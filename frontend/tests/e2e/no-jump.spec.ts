import { mkdirSync } from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { createCollection, signIn } from './helpers/sync'

const shots = '/tmp/codex-runs/A3-shots'
mkdirSync(shots, { recursive: true })

type Geometry = {
  input: number[]
  row: number[]
  nextButtons: number[]
  scrollY: number
  activeLabel: string | null
  selectionStart: number | null
}

async function geometry(page: Page, input: Locator, row: Locator, nextButtons: Locator): Promise<Geometry> {
  const rect = async (locator: Locator) =>
    locator.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return [box.x, box.y, box.width, box.height]
    })
  const [inputRect, rowRect, nextRect, state] = await Promise.all([
    rect(input),
    rect(row),
    rect(nextButtons),
    input.evaluate((element) => ({
      activeLabel: document.activeElement?.getAttribute('aria-label') ?? null,
      selectionStart: (element as HTMLInputElement).selectionStart,
    })),
  ])
  return {
    input: inputRect,
    row: rowRect,
    nextButtons: nextRect,
    scrollY: await page.evaluate(() => scrollY),
    ...state,
  }
}

async function expectNoJump(
  page: Page,
  input: Locator,
  row: Locator,
  nextButtons: Locator,
  before: Geometry,
) {
  await expect.poll(() => geometry(page, input, row, nextButtons)).toEqual(before)
}

test('sync and live row updates keep focused controls and surrounding rows fixed', async ({ page }, info) => {
  test.skip(!['iphone-webkit', 'iphone-chromium', 'android-chromium'].includes(info.project.name))
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  const name = `No jump ${Date.now()}`
  await createCollection(page, name, 'synced')
  for (let index = 0; index < 9; index++) {
    const entryCount = index + 1
    await page.locator('.new-entry-bar button').click()
    await expect(
      page.getByText(`${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}`, { exact: true }),
    ).toBeAttached()
  }
  await page.locator('summary[aria-label="Collection actions"]').click()
  await page.getByRole('menuitemradio', { name: /Last edited/ }).click()
  await page.locator('.filter-trigger summary').click()
  await page.getByRole('menuitemradio', { name: /Any incomplete/ }).click()

  const wrappers = page.locator('.entry-list > [data-entry-id]')
  const target = wrappers.nth(4)
  const row = target.locator('.entry-row')
  const nextButtons = wrappers.nth(5).getByRole('button').first()
  const rowId = await target.getAttribute('data-entry-id')
  const inputs = ['Entry title', 'Quantity', 'Dimensions']

  await page.context().setOffline(true)
  await target.getByLabel('Entry title').focus()
  await page.screenshot({ path: `${shots}/before-${info.project.name}.png`, scale: 'css' })
  for (const [index, label] of inputs.entries()) {
    const input = target.getByLabel(label)
    await input.focus()
    await input.fill(index === 0 ? 'Stable title' : index === 1 ? '12' : '10 x 20 cm')
    const savingBaseline = await geometry(page, input, row, nextButtons)
    await expect(target.locator('.row-status')).toContainText('Saving…')
    await expectNoJump(page, input, row, nextButtons, savingBaseline)
    await expect(target.locator('.row-status')).toContainText('Pending sync')
    const baseline = await geometry(page, input, row, nextButtons)
    await expectNoJump(page, input, row, nextButtons, baseline)
    await expect(target).toHaveAttribute('data-entry-id', rowId!)
  }
  await expect(target.locator('.row-status')).toContainText('Pending sync')

  let requestStarted!: () => void
  let releaseRequest!: () => void
  const started = new Promise<void>((resolve) => (requestStarted = resolve))
  const released = new Promise<void>((resolve) => (releaseRequest = resolve))
  await page.route('**/api/sync/batch', async (route) => {
    requestStarted()
    await released
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"message":"temporary failure"}',
    })
  })

  const focused = target.getByLabel('Dimensions')
  const beforeSync = await geometry(page, focused, row, nextButtons)
  if (info.project.name === 'iphone-webkit') {
    await page.context().setOffline(false)
    await expect(page.locator(`[data-entry-id="${rowId}"] .row-status`)).toContainText('Backed up', {
      timeout: 30_000,
    })
    await expectNoJump(page, focused, row, nextButtons, beforeSync)
    await page.screenshot({ path: `${shots}/after-${info.project.name}.png`, scale: 'css' })
    return
  }
  await page.context().setOffline(false)
  await page
    .locator('.new-entry-toolbar .sync-now-button .button')
    .evaluate((button: HTMLButtonElement) => button.click())
  await started
  await expectNoJump(page, focused, row, nextButtons, beforeSync)
  releaseRequest()
  await expect(page.locator('.global-sync')).toContainText('Sync error')
  await expectNoJump(page, focused, row, nextButtons, beforeSync)

  await page.context().setOffline(true)
  await expect(page.locator('.global-sync')).toContainText('Will sync when online')
  await expectNoJump(page, focused, row, nextButtons, beforeSync)
  await page.unroute('**/api/sync/batch')
  await page.context().setOffline(false)
  await expect(page.locator(`[data-entry-id="${rowId}"] .row-status`)).toContainText('Backed up', {
    timeout: 30_000,
  })
  await expectNoJump(page, focused, row, nextButtons, beforeSync)
  await page.screenshot({ path: `${shots}/after-${info.project.name}.png`, scale: 'css' })
})
