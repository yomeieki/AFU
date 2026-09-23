/**
 * 预约送达纯函数自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-schedule.ts
 */
import assert from 'assert'
import { DEFAULT_LOCAL_SETTINGS, sanitizeLocalSettings } from '../src/services/local-settings'
import {
  scheduleTimeline, schedulePrepMinutes, buildDeliverySlots, isValidDeliverySlot, earliestScheduleText, schedulePhase, scheduleView,
} from '../src/services/delivery/schedule'
import { buildPickupSlots } from '../src/services/pickup'
import { sortColumn, SortableCard } from '../src/routes/admin/workbench'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}
const sh = (iso: string) => new Date(iso + '+08:00')
const iso = (d: Date) => d.toISOString()

// 3 km / 15 km/h = 12 分路上；呼叫到取走 12；备餐 20（高峰 30）；缓冲 5；提前量 15；自助取消 120
const base = sanitizeLocalSettings({
  ...DEFAULT_LOCAL_SETTINGS,
  businessHours: [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '20:00' }],
  prepMinutes: 20, riderSpeedKmh: 15, callToPickupMin: 12,
  peak: { windows: [{ start: '12:00', end: '13:00' }], prepMinMinutes: 25, prepMaxMinutes: 30 },
  schedule: { ...DEFAULT_LOCAL_SETTINGS.schedule, enabled: true },
  selfCancelLeadMin: 120,
})
const D3 = 3000

t('平时 12:00 前送达（11:30）：呼叫 11:06、开始备餐 10:46、接单截止 10:41、出票 10:31、自助取消 09:30', () => {
  const tl = scheduleTimeline(base, sh('2026-09-22T11:30:00'), D3)
  assert.strictEqual(iso(tl.callAt), iso(sh('2026-09-22T11:06:00')))
  assert.strictEqual(iso(tl.prepStartAt), iso(sh('2026-09-22T10:46:00')))
  assert.strictEqual(iso(tl.acceptDueAt), iso(sh('2026-09-22T10:41:00')))
  assert.strictEqual(iso(tl.ticketAt), iso(sh('2026-09-22T10:31:00')))
  assert.strictEqual(iso(tl.selfCancelUntil), iso(sh('2026-09-22T09:30:00')))
  assert.strictEqual(tl.prepMinutes, 20); assert.strictEqual(tl.rideMinutes, 12)
})
t('高峰送达（12:30）：备餐取 max(20, 30)=30，开始备餐 11:36', () => {
  assert.strictEqual(schedulePrepMinutes(base, sh('2026-09-22T12:30:00')), 30)
  assert.strictEqual(iso(scheduleTimeline(base, sh('2026-09-22T12:30:00'), D3).prepStartAt), iso(sh('2026-09-22T11:36:00')))
})
t('schedule.prepMinutes 大于高峰上界时以它为准', () => {
  const s = sanitizeLocalSettings({ ...base, schedule: { ...base.schedule, prepMinutes: 40 } })
  assert.strictEqual(schedulePrepMinutes(s, sh('2026-09-22T12:30:00')), 40)
})
t('09:00 看时段：10:00 格开始备餐 09:16 早于开门 10:00 → 不出；首格 11:00（开始备餐 10:16 ≥ 10:00）', () => {
  const v = buildDeliverySlots(base, D3, sh('2026-09-22T09:00:00'))
  assert.strictEqual(v.blocked, null)
  const labels = v.days[0].slots.map((x) => x.label)
  assert.ok(!labels.includes('10:00–10:30') && !labels.includes('10:30–11:00'), labels.join(','))
  assert.strictEqual(labels[0], '11:00–11:30')
  assert.strictEqual(v.earliestAt, v.days[0].slots[0].startAt)
})
t('10:30 看时段：11:00 格提前量 12+12+20+5=49 → 10:11 < 10:30 不可选；11:30 格 10:41 ≥ 10:30 可选', () => {
  const v = buildDeliverySlots(base, D3, sh('2026-09-22T10:30:00'))
  assert.strictEqual(v.days[0].slots[0].label, '11:30–12:00')
})
t('末格不越打烊：13:30–14:00 是上午最后一格；晚市首格按开门 17:00 推 → 18:00', () => {
  const labels = buildDeliverySlots(base, D3, sh('2026-09-22T09:00:00')).days[0].slots.map((x) => x.label)
  assert.ok(labels.includes('13:30–14:00')); assert.ok(!labels.some((l) => l.startsWith('14:00')))
  assert.ok(!labels.includes('17:00–17:30') && !labels.includes('17:30–18:00')); assert.ok(labels.includes('18:00–18:30'))
})
t('打烊后（21:00）：今天空数组、明天满格，label 明天', () => {
  const v = buildDeliverySlots(base, D3, sh('2026-09-22T21:00:00'))
  assert.deepStrictEqual(v.days[0].slots, []); assert.strictEqual(v.days[1].label, '明天'); assert.ok(v.days[1].slots.length > 0)
})
t('daysAhead=0 只有今天；休业日整天去掉；全休业 blocked=HOLIDAY', () => {
  const s0 = sanitizeLocalSettings({ ...base, schedule: { ...base.schedule, daysAhead: 0 } })
  assert.strictEqual(buildDeliverySlots(s0, D3, sh('2026-09-22T09:00:00')).days.length, 1)
  const sh1 = sanitizeLocalSettings({ ...base, holiday: { until: '2026-09-22', reason: '盘点' } })
  const v = buildDeliverySlots(sh1, D3, sh('2026-09-22T09:00:00'))
  assert.strictEqual(v.days.length, 1); assert.strictEqual(v.days[0].date, '2026-09-23')
  const sh2 = sanitizeLocalSettings({ ...base, holiday: { until: '2026-09-23', reason: '盘点' } })
  assert.strictEqual(buildDeliverySlots(sh2, D3, sh('2026-09-22T09:00:00')).blocked?.kind, 'HOLIDAY')
})
t('暂停：until 为空当天全停明天照出；until=12:00 则 12:00 前的格不出、之后照出', () => {
  const p1 = sanitizeLocalSettings({ ...base, paused: { until: null, reason: '忙' } })
  const v1 = buildDeliverySlots(p1, D3, sh('2026-09-22T09:00:00'))
  assert.deepStrictEqual(v1.days[0].slots, []); assert.ok(v1.days[1].slots.length > 0); assert.strictEqual(v1.blocked, null)
  const p2 = sanitizeLocalSettings({ ...base, paused: { until: '2026-09-22T12:00:00+08:00', reason: '忙' } })
  const labels = buildDeliverySlots(p2, D3, sh('2026-09-22T09:00:00')).days[0].slots.map((x) => x.label)
  assert.ok(!labels.includes('11:00–11:30')); assert.ok(labels.includes('12:00–12:30'))
  const p3 = sanitizeLocalSettings({ ...p1, schedule: { ...p1.schedule, daysAhead: 0 } })
  assert.strictEqual(buildDeliverySlots(p3, D3, sh('2026-09-22T09:00:00')).blocked?.kind, 'PAUSED')
})
t('未开通 blocked=DISABLED；isValidDeliverySlot 精确命中格起点', () => {
  const off = sanitizeLocalSettings({ ...base, schedule: { ...base.schedule, enabled: false } })
  assert.strictEqual(buildDeliverySlots(off, D3, sh('2026-09-22T09:00:00')).blocked?.kind, 'DISABLED')
  assert.strictEqual(isValidDeliverySlot(base, sh('2026-09-22T11:00:00'), D3, sh('2026-09-22T09:00:00')), true)
  assert.strictEqual(isValidDeliverySlot(base, sh('2026-09-22T11:07:00'), D3, sh('2026-09-22T09:00:00')), false)
  assert.strictEqual(isValidDeliverySlot(base, sh('2026-09-22T10:00:00'), D3, sh('2026-09-22T09:00:00')), false)
})
t('earliestScheduleText 按半径 5 km 算最坏路上 20 分：09:00 看首格 11:00 → 「最早今天 11:00–11:30送达」', () => {
  assert.strictEqual(earliestScheduleText(base, sh('2026-09-22T09:00:00')), '最早今天 11:00–11:30送达')
})
t('phase 七态按时刻切换', () => {
  const tl = scheduleTimeline(base, sh('2026-09-22T11:30:00'), D3)
  const none = { readyAt: null, pickedUp: false, hasActiveDelivery: false }
  assert.strictEqual(schedulePhase(tl, none, sh('2026-09-22T10:00:00')), 'WAITING')
  assert.strictEqual(schedulePhase(tl, none, sh('2026-09-22T10:31:00')), 'TICKETED')
  assert.strictEqual(schedulePhase(tl, none, sh('2026-09-22T10:46:00')), 'PREPPING')
  assert.strictEqual(schedulePhase(tl, none, sh('2026-09-22T11:06:00')), 'CALL_DUE')
  assert.strictEqual(schedulePhase(tl, { readyAt: sh('2026-09-22T10:50:00'), pickedUp: false, hasActiveDelivery: false }, sh('2026-09-22T10:55:00')), 'READY_WAITING')
  assert.strictEqual(schedulePhase(tl, { readyAt: sh('2026-09-22T10:50:00'), pickedUp: false, hasActiveDelivery: true }, sh('2026-09-22T11:10:00')), 'CALLED')
  assert.strictEqual(schedulePhase(tl, { readyAt: sh('2026-09-22T10:50:00'), pickedUp: false, hasActiveDelivery: false }, sh('2026-09-22T11:31:00')), 'LATE')
  assert.strictEqual(schedulePhase(tl, { readyAt: sh('2026-09-22T10:50:00'), pickedUp: true, hasActiveDelivery: true }, sh('2026-09-22T11:31:00')), 'CALLED')
})
t('S4：CALL_DUE 两分钟宽限——已备好到点但无在途单，过 2 分钟宽限才回落 CALL_DUE；有在途单恒 CALLED', () => {
  // callAt = 11:06（同上：scheduledAt 11:30 送达）
  const tl = scheduleTimeline(base, sh('2026-09-22T11:30:00'), D3)
  const readyAt = sh('2026-09-22T10:50:00')
  // 有在途配送单：提前呼出（callAt−10min）仍是 CALLED，不再显示「等自动呼叫」
  assert.strictEqual(schedulePhase(tl, { readyAt, pickedUp: false, hasActiveDelivery: true }, sh('2026-09-22T10:56:00')), 'CALLED')
  // 无在途单：callAt+1min 仍在两跳心跳的宽限内 → READY_WAITING
  assert.strictEqual(schedulePhase(tl, { readyAt, pickedUp: false, hasActiveDelivery: false }, sh('2026-09-22T11:07:00')), 'READY_WAITING')
  // 无在途单：callAt+2min 宽限用尽 → CALL_DUE（该呼叫却没呼出去）
  assert.strictEqual(schedulePhase(tl, { readyAt, pickedUp: false, hasActiveDelivery: false }, sh('2026-09-22T11:08:00')), 'CALL_DUE')
  // 无在途单：callAt+4min 同样 CALL_DUE
  assert.strictEqual(schedulePhase(tl, { readyAt, pickedUp: false, hasActiveDelivery: false }, sh('2026-09-22T11:10:00')), 'CALL_DUE')
  // readyAt 为空时原口径不变：到点即 CALL_DUE，与 hasActiveDelivery 无关
  assert.strictEqual(schedulePhase(tl, { readyAt: null, pickedUp: false, hasActiveDelivery: false }, sh('2026-09-22T11:10:00')), 'CALL_DUE')
})
t('scheduleView 第 5 参（hasActiveDelivery）缺省 false 时原有断言不变', () => {
  const v = scheduleView(base, { deliveryType: 'LOCAL', scheduledAt: sh('2026-09-22T11:30:00'), distanceM: D3, readyAt: null }, sh('2026-09-22T09:00:00'))!
  assert.strictEqual(v.phase, 'WAITING')
})
t('scheduleView：非预约单/缺距离 → null；预约单给全部时刻与 phase', () => {
  assert.strictEqual(scheduleView(base, { deliveryType: 'LOCAL', scheduledAt: null, distanceM: D3, readyAt: null }), null)
  assert.strictEqual(scheduleView(base, { deliveryType: 'LOCAL', scheduledAt: sh('2026-09-22T11:30:00'), distanceM: null, readyAt: null }), null)
  const v = scheduleView(base, { deliveryType: 'LOCAL', scheduledAt: sh('2026-09-22T11:30:00'), distanceM: D3, readyAt: null }, sh('2026-09-22T09:00:00'))!
  assert.strictEqual(v.phase, 'WAITING'); assert.strictEqual(v.slotLabel, '今天 11:30–12:00'); assert.strictEqual(v.callAt, iso(sh('2026-09-22T11:06:00')))
})
t('自取经公共模块后行为不变：09:00 看自取首格 10:00（10:00−20−5=09:35 ≥ 09:00）', () => {
  const s = sanitizeLocalSettings({ ...base, pickup: { ...base.pickup, enabled: true, slotMinutes: 30, acceptBufferMin: 5, daysAhead: 1 } })
  const v = buildPickupSlots(s, sh('2026-09-22T09:00:00'))
  assert.strictEqual(v.days[0].slots[0].label, '10:00–10:30'); assert.strictEqual(v.days.length, 2)
})

// 复核 R8：done 列（newestFirst=true）不再被预约单的 prepStartAt 打乱；其余列（newestFirst=false，
// 待接单/备餐中等等）仍按 spec §6.1「同渠道内预约单按 prepStartAt 升序排在立即单之前」的原口径。
t('R8：done 列 newestFirst 生效——waitSince 较新的立即单排在 waitSince 较旧的预约单之前', () => {
  const cards: SortableCard[] = [
    { channel: 'LOCAL', waitSince: '2026-09-22T08:00:00.000Z', local: { schedule: { prepStartAt: '2026-09-22T07:00:00.000Z' } } }, // 预约单，waitSince 更旧
    { channel: 'LOCAL', waitSince: '2026-09-22T09:00:00.000Z' }, // 立即单，waitSince 更新
  ]
  sortColumn(cards, true)
  assert.strictEqual(cards[0].waitSince, '2026-09-22T09:00:00.000Z', '立即单（新）应排在预约单（旧）之前')
  assert.strictEqual(cards[1].waitSince, '2026-09-22T08:00:00.000Z')
})
t('R8：非 done 列（newestFirst=false）预约单仍按 prepStartAt 升序排在同渠道立即单之前，原口径不回归', () => {
  const cards: SortableCard[] = [
    { channel: 'LOCAL', waitSince: '2026-09-22T09:00:00.000Z' }, // 立即单
    { channel: 'LOCAL', waitSince: '2026-09-22T08:00:00.000Z', local: { schedule: { prepStartAt: '2026-09-22T07:00:00.000Z' } } }, // 预约单
  ]
  sortColumn(cards, false)
  assert.ok(cards[0].local?.schedule?.prepStartAt, '预约单应排在立即单之前')
  assert.strictEqual(cards[1].waitSince, '2026-09-22T09:00:00.000Z')
})
t('R8：非预约卡片两侧 prepStartAt 均为 null 时，排序不受影响（自取/邮寄/立即单原有口径零回归）', () => {
  const asc: SortableCard[] = [
    { channel: 'LOCAL', waitSince: '2026-09-22T09:00:00.000Z' },
    { channel: 'LOCAL', waitSince: '2026-09-22T08:00:00.000Z' },
  ]
  sortColumn(asc, false)
  assert.strictEqual(asc[0].waitSince, '2026-09-22T08:00:00.000Z', '非 newestFirst 时仍按 waitSince 升序')
  const desc: SortableCard[] = [
    { channel: 'LOCAL', waitSince: '2026-09-22T08:00:00.000Z' },
    { channel: 'LOCAL', waitSince: '2026-09-22T09:00:00.000Z' },
  ]
  sortColumn(desc, true)
  assert.strictEqual(desc[0].waitSince, '2026-09-22T09:00:00.000Z', 'newestFirst 时仍按 waitSince 降序')
})

console.log(process.exitCode ? `有失败（通过 ${pass}）` : `全部通过 ${pass}`)
