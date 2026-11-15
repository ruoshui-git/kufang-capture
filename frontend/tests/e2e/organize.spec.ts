import { expect, test } from '@playwright/test'
import { addEntry, openLocalCollection } from './helpers/local'

test('folders, starred entries, review state, and collection notes', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New collection' }).click()
  await page.getByLabel('Name').fill('Organize room')
  await page.getByLabel('Folder').fill('North wing')
  await page.getByRole('radio', { name: /Local Only/ }).check()
  await page.getByRole('button', { name: 'Create collection' }).click()
  await expect(page.getByRole('heading', { name: 'Organize room' })).toBeVisible()
  await addEntry(page)
  const row = page.locator('[data-entry-id]').first()
  await row.getByRole('button', { name: 'Star entry' }).click()
  await expect(row.getByRole('button', { name: 'Unstar entry' })).toHaveAttribute('aria-pressed', 'true')
  await row.getByRole('button', { name: 'Details' }).click()
  await page.getByLabel('Review status').selectOption('needs_review')
  await expect(page.getByText('Needs review').first()).toBeVisible()
  await page.getByRole('button', { name: 'Add note for this collection' }).click()
  await page.getByLabel('Notes for Organize room').fill('Keep with shelf inventory')
})

test('existing collections can be filed into folders and collapsed', async ({ page }) => {
  await openLocalCollection(page, 'Folder room')
  await page.goto('/')
  await page.getByRole('button', { name: /Actions for Folder room/ }).click()
  await page.getByRole('menuitem', { name: 'Rename / Edit' }).click()
  await page.getByLabel('Folder').fill('North wing')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('button', { name: /North wing/ })).toBeVisible()
  await page.getByRole('button', { name: /North wing/ }).click()
  await expect(page.getByRole('link', { name: 'Open Folder room' })).toHaveCount(0)
})
