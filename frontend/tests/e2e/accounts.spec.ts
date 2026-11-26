import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { addEntry, addPhoto, api, createCollection, signIn, syncNow, waitBackedUp } from './helpers/sync'

const evidenceDir = process.env.ACCOUNTS_SHOTS_DIR
const viewport = { width: 390, height: 844 }
const dataRequest = /\/api\/(sync|photos|collections|exports)(?:[/?]|$)/

async function screenshot(page: Page, name: string) {
  if (!evidenceDir || test.info().project.name !== 'iphone-webkit') return
  await mkdir(evidenceDir, { recursive: true })
  await page.screenshot({ path: join(evidenceDir, `${name}.png`), scale: 'css' })
}

function personRow(page: Page, name: string): Locator {
  return page.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) })
}

async function openPeople(page: Page) {
  await page.goto('/settings')
  await page.getByRole('button', { name: 'People', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'People', exact: true })).toBeVisible()
}

async function addPerson(page: Page, name: string) {
  await openPeople(page)
  await page.getByRole('button', { name: 'Add person' }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(personRow(page, name)).toBeVisible()
}

async function codeFromSheet(page: Page, name: string) {
  const sheet = page.getByRole('dialog', { name: `Sign-in code for ${name}` })
  await expect(sheet.getByRole('img', { name: 'QR code for helper sign-in' })).toBeVisible()
  return (await sheet.locator('.join-code').innerText()).trim()
}

async function issueCode(page: Page, name: string) {
  await personRow(page, name).getByRole('button', { name: 'Sign-in code' }).click()
  return codeFromSheet(page, name)
}

async function enterCode(page: Page, code: string, returnTo = '/') {
  await page.goto(`/login?return=${encodeURIComponent(returnTo)}`)
  await page.getByRole('button', { name: 'Enter code', exact: true }).click()
  await page.getByRole('textbox', { name: 'Sign-in code' }).fill(code.replace('-', ' ').toLowerCase())
  await expect(page.getByRole('textbox', { name: 'Sign-in code' })).toHaveValue(code.replace('-', ' '))
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

test('pairs a helper, isolates rooms and photos, and refuses to switch a device with data', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize(viewport)
  const userAgent = await page.evaluate(() => navigator.userAgent)
  const helperContext = await browser.newContext({
    baseURL,
    viewport,
    userAgent,
    isMobile: true,
    hasTouch: true,
  })
  const wechatContext = await browser.newContext({
    baseURL,
    viewport,
    userAgent: `${userAgent} MicroMessenger/8.0.61`,
    isMobile: true,
    hasTouch: true,
  })
  const otherHelperContext = await browser.newContext({
    baseURL,
    viewport,
    userAgent,
    isMobile: true,
    hasTouch: true,
  })
  const suffix = Date.now()
  const helperName = `Mina ${suffix}`
  const ownerRoom = `Owner room ${suffix}`
  const helperRoom = `Helper room ${suffix}`
  try {
    await signIn(page)
    await addPerson(page, helperName)
    await screenshot(page, 'people')
    const code = await issueCode(page, helperName)
    await expect(page.getByText(/Expires in/)).toBeVisible()
    await screenshot(page, 'code-sheet')

    const wechat = await wechatContext.newPage()
    const wechatJoins: string[] = []
    wechat.on('request', (request) => {
      if (request.url().endsWith('/api/auth/join')) wechatJoins.push(request.url())
    })
    await wechat.goto(`/join#${code}`)
    await expect(wechat.getByRole('heading', { name: 'Open in Chrome or Safari' })).toBeVisible()
    await expect(wechat.getByText(code, { exact: true })).toBeVisible()
    await expect(wechat.getByRole('button', { name: 'Copy code' })).toBeVisible()
    await expect(wechat.getByRole('button', { name: 'Sign in as helper' })).toHaveCount(0)
    expect(wechatJoins).toEqual([])
    await screenshot(wechat, 'wechat-notice')

    const helper = await helperContext.newPage()
    const helperRequests: { method: string; path: string; account: string | undefined }[] = []
    helper.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (dataRequest.test(path)) {
        helperRequests.push({
          method: request.method(),
          path,
          account: request.headers()['x-capture-account'],
        })
      }
    })
    await helper.goto(`/join#${code}`)
    await expect(helper).toHaveURL(/\/join$/)
    await expect(helper.getByRole('heading', { name: 'Sign in as helper?' })).toBeVisible()
    await expect(helper.getByText(code, { exact: true })).toBeVisible()
    await screenshot(helper, 'join-page')
    await helper.getByRole('button', { name: 'Sign in as helper' }).click()
    await helper.waitForURL('**/')
    const account = await api<{ user: { id: string; name: string; is_owner: boolean } }>(
      helper,
      '/api/auth/session',
    )
    expect(account.user).toMatchObject({ name: helperName, is_owner: false })

    const otherHelper = await otherHelperContext.newPage()
    await enterCode(otherHelper, code)
    await expect(otherHelper.getByRole('alert')).toHaveText(/invalid, expired or already used/)

    const secondCode = await issueCodeAfterBack(page, helperName)
    await enterCode(otherHelper, secondCode)
    await otherHelper.waitForURL('**/')

    await helper.goto('/settings')
    await expect(helper.getByText(`Signed in as ${helperName}.`)).toBeVisible()
    await expect(helper.getByRole('button', { name: 'People', exact: true })).toHaveCount(0)
    expect((await helper.request.get('/api/people')).status()).toBe(403)
    await helper.goto('/')
    await helper.getByRole('button', { name: 'New collection' }).click()
    await expect(helper.getByLabel('Sync to Server')).toBeChecked()
    await helper.getByLabel('Name').fill(helperRoom)
    await helper.getByRole('button', { name: 'Create collection' }).click()
    await expect(helper.getByRole('heading', { name: helperRoom })).toBeVisible()
    const helperEntry = await addEntry(helper, '4', 'helper record')
    const helperPhoto = await addPhoto(helper, helperEntry, 'helper-original')
    await syncNow(helper)
    await waitBackedUp(helper)
    for (const request of helperRequests) expect(request.account, request.path).toBe(account.user.id)
    expect(helperRequests.map(({ method, path }) => method + ' ' + path)).toEqual(
      expect.arrayContaining([
        'POST /api/sync/batch',
        'GET /api/sync/changes',
        expect.stringMatching(/^HEAD \/api\/photos\/.+\/original$/),
        expect.stringMatching(/^PATCH \/api\/photos\/.+\/original$/),
      ]),
    )

    const imageResponse = (kind: 'thumbnail' | 'original') =>
      otherHelper.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname.endsWith(`/${kind}`) &&
          response.ok(),
      )
    const thumbnail = imageResponse('thumbnail')
    await otherHelper.goto('/')
    await otherHelper.getByRole('link', { name: `Open ${helperRoom}` }).click()
    expect((await thumbnail).request().headers()['x-capture-account']).toBe(account.user.id)
    const originalDownload = imageResponse('original')
    await otherHelper.getByRole('button', { name: 'Open photo', exact: true }).click()
    const remoteOriginal = await originalDownload
    expect(remoteOriginal.request().headers()['x-capture-account']).toBe(account.user.id)
    expect(
      createHash('sha256')
        .update(await remoteOriginal.body())
        .digest('hex'),
    ).toBe(helperPhoto.sha256)

    const remoteImage = otherHelper.getByRole('dialog', { name: 'Photo viewer' }).getByRole('img')
    await expect(remoteImage).toBeVisible()
    const sameDevice = await otherHelperContext.newPage()
    await sameDevice.goto('/login')
    await sameDevice.getByLabel('Password').fill('dev')
    await sameDevice.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(sameDevice.getByRole('alert')).toHaveText(
      `This device belongs to ${helperName}. Sign in as ${helperName}, or use another browser profile.`,
    )
    await expect(remoteImage).toHaveCount(0)
    await sameDevice.close()

    await createCollection(page, ownerRoom, 'synced')
    const ownerEntry = await addEntry(page, '7', 'owner record')
    const ownerEntryId = await ownerEntry.getAttribute('data-entry-id')
    const ownerPhoto = await addPhoto(page, ownerEntry, 'owner-original')
    await syncNow(page)
    await waitBackedUp(page)
    const ownerRoomPath = new URL(page.url()).pathname
    const ownCollections = await api<Array<{ name: string }>>(page, '/api/collections')
    const helperCollections = await api<Array<{ name: string }>>(helper, '/api/collections', {
      headers: { 'X-Capture-Account': account.user.id },
    })
    expect(ownCollections.map(({ name }) => name)).toContain(ownerRoom)
    expect(ownCollections.map(({ name }) => name)).not.toContain(helperRoom)
    expect(helperCollections.map(({ name }) => name)).toContain(helperRoom)
    expect(helperCollections.map(({ name }) => name)).not.toContain(ownerRoom)

    await openPeople(page)
    const wrongAccountCode = await issueCode(page, helperName)
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByText('Signed out.')).toBeVisible()
    await page.goto(ownerRoomPath)
    await expect(page.locator(`[data-entry-id="${ownerEntryId}"]`)).toBeVisible()
    const pending = await addEntry(page, '42', 'keep this unsent')
    const pendingId = await pending.getAttribute('data-entry-id')
    expect(pendingId).not.toBe(ownerEntryId)
    await expect(pending.locator('.row-status')).toContainText('Pending sync')
    const strayRequests: string[] = []
    const noteRequest = (request: import('@playwright/test').Request) => {
      if (dataRequest.test(new URL(request.url()).pathname)) strayRequests.push(request.url())
    }
    page.on('request', noteRequest)
    await enterCode(page, wrongAccountCode)
    await page.waitForURL('**/settings')
    await expect(page.getByRole('alert')).toHaveText(
      'This device belongs to Owner. Sign in as Owner, or use another browser profile.',
    )
    await expect(page.getByRole('button', { name: /Switch to/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
    await screenshot(page, 'blocked-device')
    await page.goto(ownerRoomPath)
    const stillPending = page.locator(`[data-entry-id="${pendingId}"]`)
    await expect(stillPending.getByLabel('Quantity')).toHaveValue('42')
    await expect(stillPending.getByLabel('Short note')).toHaveValue('keep this unsent')
    await expect(page.getByRole('status', { name: 'Sync blocked' })).toBeVisible()
    expect(strayRequests).toEqual([])
    page.off('request', noteRequest)

    await signIn(page)
    await page.goto(ownerRoomPath)
    await syncNow(page)
    await waitBackedUp(page)
    await expect(page.locator(`[data-entry-id="${pendingId}"]`).getByLabel('Short note')).toHaveValue(
      'keep this unsent',
    )
    const changes = await api<{
      changes: Array<{ entity: string; id: string; record: { sha256?: string } }>
    }>(page, '/api/sync/changes?cursor=0&schema=2')
    const uploaded = changes.changes.find(
      ({ entity, record }) => entity === 'photo' && record.sha256 === ownerPhoto.sha256,
    )
    expect(uploaded).toBeDefined()
    const original = await page.request.get(`/api/photos/${uploaded!.id}/original`)
    expect(
      createHash('sha256')
        .update(await original.body())
        .digest('hex'),
    ).toBe(ownerPhoto.sha256)
  } finally {
    await Promise.all([helperContext.close(), wechatContext.close(), otherHelperContext.close()])
  }
})

async function issueCodeAfterBack(page: Page, name: string) {
  await page.getByRole('button', { name: 'Back to People' }).click()
  return issueCode(page, name)
}

test('updates People and rejects a superseded code after the countdown expires', async ({
  page,
  browser,
  baseURL,
}) => {
  await signIn(page)
  const name = `New helper ${Date.now()}`
  const renamed = `${name} renamed`
  await addPerson(page, name)
  await personRow(page, name).getByRole('button', { name: 'Rename' }).click()
  await page.getByLabel('Name', { exact: true }).fill(renamed)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const code = await issueCode(page, renamed)
  await page.clock.setFixedTime(new Date(Date.now() + 11 * 60_000))
  await expect(page.getByText('This code has expired. Make a new code to sign in.')).toBeVisible()
  await page.clock.setFixedTime(new Date())
  await page.getByRole('button', { name: 'New code', exact: true }).click()
  const replacement = page.getByRole('dialog', { name: `Sign-in code for ${renamed}` }).locator('.join-code')
  await expect(replacement).not.toHaveText(code)
  await expect(replacement).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)

  const visitor = await browser.newPage({ baseURL })
  try {
    await visitor.goto(`/join#${code}`)
    await visitor.getByRole('button', { name: 'Sign in as helper' }).click()
    await expect(visitor.getByRole('alert')).toHaveText(/invalid, expired or already used/)
  } finally {
    await visitor.close()
  }

  await page.getByRole('button', { name: 'Back to People' }).click()
  await personRow(page, renamed).getByRole('button', { name: 'Disable' }).click()
  await page.getByRole('button', { name: `Disable ${renamed}`, exact: true }).click()
  await expect(personRow(page, renamed).getByText('Disabled', { exact: true })).toBeVisible()
  await expect(personRow(page, renamed).getByRole('button', { name: 'Sign-in code' })).toHaveCount(0)
  await personRow(page, renamed).getByRole('button', { name: 'Enable' }).click()
  await page.getByRole('button', { name: `Enable ${renamed}`, exact: true }).click()
  await expect(personRow(page, renamed).getByRole('button', { name: 'Sign-in code' })).toBeVisible()
})
