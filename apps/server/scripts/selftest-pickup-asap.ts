/**
 * 到店自取「尽快取」纯函数自测（无需 DB，plans/2026-09-28-pickup-asap.md 测试用例 A1–A16）：
 *   cd apps/server && TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-pickup-asap.ts
 *
 * 时刻与设置一律注入，不读真实时钟。每条用例名以 A 编号开头，对应方案「测试用例 · A 组」。
 */
import assert from 'assert'
import { DEFAULT_LOCAL_SETTINGS, sanitizeLocalSettings, LocalDeliverySettings } from '../src/services/local-settings'
import {
  asapReadyAt, pickupAsapInfo, asapPickupAtOnPaid, asapPickupLabel, pickupTimeLabel, pickupTicketFields, pickupSlotLabel,
} from '../src/services/pickup'
import { renderOrderTicket, strWidth, BIG_LINE_WIDTH, TicketOrderInput } from '../src/services/ticket/content'
import { sortColumn, SortableCard } from '../src/routes/admin/workbench'
import { buildContent } from '../src/services/order-notify'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}
const sh = (iso: string) => new Date(iso + '+08:00') // 上海时刻字面量
const iso = (s: string) => sh(s).toISOString()

// A1 的设置：营业 10:00–14:30，备餐 15、缓冲 5，高峰 12:00–13:00（上限 30）
const base: LocalDeliverySettings = sanitizeLocalSettings({
  ...DEFAULT_LOCAL_SETTINGS,
  businessHours: [{ start: '10:00', end: '14:30' }, { start: '17:00', end: '20:00' }],
  prepMinutes: 15,
  peak: { windows: [{ start: '12:00', end: '13:00' }], prepMinMinutes: 25, prepMaxMinutes: 30 },
  pickup: { ...DEFAULT_LOCAL_SETTINGS.pickup, enabled: true, slotMinutes: 30, acceptBufferMin: 5, daysAhead: 1 },
})
const D = '2026-09-28'

// ── A1–A7：可用性与预计时刻 ──────────────────────────────────────────
t('A1 常规：11:20:00 → available，minutes=20，readyAt=11:40', () => {
  assert.deepStrictEqual(pickupAsapInfo(base, sh(`${D}T11:20:00`)), { available: true, readyAt: iso(`${D}T11:40:00`), minutes: 20, reason: null })
})
t('A2 高峰看取餐时刻：11:45 → 临时 12:05 落在高峰 → 30+5 → 12:20、minutes=35；11:20 → 11:40 不在高峰 → 20', () => {
  assert.deepStrictEqual(pickupAsapInfo(base, sh(`${D}T11:45:00`)), { available: true, readyAt: iso(`${D}T12:20:00`), minutes: 35, reason: null })
  const r = asapReadyAt(base, sh(`${D}T11:20:00`))
  assert.strictEqual(r.minutes, 20)
  assert.strictEqual(r.readyAt.toISOString(), iso(`${D}T11:40:00`))
})
t('A3 取整：11:20:31 → readyAt 向上取整到整分 11:41:00；恰为整分不再进一', () => {
  assert.strictEqual(asapReadyAt(base, sh(`${D}T11:20:31`)).readyAt.toISOString(), iso(`${D}T11:41:00`))
  assert.strictEqual(asapReadyAt(base, new Date(sh(`${D}T11:20:00`).getTime() + 1)).readyAt.toISOString(), iso(`${D}T11:41:00`))
  assert.strictEqual(asapReadyAt(base, sh(`${D}T11:20:00`)).readyAt.getUTCSeconds(), 0)
})
t('A4 本段来不及：14:05 → 14:25 可用；14:10:01 → 14:31 TOO_LATE；恰好等于段结束 14:30 → TOO_LATE', () => {
  assert.strictEqual(pickupAsapInfo(base, sh(`${D}T14:05:00`)).readyAt, iso(`${D}T14:25:00`))
  assert.deepStrictEqual(pickupAsapInfo(base, sh(`${D}T14:10:01`)), { available: false, readyAt: null, minutes: null, reason: 'TOO_LATE' })
  assert.strictEqual(pickupAsapInfo(base, sh(`${D}T14:10:00`)).reason, 'TOO_LATE')
  // 反例：晚市同理，按「此刻所在那一段」的结束判，不是全天最后一段
  assert.strictEqual(pickupAsapInfo(base, sh(`${D}T19:40:00`)).reason, 'TOO_LATE')
  assert.strictEqual(pickupAsapInfo(base, sh(`${D}T19:39:00`)).available, true)
})
t('A5 不在营业段：09:50、14:40（午休）、20:00（打烊）→ CLOSED', () => {
  for (const hm of ['09:50', '14:40', '20:00']) {
    assert.deepStrictEqual(pickupAsapInfo(base, sh(`${D}T${hm}:00`)), { available: false, readyAt: null, minutes: null, reason: 'CLOSED' }, hm)
  }
})
t('A6 休业 HOLIDAY；自取暂停（until 空 / 在未来）PAUSED；未开通 DISABLED；外送暂停不影响', () => {
  const now = sh(`${D}T11:20:00`)
  assert.strictEqual(pickupAsapInfo({ ...base, holiday: { until: D, reason: '盘点' } }, now).reason, 'HOLIDAY')
  assert.strictEqual(pickupAsapInfo({ ...base, pickup: { ...base.pickup, paused: { until: null, reason: '忙' } } }, now).reason, 'PAUSED')
  assert.strictEqual(pickupAsapInfo({ ...base, pickup: { ...base.pickup, paused: { until: iso(`${D}T12:00:00`), reason: '忙' } } }, now).reason, 'PAUSED')
  // 暂停已过期 → 不算暂停
  assert.strictEqual(pickupAsapInfo({ ...base, pickup: { ...base.pickup, paused: { until: iso(`${D}T11:00:00`), reason: '忙' } } }, now).available, true)
  assert.strictEqual(pickupAsapInfo({ ...base, pickup: { ...base.pickup, enabled: false } }, now).reason, 'DISABLED')
  // 顺序：未开通压过休业与暂停，休业压过暂停
  assert.strictEqual(pickupAsapInfo({ ...base, holiday: { until: null, reason: '' }, pickup: { ...base.pickup, enabled: false, paused: { until: null, reason: '' } } }, now).reason, 'DISABLED')
  assert.strictEqual(pickupAsapInfo({ ...base, holiday: { until: null, reason: '' }, pickup: { ...base.pickup, paused: { until: null, reason: '' } } }, now).reason, 'HOLIDAY')
  // 外送暂停 / 外送未开通：尽快取照常
  assert.strictEqual(pickupAsapInfo({ ...base, enabled: false, paused: { until: null, reason: '外送忙' } }, now).available, true)
})
t('A7 今日已约满：daysAhead=0 且今天已无可选格 → NONE（营业段内、本来也来得及）', () => {
  const s0 = { ...base, pickup: { ...base.pickup, daysAhead: 0 } }
  // 19:39 在晚市段内、19:59 < 20:00 本来来得及，但最后一格 19:30 已过 → NONE（先于 TOO_LATE 判）
  assert.strictEqual(pickupAsapInfo(s0, sh(`${D}T19:39:00`)).reason, 'NONE')
  // 对照：daysAhead=1 时同一时刻可用
  assert.strictEqual(pickupAsapInfo(base, sh(`${D}T19:39:00`)).available, true)
})

// ── A8：票面 ──────────────────────────────────────────────────────────
function ticketInput(pickupAt: Date, asap: boolean, now: Date): TicketOrderInput {
  return {
    channel: 'PICKUP', orderNo: 'FS20260928000123', createdAt: sh('2026-09-28T11:19:30'), paidAt: sh('2026-09-28T11:20:10'),
    items: [{ productName: '凉拌耳片', specText: '微辣', quantity: 1, subtotal: 1800, isGift: false, pointsCost: 0 }, { productName: '干煸四季豆', specText: null, quantity: 2, subtotal: 1600, isGift: false, pointsCost: 0 }],
    totalAmount: 3400, shippingFee: 0, packingFee: 200, actualAmount: 3420, remark: '少放辣',
    receiverName: '张三', receiverPhone: '13900000000', receiverFullAddress: '四川省自贡市自流井区丹桂40栋底楼',
    receiverDistrict: '自流井区', receiverDetail: '丹桂40栋底楼', receiverPoiName: null, distanceM: null, estimatedDeliveryAt: null,
    discountAmount: 0, pointsUsed: 0, tablewareMode: 'COUNT', tablewareCount: 2,
    pickupAt, ...pickupTicketFields(pickupAt, asap, 30, now), pickupDiscountAmount: 180, promoDiscountAmount: 0,
  } as TicketOrderInput
}
// BASE（72d441f）同一输入的原样输出：改动前用 BASE 的 content.ts 与 toTicketInput 同款字段拼法跑出来的字符串。
const BASE_SCHEDULED_TODAY = "<CB>到店自取</CB><BR><CB>尾号0000</CB><BR>付款：2026-09-28 11:20<BR>取餐 9月28日（周一）<BR><B>12:00–12:30</B><BR>取餐人 张三<BR>电话 139****0000<BR><B>餐具：2 份</B><BR><CB>备注：少放辣</CB><BR>凉拌耳片(微辣)         x1 ¥18.00<BR>干煸四季豆             x2 ¥16.00<BR>合计：¥34.00<BR>打包费：¥2.00<BR>自取优惠：−¥1.80<BR><B>实付：¥34.20</B><BR>接单请在工作台操作<BR> <BR> <BR> <BR> <BR> <BR> <BR> <BR><CUT><CB>厨房联</CB><BR><CB>尾号0000</CB><BR><B>餐具：2 份</B><BR>--------------------------------<BR><B>凉拌耳片      x1</B><BR>  (微辣)<BR><B>干煸四季豆    x2</B><BR>--------------------------------<BR><CB>备注：少放辣</CB><BR> <BR> <BR> <BR> <BR> <BR> <BR> <BR><CUT>"
const BASE_SCHEDULED_TOMORROW = "<CB>到店自取</CB><BR><CB>【明日单】</CB><BR><CB>尾号0000</CB><BR>付款：2026-09-28 11:20<BR>取餐 9月29日（周二）<BR><B>10:30–11:00</B><BR>取餐人 张三<BR>电话 139****0000<BR><B>餐具：2 份</B><BR><CB>备注：少放辣</CB><BR>凉拌耳片(微辣)         x1 ¥18.00<BR>干煸四季豆             x2 ¥16.00<BR>合计：¥34.00<BR>打包费：¥2.00<BR>自取优惠：−¥1.80<BR><B>实付：¥34.20</B><BR>接单请在工作台操作<BR> <BR> <BR> <BR> <BR> <BR> <BR> <BR><CUT><CB>厨房联</CB><BR><CB>尾号0000</CB><BR><B>餐具：2 份</B><BR>--------------------------------<BR><B>凉拌耳片      x1</B><BR>  (微辣)<BR><B>干煸四季豆    x2</B><BR>--------------------------------<BR><CB>备注：少放辣</CB><BR> <BR> <BR> <BR> <BR> <BR> <BR> <BR><CUT>"
const bigSegs = (tk: string) => [...tk.matchAll(/<B>([^<]*)<\/B>/g)].map((m) => m[1])

t('A8 票面：尽快单取餐联放大行「尽快取 约 HH:mm」≤16 列，不盖明日单戳、不出日期行', () => {
  const now = sh(`${D}T11:20:10`)
  const tk = renderOrderTicket(ticketInput(sh(`${D}T11:41:00`), true, now))
  assert.ok(tk.includes('<B>尽快取 约 11:41</B>'), tk)
  assert.ok(strWidth('尽快取 约 11:41') <= BIG_LINE_WIDTH)
  for (const seg of bigSegs(tk).filter((x) => x.includes('尽快取'))) assert.ok(strWidth(seg) <= BIG_LINE_WIDTH, seg)
  assert.ok(!tk.includes('【'), '不应盖任何日期戳：' + tk)
  assert.ok(!tk.includes('取餐 9月'), '不应出日期行：' + tk)
  assert.ok(!/<B>\d{2}:\d{2}–\d{2}:\d{2}<\/B>/.test(tk), '不应出预约时段放大行：' + tk)
})
t('A8 票面：预约单与 BASE 同一输入逐字节一致（今天的格 + 明天的格都照旧盖戳）', () => {
  const now = sh(`${D}T11:20:10`)
  assert.strictEqual(renderOrderTicket(ticketInput(sh(`${D}T12:00:00`), false, now)), BASE_SCHEDULED_TODAY)
  const tomorrow = renderOrderTicket(ticketInput(sh('2026-09-29T10:30:00'), false, now))
  assert.strictEqual(tomorrow, BASE_SCHEDULED_TOMORROW)
  assert.ok(tomorrow.includes('<CB>【明日单】</CB>') && tomorrow.includes('取餐 9月29日（周二）<BR><B>10:30–11:00</B>'), tomorrow)
  // pickupTicketFields 对预约单的五个字段与改前 toTicketInput 的四行拼法相同
  assert.deepStrictEqual(pickupTicketFields(sh('2026-09-29T10:30:00'), false, 30, now), {
    pickupAsap: false, pickupSlotLabel: '9月29日（周二）10:30–11:00', pickupSlotDate: '9月29日（周二）', pickupSlotTime: '10:30–11:00', pickupDayStamp: '明日单',
  })
})
t('A8 票面：不传 pickupAsap（老调用方）时走预约写法，与 pickupAsap=false 输出相同', () => {
  const now = sh(`${D}T11:20:10`)
  const a = ticketInput(sh(`${D}T12:00:00`), false, now)
  const b = { ...a } as TicketOrderInput & { pickupAsap?: boolean }
  delete b.pickupAsap
  assert.strictEqual(renderOrderTicket(b), renderOrderTicket(a))
})

// ── A9：工作台排序 ───────────────────────────────────────────────────
t('A9 sortColumn：非 done 列同为 PICKUP 时尽快单在预约单前；done 列口径不变；LOCAL 预约排序不回归', () => {
  const card = (id: string, channel: string, waitSince: string, extra: Partial<SortableCard> = {}) => ({ id, channel, waitSince, ...extra }) as SortableCard & { id: string }
  // 预约自取付款更早（等得更久）也排在尽快单之后
  const cards = [
    card('sched', 'PICKUP', '2026-09-28T02:00:00Z', { pickup: { asap: false } }),
    card('asap2', 'PICKUP', '2026-09-28T03:10:00Z', { pickup: { asap: true } }),
    card('asap1', 'PICKUP', '2026-09-28T03:00:00Z', { pickup: { asap: true } }),
    card('exp', 'EXPRESS', '2026-09-28T01:00:00Z'),
    card('loc', 'LOCAL', '2026-09-28T03:30:00Z'),
  ]
  sortColumn(cards)
  assert.deepStrictEqual(cards.map((c) => (c as { id: string }).id), ['loc', 'asap1', 'asap2', 'sched', 'exp'])
  // done 列：新在上，尽快与否不参与
  const done = [
    card('sched', 'PICKUP', '2026-09-28T04:00:00Z', { pickup: { asap: false } }),
    card('asap', 'PICKUP', '2026-09-28T03:00:00Z', { pickup: { asap: true } }),
  ]
  sortColumn(done, true)
  assert.deepStrictEqual(done.map((c) => (c as { id: string }).id), ['sched', 'asap'])
  // LOCAL 预约单仍按 prepStartAt 升序排在立即单前
  const local = [
    card('now', 'LOCAL', '2026-09-28T01:00:00Z'),
    card('s2', 'LOCAL', '2026-09-28T03:00:00Z', { local: { schedule: { prepStartAt: '2026-09-28T05:00:00Z' } } }),
    card('s1', 'LOCAL', '2026-09-28T03:05:00Z', { local: { schedule: { prepStartAt: '2026-09-28T04:00:00Z' } } }),
  ]
  sortColumn(local)
  assert.deepStrictEqual(local.map((c) => (c as { id: string }).id), ['s1', 's2', 'now'])
})

// ── A10：文案 helper ─────────────────────────────────────────────────
t('A10 文案 helper：尽快单「尽快取 约 HH:mm」；预约单与 slotLabel 原样一致；来单推送标题不重复「取」', () => {
  const now = sh(`${D}T11:20:00`)
  assert.strictEqual(pickupTimeLabel({ pickupAt: sh(`${D}T11:41:00`), pickupAsap: true }, base, now), '尽快取 约 11:41')
  assert.strictEqual(asapPickupLabel(sh(`${D}T11:41:00`)), '尽快取 约 11:41')
  for (const at of [sh(`${D}T12:00:00`), sh('2026-09-29T10:30:00'), sh('2026-09-30T18:00:00')]) {
    assert.strictEqual(pickupTimeLabel({ pickupAt: at, pickupAsap: false }, base, now), pickupSlotLabel(at, base.pickup.slotMinutes, now))
    assert.strictEqual(pickupTimeLabel({ pickupAt: at }, base, now), pickupSlotLabel(at, base.pickup.slotMinutes, now))
  }
  const info = { orderNo: 'FS1', actualAmount: 3420, receiverName: '张三', receiverPhone: '13900000000', paidAt: now, deliveryType: 'PICKUP' }
  const items = [{ productName: '凉拌耳片', quantity: 1 }]
  assert.strictEqual(buildContent({ ...info, pickupSlotLabel: '尽快取 约 11:41' }, items).split('\n')[0], '**🏪 自取新订单 · 尽快取 约 11:41**')
  assert.strictEqual(buildContent({ ...info, pickupSlotLabel: '今天 12:00–12:30' }, items).split('\n')[0], '**🏪 自取新订单 · 今天 12:00–12:30 取**')
  assert.strictEqual(buildContent({ ...info }, items).split('\n')[0], '**🏪 自取新订单**')
})

// ── A11–A16：付款时重算 ─────────────────────────────────────────────
const asapOrder = (pickupAt: string) => ({ deliveryType: 'PICKUP', pickupAsap: true, pickupAt: sh(pickupAt) })
const paidAt = (o: ReturnType<typeof asapOrder>, s: LocalDeliverySettings, pay: string, processed = pay) =>
  asapPickupAtOnPaid(o, s, sh(pay), sh(processed))?.toISOString() ?? null

t('A11 付款重算（处理时刻 = paidAt）：11:20:10 → 11:41；11:29 → 11:49；11:10 → 保持 11:40 不回退；结果永远整分', () => {
  const o = asapOrder(`${D}T11:40:00`)
  assert.strictEqual(paidAt(o, base, `${D}T11:20:10`), iso(`${D}T11:41:00`))
  assert.strictEqual(paidAt(o, base, `${D}T11:29:00`), iso(`${D}T11:49:00`))
  assert.strictEqual(paidAt(o, base, `${D}T11:10:00`), iso(`${D}T11:40:00`))
  for (const pay of [`${D}T11:20:10`, `${D}T11:29:59`, `${D}T11:33:01`]) {
    const r = asapPickupAtOnPaid(o, base, sh(pay), sh(pay))!
    assert.strictEqual(r.getTime() % 60_000, 0, pay)
  }
})
t('A12 高峰按重算后的取餐时刻判：原 11:59，paidAt 11:44 → 临时 12:04 在高峰 → 12:19；paidAt 11:30 → 11:50 < 11:59 → 保持 11:59', () => {
  const o = asapOrder(`${D}T11:59:00`)
  assert.strictEqual(paidAt(o, base, `${D}T11:44:00`), iso(`${D}T12:19:00`))
  assert.strictEqual(paidAt(o, base, `${D}T11:30:00`), iso(`${D}T11:59:00`))
})
t('A13 付款重算不看可用性（Q3=A）：原 14:25，paidAt 14:19 → 14:39 不封顶；叠加暂停 / 休业 / 营业时段不含 paidAt 结果都一样', () => {
  const o = asapOrder(`${D}T14:25:00`)
  const want = iso(`${D}T14:39:00`)
  assert.strictEqual(paidAt(o, base, `${D}T14:19:00`), want)
  assert.strictEqual(paidAt(o, { ...base, pickup: { ...base.pickup, paused: { until: null, reason: '忙' } } }, `${D}T14:19:00`), want)
  assert.strictEqual(paidAt(o, { ...base, holiday: { until: D, reason: '盘点' } }, `${D}T14:19:00`), want)
  assert.strictEqual(paidAt(o, { ...base, businessHours: [{ start: '17:00', end: '20:00' }] }, `${D}T14:19:00`), want)
})
t('A14 只作用于尽快单：预约自取、LOCAL 立即/预约、EXPRESS、pickupAt 为空 → 返回 null（调用方不写）', () => {
  const pay = sh(`${D}T11:29:00`)
  assert.strictEqual(asapPickupAtOnPaid({ deliveryType: 'PICKUP', pickupAsap: false, pickupAt: sh(`${D}T12:00:00`) }, base, pay, pay), null)
  assert.strictEqual(asapPickupAtOnPaid({ deliveryType: 'LOCAL', pickupAsap: false, pickupAt: null }, base, pay, pay), null)
  assert.strictEqual(asapPickupAtOnPaid({ deliveryType: 'LOCAL', pickupAsap: true, pickupAt: sh(`${D}T11:40:00`) }, base, pay, pay), null)
  assert.strictEqual(asapPickupAtOnPaid({ deliveryType: 'EXPRESS', pickupAsap: false, pickupAt: null }, base, pay, pay), null)
  assert.strictEqual(asapPickupAtOnPaid({ deliveryType: 'PICKUP', pickupAsap: true, pickupAt: null }, base, pay, pay), null)
})
t('A15 跨零点：营业 18:00–23:59，原 23:50，paidAt 23:44 → 次日 00:04；文案「尽快取 约 00:04」；票面不盖明日单戳、不出日期行', () => {
  const night = { ...base, businessHours: [{ start: '18:00', end: '23:59' }], peak: { ...base.peak, windows: [] } }
  const o = asapOrder(`${D}T23:50:00`)
  assert.strictEqual(paidAt(o, night, `${D}T23:44:00`), iso('2026-09-29T00:04:00'))
  const at = sh('2026-09-29T00:04:00')
  const now = sh(`${D}T23:44:00`)
  assert.strictEqual(pickupTimeLabel({ pickupAt: at, pickupAsap: true }, night, now), '尽快取 约 00:04')
  const f = pickupTicketFields(at, true, 30, now)
  assert.deepStrictEqual(f, { pickupAsap: true, pickupSlotLabel: '尽快取 约 00:04', pickupSlotDate: null, pickupSlotTime: null, pickupDayStamp: null })
  const tk = renderOrderTicket(ticketInput(at, true, now))
  assert.ok(tk.includes('<B>尽快取 约 00:04</B>') && !tk.includes('【') && !tk.includes('取餐 9月'), tk)
  // 对照：同一时刻若是预约单，票面照旧盖「明日单」
  assert.ok(renderOrderTicket(ticketInput(at, false, now)).includes('【明日单】'))
})
t('A16 锚点取 paidAt 与处理时刻中较晚者（原 11:40）', () => {
  const o = asapOrder(`${D}T11:40:00`)
  // (a) 回调晚到：按处理时刻 11:23:30 → ceil(11:43:30)=11:44（只用 success_time 会得 11:41）
  assert.strictEqual(paidAt(o, base, `${D}T11:20:10`, `${D}T11:23:30`), iso(`${D}T11:44:00`))
  // (b) 服务器时钟慢于微信：按 paidAt 11:25 → 11:45（只用处理时刻会得 11:42）
  assert.strictEqual(paidAt(o, base, `${D}T11:25:00`, `${D}T11:22:00`), iso(`${D}T11:45:00`))
  // (c) 高峰按锚点判：锚点 11:44 → 临时 12:04 在高峰 → 12:19（按 paidAt 11:30 判会得 11:50）
  assert.strictEqual(paidAt(o, base, `${D}T11:30:00`, `${D}T11:44:00`), iso(`${D}T12:19:00`))
  // (d) 两者相等与 A11 同值；非尽快单无论两个时刻怎么给都返回 null
  assert.strictEqual(paidAt(o, base, `${D}T11:29:00`, `${D}T11:29:00`), iso(`${D}T11:49:00`))
  assert.strictEqual(asapPickupAtOnPaid({ deliveryType: 'PICKUP', pickupAsap: false, pickupAt: sh(`${D}T11:40:00`) }, base, sh(`${D}T11:20:10`), sh(`${D}T11:59:00`)), null)
  assert.strictEqual(asapPickupAtOnPaid({ deliveryType: 'LOCAL', pickupAsap: false, pickupAt: null }, base, sh(`${D}T11:59:00`), sh(`${D}T11:20:10`)), null)
})

console.log(`\n${process.exitCode ? '有失败' : `全部通过 ${pass}`}`)
