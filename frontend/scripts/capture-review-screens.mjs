import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

const base = process.env.W4_BASE_URL ?? 'http://127.0.0.1:8123'
const out = process.env.W4_OUT ?? '/tmp/codex-runs/w4-polish-shots/before'
const viewports = [
  [360, 780],
  [390, 844],
  [1024, 768],
  [1440, 900],
]
await mkdir(out, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
for (const [width, height] of viewports)
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme,
      permissions: ['camera'],
    })
    const page = await context.newPage()
    const capture = async (name) => {
      await page.screenshot({ path: `${out}/${width}x${height}-${colorScheme}-${name}.png`, fullPage: true })
      const sizes = await page.evaluate(() => ({
        viewport: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }))
      if (sizes.scroll > sizes.viewport)
        console.error(`Horizontal overflow on ${name}: ${sizes.scroll}px > ${sizes.viewport}px`)
    }
    await page.goto(base)
    if (
      await page
        .getByRole('heading', { name: 'Sign in' })
        .isVisible()
        .catch(() => false)
    ) {
      await page.getByLabel('Password').fill('dev')
      await page.getByRole('button', { name: 'Sign in' }).click()
    }
    await page.getByRole('heading', { name: 'Collections', exact: true }).waitFor()
    await capture('collections')
    await page.getByRole('button', { name: 'New collection' }).click()
    await page.getByLabel('Name').fill(`Review ${width} ${colorScheme}`)
    await page.getByRole('radio', { name: /Local Only/ }).check()
    await page.getByRole('button', { name: 'Create collection' }).click()
    await page.getByRole('heading', { name: `Review ${width} ${colorScheme}` }).waitFor()
    const collectionUrl = page.url()
    await page
      .getByRole('button', { name: /New Entry/ })
      .first()
      .click()
    const row = page.locator('[data-entry-id]').first()
    await row.waitFor()
    const bytes = await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = 100
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#336699'
      ctx.fillRect(0, 0, 160, 100)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg'))
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    })
    const chooserPromise = page.waitForEvent('filechooser')
    await row.getByRole('button', { name: /Add Photo/ }).click()
    const chooser = await chooserPromise
    await chooser.setFiles({ name: 'review.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) })
    await page.waitForTimeout(500)
    await page.goto(base + '/settings')
    await page.getByLabel(/Fast camera/).evaluate((input) => {
      input.checked = true
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForTimeout(350)
    await page.goto(collectionUrl)
    await capture('entry-list-closed')
    await row.getByRole('button', { name: /Add Photo/ }).click()
    await page
      .getByRole('dialog', { name: 'Fast camera' })
      .waitFor({ timeout: 8000 })
      .catch(() => {})
    await capture('camera-sheet')
    await page
      .getByRole('button', { name: 'Done' })
      .click()
      .catch(() => {})
    const collectionId = new URL(collectionUrl).pathname.split('/')[2]
    const entryId = await row.getAttribute('data-entry-id')
    await page.goto(`${base}/c/${collectionId}/e/${entryId}`)
    await page.waitForTimeout(250)
    if (width < 900) {
      await capture('detail')
      await page.goto(base + '/diagnostics')
      await page.getByRole('button', { name: 'Start camera test' }).click()
      await page
        .getByText('Test complete', { exact: true })
        .waitFor({ timeout: 20000 })
        .catch(() => {})
      await capture('diagnostics')
      await page.goto(base + '/settings')
      await capture('settings')
      await page.goto(base + '/server')
      if (
        await page
          .getByLabel('Password')
          .isVisible()
          .catch(() => false)
      ) {
        await page.getByLabel('Password').fill('dev')
        await page.getByRole('button', { name: 'Sign in' }).click()
      }
      await page
        .getByRole('heading', { name: 'Server exports' })
        .waitFor({ timeout: 10000 })
        .catch(() => {})
      await page.waitForTimeout(250)
      await capture('server')
    } else {
      await capture('entry-list-panel')
      await page.goto(base + '/diagnostics')
      await page.getByRole('button', { name: 'Start camera test' }).click()
      await page
        .getByText('Test complete', { exact: true })
        .waitFor({ timeout: 20000 })
        .catch(() => {})
      await capture('diagnostics')
      await page.goto(base + '/settings')
      await capture('settings')
      await page.goto(base + '/server')
      if (
        await page
          .getByLabel('Password')
          .isVisible()
          .catch(() => false)
      ) {
        await page.getByLabel('Password').fill('dev')
        await page.getByRole('button', { name: 'Sign in' }).click()
      }
      await page
        .getByRole('heading', { name: 'Server exports' })
        .waitFor({ timeout: 10000 })
        .catch(() => {})
      await page.waitForTimeout(250)
      await capture('server')
    }
    const loginContext = await browser.newContext({ viewport: { width, height }, colorScheme })
    const loginPage = await loginContext.newPage()
    await loginPage.goto(base + '/logout').catch(() => {})
    await loginPage.goto(base + '/login')
    await loginPage.screenshot({ path: `${out}/${width}x${height}-${colorScheme}-login.png`, fullPage: true })
    const overflow = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))
    if (overflow.scrollWidth > overflow.width)
      console.error(`Horizontal overflow: ${width}x${height} ${colorScheme}: ${overflow.scrollWidth}px`)
    await loginContext.close()
    await context.close()
  }
await browser.close()
