import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduleUrgency, scheduleCapsule, scheduleFoldable, scheduleBarText, etaTextIfCallNow, isBeforeCallWindow, scheduleFieldsLine, findCardColumn, actionColKey } from './schedule.ts'
import type { ScheduleInfo, WorkbenchCard, WorkbenchSnapshot } from '../types'

// 2026-09-22 12:00 Asia/Shanghai = 04:00Z
const NOON = Date.parse('2026-09-22T04:00:00Z')
const min = (n: number) => n * 60_000
const iso = (t: number) => new Date(t).toISOString()
const base = (phase: ScheduleInfo['phase'], readyAt: string | null = null): ScheduleInfo => ({
  scheduledAt: iso(NOON), slotLabel: '今天 12:00–12:30',
  ticketAt: iso(NOON - min(59)), prepStartAt: iso(NOON - min(44)), callAt: iso(NOON - min(24)),
  acceptDueAt: iso(NOON - min(49)), selfCancelUntil: iso(NOON - min(120)),
  readyAt, phase, etaIfCallNow: iso(NOON + min(5)), callToleranceMin: 5,
})

test('紧急度只看阶段：CALL_DUE 橙、LATE 红、其余不亮', () => {
  assert.equal(scheduleUrgency('CALL_DUE'), 'warn'); assert.equal(scheduleUrgency('LATE'), 'late')
  for (const p of ['WAITING', 'TICKETED', 'PREPPING', 'READY_WAITING', 'CALLED'] as const) assert.equal(scheduleUrgency(p), '')
})
test('胶囊文案七态；done 列返回 null', () => {
  const now = NOON - min(50)
  assert.deepEqual(scheduleCapsule(base('WAITING'), 'pending', now), { text: '11:16 开始备餐', cls: '' })
  assert.deepEqual(scheduleCapsule(base('TICKETED'), 'pending', now), { text: '11:16 开始备餐', cls: '' })
  assert.deepEqual(scheduleCapsule(base('PREPPING'), 'preparing', NOON - min(30)), { text: '距应备好 6 分', cls: '' })
  assert.deepEqual(scheduleCapsule(base('CALL_DUE'), 'preparing', NOON - min(20)), { text: '应已备好 · 晚 4 分', cls: 'wb__wait--warn' })
  assert.deepEqual(scheduleCapsule(base('READY_WAITING', iso(NOON - min(40))), 'preparing', NOON - min(30)), { text: '已备好 · 11:36 自动呼叫', cls: '' })
  assert.deepEqual(scheduleCapsule(base('CALLED', iso(NOON - min(40))), 'waitingCourier', NOON - min(10)), { text: '12:00 送达', cls: '' })
  assert.deepEqual(scheduleCapsule(base('LATE'), 'delivering', NOON + min(11)), { text: '已超约定时间 11 分', cls: 'wb__wait--danger' })
  assert.equal(scheduleCapsule(base('CALLED'), 'done', NOON), null)
})
test('折叠：只折 WAITING 且无取消申请', () => {
  const card = (phase: ScheduleInfo['phase'], cancelRequested = false) =>
    ({ channel: 'LOCAL', local: { schedule: base(phase), cancelRequested } } as unknown as WorkbenchCard)
  assert.equal(scheduleFoldable(card('WAITING')), true)
  assert.equal(scheduleFoldable(card('WAITING', true)), false)
  assert.equal(scheduleFoldable(card('TICKETED')), false)
  assert.equal(scheduleFoldable({ channel: 'PICKUP', local: null } as unknown as WorkbenchCard), false)
})
test('倒计时条文案：还有/已到点、另有 N 张', () => {
  const bar = { prepStartAt: iso(NOON - min(44)), slotLabel: '今天 12:00–12:30', count: 3 }
  assert.equal(scheduleBarText(bar, NOON - min(64)), '下一张预约单 11:16 开始备餐，还有 20 分钟（今天 12:00–12:30 送达） · 另有 2 张')
  assert.equal(scheduleBarText({ ...bar, count: 1 }, NOON - min(40)), '下一张预约单 11:16 开始备餐，已到点 4 分钟（今天 12:00–12:30 送达）')
})
test('findCardColumn：五列 + scheduled 桶一起找；WAITING 预约单只在 scheduled 里，colKey 记为 pending（R1）', () => {
  const card = (orderId: number) => ({ orderId } as unknown as WorkbenchCard)
  const columns = {
    pending: [card(1)], preparing: [card(2)], waitingCourier: [], delivering: [], done: [],
    scheduled: [card(3)],
  } as unknown as WorkbenchSnapshot['columns']
  assert.deepEqual(findCardColumn(columns, 1), { card: columns.pending[0], colKey: 'pending' })
  assert.deepEqual(findCardColumn(columns, 2), { card: columns.preparing[0], colKey: 'preparing' })
  assert.deepEqual(findCardColumn(columns, 3), { card: columns.scheduled[0], colKey: 'pending' })
  // 六处都没找到：订单已经离开看板（顾客取消退款、或被别的渠道/店员处理掉）
  assert.equal(findCardColumn(columns, 999), null)
})
test('现在呼叫预计送达 / 呼叫窗口判定 / 字段行', () => {
  const sc = base('PREPPING')
  assert.equal(etaTextIfCallNow(sc), '现在呼叫预计 12:05 送达')
  assert.equal(isBeforeCallWindow(sc, NOON - min(30)), true)    // callAt 11:36 − 5 = 11:31，11:30 仍早
  assert.equal(isBeforeCallWindow(sc, NOON - min(29)), false)
  assert.equal(scheduleFieldsLine(sc), '今天 12:00–12:30 送达 · 11:16 开始备餐 · 11:36 呼叫')
})
test('actionColKey：折叠组里已接单的预约卡配按钮要按 preparing 走，其余原样返回 colKey（spec §6.1 按钮按订单状态，不按展示列）', () => {
  const card = (status: string, hasSchedule: boolean) =>
    ({ status, local: hasSchedule ? { schedule: base('WAITING') } : null } as unknown as WorkbenchCard)
  // pending + 有预约 + 已接单（PREPARING）→ 映射到 preparing
  assert.equal(actionColKey('pending', card('PREPARING', true)), 'preparing')
  // pending + 有预约 + 未接单（PAID）→ 原样 pending
  assert.equal(actionColKey('pending', card('PAID', true)), 'pending')
  // pending + 无预约 + PREPARING → 原样 pending（不是预约单，折叠规则不适用）
  assert.equal(actionColKey('pending', card('PREPARING', false)), 'pending')
  // 其他 colKey 原样返回，不受 status/schedule 影响
  assert.equal(actionColKey('preparing', card('PREPARING', true)), 'preparing')
  assert.equal(actionColKey('waitingCourier', card('PREPARING', true)), 'waitingCourier')
  assert.equal(actionColKey('delivering', card('PAID', false)), 'delivering')
  assert.equal(actionColKey('done', card('PREPARING', true)), 'done')
})
