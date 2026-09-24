import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moneyRows, refundedLineFlags, timelineNodes, backTargetFor, channelLabel, withLatestRefund, backLabelFor } from './order-detail.ts'
import type { RefundStatus } from '../types.ts'

const refundFixture = (status: RefundStatus, createdAt: string) => ({
  id: 1, status, outRefundNo: 'x', amount: 100, mode: 'MOCK' as const, errorMessage: null, createdAt,
  reason: null, operator: null, successTime: null, errorCode: null, afterSaleId: null,
})

test('withLatestRefund：取 refunds[0]（服务端已按 createdAt desc 排好）', () => {
  const o = { refunds: [refundFixture('PROCESSING', '2026-09-18T02:00:00Z'), refundFixture('FAILED', '2026-09-18T01:00:00Z')] }
  assert.equal(withLatestRefund(o).latestRefund!.status, 'PROCESSING')
})

test('withLatestRefund：refunds 为空数组 → null', () => {
  assert.equal(withLatestRefund({ refunds: [] }).latestRefund, null)
})

test('withLatestRefund：refunds 缺省 → null', () => {
  assert.equal(withLatestRefund({}).latestRefund, null)
})

test('backTargetFor / channelLabel', () => {
  assert.equal(backTargetFor('EXPRESS'), '/orders/express')
  assert.equal(backTargetFor('LOCAL'), '/orders/local')
  assert.equal(backTargetFor('PICKUP'), '/orders/local')
  assert.equal(channelLabel('LOCAL'), '同城外送')
  assert.equal(channelLabel('PICKUP'), '到店自取')
  assert.equal(channelLabel('EXPRESS'), '全国邮寄')
})

test('moneyRows：含打包费/自取优惠/满减/券/运费的单，顺序与小票一致；为 0 的行不出现；已退为 0 仍出现', () => {
  const o = {
    totalAmount: 10000,
    packingFee: 200,
    pickupDiscountAmount: 300,
    promoDiscountAmount: 500,
    discountAmount: 800,
    shippingFee: 600,
    actualAmount: 9200, // 10000 + 200 - 300 - 500 - 800 + 600 = 9200
    refundedAmount: 0,
    remainingRefundable: 9200,
    deliveryType: 'LOCAL',
    coupon: { name: '新人礼', code: 'X', amount: 800, threshold: 0, source: 'NEWCOMER' as const, issuedBy: null, remark: null },
  }
  const rows = moneyRows(o)
  assert.deepEqual(rows.map((r) => r.key), ['subtotal', 'packing', 'pickupDiscount', 'promo', 'coupon', 'shipping', 'actual', 'refunded', 'remaining'])

  // ① 逐行断言 fen——不只断 key 顺序：把满减/券的 fen 互换、或哪一行算错了金额，这里都要能抓到
  // （原先的「sum 全由夹具字段相加」自洽检查，sum 与 rows 完全无关，改哪行都不会红）。
  const byKey = (k: string) => rows.find((r) => r.key === k)!.fen
  assert.equal(byKey('subtotal'), 10000)
  assert.equal(byKey('packing'), 200)
  assert.equal(byKey('pickupDiscount'), 300)
  assert.equal(byKey('promo'), 500)
  assert.equal(byKey('coupon'), 800)
  assert.equal(byKey('shipping'), 600)
  assert.equal(byKey('actual'), 9200)
  assert.equal(byKey('refunded'), 0)
  assert.equal(byKey('remaining'), 9200)

  // ② 按 kind 带符号求和，必须真的等于 actual 那一行——不是各自摆对了数就算过
  const signedSum = rows
    .filter((r) => r.kind === 'plus' || r.kind === 'minus')
    .filter((r) => r.key !== 'refunded') // refunded 是「已退」，不参与「实付怎么算出来的」这条链
    .reduce((s, r) => s + (r.kind === 'plus' ? r.fen : -r.fen), 0)
  assert.equal(signedSum, byKey('actual'))

  // ③ remaining/refunded 必须真的读自订单字段，不是巧合对上
  assert.equal(byKey('remaining'), o.remainingRefundable)
  assert.equal(byKey('refunded'), o.refundedAmount)
})

test('moneyRows：部分退款——已退/还可退分别读自 refundedAmount/remainingRefundable', () => {
  const o = {
    totalAmount: 10000, packingFee: 200, pickupDiscountAmount: 300, promoDiscountAmount: 500, discountAmount: 800,
    shippingFee: 600, actualAmount: 9200, refundedAmount: 6000, remainingRefundable: 3200,
    deliveryType: 'LOCAL', coupon: null,
  }
  const rows = moneyRows(o)
  assert.equal(rows.find((r) => r.key === 'refunded')!.fen, 6000)
  assert.equal(rows.find((r) => r.key === 'remaining')!.fen, 3200)
})

test('moneyRows：为 0 的优惠/费用行不出现', () => {
  const o = {
    totalAmount: 5000, packingFee: 0, pickupDiscountAmount: 0, promoDiscountAmount: 0, discountAmount: 0,
    shippingFee: 800, actualAmount: 5800, refundedAmount: 0, remainingRefundable: 5800, deliveryType: 'EXPRESS', coupon: null,
  }
  const rows = moneyRows(o)
  assert.deepEqual(rows.map((r) => r.key), ['subtotal', 'shipping', 'actual', 'refunded', 'remaining'])
})

test('moneyRows：自取单没有运费行', () => {
  const o = {
    totalAmount: 3000, packingFee: 0, pickupDiscountAmount: 0, promoDiscountAmount: 0, discountAmount: 0,
    shippingFee: 0, actualAmount: 3000, refundedAmount: 0, remainingRefundable: 3000, deliveryType: 'PICKUP', coupon: null,
  }
  const rows = moneyRows(o)
  assert.ok(!rows.some((r) => r.key === 'shipping'))
})

test('refundedLineFlags：全额退 → 付费行全 true、赠品行 false', () => {
  const o = {
    items: [
      { productName: 'A', productImage: null, quantity: 1, productPrice: 1000, subtotal: 1000 },
      { productName: '赠品', productImage: null, quantity: 1, productPrice: 0, subtotal: 0, isGift: true },
    ],
    refundedAmount: 1000,
    actualAmount: 1000,
  }
  assert.deepEqual(refundedLineFlags(o), [true, false])
})

test('refundedLineFlags：部分退 → 全 false', () => {
  const o = {
    items: [{ productName: 'A', productImage: null, quantity: 1, productPrice: 1000, subtotal: 1000 }],
    refundedAmount: 300,
    actualAmount: 1000,
  }
  assert.deepEqual(refundedLineFlags(o), [false])
})

test('refundedLineFlags：未退 → 全 false', () => {
  const o = {
    items: [{ productName: 'A', productImage: null, quantity: 1, productPrice: 1000, subtotal: 1000 }],
    refundedAmount: 0,
    actualAmount: 1000,
  }
  assert.deepEqual(refundedLineFlags(o), [false])
})

const baseOrder = {
  deliveryType: 'LOCAL',
  status: 'COMPLETED' as const,
  createdAt: '2026-09-18T01:00:00Z',
  paidAt: '2026-09-18T01:05:00Z',
  payment: { paymentType: 'WECHAT' as const, paidAt: '2026-09-18T01:05:00Z' },
  cancelRequestedAt: null,
  cancelRequestNote: null,
  acceptedAt: null as string | null,
  pickupReadyAt: null,
  completedAt: '2026-09-18T02:00:00Z',
  cancelledAt: null,
  cancelReason: null,
  shipment: null,
  refunds: [],
  afterSales: [],
}

test('timelineNodes：acceptedAt 为 null 时没有「接单」', () => {
  const nodes = timelineNodes(baseOrder, {})
  assert.ok(!nodes.some((n) => n.label === '接单'))
})

test('timelineNodes：节点按时间升序', () => {
  const nodes = timelineNodes({ ...baseOrder, acceptedAt: '2026-09-18T01:10:00Z' }, {})
  const times = nodes.map((n) => new Date(n.at).getTime())
  assert.deepEqual(times, [...times].sort((a, b) => a - b))
})

test('timelineNodes：退款失败节点 tone bad', () => {
  const nodes = timelineNodes(
    { ...baseOrder, refunds: [{ id: 1, status: 'FAILED', outRefundNo: 'x', amount: 500, mode: 'MOCK', errorMessage: 'boom', createdAt: '2026-09-18T03:00:00Z', reason: '拍错了', operator: '店员小王', successTime: null, errorCode: null, afterSaleId: null }] },
    {}
  )
  const n = nodes.find((x) => x.label.startsWith('退款失败'))
  assert.ok(n)
  assert.equal(n!.tone, 'bad')
})

test('timelineNodes：CLOSED 退款单独标注「退款关闭」，tone muted，不与「退款处理中」混同', () => {
  const nodes = timelineNodes(
    { ...baseOrder, refunds: [{ id: 1, status: 'CLOSED', outRefundNo: 'x', amount: 500, mode: 'MOCK', errorMessage: null, createdAt: '2026-09-18T03:00:00Z', reason: '超时关闭', operator: '系统', successTime: null, errorCode: null, afterSaleId: null }] },
    {}
  )
  const n = nodes.find((x) => x.label.startsWith('退款关闭'))
  assert.ok(n)
  assert.equal(n!.tone, 'muted')
  assert.ok(!nodes.some((x) => x.label.startsWith('退款处理中')))
})

test('timelineNodes：同城单不出现「已发货」', () => {
  const nodes = timelineNodes(baseOrder, {})
  assert.ok(!nodes.some((n) => n.label === '已发货'))
})

test('timelineNodes：自取单不出现「已完成」而出现「已取走」', () => {
  const nodes = timelineNodes({ ...baseOrder, deliveryType: 'PICKUP', status: 'COMPLETED' }, {})
  assert.ok(!nodes.some((n) => n.label === '已完成'))
  assert.ok(nodes.some((n) => n.label === '已取走'))
})

test('backLabelFor：/users 开头（含查询参数）→ 返回用户管理', () => {
  assert.equal(backLabelFor('/users?kw=x&orders=5'), '返回用户管理')
})

test('backLabelFor：/orders/local 开头 → 返回同城订单', () => {
  assert.equal(backLabelFor('/orders/local?status=PAID'), '返回同城订单')
})

test('backLabelFor：/orders/express → 返回全国邮寄', () => {
  assert.equal(backLabelFor('/orders/express'), '返回全国邮寄')
})

test('backLabelFor：认不出的地址 → 退回全国邮寄', () => {
  assert.equal(backLabelFor('/somewhere'), '返回全国邮寄')
})
