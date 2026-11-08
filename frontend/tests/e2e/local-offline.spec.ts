import { test, expect, chromium, webkit } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  addEntry,
  addPhoto,
  assertNoLocalOnlyRequests,
  idbSnapshot,
  openLocalCollection,
  photoOriginalHash,
} from './helpers/local'

const on = (project: string[]) =>
  test.skip(!project.includes(test.info().project.name), 'Not in requested project subset')

test.use({ trace: 'off' })

test('§9 #1 offline launch: shell and IndexedDB survive reload and persistent-context restart', async ({
  page,
  browserName,
  baseURL,
}) => {
  on(['iphone-chromium', 'iphone-webkit'])
  await openLocalCollection(page, 'Offline launch room')
  await addEntry(page)
  await expect(page.locator('[data-entry-id]')).toHaveCount(1)
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.context().setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Offline launch room' })).toBeVisible()
  await expect(page.locator('[data-entry-id]')).toHaveCount(1)
  await page.context().setOffline(false)

  if ((browserName === 'chromium' || browserName === 'webkit') && baseURL) {
    const userDir = await mkdtemp(join(tmpdir(), 'kc-persistent-'))
    const engine = browserName === 'webkit' ? webkit : chromium
    const persistent = await engine.launchPersistentContext(userDir, {
      headless: true,
      viewport: { width: 430, height: 932 },
    })
    try {
      const durablePage = persistent.pages()[0] ?? (await persistent.newPage())
      await openLocalCollection(durablePage, 'Persistent room', baseURL)
      await addEntry(durablePage)
      await persistent.close()
      const relaunched = await engine.launchPersistentContext(userDir, {
        headless: true,
        viewport: { width: 430, height: 932 },
      })
      try {
        const reopened = relaunched.pages()[0]!
        await reopened.goto(baseURL)
        await expect(reopened.getByRole('link', { name: 'Open Persistent room' })).toBeVisible()
        await reopened.getByRole('link', { name: 'Open Persistent room' }).click()
        await expect(reopened.locator('[data-entry-id]')).toHaveCount(1)
      } finally {
        await relaunched.close()
      }
    } finally {
      await rm(userDir, { recursive: true, force: true })
    }
  }
})

test('§9 #2/#3 list-only counting: edit #0003, append row photos, retain place and linkage', async ({
  page,
}) => {
  on(['iphone-chromium', 'desktop-chromium', 'iphone-webkit'])
  await openLocalCollection(page)
  const expectedPhotos: string[] = []
  for (let number = 1; number <= 15; number += 1) {
    await addEntry(page)
    const photo = await addPhoto(page, number, number * 13)
    expectedPhotos.push(photo.sha256)
  }
  const row3 = page.locator('[data-entry-id]').filter({ has: page.getByPlaceholder('Entry #0003') })
  await row3.scrollIntoViewIfNeeded()
  const before = await row3.evaluate((el) => el.getBoundingClientRect().top)
  await row3.getByLabel('Quantity').fill('12.5')
  await row3.getByLabel('Unit').fill('boxes')
  await row3.getByLabel('Short note').fill('counted here')
  await row3.getByLabel('Entry title').fill('Blue cabinet')
  await expect.poll(() => row3.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(before - 40)
  for (const seed of [903, 904]) {
    await addPhoto(page, 3, seed)
    await expect.poll(() => row3.getByRole('button', { name: 'Open photo' }).count()).toBeGreaterThan(0)
  }
  await expect(page).toHaveURL(/\/c\//)
  const state = await idbSnapshot(page)
  const entry = state.entries.find((item) => item.sequence_number === 3)!
  expect(entry).toMatchObject({
    title: 'Blue cabinet',
    quantity: '12.5',
    unit: 'boxes',
    notes: 'counted here',
  })
  const photos = state.photos.filter((photo) => photo.entry_id === entry.id)
  expect(photos).toHaveLength(3)
  expect(state.photoBlobs.filter((blob) => photos.some((photo) => photo.id === blob.photo_id))).toHaveLength(
    3,
  )
  await expect(page.getByText('15 entries')).toBeVisible()
  await expect(page.getByText('17 photos')).toBeVisible()
  expect(await row3.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(before - 40)
})

test('§9 #4 fast camera: five rapid frame captures persist and diagnostics reports capabilities', async ({
  page,
}) => {
  on(['iphone-chromium'])
  await openLocalCollection(page, 'Fast camera room')
  await addEntry(page)
  const fakeTrackHasZoom = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true })
    const supported = 'zoom' in stream.getVideoTracks()[0]!.getCapabilities()
    stream.getTracks().forEach((track) => track.stop())
    return supported
  })
  const origin = new URL(page.url()).origin
  await page.goto(new URL('/settings', origin).toString())
  await page.getByLabel(/Fast camera/).check()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const request = indexedDB.open('kufang-capture')
            request.onsuccess = () => {
              const read = request.result
                .transaction('settings', 'readonly')
                .objectStore('settings')
                .get('capture_mode')
              read.onsuccess = () => resolve(read.result?.value)
            }
          }),
      ),
    )
    .toBe('fast')
  await page.goto(new URL('/', origin).toString())
  await page.getByRole('link', { name: 'Open Fast camera room' }).click()
  const row = page.locator('[data-entry-id]').first()
  await row.getByRole('button', { name: /Add Photo/ }).click()
  await expect(page.getByRole('dialog', { name: 'Fast camera' })).toBeVisible()
  await expect
    .poll(() =>
      page
        .locator('video[aria-label="Camera preview"]')
        .evaluate((video: HTMLVideoElement) => video.readyState),
    )
    .toBeGreaterThanOrEqual(2)
  const shutter = page.getByRole('button', { name: /Take photo|Shutter|Capture photo/i })
  for (let index = 0; index < 5; index += 1) await shutter.click({ delay: 20 })
  await expect.poll(async () => (await idbSnapshot(page)).photos.length, { timeout: 20_000 }).toBe(5)
  expect((await idbSnapshot(page)).photos.every((photo) => photo.capture_source === 'camera_frame')).toBe(
    true,
  )
  await expect(page.getByLabel('Zoom')).toHaveCount(fakeTrackHasZoom ? 1 : 0)
  await page.goto('/diagnostics')
  await page.getByRole('button', { name: 'Start camera test' }).click()
  await expect(page.getByText('Test complete')).toBeVisible()
})

test('§9 #6 offline durability: entries and photo originals survive offline persistent restart', async ({
  browserName,
  baseURL,
}) => {
  on(['iphone-chromium', 'desktop-chromium', 'iphone-webkit'])
  const engine = browserName === 'webkit' ? webkit : chromium
  const userDir = await mkdtemp(join(tmpdir(), 'kc-offline-durable-'))
  const context = await engine.launchPersistentContext(userDir, {
    headless: true,
    viewport: { width: 430, height: 932 },
  })
  const hashes: string[] = []
  try {
    const page = context.pages()[0]!
    await openLocalCollection(page, 'Durability room', baseURL)
    for (let number = 1; number <= 3; number += 1) {
      await addEntry(page)
      for (let shot = 0; shot < 7; shot += 1)
        hashes.push((await addPhoto(page, number, 1000 + number * 10 + shot)).sha256)
    }
    await context.setOffline(true)
  } finally {
    await context.close()
  }
  try {
    const relaunched = await engine.launchPersistentContext(userDir, {
      headless: true,
      viewport: { width: 430, height: 932 },
    })
    await relaunched.setOffline(true)
    try {
      const page = relaunched.pages()[0]!
      await page.goto(new URL('/', baseURL!).toString())
      await expect(page.getByRole('heading', { name: 'Collections', exact: true })).toBeVisible()
      await page.getByRole('link', { name: 'Open Durability room' }).click()
      await expect(page.getByText('3 entries')).toBeVisible()
      await expect(page.getByText('21 photos')).toBeVisible()
      const snapshot = await idbSnapshot(page)
      expect(
        snapshot.entries.filter((entry) => entry.collection_id === snapshot.collections[0]!.id),
      ).toHaveLength(3)
      expect(snapshot.photoBlobs).toHaveLength(21)
      const photoId = snapshot.photoBlobs[0]!.photo_id
      expect(await photoOriginalHash(page, photoId)).toBe(hashes[0])
    } finally {
      await relaunched.close()
    }
  } finally {
    await rm(userDir, { recursive: true, force: true })
  }
})

test('§9 #7 Local Only: entry and photo identifiers never appear in API requests', async ({ page }) => {
  on(['iphone-chromium', 'desktop-chromium', 'iphone-webkit'])
  await openLocalCollection(page, 'Request audit room')
  const audit = assertNoLocalOnlyRequests(page)
  await addEntry(page)
  await addPhoto(page, 1, 7766)
  const state = await idbSnapshot(page)
  const collection = state.collections.find((item) => item.name === 'Request audit room')!
  const ids = [
    ...state.entries.map((entry) => entry.id),
    ...state.photos.map((photo) => photo.id),
    collection.id,
  ]
  await page.waitForTimeout(400)
  await audit.assertClean(ids)
})

test('§9 #10 scale: generated Local Only sample rows render while scrolling', async ({ page }) => {
  on(['iphone-chromium'])
  await page.goto('/diagnostics')
  await page.getByRole('button', { name: 'Generate 300 sample entries' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Created Test data' })).toBeVisible({
    timeout: 120_000,
  })
  await page.goto('/')
  const collectionLink = page.getByRole('link', { name: /Open Test data/ }).first()
  await expect(collectionLink).toBeVisible()
  await collectionLink.click()
  await expect(page.getByText('300 entries')).toBeVisible({ timeout: 30_000 })
  const metrics = await page.evaluate(async () => {
    const longTasks: number[] = []
    const frames: number[] = []
    const observer = new PerformanceObserver((list) =>
      list.getEntries().forEach((entry) => longTasks.push(entry.duration)),
    )
    observer.observe({ type: 'longtask', buffered: true })
    let last = performance.now()
    for (let index = 0; index < 35; index += 1) {
      window.scrollBy(0, 500)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          const now = performance.now()
          frames.push(now - last)
          last = now
          resolve()
        }),
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    observer.disconnect()
    return { longTasks, frames, rendered: document.querySelectorAll('[data-entry-id]').length }
  })
  expect(metrics.rendered).toBeGreaterThan(0)
  expect(metrics.longTasks.filter((duration) => duration > 250)).toEqual([])
  console.log(
    `§9 #10 scroll metrics: ${JSON.stringify({ maxLongTaskMs: Math.max(0, ...metrics.longTasks), maxFrameMs: Math.max(0, ...metrics.frames), rowsRendered: metrics.rendered })}`,
  )
})

test('§9 #11 summary and recovery: quantities stay per unit and sequence numbers are not reused', async ({
  page,
}) => {
  on(['iphone-chromium'])
  await openLocalCollection(page, 'Recovery room')
  for (const [number, quantity, unit] of [
    [1, '5', 'boxes'],
    [2, '12', 'pieces'],
  ] as const) {
    await addEntry(page)
    const row = page
      .locator('[data-entry-id]')
      .filter({ has: page.getByPlaceholder(`Entry #${String(number).padStart(4, '0')}`) })
    await row.getByLabel('Quantity').fill(quantity)
    await row.getByLabel('Unit').fill(unit)
    await row.getByLabel('Unit').blur()
    await expect
      .poll(async () => {
        const entry = (await idbSnapshot(page)).entries.find((item) => item.sequence_number === number)
        return [entry?.quantity, entry?.unit]
      })
      .toEqual([quantity, unit])
  }
  const quantities = page.getByLabel('Quantities by unit')
  await expect(quantities).toContainText('5 boxes')
  await expect(quantities).toContainText('12 pieces')
  const row2 = page.locator('[data-entry-id]').filter({ has: page.getByPlaceholder('Entry #0002') })
  await addPhoto(page, 2, 777)
  await expect
    .poll(async () => {
      const state = await idbSnapshot(page)
      const entryId = state.entries.find((entry) => entry.sequence_number === 2)?.id
      return state.photos.filter((item) => item.entry_id === entryId).length
    })
    .toBe(1)
  const photo = (await idbSnapshot(page)).photos[0]!
  await row2.getByRole('button', { name: 'Open details for #0002' }).click()
  await page.getByRole('button', { name: 'Delete photo' }).click()
  await page
    .getByRole('status')
    .filter({ hasText: 'Photo deleted' })
    .getByRole('button', { name: 'Undo' })
    .click()
  await page.getByRole('button', { name: 'Delete photo' }).click()
  await page.getByRole('button', { name: /Back to list/i }).click()
  await page.getByRole('button', { name: 'Recently Deleted' }).click()
  await page
    .locator('section[aria-label="Recently Deleted"]')
    .getByRole('button', { name: 'Restore' })
    .click()
  expect((await idbSnapshot(page)).photos.find((item) => item.id === photo.id)?.deleted_at).toBeNull()
  await page.getByRole('button', { name: 'All' }).click()
  await expect(row2).toBeVisible()
  await row2.locator('summary[aria-label="Entry actions"]').click()
  await page.getByRole('menuitem', { name: 'Delete entry' }).click()
  await page
    .getByRole('status')
    .filter({ hasText: 'Deleted #0002' })
    .getByRole('button', { name: 'Undo' })
    .click()
  await row2.locator('summary[aria-label="Entry actions"]').click()
  await page.getByRole('menuitem', { name: 'Delete entry' }).click()
  await page.getByRole('button', { name: 'Recently Deleted' }).click()
  await page
    .locator('section[aria-label="Recently Deleted"]')
    .getByRole('button', { name: 'Restore' })
    .click()
  expect(
    (await idbSnapshot(page)).entries.find((entry) => entry.sequence_number === 2)?.deleted_at,
  ).toBeNull()
  await page.getByRole('button', { name: 'All' }).click()
  await addEntry(page)
  expect((await idbSnapshot(page)).entries.map((entry) => entry.sequence_number).sort()).toEqual([1, 2, 3])
  expect(photo.entry_id).toBe(
    (await idbSnapshot(page)).entries.find((entry) => entry.sequence_number === 2)?.id,
  )
})

test('§9 #12 export: verifier accepts ZIP and original photo bytes match', async ({ page }, testInfo) => {
  on(['iphone-chromium'])
  await openLocalCollection(page, 'Export room')
  for (let sequence = 1; sequence <= 15; sequence += 1) await addEntry(page)
  const newestPhoto = await addPhoto(page, 15, 9915)
  const laterPhoto = await addPhoto(page, 3, 9903)
  const entry3 = (await idbSnapshot(page)).entries.find((entry) => entry.sequence_number === 3)!
  await page.locator('summary[aria-label="Collection actions"]').click()
  await page.getByRole('menuitem', { name: 'Export ZIP' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export ZIP' }).last().click()
  const download = await downloadPromise
  const zipPath = join(testInfo.outputDir, download.suggestedFilename())
  await download.saveAs(zipPath)
  execFileSync('python3', ['-I', '../tools/verify-export.py', zipPath], { cwd: process.cwd(), stdio: 'pipe' })
  const output = execFileSync(
    'python3',
    [
      '-c',
      'import sys,zipfile,hashlib,csv,io,json; z=zipfile.ZipFile(sys.argv[1]); rows=list(csv.DictReader(io.StringIO(z.read("capture-export/photos.csv").decode("utf-8-sig")))); print(json.dumps([{**r,"actual_sha256":hashlib.sha256(z.read("capture-export/"+r["path"])).hexdigest()} for r in rows]))',
      zipPath,
    ],
    { encoding: 'utf8' },
  )
  const photos = JSON.parse(output) as Array<{ sha256: string; actual_sha256: string; entry_id: string }>
  expect(photos.map((photo) => photo.sha256).sort()).toEqual([newestPhoto.sha256, laterPhoto.sha256].sort())
  expect(photos.every((photo) => photo.sha256 === photo.actual_sha256)).toBe(true)
  expect(photos.find((photo) => photo.sha256 === laterPhoto.sha256)?.entry_id).toBe(entry3.id)
})

test('§9 #16 archive and clear: guard blocks before export and exact-name confirmation clears only target', async ({
  page,
}) => {
  on(['iphone-chromium'])
  await openLocalCollection(page, 'Clear target')
  await addEntry(page)
  await page.goto('/')
  await page
    .locator('.collection-card')
    .filter({ hasText: 'Clear target' })
    .locator('summary[aria-label="Actions for Clear target"]')
    .click()
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await page.getByLabel('Show archived').check()
  const card = page.locator('.collection-card').filter({ hasText: 'Clear target' })
  await expect(card).toBeVisible()
  await card.locator('summary[aria-label="Actions for Clear target"]').click()
  await page.getByRole('menuitem', { name: 'Clear from this device' }).click()
  await expect(page.getByText(/blocked from clearing/i)).toBeVisible()
  await page.getByRole('button', { name: 'Export ZIP now' }).click()
  await page.getByLabel('Type collection name').fill('wrong')
  await expect(page.getByRole('button', { name: 'Clear collection' })).toBeDisabled()
  await page.getByLabel('Type collection name').fill('Clear target')
  await page.getByRole('button', { name: 'Clear collection' }).click()
  await expect(page.getByText('Collection cleared from this device')).toBeVisible()
  const state = await idbSnapshot(page)
  expect(state.collections.some((item) => item.name === 'Clear target')).toBe(false)
})
