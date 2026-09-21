const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const sheetPath = '../../apps/miniapp/components/promo-bar/sheet.js'
const promoPath = '../../apps/miniapp/utils/promo'

const read = p => fs.readFileSync(path.join(__dirname, '../../apps/miniapp', p), 'utf8')

// 线上配置：五档免运费，radius 8 km（与 tests/miniapp/freeship-bar.test.cjs 的 liveTiers 一致）
const liveTiers = [
  { minAmountFen: 5800, maxKm: 2 },
  { minAmountFen: 8800, maxKm: 3 },
  { minAmountFen: 12800, maxKm: 4 },
  { minAmountFen: 16800, maxKm: 5 },
  { minAmountFen: 19800, maxKm: 7 },
]
const liveMeta = { radiusKm: 8, fee: { freeShipTiers: liveTiers } }

test('sheetRowsOf 免运费五档：一档一行，距离字段独立', () => {
  const { sheetRowsOf } = require(sheetPath)
  const { rows, note } = sheetRowsOf('freeship', null, liveMeta)
  assert.equal(rows.length, 5)
  assert.deepEqual(rows[0], { left: '满 ¥58', right: '免运费 ', em: '2 km', tail: ' 内' })
  assert.deepEqual(rows[4], { left: '满 ¥198', right: '免运费 ', em: '7 km', tail: ' 内' })
  assert.match(note, /8 km/)
})

test('sheetRowsOf 免运费 maxKm >= radiusKm 的档不带距离', () => {
  const { sheetRowsOf } = require(sheetPath)
  const { rows } = sheetRowsOf('freeship', null, { radiusKm: 8, fee: { freeShipTiers: [{ minAmountFen: 5800, maxKm: 2 }, { minAmountFen: 9900, maxKm: 8 }] } })
  assert.deepEqual(rows[1], { left: '满 ¥99', right: '免运费', em: '', tail: '' })
})

test('sheetRowsOf 免运费 radiusKm 缺失：note 无「配送范围」', () => {
  const { sheetRowsOf } = require(sheetPath)
  const { note } = sheetRowsOf('freeship', null, { fee: { freeShipTiers: liveTiers } })
  assert.equal(note, '按下单地址到门店的距离判断')
  assert.doesNotMatch(note, /配送范围/)
})

test('sheetRowsOf 免运费档位乱序输入，按门槛升序排列', () => {
  const { sheetRowsOf } = require(sheetPath)
  const shuffled = [liveTiers[3], liveTiers[0], liveTiers[4], liveTiers[1], liveTiers[2]]
  const { rows } = sheetRowsOf('freeship', null, { radiusKm: 8, fee: { freeShipTiers: shuffled } })
  assert.deepEqual(rows.map(r => r.left), ['满 ¥58', '满 ¥88', '满 ¥128', '满 ¥168', '满 ¥198'])
})

test('sheetRowsOf 免运费 tiers 空 → rows 为空数组', () => {
  const { sheetRowsOf } = require(sheetPath)
  const { rows } = sheetRowsOf('freeship', null, { radiusKm: 8, fee: { freeShipTiers: [] } })
  assert.deepEqual(rows, [])
})

test('sheetRowsOf 满减两档：右列金额独立于品牌色文本节点', () => {
  const { sheetRowsOf } = require(sheetPath)
  const promotion = { active: true, name: '国庆满减', tiers: [{ minFen: 6600, cutFen: 660 }, { minFen: 10800, cutFen: 1080 }] }
  const { rows, note } = sheetRowsOf('promo', promotion, null)
  assert.deepEqual(rows[0], { left: '满 ¥66', right: '减 ', em: '¥6.6', tail: '' })
  assert.deepEqual(rows[1], { left: '满 ¥108', right: '减 ', em: '¥10.8', tail: '' })
  assert.equal(note, '与优惠券可叠加 · 运费、打包费不参与')
})

test('sheetRowsOf 满减档位乱序输入，按门槛升序排列', () => {
  const { sheetRowsOf } = require(sheetPath)
  const promotion = { tiers: [{ minFen: 30000, cutFen: 4000 }, { minFen: 10000, cutFen: 1000 }, { minFen: 20000, cutFen: 2500 }] }
  const { rows } = sheetRowsOf('promo', promotion, null)
  assert.deepEqual(rows.map(r => r.left), ['满 ¥100', '满 ¥200', '满 ¥300'])
})

test('sheetRowsOf 满减 tiers 空 → rows 为空数组', () => {
  const { sheetRowsOf } = require(sheetPath)
  const { rows } = sheetRowsOf('promo', { tiers: [] }, null)
  assert.deepEqual(rows, [])
})

// 一致性：对同一输入，行数据拼回的文本（去空格、去括号）与 promo.js 的 detailLines 去掉末行
// 逐档等价，钉住两处口径不漂移（见方案 §2）。
function stripped(s) {
  return s.replace(/[\s（）()]/g, '')
}
test('一致性：freeship 行数据与 promo.js detailLines 逐档等价（去空格/括号）', () => {
  const { sheetRowsOf } = require(sheetPath)
  const { freeShipBarOf } = require(promoPath)
  const { rows } = sheetRowsOf('freeship', null, liveMeta)
  const bar = freeShipBarOf(liveMeta, 'LOCAL')
  const detailRows = bar.detailLines.slice(0, -1)
  assert.equal(rows.length, detailRows.length)
  rows.forEach((r, i) => {
    const joined = stripped(r.left + ' ' + r.right + r.em + r.tail)
    assert.equal(joined, stripped(detailRows[i]))
  })
})
test('一致性：promo 行数据与 promo.js detailLines 逐档等价（去空格/括号）', () => {
  const { sheetRowsOf } = require(sheetPath)
  const { promoBarOf } = require(promoPath)
  const promotion = { active: true, name: '秋日优惠', channels: {}, tiers: [{ minFen: 30000, cutFen: 4000 }, { minFen: 10000, cutFen: 1000 }, { minFen: 20000, cutFen: 2500 }] }
  const { rows } = sheetRowsOf('promo', promotion, null)
  const bar = promoBarOf(promotion, 'LOCAL')
  const detailRows = bar.detailLines.slice(0, -1)
  assert.equal(rows.length, detailRows.length)
  rows.forEach((r, i) => {
    const joined = stripped(r.left + ' ' + r.right + r.em + r.tail)
    assert.equal(joined, stripped(detailRows[i]))
  })
})
