/** 预约弹窗的重量输入归一：与服务端 createBooking 的 `Math.round(w*10)/10` 同口径 */
export const WEIGHT_MIN_KG = 0.1
export const WEIGHT_MAX_KG = 50
export function normalizeWeightKg(input: string): number | null {
  const n = Number(input.trim())
  if (input.trim() === '' || !Number.isFinite(n)) return null
  const w = Math.round(n * 10) / 10
  if (w < WEIGHT_MIN_KG || w > WEIGHT_MAX_KG) return null
  return w
}
