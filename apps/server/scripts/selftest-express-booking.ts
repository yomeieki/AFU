/**
 * 邮寄预约状态机与协议自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-express-booking.ts
 */
import assert from 'assert'
import { BOOKING_RANK, BOOKING_TERMINAL, BOOKING_ACTIVE, KD_EXPRESS_STATUS_MAP, canTransition, BOOKING_STATUS_LABEL } from '../src/services/delivery/express-booking-state'
import { makeExpressDedupeKey } from '../src/services/delivery/express-events'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}

t('rank 单调：PENDING<UNKNOWN<BOOKED<ACCEPTED<PICKED<DELIVERED', () => {
  const r = BOOKING_RANK
  assert.ok(r.PENDING < r.UNKNOWN && r.UNKNOWN < r.BOOKED && r.BOOKED < r.ACCEPTED && r.ACCEPTED < r.PICKED && r.PICKED < r.DELIVERED)
  assert.deepStrictEqual([...BOOKING_TERMINAL], ['DELIVERED', 'CANCELLED', 'FAILED', 'VOID'])
  assert.deepStrictEqual([...BOOKING_ACTIVE], ['BOOKED', 'ACCEPTED', 'UNKNOWN'])
})
t('canTransition：只允许前进与终态化；终态后一律拒', () => {
  assert.ok(canTransition('BOOKED', 'ACCEPTED')); assert.ok(canTransition('BOOKED', 'PICKED')); assert.ok(canTransition('ACCEPTED', 'PICKED'))
  assert.ok(canTransition('PICKED', 'DELIVERED')); assert.ok(canTransition('BOOKED', 'CANCELLED')); assert.ok(canTransition('ACCEPTED', 'FAILED'))
  assert.ok(canTransition('UNKNOWN', 'BOOKED')); assert.ok(canTransition('UNKNOWN', 'VOID')); assert.ok(canTransition('PENDING', 'UNKNOWN'))
  assert.ok(!canTransition('PICKED', 'ACCEPTED')); assert.ok(!canTransition('ACCEPTED', 'BOOKED'))
  for (const term of BOOKING_TERMINAL) for (const to of ['BOOKED', 'ACCEPTED', 'PICKED', 'DELIVERED', 'CANCELLED']) assert.ok(!canTransition(term, to), `${term}->${to}`)
  assert.ok(!canTransition('PICKED', 'CANCELLED'), '取件后不能再被回调取消')
})
t('快递100 状态映射', () => {
  const m = KD_EXPRESS_STATUS_MAP
  assert.deepStrictEqual(m['0'], { type: 'rank', status: 'BOOKED', rank: 10 })
  assert.deepStrictEqual(m['1'], { type: 'rank', status: 'ACCEPTED', rank: 20, stamp: 'acceptedAt' })
  assert.deepStrictEqual(m['2'], { type: 'rank', status: 'ACCEPTED', rank: 20, stamp: 'acceptedAt' })
  assert.deepStrictEqual(m['10'], { type: 'rank', status: 'PICKED', rank: 30, stamp: 'pickedAt' })
  assert.deepStrictEqual(m['13'], { type: 'rank', status: 'DELIVERED', rank: 100, stamp: 'deliveredAt' })
  assert.strictEqual(m['11'].type, 'side'); assert.strictEqual((m['11'] as { kind: string }).kind, 'FAILED')
  assert.strictEqual((m['610'] as { kind: string }).kind, 'FAILED')
  assert.strictEqual((m['9'] as { kind: string }).kind, 'CANCELLED'); assert.strictEqual((m['99'] as { kind: string }).kind, 'CANCELLED')
  assert.strictEqual((m['15'] as { kind: string }).kind, 'FEE'); assert.strictEqual((m['155'] as { kind: string }).kind, 'FEE')
  for (const s of ['101', '400', '200', '201']) assert.strictEqual((m[s] as { kind: string }).kind, 'IGNORE', s)
  for (const s of ['12', '14', '166']) assert.strictEqual((m[s] as { kind: string }).kind, 'ALERT', s)
  assert.strictEqual(m['999'], undefined)
  assert.strictEqual(BOOKING_STATUS_LABEL.BOOKED, '已预约·待接单')
})
t('去重键：同 bookingNo+status+同 body 相同；body 变则不同；≤64', () => {
  const a = makeExpressDedupeKey('E12-1', '10', '{"a":1}'), b = makeExpressDedupeKey('E12-1', '10', '{"a":1}'), c = makeExpressDedupeKey('E12-1', '10', '{"a":2}')
  assert.strictEqual(a, b); assert.notStrictEqual(a, c); assert.ok(a.length <= 64); assert.ok(a.startsWith('CB:E12-1:10:'))
})

console.log(`\n通过 ${pass} 条${process.exitCode ? '，有失败' : ''}`)
