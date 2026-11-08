import { expect, test, type Locator } from '@playwright/test'
import { addEntry, addPhoto, openLocalCollection } from './helpers/local'

async function box(locator: Locator) {
  const value = await locator.boundingBox()
  if (!value) throw new Error('Element is not rendered')
  return value
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

test('menus close on an outside tap and extra fields fit side by side', async ({ page }, testInfo) => {
  await openLocalCollection(page, 'Layout room')
  await addEntry(page)
  await addEntry(page)
  await addPhoto(page, 1, 40)
  const row = page.locator('[data-entry-id]').filter({ has: page.getByPlaceholder('Entry #0001') })

  const menuSummary = row.getByLabel('Entry actions')
  await menuSummary.click()
  await expect(row.getByRole('menuitem', { name: 'Delete entry' })).toBeVisible()
  await page.getByRole('heading', { name: 'Layout room' }).click()
  await expect(row.getByRole('menuitem', { name: 'Delete entry' })).toBeHidden()

  const phone = (page.viewportSize()?.width ?? 0) < 700
  if (phone) {
    await row.getByRole('button', { name: 'More details' }).click()
    const expiration = row.getByLabel('Expiration date')
    const dimensions = row.getByLabel('Dimensions')
    await expiration.fill('2027-03-01')
    await dimensions.fill('30 × 20 × 15 cm')
    const rowBox = await box(row)
    for (const field of [expiration, dimensions]) {
      const fieldBox = await box(field)
      expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5)
    }
    expect(overlaps(await box(expiration), await box(dimensions))).toBe(false)
  }
  await page.screenshot({ path: testInfo.outputPath('entry-list.png'), fullPage: true })

  await row.getByRole('button', { name: 'Details', exact: true }).click()
  const expiration = page.locator('[data-field="expiration_date"]')
  const dimensions = page.locator('[data-field="dimensions"]')
  await expect(expiration).toBeVisible()
  await expect(dimensions).toBeVisible()
  if (phone) await expect(expiration).toHaveValue('2027-03-01')
  expect(overlaps(await box(expiration), await box(dimensions))).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('detail.png'), fullPage: true })
})
