// 只组织展示文案；命中满减档位与折扣金额由服务端决定。
function yuanShort(fen) { return (fen / 100).toFixed(2).replace(/\.00$/, '') }
function promoTypeOf(channel, mode) {
  return channel === 'EXPRESS' ? 'EXPRESS' : (mode === 'PICKUP' ? 'PICKUP' : 'LOCAL')
}
function progressTipOf(preview, opts) {
  var hidden = { show: false, text: '', tone: 'hint' }
  if (!preview || !preview.active) return hidden
  opts = opts || {}
  if (!preview.discountFen) {
    if (preview.nextTierGapFen == null) return hidden
    return { show: true, text: '再买 ¥' + yuanShort(preview.nextTierGapFen) + ' 减 ¥' + yuanShort(preview.nextTierCutFen), tone: 'hint' }
  }
  var text = '已减 ¥' + yuanShort(preview.discountFen)
  var second = ''
  var tone = 'done'
  var tiers = (opts.freeShipTiers || []).slice().sort(function(a, b) { return a.minAmountFen - b.minAmountFen })
  if (opts.deliveryType === 'LOCAL' && tiers.length) {
    var reached = null
    var next = null
    tiers.forEach(function(t) {
      if (t.minAmountFen <= opts.subtotal) {
        if (!reached || t.maxKm > reached.maxKm) reached = t
      } else if (!next) next = t
    })
    if (reached) {
      second = reached.maxKm < opts.radiusKm ? reached.maxKm + ' km 内免运费' : '已免运费'
    } else if (next) {
      second = '再买 ¥' + yuanShort(next.minAmountFen - opts.subtotal) + ' 免运费'
      if (next.maxKm < opts.radiusKm) second += '（' + next.maxKm + ' km 内）'
      tone = 'hint'
    }
  } else if (preview.nextTierGapFen != null) {
    second = '再买 ¥' + yuanShort(preview.nextTierGapFen) + ' 可减 ¥' + yuanShort(preview.nextTierCutFen)
    tone = 'hint'
  }
  return { show: true, text: text + (second ? ' · ' + second : ''), tone: tone }
}
function promoBarOf(promotion, deliveryType) {
  var hidden = { show: false, summary: '', name: '', detailLines: [] }
  if (!promotion || !promotion.active || (promotion.channels || {})[deliveryType] === false || !(promotion.tiers || []).length) return hidden
  var tiers = promotion.tiers.slice().sort(function(a, b) { return a.minFen - b.minFen })
  return {
    show: true,
    name: promotion.name || '全店满减',
    summary: tiers.slice(0, 2).map(function(t) { return '满 ' + yuanShort(t.minFen) + ' 减 ' + yuanShort(t.cutFen) }).join(' · ') + (tiers.length > 2 ? ' …' : ''),
    detailLines: tiers.map(function(t) { return '满 ¥' + yuanShort(t.minFen) + ' 减 ¥' + yuanShort(t.cutFen) }).concat(['与优惠券可叠加；运费、打包费不参与']),
  }
}
module.exports = { yuanShort: yuanShort, promoTypeOf: promoTypeOf, progressTipOf: progressTipOf, promoBarOf: promoBarOf }
