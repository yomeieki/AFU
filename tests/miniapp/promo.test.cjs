const test = require('node:test')
const assert = require('node:assert/strict')
const payPath = '../../apps/miniapp/utils/checkout-pay'
const promoPath = '../../apps/miniapp/utils/promo'
const pickup = require('../../apps/miniapp/utils/pickup-checkout-state')
const preview = { active: true, discountFen: 2000, nextTierGapFen: null }
const local = { deliveryType: 'LOCAL', subtotal: 7000, freeShipTiers: [{ minAmountFen: 9900, maxKm: 5 }], radiusKm: 5 }
const cases = [
  ['同城', { subtotal: 6000, promoFen: 500, shippingFee: 600 }, 6100],
  ['自取', { subtotal: 6000, pickupDiscount: 300, promoFen: 500 }, 5200],
  ['邮寄', { subtotal: 6000, promoFen: 500, shippingFee: 0 }, 5500],
  ['券叠加封顶且费用不减', { subtotal: 6000, promoFen: 500, couponDiscount: 6000, shippingFee: 600, packingFee: 200 }, 800],
  ['满减挤压', { subtotal: 1000, pickupDiscount: 800, promoFen: 500 }, 0],
]
cases.forEach(([name, input, expected]) => test('composePay ' + name, () => {
  const r = require(payPath).composePay(input)
  assert.equal(r.payAmount, expected)
  if (name === '满减挤压') assert.equal(r.promoDiscount, 200)
  if (input.couponDiscount) assert.equal(r.couponDiscount, 5500)
}))
test('promoFen=0 与三个渠道旧公式逐分一致', () => {
  const composePay = require(payPath).composePay
  assert.equal(composePay({ subtotal: 6000, couponDiscount: 500, shippingFee: 600, packingFee: 200 }).payAmount, 6300)
  assert.equal(composePay({ subtotal: 6000, pickupDiscount: 300, couponDiscount: 500, packingFee: 200, promoFen: 0 }).payAmount, 5400)
  assert.equal(composePay({ subtotal: 6000, couponDiscount: 500, shippingFee: 600, promoFen: 0 }).payAmount, 6100)
})
test('自取五参数组合满减，旧四参数形状不变', () => {
  assert.equal(pickup.computePickupPay(6000, { type: 'PERCENT', value: 95 }, 6000, 200, 500).promoDiscount, 500)
  assert.equal(pickup.computePickupPay(6000, { type: 'PERCENT', value: 95 }, 6000, 200, 500).couponDiscount, 5200)
})
test('自取满减失败提供重新计算动作', () => {
  const r = pickup.pickupCheckoutAction({ hasSlot: true, phoneValid: true, promoError: true, payAmount: null })
  assert.deepEqual(r, { disabled: false, text: '重新计算优惠', amountState: 'pending', action: 'promo' })
})
test('未达满减门槛', () => {
  assert.deepEqual(require(promoPath).progressTipOf({ active: true, discountFen: 0, nextTierGapFen: 13100, nextTierCutFen: 2000 }, local), { show: true, text: '再买 ¥131 减 ¥20', tone: 'hint' })
})
test('已满减未免运和已免运', () => {
  const tip = require(promoPath).progressTipOf
  assert.deepEqual(tip(preview, local), { show: true, text: '已减 ¥20 · 再买 ¥29 免运费', tone: 'hint' })
  assert.deepEqual(tip(preview, { ...local, subtotal: 9900 }), { show: true, text: '已减 ¥20 · 已免运费', tone: 'done' })
})
test('免运金额和范围随后台配置变化，已达档选最大范围', () => {
  const tip = require(promoPath).progressTipOf
  assert.equal(tip(preview, { ...local, radiusKm: 8 }).text, '已减 ¥20 · 再买 ¥29 免运费（5 km 内）')
  assert.equal(tip(preview, { ...local, subtotal: 10000, radiusKm: 8 }).text, '已减 ¥20 · 5 km 内免运费')
  assert.equal(tip(preview, { ...local, freeShipTiers: [{ minAmountFen: 12000, maxKm: 3 }], radiusKm: 8 }).text, '已减 ¥20 · 再买 ¥50 免运费（3 km 内）')
  assert.equal(tip(preview, { ...local, subtotal: 15000, radiusKm: 8, freeShipTiers: [{ minAmountFen: 12000, maxKm: 3 }, { minAmountFen: 9900, maxKm: 8 }] }).text, '已减 ¥20 · 已免运费')
})
test('关活动隐藏，自取与邮寄不出免运段，下一档按服务端响应', () => {
  const tip = require(promoPath).progressTipOf
  assert.equal(tip({ ...preview, active: false }, local).show, false)
  assert.equal(tip(null, local).show, false)
  assert.equal(tip({ active: true, discountFen: 0 }, local).show, false)
  for (const deliveryType of ['PICKUP', 'EXPRESS']) {
    assert.equal(tip(preview, { ...local, deliveryType }).text, '已减 ¥20')
    assert.equal(tip({ ...preview, nextTierGapFen: 3000, nextTierCutFen: 3000 }, { ...local, deliveryType }).text, '已减 ¥20 · 再买 ¥30 可减 ¥30')
  }
})
test('活动条显隐、排序、两档截断，详情保留全部档', () => {
  const bar = require(promoPath).promoBarOf
  const p = { active: true, name: '秋日优惠', channels: { LOCAL: true, PICKUP: false }, tiers: [{ minFen: 30000, cutFen: 4000 }, { minFen: 10000, cutFen: 1000 }, { minFen: 20000, cutFen: 2500 }] }
  assert.equal(bar(null, 'LOCAL').show, false)
  assert.equal(bar({ ...p, active: false }, 'LOCAL').show, false)
  assert.equal(bar(p, 'PICKUP').show, false)
  assert.equal(bar({ ...p, tiers: [] }, 'LOCAL').show, false)
  const r = bar(p, 'LOCAL')
  assert.equal(r.show, true)
  assert.equal(r.name, '秋日优惠')
  assert.equal(r.summary, '满 100 减 10 · 满 200 减 25 …')
  assert.deepEqual(r.detailLines, ['满 ¥100 减 ¥10', '满 ¥200 减 ¥25', '满 ¥300 减 ¥40', '与优惠券可叠加；运费、打包费不参与'])
})
test('渠道按邮寄/自取/外送映射', () => {
  const p = require(promoPath)
  assert.equal(p.promoTypeOf('EXPRESS', 'PICKUP'), 'EXPRESS')
  assert.equal(p.promoTypeOf('LOCAL', 'PICKUP'), 'PICKUP')
  assert.equal(p.promoTypeOf('LOCAL', 'DELIVERY'), 'LOCAL')
})
// 运行真实组件方法，只替换微信宿主和网络边界，验证渠道/异步响应隔离。
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
function cartComponent(getCart, getPromoPreview) {
  let config
  const events = []
  const file = path.resolve(__dirname, '../../apps/miniapp/components/local-cart-bar/index.js')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: name => name === '../../api/cart' ? { getCart } : name === '../../api/local' ? { getPromoPreview } : require(path.resolve(path.dirname(file), name)),
    Component: c => { config = c }, wx: { nextTick: fn => fn(), navigateTo: e => events.push(e) },
  })
  const c = { data: structuredClone(config.data), properties: { channel: 'EXPRESS', mode: 'DELIVERY', meta: null, promotion: null },
    setData(p, cb) { Object.assign(this.data, p); if (cb) cb() }, triggerEvent(name, value) { events.push({ name, value }) }, ...config.methods }
  return { c, events, config }
}
test('邮寄条只统计勾选件数小计并只传勾选行去结算', async () => {
  const { c, events } = cartComponent(async () => ({ items: [
    { id: 1, quantity: 2, subtotal: 6000, price: 3000, isSelected: 1 },
    { id: 2, quantity: 9, subtotal: 9000, price: 1000, isSelected: 0 },
  ] }), async () => ({ active: false, discountFen: 0 }))
  await c.refresh()
  assert.equal(c.data.count, 2)
  assert.equal(c.data.amount, 6000)
  assert.equal(c.data.actionText, '去结算 · 邮寄')
  c.goCheckout()
  assert.equal(events.at(-1).url, '/pages/order/confirm?cartItemIds=1')
})
test('清空购物车使在途满减响应失效，错误响应隐藏提示', async () => {
  let resolve
  const { c } = cartComponent(async () => ({ items: [] }), () => new Promise(r => { resolve = r }))
  c.data.count = 2; c.data.amount = 6000
  const pending = c.loadPromo()
  c.data.count = 0
  await c.loadPromo()
  resolve({ active: true, discountFen: 500 })
  await pending
  assert.equal(c.data.promoFen, 0)
  assert.equal(c.data.tip.show, false)
})
function checkoutPage(name, apis = {}) {
  let config
  const file = path.resolve(__dirname, '../../apps/miniapp/pages/' + name + '.js')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: dep => dep.startsWith('../../api/') ? (apis[dep.slice(10)] || {}) : dep === '../../utils/request' ? {} : dep === '../../utils/subscribe' ? {} : require(path.resolve(path.dirname(file), dep)),
    Page: c => { config = c }, getApp: () => ({ globalData: {} }), wx: {}, console,
  })
  config.data = structuredClone(config.data)
  config.setData = function(p) { Object.assign(this.data, p) }
  return config
}
test('真实外送与邮寄页面组合报价满减、券封顶及费用', () => {
  const l = checkoutPage('local/confirm')
  l.setData({ quoteToken: 'token', quote: { fee: 600 }, subtotal: 6000, promoFen: 500, discount: 6000, packingFee: 200 })
  l.syncPayAmount()
  assert.equal(l.data.payAmount, 800)
  assert.equal(l.data.couponDiscount, 5500)
  assert.equal(l.data.totalCut, 6000)
  const e = checkoutPage('order/confirm')
  e.setData({ totalAmount: 6000, promoFen: 500, discount: 500, shippingFee: 600 })
  e.recalcPay()
  assert.equal(e.data.payAmount, 5600)
  assert.equal(e.data.promoDiscount, 500)
})
test('自取满减请求在途不可提交，失败可重试，旧响应不能覆盖新结果', async () => {
  const pending = []
  const p = checkoutPage('local/pickup', { local: { getPromoPreview: (type, amount) => new Promise((resolve, reject) => pending.push({ resolve, reject, type, amount })) } })
  p.setData({ items: [{ quantity: 2, packingFeeEach: 100 }], subtotal: 6000, discountRule: { type: 'PERCENT', value: 95 }, discount: 500, selected: { startAt: 'slot' }, hasAnySlot: true, slotsLoading: false, contactPhone: '13800009901', tableware: { mode: 'NONE' } })
  const first = p.loadPromo()
  assert.equal(p.data.payAmount, null)
  assert.equal(p.data.action.disabled, true)
  const second = p.loadPromo()
  pending[1].reject(new Error('network'))
  await second
  assert.equal(p.data.action.action, 'promo')
  assert.equal(p.data.action.disabled, false)
  pending[0].resolve({ active: true, discountFen: 999 })
  await first
  assert.equal(p.data.promoState, 'error')
  const third = p.loadPromo()
  pending[2].resolve({ active: true, discountFen: 500 })
  await third
  assert.equal(p.data.payAmount, 4900)
  assert.equal(p.data.totalCut, 1300)
  assert.equal(p.data.action.action, 'submit')
})
test('自取活动关闭不请求、清旧满减并恢复旧金额', async () => {
  const p = checkoutPage('local/pickup', { local: { getPromoPreview: () => { throw new Error('must not request') } } })
  p.setData({ items: [{ quantity: 2, packingFeeEach: 100 }], subtotal: 6000, promoFen: 500, meta: { promotion: { active: false } }, discountRule: { type: 'PERCENT', value: 95 }, discount: 500 })
  await p.loadPromo()
  assert.equal(p.data.promoFen, 0)
  assert.equal(p.data.promoState, 'ready')
  assert.equal(p.data.payAmount, 5400)
})
test('优惠券显示随其它优惠封顶，并在取消满减后恢复原抵扣额', () => {
  let config, last
  const file = path.resolve(__dirname, '../../apps/miniapp/components/checkout-benefits/index.js')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: () => ({}), Component: c => { config = c } })
  const c = { data: { ...structuredClone(config.data), state: 'ready', subtotal: 6000, coupons: [{ id: 1, usable: true, discount: 6000 }], selectedCouponId: 1 },
    properties: { otherDiscount: 800, shippingFee: 600 }, setData(p) { Object.assign(this.data, p) }, triggerEvent(n, d) { last = d }, ...config.methods }
  c._emit()
  assert.equal(c.data.discount, 5200)
  assert.equal(last.discount, 5200)
  c.properties.otherDiscount = 0
  config.observers.otherDiscount.call(c)
  assert.equal(c.data.discount, 6000)
})
test('父页仅在其它优惠变化时传值，避免组件回传导致递归重算', () => {
  for (const name of ['local/confirm', 'local/pickup', 'order/confirm']) {
    const p = checkoutPage(name)
    const patches = []
    p.setData({ subtotal: 6000, totalAmount: 6000, promoFen: 500, promoState: 'ready', quoteToken: 'token', quote: { fee: 600 }, items: [{ quantity: 2 }], discountRule: { type: 'PERCENT', value: 95 } })
    p.setData = function(v) { patches.push(v); Object.assign(this.data, v) }
    const recompute = p.syncPayAmount || p.recalcPay || p.recompute
    recompute.call(p)
    assert.equal(p.data.otherDiscount, name === 'local/pickup' ? 800 : 500)
    patches.length = 0
    recompute.call(p)
    assert.equal(patches.some(v => Object.hasOwn(v, 'otherDiscount')), false)
  }
})
