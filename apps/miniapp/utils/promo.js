// 只组织展示文案；命中满减档位与折扣金额由服务端决定。
function yuanShort(fen) { return (fen / 100).toFixed(2).replace(/\.?0+$/, '') }
function promoTypeOf(channel, mode) {
  return channel === 'EXPRESS' ? 'EXPRESS' : (mode === 'PICKUP' ? 'PICKUP' : 'LOCAL')
}
// 免运费三态（S1 未到最低档 / S2 到了一档还有更远档 / S3 到顶），供「满减关闭」与
// 「满减开着未达档」两处共用。tiers 未排序时内部自行按 minAmountFen 升序处理。
// 无档或算不出下一档时返回 null（调用方按 hidden 处理）。
function freeShipTip(tiers, subtotal, radius) {
  if (!tiers || !tiers.length) return null
  var reached = null
  tiers.forEach(function(t) {
    if (t.minAmountFen <= subtotal && (!reached || t.maxKm > reached.maxKm)) reached = t
  })
  var next = null
  tiers.forEach(function(t) {
    if (t.minAmountFen > subtotal && t.maxKm > (reached ? reached.maxKm : -1) && (!next || t.minAmountFen < next.minAmountFen)) next = t
  })
  if (!reached && !next) return null
  if (!reached) {
    var text = '再买 ¥' + yuanShort(next.minAmountFen - subtotal) + ' 免运费'
    if (next.maxKm < radius) text += '（' + next.maxKm + ' km 内）'
    return { text: text, tone: 'hint' }
  }
  if (reached.maxKm >= radius || !next) {
    return { text: reached.maxKm < radius ? reached.maxKm + ' km 内免运费' : '已免运费', tone: 'done' }
  }
  var gap = yuanShort(next.minAmountFen - subtotal)
  var tail = next.maxKm < radius ? (' 免 ' + next.maxKm + ' km 内运费') : ' 免运费'
  return { text: reached.maxKm + ' km 内免运费 · 再买 ¥' + gap + tail, tone: 'hint' }
}
function progressTipOf(preview, opts) {
  var hidden = { show: false, text: '', tone: 'hint' }
  opts = opts || {}
  var isLocal = opts.deliveryType === 'LOCAL'
  var tiers = (opts.freeShipTiers || []).slice().sort(function(a, b) { return a.minAmountFen - b.minAmountFen })
  if (preview && preview.active && !preview.discountFen && preview.nextTierGapFen != null) {
    var text = '再买 ¥' + yuanShort(preview.nextTierGapFen) + ' 减 ¥' + yuanShort(preview.nextTierCutFen)
    // 统筹裁定（2026-09-21）：满减开着、未达档时也追加免运费第二段，文案与满减关闭分支同源。
    if (isLocal) {
      var fs1 = freeShipTip(tiers, opts.subtotal, opts.radiusKm)
      if (fs1) text += ' · ' + fs1.text
    }
    return { show: true, text: text, tone: 'hint' }
  }
  if (preview && preview.active && preview.discountFen) {
    var text2 = '已减 ¥' + yuanShort(preview.discountFen)
    var second = ''
    var tone = 'done'
    if (isLocal && tiers.length) {
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
    return { show: true, text: text2 + (second ? ' · ' + second : ''), tone: tone }
  }
  // 满减关闭 / 未命中：补漏洞——不再直接 hidden，改成只提示免运费进度（满减关闭时也要看得到）。
  if (!isLocal) return hidden
  var fs2 = freeShipTip(tiers, opts.subtotal, opts.radiusKm)
  if (!fs2) return hidden
  return { show: true, text: fs2.text, tone: fs2.tone }
}
function promoBarOf(promotion, deliveryType) {
  var hidden = { show: false, badge: '', summary: '', name: '', detailLines: [] }
  if (!promotion || !promotion.active || (promotion.channels || {})[deliveryType] === false || !(promotion.tiers || []).length) return hidden
  var tiers = promotion.tiers.slice().sort(function(a, b) { return a.minFen - b.minFen })
  return {
    show: true,
    badge: '减',
    name: promotion.name || '全店满减',
    summary: tiers.slice(0, 2).map(function(t) { return '满 ' + yuanShort(t.minFen) + ' 减 ' + yuanShort(t.cutFen) }).join(' · ') + (tiers.length > 2 ? ' …' : ''),
    detailLines: tiers.map(function(t) { return '满 ¥' + yuanShort(t.minFen) + ' 减 ¥' + yuanShort(t.cutFen) }).concat(['与优惠券可叠加；运费、打包费不参与']),
  }
}
// 免运费提示条：同城主页/分类页满减条正下方。档位与配送半径全部读后台配置，为空数组时不渲染。
function freeShipBarOf(meta, deliveryType) {
  var hidden = { show: false, badge: '', name: '', summary: '', detailLines: [] }
  if (deliveryType !== 'LOCAL') return hidden
  if (!meta || !meta.fee) return hidden
  var tiers = (meta.fee.freeShipTiers || []).slice().sort(function(a, b) { return a.minAmountFen - b.minAmountFen })
  if (!tiers.length) return hidden
  var radius = meta.radiusKm
  function line(t) {
    return '满 ¥' + yuanShort(t.minAmountFen) + ' 免运费' + (radius > 0 && t.maxKm < radius ? '（' + t.maxKm + ' km 内）' : '')
  }
  var detailLines = tiers.map(line).concat([radius > 0 ? '按下单地址到门店的距离判断；配送范围 ' + radius + ' km' : '按下单地址到门店的距离判断'])
  return {
    show: true,
    badge: '免',
    name: '免运费',
    summary: line(tiers[0]) + (tiers.length > 1 ? '· 多买免更远' : ''),
    detailLines: detailLines,
  }
}
module.exports = { yuanShort: yuanShort, promoTypeOf: promoTypeOf, progressTipOf: progressTipOf, promoBarOf: promoBarOf, freeShipBarOf: freeShipBarOf }
