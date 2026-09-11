/**
 * 到店自取纯函数自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-pickup.ts
 */
import assert from 'assert'
import { DEFAULT_LOCAL_SETTINGS, sanitizeLocalSettings } from '../src/services/local-settings'
import { buildPickupSlots, prepStartAt, pickupPrepMinutes, isValidPickupSlot, pickupDiscountOf, pickupSlotLabel, pickupTicketLabel } from '../src/services/pickup'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}
const sh = (iso: string) => new Date(iso + '+08:00') // 上海时刻字面量

const base = sanitizeLocalSettings({
  ...DEFAULT_LOCAL_SETTINGS,
  businessHours: [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '20:00' }],
  prepMinutes: 20,
  peak: { windows: [{ start: '12:00', end: '13:00' }], prepMinMinutes: 25, prepMaxMinutes: 30 },
  pickup: { ...DEFAULT_LOCAL_SETTINGS.pickup, enabled: true, slotMinutes: 30, acceptBufferMin: 5, daysAhead: 1 },
})

t('备餐时长：取餐时刻在高峰取上界 30，否则 20', () => {
  assert.strictEqual(pickupPrepMinutes(base, sh('2026-09-11T12:30:00')), 30)
  assert.strictEqual(pickupPrepMinutes(base, sh('2026-09-11T11:00:00')), 20)
})
t('开始备餐时刻 = 取餐 − 备餐 − 缓冲', () => {
  assert.strictEqual(prepStartAt(base, sh('2026-09-11T11:00:00')).toISOString(), sh('2026-09-11T10:35:00').toISOString())
  assert.strictEqual(prepStartAt(base, sh('2026-09-11T12:30:00')).toISOString(), sh('2026-09-11T11:55:00').toISOString())
})
t('09:00 下单：今天从 10:00 起每 30 分钟一格，10:00 可选（10:00−20−5=09:35 ≥ 09:00）', () => {
  const v = buildPickupSlots(base, sh('2026-09-11T09:00:00'))
  assert.strictEqual(v.blocked, null)
  assert.strictEqual(v.days.length, 2)
  assert.strictEqual(v.days[0].date, '2026-09-11'); assert.strictEqual(v.days[0].label, '今天')
  assert.strictEqual(v.days[0].slots[0].label, '10:00–10:30')
  assert.strictEqual(v.days[0].slots[0].startAt, sh('2026-09-11T10:00:00').toISOString())
  assert.strictEqual(v.earliestAt, v.days[0].slots[0].startAt)
})
t('10:50 下单：10:00/10:30/11:00 都来不及（11:00−25=10:35<10:50），第一格 11:30', () => {
  const v = buildPickupSlots(base, sh('2026-09-11T10:50:00'))
  assert.strictEqual(v.days[0].slots[0].label, '11:30–12:00')
})
t('高峰格备餐更久：11:40 下单，12:00 格要 12:00−30−5=11:25<11:40 不可选，12:30 可选', () => {
  const v = buildPickupSlots(base, sh('2026-09-11T11:40:00'))
  assert.ok(!v.days[0].slots.some((x) => x.label === '12:00–12:30'))
  assert.strictEqual(v.days[0].slots[0].label, '12:30–13:00')
})
t('末格不越打烊：13:30–14:00 是上午最后一格，没有 14:00 起的格', () => {
  const v = buildPickupSlots(base, sh('2026-09-11T09:00:00'))
  const labels = v.days[0].slots.map((x) => x.label)
  assert.ok(labels.includes('13:30–14:00'))
  assert.ok(!labels.some((l) => l.startsWith('14:00')))
  assert.ok(labels.includes('19:30–20:00'))
})
t('两段之间（15:00）今天还有晚市格；打烊后（21:00）今天为空数组、明天满格', () => {
  assert.strictEqual(buildPickupSlots(base, sh('2026-09-11T15:00:00')).days[0].slots[0].label, '17:00–17:30')
  const v = buildPickupSlots(base, sh('2026-09-11T21:00:00'))
  assert.deepStrictEqual(v.days[0].slots, [])
  assert.strictEqual(v.days[1].label, '明天')
  assert.strictEqual(v.days[1].slots[0].label, '10:00–10:30')
  assert.strictEqual(v.earliestAt, v.days[1].slots[0].startAt)
})
t('daysAhead=0 只有今天；daysAhead=2 第三天标签是日期', () => {
  assert.strictEqual(buildPickupSlots({ ...base, pickup: { ...base.pickup, daysAhead: 0 } }, sh('2026-09-11T09:00:00')).days.length, 1)
  const v = buildPickupSlots({ ...base, pickup: { ...base.pickup, daysAhead: 2 } }, sh('2026-09-11T09:00:00'))
  assert.strictEqual(v.days[2].label, '09-13')
})
t('休业：整天去掉；全部休业则 blocked=HOLIDAY 且 days 为空', () => {
  const v = buildPickupSlots({ ...base, holiday: { until: '2026-09-11', reason: '盘点' } }, sh('2026-09-11T09:00:00'))
  assert.strictEqual(v.blocked, null)
  assert.strictEqual(v.days.length, 1); assert.strictEqual(v.days[0].date, '2026-09-12')
  const all = buildPickupSlots({ ...base, holiday: { until: '2026-09-20', reason: '装修' } }, sh('2026-09-11T09:00:00'))
  assert.strictEqual(all.blocked?.kind, 'HOLIDAY'); assert.deepStrictEqual(all.days, [])
})
t('未开通 DISABLED、暂停 PAUSED', () => {
  assert.strictEqual(buildPickupSlots({ ...base, pickup: { ...base.pickup, enabled: false } }, sh('2026-09-11T09:00:00')).blocked?.kind, 'DISABLED')
  assert.strictEqual(buildPickupSlots({ ...base, pickup: { ...base.pickup, paused: { until: null, reason: '忙' } } }, sh('2026-09-11T09:00:00')).blocked?.kind, 'PAUSED')
})
t('isValidPickupSlot：命中格子才有效；过期格、非整格都无效', () => {
  const now = sh('2026-09-11T09:00:00')
  assert.strictEqual(isValidPickupSlot(base, sh('2026-09-11T10:00:00'), now), true)
  assert.strictEqual(isValidPickupSlot(base, sh('2026-09-11T10:15:00'), now), false)
  assert.strictEqual(isValidPickupSlot(base, sh('2026-09-11T10:00:00'), sh('2026-09-11T09:50:00')), false)
})
t('自取优惠：PERCENT 95 → 小计 5000 减 250；FIXED 300 封顶到小计；NONE 为 0', () => {
  assert.strictEqual(pickupDiscountOf({ ...base, pickup: { ...base.pickup, discount: { type: 'PERCENT', value: 95 } } }, 5000), 250)
  assert.strictEqual(pickupDiscountOf({ ...base, pickup: { ...base.pickup, discount: { type: 'PERCENT', value: 95 } } }, 3333), 167)
  assert.strictEqual(pickupDiscountOf({ ...base, pickup: { ...base.pickup, discount: { type: 'FIXED', value: 300 } } }, 200), 200)
  assert.strictEqual(pickupDiscountOf(base, 5000), 0)
})
t('时段文案：今天/明天/日期', () => {
  const now = sh('2026-09-11T09:00:00')
  assert.strictEqual(pickupSlotLabel(sh('2026-09-11T12:00:00'), 30, now), '今天 12:00–12:30')
  assert.strictEqual(pickupSlotLabel(sh('2026-09-12T12:00:00'), 30, now), '明天 12:00–12:30')
  assert.strictEqual(pickupSlotLabel(sh('2026-09-13T12:00:00'), 30, now), '09-13 12:00–12:30')
})

t('小票取餐文案：绝对日期 + 星期；今天不盖戳、明天「明日单」、更远印日期', () => {
  const now = sh('2026-09-11T09:00:00')
  assert.deepStrictEqual(pickupTicketLabel(sh('2026-09-11T12:00:00'), 30, now), { text: '9月11日（周五）12:00–12:30', stamp: '' })
  assert.deepStrictEqual(pickupTicketLabel(sh('2026-09-12T12:00:00'), 30, now), { text: '9月12日（周六）12:00–12:30', stamp: '明日单' })
  assert.deepStrictEqual(pickupTicketLabel(sh('2026-09-13T18:00:00'), 20, now), { text: '9月13日（周日）18:00–18:20', stamp: '9月13日单' })
})

console.log(`\n${process.exitCode ? '有失败' : `全部通过 ${pass}`}`)
