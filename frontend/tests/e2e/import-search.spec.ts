import { mkdir } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { idbSnapshot } from './helpers/local'
import { addEntry } from './helpers/sync'

const shots = '/tmp/codex-runs/A4-shots'

async function createLocalCollection(page: import('@playwright/test').Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'New collection' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByRole('radio', { name: /Local Only/ }).check()
  await page.getByRole('button', { name: 'Create collection' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

test('searches shared items across collections and imports the grouped item once', async ({ page }) => {
  const suffix = Date.now()
  const sourceA = `Search A ${suffix}`
  const sourceB = `Search B ${suffix}`
  const target = `Search target ${suffix}`
  const title = `Blue bronze lamp ${suffix}`

  await createLocalCollection(page, sourceA)
  const entryA = await addEntry(page)
  await entryA.getByLabel('Entry title').fill(title)
  await entryA.getByLabel('Entry title').blur()
  // The next collection setup reloads the page, so wait for the IndexedDB commit.
  const sourceEntryId = await entryA.getAttribute('data-entry-id')
  await expect
    .poll(async () => {
      const { entries, items } = await idbSnapshot(page)
      const itemId = entries.find((entry) => entry.id === sourceEntryId)?.item_id
      return items.find((item) => item.id === itemId)?.title
    })
    .toBe(title)
  await createLocalCollection(page, sourceB)
  await page.locator('summary[aria-label="Collection actions"]').click()
  await page.getByRole('menuitem', { name: 'Import from another collection' }).click()
  await page.getByRole('button', { name: sourceA }).click()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Import 1' }).click()
  await expect(page.getByText('Imported 1 item')).toBeVisible()

  await createLocalCollection(page, target)
  await page.locator('summary[aria-label="Collection actions"]').click()
  await page.getByRole('menuitem', { name: 'Import from another collection' }).click()
  const search = page.getByRole('textbox', { name: 'Search all collections' })
  await search.fill(`bronze ${suffix}`)
  const result = page.getByText(title, { exact: true })
  await expect(result).toBeVisible()
  const row = result.locator('xpath=ancestor::label[contains(@class,"candidate-row")]')
  await expect(row).toContainText(sourceA)
  await expect(row).toContainText(sourceB)
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: `${shots}/import-search-${test.info().project.name}.png` })
  await row.getByRole('checkbox').check()
  await expect(page.getByText('1 selected')).toBeVisible()
  await page.getByRole('button', { name: 'Import 1' }).click()
  await expect(page.getByText('Imported 1 item')).toBeVisible()
  await expect(page.locator('[data-entry-id]')).toHaveCount(1)
  await expect(page.locator('[data-entry-id]').first().getByLabel('Entry title')).toHaveValue(title)
})
