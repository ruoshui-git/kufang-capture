import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { expectNoEnglish, useChinese } from './helpers/i18n'
import { idbSnapshot } from './helpers/local'
import { photoFixture } from './helpers/sync'

const shots = '/tmp/codex-runs/i18n-entry-shots'
const roomA = '一号库房'
const roomB = '二号库房'
const itemName = '纸箱'

test.use({ locale: 'zh-CN', actionTimeout: 15_000 })

test.beforeEach(async ({ page }, { project }) => {
  await useChinese(page)
  const viewport = project.name.startsWith('desktop')
    ? { width: 1280, height: 800 }
    : project.name.startsWith('android')
      ? { width: 390, height: 844 }
      : { width: 375, height: 667 }
  await page.setViewportSize(viewport)
})

async function shot(page: Page, info: TestInfo, name: string) {
  const { width, height } = page.viewportSize()!
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(0)
  const path = `${shots}/${width}x${height}-${name}.png`
  await page.screenshot({ path, animations: 'disabled', scale: 'css' })
  await info.attach(name, { path, contentType: 'image/png' })
}

async function copy(page: Page, root: Locator, allow: string[] = []) {
  await expect(root).toBeVisible()
  await expectNoEnglish(page, { root, allow })
}

async function sheetCopy(page: Page, sheet: Locator) {
  // The shared Sheet header also renders its own close button. Check the owned heading and body.
  await copy(page, sheet.getByRole('heading').first())
  const sections = await sheet.locator(':scope > :not(.sheet-head)').filter({ visible: true }).all()
  expect(sections.length).toBeGreaterThan(0)
  for (const section of sections) await copy(page, section)
}

async function toastCopy(page: Page, message: string) {
  const toast = page.locator('.toast').filter({ hasText: message })
  await expect(toast).toBeVisible()
  // ToastHost owns the separate dismiss button.
  for (const content of await toast.locator(':scope > :not(.toast-close)').all()) {
    await copy(page, content)
  }
  return toast
}

async function createCollection(page: Page, name: string) {
  await page.goto('/')
  await page.locator('.new-collection-action').click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('textbox', { name: /^(Name|名称)$/ }).fill(name)
  await sheet.getByRole('radio', { name: /^(Local Only|仅本设备)/ }).check()
  await sheet.getByRole('button', { name: /^(Create collection|创建清点单)$/ }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  return new URL(page.url()).pathname
}

async function newEntry(page: Page) {
  const rows = page.locator('[data-entry-id]')
  const ids = () =>
    rows.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-entry-id')))
  const before = new Set(await ids())
  await page
    .getByRole('button', { name: /New Entry|新建条目/ })
    .first()
    .click()
  await expect(rows).toHaveCount(before.size + 1)
  const id = (await ids()).find((candidate) => candidate && !before.has(candidate))
  if (!id) throw new Error('The new entry did not appear in the list.')
  return page.locator(`[data-entry-id="${id}"]`)
}

async function collectionAction(page: Page, name: RegExp) {
  await page
    .locator('summary')
    .filter({ visible: true })
    .and(page.getByLabel(/^(Collection actions|清点单操作)$/))
    .click()
  await page.getByRole('menuitem', { name }).click()
}

async function entryAction(row: Locator, name: string) {
  await row.getByLabel('条目操作').click()
  await row.getByRole('menuitem', { name, exact: true }).click()
}

async function selectPhoto(page: Page, button: Locator, label: string) {
  const photo = await photoFixture(page, label)
  const file = page.waitForEvent('filechooser')
  await button.click()
  await (await file).setFiles({ name: photo.filename, mimeType: 'image/jpeg', buffer: photo.bytes })
}

async function changeLocalData(page: Page, store: 'settings' | 'photoBlobs') {
  await page.evaluate(async (store) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kufang-capture')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        const records = tx.objectStore(store)
        if (store === 'settings') records.put({ key: 'capture_mode', value: 'fast' })
        else records.clear()
      })
    } finally {
      db.close()
    }
  }, store)
}

test('localizes entry rows, detail, gallery, viewer and deleted items', async ({ page }, info) => {
  const collectionPath = await createCollection(page, roomA)
  await page.getByRole('button', { name: /^(Recently Deleted|最近删除)$/ }).click()
  const trash = page.getByRole('region', { name: '最近删除' })
  await expect(trash).toContainText('最近没有删除任何条目或照片。')
  await copy(page, trash)
  await shot(page, info, 'trash-empty')
  await page.getByRole('button', { name: /^(All|全部)$/ }).click()

  const row = await newEntry(page)
  const title = row.getByLabel('条目标题')
  await expect(title).toHaveAttribute('placeholder', '条目 #0001')
  await expect(row.getByLabel('打开 #0001 的详情')).toBeVisible()
  await copy(page, row.locator('.no-photos'))
  await title.fill(itemName)
  await title.blur()
  await row.getByRole('button', { name: '加星标' }).click()
  await expect(row.getByRole('button', { name: '取消星标' })).toBeVisible()
  await row.getByLabel('条目操作').click()
  await copy(page, row.getByRole('menu'))
  await shot(page, info, 'row-menu')
  await row.getByRole('menuitem', { name: '标为待复核' }).click()
  await expect(row.getByText('待复核', { exact: true })).toBeVisible()
  await row.getByLabel('数量').fill('bad')
  await copy(page, row.getByRole('alert'))
  await row.getByLabel('数量').fill('12')
  await row.getByLabel('数量').press('Enter')
  await expect(row.getByLabel('尺寸')).toBeFocused()
  await row.getByLabel('尺寸').press('Enter')
  await expect(row.getByLabel('简短备注')).toBeFocused()
  await row.getByLabel('简短备注').fill('Shelf note')
  if (await row.getByRole('button', { name: '更多详情' }).isVisible()) {
    await row.getByRole('button', { name: '更多详情' }).click()
    await copy(page, row.locator('.extra'))
    await row.locator('.extra').scrollIntoViewIfNeeded()
    await shot(page, info, 'row-expanded')
    await row.getByRole('button', { name: '更多详情' }).click()
  }

  await selectPhoto(page, row.getByRole('button', { name: '从相册添加' }), 'orange')
  await expect(row.getByText('1 张照片')).toBeVisible()
  for (const label of ['blue', 'green', 'violet']) {
    await selectPhoto(page, row.getByRole('button', { name: '拍照', exact: true }), label)
  }
  await expect(row.getByText('4 张照片')).toBeVisible()
  await entryAction(row, '标为已完成')
  await expect(row.getByText('待复核', { exact: true })).toHaveCount(0)
  await copy(page, row.locator('article.entry-row'), ['Shelf note'])
  const remaining = row.getByRole('button', { name: '打开其余照片' })
  const capture = row.getByRole('button', { name: '拍照', exact: true })
  const lastThumb = (await remaining.boundingBox())!
  const captureButton = (await capture.boundingBox())!
  expect(lastThumb.x + lastThumb.width).toBeLessThanOrEqual(captureButton.x)
  await shot(page, info, 'row')
  await remaining.click()
  const viewer = page.getByRole('dialog', { name: '照片查看器' })
  const position = viewer.locator('.viewer-head > span')
  await expect(position).toHaveText(/^第 [1-4] 张，共 4 张$/)
  const initial = Number((await position.innerText()).match(/\d+/)?.[0])
  await expect(viewer.locator('img')).toBeVisible()
  const startupToast = page.locator('.toast').filter({ hasText: /Ready to work offline|可离线/ })
  const dismiss = startupToast.locator('.toast-close')
  if (await dismiss.isVisible()) await dismiss.click()
  await copy(page, viewer)
  await shot(page, info, 'viewer')
  const previous = viewer.getByRole('button', { name: '上一张照片' })
  const next = viewer.getByRole('button', { name: '下一张照片' })
  await (initial > 1 ? previous : next).click()
  await expect(position).toHaveText(`第 ${initial > 1 ? initial - 1 : initial + 1} 张，共 4 张`)
  await (initial > 1 ? next : previous).click()
  await expect(position).toHaveText(`第 ${initial} 张，共 4 张`)
  await viewer.getByRole('button', { name: '关闭照片查看器' }).click()

  await row.getByRole('button', { name: '打开 #0001 的详情' }).click()
  const detail = page.locator('.detail-page')
  const viewport = page.viewportSize()!
  if (viewport.width < 900) await expect(page).toHaveTitle('#0001 — 条目详情 — Kufang Capture')
  await expect(detail.getByText('暂无移动记录')).toBeVisible()
  await copy(page, detail)
  await shot(page, info, 'detail-gallery')
  if (viewport.width !== 390) {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.setViewportSize(
      viewport.width === 375 ? { width: 360, height: 667 } : { width: 1440, height: 900 },
    )
    await shot(page, info, 'detail-dark')
    await page.setViewportSize(viewport)
    await page.emulateMedia({ colorScheme: 'light' })
  }
  await detail.getByLabel('复核状态').selectOption('needs_review')
  await copy(page, detail.getByLabel('复核状态'))
  await detail.getByRole('button', { name: '添加清点单备注' }).click()
  await detail.getByLabel(/一号库房.*备注/).fill('Shelf note')
  await detail.getByLabel('数量').fill('bad')
  await copy(page, detail.getByRole('alert'))
  await detail.getByLabel('数量').fill('12')
  await detail.getByLabel('数量').blur()
  await detail.locator('.field-grid').scrollIntoViewIfNeeded()
  await shot(page, info, 'detail-fields')

  const grid = detail.getByLabel('条目照片')
  await grid.getByLabel('照片说明').first().fill('Photo caption')
  await grid.getByLabel('照片说明').first().blur()
  const cover = grid.getByRole('button', { name: '设为封面' }).first()
  const coverLines = await cover.evaluate((button) => {
    const range = document.createRange()
    range.selectNodeContents(button)
    return range.getClientRects().length
  })
  expect(coverLines).toBe(1)
  await cover.click()
  await copy(page, grid, ['Photo caption'])
  await grid.getByRole('button', { name: '删除照片' }).first().click()
  const deletedToast = await toastCopy(page, '照片已删除')
  await deletedToast.getByRole('button', { name: '撤销' }).click()
  await expect(grid.getByRole('button', { name: '删除照片' })).toHaveCount(4)
  await grid.getByRole('button', { name: '删除照片' }).first().click()
  await toastCopy(page, '照片已删除')
  await page.goto(collectionPath)
  await expect(row).toBeVisible()
  const other = await newEntry(page)
  const entryPath = collectionPath + '/e/' + (await other.getAttribute('data-entry-id'))
  await entryAction(other, '删除条目')
  // The collection route owns the entry deletion toast.
  await page.getByRole('button', { name: /^(Recently Deleted|最近删除)$/ }).click()
  await expect(trash.getByRole('button', { name: '恢复' })).toHaveCount(2)
  await copy(page, trash)
  await shot(page, info, 'trash-populated')
  await trash.getByRole('button', { name: '恢复' }).last().click()
  await expect(trash.getByRole('button', { name: '恢复' })).toHaveCount(1)
  await page.goto(entryPath)
  await expect(detail.getByText('此条目已删除。')).toBeVisible()
  await copy(page, detail)
  await detail.getByRole('button', { name: '恢复' }).click()
  await expect(detail.getByRole('button', { name: '拍照', exact: true })).toBeVisible()
})

test('localizes move validation, move variants, undo, and history', async ({ page }, info) => {
  const source = await createCollection(page, roomA)
  let row = await newEntry(page)
  const title = row.getByLabel('条目标题')
  await title.fill(itemName)
  await title.blur()
  await row.getByLabel('数量').fill('12')
  await row.getByLabel('数量').blur()
  const move = page.getByRole('dialog', { name: '将 #0001 移至…' })
  await entryAction(row, '移至…')
  await expect(move.getByText('没有可选的清点单。只能移到存储模式相同的清点单。')).toBeVisible()
  await sheetCopy(page, move)
  await page.keyboard.press('Escape')

  const target = await createCollection(page, roomB)
  await page.goto(source)
  row = page.locator('[data-entry-id]').first()
  const sourceDetail = source + '/e/' + (await row.getAttribute('data-entry-id'))
  await entryAction(row, '移至…')
  const amount = move.getByRole('textbox', { name: '移动数量' })
  await expect(amount).toHaveValue('12')
  for (const [value, message] of [
    ['', '请输入大于零的数量。'],
    ['invalid', '请输入有效的数字。'],
    ['0', '数量必须大于零。'],
    ['13', '移动数量不能超过已记录的数量。'],
  ]) {
    await amount.fill(value)
    await expect(move.getByRole('alert')).toHaveText(message)
    await copy(page, move.getByRole('alert'))
    await expect(move.getByRole('button', { name: /二号库房/ })).toBeDisabled()
  }
  await sheetCopy(page, move)
  await shot(page, info, 'move-to')
  await amount.fill('5')
  await move.getByRole('button', { name: /二号库房/ }).click()
  const firstMove = await toastCopy(page, '已将 5 移至“二号库房”，编号为 #0001')
  await expect(row.getByText('移动 1 次')).toBeVisible()
  await row.getByLabel('数量').fill('8')
  await row.getByLabel('数量').blur()
  await expect
    .poll(
      async () =>
        (await idbSnapshot(page)).entries.find((entry) => entry.collection_id === source.split('/').at(-1))
          ?.quantity,
    )
    .toBe('8')
  await firstMove.getByRole('button', { name: '撤销' }).click()
  await toastCopy(page, '移动后条目已有改动，无法撤销此次移动。')
  await row.getByLabel('数量').fill('7')
  await row.getByLabel('数量').blur()
  await entryAction(row, '移至…')
  await expect(move.getByRole('heading', { name: '最近使用' })).toBeVisible()
  await amount.fill('2')
  await move.getByRole('button', { name: /二号库房/ }).click()
  const partial = await toastCopy(page, '已将 2 移至“二号库房”的现有条目 #0001')
  await partial.getByRole('button', { name: '撤销' }).click()
  const undone = await toastCopy(page, '已撤销移动')
  await undone.locator('.toast-close').click()
  await expect(row.getByLabel('数量')).toHaveValue('7')

  await entryAction(row, '移至…')
  await move.getByRole('button', { name: /二号库房/ }).click()
  const moved = await toastCopy(page, '已移至“二号库房”，并入现有条目 #0001')
  await moved.getByRole('button', { name: '打开' }).click()
  await expect(page).toHaveURL(new RegExp(target + '/e/'))
  const history = page.getByRole('region', { name: '移动记录' })
  await expect(history.locator('li')).toHaveCount(2)
  await expect(history.getByText('原有数量：5')).toBeVisible()
  await history.getByRole('button', { name: '显示已撤销记录' }).click()
  await expect(history.locator('li.undone')).toHaveCount(1)
  await expect(history.locator('time').first()).toHaveText(/\d+月\d+日/)
  await copy(page, history)
  await history.scrollIntoViewIfNeeded()
  await shot(page, info, 'history')
  await history.getByRole('button', { name: '隐藏已撤销记录' }).click()
  await expect(history.locator('li.undone')).toHaveCount(0)

  await page.goto(source)
  await page.getByRole('button', { name: /^(Recently Deleted|最近删除)$/ }).click()
  const trash = page.getByRole('region', { name: '最近删除' })
  await expect(trash.getByText('已移至“二号库房”（#0001）')).toBeVisible()
  await copy(page, trash)
  await page.goto(sourceDetail)
  const detail = page.locator('.detail-page')
  await expect(detail.getByText('已移至“二号库房”，编号为 #0001')).toBeVisible()
  await copy(page, detail)
  await shot(page, info, 'moved-detail')
})

test('localizes import search, source steps, shared placements, and bulk move', async ({ page }, info) => {
  const target = await createCollection(page, roomB)
  const importAction = /^(Import from another collection|从其他清点单导入)$/
  const bulkAction = /^(Move entries…|移动条目…)$/
  const importSheet = page.getByRole('dialog', { name: '从其他清点单导入' })
  await collectionAction(page, importAction)
  await expect(importSheet.getByText('暂无其他仅本设备清点单。')).toBeVisible()
  await sheetCopy(page, importSheet)
  await page.keyboard.press('Escape')

  const source = await createCollection(page, roomA)
  const row = await newEntry(page)
  await row.getByLabel('条目标题').fill(itemName)
  await row.getByLabel('条目标题').blur()
  await selectPhoto(page, row.getByRole('button', { name: '从相册添加' }), 'import')
  await expect(row.getByText('1 张照片')).toBeVisible()
  await page.goto(target)
  await collectionAction(page, importAction)
  await sheetCopy(page, importSheet)
  await shot(page, info, 'import-sources')
  const search = importSheet.getByRole('textbox', { name: '搜索全部清点单' })
  await search.fill('无匹配项')
  await expect(importSheet.getByRole('status')).toHaveText('没有匹配的物品。')
  await sheetCopy(page, importSheet)
  await search.fill(itemName)
  const results = importSheet.getByLabel('导入搜索结果')
  await expect(results.getByRole('checkbox')).toHaveCount(1)
  await sheetCopy(page, importSheet)
  await shot(page, info, 'import-search')
  await search.clear()
  await importSheet.getByRole('button', { name: roomA }).click()
  const candidates = page.getByRole('dialog', { name: '从“一号库房”导入' })
  await expect(candidates.getByLabel('可导入的物品').getByRole('checkbox')).toHaveCount(1)
  await sheetCopy(page, candidates)
  await shot(page, info, 'import-items')
  await candidates.getByRole('button', { name: /返回/ }).click()
  await sheetCopy(page, importSheet)
  await importSheet.getByRole('button', { name: roomA }).click()
  await candidates.getByRole('checkbox').check()
  await candidates.getByRole('button', { name: '清除' }).click()
  await expect(candidates.getByText('已选 0 项')).toBeVisible()
  await candidates.getByRole('checkbox').check()
  await candidates.getByRole('button', { name: '导入 1 个物品' }).click()
  const imported = await toastCopy(page, '已导入 1 个物品')
  await expect(page.getByText('共享 · 2 份清点单')).toBeVisible()
  await imported.getByRole('button', { name: '撤销' }).click()
  await expect(page.locator('[data-entry-id]')).toHaveCount(0)

  await collectionAction(page, importAction)
  await importSheet.getByRole('button', { name: roomA }).click()
  await candidates.getByRole('checkbox').check()
  await candidates.getByRole('button', { name: '导入 1 个物品' }).click()
  await toastCopy(page, '已导入 1 个物品，其中 1 个恢复了原编号')
  await collectionAction(page, importAction)
  await search.fill(itemName)
  await expect(results.getByRole('checkbox')).toBeDisabled()
  await expect(results.getByText('已在此清点单中')).toBeVisible()
  await sheetCopy(page, importSheet)
  await page.keyboard.press('Escape')

  await page.locator('[data-entry-id]').first().getByLabel('打开 #0001 的详情').click()
  const detail = page.locator('.detail-page')
  await expect(detail.getByText('标题、备注和照片在 2 份清点单中共享。')).toBeVisible()
  await copy(page, detail)
  await shot(page, info, 'shared-detail')
  await detail.getByRole('button', { name: '删除照片' }).click()
  await (await toastCopy(page, '已从 2 份清点单中删除照片。')).getByRole('button', { name: '撤销' }).click()

  await page.goto(source)
  const sourceRow = page.locator('[data-entry-id]').first()
  const sourceId = await sourceRow.getAttribute('data-entry-id')
  await entryAction(sourceRow, '删除条目')
  await expect(page.locator('[data-entry-id]')).toHaveCount(0)
  await page.goto(source + '/e/' + sourceId)
  await expect(detail.getByText(/已从这份清点单移除。此条目也在/)).toBeVisible()
  await copy(page, detail)
  await detail.getByRole('button', { name: '恢复' }).click()
  await expect(detail.getByRole('button', { name: '拍照', exact: true })).toBeVisible()
  await page.goto(source)
  await collectionAction(page, bulkAction)
  const bulk = page.getByRole('dialog', { name: '移动条目' })
  await expect(bulk.getByLabel('新清点单名称')).toHaveValue('一号库房（拆分）')
  await bulk.getByLabel('搜索要移动的条目').fill('无匹配项')
  await expect(bulk.getByText('没有找到可移动的条目。')).toBeVisible()
  await sheetCopy(page, bulk)
  await bulk.getByLabel('搜索要移动的条目').clear()
  await bulk.getByRole('button', { name: '全选' }).click()
  await sheetCopy(page, bulk)
  await bulk.getByRole('button', { name: '移动 1 个条目' }).scrollIntoViewIfNeeded()
  await shot(page, info, 'bulk-move')
  await bulk.getByLabel('新清点单名称').fill('拆分库房')
  await bulk.getByRole('button', { name: '移动 1 个条目' }).click()
  await toastCopy(page, '已移动 1 个条目')

  await page.goto('/')
  const sourceMenu = page.locator('.collection-card-menu summary').and(page.getByLabel(/一号库房/))
  await sourceMenu.click()
  await page.getByRole('menuitem', { name: /^(Archive|归档)$/ }).click()
  await expect(sourceMenu).toHaveCount(0)
  await page.goto(target)
  await collectionAction(page, importAction)
  await expect(importSheet.getByRole('button', { name: /一号库房.*已归档/ })).toBeVisible()
  await sheetCopy(page, importSheet)
})

test('localizes fast camera controls, save states and permission recovery', async ({ page }, info) => {
  await page.addInitScript(() => {
    if (!navigator.mediaDevices) return
    Object.defineProperty(globalThis, 'ImageCapture', { configurable: true, value: undefined })
    const toBlob = HTMLCanvasElement.prototype.toBlob
    let release: (() => void) | undefined
    document.addEventListener('i18n-entry-camera-release', () => release?.())
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      const mode = sessionStorage.getItem('i18n-entry-frame')
      if (mode === 'fail') args[0](null)
      else if (mode === 'hold') release = () => toBlob.apply(this, args)
      else toBlob.apply(this, args)
    }
    const click = HTMLInputElement.prototype.click
    HTMLInputElement.prototype.click = function () {
      if (this.type === 'file' && sessionStorage.getItem('i18n-entry-block-picker')) {
        throw new DOMException('Test blocked picker', 'NotAllowedError')
      }
      click.call(this)
    }
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      value: async () => [
        { kind: 'videoinput', label: 'Back camera', deviceId: 'rear-one' },
        { kind: 'videoinput', label: 'Rear wide camera', deviceId: 'rear-two' },
      ],
    })
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async (constraints: MediaStreamConstraints) => {
        const mode = sessionStorage.getItem('i18n-entry-camera')
        if (mode === 'denied') throw new DOMException('', 'NotAllowedError')
        if (mode === 'missing') throw new DOMException('', 'NotFoundError')
        const canvas = document.createElement('canvas')
        canvas.width = 128
        canvas.height = 128
        const paint = canvas.getContext('2d')!
        const stream = canvas.captureStream(10)
        const track = stream.getVideoTracks()[0]!
        const frame = setInterval(() => {
          if (track.readyState === 'ended') {
            clearInterval(frame)
            return
          }
          paint.fillStyle = '#dcd'
          paint.fillRect(0, 0, 128, 128)
        }, 80)
        const device = (constraints.video as MediaTrackConstraints).deviceId as ConstrainDOMStringParameters
        Object.defineProperties(track, {
          getSettings: { value: () => ({ deviceId: device?.exact || 'rear-one', width: 128, height: 128 }) },
          getCapabilities: {
            value: () =>
              mode === 'digital'
                ? {}
                : {
                    zoom: { min: 1, max: 3, step: 0.1 },
                    torch: true,
                    focusMode: ['continuous', 'manual', 'single-shot', 'none'],
                    focusDistance: { min: 1, max: 10, step: 1 },
                  },
          },
          applyConstraints: {
            value: async () => {
              throw new DOMException('', 'OverconstrainedError')
            },
          },
        })
        return stream
      },
    })
  })
  await createCollection(page, roomA)
  await newEntry(page)
  await changeLocalData(page, 'settings')
  await page.reload()
  const row = page.locator('[data-entry-id]').first()
  await row.getByRole('button', { name: '拍照', exact: true }).click()
  const camera = page.getByRole('dialog', { name: '快速拍照' })
  await expect(camera.getByLabel('镜头').locator('option')).toHaveText(['后置相机 1', '后置相机 2'])
  await expect(camera.getByLabel('对焦模式').locator('option')).toHaveText([
    '连续自动对焦',
    '手动对焦',
    '单次自动对焦',
    '不对焦',
  ])
  await copy(page, camera)
  await shot(page, info, 'camera')
  for (const [control, message] of [
    ['变焦', '相机不支持所选的变焦设置。'],
    ['补光灯', '相机无法更改补光灯设置。'],
    ['对焦模式', '相机无法更改对焦模式。'],
    ['对焦距离', '相机无法更改对焦距离。'],
  ]) {
    const input = camera.getByLabel(control, { exact: control !== '对焦模式' })
    if (control === '补光灯') await input.check()
    else if (control === '对焦模式') await input.selectOption('manual')
    else
      await input.evaluate((element) => {
        const range = element as HTMLInputElement
        range.value = range.value === range.min ? range.max : range.min
        range.dispatchEvent(new Event('input', { bubbles: true }))
      })
    await expect(camera.getByRole('alert')).toHaveText(message)
    await copy(page, camera)
  }
  const shutter = camera.getByRole('button', { name: '拍照' })
  await page.evaluate(() => sessionStorage.setItem('i18n-entry-frame', 'fail'))
  await shutter.click()
  await expect(camera.getByRole('alert')).toHaveText('无法保存此照片。请检查剩余存储空间后重试。')
  await copy(page, camera)
  await page.evaluate(() => sessionStorage.setItem('i18n-entry-frame', 'hold'))
  await shutter.click()
  await expect(camera.getByText('已保存 0 张，正在保存 1 张')).toBeVisible()
  await copy(page, camera)
  await page.evaluate(() => {
    sessionStorage.removeItem('i18n-entry-frame')
    document.dispatchEvent(new Event('i18n-entry-camera-release'))
  })
  await expect(camera.getByText('已保存 1 张', { exact: true })).toBeVisible()
  await copy(page, camera)
  await camera.getByRole('button', { name: '完成' }).click()
  await expect(row.getByText('1 张照片')).toBeVisible()
  const data = await idbSnapshot(page)
  expect(data.photos[0]?.capture_source).toBe('camera_frame')

  await page.evaluate(() => sessionStorage.setItem('i18n-entry-camera', 'digital'))
  await row.getByRole('button', { name: '拍照', exact: true }).click()
  const preview = camera.getByRole('application', { name: '相机预览控制' })
  await expect(camera.getByLabel('镜头')).toBeVisible()
  await preview.evaluate((element) => {
    for (const [eventType, end] of [
      ['touchstart', 20],
      ['touchmove', 40],
    ] as const) {
      const event = new Event(eventType, { bubbles: true })
      Object.defineProperty(event, 'touches', {
        value: [
          { clientX: 0, clientY: 0 },
          { clientX: end, clientY: 0 },
        ],
      })
      element.dispatchEvent(event)
    }
  })
  await expect(camera.getByText('数码裁切 2.0×')).toBeVisible()
  await copy(page, camera)
  await camera.getByRole('button', { name: '完成' }).click()

  await page.evaluate(() => sessionStorage.setItem('i18n-entry-camera', 'denied'))
  await row.getByRole('button', { name: '拍照', exact: true }).click()
  await expect(camera.getByText('相机已暂停')).toBeVisible()
  await expect(camera.getByRole('alert')).toContainText('Safari')
  await copy(page, camera)
  await shot(page, info, 'camera-permission')
  await page.evaluate(() => sessionStorage.setItem('i18n-entry-camera', 'missing'))
  await camera.getByRole('button', { name: '继续拍照' }).click()
  await expect(camera.getByRole('alert')).toContainText('找到相机')
  await copy(page, camera)
  const systemCamera = camera.getByRole('button', { name: '改用系统相机' })
  await page.evaluate(() => sessionStorage.setItem('i18n-entry-block-picker', 'true'))
  await systemCamera.click()
  await expect(camera.getByRole('alert')).toHaveText('无法打开系统相机。请检查相机权限后重试。')
  await copy(page, camera)
  await page.evaluate(() => sessionStorage.removeItem('i18n-entry-block-picker'))
  await selectPhoto(page, systemCamera, 'system')
  await expect(camera.getByText('已保存 1 张', { exact: true })).toBeVisible()
  await copy(page, camera)
})

test('localizes on-device write failures and unavailable photo states', async ({ page }) => {
  // Simulate a browser storage failure while leaving reads and unrelated stores available.
  await page.addInitScript(() => {
    const add = IDBObjectStore.prototype.add
    const put = IDBObjectStore.prototype.put
    function check(store: IDBObjectStore) {
      if (sessionStorage.getItem('i18n-entry-failing-store') === store.name)
        throw new DOMException('Test quota failure', 'QuotaExceededError')
    }
    IDBObjectStore.prototype.add = function (...args) {
      check(this)
      return add.apply(this, args)
    }
    IDBObjectStore.prototype.put = function (...args) {
      check(this)
      return put.apply(this, args)
    }
  })

  const path = await createCollection(page, roomA)
  const row = await newEntry(page)
  await page.evaluate(() => sessionStorage.setItem('i18n-entry-failing-store', 'photoBlobs'))
  await selectPhoto(page, row.getByRole('button', { name: '从相册添加' }), 'rejected-row')
  await expect(row.getByText('无法添加照片')).toBeVisible()
  await copy(page, row.locator('.row-status'))

  await row.getByLabel('打开 #0001 的详情').click()
  const detail = page.locator('.detail-page')
  await selectPhoto(page, detail.getByRole('button', { name: '从相册添加' }), 'rejected-detail')
  await toastCopy(page, '无法添加照片。请检查剩余存储空间后重试。')

  await page.evaluate(() => sessionStorage.setItem('i18n-entry-failing-store', 'items'))
  await detail.getByLabel('条目标题').fill(itemName)
  await detail.getByLabel('条目标题').blur()
  const save = detail.locator('.save-state')
  await expect(save).toHaveText('无法将此更改保存到本设备。请重试。')
  await copy(page, save)
  await page.evaluate(() => sessionStorage.removeItem('i18n-entry-failing-store'))
  await selectPhoto(page, detail.getByRole('button', { name: '从相册添加' }), 'missing-bytes')
  await expect(detail.getByRole('button', { name: '查看第 1 张照片' })).toBeVisible()
  await changeLocalData(page, 'photoBlobs')
  await page.reload()
  await expect(detail.getByText('正在加载照片…')).toBeVisible()
  await copy(page, detail.getByLabel('条目照片'))
  await detail.getByRole('button', { name: '查看第 1 张照片' }).click()
  const viewer = page.getByRole('dialog', { name: '照片查看器' })
  await expect(viewer.getByText('暂无可查看的照片')).toBeVisible()
  await copy(page, viewer)

  await page.goto(path + '/e/missing')
  const loading = page.locator('.detail-empty')
  await expect(loading).toHaveText('正在加载条目…')
  await copy(page, loading)
})
