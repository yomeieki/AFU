/** 配送引擎纯逻辑自测（无 DB）：cd apps/server && npx ts-node --transpile-only scripts/selftest-delivery-core.ts */
import assert from 'assert'
import { DELIVERY_RANK, TERMINAL, PROVIDER_STATUS_MAP, DELIVERY_STATUS_LABEL } from '../src/services/delivery/state'
import { isCircuitTripped, tripCircuit, resetCircuit, getCircuitState } from '../src/services/delivery/circuit'
import { trunc, makeCallbackDedupeKey, adminEventKey } from '../src/services/delivery/events'
import { ProviderError } from '../src/services/delivery/types'
import { shouldKillGhost, shouldAutoVoidCancelIntent, ghostNoIdShouldAlert } from '../src/services/delivery/cancel-intent'
import {
  parseAutoEscalationReason, autoEscalationCancelDesc, legacyDisplayDesc, escalatedFrom, waitAnchorFor,
} from '../src/services/delivery/history-view'

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
// P19：shouldKillGhost 判定表（已结束配送单该不该对这条回调自动向运力方撤销）
t('shouldKillGhost：FAILED + rank<100 → true', () => {
  assert.strictEqual(shouldKillGhost('FAILED', null, { type: 'rank', rank: 20 }), true)
  assert.strictEqual(shouldKillGhost('FAILED', 'T1', { type: 'rank', rank: 50 }), true)
})
t('shouldKillGhost：CANCELLED 且无 taskId + rank<100 → true', () => {
  assert.strictEqual(shouldKillGhost('CANCELLED', null, { type: 'rank', rank: 30 }), true)
})
t('shouldKillGhost：CANCELLED 有 taskId → false（我方主动取消过，尾随回调预期之内）', () => {
  assert.strictEqual(shouldKillGhost('CANCELLED', 'T1', { type: 'rank', rank: 30 }), false)
})
t('shouldKillGhost：任何 status + 520（rank=100）→ false（已送达，撤不了）', () => {
  assert.strictEqual(shouldKillGhost('FAILED', null, { type: 'rank', rank: 100 }), false)
  assert.strictEqual(shouldKillGhost('CANCELLED', null, { type: 'rank', rank: 100 }), false)
})
t('shouldKillGhost：side（515/510/720 旁路态）→ false', () => {
  assert.strictEqual(shouldKillGhost('FAILED', null, { type: 'side' }), false)
  assert.strictEqual(shouldKillGhost('CANCELLED', null, { type: 'side' }), false)
})
t('shouldKillGhost：DELIVERED → false（终态但不是"已结束等回调"的那两种）', () => {
  assert.strictEqual(shouldKillGhost('DELIVERED', null, { type: 'rank', rank: 50 }), false)
})
t('shouldKillGhost：mapped 未定义（未知状态）→ false', () => {
  assert.strictEqual(shouldKillGhost('FAILED', null, undefined), false)
})
// 复核 R3 + 验收 24：tasks.ts 的 processCancelIntents 直接调用这个函数决定要不要进入
// P17(b) 自动结束分支——方案原文「任一 id 为空」，旧代码只判断 providerTaskId 一半，
// 「有 taskId 无 orderId」的行会永久卡在取消意图里出不来。
t('shouldAutoVoidCancelIntent：两个 id 都缺 → true', () => {
  assert.strictEqual(shouldAutoVoidCancelIntent(null, null), true)
})
t('shouldAutoVoidCancelIntent：有 taskId 缺 orderId → true（R3 修复点：旧代码这里是 false）', () => {
  assert.strictEqual(shouldAutoVoidCancelIntent('T1', null), true)
})
t('shouldAutoVoidCancelIntent：缺 taskId 有 orderId → true', () => {
  assert.strictEqual(shouldAutoVoidCancelIntent(null, 'O1'), true)
})
t('shouldAutoVoidCancelIntent：两个 id 都齐全 → false（该走执行分支，不该被自动结束）', () => {
  assert.strictEqual(shouldAutoVoidCancelIntent('T1', 'O1'), false)
})

// 验收 31（R15-2）：killGhostDelivery 缺 orderId 分支该不该告警——只在骑手确认在动
// （rank>=20：100/210/230/310）时才升级为告警；rank=0（仅「已呼叫待抢单」，并呼噪声）
// 与 rank=100（已送达终态，shouldKillGhost 早已挡在外面，不会传到这里）都不告警。
t('ghostNoIdShouldAlert：rank 0/20/30/40/50/100 期望 false/true/true/true/true/false', () => {
  assert.strictEqual(ghostNoIdShouldAlert(0), false)
  assert.strictEqual(ghostNoIdShouldAlert(20), true)
  assert.strictEqual(ghostNoIdShouldAlert(30), true)
  assert.strictEqual(ghostNoIdShouldAlert(40), true)
  assert.strictEqual(ghostNoIdShouldAlert(50), true)
  assert.strictEqual(ghostNoIdShouldAlert(100), false)
})

// wb-escalation-display 验收 4：history-view.ts 纯函数——解析自动升级取消理由、拼历史行文案、
// 判定升级链路归属、算等待锚点（一律从第一次呼叫算，自动升级/店员取消重呼都不清零）。
t('parseAutoEscalationReason：合法 reason 解析出 minutes/rungText', () => {
  assert.deepStrictEqual(
    parseAutoEscalationReason('3 分钟无人接单，自动升级为并呼最便宜 3 家'),
    { minutes: '3', rungText: '并呼最便宜 3 家' },
  )
})
t('parseAutoEscalationReason：小数分钟（升级阈值 0.01 场景）', () => {
  assert.deepStrictEqual(
    parseAutoEscalationReason('0.01 分钟无人接单，自动升级为并呼最便宜 3 家'),
    { minutes: '0.01', rungText: '并呼最便宜 3 家' },
  )
})
t('parseAutoEscalationReason：非升级 reason / null → null', () => {
  assert.strictEqual(parseAutoEscalationReason('商家取消'), null)
  assert.strictEqual(parseAutoEscalationReason(null), null)
})
t('autoEscalationCancelDesc：拼出取消文案', () => {
  assert.strictEqual(
    autoEscalationCancelDesc({ providersLabel: '达达', minutes: '3', feeYuan: '0.00', rungText: '并呼最便宜 3 家' }),
    '达达 3 分钟无人接，已自动取消（取消费 ¥0.00），改为并呼最便宜 3 家',
  )
})
t('legacyDisplayDesc：ADMIN+scheduler 事件 + 匹配的升级 cancelReason → 改写为新文案', () => {
  const ev = { source: 'ADMIN', operator: 'scheduler', statusDesc: '商家取消（取消费 0.00 元）' }
  const d = { cancelReason: '3 分钟无人接单，自动升级为并呼最便宜 3 家', calledProviders: ['dadatongcheng'] }
  assert.strictEqual(legacyDisplayDesc(ev, d), '达达 3 分钟无人接，已自动取消（取消费 ¥0.00），改为并呼最便宜 3 家')
})
t('legacyDisplayDesc：带【订单未回退，请核对】尾巴时尾巴保留', () => {
  const ev = { source: 'ADMIN', operator: 'scheduler', statusDesc: '商家取消（取消费 0.00 元）【订单未回退，请核对】' }
  const d = { cancelReason: '3 分钟无人接单，自动升级为并呼最便宜 3 家', calledProviders: ['dadatongcheng'] }
  assert.strictEqual(
    legacyDisplayDesc(ev, d),
    '达达 3 分钟无人接，已自动取消（取消费 ¥0.00），改为并呼最便宜 3 家【订单未回退，请核对】',
  )
})
t('legacyDisplayDesc：operator 非 scheduler → 原文不改', () => {
  const ev = { source: 'ADMIN', operator: 'admin', statusDesc: '商家取消（取消费 0.00 元）' }
  const d = { cancelReason: '3 分钟无人接单，自动升级为并呼最便宜 3 家', calledProviders: ['dadatongcheng'] }
  assert.strictEqual(legacyDisplayDesc(ev, d), '商家取消（取消费 0.00 元）')
})
t('legacyDisplayDesc：cancelReason 不匹配升级格式 → 原文不改', () => {
  const ev = { source: 'ADMIN', operator: 'scheduler', statusDesc: '商家取消（取消费 0.00 元）' }
  const d = { cancelReason: '商家取消', calledProviders: ['dadatongcheng'] }
  assert.strictEqual(legacyDisplayDesc(ev, d), '商家取消（取消费 0.00 元）')
})
t('legacyDisplayDesc：statusDesc 已是新文案 → 原文不改（不重复改写）', () => {
  const ev = { source: 'ADMIN', operator: 'scheduler', statusDesc: '达达 3 分钟无人接，已自动取消（取消费 ¥0.00），改为并呼最便宜 3 家' }
  const d = { cancelReason: '3 分钟无人接单，自动升级为并呼最便宜 3 家', calledProviders: ['dadatongcheng'] }
  assert.strictEqual(legacyDisplayDesc(ev, d), ev.statusDesc)
})

const D1 = { id: 1, deliveryNo: 'D34-1', status: 'CANCELLED', operator: 'scheduler', callOrigin: null, cancelReason: '3 分钟无人接单，自动升级为并呼最便宜 3 家', calledProviders: ['dadatongcheng'] }
const D2 = { id: 2, deliveryNo: 'D34-2', status: 'CALLING', operator: 'scheduler', callOrigin: null, cancelReason: null, calledProviders: ['dadatongcheng', 'fengniaotongcheng', 'uupaotui'] }
t('escalatedFrom：自动升级链成立 → 前一张的运力/分钟数', () => {
  assert.deepStrictEqual(escalatedFrom(D2, [D1, D2]), { fromDeliveryNo: 'D34-1', providersLabel: '达达', minutes: '3' })
})
t('escalatedFrom：前一张是店员手动取消（reason=商家取消）→ null', () => {
  const d1Manual = { ...D1, cancelReason: '商家取消' }
  assert.strictEqual(escalatedFrom(D2, [d1Manual, D2]), null)
})
t('escalatedFrom：前一张是 SOLO_HELD 未取消（status 非 CANCELLED）→ null', () => {
  const d1Held = { ...D1, status: 'CALLING' }
  assert.strictEqual(escalatedFrom(D2, [d1Held, D2]), null)
})
t('escalatedFrom：D2 operator 非 scheduler → null', () => {
  const d2Manual = { ...D2, operator: 'admin' }
  assert.strictEqual(escalatedFrom(d2Manual, [D1, d2Manual]), null)
})

t('waitAnchorFor：链成立 → D1 的 calledAt', () => {
  const d1 = { id: 1, calledAt: new Date('2026-09-26T10:00:00Z'), createdAt: new Date('2026-09-26T09:59:00Z') }
  const d2 = { id: 2, calledAt: new Date('2026-09-26T10:03:00Z'), createdAt: new Date('2026-09-26T10:03:00Z') }
  assert.strictEqual(waitAnchorFor(d2, [d1, d2]).getTime(), d1.calledAt.getTime())
})
t('waitAnchorFor：D1 calledAt 为 null → D1 的 createdAt', () => {
  const d1 = { id: 1, calledAt: null as Date | null, createdAt: new Date('2026-09-26T09:59:00Z') }
  const d2 = { id: 2, calledAt: new Date('2026-09-26T10:03:00Z'), createdAt: new Date('2026-09-26T10:03:00Z') }
  assert.strictEqual(waitAnchorFor(d2, [d1, d2]).getTime(), d1.createdAt.getTime())
})
t('waitAnchorFor：店员手动取消重呼 → 仍是 D1 的 calledAt（不清零）', () => {
  const d1 = { id: 1, calledAt: new Date('2026-09-26T10:00:00Z'), createdAt: new Date('2026-09-26T09:59:00Z') }
  const d2 = { id: 2, calledAt: new Date('2026-09-26T10:05:00Z'), createdAt: new Date('2026-09-26T10:05:00Z') }
  assert.strictEqual(waitAnchorFor(d2, [d1, d2]).getTime(), d1.calledAt.getTime())
})
t('waitAnchorFor：三张单 D1→D2 自动升级、D2→D3 店员重呼 → 仍是 D1 的 calledAt', () => {
  const d1 = { id: 1, calledAt: new Date('2026-09-26T10:00:00Z'), createdAt: new Date('2026-09-26T09:59:00Z') }
  const d2 = { id: 2, calledAt: new Date('2026-09-26T10:03:00Z'), createdAt: new Date('2026-09-26T10:03:00Z') }
  const d3 = { id: 3, calledAt: new Date('2026-09-26T10:08:00Z'), createdAt: new Date('2026-09-26T10:08:00Z') }
  assert.strictEqual(waitAnchorFor(d3, [d1, d2, d3]).getTime(), d1.calledAt.getTime())
})

console.log(`\n${process.exitCode ? '有失败' : `全部通过 ${pass}`}`)
