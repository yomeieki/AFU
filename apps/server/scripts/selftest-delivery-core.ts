/** 配送引擎纯逻辑自测（无 DB）：cd apps/server && npx ts-node --transpile-only scripts/selftest-delivery-core.ts */
import assert from 'assert'
import { DELIVERY_RANK, TERMINAL, PROVIDER_STATUS_MAP, DELIVERY_STATUS_LABEL } from '../src/services/delivery/state'
import { isCircuitTripped, tripCircuit, resetCircuit, getCircuitState } from '../src/services/delivery/circuit'
import { trunc, makeCallbackDedupeKey, adminEventKey } from '../src/services/delivery/events'
import { ProviderError } from '../src/services/delivery/types'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}

t('rank 表单调且 DELIVERED=100', () => {
  const order = ['PENDING','CALLING','ACCEPTED','ARRIVING','ARRIVED','DELIVERING','DELIVERED']
  for (let i = 1; i < order.length; i++) assert.ok(DELIVERY_RANK[order[i]] > DELIVERY_RANK[order[i-1]], order[i])
  assert.strictEqual(DELIVERY_RANK.DELIVERED, 100)
})
t('旁路态不在 rank 表', () => {
  for (const s of ['REASSIGNING','ABNORMAL','CANCELLED','FAILED','UNKNOWN']) assert.strictEqual(DELIVERY_RANK[s], undefined, s)
})
t('TERMINAL 恰为三态', () => assert.deepStrictEqual([...TERMINAL].sort(), ['CANCELLED','DELIVERED','FAILED']))
t('映射表覆盖 9 个运力状态且类型正确', () => {
  assert.deepStrictEqual(PROVIDER_STATUS_MAP['310'], { type:'rank', status:'DELIVERING', rank:50, stamp:'pickedUpAt' })
  assert.deepStrictEqual(PROVIDER_STATUS_MAP['720'], { type:'side', status:'CANCELLED' })
  assert.strictEqual(Object.keys(PROVIDER_STATUS_MAP).length, 9)
})
t('12 个状态都有中文标签', () => {
  for (const s of ['PENDING','CALLING','ACCEPTED','ARRIVING','ARRIVED','DELIVERING','REASSIGNING','ABNORMAL','DELIVERED','CANCELLED','FAILED','UNKNOWN'])
    assert.ok(DELIVERY_STATUS_LABEL[s]?.length >= 2, s)
})
t('熔断：trip 幂等、reset 记操作人', () => {
  resetCircuit('selftest')
  assert.strictEqual(isCircuitTripped(), false)
  assert.strictEqual(tripCircuit('30004'), true)
  assert.strictEqual(tripCircuit('30004'), false)      // 已熔断，不重复告警
  assert.strictEqual(isCircuitTripped(), true)
  resetCircuit('boss')
  assert.strictEqual(getCircuitState().operator, 'boss')
  assert.strictEqual(isCircuitTripped(), false)
})
t('trunc 空安全与截断', () => {
  assert.strictEqual(trunc(null, 5), null)
  assert.strictEqual(trunc(undefined, 5), null)
  assert.strictEqual(trunc('abcdefg', 5), 'abcde')
})
t('dedupeKey：有 updateTime 用时间，无则退化 rawBody 摘要，恒 ≤64', () => {
  const a = makeCallbackDedupeKey('D42-1', '310', '2026-09-04T10:00:00.000Z', 'x')
  const b = makeCallbackDedupeKey('D42-1', '310', null, 'raw-body-1')
  const c = makeCallbackDedupeKey('D42-1', '310', null, 'raw-body-2')
  assert.ok(a.startsWith('CB:D42-1:310:2026'))
  assert.notStrictEqual(b, c)
  assert.strictEqual(makeCallbackDedupeKey('D42-1', '310', null, 'raw-body-1'), b)   // 稳定
  for (const k of [a, b]) assert.ok(k.length <= 64)
})
t('adminEventKey 唯一且 ≤64', () => {
  const a = adminEventKey(), b = adminEventKey()
  assert.notStrictEqual(a, b); assert.ok(a.length <= 64 && a.startsWith('ADM:'))
})
t('ProviderError 保留 kind/code/name', () => {
  const e = new ProviderError('BALANCE', '30004', '余额不足')
  assert.strictEqual(e.kind, 'BALANCE'); assert.strictEqual(e.code, '30004'); assert.strictEqual(e.name, 'ProviderError')
})

console.log(`\n${process.exitCode ? '有失败' : `全部通过 ${pass}`}`)
