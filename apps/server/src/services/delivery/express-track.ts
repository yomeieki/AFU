/**
 * 快递100 轨迹推送（pollCallBackUrl）落库。轨迹是「展示层」事实：trackJson 整体覆盖，不逐条合并。
 * 只有「签收」推进预约状态：按 13 交给 applyProviderStatus；若预约还没到 PICKED（10 没推到），
 * 「先补一步 10」让订单 SHIPPED、发发货通知已内置在 applyProviderStatus 里（批次四），三条签收
 * 路径（回调 / 轨迹 / 对账）共用同一处状态机规则，这里不用再自己走两步。
 * 顺序同状态回调：查单 → 验签 → 事务内去重留痕 → 写 JSON → 签收推进 → 事务外通知。
 */
import { ExpressBooking, Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { verifyAndParseExpressTrack, ExpressTrackPayload, ExpressCallbackPayload } from './express-callback-sign'
import { recordBookingEvent, makeExpressTrackDedupeKey } from './express-events'
import { applyProviderStatus } from './express-callback'
import { toStoredTrack, parseStoredTrack, trackAlertKinds } from './express-track-json'
import { notifySystemAlert } from '../notify'
import { notifyExpressAlert } from '../order-notify'
import { getExpressSettings, COURIER_LABEL } from '../express-settings'

const NO_TRACK_STATUSES = ['CANCELLED', 'FAILED', 'VOID']

export async function handleExpressTrackCallback(bookingNo: string, body: Record<string, string>): Promise<{ http: 200 | 500 }> {
  const rawBody = JSON.stringify(body)
  const booking = await prisma.expressBooking.findUnique({ where: { bookingNo }, include: { order: { include: { user: { select: { openid: true } }, items: { select: { productName: true }, take: 1, orderBy: { id: 'asc' } } } } } })
  if (!booking) {
    notifySystemAlert('快递100 轨迹推送查不到预约', [`bookingNo=${bookingNo}`], { key: 'kd-express:track-unknown-booking' })
    return { http: 200 }
  }
  const parsed = verifyAndParseExpressTrack(body, booking.callbackSalt)
  if (!parsed.ok) {
    try { await recordBookingEvent(prisma, { bookingId: booking.id, dedupeKey: makeExpressTrackDedupeKey(bookingNo, 'BAD', rawBody), source: 'TRACK', statusDesc: parsed.reason === 'SIGN_MISMATCH' ? '轨迹推送验签失败' : '轨迹推送格式异常' }) } catch { /* 留痕失败不升级 */ }
    // 固定 key 不带 bookingNo：同状态回调的理由（bookingNo 可枚举，按它分 key 会被刷穿去重）
    notifySystemAlert('快递100 轨迹推送验签失败', [`bookingNo=${bookingNo}`], { key: 'kd-express:track-sign-fail' })
    return { http: 200 }
  }
  const p = parsed.payload
  const after: (() => void)[] = []
  const { costAlertRatio } = await getExpressSettings()
  try {
    await prisma.$transaction(async (tx) => {
      const ev = await recordBookingEvent(tx, { bookingId: booking.id, dedupeKey: makeExpressTrackDedupeKey(bookingNo, p.status, rawBody), source: 'TRACK', statusDesc: trackEventDesc(p), rawPayload: toStoredTrack(p) as unknown as Prisma.InputJsonValue })
      if (ev.duplicate) return
      // 取消/失败/作废的预约不该再有轨迹；来了只留痕，不写 JSON——顾客端读的是「最新一条预约」，
      // 店员取消后重约的新单不能被旧单的轨迹顶掉（旧单在 findFirst orderBy id desc 里不是最新，但保险起见不写）
      if (NO_TRACK_STATUSES.includes(booking.status)) return
      // abort 且没带任何条目：大概率是「单号有误/超期」这类不含轨迹内容的中止推送，不能拿它去覆盖
      // 已经落库的正常轨迹——顾客端还得看之前那些条目。仍然刷新 trackStatus/trackUpdatedAt 留痕，
      // 只是不动 trackJson；下面的告警分支照常触发。
      const skipTrackJson = p.status === 'abort' && p.items.length === 0
      const prevTrack = parseStoredTrack(booking.trackJson)
      await tx.expressBooking.update({ where: { id: booking.id }, data: { ...(skipTrackJson ? {} : { trackJson: toStoredTrack(p) as unknown as Prisma.InputJsonValue }), trackStatus: p.status ? p.status.slice(0, 16) : null, trackUpdatedAt: new Date() } })
      const label = COURIER_LABEL[booking.kuaidicom] ?? booking.kuaidicom
      // 一个预约只告警一次：跟落库前的「上一次」trackStatus/state 比，同状态不重复吵（对齐子系统里其它 DB 落库式告警的口径）
      for (const kind of trackAlertKinds(booking.trackStatus, prevTrack?.state ?? null, p)) {
        if (kind === 'abort') {
          after.push(() => notifyExpressAlert('快递100 轨迹订阅中止', [`订单 ${booking.orderNo} · ${label}${booking.kuaidinum ? ` ${booking.kuaidinum}` : ''}`, p.message ?? '单号可能有误或已超期', '顾客端将看不到后续轨迹，可到快递100 后台核对'], { key: `express-track-abort:${booking.id}` }))
        } else {
          after.push(() => notifyExpressAlert('快递100 轨迹显示退签/退回', [`订单 ${booking.orderNo} · ${label}${booking.kuaidinum ? ` ${booking.kuaidinum}` : ''}`, p.items[0]?.context ?? '', '请联系快递员或顾客处理'], { key: `express-track-return:${booking.id}` }))
        }
      }
      if (!p.ischeck || booking.status === 'DELIVERED') return
      // 签收 = 取件 + 签收：预约还没到 PICKED 时的「先补一步 10」已内置在 applyProviderStatus（批次四），
      // 三条签收路径（回调 / 轨迹 / 对账）共用一处，这里只按 13 走一遍
      await applyProviderStatus(tx, booking, syntheticPayload(booking, p, '13'), after, costAlertRatio)
    })
  } catch (e) {
    console.error('[kd-express-track] 处理失败:', e)
    return { http: 500 }
  }
  for (const f of after) { try { f() } catch (e) { console.error('[kd-express-track] after 失败:', e) } }
  return { http: 200 }
}

function trackEventDesc(p: ExpressTrackPayload): string {
  const latest = p.items[0]?.context ?? ''
  return `轨迹 ${p.status}${p.ischeck ? '（已签收）' : ''}${latest ? `：${latest.slice(0, 120)}` : p.message ? `：${p.message.slice(0, 120)}` : ''}`
}
/** 把轨迹签收翻译成状态回调的形状交给 applyProviderStatus：只带单号（轨迹的 nu），不带费用/快递员 */
function syntheticPayload(b: ExpressBooking, p: ExpressTrackPayload, status: string): ExpressCallbackPayload {
  return { status, taskId: null, kdOrderId: null, kuaidinum: p.nu ?? b.kuaidinum, courierName: null, courierMobile: null, weightKg: null, freightFen: null, defPriceFen: null, feeDetails: null, statusDesc: status === '13' ? '轨迹显示已签收' : '轨迹显示已揽收（补取件）', raw: p.raw }
}
