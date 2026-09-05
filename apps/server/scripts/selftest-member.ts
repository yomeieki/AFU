/**
 * 会员积分/优惠券纯函数自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-member.ts
 *   （或 npx tsx scripts/selftest-member.ts）
 *
 * 覆盖 spec §9「纯函数自测」：calcEarn 取整、calcRefundDeduct 扣回上限公式、
 * 优惠券 code 生成唯一性。
 */
import assert from 'assert'
import { calcEarn, calcRefundDeduct } from '../src/services/member/points'
import { generateCouponCode } from '../src/services/member/coupons'

let pass = 0
function t(name: string, fn: () => void) {
  try {
    fn()
    pass++
    console.log('  ✔', name)
  } catch (e) {
    console.error('  ✘', name, '\n    ', (e as Error).message)
    process.exitCode = 1
  }
}

// ── calcEarn：Math.floor(max(0, actual-refunded)/100) * rate ──────────────

t('calcEarn 金额 0 → 0 分', () => {
  assert.strictEqual(calcEarn(0, 0, 1), 0)
})
t('calcEarn 金额 99 分 → 0 分（不足 1 元不得分）', () => {
  assert.strictEqual(calcEarn(99, 0, 1), 0)
})
t('calcEarn 金额 100 分 → 1 分', () => {
  assert.strictEqual(calcEarn(100, 0, 1), 1)
})
t('calcEarn 金额 250 分 rate=2 → 4 分（2元*2倍，取整不进位）', () => {
  assert.strictEqual(calcEarn(250, 0, 2), 4)
})
t('calcEarn 已退款超过实付 → 0 分（不倒扣负数）', () => {
  assert.strictEqual(calcEarn(1000, 1500, 1), 0)
})
t('calcEarn 部分退款后按剩余实付算', () => {
  assert.strictEqual(calcEarn(1000, 300, 1), 7) // (1000-300)/100=7
})

// ── calcRefundDeduct：min(比例应扣, 该单还剩多少没扣, 用户当前余额)，不小于 0 ──

t('calcRefundDeduct 正常部分退款：按比例扣', () => {
  // 退 500 分(=5元) * rate 1 = 5，该单发过 100 分未扣过，余额 100 → 扣 5
  assert.strictEqual(calcRefundDeduct(500, 1, 100, 0, 100), 5)
})
t('calcRefundDeduct 上限①：比例应扣超过该单剩余可扣（连续两次部分退款不超发放量）', () => {
  // 该单发了 100 分，已扣回 98，这次退款按比例该扣 10，但只剩 2 可扣
  assert.strictEqual(calcRefundDeduct(1000, 1, 100, 98, 1000), 2)
})
t('calcRefundDeduct 上限②：超过用户当前总余额（已经花掉了，扣到 0 为止的上游保护）', () => {
  // 该单发了 100 分全没扣过，按比例该扣 100，但用户只剩 30（已被别的地方花掉）
  assert.strictEqual(calcRefundDeduct(10000, 1, 100, 0, 30), 30)
})
t('calcRefundDeduct 三重上限各自触顶：同时触发也不为负', () => {
  assert.strictEqual(calcRefundDeduct(100000, 5, 50, 50, 999), 0) // 该单已扣完
  assert.strictEqual(calcRefundDeduct(100000, 5, 50, 0, 0), 0) // 用户余额已是 0
})
t('calcRefundDeduct 退款金额 0 → 0', () => {
  assert.strictEqual(calcRefundDeduct(0, 1, 100, 0, 100), 0)
})

// ── 优惠券 code 生成：格式 + 大量生成不重复 ────────────────────────────────

t('generateCouponCode 格式为 C + 8 位 Crockford base32', () => {
  const code = generateCouponCode()
  assert.match(code, /^C[0-9A-HJKMNP-TV-Z]{8}$/)
})
t('generateCouponCode 一万次生成唯一性（碰撞概率验证，非穷举证明）', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 10000; i++) {
    const code = generateCouponCode()
    assert.ok(!seen.has(code), `重复生成: ${code}`)
    seen.add(code)
  }
})

console.log(`\n${pass} passed${process.exitCode ? ', 有失败' : ''}`)
