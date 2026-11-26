import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { join } from 'node:path'
import { expectNoEnglish, useChinese } from './helpers/i18n'
import { api, loginContext } from './helpers/sync'

// Mocked API routes must reach the page; WebKit does not route service-worker fetches.
test.use({ serviceWorkers: 'block' })

const fakeCode = '1234-5678'
const signIn = '登录'
const close = '关闭'

test.beforeEach(async ({ page }) => {
  await useChinese(page)
})

// Collect evidence at the requested CSS viewport sizes when running locally.
async function shots(page: Page, info: TestInfo, name: string, main = true, anchor?: string) {
  const directory = process.env.I18N_ACCOUNT_SCREENSHOTS
  const originalSize = page.viewportSize()
  if (!directory || info.project.name !== 'desktop-chromium' || !originalSize) return
  const sizes = [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
  ]
  if (main) sizes.push({ width: 1280, height: 800 })
  for (const size of sizes) {
    await page.setViewportSize(size)
    if (anchor) {
      await page.locator(anchor).evaluate((element) => element.scrollIntoView({ block: 'center' }))
    }
    const overflows = await page.evaluate(() => {
      const visible = document.querySelector('dialog[open]') ?? document.querySelector('main > .page')
      return visible ? visible.scrollWidth > visible.clientWidth + 1 : false
    })
    expect(overflows, `${name} at ${size.width}×${size.height}`).toBe(false)
    await page.screenshot({ path: join(directory, `${name}-${size.width}x${size.height}.png`) })
  }
  await page.setViewportSize(originalSize)
  if (anchor) await page.evaluate(() => window.scrollTo(0, 0))
}

async function openSheet(page: Page, name: string | RegExp, action: () => Promise<unknown>) {
  await action()
  const dialog = page.getByRole('dialog', { name })
  await expect(dialog).toBeVisible()
  return dialog
}

async function owner(page: Page, baseURL: string | undefined) {
  await loginContext(page.context(), baseURL!)
  await page.goto('/settings')
  await expect(page.getByText('已登录为 所有者。')).toBeVisible()
}

async function collection(page: Page, name: string) {
  await page.goto('/?new=1')
  const form = page.getByRole('dialog')
  await form.getByRole('textbox', { name: /^(Name|名称|清点单名称)$/ }).fill(name)
  await form.getByRole('radio', { name: /^(Local Only|仅本设备)/ }).check()
  await form.getByRole('button', { name: /^(Create collection|创建清点单|创建)$/ }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  const url = new URL(page.url())
  expect(url.pathname).toMatch(/^\/c\//)
  return { id: url.pathname.split('/').at(-1)!, path: url.pathname }
}

async function collectionAction(page: Page, collectionName: string, action: RegExp) {
  const card = page.locator('.collection-card').filter({ hasText: collectionName })
  await card.locator('summary').click()
  await page.getByRole('menuitem', { name: action }).click()
}

test('translates password, code entry, and join link states', async ({ page }, info) => {
  const screen = page.locator('.auth-page')
  await page.goto('/login')
  await expect(page).toHaveTitle('登录 — Kufang Capture')
  await expect(screen.getByRole('heading', { name: signIn })).toBeVisible()
  await expectNoEnglish(page, { root: screen })
  await shots(page, info, 'login')

  let respond!: () => void
  const waiting = new Promise<void>((resolve) => (respond = resolve))
  await page.route('**/api/auth/login', async (route) => {
    await waiting
    await route.fulfill({ status: 401 })
  })
  await screen.getByLabel('密码').fill('incorrect')
  await screen.getByRole('button', { name: signIn, exact: true }).click()
  await expect(screen.getByRole('button', { name: '正在登录…' })).toBeDisabled()
  await expectNoEnglish(page, { root: screen })
  respond()
  await expect(screen.getByRole('alert')).toHaveText('密码不正确。')
  await expectNoEnglish(page, { root: screen })
  await page.unroute('**/api/auth/login')
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({ status: 429, headers: { 'Retry-After': '120' } }),
  )
  await screen.getByRole('button', { name: signIn, exact: true }).click()
  await expect(screen.getByRole('alert')).toHaveText(/请在 2 分钟后重试/)
  await expectNoEnglish(page, { root: screen })

  await screen.getByRole('button', { name: '输入加入码' }).click()
  await expect(screen.getByRole('heading', { name: '输入加入码' })).toBeVisible()
  await expectNoEnglish(page, { root: screen })
  await shots(page, info, 'login-code', false)
  await screen.getByLabel('加入码').fill('123')
  await screen.getByRole('button', { name: signIn, exact: true }).click()
  await expect(screen.getByRole('alert')).toHaveText('请输入八位加入码。')
  await expectNoEnglish(page, { root: screen })
  await page.route('**/api/auth/join', (route) => route.fulfill({ status: 401 }))
  await screen.getByLabel('加入码').fill(fakeCode)
  await screen.getByRole('button', { name: signIn, exact: true }).click()
  await expect(screen.getByRole('alert')).toHaveText('加入码无效、已过期或已使用。请索取新的加入码。')
  await expectNoEnglish(page, { root: screen })

  await page.goto('/join')
  await expect(screen.getByText(/此链接缺少有效的加入码/)).toBeVisible()
  await expectNoEnglish(page, { root: screen })

  await page.goto(`/join?case=valid-format#${fakeCode}`)
  await expect(page).toHaveTitle('帮手登录 — Kufang Capture')
  await expect(screen.getByRole('heading', { name: '以帮手身份登录？' })).toBeVisible()
  await expectNoEnglish(page, { root: screen })
  await shots(page, info, 'join')
  await screen.getByRole('button', { name: '以帮手身份登录' }).click()
  await expect(screen.getByRole('alert')).toHaveText(/加入码无效/)
  await expectNoEnglish(page, { root: screen })
})

test('translates in-app browser instructions and both clipboard outcomes', async ({ page }, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { get: () => 'MicroMessenger' })
    let copied = false
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async () => {
        if (copied) throw new DOMException('Clipboard denied', 'NotAllowedError')
        copied = true
      },
    })
  })
  const screen = page.locator('.auth-page')
  await page.goto('/login?mode=code')
  await expect(screen.getByText(/请在 Chrome 或 Safari 中打开/)).toBeVisible()
  await expectNoEnglish(page, { root: screen })
  await shots(page, info, 'login-in-app', false)
  await page.goto(`/join?case=valid-format#${fakeCode}`)
  await expect(screen.getByRole('heading', { name: '用 Chrome 或 Safari 打开' })).toBeVisible()
  await expectNoEnglish(page, { root: screen })
  await shots(page, info, 'join-in-app', false)
  await screen.getByRole('button', { name: '复制加入码' }).click()
  await expect(screen.getByRole('status')).toHaveText('已复制加入码。')
  await expectNoEnglish(page, { root: screen })
  await screen.getByRole('button', { name: '复制加入码' }).click()
  await expect(screen.getByRole('status')).toHaveText('请选择上方的加入码并复制。')
  await expectNoEnglish(page, { root: screen })

  await page.goto('/join?case=missing-code')
  await expect(screen.getByText(/此链接缺少有效的加入码/)).toBeVisible()
  await expectNoEnglish(page, { root: screen })
})

test('translates Settings, device export errors, and account availability', async ({
  page,
  baseURL,
}, info) => {
  await page.addInitScript(() => {
    let persisted = false
    // WebKit ignores an own-property override on navigator.storage; patch the prototype.
    Object.defineProperties(StorageManager.prototype, {
      persisted: { value: async () => persisted },
      persist: {
        value: async () => {
          const previouslyRequested = sessionStorage.getItem('test-persist')
          sessionStorage.setItem('test-persist', 'true')
          return (persisted = previouslyRequested === 'true')
        },
      },
    })
  })
  const settings = page.locator('.settings-page')
  await page.goto('/settings')
  await expect(page).toHaveTitle('设置 — Kufang Capture')
  await expect(settings.getByText(/尚未登录/)).toBeVisible()
  await expectNoEnglish(page, { root: settings })
  await shots(page, info, 'settings-signed-out')
  const persist = settings.getByRole('button', { name: '在此设备保留数据' })
  await persist.click()
  await expect(settings.getByRole('status')).toHaveText('浏览器未允许持久存储。')
  await expectNoEnglish(page, { root: settings })
  await persist.click()
  await expect(settings.getByRole('status')).toHaveText('浏览器会保留这些数据，直到你清除站点数据。')
  await expect(settings.getByText('已启用', { exact: true })).toBeVisible()
  await expectNoEnglish(page, { root: settings })
  await shots(page, info, 'settings-storage', false, '.settings-card[aria-labelledby="storage-heading"]')
  await settings.getByRole('radio', { name: /快速相机/ }).check()
  await expectNoEnglish(page, { root: settings })

  const dialog = await openSheet(page, '导出全部数据', () =>
    settings.getByRole('button', { name: '导出全部数据' }).click(),
  )
  await expectNoEnglish(page, { root: dialog })
  await shots(page, info, 'device-export', false)
  await dialog.getByRole('button', { name: '导出 ZIP' }).click()
  await expect(dialog.getByRole('alert')).toHaveText(/无法导出此数据。/)
  await expectNoEnglish(page, { root: dialog })
  await dialog.getByRole('button', { name: close }).click()

  await owner(page, baseURL)
  await expectNoEnglish(page, { root: settings })
  await shots(page, info, 'settings-signed-in')
  const logout = '**/api/auth/logout'
  await page.route(logout, (route) => route.abort())
  await settings.getByRole('button', { name: '退出登录' }).click()
  await expect(settings.getByRole('status')).toHaveText(/退出登录失败/)
  await expectNoEnglish(page, { root: settings })
  await page.unroute(logout)
  await settings.getByRole('button', { name: '退出登录' }).click()
  await expect(settings.getByRole('status')).toHaveText('已退出登录。')
  await expectNoEnglish(page, { root: settings })

  await page.route('**/api/auth/session', (route) =>
    route.fulfill({ status: 503, json: { detail: 'account_unavailable' } }),
  )
  for (const [path, root] of [
    ['/settings', settings],
    ['/server', page.locator('.server-page')],
  ] as const) {
    await page.goto(path)
    await expect(root.getByRole('alert')).toHaveText(/账号暂时不可用/)
    await expectNoEnglish(page, { root })
  }
})

test('translates People list, forms, one-time codes, and status confirmations', async ({
  page,
  baseURL,
}, info) => {
  await owner(page, baseURL)
  const peopleURL = '**/api/people'
  let releaseList!: () => void
  const waiting = new Promise<void>((resolve) => (releaseList = resolve))
  await page.route(peopleURL, async (route) => {
    await waiting
    await route.abort()
  })
  await openSheet(page, '人员', () =>
    page.locator('.settings-page').getByRole('button', { name: '人员' }).click(),
  )
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('status')).toHaveText('正在加载人员…')
  await expectNoEnglish(page, { root: dialog })
  releaseList()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expectNoEnglish(page, { root: dialog })
  await page.unroute(peopleURL)

  // Running the entire suite can leave helpers created by other specs. Use a dedicated
  // error fixture for the empty response and scan the Chinese headings/actions in the real list.
  await page.route(peopleURL, (route) => route.fulfill({ json: [] }))
  await dialog.getByRole('button', { name: '重试' }).click()
  await expect(dialog.getByRole('button', { name: '添加人员' })).toBeEnabled()
  await expectNoEnglish(page, { root: dialog })
  await page.unroute(peopleURL)

  const name = `测试帮手 ${Date.now()}`
  const renamed = `${name} 改名`
  const scan = () => expectNoEnglish(page, { root: dialog })
  const save = dialog.getByRole('button', { name: '保存', exact: true })
  await dialog.getByRole('button', { name: '添加人员' }).click()
  await expect(dialog.getByRole('heading', { name: '添加人员' })).toBeVisible()
  await scan()
  await shots(page, info, 'people-add', false)
  await dialog.getByLabel('姓名').fill('测试'.repeat(21))
  await save.click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await scan()
  await dialog.getByLabel('姓名').fill(name)
  await save.click()
  const person = (name: string) => dialog.getByRole('listitem').filter({ hasText: name })
  await expect(person(name)).toBeVisible()
  await scan()
  await person(name).getByRole('button', { name: '重命名' }).click()
  await expect(dialog.getByRole('heading', { name: '重命名人员' })).toBeVisible()
  await scan()
  await dialog.getByLabel('姓名').fill(renamed)
  await save.click()

  // Keep the real code issue and expiry time, substituting a numeric code in the displayed fixture.
  await page.route('**/api/people/*/code', async (route) => {
    const response = await route.fetch()
    const code = (await response.json()) as { code: string; url: string }
    const url = new URL(code.url)
    url.hash = fakeCode
    await route.fulfill({ response, json: { ...code, code: fakeCode, url: url.href } })
  })
  await person(renamed).getByRole('button', { name: '加入码' }).click()
  await expect(dialog.getByRole('img', { name: '帮手登录二维码' })).toBeVisible()
  await expect(dialog.getByText(fakeCode)).toBeVisible()
  await scan()
  await shots(page, info, 'people-qr', false)
  await page.clock.setFixedTime(new Date(Date.now() + 11 * 60_000))
  await expect(dialog.getByRole('status')).toHaveText(/此加入码已过期/)
  await scan()
  await page.clock.setFixedTime(new Date())
  await dialog.getByRole('button', { name: '生成新加入码' }).click()
  await expect(dialog.getByRole('img', { name: '帮手登录二维码' })).toBeVisible()
  await scan()
  await dialog.getByRole('button', { name: '返回人员列表' }).click()

  await person(renamed).getByRole('button', { name: '停用', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: `要停用 ${renamed} 吗？` })).toBeVisible()
  await scan()
  await shots(page, info, 'people-disable', false)
  await dialog.getByRole('button', { name: `停用 ${renamed}` }).click()
  await expect(person(renamed).getByText('已停用')).toBeVisible()
  await scan()
  await person(renamed).getByRole('button', { name: '启用', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: `要启用 ${renamed} 吗？` })).toBeVisible()
  await scan()
  await dialog.getByRole('button', { name: `启用 ${renamed}` }).click()
  await expect(person(renamed).getByRole('button', { name: '加入码' })).toBeVisible()
  await scan()
  await dialog.getByRole('button', { name: close }).click()

  // Show the real owner row without introducing unrelated English helper names from another spec.
  await page.route(peopleURL, async (route) => {
    const response = await route.fetch()
    const rows = (await response.json()) as Array<{ is_owner: boolean; name: string }>
    await route.fulfill({ response, json: rows.filter((row) => row.is_owner || row.name === renamed) })
  })
  await page.locator('.settings-page').getByRole('button', { name: '人员' }).click()
  await expect(dialog.getByRole('heading', { name: '所有者' })).toBeVisible()
  await scan()
  await shots(page, info, 'people', false)
})

test('translates server export loading, empty, populated, and download states', async ({
  page,
  baseURL,
}, info) => {
  await owner(page, baseURL)
  const screen = page.locator('.server-page')
  const list = '**/api/collections'
  let releaseList!: () => void
  const waiting = new Promise<void>((resolve) => (releaseList = resolve))
  await page.route(list, async (route) => {
    await waiting
    await route.abort()
  })
  await page.goto('/server')
  await expect(page).toHaveTitle('服务器导出 — Kufang Capture')
  await expect(screen.getByText('正在加载服务器上的清点单…')).toBeVisible()
  await expectNoEnglish(page, { root: screen })
  releaseList()
  await expect(screen.getByRole('alert')).toHaveText(/无法加载服务器上的清点单/)
  await expectNoEnglish(page, { root: screen })
  await page.unroute(list)
  await page.route(list, (route) => route.fulfill({ json: [] }))
  await screen.getByRole('button', { name: '重试' }).click()
  await expect(screen.getByText('服务器上没有已同步的清点单。')).toBeVisible()
  await expectNoEnglish(page, { root: screen })
  await shots(page, info, 'server-empty')
  await page.unroute(list)

  await page.route(list, (route) =>
    route.fulfill({
      json: [
        {
          id: 'test-export',
          name: '测试清点单',
          entry_count: 1,
          photo_count: 2,
          stored_photo_bytes: 4096,
          missing_originals: 1,
        },
      ],
    }),
  )
  await page.reload()
  await expect(screen.getByText('1 个条目，2 张照片，4 KB')).toBeVisible()
  await expect(screen.getByText('服务器上缺少 1 张照片原件。')).toBeVisible()
  await expectNoEnglish(page, { root: screen })
  await shots(page, info, 'server-exports')

  const downloadURL = '**/api/exports/**'
  let releaseDownload!: () => void
  const downloading = new Promise<void>((resolve) => (releaseDownload = resolve))
  await page.route(downloadURL, async (route) => {
    await downloading
    await route.abort()
  })
  await screen.getByRole('button', { name: '下载 ZIP' }).click()
  await expect(screen.getByRole('status')).toHaveText('正在下载 ZIP…')
  await expectNoEnglish(page, { root: screen })
  releaseDownload()
  await expect(screen.getByRole('alert')).toHaveText(/无法下载 ZIP/)
  await expectNoEnglish(page, { root: screen })
  await page.unroute(downloadURL)
  await page.route(downloadURL, (route) =>
    route.fulfill({
      body: 'test ZIP',
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="test.zip"',
      },
    }),
  )
  await screen.getByLabel('包含最近删除的内容').check()
  const file = page.waitForEvent('download')
  await screen.getByRole('button', { name: '下载全部' }).click()
  expect((await file).suggestedFilename()).toBe('test.zip')
  await expectNoEnglish(page, { root: screen })
})

test('translates diagnostics summary and controls while the report stays English', async ({ page }, info) => {
  await page.addInitScript(() => {
    let allowCamera = false
    const camera = {
      getUserMedia: {
        configurable: true,
        get: () => {
          if (allowCamera) return undefined
          return async () => {
            allowCamera = true
            throw new DOMException('Camera denied', 'NotAllowedError')
          }
        },
      },
      enumerateDevices: { configurable: true, value: async () => [] },
    }
    // WebKit can resolve these through the prototype, so replace them there too.
    Object.defineProperties(MediaDevices.prototype, camera)
    Object.defineProperties(navigator.mediaDevices, camera)
    let copied = false
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async (value: string) => {
        if (copied || !value.startsWith('Kufang Capture camera diagnostics')) throw new Error('Copy denied')
        copied = true
      },
    })
  })
  const screen = page.locator('.diagnostics-page')
  await page.goto('/diagnostics')
  await expect(page).toHaveTitle('诊断 — Kufang Capture')
  await expectNoEnglish(page, { root: screen })
  await shots(page, info, 'diagnostics')
  await screen.getByRole('button', { name: '开始相机测试' }).click()
  await expect(screen.getByRole('alert')).toHaveText(/相机测试失败/)
  await expectNoEnglish(page, { root: screen })
  await screen.getByRole('button', { name: '开始相机测试' }).click()
  const report = screen.getByLabel('相机报告')
  await expect(report).toHaveValue(/^Kufang Capture camera diagnostics\n/)
  await expect(screen.getByText('发现 0 个相机')).toBeVisible()
  await expectNoEnglish(page, { root: screen })
  await shots(page, info, 'diagnostics-report', false, '.diagnostic-summary')
  await screen.getByRole('button', { name: '复制报告' }).click()
  await expect(screen.getByRole('status')).toHaveText('已复制报告')
  await expectNoEnglish(page, { root: screen })
  await screen.getByRole('button', { name: '复制报告' }).click()
  await expect(screen.getByRole('status')).toHaveText('请选择并复制报告文字')
  await expectNoEnglish(page, { root: screen })

  await page.evaluate(() => {
    HTMLCanvasElement.prototype.getContext = () => null
  })
  await screen.getByRole('button', { name: '生成 300 个示例条目' }).click()
  await expect(screen.getByRole('alert')).toHaveText(/无法生成测试数据/)
  await expectNoEnglish(page, { root: screen })

  await page.reload()
  await screen.getByRole('button', { name: '生成 300 个示例条目' }).click()
  await expect(screen.getByRole('button', { name: '正在生成…' })).toBeDisabled()
  await expectNoEnglish(page, { root: screen })
  await expect(screen.getByRole('status')).toHaveText(/已生成 300 个示例条目/, { timeout: 45_000 })
  await expectNoEnglish(page, { root: screen })
})

test('translates a device bound to another account and its switch action', async ({
  page,
  baseURL,
}, info) => {
  const context = page.context()
  await loginContext(context, baseURL!)
  const headers = { 'X-Capture-Request': '1' }
  const name = `绑定测试帮手 ${Date.now()}`
  const person = await context.request.post('/api/people', { data: { name }, headers })
  expect(person.ok()).toBe(true)
  const id = ((await person.json()) as { id: string }).id
  const issued = await context.request.post(`/api/people/${id}/code`, { headers })
  expect(issued.ok()).toBe(true)
  const code = ((await issued.json()) as { code: string }).code
  const signedIn = await context.request.post('/api/auth/join', { data: { code }, headers })
  expect(signedIn.ok()).toBe(true)

  const settings = page.locator('.settings-page')
  await page.goto('/settings')
  await expect(settings.getByText(`已登录为 ${name}。`)).toBeVisible()
  await expectNoEnglish(page, { root: settings })
  await loginContext(context, baseURL!)
  await page.reload()
  await expect(settings.getByRole('alert')).toContainText(name)
  await expectNoEnglish(page, { root: settings })
  await shots(page, info, 'settings-bound', false)
  await page.goto('/server')
  const server = page.locator('.server-page')
  await expect(server.getByRole('alert')).toContainText(name)
  await expectNoEnglish(page, { root: server })
  await page.goto('/settings')
  await settings.getByRole('button', { name: '切换到 所有者' }).click()
  await expect(settings.getByText('已登录为 所有者。')).toBeVisible()
  await expectNoEnglish(page, { root: settings })
})

test('translates storage consent, sync controls, and server-copy removal', async ({
  page,
  baseURL,
}, info) => {
  const name = `Storage room ${Date.now()}`
  const { id, path } = await collection(page, name)
  await expectNoEnglish(page, { root: page.locator('.status-chip') })
  await page.goto('/')
  const changeMode = () => collectionAction(page, name, /^(Change storage mode|更改存储模式)/)
  const dialog = await openSheet(page, '更改存储模式', changeMode)
  await expect(dialog.getByText(/请先登录/)).toBeVisible()
  await expectNoEnglish(page, { root: dialog })
  await dialog.getByRole('button', { name: close }).click()

  await owner(page, baseURL)
  await page.goto('/')
  await changeMode()
  const consentCopy = dialog.getByText(/要将此清点单的/)
  await expect(consentCopy).toHaveText(
    '要将此清点单的 0 个条目和 0 张照片（0.0 MB）上传到 capture.kufang.org 吗？',
  )
  // The destination hostname is fixed metadata. Check its full sentence above and scan the rest of the dialog.
  await expectNoEnglish(page, { root: dialog.getByRole('heading') })
  await expectNoEnglish(page, { root: dialog.getByRole('checkbox').locator('..') })
  await expectNoEnglish(page, { root: dialog.getByRole('button', { name: '同步到服务器' }) })
  await expectNoEnglish(page, { root: dialog.getByRole('button', { name: close }) })
  await shots(page, info, 'storage-consent', false)
  await expect(dialog.getByRole('button', { name: '同步到服务器' })).toBeDisabled()
  let releaseSync!: () => void
  const pendingSync = new Promise<void>((resolve) => (releaseSync = resolve))
  await page.route('**/api/sync/batch', async (route) => {
    await pendingSync
    await route.continue()
  })
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: '同步到服务器' }).click()
  await expect(dialog).toBeHidden()
  const sync = page.locator('.global-sync .sync-now-button')
  await expect(sync.getByRole('button', { name: '立即同步' })).toBeVisible()
  await expectNoEnglish(page, { root: sync })
  releaseSync()
  await page.unroute('**/api/sync/batch')

  await page.goto(path)
  const status = page.locator('.status-chip')
  await expect(status).toHaveText('已备份到服务器')
  await expectNoEnglish(page, { root: status })

  const conflicts = await openSheet(page, '解决冲突', () => page.locator('.status-trigger').click())
  await expect(conflicts.getByText('没有需要处理的冲突。')).toBeVisible()
  await expectNoEnglish(page, { root: conflicts })
  await shots(page, info, 'conflict-empty', false)
  await conflicts.getByRole('button', { name: close }).click()

  await expect
    .poll(async () => {
      const rows = await api<Array<{ id: string }>>(page, '/api/collections')
      return rows.some((row) => row.id === id)
    })
    .toBe(true)
  await page.goto('/')
  await changeMode()
  const scanMode = () => expectNoEnglish(page, { root: dialog, allow: [name] })
  await scanMode()
  await shots(page, info, 'storage-synced', false)
  const remove = dialog.getByRole('button', { name: '删除服务器副本' })
  await dialog.getByLabel('输入清点单名称').fill(name + ' 错')
  await expect(remove).toBeDisabled()
  await dialog.getByLabel('输入清点单名称').fill(name)

  const removal = '**/api/collections/*/server-copy'
  await page.route(removal, (route) => route.abort())
  await remove.click()
  await expect(dialog.getByRole('alert')).toHaveText(/无法删除服务器副本/)
  await scanMode()
  await page.unroute(removal)
  await remove.click()
  await expect(dialog).toBeHidden()
  const rows = await api<Array<{ id: string }>>(page, '/api/collections')
  expect(rows.some((row) => row.id === id)).toBe(false)
})

test('translates prepared exports, the clear confirmation, and the clear toast', async ({ page }, info) => {
  await page.addInitScript(() => {
    Object.defineProperties(navigator, {
      canShare: { value: () => true },
      userActivation: { value: { isActive: false } },
      share: {
        value: async () => {
          const shareAttempts = Number(sessionStorage.getItem('share-attempts')) + 1
          sessionStorage.setItem('share-attempts', String(shareAttempts))
          if (shareAttempts === 1) throw new DOMException('Share cancelled', 'AbortError')
          if (shareAttempts === 2 || shareAttempts === 4)
            throw new DOMException('Tap expired', 'NotAllowedError')
          if (shareAttempts === 3) throw new Error('Share failed')
        },
      },
    })
  })
  const name = `清除测试 ${Date.now()}`
  await collection(page, name)
  await page.goto('/settings')
  const settings = page.locator('.settings-page')
  await expect(settings.getByText(/请定期导出 ZIP/)).toBeVisible()
  await expectNoEnglish(page, { root: settings })
  const exported = await openSheet(page, '导出全部数据', () =>
    settings.getByRole('button', { name: '导出全部数据' }).click(),
  )
  const exportButton = exported.getByRole('button', { name: '导出 ZIP', exact: true })
  await exportButton.click()
  await expect(exported.getByRole('status')).toHaveText('已取消导出。')
  await expectNoEnglish(page, { root: exported })
  await exportButton.click()
  await expect(exported.getByRole('status')).toHaveText(/ZIP 已就绪/)
  await expectNoEnglish(page, { root: exported })
  await shots(page, info, 'device-export-ready', false)
  await exported.getByRole('button', { name: '分享 ZIP' }).click()
  await expect(exported.getByRole('alert')).toHaveText(/无法导出此数据。无法分享/)
  await expectNoEnglish(page, { root: exported })
  await exported.getByRole('button', { name: close }).click()

  await page.goto('/')
  const dialog = await openSheet(page, '从本设备清除', () =>
    collectionAction(page, name, /^(Clear from this device|从本设备清除)/),
  )
  await expect(dialog.getByText('无法清除此清点单：')).toBeVisible()
  await expectNoEnglish(page, { root: dialog })
  await shots(page, info, 'clear-guard', false)
  await dialog.getByRole('button', { name: '立即导出 ZIP' }).click()
  await expect(dialog.getByRole('status')).toHaveText('ZIP 已就绪。点击“分享 ZIP”保存。')
  await expectNoEnglish(page, { root: dialog })
  await dialog.getByRole('button', { name: '分享 ZIP' }).click()
  const delivery = page.locator('.toast').filter({ hasText: /^已导出 / })
  await expect(delivery).toHaveText(/^已导出 .*\.zip×$/)
  // The filename preserves the archive identity. Scan the control and verify the complete toast above.
  await expect(delivery.locator('.toast-close')).toHaveAttribute('aria-label', '关闭通知')
  await expectNoEnglish(page, { root: delivery.locator('.toast-close') })
  const clear = dialog.getByRole('button', { name: '清除清点单' })
  await dialog.getByLabel('输入清点单名称').fill(name + ' 错')
  await expect(clear).toBeDisabled()
  await dialog.getByLabel('输入清点单名称').fill(name)
  await expectNoEnglish(page, { root: dialog })
  await clear.click()
  await expect(dialog).toBeHidden()
  const toast = page.locator('.toast').filter({ hasText: '已从本设备清除清点单' })
  await expect(toast).toBeVisible()
  await expectNoEnglish(page, { root: toast })
})

test('translates a populated conflict sheet and preserves item text', async ({ page }, info) => {
  const { id, path } = await collection(page, '冲突测试清点单')
  await page
    .getByRole('button', { name: /New Entry|新建条目|新增条目/ })
    .first()
    .click()
  await expect(page.locator('[data-entry-id]').first()).toBeVisible()
  await page.evaluate(async (collectionId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kufang-capture')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(['entries', 'conflicts'], 'readwrite')
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        const entry = transaction.objectStore('entries').index('collection_id').get(collectionId)
        entry.onsuccess = () => {
          transaction.objectStore('conflicts').put({
            id: 'test-conflict',
            collection_id: collectionId,
            entity: 'item',
            entity_id: entry.result.item_id,
            fields: ['notes', 'expiration_date', 'review_status'],
            local_values: { notes: '架子甲', expiration_date: '2028-05-01', review_status: 'draft' },
            server_values: { notes: '架子乙', expiration_date: '2028-06-01', review_status: 'complete' },
            server_revision: 2,
            created_at: new Date().toISOString(),
          })
        }
      })
    } finally {
      db.close()
    }
  }, id)
  await page.goto(path)
  const dialog = await openSheet(page, '解决冲突', () => page.locator('.status-trigger').click())
  await expect(dialog.getByRole('heading', { name: '物品字段' })).toBeVisible()
  await expect(dialog.getByText('到期日期')).toBeVisible()
  await expect(dialog.getByText('2028/5/1')).toBeVisible()
  await expect(dialog.getByText('架子乙')).toBeVisible()
  await expect(dialog.getByText('已完成')).toBeVisible()
  await expectNoEnglish(page, { root: dialog })
  await shots(page, info, 'conflict', false)
})

test('translates a shared-item storage blocker, clear warning, and multi-collection export', async ({
  page,
  baseURL,
}, info) => {
  await owner(page, baseURL)
  const source = '共享物品来源'
  const target = '共享物品目的地'
  await collection(page, source)
  await page
    .getByRole('button', { name: /New Entry|新建条目|新增条目/ })
    .first()
    .click()
  await expect(page.locator('[data-entry-id]').first()).toBeVisible()
  await collection(page, target)
  await page
    .locator('.toolbar')
    .locator('details')
    .filter({
      has: page
        .locator('[role=menuitem]')
        .filter({ hasText: /Import from another collection|从.*清点单导入/ }),
    })
    .locator('summary')
    .click()
  await page.getByRole('menuitem', { name: /Import from another collection|从.*清点单导入/ }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: source, exact: true }).click()
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: /Import 1|导入 ?1/ }).click()
  await expect(dialog).toBeHidden()

  await page.goto('/')
  dialog = await openSheet(page, '更改存储模式', () =>
    collectionAction(page, source, /^(Change storage mode|更改存储模式)/),
  )
  const blocker = dialog.getByText(/有 1 个物品与仅本设备的清点单/)
  await expect(blocker).toContainText(target)
  await expectNoEnglish(page, { root: blocker })
  await expect(dialog.getByRole('button', { name: '同步到服务器' })).toBeDisabled()
  await shots(page, info, 'storage-blocked', false)
  await dialog.getByRole('button', { name: close }).click()

  dialog = await openSheet(page, '从本设备清除', () =>
    collectionAction(page, target, /^(Clear from this device|从本设备清除)/),
  )
  await expect(dialog.getByText('有 1 个共享物品仍会保留在其他清点单中。')).toBeVisible()
  await expectNoEnglish(page, { root: dialog })
  await dialog.getByRole('button', { name: close }).click()

  await page.getByRole('button', { name: /^(Select|选择)$/ }).click()
  for (const name of [source, target]) await page.getByRole('checkbox', { name }).check()
  await page
    .locator('.selection-bar')
    .getByRole('button', { name: /Export ZIP|导出 ZIP/ })
    .click()
  dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/将在本设备上导出 2 份清点单/)).toBeVisible()
  // The dialog name is supplied by the Collections page. Scan the account sheet controls and copy.
  for (const child of await dialog.locator(':scope > :not(.sheet-head)').all())
    await expectNoEnglish(page, { root: child })
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '导出 ZIP' }).click()
  const filename = (await download).suggestedFilename()
  const status = dialog.getByRole('status')
  await expect(status).toHaveText(`已导出 ${filename}`)
})
