/**
 * 预约送达票面放大行宽度自测（S7，2026-09-23）：
 *   cd apps/server && TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-ticket-schedule.ts
 *
 * 真机实测（SN 222601993，见 content.ts 的 BIG_LINE_WIDTH 注释）：`<B>` 放大一倍，一行只能放
 * 普通行一半的内容，可用宽度是 16 列（不是 32）。这份自测穷举三种会被塞进 <B> 的预约时刻文案，
 * 确认拆行之后没有一段超过 16 列，并用一条反例证明宽度函数本身能证伪（不是恒真断言）。
 */
import assert from 'assert'
import { renderOrderTicket, renderReadyDueTicket, strWidth, BIG_LINE_WIDTH, TicketOrderInput } from '../src/services/ticket/content'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}

/** 提取票面里所有 `<B>…</B>` 段的原文（不含标签本身） */
function bigSegments(ticket: string): string[] {
  return [...ticket.matchAll(/<B>([^<]*)<\/B>/g)].map((m) => m[1])
}
/**
 * 只校验本批（S7）新拆出来的那几段——收货人姓名/地址那两条 `<B>` 行是既有设计（PO 2026-09-06
 * 定：地址放大后允许折成 2–3 行，见 content.ts 收货人地址那段注释），不属于本批修复范围，
 * 混进「全票扫描」断言会把无关的既有行也一并判为失败，没有区分度。
 */
function assertScheduleBigSegmentsWithin(ticket: string, expected: string[], limit = BIG_LINE_WIDTH) {
  const segs = bigSegments(ticket)
  for (const text of expected) {
    assert.ok(segs.includes(text), `票面里应含 <B>${text}</B>，实际 <B> 段有：${segs.join(' | ')}`)
    assert.ok(strWidth(text) <= limit, `<B>${text}</B> 显示宽度 ${strWidth(text)} 超过 ${limit} 列`)
  }
}

const base: TicketOrderInput = {
  orderNo: 'ORD1', channel: 'LOCAL',
  createdAt: new Date('2026-10-22T02:00:00Z'), paidAt: new Date('2026-10-22T02:01:00Z'),
  items: [{ productName: '凉拌牛肉', specText: null, quantity: 2, subtotal: 5000 }],
  totalAmount: 5000, shippingFee: 500, actualAmount: 5500, remark: null,
  receiverName: '张三', receiverPhone: '13800001234', receiverFullAddress: '四川省自贡市自流井区丹桂40栋底楼',
  receiverDistrict: '自流井区', receiverDetail: '丹桂40栋底楼', receiverPoiName: null, distanceM: 3000,
  scheduledAt: new Date('2026-10-22T04:00:00Z'),
  // 与 slots.ticketLabel('2026-10-22T12:00 Asia/Shanghai', 30) 算出来的一致：
  // text='10月22日（周四）12:00–12:30'，date='10月22日（周四）'，time='12:00–12:30'
  scheduleSlotLabel: '10月22日（周四）12:00–12:30',
  scheduleSlotDate: '10月22日（周四）',
  scheduleSlotTime: '12:00–12:30',
  scheduleDayStamp: '10月22日单',
  schedulePrepStart: '11:16',
  scheduleCall: '11:36',
}

t('预约来单票：配送联/厨房联的放大时段行 ≤16 列；含普通日期行 + 放大时段行；仍含开始备餐/呼叫骑手时刻', () => {
  const ticket = renderOrderTicket(base)
  const [delivery, kitchen] = ticket.split('<CUT>')
  assert.ok(delivery.includes('送达 10月22日（周四）'), delivery)
  assertScheduleBigSegmentsWithin(delivery, ['12:00–12:30'])
  assert.ok(delivery.includes('开始备餐 11:16 · 呼叫骑手 11:36'), delivery)
  assert.ok(kitchen.includes('送达 10月22日（周四）'), kitchen)
  assertScheduleBigSegmentsWithin(kitchen, ['12:00–12:30'])
})

t('预约备餐票（prep.unaccepted=true）：<B>HH:mm 开始备餐</B>、<B>HH:mm 前备好</B> 两条独立行，含 [未接单]，全部 ≤16 列', () => {
  const ticket = renderOrderTicket({ ...base, prep: { unaccepted: true } })
  assertScheduleBigSegmentsWithin(ticket, ['11:16 开始备餐', '11:36 前备好'])
  assert.ok(ticket.includes('<CB>[未接单]</CB>'), ticket)
})

t('renderReadyDueTicket：<B>应于HH:mm前备好</B> ≤16 列', () => {
  const ticket = renderReadyDueTicket({ receiverPhone: '13800001234', slotLabel: '今天 12:00–12:30', call: '11:36', seq: 1 })
  assertScheduleBigSegmentsWithin(ticket, ['应于11:36前备好'])
})

t('反例：把老写法「送达 + 完整 scheduleSlotLabel」拼成一整段喂给宽度函数，应得 33（证明宽度函数本身能证伪，不是恒真断言）', () => {
  assert.strictEqual(strWidth(`送达 ${base.scheduleSlotLabel}`), 33)
})

// 店主决定 D3：自取票「取餐」同批一起拆行，不是本批必修但同法修，补一条覆盖
t('自取票（PICKUP）：取餐票同样拆成普通日期行 + 放大时段行，放大段 ≤16 列', () => {
  const pickup: TicketOrderInput = {
    ...base, channel: 'PICKUP', scheduledAt: null, distanceM: null,
    pickupAt: new Date('2026-09-12T04:00:00Z'),
    pickupSlotLabel: '9月12日（周六）12:00–12:30',
    pickupSlotDate: '9月12日（周六）',
    pickupSlotTime: '12:00–12:30',
  }
  const ticket = renderOrderTicket(pickup)
  const [receiptSide] = ticket.split('<CUT>')
  assert.ok(receiptSide.includes('取餐 9月12日（周六）'), receiptSide)
  assertScheduleBigSegmentsWithin(receiptSide, ['12:00–12:30'])
})

console.log(process.exitCode ? `有失败（通过 ${pass}）` : `全部通过 ${pass}`)
