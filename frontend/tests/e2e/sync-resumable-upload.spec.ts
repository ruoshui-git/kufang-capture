import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { addEntry, createCollection, loginContext } from './helpers/sync'

test.use({ serviceWorkers: 'block' })

test('resumes a failed original PATCH and backs up the exact JPEG', async ({
  page,
  context,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Exercises Chromium request interruption')
  await loginContext(context, baseURL!)
  await createCollection(page, `Resumable ${Date.now()}`, 'synced')
  const row = await addEntry(page)
  const bytes = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 1600
      canvas.height = 1600
      const context = canvas.getContext('2d')!
      const image = context.createImageData(canvas.width, canvas.height)
      for (let i = 0; i < image.data.length; i++)
        image.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256)
      context.putImageData(image, 0, 0)
      return canvas.toDataURL('image/jpeg', 0.95).split(',')[1]!
    }),
    'base64',
  )
  const chunkSize = 1024 * 1024
  expect(bytes.length).toBeGreaterThan(2 * chunkSize)
  expect(bytes.length).toBeLessThan(3 * chunkSize)

  const offsets: number[] = []
  let releaseRetry!: () => void
  const retryHeld = new Promise<void>((resolve) => (releaseRetry = resolve))
  await page.route('**/api/photos/*/original', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    offsets.push(Number(route.request().headers()['upload-offset']))
    if (offsets.length === 2) return route.abort('connectionreset')
    if (offsets.length === 3) await retryHeld
    return route.continue()
  })
  const initial = page.waitForResponse(
    (response) => response.url().endsWith('/original') && response.request().method() === 'PATCH',
  )
  const chooser = page.waitForEvent('filechooser')
  await row.getByRole('button', { name: 'Add Photo', exact: true }).click()
  await (await chooser).setFiles({ name: 'noise.jpg', mimeType: 'image/jpeg', buffer: bytes })

  const chip = page.locator('.status-trigger .status-chip')
  try {
    const first = await initial
    expect(first.status()).toBe(204)
    expect(first.headers()['upload-offset']).toBe(String(chunkSize))
    await expect.poll(() => offsets, { timeout: 30_000 }).toEqual([0, chunkSize, chunkSize])
    await expect(chip).not.toHaveText('Backed up')

    const original = first.url()
    const partial = await context.request.head(original)
    expect(partial.status()).toBe(404)
    expect(partial.headers()['upload-offset']).toBe(String(chunkSize))
    releaseRetry()
    await expect(chip).toHaveText('Backed up', { timeout: 30_000 })
    expect(offsets).toEqual([0, chunkSize, chunkSize, 2 * chunkSize])
    const stored = await context.request.get(original)
    expect(stored.status()).toBe(200)
    expect(
      createHash('sha256')
        .update(await stored.body())
        .digest('hex'),
    ).toBe(createHash('sha256').update(bytes).digest('hex'))
  } finally {
    releaseRetry()
  }
})
