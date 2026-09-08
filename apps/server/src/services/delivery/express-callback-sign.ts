/**
 * 快递100 上门取件回调验签 + param 解析。独立成文件是为了打断 kd100-express.ts ↔ express-mock.ts
 * 的运行时 import 环：两个 provider（真实/mock）的 verifyAndParseCallback 都调这里的实现，互不
 * 依赖对方模块的值导出。回调 param 把状态既放顶层 status 又放 data.status，单号/快递员在 data 里
 * 为主、顶层为辅，两层都读（同 kd100-express.ts 里旧的 _parseCallbackParam 语义，逐字节保留）。
 */
import crypto from 'crypto'

export interface ExpressCallbackPayload {
  status: string; taskId: string | null; kdOrderId: string | null; kuaidinum: string | null
  courierName: string | null; courierMobile: string | null
  weightKg: number | null; freightFen: number | null; defPriceFen: number | null; feeDetails: unknown
  statusDesc: string | null; raw: Record<string, unknown>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const numOrNull = (v: unknown): number | null => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const md5U = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase()

export function _parseCallbackParam(p: Record<string, unknown>): ExpressCallbackPayload {
  const d = (p.data && typeof p.data === 'object' ? p.data : {}) as Record<string, unknown>
  const w = numOrNull(d.weight), fr = numOrNull(d.freight), def = numOrNull(d.defPrice)
  return {
    status: String(d.status ?? p.status ?? ''),
    taskId: str(p.taskId ?? d.taskId), kdOrderId: str(d.orderId ?? p.orderId), kuaidinum: str(p.kuaidinum ?? d.kuaidinum ?? d.kuaidiNum),
    courierName: str(d.courierName ?? p.courierName), courierMobile: str(d.courierMobile ?? p.courierMobile),
    weightKg: w, freightFen: fr === null ? null : Math.round(fr * 100), defPriceFen: def === null ? null : Math.round(def * 100),
    feeDetails: d.feeDetails ?? null, statusDesc: str(p.message ?? d.statusDesc ?? d.message), raw: p,
  }
}

/** sign = MD5(param + salt) 大写；多字节篡改 sign 先按字节长度筛，避免 timingSafeEqual 因长度不等直接抛异常 */
export function verifyAndParseExpressCallback(
  body: Record<string, string>,
  salt: string,
): { ok: true; payload: ExpressCallbackPayload } | { ok: false; reason: 'BAD_PARAM' | 'SIGN_MISMATCH' } {
  const paramStr = body.param, sign = body.sign
  if (typeof paramStr !== 'string' || !paramStr || typeof sign !== 'string') return { ok: false, reason: 'BAD_PARAM' }
  const expect = md5U(paramStr + salt), got = sign.toUpperCase()
  if (Buffer.byteLength(got) !== Buffer.byteLength(expect)) return { ok: false, reason: 'SIGN_MISMATCH' }
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(got))) return { ok: false, reason: 'SIGN_MISMATCH' }
  let p: Record<string, unknown>
  try { p = JSON.parse(paramStr) as Record<string, unknown> } catch { return { ok: false, reason: 'BAD_PARAM' } }
  if (!p || typeof p !== 'object') return { ok: false, reason: 'BAD_PARAM' }
  return { ok: true, payload: _parseCallbackParam(p) }
}
