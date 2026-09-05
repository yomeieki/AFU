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

// ── calcRefundDeduct（B5）：累计目标(targetCum) − 已扣，与 earnRatePerYuan 无关 ──
// 签名：calcRefundDeduct(pointsEarned, pointsBase, actualAmount, refundedAmount, alreadyDeducted, balance)
// base = pointsBase>0 ? pointsBase : actualAmount；cumRef = max(0, refundedAmount+base-actualAmount)；
// targetCum = floor(pointsEarned*cumRef/base)；返回 max(0, min(targetCum-alreadyDeducted, pointsEarned-alreadyDeducted, balance))

t('calcRefundDeduct 正常部分退款：按比例扣（累计口径）', () => {
  // 结算基数 ¥100(10000分)，发了 100 分；本次退款后累计退了 ¥5(500分) → 应扣 5
  assert.strictEqual(calcRefundDeduct(100, 10000, 10000, 500, 0, 100), 5)
})
t('calcRefundDeduct 累计公式：分三次退款打满，累计恰好等于 pointsEarned（逐笔 floor 会少扣 1）', () => {
  // ¥100 得 100 分，分三次退 ¥33.33/33.33/33.34（凑整 ¥100），累计应精确扣满 100 分，不多不少
  let deducted = 0
  deducted += calcRefundDeduct(100, 10000, 10000, 3333, deducted, 1000) // → 33，累计 33
  assert.strictEqual(deducted, 33)
  deducted += calcRefundDeduct(100, 10000, 10000, 6666, deducted, 1000) // → 33，累计 66
  assert.strictEqual(deducted, 66)
  deducted += calcRefundDeduct(100, 10000, 10000, 10000, deducted, 1000) // → 34，累计 100（打满）
  assert.strictEqual(deducted, 100)
})
t('calcRefundDeduct 上限①：该单已扣完（pointsEarned-alreadyDeducted 封顶）', () => {
  assert.strictEqual(calcRefundDeduct(50, 5000, 5000, 5000, 50, 999), 0)
})
t('calcRefundDeduct 上限②：超过用户当前总余额（已经花掉了，扣到 0 为止的上游保护）', () => {
  // 全额退款该扣 100，但用户只剩 30（已被别的地方花掉）
  assert.strictEqual(calcRefundDeduct(100, 100, 100, 100, 0, 30), 30)
})
t('calcRefundDeduct 用户余额已是 0 → 0', () => {
  assert.strictEqual(calcRefundDeduct(50, 5000, 5000, 0, 0, 0), 0)
})
t('calcRefundDeduct 退款额 0（未发生退款）→ 0', () => {
  assert.strictEqual(calcRefundDeduct(100, 10000, 10000, 0, 0, 100), 0)
})
t('calcRefundDeduct 旧单退化：pointsBase=null 时用 actualAmount 当基数', () => {
  assert.strictEqual(calcRefundDeduct(100, null, 10000, 1000, 0, 100), 10)
})
t('calcRefundDeduct 边界 base<=0：退化为直接按 pointsEarned 扣（不除以 0）', () => {
  assert.strictEqual(calcRefundDeduct(100, 0, 0, 0, 0, 50), 50)
})
t('calcRefundDeduct 与 earnRatePerYuan 无关：结算前后改比例不影响扣回（B5 核心场景）', () => {
  // ¥100 结算时 rate=1 得 100 分；之后把 rate 改成 100 不影响任何已发生的订单——
  // calcRefundDeduct 压根不接收 rate 参数，这条用例确认签名上就切断了这个耦合
  assert.strictEqual(calcRefundDeduct(100, 10000, 10000, 100, 0, 100), 1)
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
