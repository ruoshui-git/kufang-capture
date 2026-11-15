import { mkdir } from 'node:fs/promises'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { addEntry, signIn } from './helpers/sync'

const shots = '/tmp/codex-runs/w3-mobile-layout-shots'

async function screenshot(page: Page, name: string) {
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: `${shots}/${name}.png` })
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth),
  )
}

async function checkMenu(page: Page, trigger: Locator, name: string) {
  await trigger.click()
  const menu = page.getByRole('menu').last()
  await expect(menu).toBeVisible()
  const box = await menu.boundingBox()
  if (!box) throw new Error('Menu is not rendered')
  const viewport = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(15.5)
  expect(box.y).toBeGreaterThanOrEqual(15.5)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 15.5)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 15.5)
  const item = menu.getByRole('menuitem').or(menu.getByRole('menuitemradio')).first()
  const itemBox = await item.boundingBox()
  if (!itemBox) throw new Error('First menu item is not rendered')
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[role="menuitem"], [role="menuitemradio"]') !== null,
      {
        x: itemBox.x + itemBox.width / 2,
        y: itemBox.y + itemBox.height / 2,
      },
    ),
  ).toBe(true)
  await screenshot(page, name)
  await page.keyboard.press('Escape')
}

test('phone layouts keep actions visible and every menu inside the viewport', async ({ page }, info) => {
  test.skip(!['iphone-chromium', 'desktop-chromium'].includes(info.project.name))
  const desktop = info.project.name === 'desktop-chromium'
  const suffix = Date.now()
  const source = `Long storeroom collection name ${suffix}`
  const target = `Shared target collection ${suffix}`
  await page.setViewportSize(desktop ? { width: 1280, height: 800 } : { width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: 'New collection' }).click()
  await page.getByLabel('Name').fill(source)
  await page.getByLabel('Folder').fill(`Temple supplies ${suffix}`)
  await page.getByLabel('Local Only').check()
  await page.getByRole('button', { name: 'Create collection' }).click()
  for (let index = 0; index < 6; index++) {
    const row = await addEntry(page)
    await row.getByLabel('Entry title').fill(`Long title for storeroom inventory item number ${index + 1}`)
    await row.getByLabel('Entry title').blur()
  }
  const first = page.locator('[data-entry-id]').first()
  await first.getByLabel('Star entry').click()
  const needsReview = page.locator('[data-entry-id]').first()
  await needsReview.getByLabel('Entry actions').click()
  await page.getByRole('menuitem', { name: 'Mark needs review' }).click()

  await page.goto('/')
  await page.getByRole('button', { name: 'New collection' }).click()
  await page.getByPlaceholder('e.g. Temple 2 / A04').fill(target)
  await page.getByRole('radio', { name: /Local Only/ }).check()
  await page.getByRole('button', { name: 'Create collection' }).click()
  await expect(page.getByRole('heading', { name: target })).toBeVisible()
  await page.locator('summary[aria-label="Collection actions"]').click()
  await page.getByRole('menuitem', { name: 'Import from another collection' }).click()
  await page.getByRole('button', { name: source }).click()
  await page.getByRole('checkbox').first().check()
  await page.getByRole('button', { name: 'Import 1' }).click()
  await expect(
    page
      .locator('[data-entry-id]')
      .first()
      .getByText(/Shared · 2 collections/),
  ).toBeVisible()

  await page.goto('/')
  for (const width of desktop ? [1280] : [390, 320]) {
    const height = desktop ? 800 : width === 390 ? 844 : 640
    await page.setViewportSize({ width, height })
    await noHorizontalScroll(page)
    await checkMenu(
      page,
      page.getByLabel(`Actions for ${source}`, { exact: true }),
      `collection-card-menu-${width}x${height}`,
    )
    await page.getByLabel(`Actions for ${source}`, { exact: true }).click()
    await page.getByRole('menuitem', { name: 'Export ZIP' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await noHorizontalScroll(page)
    await page.getByRole('button', { name: 'Close' }).click()
    await page.getByLabel(`Actions for ${source}`, { exact: true }).click()
    await page.getByRole('menuitem', { name: 'Clear from this device…' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await noHorizontalScroll(page)
    await page.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await screenshot(page, `selection-mode-${width}x${height}`)
    await page.getByRole('button', { name: 'Cancel selection' }).click()
    await page.getByRole('link', { name: `Open ${source}` }).click()
    const entryRow = page.locator('[data-entry-id]').first()
    const head = entryRow.locator('.row-head')
    const controls = [
      head.locator('.tag-link'),
      head.getByLabel('Entry title'),
      head.getByLabel('Unstar entry'),
      head.locator('summary[aria-label="Entry actions"]'),
    ]
    const boxes = await Promise.all(controls.map((control) => control.boundingBox()))
    expect(boxes.every(Boolean)).toBe(true)
    const centers = boxes.map((box) => box!.y + box!.height / 2)
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(4)
    await screenshot(page, `entry-row-before-${width}x${height}`)
    await checkMenu(page, controls[3]!, `entry-first-menu-${width}x${height}`)
    const last = page.locator('[data-entry-id]').last()
    await last.scrollIntoViewIfNeeded()
    await checkMenu(
      page,
      last.locator('summary[aria-label="Entry actions"]'),
      `entry-last-menu-${width}x${height}`,
    )
    await page.locator('summary[aria-label="Collection actions"]').scrollIntoViewIfNeeded()
    await checkMenu(
      page,
      page.locator('summary[aria-label="Collection actions"]'),
      `collection-actions-${width}x${height}`,
    )
    await page.locator('summary[aria-label="Collection actions"]').click()
    await page.getByRole('menuitem', { name: 'Import from another collection' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await noHorizontalScroll(page)
    await page.getByRole('button', { name: 'Close' }).click()
    await checkMenu(
      page,
      page.locator('summary').filter({ hasText: 'Incomplete' }),
      `incomplete-menu-${width}x${height}`,
    )
    await entryRow.getByRole('button', { name: 'Details', exact: true }).click()
    await noHorizontalScroll(page)
    await screenshot(page, `detail-header-${width}x${height}`)
    await page.goto('/starred')
    await noHorizontalScroll(page)
    await screenshot(page, `starred-page-${width}x${height}`)
    await page.goto('/settings')
    await noHorizontalScroll(page)
    await page.getByRole('button', { name: 'Export all data' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await noHorizontalScroll(page)
    await page.getByRole('button', { name: 'Close' }).click()
    await signIn(page)
    await page.goto('/server')
    await expect(page.getByRole('heading', { name: 'Server exports' })).toBeVisible()
    await noHorizontalScroll(page)
    await page.goto('/')
  }
})
