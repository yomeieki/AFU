/**
 * 餐具文案（2026-09-14 餐具选择设计）。与服务端 services/tableware.ts 的 tablewareLabel
 * 逐字同一组输出——两端各自维护一份、单测锁同一组用例，不共享代码。
 */
export function tablewareLabel(mode?: string | null, count?: number | null): string {
  if (mode === 'NONE') return '无需餐具'
  if (mode === 'BY_MEAL') return '需要餐具 · 按餐量'
  if (mode === 'COUNT' && count) return `需要餐具 · ${count} 份`
  return ''
}
