import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { expectNoEnglish, useChinese } from './helpers/i18n'
import { idbSnapshot } from './helpers/local'

const room = 'Temple Lanterns'
const secondRoom = 'Temple Incense'
const syncRoom = 'Temple Shelves'
const folder = 'West Wing'
const missing = 'No such name'
const title = 'Brass lamps'
const note = 'Near the door'
const typed = [room, secondRoom, syncRoom, folder, missing, title, note]

const sizes = {
  'iphone-chromium': { width: 375, height: 667 },
  'android-chromium': { width: 390, height: 844 },
  'desktop-chromium': { width: 1280, height: 800 },
  'iphone-webkit': { width: 390, height: 844 },
} as const

const checkChinese = (page: Page, root: Locator) => expectNoEnglish(page, { root, allow: typed })

async function screenshot(page: Page, name: string) {
  const directory = process.env.I18N_SHELL_SHOTS
  const viewport = page.viewportSize()
  if (!directory || !viewport) return
  await mkdir(directory, { recursive: true })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: join(directory, `${name}-${viewport.width}x${viewport.height}.png`),
    animations: 'disabled',
    scale: 'css',
  })
}

async function noPageOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1)
}

const newCollection = (page: Page) => page.getByRole('button', { name: '新建清点单' })
const collections = (page: Page) => page.locator('.collections-page')
const appStatus = (page: Page) => page.locator('.global-sync')
const statusCopy = (page: Page) => appStatus(page).locator(':scope > span:nth-child(2)')
const selection = (page: Page) => page.getByRole('region', { name: '导出所选清点单' })
const collectionMenu = (page: Page, name: string) => page.getByLabel(`“${name}”的操作`).click()
const entryMenu = (page: Page) => page.getByLabel('清点单操作').click()
const entryFilter = (page: Page) => page.getByRole('group', { name: '条目筛选' })
const entryTitle = (page: Page) => page.locator('[data-entry-id] input.title')

async function closeDialog(page: Page) {
  const dialog = page.getByRole('dialog')
  await dialog.locator('.sheet-head button').click()
  await expect(dialog).toBeHidden()
}

async function checkDialogTitle(page: Page, title: string) {
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  // Shared sheets own their close control and body. Check the title this caller passes to them.
  await checkChinese(page, dialog.getByRole('heading', { name: title, exact: true }))
  return dialog
}

async function checkToast(page: Page, text: string) {
  const toast = page.locator('.toast').filter({ hasText: text })
  await expect(toast).toBeVisible()
  await checkChinese(page, toast.locator('span'))
  const action = toast.locator('button:not(.toast-close)')
  if (await action.count()) await checkChinese(page, action)
  return toast
}

async function createCollection(page: Page, name: string, filed = '', synced = false) {
  await newCollection(page).click()
  await page.getByLabel('名称', { exact: true }).fill(name)
  if (filed) await page.getByLabel('文件夹', { exact: true }).fill(filed)
  await page.getByRole('radio', { name: synced ? /^同步到服务器/ : /^仅本设备/ }).check()
  await page.getByRole('button', { name: '创建清点单' }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
}

async function selectForMerge(page: Page, first: string, second: string) {
  await page.getByRole('button', { name: '选择', exact: true }).click()
  await page.getByRole('checkbox', { name: first, exact: true }).click()
  await page.getByRole('checkbox', { name: second, exact: true }).click()
  await selection(page).getByRole('button', { name: '合并…' }).click()
  return checkDialogTitle(page, '合并清点单')
}

test.beforeEach(async ({ page }, { project }) => {
  await useChinese(page)
  await page.setViewportSize(sizes[project.name as keyof typeof sizes])
})

test('collections, rail, create and edit, archive, and collection menus', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page).toHaveTitle('清点单｜Kufang Capture')
  await expect(page.getByRole('heading', { name: '还没有清点单' })).toBeVisible()
  await checkChinese(page, collections(page))
  await screenshot(page, 'collections-empty')
  const archived = page.getByRole('checkbox', { name: '显示已归档' })
  await archived.check()
  await expect(page.getByRole('heading', { name: '没有已归档的清点单' })).toBeVisible()
  await checkChinese(page, collections(page))
  await archived.uncheck()

  const rail = page.getByRole('complementary', { name: '清点单' })
  if (await rail.isVisible()) {
    await expect(rail.getByRole('link', { name: '登录' })).toBeVisible()
    await checkChinese(page, rail)
    const railSearch = rail.getByRole('searchbox', { name: '筛选清点单' })
    await railSearch.fill(missing)
    await expect(rail.getByRole('status')).toHaveText('没有匹配结果')
    await checkChinese(page, rail)
    await railSearch.press('Escape')
  }

  await newCollection(page).click()
  const create = await checkDialogTitle(page, '新建清点单')
  await expect(create.getByText('请输入名称后继续。')).toBeVisible()
  const submit = create.getByRole('button', { name: '创建清点单' })
  await expect(submit).toBeDisabled()
  await expect(submit).toBeInViewport({ ratio: 1 })
  await checkChinese(page, create.locator('form'))
  await screenshot(page, 'collection-create')
  await create.getByLabel('名称', { exact: true }).fill(room)
  await create.getByLabel('文件夹', { exact: true }).fill(folder)
  await create.getByLabel('说明', { exact: true }).fill(note)
  // Fail the next local collection write and restore the browser method immediately.
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      if (this.name === 'collections') {
        IDBObjectStore.prototype.add = add
        throw new DOMException('测试写入失败', 'QuotaExceededError')
      }
      return add.apply(this, args)
    }
  })
  await submit.click()
  await expect(create.getByRole('alert')).toHaveText('无法保存此清点单。请检查填写的内容后重试。')
  await checkChinese(page, create.locator('form'))
  await submit.click()
  await expect(page.getByRole('heading', { name: room, exact: true })).toBeVisible()
  await page.goto('/')
  await createCollection(page, secondRoom)
  await page.goto('/')

  const search = page.getByRole('searchbox', { name: '搜索清点单' })
  await search.fill(missing)
  await expect(page.getByRole('heading', { name: `没有与“${missing}”匹配的清点单` })).toBeVisible()
  await expect(page.locator('.search-status')).toHaveText('共 2 份清点单，匹配 0 份')
  await checkChinese(page, collections(page))
  await page.getByRole('button', { name: '清除搜索' }).click()
  await search.fill(folder)
  await expect(page.locator('.search-status')).toHaveText('共 2 份清点单，匹配 1 份')
  await checkChinese(page, page.locator('.search-status'))
  await search.press('Escape')
  await expect(page.getByRole('heading', { name: /未归入文件夹/ })).toBeVisible()
  await checkChinese(page, page.locator('.page-heading'))
  await checkChinese(page, page.locator('.search-controls'))
  for (const card of await page.locator('.collection-card').all()) {
    await checkChinese(page, card.locator('.collection-open'))
    await checkChinese(page, card.locator('.collection-card-menu'))
  }
  await noPageOverflow(page)
  await screenshot(page, 'collections')

  await collectionMenu(page, room)
  const menu = page.getByRole('menu')
  await checkChinese(page, menu)
  await screenshot(page, 'collection-actions')
  await menu.getByRole('menuitem', { name: '重命名或编辑' }).click()
  const edit = await checkDialogTitle(page, '编辑清点单')
  await expect(edit.getByLabel('名称', { exact: true })).toHaveValue(room)
  await checkChinese(page, edit.locator('form'))
  await edit.getByRole('button', { name: '保存更改' }).click()
  await checkToast(page, '清点单已更新')

  await collectionMenu(page, room)
  await menu.getByRole('menuitem', { name: '导出 ZIP' }).click()
  await checkDialogTitle(page, `导出“${room}”`)
  await closeDialog(page)

  for (const action of ['更改存储模式…', '从本设备清除…']) {
    await collectionMenu(page, room)
    await menu.getByRole('menuitem', { name: action }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await closeDialog(page)
  }
  await page.getByLabel('查看同步冲突').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await closeDialog(page)

  await collectionMenu(page, room)
  await menu.getByRole('menuitem', { name: '归档', exact: true }).click()
  const archiveToast = await checkToast(page, '清点单已归档')
  await archiveToast.getByRole('button', { name: '撤销' }).click()
  await expect(page.getByRole('link', { name: `打开“${room}”` })).toBeVisible()
  await collectionMenu(page, room)
  await menu.getByRole('menuitem', { name: '归档', exact: true }).click()
  await archived.check()
  await collectionMenu(page, room)
  await checkChinese(page, menu)
  await menu.getByRole('menuitem', { name: '取消归档' }).click()
  await checkToast(page, '清点单已取消归档')
})

test('bulk selection, export, and both merge outcomes', async ({ page }) => {
  await page.goto('/')
  await createCollection(page, room, folder)
  await page.goto('/')
  await createCollection(page, secondRoom)
  await page.getByRole('button', { name: /新建条目/ }).click()
  await expect(entryTitle(page)).toHaveCount(1)
  await page.goto('/')

  await page.getByRole('button', { name: '选择', exact: true }).click()
  const folderHeadings = page.locator('.folder-heading-row')
  for (const heading of await folderHeadings.all()) {
    await checkChinese(page, heading)
    await heading.getByRole('button', { name: '全选' }).click()
    await expect(heading.getByRole('button', { name: '清除选择' })).toBeVisible()
    await checkChinese(page, heading)
  }
  await checkChinese(page, selection(page))
  await expect(selection(page)).toContainText('已选 2 项')
  await screenshot(page, 'collection-selection')
  await selection(page).getByRole('button', { name: '导出 ZIP' }).click()
  await checkDialogTitle(page, '导出 2 份清点单')
  await closeDialog(page)
  await selection(page).getByRole('button', { name: '合并…' }).click()
  const merge = await checkDialogTitle(page, '合并清点单')
  await expect(merge.getByText(`将“${secondRoom}”中的 1 个条目移至“${room}”。`)).toBeVisible()
  await checkChinese(page, merge.locator('fieldset'))
  await checkChinese(page, merge.locator('.summary'))
  await checkChinese(page, merge.locator('.actions'))
  await screenshot(page, 'collection-merge')
  // Simulate the target disappearing before the merge transaction reads it.
  await page.evaluate(() => {
    const get = IDBObjectStore.prototype.get
    IDBObjectStore.prototype.get = function (key: Parameters<typeof get>[0]) {
      if (
        this.name === 'collections' &&
        this.transaction.mode === 'readwrite' &&
        this.transaction.objectStoreNames.contains('movements')
      ) {
        IDBObjectStore.prototype.get = get
        return get.call(this, 'missing-test-collection')
      }
      return get.call(this, key)
    }
  })
  await merge.getByRole('button', { name: '合并清点单' }).click()
  await expect(merge.getByRole('alert')).toBeVisible()
  await checkChinese(page, merge.getByRole('alert'))
  await merge.getByRole('button', { name: '合并清点单' }).click()
  await checkToast(page, `已将 2 份清点单合并到“${room}”，其余清点单已归档。`)
  await page.getByRole('button', { name: '取消选择' }).click()

  await createCollection(page, syncRoom, '', true)
  const signIn = await checkToast(page, '已在本设备创建。登录后即可同步。')
  await expect(signIn.getByRole('button', { name: '登录' })).toBeVisible()
  await expect(appStatus(page)).toContainText('登录后可同步清点单')
  await checkChinese(page, appStatus(page))
  await page.goto('/')
  const blocked = await selectForMerge(page, room, syncRoom)
  await expect(blocked.getByRole('alert')).toHaveText('清点单必须使用相同的存储模式。')
  await checkChinese(page, blocked.getByRole('alert'))
  await expect(blocked.getByRole('button', { name: '合并清点单' })).toBeDisabled()
})

test('entry summaries, filters, search, menus, deletion, and starred entries', async ({ page }) => {
  await page.goto('/')
  await createCollection(page, secondRoom)
  await page.goto('/')
  await createCollection(page, room)
  const collectionPath = new URL(page.url()).pathname
  await expect(page).toHaveTitle(`${room}｜Kufang Capture`)
  const entries = page.locator('.entries-page')
  await expect(entries.getByText('还没有条目')).toBeVisible()
  await checkChinese(page, entries.locator('.empty-state'))
  await checkChinese(page, entries.locator('.toolbar'))
  const back = entries.locator('.back')
  if (await back.isVisible()) await checkChinese(page, back)
  await checkChinese(page, page.getByRole('button', { name: /新建条目/ }))
  await screenshot(page, 'entries-empty')

  const add = page.getByRole('button', { name: /新建条目/ })
  await add.click()
  const row = page.locator('[data-entry-id]').first()
  await expect(row.locator('input.title')).toBeFocused()
  await row.locator('input.title').fill(title)
  await row.locator('.short-note').fill(note)
  await row.locator('.quantity-wrap input').fill('5')
  await row.locator('.quantity-wrap input').blur()
  await row.locator('.star-toggle').click()
  await expect(row.locator('.star-toggle')).toHaveAttribute('aria-pressed', 'true')
  await row.locator('.menu-cell summary').click()
  await row.getByRole('menuitem', { name: /Mark needs review|待复核/ }).click()
  await expect(entries.locator('.summary-chips')).toContainText('1 个待复核')
  await expect(entries.locator('.quantity-chips')).toHaveText('5（无单位）')
  await checkChinese(page, entries.locator('.summary-chips'))
  await noPageOverflow(page)
  await screenshot(page, 'entries')

  const filters = entryFilter(page)
  await filters.getByLabel('未填完整', { exact: true }).click()
  await checkChinese(page, filters.getByRole('menu'))
  await screenshot(page, 'entry-filters')
  await filters.getByRole('menuitemradio', { name: '待复核' }).click()
  await expect(entries.locator('.list-status')).toContainText('共 1 个条目，匹配 1 个')
  await checkChinese(page, entries.locator('.list-status'))
  await filters.getByRole('button', { name: '等待同步', exact: true }).click()
  await expect(entries.getByText('没有匹配的条目')).toBeVisible()
  await checkChinese(page, entries.locator('.empty-state'))
  await checkChinese(page, entries.locator('.list-status'))
  await entries.getByRole('button', { name: '显示所有条目' }).click()
  const search = page.getByLabel('搜索条目', { exact: true })
  await search.fill(missing)
  await expect(entries.getByText('没有匹配的条目')).toBeVisible()
  await checkChinese(page, entries.locator('.empty-state'))
  await entries.getByRole('button', { name: '显示所有条目' }).click()
  await filters.getByRole('button', { name: '最近删除' }).click()
  await expect(entries.locator('.trash')).toBeVisible()
  await checkChinese(page, filters)
  await filters.getByRole('button', { name: '全部' }).click()

  await entryMenu(page)
  const actions = page.getByRole('menu')
  await checkChinese(page, actions)
  await screenshot(page, 'entry-actions')
  await actions.getByRole('menuitemradio', { name: '最早条目在前' }).click()
  for (const action of ['导出 ZIP', '从其他清点单导入', '移动条目…']) {
    await entryMenu(page)
    await actions.getByRole('menuitem', { name: action, exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    if (action === '导出 ZIP') await checkDialogTitle(page, `导出“${room}”`)
    await closeDialog(page)
  }
  await page.locator('.entries-page .status-trigger').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await closeDialog(page)

  await row.locator('.menu-cell summary').click()
  await row.getByRole('menuitem', { name: /Delete entry|删除条目/ }).click()
  const deleted = await checkToast(page, '已删除 #0001')
  await deleted.getByRole('button', { name: '撤销' }).click()
  await expect(row.locator('input.title')).toHaveValue(title)

  for (const destination of [secondRoom, syncRoom]) {
    await page.goto('/')
    if (destination === syncRoom) await createCollection(page, destination)
    else await page.getByRole('link', { name: `打开“${destination}”` }).click()
    await expect(page.getByRole('heading', { name: destination, exact: true })).toBeVisible()
    await entryMenu(page)
    await actions.getByRole('menuitem', { name: '从其他清点单导入' }).click()
    const importDialog = page.getByRole('dialog')
    await importDialog.getByRole('button', { name: room, exact: true }).click()
    await importDialog.getByRole('checkbox').check()
    await importDialog.locator('.actions .primary').click()
    await expect(entryTitle(page)).toHaveValue(title)

    await page.goto(collectionPath)
    await row.locator('.menu-cell summary').click()
    await row.getByRole('menuitem', { name: /Delete entry|删除条目/ }).click()
    const removalText =
      destination === secondRoom
        ? `已从“${room}”移除，仍保留在“${secondRoom}”。`
        : `已从“${room}”移除，仍保留在“${secondRoom}”及另外 1 份清点单中。`
    const removed = await checkToast(page, removalText)
    await removed.getByRole('button', { name: '撤销' }).click()
    await expect(row.locator('input.title')).toHaveValue(title)
  }

  await page.goto('/')
  await collectionMenu(page, room)
  await page.getByRole('menuitem', { name: '归档', exact: true }).click()
  await checkToast(page, '清点单已归档')
  await page.goto('/starred')
  const starred = page.locator('main .page')
  await expect(page).toHaveTitle('已加星标｜Kufang Capture')
  const group = starred.locator('.starred-group')
  const starredRow = starred.locator('.starred-row')
  await expect(starredRow.getByRole('link', { name: new RegExp(title) })).toBeVisible()
  await expect(group.getByText('已归档')).toBeVisible()
  await checkChinese(page, starred.locator('.starred-back'))
  await checkChinese(page, starred.getByRole('heading', { name: '已加星标' }))
  await checkChinese(page, group.getByRole('heading'))
  await checkChinese(page, starredRow.getByRole('link'))
  await checkChinese(page, starredRow.getByRole('button', { name: '取消条目的星标' }))
  await noPageOverflow(page)
  await screenshot(page, 'starred')
  await page.getByRole('button', { name: '取消条目的星标' }).click()
  await expect(starred.getByText(/还没有加星标的条目/)).toBeVisible()
  await checkChinese(page, starred)
  await screenshot(page, 'starred-empty')
})

test('offline-ready and interrupted-camera notifications and page not found', async ({ page }) => {
  await page.addInitScript(() => {
    if (location.pathname === '/missing-page')
      sessionStorage.setItem('kufang-camera-pending', JSON.stringify({ timestamp: Date.now() }))
  })
  await page.goto('/missing-page')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: '找不到页面' })).toBeVisible()
  await checkChinese(page, main)
  await checkToast(page, '照片未保存')
  await checkToast(page, '可以离线使用了')
  await noPageOverflow(page)
  await screenshot(page, 'page-not-found')
  await main.getByRole('link', { name: '返回清点单' }).click()
  await expect(page.getByRole('heading', { name: '清点单', exact: true })).toBeVisible()
})

test.describe('with mocked API routes', () => {
  // Mocked API routes must reach the page; WebKit does not route service-worker fetches.
  test.use({ serviceWorkers: 'block' })

  test('shows account and sync errors, offline changes, and both remaining creation notifications', async ({
    page,
    context,
  }) => {
    let session: 'unavailable' | 'ready' | 'mismatch' = 'unavailable'
    await page.route('**/api/auth/session', async (route) => {
      if (session === 'unavailable') {
        await route.fulfill({ status: 503, json: { code: 'account_unavailable' } })
        return
      }
      await route.fulfill({
        json: {
          authenticated: true,
          expires_at: null,
          user: {
            id: session === 'ready' ? 'fixture-owner' : 'fixture-other',
            name: '测试账号',
            is_owner: true,
          },
        },
      })
    })
    await page.route('**/api/sync/**', (route) => route.fulfill({ status: 500, json: {} }))

    await page.goto('/')
    await expect(appStatus(page)).toContainText('此账号暂时不可用')
    await checkChinese(page, statusCopy(page))
    await createCollection(page, syncRoom, '', true)
    await checkToast(page, '已创建，联网后将同步。')

    session = 'ready'
    await page.goto('/')
    await expect(appStatus(page)).toContainText('同步出错。')
    await checkChinese(page, statusCopy(page))
    const navigation = page.locator('.rail-account')
    if (await navigation.isVisible()) {
      await expect(navigation.getByRole('link', { name: '服务器导出' })).toBeVisible()
      await checkChinese(page, navigation)
    }
    await createCollection(page, room, '', true)
    await checkToast(page, '已创建，将自动同步。')
    await context.setOffline(true)
    await expect(appStatus(page)).toContainText('已保存到本设备，联网后将同步。')
    await checkChinese(page, statusCopy(page))
    await context.setOffline(false)

    session = 'mismatch'
    await page.goto('/')
    await expect(appStatus(page)).toContainText('此设备已绑定到 测试账号')
    await checkChinese(page, appStatus(page))
    await appStatus(page).getByRole('link', { name: '账号' }).click()
    await expect(appStatus(page)).toContainText('同步受阻')
    await checkChinese(page, appStatus(page))
  })
})

test('paginates entries and keeps units as entered', async ({ page }) => {
  await page.goto('/')
  await createCollection(page, room)
  await page.keyboard.press('n')
  await expect(entryTitle(page)).toHaveCount(1)
  await expect(entryTitle(page)).toBeFocused()
  await entryTitle(page).fill(title)
  await entryTitle(page).blur()
  await expect.poll(async () => (await idbSnapshot(page)).items[0]?.title).toBe(title)

  const { collections, entries, items } = await idbSnapshot(page)
  await page.evaluate(
    ({ collection, entry, item }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('kufang-capture')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const write = db.transaction(['collections', 'entries', 'items'], 'readwrite')
          const records = write.objectStore('entries')
          const itemRecords = write.objectStore('items')
          records.put({ ...entry, quantity: '5', unit: '箱' })
          for (let sequence = 2; sequence <= 42; sequence++) {
            const id = `fixture-entry-${sequence}`
            itemRecords.add({ ...item, id })
            records.add({
              ...entry,
              id,
              item_id: id,
              sequence_number: sequence,
              quantity: sequence === 2 ? '2' : null,
              unit: sequence === 2 ? '件' : '',
            })
          }
          write.objectStore('collections').put({ ...collection, next_sequence_number: 43 })
          write.oncomplete = () => {
            db.close()
            resolve()
          }
          write.onerror = () => reject(write.error)
        }
      }),
    { collection: collections[0]!, entry: entries[0]!, item: items[0]! },
  )
  await page.reload()
  const quantities = page.getByLabel('按单位汇总数量')
  await expect(quantities.getByText('5 箱', { exact: true })).toBeVisible()
  await expect(quantities.getByText('2 件', { exact: true })).toBeVisible()
  await checkChinese(page, quantities)
  const pageCount = page.getByText('共 42 个条目，已显示 40 个')
  await expect(pageCount).toBeAttached()
  await checkChinese(page, pageCount.locator('..'))
  await page
    .getByRole('button', { name: '显示其余条目' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(entryTitle(page)).toHaveCount(42)
})
