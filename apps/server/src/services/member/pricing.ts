/**
 * 结算计价的两个纯函数（会员 M2）。
 *
 * **纯**在这里是硬要求，不是风格偏好：不 import prisma、不 import AppError。
 * 判定结果结构化返回，抛错留给路由层。这样 `scripts/selftest-member.ts` 才能不起数据库、
 * 不起服务就把整个计价矩阵跑完——计费是最不该靠端到端测试来保证的一块。
 *
 * 计费顺序是 spec §5.1 的产品决策，逐字执行，本文件不重新讨论：
 *
 *   小计 = Σ非赠品行
 *   折扣 = 券 ? min(券面额, 小计) : 0      ← 门槛比对的是**小计**
 *   运费 = 按**券前小计**判定（包邮/起送/同城起送）← 顾客不因为用券失去包邮
 *   实付 = 小计 − 折扣 + 运费
 *
 * ⚠️ 「运费按券前小计判定」这一条不在本文件里实现，而在 `routes/orders.ts`：那里的
 * `calcLocalFee(s, distanceM, totalAmount)` 与 `calcExpressFee(s, group, weightKg, quotes, totalAmount, locked)`
 * 收到的 `totalAmount`/`subtotalFen` 必须始终是券前小计。本文件只负责「券那一步」和最后的加减法，
 * 不给调用方任何把券后金额传进运费计算的机会——`computeCheckout` 拿到的 `shippingFee`
 * 是已经算好的结果，不是让它去算。
 */

/** 券的可用性判定只需要这几个字段；传 `UserCoupon` 行进来即可（结构化子集，便于自测构造） */
export interface CouponLike {
  userId: number
  /** 面额（分） */
  amount: number
  /** 门槛（分），0 = 无门槛代金券 */
  threshold: number
  channel: 'ALL' | 'LOCAL' | 'EXPRESS'
  /** UNUSED | USED | EXPIRED */
  status: string
  expiresAt: Date
}

export type CouponUnusableReason = 'NOT_OWNER' | 'USED' | 'EXPIRED' | 'CHANNEL' | 'THRESHOLD'

export type UsableCheck =
  | { usable: true; discount: number }
  | { usable: false; reason: CouponUnusableReason; message: string }

export interface CheckCouponCtx {
  userId: number
  channel: 'LOCAL' | 'EXPRESS'
  /** 券前商品小计（分），不含运费、不含赠品行 */
  subtotal: number
  /** 便于自测；缺省取当前时间 */
  now?: Date
}

const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`

/**
 * 判断一张券能不能用在这一单上，可用时给出实际抵扣额。
 *
 * **判定顺序被自测钉死**：`NOT_OWNER → USED → EXPIRED → CHANNEL → THRESHOLD`。
 * 一张既过期、渠道又不符、还没到门槛的券必须稳定地报同一个原因，否则文案会随实现漂移。
 * 这个顺序的依据：归属是安全检查，排头；再看券自身的状态（用过 / 过期，顾客无法补救）；
 * 最后才是与本单相关的渠道与门槛（顾客换个单就能用，属于「可补救」，放在最后报最有用）。
 *
 * `NOT_OWNER` 的文案刻意说「优惠券不存在」而不是「不属于你」——后者等于确认了这张券存在，
 * 拿别人的券号试探就能枚举出有效券号。
 */
export function checkCouponUsable(c: CouponLike, ctx: CheckCouponCtx): UsableCheck {
  if (c.userId !== ctx.userId) {
    return { usable: false, reason: 'NOT_OWNER', message: '优惠券不存在' }
  }
  if (c.status !== 'UNUSED') {
    return { usable: false, reason: 'USED', message: '优惠券已使用' }
  }
  const now = ctx.now ?? new Date()
  // 取 `<=` 而不是 `<`：到期时刻那一瞬间算过期。券的 expiresAt 通常落在自然日边界上，
  // 这个取舍只影响那一毫秒，但写死了才不会两处判定不一致（scheduler 的 expireCoupons 同样口径）。
  if (c.expiresAt.getTime() <= now.getTime()) {
    return { usable: false, reason: 'EXPIRED', message: '优惠券已过期' }
  }
  if (c.channel !== 'ALL' && c.channel !== ctx.channel) {
    return {
      usable: false,
      reason: 'CHANNEL',
      message: c.channel === 'LOCAL' ? '该券仅限同城配送订单使用' : '该券仅限全国邮寄订单使用',
    }
  }
  if (ctx.subtotal < c.threshold) {
    // 边界取 `>=`：门槛刚好等于小计就可用。「满 50 减 10」在小计正好 ¥50 时不能用，
    // 是顾客最容易投诉的一种数字游戏。
    return {
      usable: false,
      reason: 'THRESHOLD',
      message: `满 ${yuan(c.threshold)} 可用，当前 ${yuan(ctx.subtotal)}`,
    }
  }
  // 封顶到小计：券面额大于小计时只抵到 0，不产生负数、不倒找钱。
  // 顾客用一张 ¥20 券买 ¥15 的东西，抵 ¥15，多出来的 ¥5 不退不留——券是一次性核销的。
  return { usable: true, discount: Math.min(c.amount, ctx.subtotal) }
}

/**
 * 实付 = 小计 − 折扣 + 运费。**只做这一件事。**
 *
 * 特意做成一个只有加减法的函数，是为了让「实付怎么算出来的」在代码里有唯一一处答案，
 * 而不是散落在邮寄分支和同城分支各写一遍（那正是两条分支慢慢算出不同结果的开始）。
 *
 * `actualAmount === 0` **不在这里拒**：券把商品减到 0、又恰好没有运费，是一笔合法的
 * 0 元订单在算术上的结果，但微信支付收不了 0 元。拒不拒、报哪个错码，是路由层的业务判断
 * （spec §5.1 定的是 42251），本函数只负责算对。
 *
 * `discount > subtotal` 则直接抛：那不是业务情形，是调用方没走 `checkCouponUsable`
 * 的封顶逻辑就自己算了折扣——属于编程错误，早炸比算出一个负数实付好。
 */
export function computeCheckout(i: {
  subtotal: number
  discount: number
  shippingFee: number
  /** 自取优惠（分），只有 PICKUP 单非 0。顺序：小计 → 自取优惠 → 券 → 运费（spec 2026-09-11 P6） */
  pickupDiscount?: number
  /**
   * 打包费（分），默认 0，与 `shippingFee` 同一层相加——不参与起送门槛/券门槛/自取折扣，
   * 那些判定用的是券前商品小计（2026-09-13 打包费设计 §2.4）。
   */
  packingFee?: number
}): { actualAmount: number } {
  const pickupDiscount = i.pickupDiscount ?? 0
  const packingFee = i.packingFee ?? 0
  if (pickupDiscount < 0) throw new Error(`自取优惠 ${pickupDiscount} 为负：调用方传错`)
  if (packingFee < 0) throw new Error(`打包费 ${packingFee} 为负：调用方传错`)
  if (pickupDiscount + i.discount > i.subtotal) {
    throw new Error(`自取优惠 ${pickupDiscount} + 折扣 ${i.discount} 超过商品小计 ${i.subtotal}：调用方未按封顶逻辑算券`)
  }
  return { actualAmount: i.subtotal - pickupDiscount - i.discount + i.shippingFee + packingFee }
}
