import { mkdir } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { addEntry, addPhoto, api, createCollection, signIn, syncNow, waitBackedUp } from './helpers/sync'

const shots = '/tmp/codex-runs/w6-e2e-shots'

async function screenshot(page: import('@playwright/test').Page, name: string) {
  await mkdir(shots, { recursive: true })
  await page.setViewportSize({ width: 430, height: 932 })
  await page.screenshot({ path: `${shots}/${name}.png` })
}

async function importEntry(
  page: import('@playwright/test').Page,
  targetName: string,
  sourceName: string,
  screenshotPrefix: string,
) {
  await page.locator('summary[aria-label="Collection actions"]').click()
  await page.getByRole('menuitem', { name: 'Import from another collection' }).click()
  await expect(page.getByRole('heading', { name: 'Import from another collection' })).toBeVisible()
  await screenshot(page, `${screenshotPrefix}-step-1`)
  await page.getByRole('button', { name: sourceName }).click()
  await expect(page.getByRole('heading', { name: `Import from ${sourceName}` })).toBeVisible()
  await screenshot(page, `${screenshotPrefix}-step-2`)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Import 1' }).click()
  await expect(page.getByText('Imported 1 item')).toBeVisible()
  await expect(page.getByRole('heading', { name: targetName })).toBeVisible()
}

test('Local Only collections share item fields and photos while quantities and sync privacy stay local', async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 932 })
  const suffix = Date.now()
  const nameA = `Shared local A ${suffix}`
  const nameB = `Shared local B ${suffix}`
  const title = `Shared title ${suffix}`
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/sync/')) requests.push(`${request.url()} ${request.postData() ?? ''}`)
  })

  await createCollection(page, nameA, 'local_only')
  const rowA = await addEntry(page)
  await rowA.getByLabel('Entry title').fill(title)
  await rowA.getByLabel('Entry title').blur()
  const photo = await addPhoto(page, rowA, `shared-local-${suffix}`)
  const entryId = (await rowA.getAttribute('data-entry-id'))!

  await createCollection(page, nameB, 'local_only')
  await importEntry(page, nameB, nameA, 'local-import')
  const rowB = page.locator('[data-entry-id]').first()
  await expect(rowB.getByLabel('Entry title')).toHaveValue(title)
  await expect(rowB.getByRole('button', { name: 'Open photo' })).toBeVisible()
  await expect(rowB.getByLabel('Quantity')).toHaveValue('')
  await expect(rowB.getByText('Shared · 2 collections')).toBeVisible()
  await screenshot(page, 'shared-row')

  await rowB.getByLabel('Entry title').fill(`${title} edited`)
  await rowB.getByLabel('Entry title').blur()
  await expect(rowB.getByLabel('Entry title')).toHaveValue(`${title} edited`)
  await page.goto('/')
  await page.getByRole('link', { name: `Open ${nameA}` }).click()
  const currentRowA = page.locator('[data-entry-id]').first()
  await expect(currentRowA.getByLabel('Entry title')).toHaveValue(`${title} edited`)
  await currentRowA.getByLabel('Quantity').fill('3')
  await currentRowA.getByLabel('Quantity').blur()
  await expect(currentRowA.getByLabel('Quantity')).toHaveValue('3')
  await page.goto('/')
  await page.getByRole('link', { name: `Open ${nameB}` }).click()
  const currentRowB = page.locator('[data-entry-id]').first()
  await expect(currentRowB.getByLabel('Entry title')).toHaveValue(`${title} edited`)
  await expect(currentRowB.getByLabel('Quantity')).toHaveValue('')
  await currentRowB.getByLabel('Quantity').fill('5')
  await currentRowB.getByLabel('Quantity').blur()
  await expect(currentRowB.getByLabel('Quantity')).toHaveValue('5')
  await page.goto('/')
  await page.getByRole('link', { name: `Open ${nameA}` }).click()
  await expect(page.locator('[data-entry-id]').first().getByLabel('Quantity')).toHaveValue('3')
  await page.goto('/')
  await page.getByRole('link', { name: `Open ${nameB}` }).click()
  await expect(page.locator('[data-entry-id]').first().getByLabel('Quantity')).toHaveValue('5')

  await page.getByRole('button', { name: 'Open details for #0001' }).click()
  await expect(page.getByRole('region', { name: 'Also in' })).toContainText(nameA)
  await screenshot(page, 'detail-also-in')
  await page.getByRole('button', { name: 'Back to list' }).click()
  await page.goto('/')
  await page.getByRole('link', { name: `Open ${nameA}` }).click()
  await page.locator('[data-entry-id]').first().locator('summary[aria-label="Entry actions"]').click()
  await page.getByRole('menuitem', { name: 'Delete entry' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Removed from' })).toContainText(
    `Still in ${nameB}`,
  )
  await page.goto('/')
  await page.getByRole('link', { name: `Open ${nameB}` }).click()
  const stillShared = page.locator('[data-entry-id]').first()
  await expect(stillShared.getByLabel('Entry title')).toHaveValue(`${title} edited`)
  await expect(stillShared.getByRole('button', { name: 'Open photo' })).toBeVisible()
  expect(photo.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(requests.join('\n')).not.toContain(entryId)
  expect(requests.join('\n')).not.toContain(photo.sha256)
  expect(requests).toEqual([])
})

test('Synced collections share an item and original photo once, then restore it in a fresh browser context', async ({
  page,
  browser,
  baseURL,
}) => {
  await signIn(page)
  const suffix = Date.now()
  const nameC = `Shared synced C ${suffix}`
  const nameD = `Shared synced D ${suffix}`
  const title = `Synced shared ${suffix}`
  await createCollection(page, nameC, 'synced')
  const sourceRow = await addEntry(page)
  await sourceRow.getByLabel('Entry title').fill(title)
  await sourceRow.getByLabel('Entry title').blur()
  const fixture = await addPhoto(page, sourceRow, `shared-synced-${suffix}`)
  const itemId = (await sourceRow.getAttribute('data-entry-id'))!

  await createCollection(page, nameD, 'synced')
  await importEntry(page, nameD, nameC, 'synced-import')
  await syncNow(page)
  await waitBackedUp(page)

  const collections = await api<Array<{ id: string; name: string }>>(page, '/api/collections')
  const collectionC = collections.find((collection) => collection.name === nameC)
  const collectionD = collections.find((collection) => collection.name === nameD)
  expect(collectionC).toBeTruthy()
  expect(collectionD).toBeTruthy()
  const payload = await api<{
    changes: Array<{ entity: string; id: string; record: Record<string, unknown> }>
  }>(page, '/api/sync/changes?cursor=0&schema=2')
  const items = [
    ...new Map(
      payload.changes
        .filter((change) => change.entity === 'item' && change.id === itemId)
        .map((change) => [change.id, change]),
    ).values(),
  ]
  const entries = [
    ...new Map(
      payload.changes
        .filter(
          (change) =>
            change.entity === 'entry' &&
            change.record.item_id === itemId &&
            [collectionC?.id, collectionD?.id].includes(String(change.record.collection_id)),
        )
        .map((change) => [change.id, change]),
    ).values(),
  ]
  const photos = [
    ...new Map(
      payload.changes
        .filter((change) => change.entity === 'photo' && change.record.item_id === itemId)
        .map((change) => [change.id, change]),
    ).values(),
  ]
  expect(items).toHaveLength(1)
  expect(items[0]?.record).toMatchObject({ title })
  expect(entries).toHaveLength(2)
  expect(entries.map((entry) => entry.record.collection_id).sort()).toEqual(
    [collectionC?.id, collectionD?.id].sort(),
  )
  expect(entries.every((entry) => entry.record.item_id === itemId)).toBe(true)
  expect(photos).toHaveLength(1)
  expect(photos[0]?.record.item_id).toBe(itemId)
  expect(photos[0]?.record.sha256).toBe(fixture.sha256)
  const originalHead = await page.request.head(`/api/photos/${photos[0]?.id}/original`)
  expect(originalHead.ok()).toBeTruthy()
  expect(originalHead.headers().etag?.replaceAll('"', '')).toBe(fixture.sha256)

  const context = await browser.newContext({ baseURL, viewport: { width: 430, height: 932 } })
  try {
    const freshPage = await context.newPage()
    await signIn(freshPage)
    await expect(freshPage.getByRole('link', { name: `Open ${nameD}` })).toBeVisible({ timeout: 30_000 })
    await freshPage.getByRole('link', { name: `Open ${nameD}` }).click()
    const restoredRow = freshPage.locator('[data-entry-id]').first()
    await expect(restoredRow.getByLabel('Entry title')).toHaveValue(title)
    await expect(restoredRow.getByRole('button', { name: 'Open photo' })).toBeVisible()
  } finally {
    await context.close()
  }
})

test('storage mode is blocked for cross-mode sharing and import sources exclude Local Only collections', async ({
  page,
}) => {
  await signIn(page)
  const suffix = Date.now()
  const nameA = `Mode local A ${suffix}`
  const nameB = `Mode local B ${suffix}`
  const syncedName = `Mode synced ${suffix}`
  await createCollection(page, nameA, 'local_only')
  const row = await addEntry(page)
  await createCollection(page, nameB, 'local_only')
  await importEntry(page, nameB, nameA, 'mode-guard-import')

  await page.goto('/')
  await page.getByLabel(`Actions for ${nameA}`).click()
  await page.getByRole('menuitem', { name: 'Change storage mode…' }).click()
  await expect(page.getByText(new RegExp(`shared with Local Only collection '${nameB}'`))).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sync to Server' })).toBeDisabled()
  await page.getByRole('button', { name: 'Close' }).click()

  await createCollection(page, syncedName, 'synced')
  await page.locator('summary[aria-label="Collection actions"]').click()
  await page.getByRole('menuitem', { name: 'Import from another collection' }).click()
  await expect(page.getByRole('heading', { name: 'Import from another collection' })).toBeVisible()
  await expect(page.getByRole('button', { name: nameA })).toHaveCount(0)
  await expect(page.getByRole('button', { name: nameB })).toHaveCount(0)
  expect(row).toBeTruthy()
})
