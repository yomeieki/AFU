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
import { checkCouponUsable, computeCheckout } from '../src/services/member/pricing'

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

// ── 计价矩阵（M2 Task 2）───────────────────────────────────────────────────
//
// 这一段测的是 spec §5.1 的计费顺序里**券那一步**，以及可用性判定。
// 两个函数都是纯的：不碰 DB、不抛 AppError——结构化返回，抛错留给路由层。
// 这样这段自测才能不起数据库、不起服务就跑完。

const FAR = new Date(Date.now() + 86400_000)   // 明天到期
const GONE = new Date(Date.now() - 1000)        // 1 秒前过期
const mk = (o: Partial<Parameters<typeof checkCouponUsable>[0]> = {}) => ({
  userId: 1, amount: 1000, threshold: 0, channel: 'ALL' as const,
  status: 'UNUSED', expiresAt: FAR, ...o,
})
const ctx = (o: Partial<Parameters<typeof checkCouponUsable>[1]> = {}) => ({
  userId: 1, channel: 'EXPRESS' as const, subtotal: 5000, ...o,
})

t('券金额 < 小计 → discount = 券面额', () => {
  const r = checkCouponUsable(mk({ amount: 1000 }), ctx({ subtotal: 5000 }))
  assert.deepStrictEqual(r, { usable: true, discount: 1000 })
})
t('券金额 == 小计 → discount = 小计（把商品减到 0，允许）', () => {
  const r = checkCouponUsable(mk({ amount: 5000 }), ctx({ subtotal: 5000 }))
  assert.deepStrictEqual(r, { usable: true, discount: 5000 })
})
t('券金额 > 小计 → discount 封顶到小计，不产生负数', () => {
  const r = checkCouponUsable(mk({ amount: 9900 }), ctx({ subtotal: 5000 }))
  assert.deepStrictEqual(r, { usable: true, discount: 5000 })
})

t('门槛刚好等于小计 → 可用（边界取 >=，不是 >）', () => {
  const r = checkCouponUsable(mk({ threshold: 5000 }), ctx({ subtotal: 5000 }))
  assert.strictEqual(r.usable, true)
})
t('门槛比小计多 1 分 → 不可用，消息带两个金额', () => {
  const r = checkCouponUsable(mk({ threshold: 5001 }), ctx({ subtotal: 5000 }))
  assert.strictEqual(r.usable, false)
  assert.strictEqual(r.usable === false && r.reason, 'THRESHOLD')
  assert.ok(r.usable === false && r.message.includes('50.01') && r.message.includes('50.00'),
    `消息要同时给出门槛与当前小计，实际: ${r.usable === false ? r.message : ''}`)
})

t('ALL 券在 EXPRESS 单可用', () => {
  assert.strictEqual(checkCouponUsable(mk({ channel: 'ALL' }), ctx({ channel: 'EXPRESS' })).usable, true)
})
t('ALL 券在 LOCAL 单可用', () => {
  assert.strictEqual(checkCouponUsable(mk({ channel: 'ALL' }), ctx({ channel: 'LOCAL' })).usable, true)
})
t('LOCAL 券在 EXPRESS 单不可用，文案说的是「仅限同城」', () => {
  const r = checkCouponUsable(mk({ channel: 'LOCAL' }), ctx({ channel: 'EXPRESS' }))
  assert.strictEqual(r.usable === false && r.reason, 'CHANNEL')
  assert.ok(r.usable === false && r.message.includes('同城'), '文案要指明是哪一边')
})
t('EXPRESS 券在 LOCAL 单不可用，文案说的是「仅限全国邮寄」', () => {
  const r = checkCouponUsable(mk({ channel: 'EXPRESS' }), ctx({ channel: 'LOCAL' }))
  assert.strictEqual(r.usable === false && r.reason, 'CHANNEL')
  assert.ok(r.usable === false && r.message.includes('邮寄'), '文案要指明是哪一边')
})

t('过期 1 秒 → 不可用', () => {
  const r = checkCouponUsable(mk({ expiresAt: GONE }), ctx())
  assert.strictEqual(r.usable === false && r.reason, 'EXPIRED')
})
t('过期判定用传入的 now，不用系统时间（可测性）', () => {
  const r = checkCouponUsable(mk({ expiresAt: FAR }), ctx({ now: new Date(FAR.getTime() + 1) }))
  assert.strictEqual(r.usable === false && r.reason, 'EXPIRED')
})
t('已使用 → 不可用', () => {
  const r = checkCouponUsable(mk({ status: 'USED' }), ctx())
  assert.strictEqual(r.usable === false && r.reason, 'USED')
})
t('不属于当前用户 → NOT_OWNER，且消息不暴露「这张券存在但不是你的」', () => {
  const r = checkCouponUsable(mk({ userId: 2 }), ctx({ userId: 1 }))
  assert.strictEqual(r.usable === false && r.reason, 'NOT_OWNER')
  assert.ok(r.usable === false && !r.message.includes('不属于'), '不能泄露归属信息')
})

// 判定优先级要钉死：一张既过期、渠道又不符、还没到门槛的券，报哪一个是确定的。
// 顺序 NOT_OWNER → USED → EXPIRED → CHANNEL → THRESHOLD：
// 归属是安全检查排头；再看券自身状态（用过/过期，顾客无法补救）；最后才是与本单相关的
// 渠道与门槛（顾客换个单就能用，属于「可补救」）。不定死顺序，文案会随实现漂移。
t('优先级：归属 > 已用', () => {
  const r = checkCouponUsable(mk({ userId: 2, status: 'USED' }), ctx({ userId: 1 }))
  assert.strictEqual(r.usable === false && r.reason, 'NOT_OWNER')
})
t('优先级：已用 > 过期', () => {
  const r = checkCouponUsable(mk({ status: 'USED', expiresAt: GONE }), ctx())
  assert.strictEqual(r.usable === false && r.reason, 'USED')
})
t('优先级：过期 > 渠道不符', () => {
  const r = checkCouponUsable(mk({ expiresAt: GONE, channel: 'LOCAL' }), ctx({ channel: 'EXPRESS' }))
  assert.strictEqual(r.usable === false && r.reason, 'EXPIRED')
})
t('优先级：渠道不符 > 未达门槛', () => {
  const r = checkCouponUsable(mk({ channel: 'LOCAL', threshold: 99999 }), ctx({ channel: 'EXPRESS' }))
  assert.strictEqual(r.usable === false && r.reason, 'CHANNEL')
})

// ── computeCheckout：只做一件事，subtotal − discount + shippingFee ──────────

t('computeCheckout 无券无运费', () => {
  assert.deepStrictEqual(computeCheckout({ subtotal: 5000, discount: 0, shippingFee: 0 }), { actualAmount: 5000 })
})
t('computeCheckout 有运费', () => {
  assert.deepStrictEqual(computeCheckout({ subtotal: 5000, discount: 1000, shippingFee: 300 }), { actualAmount: 4300 })
})
t('computeCheckout 券把商品减到 0 但有运费 → 实付 = 运费（允许，不是错误）', () => {
  assert.deepStrictEqual(computeCheckout({ subtotal: 5000, discount: 5000, shippingFee: 300 }), { actualAmount: 300 })
})
t('computeCheckout 实付为 0 时只算数、不抛——拒单是调用方的事', () => {
  assert.deepStrictEqual(computeCheckout({ subtotal: 5000, discount: 5000, shippingFee: 0 }), { actualAmount: 0 })
})
t('computeCheckout discount > subtotal 是调用方的 bug，直接抛', () => {
  assert.throws(() => computeCheckout({ subtotal: 1000, discount: 1001, shippingFee: 0 }))
})

console.log(`\n${pass} passed${process.exitCode ? ', 有失败' : ''}`)
