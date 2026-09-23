const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

test('layout uses the visible viewport, measured dock, and clamps malformed inputs', () => {
  const { layoutOf } = require('../../apps/miniapp/utils/category-scroll')
  assert.deepEqual(layoutOf({ viewportHeight: 720, pinnedHeight: 40, bodyTop: 240, scrollTop: 0, dockHeight: 72, lastGroupHeight: 120 }), { sidebarTop: 240, sidebarHeight: 408, tailHeight: 488 })
  assert.deepEqual(layoutOf({ viewportHeight: 720, pinnedHeight: 40, bodyTop: 240, scrollTop: 300, dockHeight: 72, lastGroupHeight: 120 }), { sidebarTop: 40, sidebarHeight: 608, tailHeight: 488 })
  assert.deepEqual(layoutOf({ viewportHeight: 100, pinnedHeight: 80, bodyTop: 240, scrollTop: -20, dockHeight: 90, lastGroupHeight: 20 }), { sidebarTop: 240, sidebarHeight: 0, tailHeight: 0 })
  assert.deepEqual(layoutOf({ viewportHeight: 720, pinnedHeight: 40, bodyTop: 240, scrollTop: 300, dockHeight: 0, lastGroupHeight: 120 }), { sidebarTop: 40, sidebarHeight: 680, tailHeight: 560 })
  assert.deepEqual(layoutOf({ viewportHeight: NaN, pinnedHeight: undefined, bodyTop: Infinity, scrollTop: -Infinity, dockHeight: null, lastGroupHeight: NaN }), { sidebarTop: 0, sidebarHeight: 0, tailHeight: 0 })
})

test('targets and item revelation use clamped document coordinates', () => {
  const { pageTarget, revealScrollTop } = require('../../apps/miniapp/utils/category-scroll')
  assert.equal(pageTarget(900, 40), 860)
  assert.equal(pageTarget(20, 40), 0)
  assert.equal(pageTarget(Infinity, NaN), 0)
  assert.equal(revealScrollTop({ itemTop: 450, itemHeight: 50, scrollTop: 0, viewportHeight: 400 }), 100)
  assert.equal(revealScrollTop({ itemTop: 100, itemHeight: 50, scrollTop: 80, viewportHeight: 400 }), 80)
  assert.equal(revealScrollTop({ itemTop: 10, itemHeight: 50, scrollTop: 80, viewportHeight: 400 }), 10)
  assert.equal(revealScrollTop({ itemTop: NaN, itemHeight: 0, scrollTop: -10, viewportHeight: Infinity }), 0)
})

function fixture(options = {}) {
  let registered
  const pending = []
  const calls = []
  const rects = {
    '.catalog-toolbar': { top: 200, height: 40 },
    '.catalog-body': { top: 240, height: 800 },
    '.cat-panel': { top: 240, height: 408 },
    '.group-anchor': [
      { dataset: { gid: 1 }, top: 300, height: 300 },
      { dataset: { gid: 2 }, top: 600, height: 300 },
      { dataset: { gid: 3 }, top: 900, height: 120 },
    ],
    '.cat-item': [
      { dataset: { gid: 1 }, top: 240, height: 50 },
      { dataset: { gid: 2 }, top: 290, height: 50 },
      { dataset: { gid: 3 }, top: 340, height: 50 },
    ],
    '.search-results': { top: 240, height: 0, bottom: 240 },
  }
  let viewportTop = 0
  let sidebarViewportTop = 0
  let windowHeight = 720
  const wx = {
    getWindowInfo: () => ({ windowHeight, windowWidth: 375 }),
    getSystemInfoSync: () => ({ windowHeight, windowWidth: 375 }),
    nextTick: fn => fn(),
    pageScrollTo: o => calls.push(o),
    request: o => {
      const body = /\/categories/.test(o.url) ? [] : /\/products/.test(o.url) ? { list: [], total: 0 } : /\/local\/meta/.test(o.url) ? { enabled: true, isOpen: true, pickup: { enabled: true } } : {}
      o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: body } })
    },
    createSelectorQuery: () => {
      const selections = []
      let current
      const q = {
        in: () => q,
        selectViewport: () => { current = 'viewport'; return q },
        select: s => { current = s; return q },
        selectAll: s => { current = s; return q },
        scrollOffset: () => { selections.push(['scroll', current]); return q },
        boundingClientRect: () => { selections.push(['rect', current]); return q },
        exec: cb => {
          const result = () => selections.map(([kind, s]) => kind === 'scroll' ? { scrollTop: s === '.cat-panel' ? sidebarViewportTop : viewportTop } : rects[s])
          const snapshot = options.snapshotAtExec ? structuredClone(result()) : null
          pending.push(() => cb(snapshot || result()))
        },
      }
      return q
    },
  }
  const app = {
    globalData: { shoppingChannel: 'EXPRESS', pendingCategoryId: null, pendingCategoryName: null, pendingCategoryAll: false },
    getShoppingChannel: () => app.globalData.shoppingChannel,
    getLocalMode: () => 'DELIVERY', setLocalMode: () => 'DELIVERY', updateCartCount() {},
  }
  Object.keys(require.cache).filter(k => k.includes(path.join('apps', 'miniapp'))).forEach(k => delete require.cache[k])
  global.Page = o => { registered = o }
  global.getApp = () => app
  global.wx = wx
  require('../../apps/miniapp/pages/product/list.js')
  const page = registered
  page.data = { ...page.data, groups: [{ id: 1, name: 'one', items: [] }, { id: 2, name: 'two', items: [] }, { id: 3, name: 'three', items: [] }], catalogLoading: false }
  page.patches = []
  page.setData = patch => { page.patches.push(patch); Object.assign(page.data, patch) }
  page.selectComponent = () => null
  const flush = () => { while (pending.length) pending.shift()() }
  return { page, app, rects, calls, pending, flush, setViewportTop: y => { viewportTop = y }, setSidebarViewportTop: y => { sidebarViewportTop = y }, setWindowHeight: h => { windowHeight = h } }
}

test('page measurement uses one viewport sample for document anchors and measured dock layout', () => {
  const f = fixture()
  f.setViewportTop(100)
  f.page.measureOffsets()
  f.flush()
  assert.deepEqual(f.page._offsets, [{ id: 1, top: 400 }, { id: 2, top: 700 }, { id: 3, top: 1000 }])
  assert.equal(f.page.data.tailHeight, 560)
  f.page.onCartHeight({ detail: { px: 72 } })
  f.flush()
  assert.equal(f.page.data.cartSpacerPx, 72)
  assert.equal(f.page.data.sidebarHeight, 408)
  assert.equal(f.page.data.tailHeight, 488)
  f.page.onCartHeight({ detail: { px: 0 } })
  f.flush()
  assert.equal(f.page.data.sidebarHeight, 480)
  assert.equal(f.page.data.tailHeight, 560)
  f.page._clearTimers()
})

test('same category can be tapped twice and home intent waits for measured anchors', () => {
  const f = fixture()
  f.page.measureOffsets()
  f.flush()
  f.page.onSelectCategory({ currentTarget: { dataset: { id: 2 } } })
  f.page.onSelectCategory({ currentTarget: { dataset: { id: 2 } } })
  assert.deepEqual(f.calls.slice(-2).map(x => x.scrollTop), [560, 560])
  assert.equal(f.page.data.activeGroupId, 2)
  f.page._clearTimers()

  const g = fixture()
  g.app.globalData.pendingCategoryId = 3
  g.page.onShow()
  assert.equal(g.calls.length, 0)
  g.page.measureOffsets()
  g.flush()
  assert.equal(g.calls.at(-1).scrollTop, 860)
  assert.equal(g.app.globalData.pendingCategoryId, null)
  g.page._clearTimers()
})

// M15（复审建议，纳入本批）：先滚动（触发 onPageScroll 记下 _pendingScrollTop），
// 再点左侧分类定位（locateGroup 应清掉这个残留的滚动位置，见 list.js:252）——
// 不清的话，500ms 的「点击后锁定」到期时，_syncActiveFromScroll 会拿着滚动那一刻
// 留下的旧 _pendingScrollTop 把高亮重新算回滚动经过的那一段，覆盖掉顾客刚点的分类。
// A2 例外：本用例锁的是既有正确行为（list.js:252 那一行），不是待修的 bug，
// 所以先红的证据用「临时把这一行注释掉跑一次」代替，跑完必须还原（git diff 为空）。
test('T15 M15：点分类定位会清掉滚动残留，500ms 锁到期后高亮不被滚动位置抢回去', async () => {
  const f = fixture()
  f.page.measureOffsets()
  f.flush()
  f.page.onPageScroll({ scrollTop: 560 })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(f.page.data.activeGroupId, 2, '滚动应先把高亮带到经过的那一段')
  f.page.onSelectCategory({ currentTarget: { dataset: { id: 3 } } })
  assert.equal(f.page.data.activeGroupId, 3, '点击应立刻定位到第 3 组')
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(f.page.data.activeGroupId, 3, '锁到期后高亮不该被滚动经过的旧位置抢回去')
  f.page._clearTimers()
})

test('choosing a category while search is shown waits for grouped layout', () => {
  const f = fixture()
  f.page.measureOffsets(); f.flush()
  f.page.setData({ searchKeyword: 'A' })
  f.rects['.group-anchor'][1].top = 640
  f.page.locateGroup(2)
  f.flush()
  assert.equal(f.page.data.searchKeyword, '')
  assert.equal(f.calls.at(-1).scrollTop, 600)
  f.page._clearTimers()
})

test('out of order queries and hidden page cannot overwrite newer layout', () => {
  const f = fixture()
  f.page.measureOffsets()
  const old = f.pending.shift()
  f.rects['.catalog-body'] = { top: 280, height: 800 }
  f.page.measureOffsets()
  f.flush()
  assert.equal(f.page.data.sidebarTop, 280)
  old()
  assert.equal(f.page.data.sidebarTop, 280)
  f.page.measureOffsets()
  const hidden = f.pending.shift()
  f.page.onHide()
  f.rects['.catalog-body'] = { top: 310, height: 800 }
  hidden()
  assert.equal(f.page.data.sidebarTop, 280)
  f.page.onUnload()
})

test('a delayed selector sample keeps document offsets but cannot rewind a newer page scroll', () => {
  const f = fixture({ snapshotAtExec: true })
  f.page.measureOffsets(); f.flush()
  f.page.measureOffsets() // captures viewport Y=0 and group rectangles now
  f.page.onPageScroll({ scrollTop: 100 })
  assert.equal(f.page.data.sidebarTop, 140)
  f.flush()
  assert.equal(f.page._offsets[0].top, 300, 'anchor conversion must use the coherent selector sample')
  assert.equal(f.page._pageScrollTop, 100)
  assert.equal(f.page.data.sidebarTop, 140)
  assert.equal(f.page.data.sidebarHeight, 580)
  f.page._clearTimers()
})

test('channel reload invalidates a selector result from the old channel', async () => {
  const f = fixture()
  f.page.measureOffsets()
  const stale = f.pending.shift()
  f.app.globalData.shoppingChannel = 'LOCAL'
  f.page.reloadForChannel()
  stale()
  assert.deepEqual(f.page._offsets, [])
  assert.equal(f.page.data.pinnedHeight, 0)
  await new Promise(r => setTimeout(r, 0))
  f.page.onHide()
})

test('header height changes preserve product position once after browser anchoring', () => {
  const f = fixture()
  f.setViewportTop(500)
  f.rects['.catalog-body'].top = -300 // B=200 at Y=500
  f.rects['.catalog-toolbar'].height = 40
  f.page.measureOffsets(); f.flush()
  f.page.onPageScroll({ scrollTop: 500 })
  f.page._captureAnchor()
  f.rects['.catalog-body'].top = -280 // B=240 at Y=520
  f.rects['.catalog-toolbar'].height = 60
  f.setViewportTop(520)
  f.page.afterGroupsRendered(); f.flush()
  assert.equal(f.calls.length, 0, 'browser already preserved logical position')
  f.page._clearTimers()

  const g = fixture()
  g.setViewportTop(500)
  g.rects['.catalog-body'].top = -300
  g.rects['.catalog-toolbar'].height = 40
  g.page.measureOffsets(); g.flush()
  g.page.onPageScroll({ scrollTop: 500 })
  g.page._captureAnchor()
  g.rects['.catalog-body'].top = -260 // B=240 at Y=500
  g.rects['.catalog-toolbar'].height = 60
  g.page.afterGroupsRendered(); g.flush()
  assert.equal(g.calls.at(-1).scrollTop, 520)
  g.page._clearTimers()

  const h = fixture()
  h.setViewportTop(520)
  h.rects['.catalog-body'].top = -280 // B=240 at Y=520
  h.rects['.catalog-toolbar'].height = 60
  h.page.measureOffsets(); h.flush()
  h.page.onPageScroll({ scrollTop: 520 })
  h.page._captureAnchor()
  h.rects['.catalog-body'].top = -320 // B=200 at Y=520
  h.rects['.catalog-toolbar'].height = 40
  h.page.afterGroupsRendered(); h.flush()
  assert.equal(h.calls.at(-1).scrollTop, 500)
  h.page._clearTimers()
})

test('ordinary onShow preserves the current page position', async () => {
  const f = fixture()
  f.setViewportTop(500)
  f.rects['.catalog-body'].top = -260
  f.page.measureOffsets(); f.flush()
  f.page.onPageScroll({ scrollTop: 500 })
  f.page.onShow()
  await new Promise(r => setTimeout(r, 0))
  f.flush()
  assert.equal(f.calls.length, 0)
  f.page._clearTimers()
})

test('delayed selector callback still owns the header anchor snapshot', async () => {
  const f = fixture()
  f.setViewportTop(500)
  f.rects['.catalog-body'].top = -300
  f.page.measureOffsets(); f.flush()
  f.page.onPageScroll({ scrollTop: 500 })
  f.page._captureAnchor()
  f.page.afterGroupsRendered()
  f.flush() // first query runs before the child header reflows
  await new Promise(r => setTimeout(r, 210))
  f.rects['.catalog-body'].top = -260
  f.rects['.catalog-toolbar'].height = 60
  f.flush() // delayed query returns only now
  assert.equal(f.calls.at(-1).scrollTop, 520)
  f.page._clearTimers()
})

test('a newer page gesture cannot be rewound by an older header anchor', () => {
  const f = fixture({ snapshotAtExec: true })
  f.setViewportTop(500)
  f.rects['.catalog-body'].top = -300 // B=200 at Y=500
  f.page.measureOffsets(); f.flush()
  f.page.onPageScroll({ scrollTop: 500 })
  f.page._captureAnchor()
  f.rects['.catalog-body'].top = -260 // B=240 in the delayed selector sample
  f.page.measureOffsets()
  f.page.onPageScroll({ scrollTop: 700 })
  f.flush()
  assert.equal(f.calls.length, 0, 'old header anchor must not issue a page jump')
  assert.equal(f.page._pageScrollTop, 700)
  f.page._clearTimers()
})

test('page scroll highlights after throttle and reveals only offscreen sidebar items', async () => {
  const f = fixture()
  f.page.measureOffsets(); f.flush()
  f.page.onPageScroll({ scrollTop: 680 })
  assert.equal(f.page.data.activeGroupId, null)
  await new Promise(r => setTimeout(r, 130))
  assert.equal(f.page.data.activeGroupId, 2)
  const old = f.page.data.sidebarScrollTop
  f.page.onPageScroll({ scrollTop: 690 })
  await new Promise(r => setTimeout(r, 130))
  assert.equal(f.page.data.sidebarScrollTop, old)
  f.page._clearTimers()
})

test('a scroll jump across the header boundary pins the sidebar immediately', () => {
  const f = fixture()
  f.page.measureOffsets(); f.flush()
  f.page.onPageScroll({ scrollTop: 300 })
  assert.equal(f.page.data.sidebarTop, 40)
  assert.equal(f.page.data.sidebarHeight, 680)
  f.page._clearTimers()
})

test('resize recomputes sidebar and tail from the new viewport', () => {
  const f = fixture()
  f.page.measureOffsets(); f.flush()
  f.setWindowHeight(480)
  f.page.onResize()
  f.flush()
  assert.equal(f.page.data.sidebarHeight, 240)
  assert.equal(f.page.data.tailHeight, 320)
  f.page._clearTimers()
})

test('manual sidebar position is preserved until the selected item leaves view', () => {
  const f = fixture()
  f.page.data.groups = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: String(i + 1), items: [] }))
  f.rects['.cat-item'] = Array.from({ length: 20 }, (_, i) => ({ dataset: { gid: i + 1 }, top: 240 + i * 50, height: 50 }))
  f.page.measureOffsets(); f.flush()
  f.page.onSidebarScroll({ detail: { scrollTop: 200 } })
  f.page.setActiveGroup(5)
  assert.equal(f.page.data.sidebarScrollTop, 0)
  f.page.setActiveGroup(20)
  assert.equal(f.page.data.sidebarScrollTop, 520)
  f.page._clearTimers()
})

test('delayed sidebar rectangles use their own sampled scroll while reveal uses the live position', () => {
  function delayedSidebar() {
    const f = fixture({ snapshotAtExec: true })
    f.page.data.groups = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: String(i + 1), items: [] }))
    f.rects['.cat-item'] = Array.from({ length: 20 }, (_, i) => ({ dataset: { gid: i + 1 }, top: 240 + i * 50, height: 50 }))
    f.page.measureOffsets(); f.flush()
    f.page.measureOffsets() // rail rects and scroll offset sampled at zero
    f.setSidebarViewportTop(200)
    f.page.onSidebarScroll({ detail: { scrollTop: 200 } })
    f.flush()
    return f
  }
  const hidden = delayedSidebar()
  hidden.page.setActiveGroup(3) // content [100,150], visible interval [200,680]
  assert.equal(hidden.page.data.sidebarScrollTop, 100, 'reveal the hidden row by the minimum distance')
  hidden.page._clearTimers()

  const visible = delayedSidebar()
  visible.page.setActiveGroup(12) // content [550,600] is already visible
  assert.equal(visible.page.data.sidebarScrollTop, 0, 'do not disturb the live manual scroll')
  assert.equal(visible.page._sidebarScrollTop, 200)
  visible.page._clearTimers()
})

test('interrupted category jump reconciles its last scroll event at natural lock expiry', async () => {
  const f = fixture()
  f.page.measureOffsets(); f.flush()
  f.page.locateGroup(3)
  assert.equal(f.page.data.activeGroupId, 3)
  f.page.onPageScroll({ scrollTop: 560 }) // animation ends early in group 2
  await new Promise(r => setTimeout(r, 150))
  assert.equal(f.page.data.activeGroupId, 3, 'intermediate event remains locked')
  await new Promise(r => setTimeout(r, 450)) // no further page event
  assert.equal(f.page.data.activeGroupId, 2)
  f.page._clearTimers()
})

test('a second category tap owns the click lock and delays stale reconciliation', async () => {
  const f = fixture()
  f.page.measureOffsets(); f.flush()
  f.page.locateGroup(2)
  await new Promise(r => setTimeout(r, 200))
  f.page.locateGroup(3)
  f.page.onPageScroll({ scrollTop: 560 })
  await new Promise(r => setTimeout(r, 350)) // past first tap expiry, within second tap lock
  assert.equal(f.page.data.activeGroupId, 3)
  await new Promise(r => setTimeout(r, 230))
  assert.equal(f.page.data.activeGroupId, 2)
  f.page._clearTimers()
})

test('hiding the page cancels pending click-lock reconciliation', async () => {
  const f = fixture()
  f.page.measureOffsets(); f.flush()
  f.page.locateGroup(3)
  f.page.onPageScroll({ scrollTop: 560 })
  f.page.onHide()
  await new Promise(r => setTimeout(r, 550))
  assert.equal(f.page.data.activeGroupId, 3)
  assert.equal(f.page._lockTimer, null)
})

function activeSidebar(id, scrollTop) {
  const f = fixture()
  f.page.data.groups = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: String(i + 1), items: [] }))
  f.page.data.activeGroupId = id
  f.page.data.sidebarScrollTop = scrollTop
  f.page._sidebarScrollTop = scrollTop
  f.setSidebarViewportTop(scrollTop)
  f.setViewportTop(300)
  f.rects['.catalog-body'].top = -60 // document B=240: the toolbar is pinned
  f.rects['.cat-panel'].top = 40
  f.rects['.cat-item'] = Array.from({ length: 20 }, (_, i) => ({ dataset: { gid: i + 1 }, top: 40 + i * 50 - scrollTop, height: 50 }))
  f.page.measureOffsets(); f.flush()
  return f
}

test('dock growth minimally reveals the active category after sidebar height shrinks', () => {
  const f = activeSidebar(20, 320)
  assert.equal(f.page.data.sidebarHeight, 680)
  f.page.onCartHeight({ detail: { px: 72 } })
  assert.equal(f.page.data.sidebarHeight, 608)
  assert.equal(f.page.data.sidebarScrollTop, 392)
  f.rects['.cat-item'].forEach((item, i) => { item.top = 40 + i * 50 - 392 })
  f.flush()
  assert.equal(f.page.data.sidebarScrollTop, 392)
  f.page._clearTimers()
})

test('measurement reveals an active category if its previous sidebar item cache was unavailable', () => {
  const f = activeSidebar(20, 320)
  f.page._sidebarItems = []
  f.page.onCartHeight({ detail: { px: 72 } })
  assert.equal(f.page.data.sidebarScrollTop, 320)
  f.flush()
  assert.equal(f.page.data.sidebarScrollTop, 392)
  f.page._clearTimers()
})

test('viewport shrink reveals the active category while a visible manual position stays put', () => {
  const f = activeSidebar(20, 320)
  f.setWindowHeight(600)
  f.page.onResize(); f.flush()
  assert.equal(f.page.data.sidebarHeight, 560)
  assert.equal(f.page.data.sidebarScrollTop, 440)
  f.page._clearTimers()

  const g = activeSidebar(5, 100)
  g.page.onCartHeight({ detail: { px: 72 } }); g.flush()
  assert.equal(g.page.data.sidebarScrollTop, 100, 'visible selection must not interrupt manual sidebar browsing')
  g.page._clearTimers()
})

test('current search success while hidden finishes and is available on return', async () => {
  const f = fixture()
  let finish
  let requests = 0
  const api = require('../../apps/miniapp/api/catalog')
  api.getProducts = () => { requests++; return new Promise(resolve => { finish = resolve }) }
  f.page.setData({ searchKeyword: 'A', page: 1, hasMore: true })
  f.page.loadProducts(true)
  f.page.onHide()
  finish({ list: [{ id: 1, name: 'A', price: 100, stock: 1 }], total: 1 })
  await new Promise(r => setTimeout(r, 0))
  f.page.onShow(); f.flush()
  assert.equal(f.page.data.loading, false)
  assert.deepEqual(f.page.data.list.map(item => item.id), [1])
  f.page.onReachBottom()
  assert.equal(requests, 1)
  f.page._clearTimers()
})

test('current search rejection while hidden clears loading and can retry on return', async () => {
  const f = fixture()
  let fail
  let requests = 0
  const api = require('../../apps/miniapp/api/catalog')
  api.getProducts = () => {
    requests++
    return requests === 1 ? new Promise((resolve, reject) => { fail = reject }) : Promise.resolve({ list: [{ id: 2, name: 'B', price: 100, stock: 1 }], total: 1 })
  }
  f.page.setData({ searchKeyword: 'B', page: 1, hasMore: true })
  f.page.loadProducts(true)
  f.page.onHide()
  fail(new Error('offline'))
  await new Promise(r => setTimeout(r, 0))
  f.page.onShow(); f.flush()
  await new Promise(r => setTimeout(r, 0))
  f.flush()
  assert.equal(f.page.data.loading, false)
  assert.equal(requests, 2)
  assert.deepEqual(f.page.data.list.map(item => item.id), [2])
  f.page.onReachBottom()
  assert.equal(requests, 2)
  f.page._clearTimers()
})

test('short search auto fills and stops if a later page repeats the same products', async () => {
  const f = fixture()
  let calls = 0
  const api = require('../../apps/miniapp/api/catalog')
  api.getProducts = () => {
    calls++
    return Promise.resolve({ list: [{ id: 1, name: 'A', price: 100, stock: 1 }], total: 100 })
  }
  f.page.setData({ searchKeyword: 'A', page: 1, hasMore: true })
  f.page.loadProducts(true)
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 0))
    f.flush()
  }
  assert.equal(calls, 2)
  assert.deepEqual(f.page.data.list.map(item => item.id), [1])
  assert.equal(f.page.data.hasMore, false)
  f.page._clearTimers()
})
