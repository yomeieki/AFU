import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moneyRows, refundedLineFlags, timelineNodes, backTargetFor, channelLabel } from './order-detail.ts'

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
  assert.equal(rows.find((r) => r.key === 'refunded')!.fen, 0)
  const sum = o.totalAmount + o.packingFee - o.pickupDiscountAmount - o.promoDiscountAmount - o.discountAmount + o.shippingFee
  assert.equal(sum, o.actualAmount)
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

test('timelineNodes：同城单不出现「已发货」', () => {
  const nodes = timelineNodes(baseOrder, {})
  assert.ok(!nodes.some((n) => n.label === '已发货'))
})

test('timelineNodes：自取单不出现「已完成」而出现「已取走」', () => {
  const nodes = timelineNodes({ ...baseOrder, deliveryType: 'PICKUP', status: 'COMPLETED' }, {})
  assert.ok(!nodes.some((n) => n.label === '已完成'))
  assert.ok(nodes.some((n) => n.label === '已取走'))
})
