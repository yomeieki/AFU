// 活动详情弹层的行数据组装（T1）。只读 properties 里已有的结构化数据（promotion.tiers /
// meta.fee.freeShipTiers + meta.radiusKm），不碰 utils/promo.js；口径必须与 promo.js 的
// detailLines 逐档一致，见 tests/miniapp/promo-sheet.test.cjs 的一致性用例。
var yuanShort = require('../../utils/promo').yuanShort

function freeShipRows(meta) {
  var radius = (meta && meta.radiusKm) || 0
  var tiers = ((meta && meta.fee && meta.fee.freeShipTiers) || []).slice().sort(function(a, b) {
    return a.minAmountFen - b.minAmountFen
  })
  var rows = tiers.map(function(t) {
    if (radius > 0 && t.maxKm < radius) {
      return { left: '满 ¥' + yuanShort(t.minAmountFen), right: '免运费 ', em: t.maxKm + ' km', tail: ' 内' }
    }
    return { left: '满 ¥' + yuanShort(t.minAmountFen), right: '免运费', em: '', tail: '' }
  })
  var note = radius > 0 ? '按下单地址到门店的距离判断 · 配送范围 ' + radius + ' km' : '按下单地址到门店的距离判断'
  return { rows: rows, note: note }
}

function promoRows(promotion) {
  var tiers = ((promotion && promotion.tiers) || []).slice().sort(function(a, b) {
    return a.minFen - b.minFen
  })
  var rows = tiers.map(function(t) {
    return { left: '满 ¥' + yuanShort(t.minFen), right: '减 ', em: '¥' + yuanShort(t.cutFen), tail: '' }
  })
  return { rows: rows, note: '与优惠券可叠加 · 运费、打包费不参与' }
}

function sheetRowsOf(kind, promotion, meta) {
  return kind === 'freeship' ? freeShipRows(meta) : promoRows(promotion)
}

module.exports = { sheetRowsOf: sheetRowsOf }
