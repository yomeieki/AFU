/**
 * 快递100 余额不足（30004）熔断。进程内存态——与 scheduler 同享「PM2 单实例 fork」
 * 部署约束（见 scheduler.ts 头注释）；重启即复位，下次 30004 会重新 trip 并再告警一次，可接受。
 */
interface CircuitState { tripped: boolean; trippedAt: Date | null; reason: string | null; operator: string | null }
let state: CircuitState = { tripped: false, trippedAt: null, reason: null, operator: null }

export function isCircuitTripped(): boolean { return state.tripped }
/** 返回 true = 首次熔断（调用方发老板告警）；false = 早已熔断（不重复告警） */
export function tripCircuit(reason: string): boolean {
  if (state.tripped) return false
  state = { tripped: true, trippedAt: new Date(), reason, operator: null }
  return true
}
export function resetCircuit(operator: string): void {
  state = { tripped: false, trippedAt: null, reason: null, operator }
}
export function getCircuitState(): Readonly<CircuitState> { return state }
