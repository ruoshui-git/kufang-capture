import { expect, test, type Page } from '@playwright/test'
import { openLocalCollection } from './helpers/local'

const TOTAL = 95

/** Seeds entries straight into IndexedDB, so the list is opened cold like on a real visit. */
async function seedEntries(page: Page, collectionId: string, total: number) {
  await page.evaluate(
    ({ collectionId, total }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('kufang-capture')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction(['collections', 'items', 'entries'], 'readwrite')
          const at = new Date().toISOString()
          const meta = {
            created_at: at,
            updated_at: at,
            revision: 1,
            server_revision: null,
            sync_state: 'local_only',
          }
          for (let n = 1; n <= total; n++) {
            const id = `${collectionId}-${n}`
            tx.objectStore('items').put({
              ...meta,
              id,
              title: `Item ${n}`,
              notes: '',
              expiration_date: null,
              dimensions: '',
              review_status: 'draft',
            })
            tx.objectStore('entries').put({
              ...meta,
              id,
              collection_id: collectionId,
              item_id: id,
              sequence_number: n,
              quantity: '1',
              unit: 'box',
              count_detail: '',
              entry_notes: '',
              starred_at: null,
              deleted_at: null,
            })
          }
          const collections = tx.objectStore('collections')
          const get = collections.get(collectionId)
          get.onsuccess = () => collections.put({ ...get.result, next_sequence_number: total + 1 })
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      }),
    { collectionId, total },
  )
}

async function openLongCollection(page: Page, name: string) {
  await openLocalCollection(page, name)
  const collectionId = new URL(page.url()).pathname.split('/')[2]!
  await seedEntries(page, collectionId, TOTAL)
  await page.reload()
  await expect(page.locator('[data-entry-id]').first()).toBeVisible()
  return collectionId
}

const rowFor = (page: Page, collectionId: string, n: number) =>
  page.locator(`[data-entry-id="${collectionId}-${n}"]`)

async function scrollToEnd(page: Page, expectedRows: number) {
  await expect(async () => {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    expect(await page.locator('[data-entry-id]').count()).toBe(expectedRows)
  }).toPass({ timeout: 10_000 })
}

test('scrolling a long collection reaches every entry on a fresh visit', async ({ page }) => {
  const collectionId = await openLongCollection(page, 'Long room')
  await scrollToEnd(page, TOTAL)
  await expect(rowFor(page, collectionId, 1)).toBeVisible()
})

test('the list says how many entries are not yet shown and reveals them on request', async ({ page }) => {
  const collectionId = await openLongCollection(page, 'Counted room')
  await expect(page.getByText(`Showing 40 of ${TOTAL} entries`)).toBeAttached()
  await page.getByRole('button', { name: 'Show the rest' }).evaluate((button: HTMLElement) => button.click())
  await expect(page.locator('[data-entry-id]')).toHaveCount(TOTAL)
  await expect(rowFor(page, collectionId, 1)).toBeAttached()
  await expect(page.getByText(/^Showing /)).toHaveCount(0)
})

test('returning from details keeps the old entry in view', async ({ page }) => {
  const collectionId = await openLongCollection(page, 'Return room')
  await scrollToEnd(page, TOTAL)
  await rowFor(page, collectionId, 1).getByRole('button', { name: 'Details', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/e/${collectionId}-1$`))
  await page.goBack()
  await expect(rowFor(page, collectionId, 1)).toBeInViewport()
})

test('a new entry in an oldest-first list is revealed', async ({ page }) => {
  await openLongCollection(page, 'Oldest room')
  await page.getByLabel('Collection actions').click()
  await page.getByRole('menuitemradio', { name: 'Oldest first' }).click()
  await page
    .getByRole('button', { name: /New Entry/ })
    .first()
    .click()
  await expect(page.getByPlaceholder(`Entry #00${TOTAL + 1}`)).toBeInViewport()
})

test('search and filters never carry over to another collection', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'), 'the collection rail is desktop only')
  await openLocalCollection(page, 'Other room')
  const otherId = new URL(page.url()).pathname.split('/')[2]!
  await seedEntries(page, otherId, 3)
  await openLongCollection(page, 'First room')
  await page.getByRole('textbox', { name: 'Search entries' }).fill('Item 95')
  await expect(page.getByText(`1 of ${TOTAL} entries match`)).toBeVisible()
  await page.locator(`a[href="/c/${otherId}"]`).first().click()
  await expect(page.getByRole('heading', { name: 'Other room' })).toBeVisible()
  await expect(page.locator('[data-entry-id]')).toHaveCount(3)
  await expect(page.getByRole('textbox', { name: 'Search entries' })).toHaveValue('')
})

test('a search without matches says entries are hidden instead of claiming the room is empty', async ({
  page,
}) => {
  await openLongCollection(page, 'Search room')
  await page.getByRole('textbox', { name: 'Search entries' }).fill('nothing like this')
  await expect(page.getByRole('heading', { name: 'No matching entries' })).toBeVisible()
  await page.getByRole('button', { name: 'Show all entries' }).click()
  await expect(page.locator('[data-entry-id]').first()).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Search entries' })).toHaveValue('')
})
