import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { addPhoto, idbSnapshot } from './helpers/local'

async function makeRoom(page: import('@playwright/test').Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'New collection' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByRole('radio', { name: /Local Only/ }).check()
  await page.getByRole('button', { name: 'Create collection' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

test('moves one entry between rooms, supports undo, and opens the placement', async ({ page }) => {
  mkdirSync('/tmp/codex-runs/move-to-shots', { recursive: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await makeRoom(page, 'Room A')
  await page
    .getByRole('button', { name: /New Entry/ })
    .first()
    .click()
  await expect(page.locator('[data-entry-id]')).toHaveCount(1)
  await page.getByLabel('Entry title').fill('Candles')
  await addPhoto(page, 1, 502)
  await page.goto('/')
  await makeRoom(page, 'Room B')
  await page.goto('/')
  await page.getByRole('link', { name: 'Open Room A' }).click()
  const row = page.locator('[data-entry-id]').first()
  await row.getByLabel('Entry actions').click()
  await page.getByRole('menuitem', { name: 'Move to…' }).click()
  await expect(page.getByRole('dialog', { name: 'Move #0001 to…' })).toBeVisible()
  await page.screenshot({ path: '/tmp/codex-runs/move-to-shots/picker-390.png', fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Move #0001 to…' })).toBeHidden()
  await row.getByLabel('Entry actions').click()
  await page.getByRole('menuitem', { name: 'Move to…' }).click()
  await page.getByRole('button', { name: /Room B/ }).click()
  await expect(page.locator('.toast')).toContainText('Moved to "Room B" as #0001', { timeout: 2000 })
  await page.screenshot({ path: '/tmp/codex-runs/move-to-shots/toast-390.png', fullPage: true })
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText('Move undone')).toBeVisible()
  await expect(page.locator('[data-entry-id]')).toHaveCount(1)
  const rowAgain = page.locator('[data-entry-id]').first()
  await rowAgain.getByLabel('Entry actions').click()
  await page.getByRole('menuitem', { name: 'Move to…' }).click()
  await page.getByRole('button', { name: /Room B/ }).click()
  await page.locator('.toast').getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/c\/[^/]+\/e\/[^/]+$/)
  await expect(page.getByRole('region', { name: 'History' }).getByText(/From Room A #0001/)).toBeVisible()
  await page.getByRole('button', { name: 'Show undone' }).click()
  await expect(page.getByRole('region', { name: 'History' }).locator('li.undone')).toContainText(
    'From Room A #0001',
  )
  await page.getByRole('button', { name: 'Add note for this collection' }).click()
  await expect(page.getByLabel('Notes for Room B')).toHaveValue('')
  await expect(page.getByLabel('Entry title')).toHaveValue('Candles')
  await expect(page.getByRole('button', { name: 'View photo 1' })).toBeVisible()
  await page.goto('/')
  await page.getByRole('link', { name: 'Open Room A' }).click()
  await page.getByRole('button', { name: 'Recently Deleted' }).click()
  await expect(page.getByText('Moved to "Room B" #0001')).toBeVisible()
  const sourceId = (await idbSnapshot(page)).entries.find(
    (item) => item.sequence_number === 1 && item.deleted_at,
  )?.id
  expect(sourceId).toBeTruthy()
  await page.goto(
    `/c/${(await idbSnapshot(page)).collections.find((item) => item.name === 'Room A')!.id}/e/${sourceId}`,
  )
  await expect(page.getByText('Moved to "Room B" as #0001')).toBeVisible()
  await page.screenshot({ path: '/tmp/codex-runs/move-to-shots/banner-390.png', fullPage: true })
})

test('moves part of a recorded quantity and leaves the remainder in the source room', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await makeRoom(page, 'Partial A')
  await page
    .getByRole('button', { name: /New Entry/ })
    .first()
    .click()
  await expect(page.locator('[data-entry-id]')).toHaveCount(1)
  const created = await idbSnapshot(page)
  const sourceId = created.entries.find((item) => !item.deleted_at)!.id
  const sourceCollectionId = created.collections.find((item) => item.name === 'Partial A')!.id
  await page.goto(`/c/${sourceCollectionId}/e/${sourceId}`)
  await page.getByLabel('Entry title').fill('Candles')
  await page.getByLabel('Quantity').fill('12')
  await page.getByLabel('Unit').fill('boxes')
  await page.getByLabel('Unit').blur()
  await page.getByLabel('Quantity').blur()
  await page.goto('/')
  await makeRoom(page, 'Partial B')
  await page.goto('/')
  await page.getByRole('link', { name: 'Open Partial A' }).click()
  const row = page.locator(`[data-entry-id="${sourceId}"]`)
  await row.getByLabel('Entry actions').click()
  await page.getByRole('menuitem', { name: 'Move to…' }).click()
  const amount = page.getByRole('textbox', { name: 'Amount to move' })
  await expect(amount).toHaveValue('12')
  await amount.fill('5')
  await page.getByRole('button', { name: /Partial B/ }).click()
  await expect(page.locator('.toast')).toContainText('Moved 5 boxes to "Partial B" as #0001')
  await expect(row.getByLabel('Quantity')).toHaveValue('7')
  const afterMove = await idbSnapshot(page)
  const sourceEntry = afterMove.entries.find((item) => item.id === sourceId)!
  expect(sourceEntry.quantity).toBe('7')
  const targetEntry = afterMove.entries.find(
    (item) => item.collection_id !== sourceEntry.collection_id && !item.deleted_at,
  )!
  expect(targetEntry.quantity).toBe('5')
  await page.goto('/')
  await page.getByRole('link', { name: 'Open Partial B' }).click()
  await expect(page.locator(`[data-entry-id="${targetEntry.id}"]`).getByLabel('Quantity')).toHaveValue('5')
})
