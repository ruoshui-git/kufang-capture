import { test, expect, type Page } from '@playwright/test'
import { addEntry, createCollection, signIn, waitBackedUp } from './helpers/sync'

test.use({ serviceWorkers: 'block' })

async function geometry(page: Page, rowId: string, nextId: string, label: string) {
  return page.evaluate(
    ({ rowId, nextId, label }) => {
      const row = document.querySelector(`[data-entry-id="${rowId}"] .entry-row`)!
      const input = row.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
      const next = document.querySelector(`[data-entry-id="${nextId}"] .entry-row`)!
      const rect = (element: Element) => {
        const box = element.getBoundingClientRect()
        return [box.x, box.y, box.width, box.height]
      }
      return {
        input: rect(input),
        row: rect(row),
        nextButtons: Array.from(next.querySelectorAll('button, summary'), rect),
        scrollY: window.scrollY,
        focused: document.activeElement === input,
        selection: [input.selectionStart, input.selectionEnd],
      }
    },
    { rowId, nextId, label },
  )
}

test('sync and live row updates keep focused controls and surrounding rows fixed', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop-chromium', 'covers the compact phone layout')
  await signIn(page)
  await createCollection(page, `No jump ${Date.now()}`, 'synced')
  for (let index = 0; index < 9; index++) await addEntry(page)
  await waitBackedUp(page)

  const actions = page.locator('summary[aria-label="Collection actions"]')
  await actions.click()
  await page.getByRole('menuitemradio', { name: /Last edited/ }).click()
  await page.locator('.filter-trigger summary').click()
  await page.getByRole('menuitemradio', { name: /Any incomplete/ }).click()
  await expect(page.locator('.filter-trigger summary')).toContainText('Incomplete')

  const wrappers = page.locator('.entry-list > [data-entry-id]')
  const order = () => wrappers.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-entry-id')!))
  await expect(wrappers).toHaveCount(9)
  const originalOrder = await order()
  const rowId = originalOrder[4]!
  const nextId = originalOrder[5]!
  const target = page.locator(`[data-entry-id="${rowId}"]`)
  const status = target.locator('.row-status')
  const globalStatus = page.getByLabel('Sync status', { exact: true })
  await page.context().setOffline(true)
  await expect(globalStatus).not.toContainText('Will sync when online')

  for (const [label, value] of [
    ['Entry title', 'Stable title'],
    ['Quantity', '12'],
    ['Dimensions', '10 x 20 cm'],
  ] as const) {
    const input = target.getByLabel(label)
    await input.scrollIntoViewIfNeeded()
    await input.focus()
    const position = await geometry(page, rowId, nextId, label)
    expect(position.focused).toBe(true)
    expect(position.scrollY).toBeGreaterThan(0)
    if (label === 'Quantity') {
      await input.fill('invalid')
      await expect(target.getByRole('alert')).toContainText('Enter a number')
      expect(await geometry(page, rowId, nextId, label)).toEqual({ ...position, selection: [7, 7] })
    }
    await input.fill(value)
    const baseline = { ...position, selection: [value.length, value.length] }
    await expect(status).toContainText('Saving…')
    expect(await geometry(page, rowId, nextId, label)).toEqual(baseline)
    await expect(status).toContainText('Pending sync')
    expect(await geometry(page, rowId, nextId, label)).toEqual(baseline)
  }
  await expect(globalStatus).toContainText('Will sync when online')

  const batch = '**/api/sync/batch'
  let releaseRequest!: () => void
  const released = new Promise<void>((resolve) => (releaseRequest = resolve))
  await page.route(batch, async (route) => {
    await released
    await route.fulfill({ status: 503, json: { message: 'temporary failure' } })
  })

  const focused = target.getByLabel('Dimensions')
  // Use a selection inside the value so resetting the caret to the end would fail the test.
  await focused.evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 5))
  const beforeSync = await geometry(page, rowId, nextId, 'Dimensions')
  expect(beforeSync.focused).toBe(true)
  const expectFixed = async () => {
    expect(await geometry(page, rowId, nextId, 'Dimensions')).toEqual(beforeSync)
    expect(await order()).toEqual(originalOrder)
  }

  try {
    const request = page.waitForRequest(batch)
    await page.context().setOffline(false)
    // Retry without taking focus away from the field being measured.
    await page
      .locator('.new-entry-toolbar .sync-now-button button')
      .evaluate((button: HTMLButtonElement) => button.click())
    await request
    await expect(page.getByRole('status', { name: 'Syncing', exact: true })).toBeVisible()
    await expectFixed()
    releaseRequest()
    await expect(globalStatus).toContainText('Sync error')
    await expectFixed()

    await page.context().setOffline(true)
    await expect(globalStatus).toContainText('Will sync when online')
    await expectFixed()
  } finally {
    releaseRequest()
    await page.unroute(batch)
  }

  await page.context().setOffline(false)
  await expect(status).toContainText('Backed up', { timeout: 30_000 })
  await expectFixed()

  await focused.blur()
  expect(await order()).toEqual(originalOrder)
  await actions.click()
  await page.getByRole('menuitemradio', { name: /Oldest first/ }).click()
  await actions.click()
  await page.getByRole('menuitemradio', { name: /Last edited/ }).click()
  await expect(wrappers.first()).toHaveAttribute('data-entry-id', rowId)
})
