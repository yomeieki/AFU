import { test } from 'node:test'
import assert from 'node:assert/strict'
import { everPaid, canRefund, hasActiveRefund, refundLabel, canReprint, canIssueCoupon, refundRetryLabel, refundingHint, canApproveAfterSaleRefund } from './order-actions.ts'

test('canRefund：没付款就取消的单（还可退金额>0）→ false，这就是 2026-09-22 同城页的 bug', () => {
  assert.equal(canRefund({ status: 'CANCELLED', remainingRefundable: 6210 }), false)
})

test('canRefund：待付款 → false', () => {
  assert.equal(canRefund({ status: 'PENDING_PAYMENT', remainingRefundable: 3410 }), false)
})

test('canRefund：PAID/PREPARING/SHIPPED/COMPLETED 且有余额 → true', () => {
  for (const status of ['PAID', 'PREPARING', 'SHIPPED', 'COMPLETED']) {
    assert.equal(canRefund({ status, remainingRefundable: 100 }), true, status)
  }
})

test('canRefund：可退状态但余额为 0（已全退）→ false', () => {
  assert.equal(canRefund({ status: 'COMPLETED', remainingRefundable: 0 }), false)
})

test('canRefund：REFUNDING / REFUNDED 不走这个按钮（REFUNDING 由页面另画「重试退款」）', () => {
  assert.equal(canRefund({ status: 'REFUNDING', remainingRefundable: 100 }), false)
  assert.equal(canRefund({ status: 'REFUNDED', remainingRefundable: 0 }), false)
})

test('hasActiveRefund：PENDING/PROCESSING/ABNORMAL → true；SUCCESS/FAILED/无记录 → false', () => {
  for (const status of ['PENDING', 'PROCESSING', 'ABNORMAL']) {
    assert.equal(hasActiveRefund({ latestRefund: { status } }), true, status)
  }
  assert.equal(hasActiveRefund({ latestRefund: { status: 'SUCCESS' } }), false)
  assert.equal(hasActiveRefund({ latestRefund: { status: 'FAILED' } }), false)
  assert.equal(hasActiveRefund({ latestRefund: null }), false)
  assert.equal(hasActiveRefund({}), false)
})

test('refundLabel：退过一部分叫「再退款」', () => {
  assert.equal(refundLabel({ refundedAmount: 0 }), '退款')
  assert.equal(refundLabel({ refundedAmount: 1 }), '再退款')
})

test('everPaid / canReprint：待付款与已取消 → false，其余 → true', () => {
  assert.equal(everPaid({ status: 'PENDING_PAYMENT' }), false)
  assert.equal(everPaid({ status: 'CANCELLED' }), false)
  assert.equal(canReprint({ status: 'CANCELLED' }), false)
  for (const status of ['PAID', 'PREPARING', 'SHIPPED', 'COMPLETED', 'REFUNDING', 'REFUNDED']) {
    assert.equal(everPaid({ status }), true, status)
    assert.equal(canReprint({ status }), true, status)
  }
})

test('canIssueCoupon：要有 userId 且付过钱', () => {
  assert.equal(canIssueCoupon({ status: 'COMPLETED', userId: 7 }), true)
  assert.equal(canIssueCoupon({ status: 'COMPLETED' }), false)
  assert.equal(canIssueCoupon({ status: 'CANCELLED', userId: 7 }), false)
  assert.equal(canIssueCoupon({ status: 'PENDING_PAYMENT', userId: 7 }), false)
})

test('refundRetryLabel：有记录「重试退款」，没记录「发起退款」', () => {
  assert.equal(refundRetryLabel({ latestRefund: { status: 'FAILED' } }), '重试退款')
  assert.equal(refundRetryLabel({ latestRefund: null }), '发起退款')
  assert.equal(refundRetryLabel({}), '发起退款')
})

test('refundingHint：处理中 / 异常 / 其余为空', () => {
  assert.equal(refundingHint({ latestRefund: { status: 'PROCESSING' } }), '微信处理中')
  assert.equal(refundingHint({ latestRefund: { status: 'ABNORMAL' } }), '退款异常')
  assert.equal(refundingHint({ latestRefund: { status: 'CLOSED' } }), null)
  assert.equal(refundingHint({ latestRefund: null }), null)
})

test('canApproveAfterSaleRefund：余额>0、可退状态、无在途退款 → true', () => {
  assert.equal(canApproveAfterSaleRefund({ status: 'COMPLETED', remainingRefundable: 100, latestRefund: null }), true)
  assert.equal(canApproveAfterSaleRefund({ status: 'SHIPPED', remainingRefundable: 100, latestRefund: { status: 'SUCCESS' } }), true)
})

test('canApproveAfterSaleRefund：有在途退款（PENDING/PROCESSING/ABNORMAL）→ false，服务端会 42205', () => {
  for (const status of ['PENDING', 'PROCESSING', 'ABNORMAL']) {
    assert.equal(canApproveAfterSaleRefund({ status: 'COMPLETED', remainingRefundable: 100, latestRefund: { status } }), false, status)
  }
})

test('canApproveAfterSaleRefund：REFUNDING 且退款已 CLOSED/FAILED → true（允许经售后全额重试）', () => {
  assert.equal(canApproveAfterSaleRefund({ status: 'REFUNDING', remainingRefundable: 100, latestRefund: { status: 'CLOSED' } }), true)
  assert.equal(canApproveAfterSaleRefund({ status: 'REFUNDING', remainingRefundable: 100, latestRefund: { status: 'FAILED' } }), true)
})

test('canApproveAfterSaleRefund：余额 0 / 已退款 / 已取消 → false', () => {
  assert.equal(canApproveAfterSaleRefund({ status: 'COMPLETED', remainingRefundable: 0, latestRefund: null }), false)
  assert.equal(canApproveAfterSaleRefund({ status: 'REFUNDED', remainingRefundable: 0, latestRefund: { status: 'SUCCESS' } }), false)
  assert.equal(canApproveAfterSaleRefund({ status: 'CANCELLED', remainingRefundable: 100, latestRefund: null }), false)
})
