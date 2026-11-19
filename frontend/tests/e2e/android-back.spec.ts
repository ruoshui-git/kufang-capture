import { test, expect } from '@playwright/test'
import { addEntry, addPhoto, createCollection } from './helpers/sync'

test('Back dismisses the top overlay before leaving its route', async ({ page }, info) => {
  test.skip(!['android-chromium', 'iphone-chromium'].includes(info.project.name))
  const collectionName = `Back behavior ${Date.now()}`
  await createCollection(page, collectionName, 'local_only')
  const route = page.url()

  await page.locator('summary[aria-label="Collection actions"]').click()
  await page.getByRole('menuitem', { name: 'Export ZIP' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page).toHaveURL(route)

  await page.locator('summary[aria-label="Collection actions"]').click()
  await page.getByRole('menuitem', { name: 'Export ZIP' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
  await page.goBack()
  await expect(page).toHaveURL('/')
  await page.getByRole('link', { name: `Open ${collectionName}` }).click()
  await expect(page).toHaveURL(route)

  const row = await addEntry(page)
  const id = await row.getAttribute('data-entry-id')
  await addPhoto(page, row, `back-${Date.now()}`)
  await row.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/c/[^/]+/e/${id}$`))
  await page.getByRole('button', { name: 'View photo 1' }).click()
  await expect(page.getByRole('dialog', { name: 'Photo viewer' })).toBeVisible()
  const detailRoute = page.url()
  await page.goBack()
  await expect(page.getByRole('dialog', { name: 'Photo viewer' })).not.toBeVisible()
  await expect(page).toHaveURL(detailRoute)
})
