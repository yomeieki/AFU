import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PAUSE_SCOPES, validatePauseInput, pauseStateLines, endOfTodayIso, pauseActive, holidayActive } from './pause-scope.ts'

test('四个范围的顺序与文案（spec §6.1）', () => {
  assert.deepEqual(PAUSE_SCOPES.map((s) => s.key), ['DELIVERY', 'PICKUP', 'ALL_TODAY', 'HOLIDAY'])
  assert.deepEqual(PAUSE_SCOPES.map((s) => s.label), ['只暂停外送', '只暂停自取', '全部暂停（今天）', '休业至某日'])
})

test('validatePauseInput：原因必填；休业日期必填且不早于今天', () => {
  assert.equal(validatePauseInput('DELIVERY', { reason: ' ', until: '' }, '2026-09-11'), '请填写原因（顾客可见）')
  assert.equal(validatePauseInput('DELIVERY', { reason: '临时暂停', until: '' }, '2026-09-11'), null)
  assert.equal(validatePauseInput('HOLIDAY', { reason: '国庆休业', until: '' }, '2026-09-11'), '请选择恢复营业日期')
  assert.equal(validatePauseInput('HOLIDAY', { reason: '国庆休业', until: '2026-09-10' }, '2026-09-11'), '恢复日期不能早于今天')
  assert.equal(validatePauseInput('HOLIDAY', { reason: '国庆休业', until: '2026-09-11' }, '2026-09-11'), null)
})

test('pauseStateLines：按休业 > 外送 > 自取列出当前状态', () => {
  assert.deepEqual(pauseStateLines({ paused: null, pickupPaused: null, holiday: null, pickupEnabled: true }), [])
  assert.deepEqual(
    pauseStateLines({ paused: { reason: '下雨', until: null }, pickupPaused: { reason: '人手不够', until: null }, holiday: { until: '2026-10-07', reason: '国庆' }, pickupEnabled: true }),
    [
      { key: 'HOLIDAY', text: '休业中：国庆（10-07 后恢复）' },
      { key: 'DELIVERY', text: '外送已暂停：下雨' },
      { key: 'PICKUP', text: '自取已暂停：人手不够' },
    ],
  )
  // 自取没开通时不列自取那行（没开通谈不上暂停）
  assert.deepEqual(
    pauseStateLines({ paused: null, pickupPaused: { reason: 'x', until: null }, holiday: { until: null, reason: '装修' }, pickupEnabled: false }),
    [{ key: 'HOLIDAY', text: '休业中：装修（手动恢复）' }],
  )
})

test('endOfTodayIso：上海当天 23:59:59 的 ISO', () => {
  assert.equal(endOfTodayIso('2026-09-11'), '2026-09-11T15:59:59.000Z')
})

test('pauseActive：until 为空手动恢复，否则到时自动失效', () => {
  const now = Date.parse('2026-09-11T10:00:00+08:00')
  assert.equal(pauseActive(null, now), false)
  assert.equal(pauseActive({ until: null }, now), true)
  assert.equal(pauseActive({ until: '2026-09-11T23:59:59+08:00' }, now), true)
  assert.equal(pauseActive({ until: '2026-09-11T09:00:00+08:00' }, now), false)
})

test('holidayActive：until 为空手动恢复，否则含当天、次日自动恢复', () => {
  assert.equal(holidayActive({ until: '2026-09-11' }, '2026-09-11'), true)
  assert.equal(holidayActive({ until: '2026-09-11' }, '2026-09-12'), false)
  assert.equal(holidayActive({ until: null }, '2026-09-11'), true)
  assert.equal(holidayActive(null, '2026-09-11'), false)
})

test('pauseStateLines：全部到期后不再显示', () => {
  const now = Date.parse('2026-09-12T00:00:00+08:00')
  const today = '2026-09-12'
  assert.deepEqual(
    pauseStateLines(
      {
        paused: { reason: '下雨', until: '2026-09-11T23:59:59+08:00' },
        pickupPaused: { reason: '人手不够', until: '2026-09-11T23:59:59+08:00' },
        holiday: { until: '2026-09-11', reason: '国庆' },
        pickupEnabled: true,
      },
      now,
      today,
    ),
    [],
  )
})
