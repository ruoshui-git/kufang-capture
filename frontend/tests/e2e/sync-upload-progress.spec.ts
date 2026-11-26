import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { useChinese } from './helpers/i18n'
import { loginContext, photoFixture } from './helpers/sync'

test.use({ serviceWorkers: 'block' })

for (const locale of ['en', 'zh-CN'] as const) {
  test(`shows original upload progress until the server acknowledges the photo in ${locale}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    const chinese = locale === 'zh-CN'
    const desktop = testInfo.project.name === 'desktop-chromium'
    const viewport = desktop ? { width: 1280, height: 800 } : { width: 375, height: 812 }
    await page.setViewportSize(viewport)
    if (chinese) await useChinese(page)
    await loginContext(context, baseURL!)
    await page.goto('/')
    const name = `A04 ${Date.now().toString(36).slice(-4).toUpperCase()}`
    await page.getByRole('button', { name: chinese ? '新建清点单' : 'New collection' }).click()
    await page.getByLabel(chinese ? '名称' : 'Name').fill(name)
    await page.getByRole('radio', { name: chinese ? /^同步到服务器/ : /^Sync to Server/ }).check()
    await page.getByRole('button', { name: chinese ? '创建清点单' : 'Create collection' }).click()
    await expect(page.getByRole('heading', { name })).toBeVisible()
    await page
      .getByRole('button', { name: chinese ? /新建条目/ : /New Entry/ })
      .first()
      .click()
    const row = page.locator('[data-entry-id]').first()

    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let uploadStarted = false
    await page.route('**/api/photos/*/original', async (route) => {
      const method = route.request().method()
      if (method !== 'PUT' && method !== 'PATCH') return route.continue()
      uploadStarted = true
      // Continue the browser's request with its Blob body. WebKit's route.fetch loses that body.
      await held
      await route.continue()
    })

    const photo = await photoFixture(page, 'A04')
    const chooser = page.waitForEvent('filechooser')
    await row.getByRole('button', { name: chinese ? '拍照' : 'Add Photo', exact: true }).click()
    await (await chooser).setFiles({ name: photo.filename, mimeType: 'image/jpeg', buffer: photo.bytes })

    const chip = page.locator('.status-trigger .status-chip')
    const uploading = chinese ? /^上传照片 1\/1 · \d+%$/ : /^Uploading 1\/1 · \d+%$/
    try {
      await expect.poll(() => uploadStarted).toBe(true)
      await expect(chip).toHaveText(uploading)
      await expect(page.locator('.global-sync > span:nth-child(2)')).toHaveText(uploading)
      expect(await chip.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
      const shots = process.env.UPLOAD_WATCHDOG_SHOTS
      if (shots && (desktop || testInfo.project.name === 'iphone-chromium')) {
        await page.screenshot({
          path: join(shots, `${locale}-${viewport.width}x${viewport.height}.png`),
          scale: 'css',
        })
      }
      const acknowledgement = page.waitForResponse(
        (response) =>
          response.url().endsWith('/original') && ['PUT', 'PATCH'].includes(response.request().method()),
      )
      release()
      expect((await acknowledgement).status()).toBe(201)
      await expect(chip).toHaveText(chinese ? '已备份到服务器' : 'Backed up')
    } finally {
      release()
    }
  })
}

// Playwright request interception suppresses XHR upload progress, so this test only throttles the upload
// through the Chrome DevTools Protocol and lets the real original reach the server.
test('reports real upload progress for a large original in Chromium', async ({
  page,
  context,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Upload throttling uses the Chrome DevTools Protocol')
  await loginContext(context, baseURL!)
  await page.goto('/')
  const name = `A05 ${Date.now().toString(36).slice(-4).toUpperCase()}`
  await page.getByRole('button', { name: 'New collection' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByRole('radio', { name: /^Sync to Server/ }).check()
  await page.getByRole('button', { name: 'Create collection' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
  await page
    .getByRole('button', { name: /New Entry/ })
    .first()
    .click()
  const row = page.locator('[data-entry-id]').first()
  // Random pixels keep the JPEG near 1 MB so the body is sent in many chunks.
  const bytes = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 700
      canvas.height = 700
      const context = canvas.getContext('2d')!
      const image = context.createImageData(canvas.width, canvas.height)
      for (let index = 0; index < image.data.length; index++)
        image.data[index] = index % 4 === 3 ? 255 : Math.floor(Math.random() * 256)
      context.putImageData(image, 0, 0)
      return canvas.toDataURL('image/jpeg', 0.95).split(',')[1]!
    }),
    'base64',
  )
  expect(bytes.length).toBeGreaterThan(500_000)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 20,
    downloadThroughput: -1,
    uploadThroughput: 100 * 1024,
  })
  const chooser = page.waitForEvent('filechooser')
  await row.getByRole('button', { name: 'Add Photo', exact: true }).click()
  await (await chooser).setFiles({ name: 'noise.jpg', mimeType: 'image/jpeg', buffer: bytes })
  const chip = page.locator('.status-trigger .status-chip')
  await expect(chip).toHaveText(/^Uploading 1\/1 · [1-9]\d?%$/, { timeout: 20_000 })
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  await expect(chip).toHaveText('Backed up', { timeout: 30_000 })
})
