import { createHash } from 'node:crypto'
import { expect, type BrowserContext, type Page, type APIResponse } from '@playwright/test'

export type PhotoFixture = { bytes: Buffer; sha256: string; filename: string }

export async function photoFixture(page: Page, seed: string): Promise<PhotoFixture> {
  const dataUrl = await page.evaluate((label) => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext('2d')!
    context.fillStyle = `hsl(${Array.from(label).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360} 65% 45%)`
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = 'white'
    context.font = '8px sans-serif'
    context.fillText(label.slice(0, 10), 2, 32)
    return canvas.toDataURL('image/jpeg', 0.85)
  }, seed)
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), filename: `${seed}.jpg` }
}

export async function signIn(page: Page, password = 'dev') {
  await page.goto('/login?return=%2F')
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/')
}

export async function createCollection(page: Page, name: string, mode: 'synced' | 'local_only') {
  await page.goto('/')
  await page.getByRole('button', { name: 'New collection' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByLabel(mode === 'synced' ? 'Sync to Server' : 'Local Only').check()
  await page.getByRole('button', { name: 'Create collection' }).click()
  await page.getByRole('heading', { name }).waitFor()
}

export async function addEntry(page: Page, quantity?: string, note?: string) {
  const rows = page.locator('[data-entry-id]')
  const before = await rows.count()
  await page
    .getByRole('button', { name: /New Entry/ })
    .first()
    .click()
  // `rows.first()` is lazy: pin the new row by id so later steps cannot land on an older row.
  await expect(rows).toHaveCount(before + 1)
  const id = await rows.first().getAttribute('data-entry-id')
  const row = page.locator(`[data-entry-id="${id}"]`)
  if (quantity !== undefined) await row.getByLabel('Quantity').fill(quantity)
  if (note !== undefined) await row.getByLabel('Short note').fill(note)
  return row
}

export async function addPhoto(page: Page, row = page.locator('[data-entry-id]').first(), seed = 'photo') {
  const photo = await photoFixture(page, seed)
  const chooserPromise = page.waitForEvent('filechooser')
  await row.getByRole('button', { name: 'Add Photo' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles({ name: photo.filename, mimeType: 'image/jpeg', buffer: photo.bytes })
  await page.waitForFunction(
    (id) => {
      const row = document.querySelector(`[data-entry-id="${id}"]`)
      return row?.querySelector('.row-status')?.textContent?.match(/([1-9]\d*) photos?/) != null
    },
    await row.getAttribute('data-entry-id'),
  )
  return photo
}

export async function api<T>(page: Page, path: string, init?: RequestInit): Promise<T> {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, { credentials: 'include', ...init })
      if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${response.status}`)
      return (response.status === 204 ? undefined : response.json()) as T
    },
    { path, init: init as RequestInit | undefined },
  )
}

export async function loginContext(context: BrowserContext, baseURL: string) {
  const response: APIResponse = await context.request.post(`${baseURL}/api/auth/login`, {
    data: { password: 'dev' },
    headers: { 'X-Capture-Request': '1' },
  })
  if (!response.ok()) throw new Error(`Login failed: ${response.status()}`)
}

export async function waitBackedUp(page: Page, timeout = 30_000) {
  await expect
    .poll(
      async () => {
        const statuses = await page.locator('[data-entry-id] .row-status').allTextContents()
        return statuses.length > 0 && statuses.every((status) => status.includes('Backed up'))
      },
      { timeout },
    )
    .toBe(true)
  await expect(page.getByRole('status').filter({ hasText: 'Backed up' }).first()).toBeVisible({ timeout })
}

export async function syncNow(page: Page) {
  const button = page.locator('.new-entry-toolbar button.button.quiet')
  if (await button.isVisible().catch(() => false)) {
    const label = await button.innerText()
    if (label !== 'Sync now') return
    await expect(button).toBeEnabled()
    await button.click()
  }
}
