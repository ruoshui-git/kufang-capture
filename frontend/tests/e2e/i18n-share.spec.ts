import { expect, test } from '@playwright/test'
import type { ShareLink } from '../../src/lib/share/contract'
import { expectNoEnglish, useChinese } from './helpers/i18n'
import { addEntry, addPhoto, createCollection, signIn, waitBackedUp } from './helpers/sync'

test('localizes the owner sheet and signed-out collection, entry and viewer in Simplified Chinese', async ({
  page,
  browser,
  baseURL,
}, { project }) => {
  const name = '分享用清点单'
  await signIn(page)
  await createCollection(page, name, 'synced')
  const entry = await addEntry(page, '5', '蓝色箱子')
  await entry.getByRole('textbox', { name: 'Entry title' }).fill('香盒')
  await addPhoto(page, entry, '香盒')
  await waitBackedUp(page)
  await useChinese(page)
  await page.reload()
  await page.getByLabel('清点单操作').click()
  await page.getByRole('menuitem', { name: '分享只读链接…' }).click()
  const sheet = page.getByRole('dialog', { name: '分享只读链接' })
  await expect(sheet.getByRole('radio', { name: '30 天' })).toBeChecked()
  await expectNoEnglish(page, { root: sheet })
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/shares' && response.request().method() === 'POST',
  )
  await sheet.getByRole('button', { name: '创建链接' }).click()
  const response = await created
  expect(response.status()).toBe(201)
  const link: ShareLink = await response.json()
  await expect(sheet.getByRole('button', { name: '二维码' })).toBeVisible()
  await sheet.getByRole('button', { name: '二维码' }).click()
  await expectNoEnglish(page, { root: sheet })

  const phone = !project.name.startsWith('desktop')
  const fresh = await browser.newContext({
    baseURL,
    locale: 'zh-CN',
    viewport: { width: phone ? 360 : 1280, height: 800 },
    isMobile: phone,
    hasTouch: phone,
  })
  try {
    const visitor = await fresh.newPage()
    await visitor.goto(link.url)
    await expect(visitor.getByText('只读', { exact: true })).toBeVisible()
    await expect(visitor.getByRole('heading', { name })).toBeVisible()
    await expectNoEnglish(visitor)
    await expect.poll(() => visitor.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)

    await visitor.getByRole('button', { name: '#0001 · 香盒' }).click()
    const panel = visitor.getByRole(phone ? 'dialog' : 'region', { name: '香盒' })
    await expect(panel).toBeVisible()
    await expectNoEnglish(visitor, { root: panel })
    await panel.locator('.thumbnail button').click()
    const viewer = visitor.getByRole('dialog', { name: '照片查看器' })
    await expect(viewer.getByRole('img')).toBeVisible()
    await expectNoEnglish(visitor, { root: viewer })
  } finally {
    await fresh.close()
  }
})
