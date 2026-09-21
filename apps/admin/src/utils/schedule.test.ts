import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduleUrgency, scheduleCapsule, scheduleFoldable, scheduleBarText, etaTextIfCallNow, isBeforeCallWindow, scheduleFieldsLine } from './schedule.ts'
import type { ScheduleInfo, WorkbenchCard } from '../types'

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
test('现在呼叫预计送达 / 呼叫窗口判定 / 字段行', () => {
  const sc = base('PREPPING')
  assert.equal(etaTextIfCallNow(sc), '现在呼叫预计 12:05 送达')
  assert.equal(isBeforeCallWindow(sc, NOON - min(30)), true)    // callAt 11:36 − 5 = 11:31，11:30 仍早
  assert.equal(isBeforeCallWindow(sc, NOON - min(29)), false)
  assert.equal(scheduleFieldsLine(sc), '今天 12:00–12:30 送达 · 11:16 开始备餐 · 11:36 呼叫')
})
