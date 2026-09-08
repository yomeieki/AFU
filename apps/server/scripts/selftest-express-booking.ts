/**
 * 邮寄预约状态机与协议自测（无需 DB，但需要能通过 config 的 env 校验）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-express-booking.ts
 */
import assert from 'assert'
import { BOOKING_RANK, BOOKING_TERMINAL, BOOKING_ACTIVE, KD_EXPRESS_STATUS_MAP, canTransition, BOOKING_STATUS_LABEL } from '../src/services/delivery/express-booking-state'
import { makeExpressDedupeKey } from '../src/services/delivery/express-events'
import { _buildBookParam, _parseBook, _parseDetail, _parseCallbackParam, kd100ExpressProvider } from '../src/services/delivery/kd100-express'
import { expressMockProvider, queueExpressDirective, resetExpressMock, getExpressCalls } from '../src/services/delivery/express-mock'
import crypto from 'crypto'
import { ProviderError } from '../src/services/delivery/types'
import { validateSlot, suggestSlot, pickupDateOf } from '../src/services/delivery/express-booking'

let pass = 0
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log('  ✔', name) }, (e) => { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 })
}

async function main() {
await t('rank 单调：PENDING<UNKNOWN<BOOKED<ACCEPTED<PICKED<DELIVERED', () => {
  const r = BOOKING_RANK
  assert.ok(r.PENDING < r.UNKNOWN && r.UNKNOWN < r.BOOKED && r.BOOKED < r.ACCEPTED && r.ACCEPTED < r.PICKED && r.PICKED < r.DELIVERED)
  assert.deepStrictEqual([...BOOKING_TERMINAL], ['DELIVERED', 'CANCELLED', 'FAILED', 'VOID'])
  assert.deepStrictEqual([...BOOKING_ACTIVE], ['BOOKED', 'ACCEPTED', 'UNKNOWN'])
})
await t('canTransition：只允许前进与终态化；终态后一律拒', () => {
  assert.ok(canTransition('BOOKED', 'ACCEPTED')); assert.ok(canTransition('BOOKED', 'PICKED')); assert.ok(canTransition('ACCEPTED', 'PICKED'))
  assert.ok(canTransition('PICKED', 'DELIVERED')); assert.ok(canTransition('BOOKED', 'CANCELLED')); assert.ok(canTransition('ACCEPTED', 'FAILED'))
  assert.ok(canTransition('UNKNOWN', 'BOOKED')); assert.ok(canTransition('UNKNOWN', 'VOID')); assert.ok(canTransition('PENDING', 'UNKNOWN'))
  assert.ok(!canTransition('PICKED', 'ACCEPTED')); assert.ok(!canTransition('ACCEPTED', 'BOOKED'))
  for (const term of BOOKING_TERMINAL) for (const to of ['BOOKED', 'ACCEPTED', 'PICKED', 'DELIVERED', 'CANCELLED']) assert.ok(!canTransition(term, to), `${term}->${to}`)
  assert.ok(!canTransition('PICKED', 'CANCELLED'), '取件后不能再被回调取消')
})
await t('快递100 状态映射', () => {
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
await t('去重键：同 bookingNo+status+同 body 相同；body 变则不同；≤64', () => {
  const a = makeExpressDedupeKey('E12-1', '10', '{"a":1}'), b = makeExpressDedupeKey('E12-1', '10', '{"a":1}'), c = makeExpressDedupeKey('E12-1', '10', '{"a":2}')
  assert.strictEqual(a, b); assert.notStrictEqual(a, c); assert.ok(a.length <= 64); assert.ok(a.startsWith('CB:E12-1:10:'))
})

await t('bOrder param：必填字段齐全、时段只在给了才传、顺丰 serviceType 透传、thirdOrderId=bookingNo', () => {
  const p = _buildBookParam({
    bookingNo: 'E12-1', kuaidicom: 'shunfeng', serviceType: '顺丰特快',
    sender: { name: '阿福凉菜', mobile: '15309003232', addr: '四川省自贡市自流井区丹桂街道丹桂40栋底楼' },
    receiver: { name: '客', mobile: '13800000000', addr: '北京市朝阳区建国路93号' },
    cargo: '食品', weightKg: 1.5, remark: '食品请勿重压', dayType: '今天', pickupStart: '14:00', pickupEnd: '16:00',
    callbackUrl: 'http://x/api/kd-express/E12-1', salt: 'saltsaltsaltsalt',
  })
  assert.strictEqual(p.kuaidicom, 'shunfeng'); assert.strictEqual(p.serviceType, '顺丰特快'); assert.strictEqual(p.cargo, '食品')
  assert.strictEqual(p.weight, '1.5'); assert.strictEqual(p.dayType, '今天'); assert.strictEqual(p.pickupStartTime, '14:00'); assert.strictEqual(p.pickupEndTime, '16:00')
  assert.strictEqual(p.callBackUrl, 'http://x/api/kd-express/E12-1'); assert.strictEqual(p.salt, 'saltsaltsaltsalt'); assert.strictEqual(p.thirdOrderId, 'E12-1')
  assert.strictEqual(p.recManPrintAddr, '北京市朝阳区建国路93号'); assert.strictEqual(p.sendManName, '阿福凉菜'); assert.strictEqual(p.payment, 'SHIPPER')
  const q = _buildBookParam({ bookingNo: 'E1-1', kuaidicom: 'jtexpress', sender: { name: 'a', mobile: '1', addr: 'x' }, receiver: { name: 'b', mobile: '2', addr: 'y' }, cargo: '食品', weightKg: 1, callbackUrl: 'u', salt: 's' })
  assert.ok(!('dayType' in q) && !('pickupStartTime' in q) && !('serviceType' in q))
})
await t('解析下单响应：字段缺省为 null（韵达异步无单号）', () => {
  assert.deepStrictEqual(_parseBook({ taskId: 'T1', orderId: 'O1', kuaidinum: 'JD001', pollToken: 'pt' }), { taskId: 'T1', kdOrderId: 'O1', kuaidinum: 'JD001', pollToken: 'pt' })
  assert.deepStrictEqual(_parseBook({ taskId: 'T2', orderId: 'O2' }), { taskId: 'T2', kdOrderId: 'O2', kuaidinum: null, pollToken: null })
  assert.deepStrictEqual(_parseBook(null), { taskId: null, kdOrderId: null, kuaidinum: null, pollToken: null })
})
await t('解析查单：空/非对象=未找到；有 status 就是找到', () => {
  assert.strictEqual(_parseDetail(null).found, false); assert.strictEqual(_parseDetail({}).found, false)
  const d = _parseDetail({ taskId: 'T', orderId: 'O', kuaidiNum: 'N', status: 1, courierName: '张', courierMobile: '138', freight: '8.30' })
  assert.deepStrictEqual({ ...d, raw: undefined }, { found: true, status: 1, taskId: 'T', kdOrderId: 'O', kuaidinum: 'N', courierName: '张', courierMobile: '138', freightFen: 830, raw: undefined })
})
await t('回调 param 解析：顶层与 data 两层都读，费用元→分', () => {
  const p = _parseCallbackParam({ status: 10, kuaidinum: 'N1', data: { orderId: 'O1', status: 10, courierName: '李', courierMobile: '139', weight: '1.6', freight: '8.30', defPrice: '10.00', feeDetails: [{ feeType: 1 }] } })
  assert.strictEqual(p.status, '10'); assert.strictEqual(p.kuaidinum, 'N1'); assert.strictEqual(p.kdOrderId, 'O1')
  assert.strictEqual(p.courierName, '李'); assert.strictEqual(p.weightKg, 1.6); assert.strictEqual(p.freightFen, 830); assert.strictEqual(p.defPriceFen, 1000)
  assert.deepStrictEqual(p.feeDetails, [{ feeType: 1 }])
  const q = _parseCallbackParam({ data: { status: '1' } })
  assert.strictEqual(q.status, '1'); assert.strictEqual(q.kuaidinum, null)
})
await t('回调 param 解析：空串不遮蔽另一层的真实值', () => {
  const r = _parseCallbackParam({ status: 10, data: { status: '', kuaidinum: 'N2' }, kuaidinum: '' })
  assert.strictEqual(r.status, '10'); assert.strictEqual(r.kuaidinum, 'N2')
})
await t('回调验签：正确通过、篡改失败、多字节 sign 不抛、缺 param 报 BAD_PARAM', () => {
  const salt = 'abcdef0123456789'
  const param = JSON.stringify({ status: 10, data: { status: 10 } })
  const sign = crypto.createHash('md5').update(param + salt, 'utf8').digest('hex').toUpperCase()
  const ok = kd100ExpressProvider.verifyAndParseCallback({ param, sign }, salt)
  assert.ok(ok.ok && ok.payload.status === '10')
  assert.deepStrictEqual(kd100ExpressProvider.verifyAndParseCallback({ param, sign: sign.slice(0, 31) + '0' }, salt), { ok: false, reason: 'SIGN_MISMATCH' })
  assert.deepStrictEqual(kd100ExpressProvider.verifyAndParseCallback({ param, sign: '中文中文中文中文中文中文中文中文' }, salt), { ok: false, reason: 'SIGN_MISMATCH' })
  assert.deepStrictEqual(kd100ExpressProvider.verifyAndParseCallback({ sign }, salt), { ok: false, reason: 'BAD_PARAM' })
  assert.strictEqual(kd100ExpressProvider.verifyAndParseCallback({ param, sign: sign.toLowerCase() }, salt).ok, true)
})
await t('回调验签：param 解出数组视为 BAD_PARAM', () => {
  const salt2 = 'abcdef0123456789'
  const arrParam = '[1,2]'
  const arrSign = crypto.createHash('md5').update(arrParam + salt2, 'utf8').digest('hex').toUpperCase()
  assert.deepStrictEqual(kd100ExpressProvider.verifyAndParseCallback({ param: arrParam, sign: arrSign }, salt2), { ok: false, reason: 'BAD_PARAM' })
})
await t('mock：book 默认成功返 taskId/kdOrderId/单号（韵达单号为空）；指令 timeout/error；calls 按 op 过滤', async () => {
  resetExpressMock()
  const base = { bookingNo: 'E1-1', sender: { name: 'a', mobile: '1', addr: 'x' }, receiver: { name: 'b', mobile: '2', addr: 'y' }, cargo: '食品', weightKg: 1, callbackUrl: 'u', salt: 's' }
  const r = await expressMockProvider.book({ ...base, kuaidicom: 'jd' })
  assert.ok(r.taskId && r.kdOrderId && r.kuaidinum && r.kuaidinum.startsWith('JD'))
  const y = await expressMockProvider.book({ ...base, bookingNo: 'E1-2', kuaidicom: 'yunda' })
  assert.strictEqual(y.kuaidinum, null)
  queueExpressDirective({ kind: 'timeout' }, 'book')
  await assert.rejects(() => expressMockProvider.book({ ...base, kuaidicom: 'jd' }), (e: unknown) => e instanceof ProviderError && e.kind === 'TIMEOUT')
  queueExpressDirective({ kind: 'error', code: '500', message: '下单失败:该区域暂时不开放' }, 'book')
  await assert.rejects(() => expressMockProvider.book({ ...base, kuaidicom: 'jd' }), (e: unknown) => e instanceof ProviderError && e.kind === 'BUSINESS' && /该区域/.test(e.message))
  assert.strictEqual(getExpressCalls('book').length, 4); assert.strictEqual(getExpressCalls('batchPrice').length, 0)
  await expressMockProvider.cancel({ taskId: r.taskId, kdOrderId: r.kdOrderId, reason: 'x' })
  queueExpressDirective({ kind: 'error', code: '500', message: '订单已揽收，无法取消' }, 'cancel')
  await assert.rejects(() => expressMockProvider.cancel({ taskId: r.taskId, kdOrderId: r.kdOrderId, reason: 'x' }), /已揽收/)
  const d0 = await expressMockProvider.detail({ taskId: null, thirdOrderId: 'E9-9' })
  assert.strictEqual(d0.found, false)
  queueExpressDirective({ kind: 'ok', found: true, status: 1, kuaidinum: 'N9', taskId: 'T9', kdOrderId: 'O9' }, 'detail')
  const d1 = await expressMockProvider.detail({ taskId: null, thirdOrderId: 'E9-9' })
  assert.ok(d1.found && d1.status === 1 && d1.kuaidinum === 'N9')
})

// 2026-09-09 10:00 上海 = 02:00Z
const T10 = new Date('2026-09-09T02:00:00Z')
const T19 = new Date('2026-09-09T11:00:00Z')   // 19:00 上海
await t('时段校验：格式/间隔/截单/顺丰必填', () => {
  assert.strictEqual(validateSlot({ dayType: '今天', pickupStart: '14:00', pickupEnd: '16:00' }, 'jd', T10), null)
  assert.match(validateSlot({ dayType: '今天', pickupStart: '14:00', pickupEnd: '14:30' }, 'jd', T10)!, /1 小时/)
  assert.match(validateSlot({ dayType: '今天', pickupStart: '09:00', pickupEnd: '11:00' }, 'jd', T10)!, /2 小时/)   // 11:00 结束，现在 10:00 → 不足 2h
  assert.strictEqual(validateSlot({ dayType: '明天', pickupStart: '09:00', pickupEnd: '11:00' }, 'jd', T19), null)
  assert.match(validateSlot({ dayType: '今天', pickupStart: '9:00', pickupEnd: '11:00' }, 'jd', T10)!, /HH:mm/)
  assert.match(validateSlot({ dayType: '今天', pickupStart: null, pickupEnd: null }, 'shunfeng', T10)!, /顺丰/)
  assert.strictEqual(validateSlot({ dayType: '明天', pickupStart: null, pickupEnd: null }, 'jd', T10), null)
  assert.match(validateSlot({ dayType: '大后天' as never, pickupStart: null, pickupEnd: null }, 'jd', T10)!, /今天/)
})
await t('预填：现在+2h 向上取整点起两小时；晚于 20:00 翻到明天 09:00–11:00', () => {
  assert.deepStrictEqual(suggestSlot(T10), { dayType: '今天', pickupStart: '12:00', pickupEnd: '14:00' })
  assert.deepStrictEqual(suggestSlot(new Date('2026-09-09T02:10:00Z')), { dayType: '今天', pickupStart: '13:00', pickupEnd: '15:00' })
  assert.deepStrictEqual(suggestSlot(T19), { dayType: '明天', pickupStart: '09:00', pickupEnd: '11:00' })
  assert.strictEqual(pickupDateOf('今天', T10), '2026-09-09'); assert.strictEqual(pickupDateOf('后天', T19), '2026-09-11')
})

console.log(`\n通过 ${pass} 条${process.exitCode ? '，有失败' : ''}`)
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
