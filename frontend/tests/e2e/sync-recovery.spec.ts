import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { test, expect } from '@playwright/test'
import { addEntry, addPhoto, api, createCollection, signIn, syncNow } from './helpers/sync'

test('resumes original uploads after closing and reopening a persistent browser context mid-upload', async ({
  browser,
  baseURL,
}) => {
  const profile = await mkdtemp(join(tmpdir(), 'kc-sync-resume-profile-'))
  const context = await browser.browserType().launchPersistentContext(profile, {
    baseURL,
    viewport: { width: 430, height: 932 },
    // page.route cannot see requests that pass through a service worker in WebKit; this test is
    // about upload resumption, not offline caching (covered in local-offline.spec.ts).
    serviceWorkers: 'block',
  })
  const page = context.pages()[0] ?? (await context.newPage())
  await signIn(page)
  const name = `Resume ${Date.now()}`
  await createCollection(page, name, 'synced')
  await context.setOffline(true)
  const row = await addEntry(page, '5', 'survive restart')
  const fixture = await addPhoto(page, row, `resume-${Date.now()}`)

  let uploadStartedResolve!: () => void
  const uploadStarted = new Promise<void>((resolve) => (uploadStartedResolve = resolve))
  await page.route('**/api/photos/*/original', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue()
      return
    }
    uploadStartedResolve()
    await new Promise((resolve) => setTimeout(resolve, 5000))
    await route.continue()
  })
  await context.setOffline(false)
  await syncNow(page)
  await uploadStarted
  // Release the held request first: closing a context with a pending route handler can hang (WebKit).
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await context.close()

  const resumed = await browser.browserType().launchPersistentContext(profile, {
    baseURL,
    viewport: { width: 430, height: 932 },
  })
  try {
    const reopened = resumed.pages()[0] ?? (await resumed.newPage())
    await reopened.goto('/')
    await reopened.getByRole('link', { name: `Open ${name}` }).click()
    await expect(reopened.getByRole('heading', { name })).toBeVisible()
    await syncNow(reopened)
    await expect(reopened.getByText('Backed up').first()).toBeVisible({ timeout: 45_000 })
    const collection = (
      await api<Array<{ id: string; name: string; entry_count: number; photo_count: number }>>(
        reopened,
        '/api/collections',
      )
    ).find((item) => item.name === name)
    expect(collection).toMatchObject({ entry_count: 1, photo_count: 1 })
    const changes = await api<{ changes: Array<{ entity: string; record: Record<string, unknown> }> }>(
      reopened,
      '/api/sync/changes?cursor=0&limit=500',
    )
    const photos = [
      ...new Map(
        changes.changes
          .filter((change) => change.entity === 'photo' && change.record.collection_id === collection?.id)
          .map((change) => [String(change.record.id), change]),
      ).values(),
    ]
    expect(photos).toHaveLength(1)
    const photoId = String(photos[0]?.record.id)
    const head = await reopened.request.head(`/api/photos/${photoId}/original`)
    expect(head.ok()).toBeTruthy()
    expect(head.headers().etag?.replaceAll('"', '')).toBe(fixture.sha256)
    const bytes = await reopened.request
      .get(`/api/photos/${photoId}/original`)
      .then((response) => response.body())
    expect(
      await import('node:crypto').then(({ createHash }) => createHash('sha256').update(bytes).digest('hex')),
    ).toBe(fixture.sha256)
  } finally {
    await resumed.close()
    await rm(profile, { recursive: true, force: true })
  }
})

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port')
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

test('low free space pauses original upload while synced metadata remains available', async ({
  browser,
}, testInfo) => {
  // Starts a second backend with uv on the host; the WebKit Docker container has no backend toolchain.
  test.skip(testInfo.project.name === 'iphone-webkit', 'needs a host-side backend; covered on Chromium')
  const port = await freePort()
  const dataDir = await mkdtemp(join(tmpdir(), 'kc-sync-low-storage-'))
  const baseURL = `http://127.0.0.1:${port}`
  const process: ChildProcess = spawn(
    'uv',
    ['run', 'uvicorn', 'kufang_capture.main:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: '../backend',
      env: {
        ...globalThis.process.env,
        CAPTURE_DATA_DIR: dataDir,
        CAPTURE_STATIC_DIR: '../frontend/dist',
        CAPTURE_DEV_PASSWORD: 'dev',
        CAPTURE_PUBLIC_ORIGIN: baseURL,
        CAPTURE_MIN_FREE_BYTES: '999999999999999',
      },
      stdio: 'ignore',
    },
  )
  try {
    let healthy = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        healthy = (await fetch(`${baseURL}/api/health`)).ok
        if (healthy) break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(healthy).toBe(true)
    const context = await browser.newContext({ baseURL })
    try {
      const page = await context.newPage()
      await signIn(page)
      const name = `Low storage ${Date.now()}`
      await createCollection(page, name, 'synced')
      await context.setOffline(true)
      const row = await addEntry(page, '6', 'metadata should sync')
      await addPhoto(page, row, `low-storage-${Date.now()}`)
      const storageError = new Promise<string>((resolve) => {
        page.on('response', async (response) => {
          if (
            response.url().includes('/api/photos/') &&
            response.url().endsWith('/original') &&
            response.status() === 507
          ) {
            const body = await response.json().catch(() => ({}))
            resolve(String(body.message ?? body.detail ?? ''))
          }
        })
      })
      await context.setOffline(false)
      await syncNow(page)
      expect(await storageError).toBe('Server storage is low')
      await expect(page.getByRole('status').filter({ hasText: 'Sync error' })).toBeVisible()

      const collections = await api<
        Array<{
          id: string
          name: string
          entry_count: number
          photo_count: number
          missing_originals: number
        }>
      >(page, '/api/collections')
      const collection = collections.find((item) => item.name === name)
      expect(collection).toMatchObject({ entry_count: 1, photo_count: 1, missing_originals: 1 })
      const changes = await api<{ changes: Array<{ entity: string; record: Record<string, unknown> }> }>(
        page,
        '/api/sync/changes?cursor=0&limit=500',
      )
      expect(
        changes.changes.some(
          (change) => change.entity === 'entry' && change.record.collection_id === collection?.id,
        ),
      ).toBe(true)
      const photo = changes.changes.find(
        (change) => change.entity === 'photo' && change.record.collection_id === collection?.id,
      )
      expect(photo).toBeTruthy()
      expect((await page.request.head(`/api/photos/${photo?.record.id}/original`)).status()).toBe(404)
    } finally {
      await context.close()
    }
  } finally {
    process.kill('SIGTERM')
    await rm(dataDir, { recursive: true, force: true })
  }
})
