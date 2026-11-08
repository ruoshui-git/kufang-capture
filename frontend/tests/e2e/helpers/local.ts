import { expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'

export async function openLocalCollection(page: Page, name = 'Temple 2 / A04', origin?: string) {
  await page.goto(origin ? new URL('/', origin).toString() : '/')
  if (
    await page
      .getByRole('heading', { name: 'Sign in' })
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByLabel('Password').fill('dev')
    await page.getByRole('button', { name: 'Sign in' }).click()
  }
  await expect(page.getByRole('heading', { name: 'Collections', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'New collection' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByRole('radio', { name: /Local Only/ }).check()
  await page.getByRole('button', { name: 'Create collection' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

export async function addEntry(page: Page) {
  const previousCount = (await idbSnapshot(page)).entries.filter((entry) => entry.deleted_at === null).length
  await page
    .getByRole('button', { name: /New Entry/ })
    .first()
    .click()
  await expect(page.locator('[data-entry-id]')).toHaveCount(previousCount + 1)
}

export async function photoOriginalHash(page: Page, photoId: string) {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kufang-capture')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('photoBlobs', 'readonly')
    const record = await new Promise<{ original: Blob }>((resolve, reject) => {
      const request = transaction.objectStore('photoBlobs').get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const digest = await crypto.subtle.digest('SHA-256', await record.original.arrayBuffer())
    database.close()
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }, photoId)
}

export async function addPhoto(page: Page, sequence: number, seed: number) {
  const before = await idbSnapshot(page)
  const entryId = before.entries.find((entry) => entry.sequence_number === sequence)?.id
  if (!entryId) throw new Error(`Entry #${String(sequence).padStart(4, '0')} is not in IndexedDB.`)
  const previousCount = before.photos.filter((photo) => photo.entry_id === entryId).length
  const bytes = await page.evaluate(async (value) => {
    const canvas = document.createElement('canvas')
    canvas.width = 24
    canvas.height = 24
    const context = canvas.getContext('2d')!
    context.fillStyle = `hsl(${value % 360} 70% 50%)`
    context.fillRect(0, 0, 24, 24)
    context.fillStyle = '#fff'
    context.fillText(String(value), 2, 14)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((image) => resolve(image!), 'image/jpeg'))
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  }, seed)
  const buffer = Buffer.from(bytes)
  const chooserPromise = page.waitForEvent('filechooser')
  await page
    .locator(`[data-entry-id]`)
    .filter({ has: page.getByPlaceholder(`Entry #${String(sequence).padStart(4, '0')}`) })
    .getByRole('button', { name: /Add Photo/ })
    .click()
  const chooser = await chooserPromise
  await chooser.setFiles({ name: `photo-${seed}.jpg`, mimeType: 'image/jpeg', buffer })
  await expect
    .poll(async () => (await idbSnapshot(page)).photos.filter((photo) => photo.entry_id === entryId).length, {
      timeout: 20_000,
    })
    .toBe(previousCount + 1)
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex') }
}

export async function idbSnapshot(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kufang-capture')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const names = ['collections', 'entries', 'photos', 'photoBlobs', 'outbox']
    const transaction = database.transaction(names, 'readonly')
    const rows = await Promise.all(
      names.map(
        (name) =>
          new Promise<unknown[]>((resolve, reject) => {
            const request = transaction.objectStore(name).getAll()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          }),
      ),
    )
    const result = Object.fromEntries(names.map((name, index) => [name, rows[index]]))
    database.close()
    return result as {
      collections: Array<{ id: string; name: string; storage_mode: string; next_sequence_number: number }>
      entries: Array<{
        id: string
        collection_id: string
        sequence_number: number
        title: string
        quantity: string | null
        unit: string
        notes: string
        deleted_at: string | null
      }>
      photos: Array<{
        id: string
        entry_id: string
        collection_id: string
        capture_source: string
        deleted_at: string | null
        sha256: string
      }>
      photoBlobs: Array<{ photo_id: string; original: Blob }>
      outbox: Array<{ collection_id: string; entity_id: string }>
    }
  })
}

export function assertNoLocalOnlyRequests(page: Page) {
  const requests: Array<{ url: string; body: string | null }> = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/'))
      requests.push({ url: request.url(), body: request.postData() })
  })
  return {
    requests,
    async assertClean(ids: string[]) {
      for (const request of requests) {
        expect(request.url).not.toMatch(/\/api\/(?!auth\/session|health)/)
        for (const id of ids) {
          expect(request.url).not.toContain(id)
          expect(request.body ?? '').not.toContain(id)
        }
      }
    },
  }
}
