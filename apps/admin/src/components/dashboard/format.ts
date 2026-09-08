const nf = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// 千分位分组：不用 Number.prototype.toLocaleString——它与 Date 无关，但
// scripts/check-admin-timezone.mjs 按属性名一刀切禁用，手写分组绕开这个误报。
const grouped = (n: number): string => {
  const sign = n < 0 ? '-' : ''
  const s = String(Math.abs(Math.round(n)))
  return sign + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
export const fen = (v: number | null | undefined, digits: 0 | 2 = 2): string =>
  v == null ? '—' : `¥${digits === 0 ? grouped(v / 100) : nf.format(v / 100)}`
export const pct = (v: number | null | undefined): string => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
export const minutes = (v: number | null | undefined): string => (v == null ? '—' : `${v} 分`)
export const hours = (v: number | null | undefined): string => (v == null ? '—' : `${v} 小时`)
export const km = (m: number | null | undefined): string => (m == null ? '—' : `${(m / 1000).toFixed(1)} km`)
