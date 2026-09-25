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

// wb-escalation-display 复核第 1 轮（R5/R6，见 plan-decisions.md 第 7/8 条 + plan-r1-increment.md
// §S4'）：waitAnchorFor 改成「分链 + 候选链取最早」算法。fixture 补全 WaitAnchorLite 的全部
// 字段（deliveryNo/status/operator/callOrigin/cancelReason）——旧版只给 id/calledAt/createdAt
// 四条用例能过纯属巧合（这几个字段全 undefined 时 escalatedFrom 恒返回 null，每张单各自成链，
// 又因为 callOrigin undefined !== 'MANUAL_EARLY' 而全部入选候选，退化成「全局取最早」，
// 掩盖了真正的分链与 MANUAL_EARLY 排除逻辑没被测到的事实）。
const AUTO_REASON = '3 分钟无人接单，自动升级为并呼最便宜 3 家'
type WaitFixture = {
  id: number; deliveryNo: string; status: string; operator: string | null; callOrigin: string | null
  cancelReason: string | null; calledAt: Date | null; createdAt: Date
}
const wd = (id: number, over: Partial<WaitFixture> = {}): WaitFixture => ({
  id, deliveryNo: `D9-${id}`, status: 'CALLING', operator: null, callOrigin: null, cancelReason: null,
  calledAt: null, createdAt: new Date(`2026-09-26T09:00:0${id}Z`),
  ...over,
})

t('waitAnchorFor：链成立 → D1 的 calledAt', () => {
  const d1 = wd(1, { calledAt: new Date('2026-09-26T10:00:00Z'), createdAt: new Date('2026-09-26T09:59:00Z') })
  const d2 = wd(2, { calledAt: new Date('2026-09-26T10:03:00Z'), createdAt: new Date('2026-09-26T10:03:00Z') })
  assert.strictEqual(waitAnchorFor(d2, [d1, d2]).getTime(), d1.calledAt!.getTime())
})
t('waitAnchorFor：D1 calledAt 为 null → D1 的 createdAt', () => {
  const d1 = wd(1, { calledAt: null, createdAt: new Date('2026-09-26T09:59:00Z') })
  const d2 = wd(2, { calledAt: new Date('2026-09-26T10:03:00Z'), createdAt: new Date('2026-09-26T10:03:00Z') })
  assert.strictEqual(waitAnchorFor(d2, [d1, d2]).getTime(), d1.createdAt.getTime())
})
t('waitAnchorFor：店员手动取消重呼 → 仍是 D1 的 calledAt（不清零）', () => {
  const d1 = wd(1, { status: 'CANCELLED', cancelReason: '商家取消', calledAt: new Date('2026-09-26T10:00:00Z'), createdAt: new Date('2026-09-26T09:59:00Z') })
  const d2 = wd(2, { operator: 'admin', calledAt: new Date('2026-09-26T10:05:00Z'), createdAt: new Date('2026-09-26T10:05:00Z') })
  assert.strictEqual(waitAnchorFor(d2, [d1, d2]).getTime(), d1.calledAt!.getTime())
})
t('waitAnchorFor：三张单 D1→D2 自动升级、D2→D3 店员重呼 → 仍是 D1 的 calledAt', () => {
  const d1 = wd(1, { status: 'CANCELLED', cancelReason: AUTO_REASON, calledAt: new Date('2026-09-26T10:00:00Z'), createdAt: new Date('2026-09-26T09:59:00Z') })
  const d2 = wd(2, { status: 'CANCELLED', operator: 'scheduler', cancelReason: '商家取消', calledAt: new Date('2026-09-26T10:03:00Z'), createdAt: new Date('2026-09-26T10:03:00Z') })
  const d3 = wd(3, { operator: 'admin', calledAt: new Date('2026-09-26T10:08:00Z'), createdAt: new Date('2026-09-26T10:08:00Z') })
  assert.strictEqual(waitAnchorFor(d3, [d1, d2, d3]).getTime(), d1.calledAt!.getTime())
})
t('waitAnchorFor D-R5：呼叫失败也算第一次——FAILED D1（calledAt 空）用 createdAt 10:00，早于 D2 calledAt 10:20', () => {
  const d1 = wd(1, { status: 'FAILED', calledAt: null, createdAt: new Date('2026-09-26T10:00:00Z') })
  const d2 = wd(2, { calledAt: new Date('2026-09-26T10:20:00Z'), createdAt: new Date('2026-09-26T10:20:00Z') })
  assert.strictEqual(waitAnchorFor(d2, [d1, d2]).getTime(), d1.createdAt.getTime())
})
t('waitAnchorFor D-R6a：MANUAL_EARLY 那次店员手动取消（非自动升级）→ 从 D2（到点那次）算', () => {
  const d1 = wd(1, { status: 'CANCELLED', callOrigin: 'MANUAL_EARLY', cancelReason: '商家取消', calledAt: new Date('2026-09-26T09:00:00Z'), createdAt: new Date('2026-09-26T08:59:00Z') })
  const d2 = wd(2, { calledAt: new Date('2026-09-26T10:00:00Z'), createdAt: new Date('2026-09-26T10:00:00Z') })
  assert.strictEqual(waitAnchorFor(d2, [d1, d2]).getTime(), d2.calledAt!.getTime())
})
t('waitAnchorFor D-R6b：MANUAL_EARLY 那次呼叫失败、D2 到点自动呼叫 → 从 D2 算', () => {
  const d1 = wd(1, { status: 'FAILED', callOrigin: 'MANUAL_EARLY', calledAt: null, createdAt: new Date('2026-09-26T09:00:00Z') })
  const d2 = wd(2, { callOrigin: 'SCHEDULED_AUTO', calledAt: new Date('2026-09-26T10:00:00Z'), createdAt: new Date('2026-09-26T10:00:00Z') })
  assert.strictEqual(waitAnchorFor(d2, [d1, d2]).getTime(), d2.calledAt!.getTime())
})
t('waitAnchorFor D-R6c：MANUAL_EARLY 那次被自动升级接续到当前在途单（同一条链）→ 仍从 D1 算', () => {
  const d1 = wd(1, { status: 'CANCELLED', callOrigin: 'MANUAL_EARLY', cancelReason: AUTO_REASON, calledAt: new Date('2026-09-26T09:00:00Z'), createdAt: new Date('2026-09-26T08:59:00Z') })
  const d2 = wd(2, { operator: 'scheduler', calledAt: new Date('2026-09-26T09:03:00Z'), createdAt: new Date('2026-09-26T09:03:00Z') })
  assert.strictEqual(waitAnchorFor(d2, [d1, d2]).getTime(), d1.calledAt!.getTime())
})
t('waitAnchorFor D-R6d：MANUAL_EARLY 那次本身就是当前在途单 → 从它自己算', () => {
  const d1 = wd(1, { callOrigin: 'MANUAL_EARLY', calledAt: new Date('2026-09-26T09:00:00Z'), createdAt: new Date('2026-09-26T08:59:00Z') })
  assert.strictEqual(waitAnchorFor(d1, [d1]).getTime(), d1.calledAt!.getTime())
})
t('waitAnchorFor D-R6e：连续两次 MANUAL_EARLY 都取消，D3（非预约到点）在途 → 从 D3 算', () => {
  const d1 = wd(1, { status: 'CANCELLED', callOrigin: 'MANUAL_EARLY', cancelReason: '商家取消', calledAt: new Date('2026-09-26T08:00:00Z'), createdAt: new Date('2026-09-26T07:59:00Z') })
  const d2 = wd(2, { status: 'CANCELLED', callOrigin: 'MANUAL_EARLY', cancelReason: '商家取消', calledAt: new Date('2026-09-26T08:30:00Z'), createdAt: new Date('2026-09-26T08:29:00Z') })
  const d3 = wd(3, { calledAt: new Date('2026-09-26T10:00:00Z'), createdAt: new Date('2026-09-26T10:00:00Z') })
  assert.strictEqual(waitAnchorFor(d3, [d1, d2, d3]).getTime(), d3.calledAt!.getTime())
})
t('waitAnchorFor D-R6e：第三次仍是 MANUAL_EARLY 且本身在途 → 仍从它自己算（不追溯前两次）', () => {
  const d1 = wd(1, { status: 'CANCELLED', callOrigin: 'MANUAL_EARLY', cancelReason: '商家取消', calledAt: new Date('2026-09-26T08:00:00Z'), createdAt: new Date('2026-09-26T07:59:00Z') })
  const d2 = wd(2, { status: 'CANCELLED', callOrigin: 'MANUAL_EARLY', cancelReason: '商家取消', calledAt: new Date('2026-09-26T08:30:00Z'), createdAt: new Date('2026-09-26T08:29:00Z') })
  const d3 = wd(3, { callOrigin: 'MANUAL_EARLY', calledAt: new Date('2026-09-26T09:00:00Z'), createdAt: new Date('2026-09-26T08:59:00Z') })
  assert.strictEqual(waitAnchorFor(d3, [d1, d2, d3]).getTime(), d3.calledAt!.getTime())
})
t('waitAnchorFor 非预约对照：callOrigin 全程 null 时行为不变——D1 自动升级取消、D2 在途 → D1', () => {
  const d1 = wd(1, { status: 'CANCELLED', cancelReason: AUTO_REASON, calledAt: new Date('2026-09-26T10:00:00Z'), createdAt: new Date('2026-09-26T09:59:00Z') })
  const d2 = wd(2, { operator: 'scheduler', calledAt: new Date('2026-09-26T10:03:00Z'), createdAt: new Date('2026-09-26T10:03:00Z') })
  assert.strictEqual(waitAnchorFor(d2, [d1, d2]).getTime(), d1.calledAt!.getTime())
})

console.log(`\n${process.exitCode ? '有失败' : `全部通过 ${pass}`}`)
