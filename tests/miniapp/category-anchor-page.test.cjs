// 分类页左右联动（分组锚点）的页面级行为锁（2026-09-17 设计）。
//
// 这份用例锁的是「数据怎么流」：进页一次拉全量、按分类分段、无「全部」项、
// 左侧点击等于定位（不发新请求）、首页意图改成定位、搜索模式与分组视图互不干扰。
// 滚动联动（量锚点 / 节流高亮 / 点击锁）在 Task 5 里追加到本文件。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const loadedPages = []
test.afterEach(() => { for (const page of loadedPages.splice(0)) page._clearTimers() })

function loadPage(relPath, ctx) {
  Object.keys(require.cache)
    .filter((k) => k.includes(path.join('apps', 'miniapp')))
    .forEach((k) => delete require.cache[k])
  let registered = null
  global.Page = (o) => { registered = o }
  global.Component = (o) => { registered = o }
  global.getApp = () => ctx.app
  global.wx = ctx.wx
  require(relPath)
  registered.data = Object.assign({}, registered.data)
  registered._patches = []
  registered.setData = function (patch) {
    registered._patches.push(patch)
    Object.assign(registered.data, patch)
  }
  registered.selectComponent = () => null
  loadedPages.push(registered)
  return registered
}

function makeCtx(channel, opts) {
  opts = opts || {}
  const urls = []
  const pageScrolls = []
  const app = {
    globalData: { shoppingChannel: channel, localMode: opts.localMode || 'DELIVERY', pendingCategoryId: null, pendingCategoryName: null, pendingCategoryAll: false },
    getShoppingChannel: () => app.globalData.shoppingChannel,
    setShoppingChannel: (v) => { app.globalData.shoppingChannel = v; return v },
    getLocalMode: () => app.globalData.localMode,
    setLocalMode: (v) => { app.globalData.localMode = v; return v },
    applyCartBadge() {}, updateCartCount() {},
  }
  const wx = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    request: (o) => {
      const url = o.url.replace(/^https?:\/\/[^/]+(\/api)?/, '')
      urls.push(url)
      if (/\/categories/.test(url)) {
        if (opts.categoriesFail) {
          o.success({ statusCode: 200, data: { code: 50001, message: '系统开小差了' } })
          return
        }
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: opts.categories || [] } })
        return
      }
      if (/\/products/.test(url)) {
        const body = opts.respond ? opts.respond(url) : { list: [], total: 0 }
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: body } })
        return
      }
      if (/\/local\/meta/.test(url)) {
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: opts.meta || null } })
        return
      }
      if (/\/cart/.test(url)) {
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: { items: [], totalAmount: 0, selectedCount: 0 } } })
        return
      }
      o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: {} } })
    },
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
    getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, height: 32 }),
    stopPullDownRefresh() {}, showToast() {}, switchTab() {}, navigateTo() {}, reLaunch() {},
    showNavigationBarLoading() {}, hideNavigationBarLoading() {},
    nextTick: (fn) => setTimeout(fn, 0),
    pageScrollTo: (o) => pageScrolls.push(o),
    createSelectorQuery: () => {
      selectorQueryCalls++
      const selections = []
      let current
      const q = {
        in: () => q,
        selectViewport: () => { current = 'viewport'; return q },
        select: (s) => { current = s; return q },
        selectAll: (s) => { current = s; return q },
        boundingClientRect: () => { selections.push(['rect', current]); return q },
        scrollOffset: () => { selections.push(['scroll', current]); return q },
        exec: (cb) => {
          const old = opts.selectorQueryResult || [{ top: 100, height: 600 }, { scrollTop: 0 }, []]
          const rects = {
            '.catalog-toolbar': { top: 0, height: 40 },
            '.catalog-body': { top: old[0].top, height: old[0].height },
            '.group-anchor': old[2].length ? old[2] : (opts.categories || []).map((c, i) => ({ dataset: { gid: c.id }, top: old[0].top + i * 300, height: 300 })),
            '.cat-item': (opts.categories || []).map((c, i) => ({ dataset: { gid: c.id }, top: old[0].top + i * 50, height: 50 })),
            '.cat-panel': { top: old[0].top, height: 600 },
            '.search-results': { top: old[0].top, bottom: 900, height: 800 },
          }
          cb(selections.map(([kind, s]) => kind === 'scroll' ? { scrollTop: s === '.cat-panel' ? (opts.sidebarScrollTop || 0) : old[1].scrollTop } : rects[s]))
        },
      }
      return q
    },
  }
  let selectorQueryCalls = 0
  return { app, wx, urls, pageScrolls, getSelectorQueryCalls: () => selectorQueryCalls }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
async function settleAll(n) {
  for (let i = 0; i < (n || 6); i++) await settle()
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function makeProduct(id, categoryId) {
  return { id: id, categoryId: categoryId, name: 'p' + id, price: 1000, stock: 5, hasSkus: false }
}

function pagedRespond(pages, total) {
  return function (url) {
    const m = /page=(\d+)/.exec(url)
    const page = m ? Number(m[1]) : 1
    return { list: pages[page - 1] || [], total: total }
  }
}

const CATEGORIES_3 = [{ id: 1, name: '特色菜' }, { id: 2, name: '凉菜' }, { id: 3, name: '礼盒' }]

function pagesFor60() {
  const page1 = []
  for (let i = 1; i <= 50; i++) page1.push(makeProduct(i, i % 2 === 0 ? 2 : 1))
  const page2 = []
  for (let i = 51; i <= 60; i++) page2.push(makeProduct(i, i % 2 === 0 ? 2 : 1))
  return [page1, page2]
}

test('进页拉全量、按分类分段、默认高亮第一段', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  assert.ok(ctx.urls.some((u) => u.indexOf('page=1&pageSize=50') !== -1), ctx.urls.join(' '))
  assert.ok(ctx.urls.some((u) => u.indexOf('page=2&pageSize=50') !== -1), ctx.urls.join(' '))
  assert.ok(!ctx.urls.some((u) => u.indexOf('categoryId=') !== -1), ctx.urls.join(' '))
  assert.deepEqual(page.data.groups.map((g) => g.id), [1, 2, 3])
  assert.deepEqual(page.data.groups[2].items, [])
  assert.equal(page.data.activeGroupId, 1)
  assert.equal(page.data.activeGroupName, '特色菜')
  assert.equal(page.data.catalogLoading, false)
  page.data.groups[0].items.forEach((p) => {
    assert.equal(typeof p.priceText, 'string')
    assert.equal(typeof p.stockLabel, 'string')
    assert.equal(typeof p.hasSkus, 'boolean')
  })
})

test('左侧没有「全部」项', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  assert.equal(page.data.groups.some((g) => g.id === null), false)
  if (page.data.categories) {
    assert.equal(page.data.categories.some((c) => c.id === null), false)
  }
})

test('点左侧 = 定位：滚到该段、立刻高亮，不发新请求', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  const before = ctx.urls.length
  page.onSelectCategory.call(page, { currentTarget: { dataset: { id: 2 } } })
  assert.equal(ctx.pageScrolls.at(-1).scrollTop, 360)
  assert.equal(page.data.activeGroupId, 2)
  assert.equal(page.data.activeGroupName, '凉菜')
  assert.equal(ctx.urls.length, before, '点左侧不该发新请求')
})

test('同一分类再点一次仍发出原生页面定位', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  page.onSelectCategory.call(page, { currentTarget: { dataset: { id: 2 } } })
  assert.equal(ctx.pageScrolls.at(-1).scrollTop, 360)
  const before = ctx.pageScrolls.length
  page.onSelectCategory.call(page, { currentTarget: { dataset: { id: 2 } } })
  assert.equal(ctx.pageScrolls.length, before + 1)
  assert.equal(ctx.pageScrolls.at(-1).scrollTop, 360)
})

test('首页意图 → 定位（pendingCategoryId / pendingCategoryAll）', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()

  ctx.app.globalData.pendingCategoryId = 2
  ctx.app.globalData.pendingCategoryName = '凉菜'
  page.onShow.call(page)
  assert.equal(ctx.pageScrolls.at(-1).scrollTop, 360)
  assert.equal(page.data.activeGroupId, 2)
  assert.equal(ctx.app.globalData.pendingCategoryId, null)
  assert.equal(ctx.app.globalData.pendingCategoryName, null)
  assert.equal(ctx.app.globalData.pendingCategoryAll, false)

  ctx.app.globalData.pendingCategoryAll = true
  page.onShow.call(page)
  assert.equal(page.data.activeGroupId, 1)
  assert.equal(page.data.searchKeyword, '')
  assert.equal(ctx.pageScrolls.at(-1).scrollTop, 0, '回首页要滚到页面顶部')
  assert.equal(ctx.app.globalData.pendingCategoryAll, false)
  assert.equal(ctx.app.globalData.pendingCategoryId, null)
  assert.equal(ctx.app.globalData.pendingCategoryName, null)
})

test('意图先于数据到达：onLoad 之前设好，拉完之后仍生效', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  ctx.app.globalData.pendingCategoryId = 2
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  page.onShow.call(page)
  assert.equal(page.data.groups.length, 0, '此刻数据还没回来')
  await settleAll()
  assert.equal(page.data.activeGroupId, 2)
})

test('搜索模式保留分页且与分组视图互不干扰（仅邮寄）', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  const groupsBefore = page.data.groups
  const catalogUrlCountBefore = ctx.urls.filter((u) => u.indexOf('pageSize=50') !== -1).length

  page.setData({ keyword: '兔' })
  page.onSearchConfirm.call(page)
  await settleAll()
  assert.ok(ctx.urls.some((u) => u.indexOf('keyword=%E5%85%94') !== -1 && u.indexOf('page=1&pageSize=20') !== -1), ctx.urls.join(' '))
  assert.deepEqual(page.data.groups, groupsBefore, '搜索不该清掉分组数据')

  page.onReachBottom.call(page)
  await settleAll()
  assert.ok(ctx.urls.some((u) => u.indexOf('keyword=%E5%85%94') !== -1 && u.indexOf('page=2') !== -1), ctx.urls.join(' '))

  page.clearSearch.call(page)
  await settleAll()
  assert.equal(page.data.searchKeyword, '')
  assert.deepEqual(page.data.list, [])
  assert.equal(page.data.activeGroupId, 1)
  assert.equal(ctx.pageScrolls.at(-1).scrollTop, 0, '清搜索应回到页面顶部')
  const catalogUrlCountAfter = ctx.urls.filter((u) => u.indexOf('pageSize=50') !== -1).length
  assert.equal(catalogUrlCountAfter, catalogUrlCountBefore, 'clearSearch 不该重新拉全量')
})

test('clearSearch 在选择旧分类后回到页面顶部', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  page.onSelectCategory.call(page, { currentTarget: { dataset: { id: 3 } } })
  assert.equal(ctx.pageScrolls.at(-1).scrollTop, 660)
  page.setData({ keyword: '兔' })
  page.onSearchConfirm.call(page)
  await settleAll()
  page.clearSearch.call(page)
  await settleAll()
  assert.equal(ctx.pageScrolls.at(-1).scrollTop, 0)
})

test('pendingCategoryAll（非搜索路径）只回页面顶部一次', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  page.onSelectCategory.call(page, { currentTarget: { dataset: { id: 3 } } })
  assert.equal(ctx.pageScrolls.at(-1).scrollTop, 660)
  const scrollCallsBefore = ctx.pageScrolls.length
  page._patches.length = 0
  ctx.app.globalData.pendingCategoryAll = true
  page.onShow.call(page)
  assert.equal(ctx.pageScrolls.length, scrollCallsBefore + 1)
  assert.equal(ctx.pageScrolls.at(-1).scrollTop, 0)
})

test('分组视图下 onReachBottom 不发请求', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  const before = ctx.urls.length
  page.onReachBottom.call(page)
  await settleAll()
  assert.equal(ctx.urls.length, before)
})

test('切渠道清空：groups/activeGroupId/searchKeyword/offsets 归零，catalogLoading 置真', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  ctx.app.globalData.shoppingChannel = 'LOCAL'
  page.reloadForChannel.call(page)
  assert.deepEqual(page.data.groups, [])
  assert.equal(page.data.activeGroupId, null)
  assert.equal(page.data.searchKeyword, '')
  assert.deepEqual(page._offsets, [])
  assert.equal(page.data.catalogLoading, true)
})

test('分类接口失败不丢菜：全部归到「其他」段', async function () {
  const ctx = makeCtx('EXPRESS', { categoriesFail: true, respond: pagedRespond([[makeProduct(1, 1), makeProduct(2, 2)]], 2) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  assert.equal(page.data.groups.length, 1)
  assert.equal(page.data.groups[0].id, 'other')
  assert.equal(page.data.groups[0].name, '其他')
  assert.equal(page.data.groups[0].items.length, 2)
})

test('findProduct：分组视图按 id 在全量里找；搜索模式优先在 list 里找', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  const found = page.findProduct.call(page, 5)
  assert.ok(found, '应该能在全量里找到')
  assert.equal(found.id, 5)

  page.setData({ list: [{ id: 999, name: '搜索结果' }] })
  const foundSearch = page.findProduct.call(page, 999)
  assert.ok(foundSearch)
  assert.equal(foundSearch.name, '搜索结果')
})

// ── Task 5：滚动联动（量锚点 / 节流高亮 / 点击锁 / 图片去抖） ──

test('量锚点：offsets 与 tailHeight 按量出来的位置计算', async function () {
  const rects = [
    { dataset: { gid: 1 }, top: 100, height: 300 },
    { dataset: { gid: 2 }, top: 400, height: 250 },
    { dataset: { gid: 3 }, top: 650, height: 120 },
  ]
  const ctx = makeCtx('EXPRESS', {
    categories: CATEGORIES_3,
    respond: pagedRespond(pagesFor60(), 60),
    selectorQueryResult: [{ top: 100, height: 600 }, { scrollTop: 40 }, rects],
  })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  assert.deepEqual(page._offsets, [{ id: 1, top: 140 }, { id: 2, top: 440 }, { id: 3, top: 690 }])
  assert.equal(page.data.tailHeight, 652)
})

test('量锚点：最后一段比可视区高时 tailHeight 为 0', async function () {
  const rects = [{ dataset: { gid: 1 }, top: 0, height: 900 }]
  const ctx = makeCtx('EXPRESS', {
    categories: [{ id: 1, name: 'A' }],
    respond: pagedRespond([[makeProduct(1, 1)]], 1),
    selectorQueryResult: [{ top: 0, height: 812 }, { scrollTop: 0 }, rects],
  })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  assert.equal(page.data.tailHeight, 0)
})

test('滚动 → 高亮跟随（节流 100ms 后才生效，连续滚动只 setData 一次）', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  page._clearTimers()
  page._offsets = [{ id: 1, top: 0 }, { id: 2, top: 340 }, { id: 3, top: 590 }]
  page._patches.length = 0
  for (let i = 0; i < 10; i++) {
    page.onPageScroll.call(page, { scrollTop: 340 + i })
  }
  assert.equal(page.data.activeGroupId, 1, '节流期间不该立刻变')
  await wait(150)
  assert.equal(page.data.activeGroupId, 2)
  const activeGroupPatches = page._patches.filter((p) => Object.prototype.hasOwnProperty.call(p, 'activeGroupId'))
  assert.equal(activeGroupPatches.length, 1, '连续滚动只应触发一次 setData：' + JSON.stringify(page._patches))
})

test('点击锁：点左侧后 500ms 内滚动不改高亮，锁过期后恢复联动', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  page._clearTimers()
  page._offsets = [{ id: 1, top: 0 }, { id: 2, top: 340 }, { id: 3, top: 590 }]
  page.onSelectCategory.call(page, { currentTarget: { dataset: { id: 3 } } })
  assert.equal(page.data.activeGroupId, 3)
  page.onPageScroll.call(page, { scrollTop: 345 })
  await wait(150)
  assert.equal(page.data.activeGroupId, 3, '点击锁定期内滚动不该抢高亮')
  page._lockUntil = 0
  page.onPageScroll.call(page, { scrollTop: 345 })
  await wait(150)
  assert.equal(page.data.activeGroupId, 2)
})

test('搜索模式下 onPageScroll 不联动', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  page._offsets = [{ id: 1, top: 0 }, { id: 2, top: 340 }, { id: 3, top: 590 }]
  page.setData({ searchKeyword: '兔' })
  page.onPageScroll.call(page, { scrollTop: 345 })
  await wait(150)
  assert.equal(page.data.activeGroupId, 1, '搜索模式下不该联动')
})

test('图片加载去抖：连续调用只重量一次', async function () {
  const ctx = makeCtx('EXPRESS', { categories: CATEGORIES_3, respond: pagedRespond(pagesFor60(), 60) })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settleAll()
  // afterGroupsRendered 在 nextTick 之外还挂了一个 ~200ms 的二次 measureOffsets
  // 保险（返工 #6，与 onImageLoad 同款幂等）。直接清掉这个定时器而不是等它自己落地——
  // 等时间会把「它有没有先跑完」这个时序假设也测进去，本用例只想观测 onImageLoad 去抖。
  page._clearTimers()
  const before = ctx.getSelectorQueryCalls()
  for (let i = 0; i < 5; i++) page.onImageLoad.call(page)
  await wait(350)
  assert.equal(ctx.getSelectorQueryCalls() - before, 1)
})
