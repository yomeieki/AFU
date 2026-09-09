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

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
export const numOrNull = (v: unknown): number | null => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const md5U = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase()

/** 两层合并取第一个「有值」的：null/undefined/'' 都算没给，不能用 ?? 遮蔽另一层的真实值（含空串本身） */
const pick = (...vals: unknown[]): unknown => vals.find((v) => v !== null && v !== undefined && v !== '')

export function _parseCallbackParam(p: Record<string, unknown>): ExpressCallbackPayload {
  const d = (p.data && typeof p.data === 'object' ? p.data : {}) as Record<string, unknown>
  const w = numOrNull(d.weight), fr = numOrNull(d.freight), def = numOrNull(d.defPrice)
  return {
    status: String(pick(d.status, p.status) ?? ''),
    taskId: str(pick(p.taskId, d.taskId)), kdOrderId: str(pick(d.orderId, p.orderId)), kuaidinum: str(pick(p.kuaidinum, d.kuaidinum, d.kuaidiNum)),
    courierName: str(pick(d.courierName, p.courierName)), courierMobile: str(pick(d.courierMobile, p.courierMobile)),
    weightKg: w, freightFen: fr === null ? null : Math.round(fr * 100), defPriceFen: def === null ? null : Math.round(def * 100),
    feeDetails: d.feeDetails ?? null, statusDesc: str(pick(p.message, d.statusDesc, d.message)), raw: p,
  }
}

export interface ExpressTrackItem { context: string; ftime: string; status: string | null; areaName: string | null }
export interface ExpressTrackPayload {
  status: string; ischeck: boolean; state: string | null; nu: string | null; com: string | null; message: string | null
  items: ExpressTrackItem[]; raw: Record<string, unknown>
}
/** 轨迹 JSON 只留最近 50 条：顾客端只看最近几条，店员抽屉只看最新一条；快递100 一单轨迹一般 10–20 条，50 是余量 */
export const TRACK_MAX_ITEMS = 50

/** pollCallBackUrl 推送的 param（调研 §3.3）：{ status, billstatus, message, lastResult:{ nu, com, ischeck, state, data:[{context,ftime,time,status,areaName}] } } */
export function _parseTrackParam(p: Record<string, unknown>): ExpressTrackPayload {
  const lr = (p.lastResult && typeof p.lastResult === 'object' && !Array.isArray(p.lastResult) ? p.lastResult : {}) as Record<string, unknown>
  const items: ExpressTrackItem[] = []
  for (const it of Array.isArray(lr.data) ? lr.data : []) {
    const r = (it && typeof it === 'object' && !Array.isArray(it) ? it : {}) as Record<string, unknown>
    const context = str(r.context), ftime = str(r.ftime) ?? str(r.time)
    if (!context || !ftime) continue
    items.push({ context: context.slice(0, 255), ftime: ftime.slice(0, 32), status: str(r.status), areaName: str(r.areaName) })
  }
  // 快递100 通常已是最新在前，但不赌它：按 ftime 字符串（'YYYY-MM-DD HH:mm:ss' 可直接比较）降序排一次
  items.sort((a, b) => (a.ftime < b.ftime ? 1 : a.ftime > b.ftime ? -1 : 0))
  const state = str(lr.state)
  return {
    status: String(str(p.status) ?? '').toLowerCase(),
    ischeck: String(lr.ischeck ?? '') === '1' || state === '3',
    state, nu: str(lr.nu)?.slice(0, 64) ?? null, com: str(lr.com)?.slice(0, 32) ?? null, message: str(pick(p.message, lr.message)),
    items: items.slice(0, TRACK_MAX_ITEMS), raw: p,
  }
}

/** sign = MD5(param + salt) 大写；多字节篡改 sign 先按字节长度筛，避免 timingSafeEqual 因长度不等直接抛异常 */
function verifySignedParam(body: Record<string, string>, salt: string): { ok: true; param: Record<string, unknown> } | { ok: false; reason: 'BAD_PARAM' | 'SIGN_MISMATCH' } {
  const paramStr = body.param, sign = body.sign
  if (typeof paramStr !== 'string' || !paramStr || typeof sign !== 'string') return { ok: false, reason: 'BAD_PARAM' }
  const expect = md5U(paramStr + salt), got = sign.toUpperCase()
  if (Buffer.byteLength(got) !== Buffer.byteLength(expect)) return { ok: false, reason: 'SIGN_MISMATCH' }
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(got))) return { ok: false, reason: 'SIGN_MISMATCH' }
  let p: Record<string, unknown>
  try { p = JSON.parse(paramStr) as Record<string, unknown> } catch { return { ok: false, reason: 'BAD_PARAM' } }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, reason: 'BAD_PARAM' }
  return { ok: true, param: p }
}

export function verifyAndParseExpressCallback(body: Record<string, string>, salt: string): { ok: true; payload: ExpressCallbackPayload } | { ok: false; reason: 'BAD_PARAM' | 'SIGN_MISMATCH' } {
  const v = verifySignedParam(body, salt)
  return v.ok ? { ok: true, payload: _parseCallbackParam(v.param) } : v
}
export function verifyAndParseExpressTrack(body: Record<string, string>, salt: string): { ok: true; payload: ExpressTrackPayload } | { ok: false; reason: 'BAD_PARAM' | 'SIGN_MISMATCH' } {
  const v = verifySignedParam(body, salt)
  return v.ok ? { ok: true, payload: _parseTrackParam(v.param) } : v
}
