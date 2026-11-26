import { expect, test } from '@playwright/test'
import { expectNoEnglish, useChinese } from './helpers/i18n'

test.describe('Chinese browser preferences', () => {
  test.use({ locale: 'zh-CN' })

  test('chooses Simplified Chinese on the first visit', async ({ page }) => {
    await page.goto('/settings')
    const picker = page.getByRole('combobox', { name: '语言' })
    await expect(picker).toHaveValue('zh-CN')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expect(picker.getByRole('option', { name: 'English' })).toHaveAttribute('lang', 'en')
    await expect(picker.getByRole('option', { name: '简体中文' })).toHaveAttribute('lang', 'zh-CN')
    await expectNoEnglish(page, { root: page.locator('.language-picker') })
  })
})

test.describe('English browser preferences', () => {
  test.use({ locale: 'en-US' })

  test('starts in English', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue('en')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })

  test('persists the Settings choice across another reload', async ({ page }) => {
    await page.goto('/settings')
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN')
    await expect(page.getByRole('combobox', { name: '语言' })).toHaveValue('zh-CN')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await page.reload()
    await expect(page.getByRole('combobox', { name: '语言' })).toHaveValue('zh-CN')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expectNoEnglish(page, { root: page.locator('.language-picker') })
  })

  test('switches on the signed-out sign-in page and protects a form draft', async ({ page }) => {
    await page.goto('/login')
    const picker = page.getByRole('combobox', { name: 'Language' })
    const password = page.locator('input[type=password]')
    await password.fill('unfinished')
    await expect(picker).toBeDisabled()
    await expect(password).toHaveValue('unfinished')
    await password.clear()
    await picker.selectOption('zh-CN')
    await expect(page.getByRole('combobox', { name: '语言' })).toHaveValue('zh-CN')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expectNoEnglish(page, { root: page.locator('.language-picker') })
  })

  test('can seed Chinese and switch on a join link without dropping the pending code', async ({ page }) => {
    await useChinese(page)
    await page.goto('/join#ABCD-EFGH')
    await expect(page.locator('.join-code')).toHaveText('ABCD-EFGH')
    await expect(page).toHaveURL(/\/join$/)
    await page.getByRole('combobox', { name: '语言' }).selectOption('en')
    await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue('en')
    await expect(page.locator('.join-code')).toHaveText('ABCD-EFGH')
    await expect(page).toHaveURL(/\/join$/)
  })
})
