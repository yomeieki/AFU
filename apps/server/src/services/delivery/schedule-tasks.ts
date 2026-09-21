/**
 * 预约送达的五条定时任务（spec 2026-09-21-scheduled-delivery-design §4.7）。全部只扫 deliveryType=LOCAL 且
 * scheduledAt 非空；四个时刻每轮按**当时**设置重算（scheduleTimeline），店主改参数已付款的单立刻跟着动。
 * 打标范式与 delivery/tasks.ts 相同：先 updateMany 打标、count=1 才动作，并发双 tick 不会重复打扰。
 * 所有阈值都由时段倒推给出，没有 override 键；e2e 用 SQL 改 scheduled_at 把时刻推到当下（§69）。
 */
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { getLocalSettings, LocalDeliverySettings } from '../local-settings'
import { scheduleTimeline, ScheduleTimeline } from './schedule'
import { slotLabel, hhmmOf } from '../slots'
import { callRider, getActiveDelivery } from './orchestrator'
import { isCircuitTripped } from './circuit'
import { enqueueOrderTicket } from '../ticket'
import { notifyLocalDeliveryAlert, notifyScheduledAcceptReminder } from '../order-notify'
import { ACCEPT_REMIND_AFTER_MIN } from '../../utils/constants'

const BATCH = 100
const MIN = 60_000
const SEL = {
  id: true, orderNo: true, status: true, scheduledAt: true, distanceM: true, readyAt: true, prepTicketAt: true,
  scheduleRemindedAt: true, acceptRemindedAt: true, cancelRequestedAt: true, paidAt: true,
  receiverName: true, receiverPhone: true, actualAmount: true,
} satisfies Prisma.OrderSelect
type Row = Prisma.OrderGetPayload<{ select: typeof SEL }>

async function loadScheduled(statuses: string[], extra: Prisma.OrderWhereInput = {}): Promise<Row[]> {
  return prisma.order.findMany({
    where: { deliveryType: 'LOCAL', scheduledAt: { not: null }, status: { in: statuses }, ...extra },
    select: SEL, take: BATCH, orderBy: { scheduledAt: 'asc' },
  })
}
function tlOf(s: LocalDeliverySettings, o: Row): ScheduleTimeline | null {
  return o.scheduledAt && o.distanceM !== null ? scheduleTimeline(s, o.scheduledAt, o.distanceM) : null
}
const tail = (o: Row) => `订单 ${o.orderNo} · 尾号${o.receiverPhone.slice(-4)}`

/** ticketAt 到了 → 备餐票 + 企微「该开始备餐了」，每单一次（prepTicketAt 打标） */
export async function printPrepTickets(): Promise<number> {
  const s = await getLocalSettings()
  const now = Date.now()
  let n = 0
  for (const o of await loadScheduled(['PAID', 'PREPARING'], { prepTicketAt: null })) {
    const tl = tlOf(s, o)
    if (!tl || now < tl.ticketAt.getTime()) continue
    const marked = await prisma.order.updateMany({ where: { id: o.id, prepTicketAt: null }, data: { prepTicketAt: new Date() } })
    if (marked.count === 0) continue
    n++
    enqueueOrderTicket(o.id, 'PREP').catch((e) => console.error('[schedule-tasks] 备餐票入队失败:', (e as Error).message))
    notifyLocalDeliveryAlert('预约单该开始备餐了', [
      tail(o),
      `${hhmmOf(tl.prepStartAt)} 开始备餐 · ${hhmmOf(tl.callAt)} 前备好 · ${slotLabel(tl.scheduledAt, s.schedule.slotMinutes)} 送达`,
      o.status === 'PAID' ? '该单尚未接单，请先接单' : '做好后在工作台点「已备好」',
    ])
  }
  return n
}

/** acceptDueAt（且付款 ≥ afterMin）仍 PAID → 企微催单一次（acceptRemindedAt 打标） */
export async function remindScheduledUnaccepted(afterMin = ACCEPT_REMIND_AFTER_MIN): Promise<number> {
  const s = await getLocalSettings()
  const now = Date.now()
  const rows = await loadScheduled(['PAID'], { acceptRemindedAt: null, paidAt: { not: null } })
  const due = rows.filter((o) => { const tl = tlOf(s, o); return !!tl && now >= Math.max(o.paidAt!.getTime() + afterMin * MIN, tl.acceptDueAt.getTime()) })
  if (due.length === 0) return 0
  await prisma.order.updateMany({ where: { id: { in: due.map((o) => o.id) }, acceptRemindedAt: null }, data: { acceptRemindedAt: new Date() } })
  notifyScheduledAcceptReminder(due.map((o) => ({ orderNo: o.orderNo, actualAmount: o.actualAmount, receiverName: o.receiverName, receiverPhone: o.receiverPhone, slotLabel: slotLabel(o.scheduledAt!, s.schedule.slotMinutes) })))
  return due.length
}

/**
 * callAt 到了仍未点「已备好」→ 首次：企微 + READY_DUE 小条；之后每 readyRemindEveryMin 一张；
 * callAt + every×max 之后不再出小条，告警一次（计划差异④：按时间封顶，不数 PrintJob）。
 * scheduleRemindedAt = 上次动作时刻；耗尽告警发过的判据是「上次时刻 ≥ 耗尽点」。
 */
export async function remindScheduledNotReady(): Promise<number> {
  const s = await getLocalSettings()
  const now = Date.now()
  const every = s.schedule.readyRemindEveryMin * MIN
  const exhaustAfter = every * s.schedule.readyRemindMaxTimes
  let n = 0
  for (const o of await loadScheduled(['PREPARING'], { readyAt: null })) {
    const tl = tlOf(s, o)
    if (!tl || now < tl.callAt.getTime()) continue
    if (await getActiveDelivery(o.id)) continue
    const last = o.scheduleRemindedAt?.getTime() ?? null
    const exhaustAt = tl.callAt.getTime() + exhaustAfter
    if (now >= exhaustAt) {
      if (last !== null && last >= exhaustAt) continue
      const marked = await prisma.order.updateMany({ where: { id: o.id, readyAt: null, scheduleRemindedAt: o.scheduleRemindedAt }, data: { scheduleRemindedAt: new Date() } })
      if (marked.count === 0) continue
      n++
      notifyLocalDeliveryAlert('预约单迟迟未备好', [tail(o), `应于 ${hhmmOf(tl.callAt)} 前备好，已过 ${Math.round((now - tl.callAt.getTime()) / MIN)} 分钟，小条提醒已停`, '请立即处理：点「已备好」/「立即呼叫」/「自己送」'], { key: `sched-exhaust:${o.id}` })
      continue
    }
    if (last !== null && now - last < every) continue
    const marked = await prisma.order.updateMany({ where: { id: o.id, readyAt: null, scheduleRemindedAt: o.scheduleRemindedAt }, data: { scheduleRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    // 第几次提醒 = 该单已有的 READY_DUE 作业数 + 1（只做票面文案与去重 seq；打印机关着时恒为 1，无副作用）
    const seq = (await prisma.printJob.count({ where: { orderId: o.id, kind: 'READY_DUE' } })) + 1
    enqueueOrderTicket(o.id, 'READY_DUE', { seq }).catch((e) => console.error('[schedule-tasks] 催备好小条入队失败:', (e as Error).message))
    if (last === null) notifyLocalDeliveryAlert('预约单应已备好未确认', [tail(o), `应于 ${hhmmOf(tl.callAt)} 前备好 · ${slotLabel(tl.scheduledAt, s.schedule.slotMinutes)} 送达`, '请到工作台点「已备好」或「立即呼叫」'])
  }
  return n
}

/** 已备好且 callAt 到了 → 自动呼叫（SCHEDULED_AUTO）。熔断/未开通不呼；有取消申请的单交给店员 */
export async function autoCallScheduled(): Promise<number> {
  const s = await getLocalSettings()
  if (!s.enabled || isCircuitTripped()) return 0
  const now = Date.now()
  let n = 0
  for (const o of await loadScheduled(['PREPARING'], { readyAt: { not: null }, cancelRequestedAt: null })) {
    const tl = tlOf(s, o)
    if (!tl || now < tl.callAt.getTime()) continue
    if (await getActiveDelivery(o.id)) continue
    try { await callRider({ orderId: o.id, operator: 'scheduler', source: 'SCHEDULER', origin: 'SCHEDULED_AUTO' }); n++ }
    catch (e) { console.warn('[autoCallScheduled] 呼叫订单', o.id, '失败，跳过:', (e as Error)?.message ?? e) }
  }
  return n
}

/** 过了约定送达 + graceMin 骑手还没取餐 → 企微告警，限频 60 分钟一次（计划差异⑤） */
export async function remindScheduledLate(graceMin = 10): Promise<number> {
  const s = await getLocalSettings()
  const now = Date.now()
  let n = 0
  for (const o of await loadScheduled(['PAID', 'PREPARING', 'SHIPPED'], { scheduledAt: { lt: new Date(now - graceMin * MIN) } })) {
    const d = await prisma.delivery.findFirst({ where: { activeOrderId: o.id }, select: { status: true, pickedUpAt: true } })
    if (d?.pickedUpAt) continue
    n++
    notifyLocalDeliveryAlert('预约单已超约定送达时间', [
      tail(o),
      `约定 ${slotLabel(o.scheduledAt!, s.schedule.slotMinutes)}，已晚 ${Math.round((now - o.scheduledAt!.getTime()) / MIN)} 分钟`,
      o.status === 'PAID' ? '尚未接单' : d ? `配送单 ${d.status}` : o.readyAt ? '已备好，未发出呼叫' : '未备好、未呼叫骑手',
    ], { key: `sched-late:${o.id}`, windowMs: 60 * MIN })
  }
  return n
}
