/** 轨迹 JSON 的存储形状与容错解析。纯函数：bookingView / 顾客详情 / 回调落库三处共用，不碰 prisma。 */
import type { ExpressTrackPayload } from './express-callback-sign'

export interface StoredTrackItem { context: string; ftime: string }
export interface StoredTrack { status: string; ischeck: boolean; state: string | null; nu: string | null; items: StoredTrackItem[] }

export function toStoredTrack(p: ExpressTrackPayload): StoredTrack {
  return { status: p.status, ischeck: p.ischeck, state: p.state, nu: p.nu, items: p.items.map((x) => ({ context: x.context, ftime: x.ftime })) }
}
/** 库里的 JSON 可能是老版本/人工改过：字段缺就补默认，条目缺 context/ftime 就剔除，整体不是对象就当没有 */
export function parseStoredTrack(v: unknown): StoredTrack | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const items: StoredTrackItem[] = []
  for (const it of Array.isArray(o.items) ? o.items : []) {
    const r = (it && typeof it === 'object' && !Array.isArray(it) ? it : {}) as Record<string, unknown>
    if (typeof r.context === 'string' && r.context && typeof r.ftime === 'string' && r.ftime) items.push({ context: r.context, ftime: r.ftime })
  }
  return { status: typeof o.status === 'string' ? o.status : '', ischeck: o.ischeck === true, state: typeof o.state === 'string' ? o.state : null, nu: typeof o.nu === 'string' ? o.nu : null, items }
}
