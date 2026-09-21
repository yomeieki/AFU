const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const vm = require('node:vm')
const promoPath = '../../apps/miniapp/utils/promo'

const read = p => fs.readFileSync(path.join(__dirname, '../../apps/miniapp', p), 'utf8')

// 线上配置：五档免运费，radius 8 km
const liveTiers = [
  { minAmountFen: 5800, maxKm: 2 },
  { minAmountFen: 8800, maxKm: 3 },
  { minAmountFen: 12800, maxKm: 4 },
  { minAmountFen: 16800, maxKm: 5 },
  { minAmountFen: 19800, maxKm: 7 },
]
const liveMeta = { radiusKm: 8, fee: { freeShipTiers: liveTiers } }

test('yuanShort 去末尾零，有分显两位', () => {
  const { yuanShort } = require(promoPath)
  assert.equal(yuanShort(660), '6.6')
  assert.equal(yuanShort(3800), '38')
  assert.equal(yuanShort(450), '4.5')
  assert.equal(yuanShort(3705), '37.05')
  assert.equal(yuanShort(1080), '10.8')
})

test('freeShipBarOf 线上五档：摘要与详情', () => {
  const { freeShipBarOf } = require(promoPath)
  const bar = freeShipBarOf(liveMeta, 'LOCAL')
  assert.deepEqual(bar, {
    show: true,
    badge: '免',
    name: '免运费',
    summary: '满 ¥58 免运费（2 km 内）· 多买免更远',
    detailLines: [
      '满 ¥58 免运费（2 km 内）',
      '满 ¥88 免运费（3 km 内）',
      '满 ¥128 免运费（4 km 内）',
      '满 ¥168 免运费（5 km 内）',
      '满 ¥198 免运费（7 km 内）',
      '按下单地址到门店的距离判断；配送范围 8 km',
    ],
  })
})

test('freeShipBarOf 档位乱序输入，摘要仍取最低金额档', () => {
  const { freeShipBarOf } = require(promoPath)
  const shuffled = [liveTiers[3], liveTiers[0], liveTiers[4], liveTiers[1], liveTiers[2]]
  const bar = freeShipBarOf({ radiusKm: 8, fee: { freeShipTiers: shuffled } }, 'LOCAL')
  assert.equal(bar.summary, '满 ¥58 免运费（2 km 内）· 多买免更远')
  assert.equal(bar.detailLines[0], '满 ¥58 免运费（2 km 内）')
})

test('freeShipBarOf 隐藏场景：无档 / 无 meta / 无 fee / 非 LOCAL', () => {
  const { freeShipBarOf } = require(promoPath)
  const hidden = { show: false, badge: '', name: '', summary: '', detailLines: [] }
  assert.deepEqual(freeShipBarOf({ radiusKm: 8, fee: { freeShipTiers: [] } }, 'LOCAL'), hidden)
  assert.deepEqual(freeShipBarOf(null, 'LOCAL'), hidden)
  assert.deepEqual(freeShipBarOf({ radiusKm: 8 }, 'LOCAL'), hidden)
  assert.deepEqual(freeShipBarOf(liveMeta, 'PICKUP'), hidden)
  assert.deepEqual(freeShipBarOf(liveMeta, 'EXPRESS'), hidden)
})

test('freeShipBarOf 单档不带距离、不带"多买免更远"', () => {
  const { freeShipBarOf } = require(promoPath)
  const bar = freeShipBarOf({ radiusKm: 5, fee: { freeShipTiers: [{ minAmountFen: 9900, maxKm: 5 }] } }, 'LOCAL')
  assert.equal(bar.summary, '满 ¥99 免运费')
  assert.equal(bar.detailLines.length, 2)
})

test('freeShipBarOf maxKm >= radiusKm 的档不带距离', () => {
  const { freeShipBarOf } = require(promoPath)
  const bar = freeShipBarOf({ radiusKm: 8, fee: { freeShipTiers: [{ minAmountFen: 5800, maxKm: 2 }, { minAmountFen: 9900, maxKm: 8 }] } }, 'LOCAL')
  assert.equal(bar.detailLines[1], '满 ¥99 免运费')
})

test('progressTipOf 满减关闭/未命中：S1/S2/S3 三态，三种输入各覆盖一次', () => {
  const { progressTipOf } = require(promoPath)
  const closedInputs = [null, { active: false }, { active: true, discountFen: 0 }]
  closedInputs.forEach(preview => {
    const opts = { deliveryType: 'LOCAL', freeShipTiers: liveTiers, radiusKm: 8, subtotal: 3800 }
    assert.deepEqual(progressTipOf(preview, opts), { show: true, text: '再买 ¥20 免运费（2 km 内）', tone: 'hint' })
    assert.deepEqual(progressTipOf(preview, { ...opts, subtotal: 5800 }), { show: true, text: '2 km 内免运费 · 再买 ¥30 免 3 km 内运费', tone: 'hint' })
    assert.deepEqual(progressTipOf(preview, { ...opts, subtotal: 19800 }), { show: true, text: '7 km 内免运费', tone: 'done' })
  })
})

test('progressTipOf 满减关闭：单档 radius 等于 maxKm 时已免运费', () => {
  const { progressTipOf } = require(promoPath)
  const opts = { deliveryType: 'LOCAL', freeShipTiers: [{ minAmountFen: 9900, maxKm: 5 }], radiusKm: 5, subtotal: 9900 }
  assert.deepEqual(progressTipOf(null, opts), { show: true, text: '已免运费', tone: 'done' })
})

test('progressTipOf 满减关闭：PICKUP/EXPRESS 或无档 → hidden', () => {
  const { progressTipOf } = require(promoPath)
  const hidden = { show: false, text: '', tone: 'hint' }
  const opts = { deliveryType: 'LOCAL', freeShipTiers: liveTiers, radiusKm: 8, subtotal: 3800 }
  assert.deepEqual(progressTipOf(null, { ...opts, deliveryType: 'PICKUP' }), hidden)
  assert.deepEqual(progressTipOf(null, { ...opts, deliveryType: 'EXPRESS' }), hidden)
  assert.deepEqual(progressTipOf(null, { ...opts, freeShipTiers: [] }), hidden)
  assert.deepEqual(progressTipOf({ active: false }, { ...opts, freeShipTiers: [] }), hidden)
})

test('progressTipOf 满减开着未达档：追加免运费第二段（统筹裁定 Q1）', () => {
  const { progressTipOf } = require(promoPath)
  const opts = { deliveryType: 'LOCAL', freeShipTiers: [{ minAmountFen: 9900, maxKm: 5 }], radiusKm: 5, subtotal: 7000 }
  assert.deepEqual(
    progressTipOf({ active: true, discountFen: 0, nextTierGapFen: 13100, nextTierCutFen: 2000 }, opts),
    { show: true, text: '再买 ¥131 减 ¥20 · 再买 ¥29 免运费', tone: 'hint' }
  )
})

test('progressTipOf 满减开着未达档：非 LOCAL 不追加免运段', () => {
  const { progressTipOf } = require(promoPath)
  const opts = { deliveryType: 'PICKUP', freeShipTiers: [{ minAmountFen: 9900, maxKm: 5 }], radiusKm: 5, subtotal: 7000 }
  assert.deepEqual(
    progressTipOf({ active: true, discountFen: 0, nextTierGapFen: 13100, nextTierCutFen: 2000 }, opts),
    { show: true, text: '再买 ¥131 减 ¥20', tone: 'hint' }
  )
})

// 回归：满减开着「已减」两态（tests/miniapp/promo.test.cjs:38-49）逐字不变
test('回归：满减开着已减未免运/已免运/自取邮寄不出免运段，文案逐字不变', () => {
  const { progressTipOf } = require(promoPath)
  const preview = { active: true, discountFen: 2000, nextTierGapFen: null }
  const local = { deliveryType: 'LOCAL', subtotal: 7000, freeShipTiers: [{ minAmountFen: 9900, maxKm: 5 }], radiusKm: 5 }
  assert.deepEqual(progressTipOf(preview, local), { show: true, text: '已减 ¥20 · 再买 ¥29 免运费', tone: 'hint' })
  assert.deepEqual(progressTipOf(preview, { ...local, subtotal: 9900 }), { show: true, text: '已减 ¥20 · 已免运费', tone: 'done' })
  assert.equal(progressTipOf(preview, { ...local, radiusKm: 8 }).text, '已减 ¥20 · 再买 ¥29 免运费（5 km 内）')
  assert.equal(progressTipOf(preview, { ...local, subtotal: 10000, radiusKm: 8 }).text, '已减 ¥20 · 5 km 内免运费')
  for (const deliveryType of ['PICKUP', 'EXPRESS']) {
    assert.equal(progressTipOf(preview, { ...local, deliveryType }).text, '已减 ¥20')
    assert.equal(progressTipOf({ ...preview, nextTierGapFen: 3000, nextTierCutFen: 3000 }, { ...local, deliveryType }).text, '已减 ¥20 · 再买 ¥30 可减 ¥30')
  }
})

// 组件：node:vm 里加载真实 components/promo-bar/index.js（仿 promo.test.cjs:83-94 的先例）
function promoBarComponent() {
  let config
  const file = path.resolve(__dirname, '../../apps/miniapp/components/promo-bar/index.js')
  const showModalCalls = []
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: name => require(path.resolve(path.dirname(file), name)),
    Component: c => { config = c },
    wx: { showModal: opts => showModalCalls.push(opts) },
  })
  const c = Object.assign({ data: structuredClone(config.data), properties: {}, setData(p) { Object.assign(this.data, p) } }, config.methods)
  return { c, config, showModalCalls }
}

test('promo-bar 组件：kind=freeship 走 freeShipBarOf，deliveryType 非 LOCAL 隐藏', () => {
  const { c, config, showModalCalls } = promoBarComponent()
  c.properties = { kind: 'freeship', meta: liveMeta, promotion: null, deliveryType: 'LOCAL' }
  config.observers['kind, promotion, meta, deliveryType'].call(c)
  assert.equal(c.data.bar.show, true)
  assert.equal(c.data.bar.badge, '免')
  c.onTapDetail()
  assert.equal(showModalCalls.length, 1)
  assert.equal(showModalCalls[0].title, '免运费')
  assert.equal(showModalCalls[0].content, c.data.bar.detailLines.join('\n'))
  assert.equal(showModalCalls[0].showCancel, false)
  assert.equal(showModalCalls[0].confirmText, '知道了')

  c.properties = { kind: 'freeship', meta: liveMeta, promotion: null, deliveryType: 'PICKUP' }
  config.observers['kind, promotion, meta, deliveryType'].call(c)
  assert.equal(c.data.bar.show, false)
})

test('promo-bar 组件：默认 kind 走 promoBarOf，badge 为「减」', () => {
  const { c, config } = promoBarComponent()
  const promotion = { active: true, name: '国庆满减', channels: {}, tiers: [{ minFen: 5000, cutFen: 500 }] }
  c.properties = { kind: 'promo', promotion, meta: null, deliveryType: 'LOCAL' }
  config.observers['kind, promotion, meta, deliveryType'].call(c)
  assert.equal(c.data.bar.show, true)
  assert.equal(c.data.bar.badge, '减')
})

// 源码级：两页各恰好一个免运费 promo-bar 标签，位置在满减条之后、模式栏之前
test('两页 wxml 各恰好一个 kind="freeship" 的 promo-bar，且位置正确', () => {
  const indexWxml = read('pages/index/index.wxml')
  const listWxml = read('pages/product/list.wxml')
  const re = /<promo-bar\b[^>]*kind="freeship"[^>]*\/>/g
  for (const wxml of [indexWxml, listWxml]) {
    const matches = wxml.match(re)
    assert.equal(matches && matches.length, 1)
    const tag = matches[0]
    assert.match(tag, /meta="\{\{meta\}\}"/)
    assert.match(tag, /delivery-type="\{\{promoType\}\}"/)
    assert.doesNotMatch(tag, /wx:if/)
    assert.doesNotMatch(tag, /wx:elif/)
  }
  const firstPromoIdx = indexWxml.indexOf('<promo-bar')
  const freeshipIdxIndex = indexWxml.indexOf('<promo-bar kind="freeship"')
  const modeBarIdx = indexWxml.indexOf('<local-mode-bar')
  assert.ok(firstPromoIdx > -1 && firstPromoIdx < freeshipIdxIndex)
  assert.ok(freeshipIdxIndex < modeBarIdx)

  const firstPromoIdxList = listWxml.indexOf('<promo-bar')
  const freeshipIdxList = listWxml.indexOf('<promo-bar kind="freeship"')
  const modeBarIdxList = listWxml.indexOf('<local-mode-bar')
  assert.ok(firstPromoIdxList > -1 && firstPromoIdxList < freeshipIdxList)
  assert.ok(freeshipIdxList < modeBarIdxList)
})

test('components/promo-bar/index.wxml 角标用 {{bar.badge}}，不再写死「减」', () => {
  const wxml = read('components/promo-bar/index.wxml')
  assert.match(wxml, /\{\{bar\.badge\}\}/)
  assert.doesNotMatch(wxml, />减</)
})
