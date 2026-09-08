/** 预约事件留痕。与 delivery/events.ts 平行（表不同、不复用）。 */
import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'

type Db = Prisma.TransactionClient | typeof prisma
const md5hex = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex')
export const truncStr = (s: string | null | undefined, n: number): string | null => (s == null ? null : String(s).slice(0, n))

export function makeExpressDedupeKey(bookingNo: string, providerStatus: string, rawBody: string): string {
  return `CB:${bookingNo}:${providerStatus}:${md5hex(rawBody)}`.slice(0, 64)
}
export function adminBookingEventKey(): string { return `ADM:${crypto.randomUUID()}`.slice(0, 64) }

export interface RecordBookingEventInput {
  bookingId: number; dedupeKey: string; source: 'CALLBACK' | 'ADMIN' | 'SYSTEM'
  providerStatus?: number | null; statusDesc?: string | null; courierName?: string | null; courierMobile?: string | null
  operator?: string | null; rawPayload?: Prisma.InputJsonValue | null
}
export async function recordBookingEvent(db: Db, i: RecordBookingEventInput): Promise<{ duplicate: boolean }> {
  try {
    await db.expressBookingEvent.create({ data: {
      bookingId: i.bookingId, dedupeKey: i.dedupeKey, source: i.source, providerStatus: i.providerStatus ?? null,
      statusDesc: truncStr(i.statusDesc, 255), courierName: truncStr(i.courierName, 64), courierMobile: truncStr(i.courierMobile, 20),
      operator: truncStr(i.operator, 64), rawPayload: i.rawPayload ?? undefined,
    } })
    return { duplicate: false }
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return { duplicate: true }
    throw e
  }
}
