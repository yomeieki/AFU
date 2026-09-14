// 餐具选择的纯函数（2026-09-14 餐具设计）。文案与服务端 services/tableware.ts 的 tablewareLabel 逐字一致。
// ⚠️ 本文件必须保持 ES5（scripts/check-miniapp-es5.mjs 把守）。
var MAX = 10

function tablewareLabel(mode, count) {
  if (mode === 'NONE') return '无需餐具'
  if (mode === 'BY_MEAL') return '需要餐具 · 按餐量'
  if (mode === 'COUNT' && count) return '需要餐具 · ' + count + ' 份'
  return ''
}

/** 服务端返回或本地状态 → 可以直接提交的形状；不合法一律 null（按「没选」处理，比猜一个值安全） */
function normalizeTableware(v) {
  if (!v || typeof v !== 'object') return null
  if (v.mode === 'NONE' || v.mode === 'BY_MEAL') return { mode: v.mode }
  if (v.mode === 'COUNT' && typeof v.count === 'number' && v.count >= 1 && v.count <= MAX && Math.floor(v.count) === v.count) {
    return { mode: 'COUNT', count: v.count }
  }
  return null
}

function stepCount(count, delta) {
  var n = (typeof count === 'number' && count >= 1 ? count : 1) + delta
  return Math.max(1, Math.min(MAX, n))
}

module.exports = { MAX: MAX, tablewareLabel: tablewareLabel, normalizeTableware: normalizeTableware, stepCount: stepCount }
