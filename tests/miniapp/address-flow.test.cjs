// 地址流程的三条行为锁。
//
// 这条链路（结算页 → 地址列表 → 新增/编辑 → 回结算页）在同城下每一单都要走一次，
// 而它的三个坑各自都会让顾客卡住而看不出原因：
//   ① 新建完地址只 navigateBack，顾客回到结算页发现选的还是旧地址——他刚填的那个
//      没被选上，而页面不解释为什么；
//   ② 地图选点点了「取消」却把旧坐标清掉，顾客下一步被「该地址缺少定位」挡住；
//   ③ 导入微信地址只带回文字、**不带坐标**，旧坐标对不上新地址却仍被回传，
//      骑手会被派到上一个地址去。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

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
  registered.data = JSON.parse(JSON.stringify(registered.data))
  registered.setData = function (patch) {
    // 复刻小程序的路径式 setData（'form.detail' 这种），页面里用到了
    Object.keys(patch).forEach((k) => {
      if (k.indexOf('.') === -1) { registered.data[k] = patch[k]; return }
      const seg = k.split('.')
      let cur = registered.data
      for (let i = 0; i < seg.length - 1; i++) cur = cur[seg[i]]
      cur[seg[seg.length - 1]] = patch[k]
    })
  }
  registered.selectComponent = () => null
  return registered
}

function makeCtx(opts) {
  const o = opts || {}
  const nav = []
  const urls = []
  const app = {
    globalData: { shoppingChannel: 'LOCAL', selectedAddress: null },
    getShoppingChannel: () => app.globalData.shoppingChannel,
    setShoppingChannel: (v) => v,
    updateCartCount() {}, applyCartBadge() {},
  }
  const wx = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    request: (r) => {
      const u = r.url.replace(/^https?:\/\/[^/]+(\/api)?/, '')
      urls.push(r.method ? r.method + ' ' + u : 'GET ' + u)
      let body = {}
      if (/\/addresses/.test(u)) body = o.savedAddress || { id: 77, receiverName: '张女士', latE6: 29350000, lngE6: 104790000 }
      if (/\/local\/quote/.test(u)) body = { inRange: true, distanceM: 2400, fee: 600, estimatedMinutes: 36 }
      if (/\/local\/meta/.test(u)) body = { store: { latE6: 29339500, lngE6: 104778500 }, radiusStraightKm: 6 }
      r.success({ statusCode: 200, data: { code: 0, message: 'ok', data: body } })
    },
    navigateTo: (a) => { nav.push('navigateTo:' + a.url) },
    navigateBack: (a) => { nav.push('navigateBack:' + ((a && a.delta) || 1)) },
    switchTab: (a) => { nav.push('switchTab:' + a.url) },
    showToast: (a) => { nav.push('toast:' + a.title) },
    showModal: (a) => { nav.push('modal:' + a.title); if (o.modalConfirm && a.success) a.success({ confirm: true }) },
    chooseLocation: (a) => {
      nav.push('chooseLocation')
      if (o.locationCancel) { a.fail && a.fail({ errMsg: 'chooseLocation:fail cancel' }) }
      else if (a.success) a.success({ name: '新门口', address: '四川省自贡市自流井区新街 9 号', latitude: 29.36, longitude: 104.80 })
      a.complete && a.complete()
    },
    chooseAddress: (a) => {
      nav.push('chooseAddress')
      if (a.success) a.success({
        userName: '李先生', telNumber: '15900002210',
        provinceName: '四川省', cityName: '自贡市', countyName: '贡井区',
        detailInfo: '筱溪街 88 号',
      })
      a.complete && a.complete()
    },
    openSetting: () => {},
    setNavigationBarTitle: () => {},
    showNavigationBarLoading: () => {}, hideNavigationBarLoading: () => {},
  }
  return { app, wx, nav, urls }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

// ── ① 从结算页新增地址，保存后自动选中并回到结算页 ─────────────────────
test('结算页 → 新增地址 → 保存：自动选中新地址并直接回结算页', async function () {
  const saved = { id: 88, receiverName: '张女士', receiverPhone: '13866778899', latE6: 29360000, lngE6: 104800000 }
  const ctx = makeCtx({ savedAddress: saved })
  const page = loadPage('../../apps/miniapp/pages/address/edit.js', ctx)
  page.onLoad.call(page, { channel: 'LOCAL', returnTo: 'checkout' })
  // 填完表单 + 选过点
  page.setData({
    channel: 'LOCAL',
    region: ['四川省', '自贡市', '自流井区'],
    'form.receiverName': '张女士',
    'form.receiverPhone': '13866778899',
    'form.detail': '丹桂大街 12 号',
    latE6: 29360000, lngE6: 104800000,
    coordPickedThisSession: true,
  })
  page.onSave.call(page)
  await settle(); await settle()
  // 选中要**立刻**写入，不等跳转动画：它是已知的事实，没有理由拖到定时器里
  assert.deepEqual(ctx.app.globalData.selectedAddress, saved, '保存后必须把新地址交给结算页')
  await new Promise((r) => setTimeout(r, 900))
  // 页栈是 结算 → 列表 → 编辑，回两层才回得到结算页
  assert.ok(ctx.nav.includes('navigateBack:2'), '应直接回到结算页：' + ctx.nav.join(' '))
})

test('普通地址管理（非结算流程）保存后只回上一页，不写 selectedAddress', async function () {
  const ctx = makeCtx()
  const page = loadPage('../../apps/miniapp/pages/address/edit.js', ctx)
  page.onLoad.call(page, {})
  page.setData({
    region: ['四川省', '自贡市', '自流井区'],
    'form.receiverName': '张女士', 'form.receiverPhone': '13866778899', 'form.detail': '丹桂大街 12 号',
  })
  page.onSave.call(page)
  await settle(); await settle()
  assert.equal(ctx.app.globalData.selectedAddress, null, '地址管理不该顺手改结算页的选择')
  await new Promise((r) => setTimeout(r, 900))
  assert.ok(ctx.nav.includes('navigateBack:1'), ctx.nav.join(' '))
})

// ── ② 地图取消无副作用 ────────────────────────────────────────────
test('地图选点点「取消」：旧坐标原样保留，不清、不标过期', async function () {
  const ctx = makeCtx({ locationCancel: true })
  const page = loadPage('../../apps/miniapp/pages/address/edit.js', ctx)
  page.setData({
    channel: 'LOCAL', latE6: 29350000, lngE6: 104790000,
    poiName: '老门口', coordStale: false, locating: false,
  })
  page.onPickLocation.call(page)
  await settle()
  assert.equal(page.data.latE6, 29350000, '取消不该动坐标')
  assert.equal(page.data.lngE6, 104790000)
  assert.equal(page.data.poiName, '老门口')
  assert.equal(page.data.coordStale, false, '取消不该把坐标标成过期')
  assert.equal(page.data.locating, false, 'complete 要把按钮放开，否则再也点不动')
})

// ── ③ 导入微信地址只带文字，坐标必须作废 ──────────────────────────
test('导入微信收货地址：只带回联系人与文字，旧坐标立刻标为待确认', async function () {
  const ctx = makeCtx()
  const page = loadPage('../../apps/miniapp/pages/address/edit.js', ctx)
  page.setData({
    channel: 'LOCAL',
    region: ['四川省', '自贡市', '自流井区'],
    'form.detail': '丹桂大街 12 号',
    latE6: 29350000, lngE6: 104790000,
    coordSnapshotText: '四川省/自贡市/自流井区|丹桂大街 12 号',
    coordPickedThisSession: true,
  })
  page.onImportWechatAddress.call(page)
  assert.equal(page.data.form.receiverName, '李先生', '联系人要带回来')
  assert.equal(page.data.form.detail, '筱溪街 88 号', '文字地址要带回来')
  assert.equal(page.data.coordStale, true, '文字换了地方，旧坐标必须标为待确认')
  assert.equal(page.data.coordPickedThisSession, false,
    '导入不算「本次选过点」——否则 onSave 会把上一个地址的坐标当成新的一起提交')
})

test('导入后直接保存同城地址：被拦下要求重新选点，不静默提交旧坐标', async function () {
  const ctx = makeCtx()
  const page = loadPage('../../apps/miniapp/pages/address/edit.js', ctx)
  page.setData({
    channel: 'LOCAL',
    region: ['四川省', '自贡市', '自流井区'],
    'form.receiverName': '李先生', 'form.receiverPhone': '15900002210', 'form.detail': '丹桂大街 12 号',
    latE6: 29350000, lngE6: 104790000,
    coordSnapshotText: '四川省/自贡市/自流井区|丹桂大街 12 号',
    coordPickedThisSession: true,
  })
  page.onImportWechatAddress.call(page)
  page.onSave.call(page)
  await settle()
  assert.ok(ctx.nav.some((n) => n.indexOf('modal:') === 0), '应弹窗要求重新确认定位：' + ctx.nav.join(' '))
  assert.ok(!ctx.urls.some((u) => u.indexOf('POST /addresses') === 0), '不该带着旧坐标提交')
})

// ── ④ 匿名报价走统一 API 包装层 ─────────────────────────────────────
test('地址编辑页的报价条走 api/local，不再直连 wx.request 拼 baseURL', function () {
  const raw = require('node:fs').readFileSync(
    path.join(__dirname, '../../apps/miniapp/pages/address/edit.js'), 'utf8')
  // 先剥注释再扫：解释「为什么不再直连 wx.request」的那段注释本身就该留着，
  // 连注释一起扫会逼人把有用的说明删掉来讨好测试。
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(src.indexOf('wx.request') === -1, 'edit.js 不应再直连 wx.request')
  assert.ok(src.indexOf('baseURL') === -1, 'edit.js 不应再自己拼 baseURL')
  assert.ok(src.indexOf('quoteLocalByLocation') !== -1, '应走 api/local 的包装')

  const localApi = require('../../apps/miniapp/api/local')
  assert.equal(typeof localApi.quoteLocalByLocation, 'function')
})

test('匿名报价失败只收起报价条，不弹全局 toast（顾客正在填地址，不该被打断）', async function () {
  const ctx = makeCtx()
  ctx.wx.request = (r) => {
    r.success({ statusCode: 500, data: { code: 50001, message: '系统开小差了', data: null } })
  }
  const page = loadPage('../../apps/miniapp/pages/address/edit.js', ctx)
  page.setData({ channel: 'LOCAL', latE6: 29350000, lngE6: 104790000, quoteText: '旧的报价文案' })
  page.refreshQuote.call(page)
  await settle(); await settle()
  assert.equal(page.data.quoteText, '', '失败要把旧报价收起来，不能留一个过期的数字')
  assert.ok(!ctx.nav.some((n) => n.indexOf('toast:') === 0), '不该弹 toast：' + ctx.nav.join(' '))
})
