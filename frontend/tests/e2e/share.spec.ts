import { expect, test } from '@playwright/test'
import type { ShareLink } from '../../src/lib/share/contract'
import type { BrowserContext, Page } from '@playwright/test'
import { addEntry, addPhoto, createCollection, signIn, waitBackedUp } from './helpers/sync'

/** Chromium grants real clipboard access; WebKit has no clipboard permission, so stub the write. */
async function allowClipboard(page: Page, context: BrowserContext) {
  if (context.browser()?.browserType().name() === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    return
  }
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => {} }),
  )
}

test('an owner shares and revokes a synced collection for a signed-out visitor', async ({
  page,
  browser,
  baseURL,
  context,
}, { project }) => {
  const name = `Share room ${project.name} ${Date.now()}`
  await signIn(page)
  await createCollection(page, name, 'synced')
  const entry = await addEntry(page, '5', 'A shelf of supplies')
  await entry.getByRole('textbox', { name: 'Entry title' }).fill('Incense boxes')
  if (await entry.getByRole('button', { name: 'More details' }).isVisible()) {
    await entry.getByRole('button', { name: 'More details' }).click()
    await entry.getByLabel('Unit').fill('boxes')
  } else {
    await entry.getByRole('button', { name: 'Details', exact: true }).click()
    await page.locator('.detail-panel').getByLabel('Unit').fill('boxes')
    await page.goBack()
  }
  await addPhoto(page, entry, 'shared photo')
  await waitBackedUp(page)
  await allowClipboard(page, context)
  await page.getByLabel('Collection actions').click()
  await page.getByRole('menuitem', { name: 'Share read-only link…' }).click()
  const sheet = page.getByRole('dialog', { name: 'Share read-only link' })
  await expect(sheet.getByRole('radio', { name: '30 days' })).toBeChecked()
  await sheet.getByLabel('Label (optional)').fill('Boss')
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/shares' && response.request().method() === 'POST',
  )
  await sheet.getByRole('button', { name: 'Create link' }).click()
  const response = await created
  expect(response.status()).toBe(201)
  const link: ShareLink = await response.json()
  await expect(sheet.getByText('Link copied', { exact: true })).toBeVisible()
  await expect(sheet.getByText('Boss', { exact: true })).toBeVisible()
  await sheet.getByRole('button', { name: 'QR code' }).click()
  await expect(sheet.getByRole('img', { name: 'QR code for Boss' })).toBeVisible()

  const phone = !project.name.startsWith('desktop')
  const fresh = await browser.newContext({
    baseURL,
    viewport: page.viewportSize()!,
    isMobile: phone,
    hasTouch: phone,
  })
  try {
    expect(await fresh.cookies()).toEqual([])
    const visitor = await fresh.newPage()
    const api: string[] = []
    fresh.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) api.push(url.pathname)
      expect(url.search).not.toContain(link.url.split('#')[1]!)
    })
    await visitor.goto(link.url)
    await expect(visitor.getByRole('heading', { name })).toBeVisible()
    await expect(visitor.getByText('Read-only', { exact: true })).toBeVisible()
    await expect(visitor.locator('.chip.quantity')).toHaveText('5 boxes')

    const row = visitor.getByRole('button', { name: '#0001 · Incense boxes' })
    const search = visitor.getByRole('searchbox', { name: 'Search by number or title' })
    for (const query of ['42', '#1', '1', '0001', 'incense']) {
      await search.fill(query)
      await expect(row).toHaveCount(query === '42' ? 0 : 1)
    }
    await expect(visitor.locator('article img')).toBeVisible()
    await row.click()
    await expect(visitor).toHaveURL(`${link.url}/e/1`)
    const panel = visitor.getByRole(phone ? 'dialog' : 'region', { name: 'Incense boxes' })
    await expect(panel).toBeVisible()
    await expect(panel.getByText('A shelf of supplies')).toBeVisible()
    await visitor.goBack()
    await expect(panel).toHaveCount(0)

    await visitor.goto(`${link.url}/e/1`)
    await expect(panel).toBeVisible()
    const photo = panel.getByRole('button', { name: 'View photo 1' })
    await photo.click()
    const viewer = visitor.getByRole('dialog', { name: 'Photo viewer' })
    await expect(viewer.getByRole('img')).toBeVisible()
    await expect(viewer.getByRole('img')).toHaveAttribute('src', /^blob:/)
    await expect(viewer.getByRole('link')).toHaveCount(0)
    await visitor.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await expect(photo).toBeFocused()

    const ownerLink = sheet.getByRole('listitem').filter({ hasText: 'Boss' })
    await ownerLink.getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect(ownerLink.getByRole('alert')).toContainText('Anyone with the link will lose access.')
    await ownerLink.getByRole('button', { name: 'Revoke', exact: true }).last().click()
    await expect(ownerLink).toHaveCount(0)
    await visitor.reload()
    await expect(visitor.getByRole('alert')).toHaveText(
      "This link doesn't work. Ask the person who shared it for a new one.",
    )
    expect(api).toEqual(
      expect.arrayContaining([
        '/api/share',
        expect.stringMatching(/^\/api\/share\/photos\/[^/]+\/thumbnail$/),
        expect.stringMatching(/^\/api\/share\/photos\/[^/]+\/original$/),
      ]),
    )
    expect(api.filter((path) => !/^\/api\/share(?:\/|$)/.test(path))).toEqual([])
    expect(await fresh.cookies()).toEqual([])
    expect(await visitor.evaluate(() => indexedDB.databases())).toEqual([])
  } finally {
    await fresh.close()
  }
})

test('the Local Only share sheet makes no share request', async ({ page }, { project }) => {
  await createCollection(page, `Local share room ${project.name}`, 'local_only')
  const shareRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/share')) shareRequests.push(request.url())
  })
  await page.getByLabel('Collection actions').click()
  await page.getByRole('menuitem', { name: 'Share read-only link…' }).click()
  const sheet = page.getByRole('dialog', { name: 'Share read-only link' })
  await expect(sheet).toContainText(
    'Only collections that sync to the server can be shared. This collection stays on this device.',
  )
  await expect(sheet.getByRole('button', { name: 'Create link' })).toHaveCount(0)
  expect(shareRequests).toEqual([])
})

test('switching to Local Only revokes the share link and keeps the server copy', async ({
  page,
  context,
  request,
}, { project }) => {
  const name = `Share mode room ${project.name} ${Date.now()}`
  await signIn(page)
  await createCollection(page, name, 'synced')
  await addEntry(page)
  await waitBackedUp(page)
  await allowClipboard(page, context)
  await page.getByLabel('Collection actions').click()
  await page.getByRole('menuitem', { name: 'Share read-only link…' }).click()
  const shareSheet = page.getByRole('dialog', { name: 'Share read-only link' })
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/shares' && response.request().method() === 'POST',
  )
  await shareSheet.getByRole('button', { name: 'Create link' }).click()
  const response = await created
  expect(response.status()).toBe(201)
  const link: ShareLink = await response.json()
  const viewShared = () =>
    request.get('/api/share', { headers: { 'X-Capture-Share': new URL(link.url).hash.slice(1) } })
  expect((await viewShared()).status()).toBe(200)

  await page.goto('/')
  await page.getByLabel(`Actions for ${name}`).click()
  await page.getByRole('menuitem', { name: 'Change storage mode…' }).click()
  const storage = page.getByRole('dialog', { name: 'Change storage mode' })
  await expect(storage.getByText('Read-only links to this collection will stop working.')).toBeVisible()
  const revoked = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/shares/${link.id}` &&
      response.request().method() === 'DELETE',
  )
  await storage.getByRole('button', { name: 'Switch to Local Only' }).click()
  expect((await revoked).status()).toBe(204)
  await expect(storage).toBeHidden()
  const card = page.locator('.collection-card').filter({ has: page.getByRole('link', { name }) })
  await expect(card.getByRole('status', { name: 'Local Only' })).toBeVisible()
  expect((await viewShared()).status()).toBe(404)

  const server = await context.request.get('/api/collections')
  expect(server.ok()).toBe(true)
  expect(await server.json()).toContainEqual(expect.objectContaining({ id: link.collection_id }))
})

test('the Server page stops the live links of a server copy', async ({ page, request }, { project }) => {
  const name = `Share server room ${project.name} ${Date.now()}`
  await signIn(page)
  await createCollection(page, name, 'synced')
  await addEntry(page)
  await waitBackedUp(page)
  await page.getByLabel('Collection actions').click()
  await page.getByRole('menuitem', { name: 'Share read-only link…' }).click()
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/shares' && response.request().method() === 'POST',
  )
  await page
    .getByRole('dialog', { name: 'Share read-only link' })
    .getByRole('button', { name: 'Create link' })
    .click()
  const link: ShareLink = await (await created).json()
  const viewShared = () =>
    request.get('/api/share', { headers: { 'X-Capture-Share': new URL(link.url).hash.slice(1) } })
  expect((await viewShared()).status()).toBe(200)

  await page.goto('/server')
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name }) })
  await expect(card.getByText('1 read-only link still works.')).toBeVisible()
  await card.getByRole('button', { name: 'Stop links' }).click()
  await expect(card.getByText('1 read-only link still works.')).toBeHidden()
  expect((await viewShared()).status()).toBe(404)
})
