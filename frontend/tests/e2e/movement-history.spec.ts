import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { unzipSync } from 'fflate'
import { addEntry, createCollection, signIn } from './helpers/sync'

type Placement = { id: string; collection_id: string; item_id: string; deleted_at: string | null }
type Movement = {
  id: string
  item_id: string
  from_entry_id: string
  to_entry_id: string
  quantity: string | null
  kind: string
  undone_at: string | null
}

async function changeRecords<T>(page: Page, entity: string): Promise<T[]> {
  const records = new Map<string, T>()
  let cursor = 0
  let more = true
  while (more) {
    const response = await page.request.get('/api/sync/changes', { params: { schema: 3, cursor } })
    expect(response.ok()).toBe(true)
    const payload = await response.json()
    for (const row of payload.changes) {
      if (row.entity !== entity) continue
      if (row.record) records.set(row.id, row.record)
      else records.delete(row.id)
    }
    cursor = payload.cursor
    more = payload.has_more
  }
  return [...records.values()]
}

async function move(page: Page, row: ReturnType<Page['locator']>, room: string, amount?: string) {
  await row.getByLabel('Entry actions').click()
  await page.getByRole('menuitem', { name: 'Move to…' }).click()
  if (amount) await page.getByRole('textbox', { name: 'Amount to move' }).fill(amount)
  await page.getByRole('button', { name: new RegExp(room) }).click()
}

test('movement history syncs both ways and appears identically in server and device exports', async ({
  page,
  browser,
}, testInfo) => {
  mkdirSync('/tmp/codex-runs/D-shots', { recursive: true })
  if (testInfo.project.name.startsWith('iphone')) await page.setViewportSize({ width: 360, height: 800 })
  const prefix = 'History ' + testInfo.project.name + ' ' + Date.now().toString(36)
  const home = prefix + ' A'
  const away = prefix + ' B'
  await signIn(page)
  await createCollection(page, away, 'synced')
  const awayPath = new URL(page.url()).pathname
  await createCollection(page, home, 'synced')
  const homePath = new URL(page.url()).pathname
  const source = await addEntry(page, '12')
  const sourceId = (await source.getAttribute('data-entry-id'))!
  await source.getByLabel('Quantity').blur()
  await expect
    .poll(async () => (await changeRecords<Placement>(page, 'entry')).some((e) => e.id === sourceId))
    .toBe(true)

  await move(page, source, away, '5')
  await expect(page.getByText('1 move', { exact: true })).toBeVisible()
  await expect
    .poll(async () =>
      (await changeRecords<Movement>(page, 'movement')).find((m) => m.from_entry_id === sourceId),
    )
    .toMatchObject({ kind: 'part', quantity: '5', undone_at: null })

  const second = await browser.newContext({ baseURL: testInfo.project.use.baseURL })
  try {
    const other = await second.newPage()
    await signIn(other)
    await other.goto(awayPath)
    const arriving = other.locator('[data-entry-id]').first()
    await expect(arriving.locator('.movement-preview')).toHaveText('From ' + home + ' · 1 move')
    const arrivingId = (await arriving.getAttribute('data-entry-id'))!
    await other.goto(awayPath + '/e/' + arrivingId)
    await expect(other.getByRole('region', { name: 'History' }).locator('li')).toContainText(
      '5 from ' + home + ' #0001',
    )
    await other.goto(awayPath)
    await move(other, arriving, home)
    await expect
      .poll(async () =>
        (await changeRecords<Movement>(other, 'movement')).find((m) => m.from_entry_id === arrivingId),
      )
      .toMatchObject({ kind: 'move', to_entry_id: sourceId, quantity: '5' })
    await other.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(other.getByText('Move undone')).toBeVisible()
    await expect
      .poll(async () =>
        (await changeRecords<Movement>(other, 'movement')).find((m) => m.from_entry_id === arrivingId),
      )
      .toMatchObject({ undone_at: expect.any(String) })
    await move(other, arriving, home)
    await expect
      .poll(async () =>
        (await changeRecords<Movement>(other, 'movement')).filter(
          (m) => m.from_entry_id === arrivingId && !m.undone_at,
        ),
      )
      .toMatchObject([{ kind: 'move', to_entry_id: sourceId, quantity: '5' }])
  } finally {
    await second.close()
  }

  await page.goto(homePath + '/e/' + sourceId)
  const history = page.getByRole('region', { name: 'History' })
  await expect(history.locator('li')).toHaveCount(2)
  await expect(history.locator('li').nth(0)).toContainText('→ 5 to ' + away + ' #0001')
  await expect(history.locator('li').nth(1)).toContainText('5 from ' + away + ' #0001')
  await history.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/codex-runs/D-shots/' + testInfo.project.name + '-history.png' })
  if (testInfo.project.name === 'iphone-chromium' || testInfo.project.name === 'desktop-chromium') {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: '/tmp/codex-runs/D-shots/' + testInfo.project.name + '-history-dark.png' })
  }

  await page.goto(homePath)
  await page.getByLabel('Collection actions').click()
  await page.getByRole('menuitem', { name: 'Export ZIP' }).click()
  const downloaded = page.waitForEvent('download', { timeout: 15_000 })
  await page.getByRole('dialog').getByRole('button', { name: 'Export ZIP' }).click()
  const device = await downloaded
  const stream = (await device.createReadStream())!
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const deviceZip = unzipSync(Buffer.concat(chunks))
  const serverExport = await page.request.get(
    '/api/exports/collections/' + homePath.split('/').at(-1) + '.zip',
  )
  expect(serverExport.ok()).toBe(true)
  const serverZip = unzipSync(await serverExport.body())
  expect(deviceZip['capture-export/movements.csv']).toEqual(serverZip['capture-export/movements.csv'])
  const readJson = (zip: typeof deviceZip, name: string) =>
    JSON.parse(new TextDecoder().decode(zip['capture-export/' + name + '.json']))
  expect(readJson(deviceZip, 'movements')).toEqual(readJson(serverZip, 'movements'))
  const deviceManifest = readJson(deviceZip, 'manifest')
  expect(deviceManifest.format_version).toBe(4)
  expect(deviceManifest.counts.movements).toBe(3)
  expect(readJson(serverZip, 'manifest').counts).toEqual(deviceManifest.counts)
})
