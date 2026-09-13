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
import { renderOrderTicket } from '../src/services/ticket/content'

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

// ── computeCheckout：自取优惠（spec 2026-09-11 P6：小计 → 自取优惠 → 券 → 实付）──
t('computeCheckout 自取优惠先扣，再扣券', () => {
  assert.deepStrictEqual(computeCheckout({ subtotal: 5000, discount: 500, shippingFee: 0, pickupDiscount: 250 }), { actualAmount: 4250 })
})
t('computeCheckout 不传 pickupDiscount 与传 0 逐字节一致', () => {
  assert.deepStrictEqual(computeCheckout({ subtotal: 5000, discount: 500, shippingFee: 600 }), computeCheckout({ subtotal: 5000, discount: 500, shippingFee: 600, pickupDiscount: 0 }))
})
t('computeCheckout 自取优惠 + 券 超过小计 → 抛（调用方没封顶）', () => {
  assert.throws(() => computeCheckout({ subtotal: 1000, discount: 900, shippingFee: 0, pickupDiscount: 200 }))
})
t('computeCheckout 自取优惠为负 → 抛', () => {
  assert.throws(() => computeCheckout({ subtotal: 1000, discount: 0, shippingFee: 0, pickupDiscount: -1 }))
})

// ── computeCheckout：打包费（2026-09-13 打包费设计 §2.4：与 shippingFee 同层相加）──
t('computeCheckout 打包费与运费同层相加', () => {
  assert.deepStrictEqual(computeCheckout({ subtotal: 5000, discount: 500, shippingFee: 300, packingFee: 200 }), { actualAmount: 5000 - 500 + 300 + 200 })
})
t('computeCheckout 不传 packingFee 与传 0 逐字节一致', () => {
  assert.deepStrictEqual(computeCheckout({ subtotal: 5000, discount: 500, shippingFee: 300 }), computeCheckout({ subtotal: 5000, discount: 500, shippingFee: 300, packingFee: 0 }))
})
t('computeCheckout 打包费为负 → 抛', () => {
  assert.throws(() => computeCheckout({ subtotal: 1000, discount: 0, shippingFee: 0, packingFee: -1 }))
})

// ── 票面：优惠与赠品的两联分工（M2 Task 9）────────────────────────────────
//
// 这个项目**没有任何小票的自动化测试**——apps/server/scripts/ 下没有 ticket selftest，
// e2e §35 是通过 API 断言 PrintJob.content。而 content.ts 是纯渲染、零 DB 依赖，
// 完全可以在这里直接 import 来断言，代价接近零。
//
// 锁的是 PO 2026-09-06 定的分工：配送联印全部；**厨房联只有菜品和数量**，
// 赠品要出现（它是一道要做的菜），但不印优惠不印金额。

const mkTicket = (o: Partial<Parameters<typeof renderOrderTicket>[0]> = {}) =>
  renderOrderTicket({
    orderNo: 'ORD20260906123456', channel: 'LOCAL',
    createdAt: new Date('2026-09-06T02:00:00Z'), paidAt: new Date('2026-09-06T02:00:00Z'),
    receiverName: '王女士', receiverPhone: '13905710042',
    receiverDistrict: '西湖区', receiverDetail: '文三路123号',
    receiverPoiName: null, receiverFullAddress: '浙江省杭州市西湖区文三路123号',
    distanceM: null, estimatedDeliveryAt: null, remark: null,
    discountAmount: 1000, pointsUsed: 160,
    items: [
      { productName: '凉拌黑木耳', specText: null, quantity: 2, subtotal: 2400 },
      { productName: '口水鸡', specText: null, quantity: 2, subtotal: 0, isGift: true, pointsCost: 80 },
    ],
    totalAmount: 2400, shippingFee: 300, actualAmount: 1700,
    ...o,
  })
/** 同城票是双联：第一个 <CUT> 之前是配送联，之后是厨房联 */
const slips = (s: string) => { const p = s.split('<CUT>'); return { delivery: p[0], kitchen: p[1] ?? '' } }

t('票面：同城是双联（两个 <CUT>）', () => {
  assert.strictEqual((mkTicket().match(/<CUT>/g) ?? []).length, 2)
})
t('票面：邮寄是单联', () => {
  assert.strictEqual((mkTicket({ channel: 'EXPRESS' }).match(/<CUT>/g) ?? []).length, 1)
})
t('配送联：打「优惠券：−¥10.00」', () => {
  assert.ok(slips(mkTicket()).delivery.includes('优惠券：−¥10.00'))
})
t('配送联：打「赠品抵扣：160 积分」', () => {
  assert.ok(slips(mkTicket()).delivery.includes('赠品抵扣：160 积分'))
})
t('配送联：赠品行带「赠 」标', () => {
  assert.ok(slips(mkTicket()).delivery.includes('赠 口水鸡'))
})
t('配送联：赠品金额列显示积分而不是 ¥0.00（否则打包员以为漏收钱）', () => {
  const d = slips(mkTicket()).delivery
  assert.ok(d.includes('积分160'), '应显示 积分160')
  assert.ok(!d.includes('¥0.00'), '不该出现 ¥0.00')
})
t('厨房联：赠品行也带「赠 」标（是一道要做的菜，漏标就漏发）', () => {
  assert.ok(slips(mkTicket()).kitchen.includes('赠 口水鸡'))
})
t('厨房联：**一个金额都没有**（不含 ¥）', () => {
  assert.ok(!slips(mkTicket()).kitchen.includes('¥'))
})
t('厨房联：不含「优惠券」', () => {
  assert.ok(!slips(mkTicket()).kitchen.includes('优惠券'))
})
t('厨房联：不含「实付」「合计」', () => {
  const k = slips(mkTicket()).kitchen
  assert.ok(!k.includes('实付') && !k.includes('合计'))
})
t('无券无赠品时，优惠两行都不打（不留空行）', () => {
  const d = slips(mkTicket({ discountAmount: 0, pointsUsed: 0, items: [{ productName: '凉拌黑木耳', specText: null, quantity: 2, subtotal: 2400 }] })).delivery
  assert.ok(!d.includes('优惠券') && !d.includes('赠品抵扣'))
})
t('两联用同一个赠品标记（不一致会让店员对着两张写法不同的票核对）', () => {
  const s = slips(mkTicket())
  const mark = '赠 '
  assert.ok(s.delivery.includes(mark) && s.kitchen.includes(mark))
})

t('自取小票：票头「到店自取」、取餐时间放大、不印地址/距离/运费、印自取优惠、有厨房联', () => {
  const s = renderOrderTicket({
    channel: 'PICKUP', orderNo: 'ORD1', createdAt: new Date('2026-09-11T02:00:00Z'), paidAt: new Date('2026-09-11T02:01:00Z'),
    items: [{ productName: '凉拌牛肉', specText: null, quantity: 2, subtotal: 5000 }],
    totalAmount: 5000, shippingFee: 0, packingFee: 200, actualAmount: 4950, remark: null, discountAmount: 0, pointsUsed: 0, pickupDiscountAmount: 250,
    receiverName: '张三', receiverPhone: '13800001234', receiverFullAddress: '四川省自贡市自流井区丹桂40栋底楼',
    pickupAt: new Date('2026-09-12T04:00:00Z'), pickupSlotLabel: '9月12日（周六）12:00–12:30', pickupDayStamp: '明日单',
  })
  assert.ok(s.includes('<CB>到店自取</CB>'))
  assert.ok(s.includes('<CB>【明日单】</CB>'))
  assert.ok(s.includes('<B>取餐 9月12日（周六）12:00–12:30</B>'))
  assert.ok(s.includes('尾号1234'))
  assert.ok(!s.includes('地址'))
  assert.ok(!s.includes('运费'))
  assert.ok(s.includes('自取优惠：−¥2.50'))
  assert.ok(s.includes('<CB>厨房联</CB>'))
  // 2026-09-13 打包费设计 §3.6：打包费在「合计」与「自取优惠」之间
  assert.ok(s.includes('打包费：¥2.00'))
  assert.ok(s.indexOf('打包费：¥2.00') < s.indexOf('自取优惠：−¥2.50'))
})

console.log(`\n${pass} passed${process.exitCode ? ', 有失败' : ''}`)
