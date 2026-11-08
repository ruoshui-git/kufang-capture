import { createHash } from 'node:crypto'
import { test, expect } from '@playwright/test'
import {
  addEntry,
  addPhoto,
  api,
  createCollection,
  photoFixture,
  signIn,
  syncNow,
  waitBackedUp,
} from './helpers/sync'

test('syncs three entries and six exact originals once, including repeated Sync Now', async ({ page }) => {
  await signIn(page)
  const name = `Sync test ${Date.now()}`
  await createCollection(page, name, 'synced')
  const hashes: string[] = []

  for (let entry = 0; entry < 3; entry++) {
    const row = await addEntry(page, String(entry + 1), `note ${entry}`)
    for (let photo = 0; photo < 2; photo++) {
      const fixture = await addPhoto(page, row, `sync-${Date.now()}-${entry}-${photo}`)
      hashes.push(fixture.sha256)
    }
  }
  await syncNow(page)
  await waitBackedUp(page)

  const collection = (
    await api<Array<{ id: string; name: string; entry_count: number; photo_count: number }>>(
      page,
      '/api/collections',
    )
  ).find((item) => item.name === name)
  expect(collection).toMatchObject({ entry_count: 3, photo_count: 6 })
  const changes = await api<{ changes: Array<{ entity: string; record: Record<string, unknown> }> }>(
    page,
    '/api/sync/changes?cursor=0&limit=500',
  )
  const entries = [
    ...new Map(
      changes.changes
        .filter((change) => change.entity === 'entry' && change.record.collection_id === collection?.id)
        .map((change) => [String(change.record.id), change]),
    ).values(),
  ]
  const photos = [
    ...new Map(
      changes.changes
        .filter((change) => change.entity === 'photo' && change.record.collection_id === collection?.id)
        .map((change) => [String(change.record.id), change]),
    ).values(),
  ]
  expect(entries).toHaveLength(3)
  expect(photos).toHaveLength(6)
  const actualHashes: string[] = []
  for (const photo of photos) {
    const id = String(photo.record.id)
    const head = await page.request.head(`/api/photos/${id}/original`)
    expect(head.ok()).toBeTruthy()
    expect(head.headers().etag?.replaceAll('"', '')).toBe(photo.record.sha256)
    const bytes = await page.request.get(`/api/photos/${id}/original`).then((response) => response.body())
    actualHashes.push(createHash('sha256').update(bytes).digest('hex'))
  }
  expect(actualHashes.sort()).toEqual(hashes.sort())

  for (let attempt = 0; attempt < 2; attempt++) {
    await syncNow(page)
    await waitBackedUp(page)
  }
  const after = await api<Array<{ id: string; name: string; entry_count: number; photo_count: number }>>(
    page,
    '/api/collections',
  )
  expect(after.filter((item) => item.id === collection?.id)).toHaveLength(1)
  expect(after.find((item) => item.id === collection?.id)).toMatchObject({ entry_count: 3, photo_count: 6 })
})

test('requires opt-in consent for existing Local Only data and stops future uploads when disabled', async ({
  page,
}) => {
  await signIn(page)
  const name = `Opt in ${Date.now()}`
  const syncRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/sync/batch') || request.url().includes('/api/photos/'))
      syncRequests.push(request.url())
  })
  await createCollection(page, name, 'local_only')
  const collectionHref = new URL(page.url()).pathname
  const row = await addEntry(page, '8', 'keep local')
  const fixture = await addPhoto(page, row, `local-${Date.now()}`)
  await page.goto('/')
  await page.getByLabel(`Actions for ${name}`).click()
  await page.getByRole('menuitem', { name: 'Change storage mode…' }).click()
  await expect(page.getByRole('button', { name: 'Sync to Server' })).toBeDisabled()
  const consent = page.getByRole('checkbox', { name: /I understand this uploads/ })
  await expect(consent).toBeVisible()
  expect(syncRequests).toEqual([])
  await consent.check()
  await page.getByRole('button', { name: 'Sync to Server' }).click()
  await expect(page.getByRole('heading', { name: 'Change storage mode' })).toBeHidden()
  await page.goto(collectionHref)
  await page.getByRole('heading', { name }).waitFor()
  await syncNow(page)
  await waitBackedUp(page)

  const serverCollections = await api<Array<{ id: string; name: string }>>(page, '/api/collections')
  const server = serverCollections.find((item) => item.name === name)
  expect(server).toBeTruthy()
  const response = await page.request.get('/api/sync/changes?cursor=0&limit=500')
  const payload = await response.json()
  const uploadedPhoto = payload.changes.find(
    (change: { entity: string; record: { collection_id: string; sha256: string } }) =>
      change.entity === 'photo' && change.record.collection_id === server?.id,
  )
  expect(uploadedPhoto.record.sha256).toBe(fixture.sha256)

  await page.goto('/')
  await page.getByLabel(`Actions for ${name}`).click()
  await page.getByRole('menuitem', { name: 'Change storage mode…' }).click()
  await page.getByRole('button', { name: 'Switch to Local Only' }).click()
  await expect(page.getByRole('heading', { name: 'Change storage mode' })).toBeHidden()
  await page.waitForTimeout(500)
  const countAfterSwitch = syncRequests.length
  await page.waitForTimeout(500)
  expect(syncRequests.length).toBe(countAfterSwitch)
  expect(
    (await api<Array<{ id: string }>>(page, '/api/collections')).some((item) => item.id === server?.id),
  ).toBe(true)
})

test('wrong password is reported and signing out pauses sync until sign-in resumes it', async ({ page }) => {
  await page.goto('/login?return=%2F')
  await page.getByLabel('Password').fill('wrong')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  const wrongPasswordMessage = await page.getByRole('alert').textContent()
  await signIn(page)
  const name = `Auth ${Date.now()}`
  await createCollection(page, name, 'synced')
  await addEntry(page, '1')
  const collectionPath = new URL(page.url()).pathname
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByText('Signed out.')).toBeVisible()
  await expect
    .poll(async () => (await page.request.get('/api/auth/session')).json())
    .toMatchObject({
      authenticated: false,
    })
  await page.goto(collectionPath)
  await expect(page.getByRole('status')).toContainText('Sign in to sync')
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByLabel('Password').fill('dev')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/settings')
  await page.goto(collectionPath)
  await syncNow(page)
  await waitBackedUp(page)
  expect(wrongPasswordMessage).toContain('Password is incorrect')
})

test('desktop server export contains only server collections and verifies as a ZIP', async ({ page }) => {
  test.skip(
    test.info().project.name !== 'desktop-chromium',
    'Desktop export acceptance runs on desktop Chrome',
  )
  await signIn(page)
  const synced = `Desktop synced ${Date.now()}`
  await createCollection(page, synced, 'synced')
  const row = await addEntry(page, '7', 'desktop original')
  const photo = await addPhoto(page, row, `desktop-${Date.now()}`)
  await syncNow(page)
  await waitBackedUp(page)
  const local = `Desktop local ${Date.now()}`
  await createCollection(page, local, 'local_only')
  await addEntry(page, '9', 'must stay local')
  await page.goto('/server')
  await expect(page.getByRole('heading', { name: synced })).toBeVisible()
  await expect(page.getByRole('heading', { name: local })).toHaveCount(0)
  const downloadLink = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: synced }) })
    .getByRole('link', { name: 'Download ZIP' })
  const href = await downloadLink.getAttribute('href')
  expect(href).toContain('/api/exports/collections/')
  const response = await page.request.get(href!)
  expect(response.ok()).toBeTruthy()
  expect(response.headers()['content-disposition']).toContain('attachment')
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const outputDir = await mkdtemp(join(tmpdir(), 'kc-server-export-'))
  const path = join(outputDir, 'export.zip')
  await writeFile(path, await response.body())
  const { execFileSync } = await import('node:child_process')
  const output = execFileSync('python3', ['-I', '../tools/verify-export.py', path!], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  expect(output).toMatch(/OK|verified|valid/i)
  const zip = await import('fflate')
  const fs = await import('node:fs/promises')
  const entries = zip.unzipSync(new Uint8Array(await fs.readFile(path)))
  const original = Object.entries(entries).find(([name]) => name.startsWith('capture-export/photos/'))?.[1]
  expect(original).toBeTruthy()
  expect(createHash('sha256').update(original!).digest('hex')).toBe(photo.sha256)
})

test('coalesces two offline edits into one server revision with the final values', async ({ page }) => {
  await signIn(page)
  const name = `Coalesce ${Date.now()}`
  await createCollection(page, name, 'synced')
  const row = await addEntry(page, '1', 'initial')
  await syncNow(page)
  await waitBackedUp(page)
  const entryId = await row.getAttribute('data-entry-id')
  const beforeChanges = await api<{
    changes: Array<{ entity: string; id: string; record: Record<string, unknown> }>
  }>(page, '/api/sync/changes?cursor=0&limit=500')
  const before = beforeChanges.changes.find((change) => change.entity === 'entry' && change.id === entryId)
  expect(before).toBeTruthy()

  await page.context().setOffline(true)
  await row.getByLabel('Quantity').fill('2')
  await row.getByLabel('Quantity').fill('12.5')
  await row.getByLabel('Short note').fill('final note')
  await row.getByLabel('Short note').blur()
  await page.waitForTimeout(450)
  await page.context().setOffline(false)
  await syncNow(page)
  await waitBackedUp(page)
  const afterChanges = await api<{
    changes: Array<{ entity: string; id: string; record: Record<string, unknown> }>
  }>(page, '/api/sync/changes?cursor=0&limit=500')
  const after = afterChanges.changes.filter((change) => change.entity === 'entry' && change.id === entryId)
  const latest = after.at(-1)?.record
  expect(latest).toMatchObject({ quantity: '12.5', notes: 'final note' })
  expect(latest?.revision).toBe(Number(before?.record.revision) + 1)
})

test('shows a field conflict and supports both Keep mine and Use server', async ({
  page,
  browser,
  baseURL,
}) => {
  await signIn(page)
  const name = `Conflict ${Date.now()}`
  await createCollection(page, name, 'synced')
  const row = await addEntry(page, '1', 'base')
  await syncNow(page)
  await waitBackedUp(page)

  async function secondDeviceChange(value: string, suffix: string) {
    const entryId = await row.getAttribute('data-entry-id')
    const otherContext = await browser.newContext({ baseURL })
    const otherPage = await otherContext.newPage()
    await signIn(otherPage)
    const changes = await api<{
      changes: Array<{ entity: string; id: string; record: Record<string, unknown> }>
    }>(otherPage, '/api/sync/changes?cursor=0&limit=500')
    const current = changes.changes
      .filter((change) => change.entity === 'entry' && change.id === entryId)
      .at(-1)
    expect(current).toBeTruthy()
    const result = await otherPage.evaluate(
      async ({ id, collectionId, revision, value, suffix }) => {
        const response = await fetch('/api/sync/batch', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Capture-Request': '1' },
          body: JSON.stringify({
            device_id: `second-${suffix}`,
            mutations: [
              {
                id: `second-mutation-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                entity: 'entry',
                entity_id: id,
                collection_id: collectionId,
                op: 'upsert',
                base_revision: revision,
                fields: { quantity: value },
              },
            ],
          }),
        })
        return { status: response.status, payload: await response.json() }
      },
      {
        id: String(entryId),
        collectionId: String(current?.record.collection_id),
        revision: Number(current?.record.revision),
        value,
        suffix,
      },
    )
    expect(result.status).toBe(200)
    expect(result.payload.results[0].status).toBe('applied')
    await otherContext.close()
  }

  await page.context().setOffline(true)
  await row.getByLabel('Quantity').fill('mine')
  await row.getByLabel('Quantity').fill('22')
  await row.getByLabel('Quantity').blur()
  await page.waitForTimeout(400)
  await secondDeviceChange('44', 'mine')
  await page.context().setOffline(false)
  await syncNow(page)
  await expect(page.getByRole('status').filter({ hasText: 'Conflict' })).toBeVisible()
  await page.locator('.status-trigger').click()
  await expect(page.getByRole('heading', { name: 'Resolve conflicts' })).toBeVisible()
  await page.getByRole('button', { name: 'Keep mine' }).click()
  await waitBackedUp(page)
  await page.getByRole('button', { name: 'Close' }).click()
  let pulled = await api<{ changes: Array<{ entity: string; id: string; record: Record<string, unknown> }> }>(
    page,
    '/api/sync/changes?cursor=0&limit=500',
  )
  const entryId = await row.getAttribute('data-entry-id')
  expect(
    pulled.changes.filter((change) => change.entity === 'entry' && change.id === entryId).at(-1)?.record
      .quantity,
  ).toBe('22')

  await page.context().setOffline(true)
  await row.getByLabel('Quantity').fill('33')
  await row.getByLabel('Quantity').blur()
  await page.waitForTimeout(400)
  await secondDeviceChange('44', 'server')
  await page.context().setOffline(false)
  await syncNow(page)
  await expect(page.getByRole('status').filter({ hasText: 'Conflict' })).toBeVisible()
  await page.locator('.status-trigger').click()
  await expect(page.getByRole('heading', { name: 'Resolve conflicts' })).toBeVisible()
  await page.getByRole('button', { name: 'Use server' }).click()
  await waitBackedUp(page)
  pulled = await api(page, '/api/sync/changes?cursor=0&limit=500')
  expect(
    pulled.changes.filter((change) => change.entity === 'entry' && change.id === entryId).at(-1)?.record
      .quantity,
  ).toBe('44')
})
