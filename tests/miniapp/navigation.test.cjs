// 封面两个渠道入口的行为锁。
//
// 锁的是**顺序**而不只是终点：必须「先过位置许可 → 再定渠道 → 最后才跳」。
// 顺序错了各有各的坏法——
//   先跳后定渠道：主页 onShow 已经按旧渠道拉过一轮数据，顾客会看到上一个渠道的商品闪一下；
//   不过位置许可就进同城：顾客一路选完菜、到地图选点那一步才被拦，前面全白填。
//
// 这里用一个极轻的 Page/wx 桩把页面模块加载起来，不依赖微信开发者工具。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

/** 加载一个小程序页面模块，返回它注册给 Page() 的那个对象。 */
function loadPage(relPath, ctx) {
  const abs = require.resolve(relPath)
  delete require.cache[abs]
  // config/*.js 这类被页面 require 的模块也要清，否则跨用例复用旧闭包
  Object.keys(require.cache)
    .filter((k) => k.includes(path.join('apps', 'miniapp')))
    .forEach((k) => delete require.cache[k])
  let registered = null
  global.Page = (o) => { registered = o }
  global.Component = (o) => { registered = o }
  global.getApp = () => ctx.app
  global.wx = ctx.wx
  require(relPath)
  // 页面真身由 Page() 接管 setData；这里补一个桩，免得页面因为「桩不全」而不是
  // 因为真实行为而红——那种红会把注意力引到错的地方。
  if (registered && typeof registered.setData !== 'function') {
    registered.data = Object.assign({}, registered.data)
    registered.setData = function (patch) { Object.assign(registered.data, patch) }
  }
  return registered
}

/** 记录调用顺序的桩：app 与 wx 的每一次动作都往同一个数组里追加一条。 */
function makeCtx(opts) {
  const calls = []
  const app = {
    globalData: { shoppingChannel: 'EXPRESS' },
    ensurePrivacyAuthorize() {
      calls.push('privacy')
      return (opts && opts.privacyDenied) ? Promise.reject(new Error('denied')) : Promise.resolve()
    },
    setShoppingChannel(v) { calls.push('setChannel:' + v); app.globalData.shoppingChannel = v; return v },
    getShoppingChannel() { return app.globalData.shoppingChannel },
    enterLocalChannel() {
      // 真实实现在 app.js；这里的桩只记录「页面确实走了这条统一出口」
      calls.push('enterLocal')
      return Promise.resolve()
    },
    updateCartCount() {},
  }
  const wx = {
    switchTab: (o) => { calls.push('switchTab:' + o.url); o.success && o.success() },
    navigateTo: (o) => { calls.push('navigateTo:' + o.url); o.success && o.success() },
    showToast: (o) => { calls.push('toast:' + o.title) },
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
    getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
    getMenuButtonBoundingClientRect: () => ({ bottom: 80 }),
    getStorageSync: () => '',
    setStorageSync: () => {},
    reLaunch: (o) => { calls.push('reLaunch:' + o.url) },
  }
  return { app, wx, calls }
}

const tap = (page, id) => page.onTapEntry.call(page, { currentTarget: { dataset: { id } } })
const tick = () => new Promise((r) => setImmediate(r))

test('封面点「同城配送」：走统一出口，不自己 navigateTo', async function () {
  const ctx = makeCtx()
  const page = loadPage('../../apps/miniapp/pages/cover/index.js', ctx)
  tap(page, 'local_delivery')
  await tick(); await tick()
  assert.deepEqual(ctx.calls, ['enterLocal'])
})

test('封面点「全国邮寄」：显式定渠道 EXPRESS 再进主页（不能靠上一次的残留值）', async function () {
  const ctx = makeCtx()
  ctx.app.globalData.shoppingChannel = 'LOCAL'   // 上一次会话停在同城
  const page = loadPage('../../apps/miniapp/pages/cover/index.js', ctx)
  tap(page, 'nationwide_shipping')
  await tick(); await tick()
  assert.deepEqual(ctx.calls, ['setChannel:EXPRESS', 'switchTab:/pages/index/index'])
  assert.equal(ctx.app.globalData.shoppingChannel, 'EXPRESS')
})


test('「全国冷链配送」与「全国邮寄」落到同一个渠道与同一个页面', async function () {
  const ctx = makeCtx()
  const page = loadPage('../../apps/miniapp/pages/cover/index.js', ctx)
  tap(page, 'cold_chain')
  await tick(); await tick()
  assert.deepEqual(ctx.calls, ['setChannel:EXPRESS', 'switchTab:/pages/index/index'])
})

test('会员三个入口不碰渠道（它们与买什么无关）', async function () {
  for (const id of ['member_center', 'coupon', 'points_mall']) {
    const ctx = makeCtx()
    const page = loadPage('../../apps/miniapp/pages/cover/index.js', ctx)
    tap(page, id)
    await tick()
    assert.ok(!ctx.calls.some((c) => c.startsWith('setChannel')), id + ' 不应改变渠道')
    assert.ok(ctx.calls.some((c) => c.startsWith('navigateTo:/pages/member/')), id + ' 应进会员页')
  }
})

// 旧的 /pages/local/index 不再承载菜单，但必须留着：顾客手机里可能还压着旧版本的
// 页面栈，分享卡片与扫码进来的链接也指向它。白屏比慢一步糟糕得多。
test('旧同城路由退化成兼容跳转：定渠道后转共享主页', async function () {
  const ctx = makeCtx()
  const page = loadPage('../../apps/miniapp/pages/local/index.js', ctx)
  page.onLoad.call(page, {})
  await tick(); await tick()
  assert.deepEqual(ctx.calls, ['setChannel:LOCAL', 'switchTab:/pages/index/index'])
})

// 五个旧入口（购物车跨渠道提示 / 商品详情 / 会员商城 / 「我的」）此前各写一遍
// 「ensurePrivacyAuthorize → navigateTo」。任何一处漏改，顾客都会掉进一个
// 没有底部导航的孤岛页——正是这次要治的病。统一走 app.enterLocalChannel()。
test('四个旧同城入口统一走 app.enterLocalChannel()，不再各自 navigateTo', async function () {
  const cases = [
    ['../../apps/miniapp/pages/user/index.js', 'goLocal'],
    ['../../apps/miniapp/pages/cart/index.js', 'goLocal'],
    ['../../apps/miniapp/pages/product/detail.js', 'goLocalCheckout'],
  ]
  for (const [mod, fn] of cases) {
    const ctx = makeCtx()
    const page = loadPage(mod, ctx)
    assert.equal(typeof page[fn], 'function', mod + ' 应有 ' + fn)
    page[fn].call(page, { currentTarget: { dataset: {} } })
    await tick()
    assert.deepEqual(ctx.calls, ['enterLocal'], mod + ' 应只调 enterLocalChannel')
  }
})

test('会员商城「去下单」：同城走统一出口，邮寄定渠道后 switchTab', async function () {
  const ctxL = makeCtx()
  const mallL = loadPage('../../apps/miniapp/pages/member/mall.js', ctxL)
  mallL.data = Object.assign({}, mallL.data, { gifts: [{ isLocal: true }] })
  mallL.onGoOrder.call(mallL, { currentTarget: { dataset: { idx: 0 } } })
  await tick()
  assert.deepEqual(ctxL.calls, ['enterLocal'])

  const ctxE = makeCtx()
  const mallE = loadPage('../../apps/miniapp/pages/member/mall.js', ctxE)
  mallE.data = Object.assign({}, mallE.data, { gifts: [{ isLocal: false }] })
  mallE.onGoOrder.call(mallE, { currentTarget: { dataset: { idx: 0 } } })
  await tick()
  assert.deepEqual(ctxE.calls, ['setChannel:EXPRESS', 'switchTab:/pages/index/index'])
})

// ── app.enterLocalChannel() 的真身 ────────────────────────────────────────
// 上面各页只验「有没有走这条统一出口」；顺序与失败分支的行为在这里验。

function loadApp(opts) {
  const calls = []
  Object.keys(require.cache)
    .filter((k) => k.includes(path.join('apps', 'miniapp')))
    .forEach((k) => delete require.cache[k])
  let registered = null
  global.App = (o) => { registered = o }
  global.getApp = () => registered
  global.wx = {
    // 按 key 分发：整份都返回同一个值的话，token 也会被当成 'LOCAL'，
    // onLaunch 会拿它去当真实凭证，红在一个跟渠道无关的地方。
    getStorageSync: (k) => (k === 'shoppingChannel' ? ((opts && opts.storedChannel) || '') : ''),
    setStorageSync: (k, v) => { calls.push('storage:' + k + '=' + v) },
    requirePrivacyAuthorize: (o) => {
      calls.push('privacy')
      if (opts && opts.privacyDenied) o.fail(new Error('denied')); else o.success()
    },
    switchTab: (o) => {
      calls.push('switchTab:' + o.url)
      if (opts && opts.switchTabFails) o.fail && o.fail(new Error('nope'))
    },
    showToast: (o) => { calls.push('toast:' + o.title) },
    setTabBarBadge: () => {}, removeTabBarBadge: () => {},
    getSystemInfoSync: () => ({}), request: () => {},
  }
  global.getCurrentPages = () => []
  require('../../apps/miniapp/app.js')
  // updateCartCount 会发真实请求，这里换成记录调用即可——它的内容由别的用例覆盖
  registered.updateCartCount = () => { calls.push('updateCart:' + registered.globalData.shoppingChannel) }
  return { app: registered, calls }
}

test('enterLocalChannel：位置许可 → 定渠道 LOCAL → 刷角标 → switchTab，顺序不可换', async function () {
  const { app, calls } = loadApp()
  app.globalData.shoppingChannel = 'EXPRESS'
  await app.enterLocalChannel()
  assert.deepEqual(calls, [
    'privacy', 'storage:shoppingChannel=LOCAL', 'updateCart:LOCAL', 'switchTab:/pages/index/index',
  ])
})

test('enterLocalChannel：拒绝许可时不定渠道、不跳转，只给可见反馈', async function () {
  const { app, calls } = loadApp({ privacyDenied: true })
  app.globalData.shoppingChannel = 'EXPRESS'
  await app.enterLocalChannel()
  assert.deepEqual(calls, ['privacy', 'toast:需要同意位置许可才能使用同城配送'])
  assert.equal(app.globalData.shoppingChannel, 'EXPRESS', '被拒时渠道不能被改掉')
})

// 用两参数 then 而不是 .catch 的理由：否则 switchTab 的失败会掉进「拒绝许可」那条分支，
// 顾客点了同城、页面没开，却看到一句「需要同意位置许可」——指向完全错误的原因。
test('enterLocalChannel：跳转失败给的是跳转的错，不是「需要同意位置许可」', async function () {
  const { app, calls } = loadApp({ switchTabFails: true })
  await app.enterLocalChannel()
  assert.ok(calls.includes('toast:页面暂时打不开，请稍后再试'), '应给跳转失败的反馈：' + calls.join(','))
  assert.ok(!calls.some((c) => c.includes('位置许可')), '不能误报成许可问题')
})

test('setShoppingChannel：清掉待决分类意图（否则切回邮寄会去选一个同城分类）', function () {
  const { app } = loadApp()
  app.globalData.pendingCategoryId = 99
  app.globalData.pendingCategoryName = '凉菜'
  app.globalData.pendingCategoryAll = true
  app.setShoppingChannel('EXPRESS')
  assert.equal(app.globalData.pendingCategoryId, null)
  assert.equal(app.globalData.pendingCategoryName, null)
  assert.equal(app.globalData.pendingCategoryAll, false)
})

// 冷启动必须在**任何一次拉数据之前**把渠道恢复好——晚一步，第一屏就按错的渠道拉了。
test('冷启动 onLaunch 从 storage 恢复渠道；脏值回落 EXPRESS', function () {
  const boot = (stored) => {
    const h = loadApp({ storedChannel: stored })
    h.app._tryLogin = () => Promise.resolve()
    h.app.onLaunch()
    return h.app.globalData.shoppingChannel
  }
  assert.equal(boot('LOCAL'), 'LOCAL')
  assert.equal(boot('NOPE'), 'EXPRESS')
  assert.equal(boot(''), 'EXPRESS')
})
