import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'

type Db = Prisma.TransactionClient | typeof prisma

export function trunc(s: string | null | undefined, n: number): string | null {
  if (s === null || s === undefined) return null
  return s.length > n ? s.slice(0, n) : s
}
const md5hex = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex')

/** 回调幂等键：同一 deliveryNo+状态+updateTime 只落一条；缺 updateTime 退化 rawBody 摘要 */
export function makeCallbackDedupeKey(deliveryNo: string, providerStatus: string, updateTimeIso: string | null, rawBody: string): string {
  const tail = updateTimeIso ?? md5hex(rawBody)
  return `CB:${deliveryNo}:${providerStatus}:${tail}`.slice(0, 64)
}
export function adminEventKey(): string { return `ADM:${crypto.randomUUID()}`.slice(0, 64) }

export interface RecordEventInput {
  deliveryId: number; dedupeKey: string; source: 'CALLBACK' | 'API' | 'ADMIN' | 'SCHEDULER'
  providerStatus?: number | null; statusDesc?: string | null
  courierName?: string | null; courierMobile?: string | null
  providerUpdateTime?: string | null; operator?: string | null
  latencyMs?: number | null; rawPayload?: Prisma.InputJsonValue
}
/** 事件先落库再推进状态机；P2002 = 重复，调用方据此短路。字符串在此统一截到列宽。 */
export async function recordDeliveryEvent(db: Db, input: RecordEventInput): Promise<{ duplicate: boolean }> {
  try {
    await db.deliveryEvent.create({ data: {
      deliveryId: input.deliveryId, dedupeKey: input.dedupeKey, source: input.source,
      providerStatus: input.providerStatus ?? null,
      statusDesc: trunc(input.statusDesc, 255), courierName: trunc(input.courierName, 64),
      courierMobile: trunc(input.courierMobile, 20), providerUpdateTime: trunc(input.providerUpdateTime, 32),
      operator: trunc(input.operator, 64), latencyMs: input.latencyMs ?? null,
      rawPayload: input.rawPayload,
    } })
    return { duplicate: false }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { duplicate: true }
    throw e
  }
}
