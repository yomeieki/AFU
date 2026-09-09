import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '../utils/prisma'
import { loadCouponForOrder, loadGiftLines, applyOrderBenefits, releaseOrderBenefits } from '../services/member/checkout'
import { computeCheckout } from '../services/member/pricing'
import { success, paginate } from '../utils/response'
import { AppError } from '../middlewares/error'
import { validatePayConfig, createJsapiOrder, generatePayParams, closeOrder } from '../services/wechat-pay'
import { config } from '../config'
import { notifyOrderPaid, notifyRefundRequest, notifyAfterSaleRequest, notifyCancelRequest } from '../services/order-notify'
import { rollbackOrderStock } from '../utils/order-stock'
import { payLimiter } from '../middlewares/rate-limit'
import { AFTER_SALE_REASONS, AFTER_SALE_REASON_LABEL, AfterSaleReason, payExpireAtOf } from '../utils/constants'
import { initiateRefund, remainingRefundable } from '../services/refund'
import { getSubscribeTemplateIds, sendPaidSubscribeMessage } from '../services/subscribe-message'
import { loadOrderLines, assertLinesSellable } from '../services/order-lines'
import { getExpressSettings, findRegionGroup, legacyShippingView } from '../services/express-settings'
import { calcPackageWeightKg, calcExpressFee, itemsHash, addressHash, verifyExpressQuote, FeeCalc } from '../services/express-quote'
import { fetchCourierQuotes, MAX_ADDRESS_BYTES } from '../services/express-quote-service'
import { channelOfDeliveryType } from '../utils/channel'
import {
  getLocalSettings, isOpenNow, isPaused, nextOpenText, calcLocalFee, verifyQuote, haversineM,
} from '../services/local-settings'
import { DELIVERY_STATUS_LABEL, providerLabel } from '../services/delivery/state'
import { enqueueOrderTicket } from '../services/ticket'
import { getCourierLocationByOrder } from '../services/delivery/courier-location'
import { bookingView } from '../services/delivery/express-booking'
import { parseStoredTrack } from '../services/delivery/express-track-json'
import { settlePoints } from '../services/member/points'
import { allocateOrderNo } from '../services/order-no'

const router = Router()

/** 顾客端订单附加字段：待付款截止时间（倒计时用） */
/**
 * 顾客侧订单响应的统一出口。顺手剥掉店家内部的字段：
 *  - quoteSnapshot / quotedAt（§6b）：店家付给骑手的成本与查询时间，顾客只该看到自己付的运费。
 *  - isTest：内部统计口径标记（见 utils/stats-scope.ts），顾客看到「你这单是测试单」只会困惑，
 *    联调时用的还是真实小程序账号和真实支付，那一单对顾客而言就是普通订单。
 * **任何返回订单行（或订单行展开）的顾客接口都必须经过这里**——之前漏过一处
 * （PUT /:id/confirm 直接 success(res, updated)），说明「记数字」靠不住；
 * 新增出口时请重新数一遍本文件里所有 success(res, ...) **与 paginate(res, ...)** 调用，逐个确认是否携带订单行。
 * （列表出口走的是 paginate 而不是 success——只搜 success 会漏掉本文件最主要的那个订单行出口。）
 * 现存携带订单行的出口共 4 处：GET /（列表）、GET /:id、PUT /:id/confirm、PUT /:id/cancel（两个分支）。
 *
 * M2 新增的会员字段里，**该发的发、该剥的剥**：
 *   发：discountAmount / pointsUsed / pointsEarned —— 顾客要在订单里看到「优惠了多少、
 *       花了多少分、得了多少分」，M4 的订单详情与列表都按这三个名字取值。
 *   剥：pointsSettledAt / pointsBase —— 纯内部记账。前者是兜底任务的「已处理」标记
 *       （见 schema 注释：不得用 pointsEarned===0 判断，否则 earn=0 的单会被永远重扫），
 *       后者是退款按比例扣回时的分母。两个都对顾客无意义，而且泄露了发放算法的中间量。
 *       它们从 M1 落地起就一直在往外发，这次顺手收掉——本函数自称是这个文件的字段守门人，
 *       那就该真的守住。
 */
function withPayExpire<T extends { status: string; createdAt: Date }>(
  order: T
): Omit<T, 'quoteSnapshot' | 'quotedAt' | 'isTest' | 'pointsSettledAt' | 'pointsBase'> & { payExpireAt: Date | null } {
  const { quoteSnapshot, quotedAt, isTest, pointsSettledAt, pointsBase, ...rest } = order as T & {
    quoteSnapshot?: unknown
    quotedAt?: unknown
    isTest?: unknown
    pointsSettledAt?: unknown
    pointsBase?: unknown
  }
  void quoteSnapshot
  void quotedAt
  void isTest
  void pointsSettledAt
  void pointsBase
  return {
    ...(rest as unknown as Omit<T, 'quoteSnapshot' | 'quotedAt' | 'isTest' | 'pointsSettledAt' | 'pointsBase'>),
    payExpireAt: order.status === 'PENDING_PAYMENT' ? payExpireAtOf(order.createdAt, config.order.payTimeoutMin) : null,
  }
}

function isPayExpired(order: { createdAt: Date }): boolean {
  return Date.now() >= payExpireAtOf(order.createdAt, config.order.payTimeoutMin).getTime()
}

/** D6 ②：同城/邮寄订单接单后 acceptGraceMin 分钟内可申请取消（各渠道各自的宽限分钟，0 = 关闭） */
async function cancelWindowOf(order: { deliveryType: string; status: string; acceptedAt: Date | null; cancelRequestedAt: Date | null }) {
  if (order.status !== 'PREPARING' || !order.acceptedAt) return { canRequestCancel: false, cancelRequestDeadline: null as Date | null, cancelGraceMin: 0 }
  const graceMin = order.deliveryType === 'LOCAL' ? (await getLocalSettings()).acceptGraceMin : order.deliveryType === 'EXPRESS' ? (await getExpressSettings()).acceptGraceMin : 0
  if (graceMin <= 0) return { canRequestCancel: false, cancelRequestDeadline: null as Date | null, cancelGraceMin: 0 }
  const deadline = new Date(order.acceptedAt.getTime() + graceMin * 60 * 1000)
  return { canRequestCancel: !order.cancelRequestedAt && Date.now() < deadline.getTime(), cancelRequestDeadline: deadline, cancelGraceMin: graceMin }
}

// ─────────────────────────────────────────────────────────
// POST /api/orders — 下单（购物车结算 或 立即购买二选一）
// ─────────────────────────────────────────────────────────
const directItemSchema = z.object({
  productId: z.number().int().positive(),
  skuId: z.number().int().positive().optional(),
  quantity: z.number().int().min(1).max(99),
})
const createOrderSchema = z
  .object({
    cartItemIds: z.array(z.number().int().positive()).min(1, '请选择商品').optional(),
    directItem: directItemSchema.optional(),
    addressId: z.number().int().positive('请选择收货地址'),
    deliveryType: z.enum(['EXPRESS', 'LOCAL']).default('EXPRESS'),
    quoteToken: z.string().max(1024).optional(),
    // 备注上限 20 字（PO 2026-09-06 定）。不是字节预算问题——255 字也只让同城双联从 54 件降到
    // 34 件，远超实际量。真正的原因是**票面可读性**：备注用 <CB> 渲染（居中放大加粗，一个字占
    // 两列），255 字在 58mm 纸上要占约 17 行放大字，把订单信息全挤没，而且配送联厨房联各印一遍。
    // 数据库仍是 varchar(255)，故意不收窄——不需要迁移，已有数据也不会因为收紧入口变非法。
    remark: z.string().max(20).optional(),
    // 客户端下单幂等键（UUID）。**必须可选**：邮寄结算页与 e2e 里几十处下单都不传，
    // 写成必填会让那些调用方当场全红。不传时行为与本字段上线前逐字节一致。
    clientRequestId: z.string().uuid().optional(),
    // 会员优惠（M2）。两个都可选——不传时整条链路的行为与改前逐字节一致。
    couponId: z.number().int().positive().optional(),
    gifts: z
      .array(z.object({ pointsGoodId: z.number().int().positive(), quantity: z.number().int().min(1).max(9) }))
      .max(5, '一单最多加购 5 种赠品')
      .optional(),
  })
  .refine((v) => !!v.cartItemIds !== !!v.directItem, { message: '请选择商品' })
  // 同一种赠品出现两次会让 perOrderLimit 判定失效（两行各自都不超限、合起来超）。
  // 在这里挡掉比在业务层聚合更简单，也让前端拿到明确的提示。
  .refine((v) => !v.gifts || new Set(v.gifts.map((g) => g.pointsGoodId)).size === v.gifts.length, {
    message: '同一种赠品请合并数量，不要重复提交',
  })

/**
 * 「订单已创建」的返回体。首次创建与幂等重试**必须逐字段相同**——
 * 客户端拿这个返回去跳详情页、拉起支付、显示券名，任何一个字段在重试时缺了或变了，
 * 都会表现成「第一次下单正常、超时重试后页面少一块」这种极难复现的故障。
 *
 * couponName 首次由调用方传进来（那时券对象就在手上）；重试路径没有那个对象，
 * 按 order.couponId 现查一次。券名是发券时的快照（UserCoupon.name），模板改名不影响它。
 */
async function orderCreatedView(order: Prisma.OrderGetPayload<Record<string, never>>, couponName?: string | null) {
  let name = couponName ?? null
  if (couponName === undefined && order.couponId) {
    const c = await prisma.userCoupon.findFirst({ where: { id: order.couponId }, select: { name: true } })
    name = c?.name ?? null
  }
  return {
    orderId: order.id,
    orderNo: order.orderNo,
    totalAmount: order.totalAmount,
    shippingFee: order.shippingFee,
    actualAmount: order.actualAmount,
    discountAmount: order.discountAmount,
    pointsUsed: order.pointsUsed,
    couponName: name,
    status: order.status,
    payExpireAt: payExpireAtOf(order.createdAt, config.order.payTimeoutMin),
    subscribeTemplateIds: getSubscribeTemplateIds(),
  }
}

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { cartItemIds, directItem, addressId, deliveryType, quoteToken, remark, couponId, gifts, clientRequestId } =
      createOrderSchema.parse(req.body)

    // 幂等前置查询：客户端超时重试时，绝大多数情况在这里就命中并原样返回，
    // 连库存与券都不会再碰一次。真正并发的两次提交靠唯一索引在事务里挡（见下面的 P2002 分支）。
    if (clientRequestId) {
      const existing = await prisma.order.findFirst({ where: { userId, clientRequestId } })
      if (existing) return success(res, await orderCreatedView(existing))
    }

    // 1. 组装下单行（购物车项 或 立即购买单品）——与邮寄报价共用同一份逻辑，见 services/order-lines.ts
    const lines = await loadOrderLines(userId, { cartItemIds, directItem })

    // 2. 逐个验证商品（有 SKU 的行按 SKU 库存校验）
    const channel = channelOfDeliveryType(deliveryType)
    assertLinesSellable(lines, channel)

    // 3. 获取收货地址（验证归属）
    const address = await prisma.address.findFirst({
      where: { id: addressId, userId, deletedAt: null },
    })
    if (!address) throw new AppError(40401, '收货地址不存在', 404)

    // 4. 计算金额（全部后端计算；单价取 SKU 价，无 SKU 走商品价）
    let totalAmount = 0
    const orderItemsData = lines.map((line) => {
      const unitPrice = line.sku?.price ?? line.product.price
      const subtotal = unitPrice * line.quantity
      totalAmount += subtotal
      return {
        productId: line.productId,
        skuId: line.skuId,
        specText: line.sku?.specText ?? null,
        productName: line.product.name,
        productImage: line.product.coverImage,
        productPrice: unitPrice,
        quantity: line.quantity,
        subtotal,
      }
    })
    // ── 会员优惠（M2）：券与赠品的**只读**校验，必须在 totalAmount 成形之后 ──────────
    //
    // 放在这里而不是更早：券的门槛判定要比对商品小计，而小计是上面那段 map 累加出来的。
    // 这里做的全是预检；真正的并发防线在下面事务里的条件更新（applyOrderBenefits）。
    const giftResult = await loadGiftLines(userId, channel, gifts ?? [])
    const giftLines = giftResult.lines
    const pointsUsed = giftResult.pointsUsed
    const coupon = couponId ? await loadCouponForOrder(userId, couponId, channel, totalAmount) : null

    // ⚠️ 赠品与付费行指向同一商品时，上面两处库存校验各自独立通过（付费行判 1 件、赠品判 1 件），
    // 但库存只有 1 件。事务内第二次 updateMany 会判 count===0 整单回滚——**安全但文案误导**，
    // 顾客明明看到有货却被告知「库存不足，请刷新重试」。这里按 (productId, skuId) 聚合后再判一次，
    // 让顾客在提交前就拿到准确的原因。
    if (giftLines.length > 0) {
      const need = new Map<string, number>()
      const stockOf = new Map<string, { stock: number; label: string }>()
      for (const l of lines) {
        const k = `${l.productId}:${l.skuId ?? 0}`
        need.set(k, (need.get(k) ?? 0) + l.quantity)
        stockOf.set(k, {
          stock: l.sku?.stock ?? l.product.stock,
          label: l.sku ? `${l.product.name}（${l.sku.specText}）` : l.product.name,
        })
      }
      for (const g of giftLines) {
        const k = `${g.productId}:${g.skuId ?? 0}`
        need.set(k, (need.get(k) ?? 0) + g.quantity)
        if (!stockOf.has(k)) continue // 赠品独有的商品，loadGiftLines 已经单独判过库存
      }
      for (const [k, qty] of need) {
        const s = stockOf.get(k)
        if (s && s.stock < qty) {
          throw new AppError(42201, `${s.label} 库存不足（剩余 ${s.stock}，本单含赠品共需 ${qty}）`)
        }
      }
    }

    // 两套计费互不叠加：EXPRESS 走 services/express-quote(-service).ts；LOCAL 走 services/local-settings.ts
    let shippingFee = 0
    let localSnapshot: {
      receiverLatE6?: number; receiverLngE6?: number; receiverPoiName?: string | null
      distanceM?: number; distanceSource?: string; estimatedDeliveryAt?: Date
    } = {}
    let expressSnapshot: { expressQuoteSnapshot?: Prisma.InputJsonValue; expressRegionGroup?: string; expressWeightG?: number } = {}
    if (deliveryType === 'LOCAL') {
      const s = await getLocalSettings()
      if (!s.enabled) throw new AppError(42226, '同城配送暂未开通')
      if (isPaused(s)) throw new AppError(42226, `同城配送暂停接单${s.paused?.reason ? `：${s.paused.reason}` : ''}`)
      if (!isOpenNow(s)) throw new AppError(42222, `当前非营业时间，${nextOpenText(s)}`)
      if (address.latE6 === null || address.lngE6 === null) throw new AppError(42223, '该地址缺少定位，请编辑地址并在地图上选点')
      if (s.store.latE6 === null || s.store.lngE6 === null) throw new AppError(42226, '门店尚未设置坐标，暂不能配送')
      /**
       * ── quoteToken 的信任边界（改错这里就是每单漏钱，动之前先读完）──
       *
       * **同城单必须带一张有效凭证才收得下**，没有兜底估算这条路。这里不再自己算距离：本地
       * Haversine × detourFactor 是个偏低的估算（店主实测 8 个方向，真实系数 1.30–2.12，3/8 的方向
       * 超过兜底的 1.7），只要它还留在计费路径上，客户端干脆不传 token 就能少付一档运费，还能把
       * 「直线内、道路外」的点塞进配送范围。报价那边辛辛苦苦向运力方问到真实道路距离，这里一漏就白做。
       * 所以本作用域内**不存在**任何估算函数（`billableDistanceM` 已从 import 里删掉），
       * `distanceM` 是 `const` 且只有一个来源——这条保证由类型和作用域给出，不靠注释自觉。
       *
       * 凭证只在四项全对时可信：
       *  ① 签名与有效期（`verifyQuote`，TTL 15 分钟）——防伪造、防拿隔夜的价来下单；
       *  ② `addressId` 一致——凭证只能用在它报价的那个地址上；而地址归属已在上面按 userId 查过，
       *     所以一张凭证天然只有它的主人用得上；
       *  ③ **收货**坐标一致——光绑 addressId 挡不住「近处报价 → 改这个地址的坐标到远处 → 用旧凭证
       *     下单」，那会按近处判范围和收费，骑手却要跑 30 km；
       *  ④ **门店**坐标一致——这就是 geoVersion：门店一搬，凭证里那段距离量的是另一条路。
       * ①②③ 不符 → 42239「请重新获取配送报价」：这几种情形对顾客而言就是「你手上这张票不作数」，
       * 重报一次价即可。④ 不符 → **42227**，与下面「重算更贵」同码同文案：店主改了参数、
       * 顾客看到的因果和补救动作完全一样（刷新后重新提交），而客户端早就会处理 42227。
       *
       * 这里**不比 `settings.version`**：除 `distanceM` 外，凭证里每一个会变的量（运费、范围、
       * 起送门槛）都在下面用**当前**设置重新求值，那条粗粒度作废是纯冗余——留着只会让店主改一次
       * 营业时间或小费上限，就把正在结算页的顾客全踢下来。
       *
       * 下面「重算 fee 更贵 → 42227，否则按重算 fee 收」那一段**仍然必须留着**，它挡的不是距离
       * 漂移而是 subtotal 造假：`/local/quote` 的 subtotal 是顾客传的，报个 ¥99 就能拿到 fee=0
       * 的免运凭证，再拿它去下一单 ¥40 的。距离同源之后，重算 fee 与凭证 fee 唯一可能的差异就来自
       * subtotal，于是这条比较正好把它兜住；反向（重算更便宜，比如顾客实际买得更多跨过了免运门槛）
       * 实收也是重算 fee，该免的运费照免——实收永远是重算价，凭证价只用来判断要不要拒单，
       * 从不参与「谁更低」的比较（这里不存在凭证价胜出的分支）。
       */
      const quoted = quoteToken ? verifyQuote(quoteToken) : null
      if (!quoted || quoted.addressId !== address.id || quoted.latE6 !== address.latE6 || quoted.lngE6 !== address.lngE6) {
        throw new AppError(42239, '请重新获取配送报价后再提交')
      }
      if (quoted.storeLatE6 !== s.store.latE6 || quoted.storeLngE6 !== s.store.lngE6) {
        throw new AppError(42227, '配送费已更新，请刷新后重新提交')
      }
      const distanceM = quoted.distanceM
      // 基础运费：**只有 QUOTE 口径才信 token**。
      //   QUOTE —— 来自实时报价，这里按设计不做第二次外呼、重算不出来，只能信签过名的那一份，
      //            效果是给顾客锁价 15 分钟（他在结算页看到多少就付多少）。
      //   TABLE —— 表就在设置里，现算得出来，所以现算：店主中途调价要能立刻生效，
      //            下面那条 42227「配送费已更新」的防线靠的正是「重算比凭证贵就拒绝」。
      // 满免/起送一律用**下单时**的真实金额现算——顾客报完价还会加菜。
      const q = calcLocalFee(s, distanceM, totalAmount, quoted.feeSource === 'QUOTE' ? quoted.baseFee : null)
      if (!q.inRange) throw new AppError(42220, `超出配送范围（约 ${(distanceM / 1000).toFixed(1)} km，最远 ${s.radiusKm} km）`)
      if (q.belowMin) throw new AppError(42210, `同城配送满 ¥${(s.fee.minOrderAmount / 100).toFixed(2)} 起送，当前 ¥${(totalAmount / 100).toFixed(2)}`)
      // 赠品**计入**件数与重量（PO 2026-09-06 定 / 计划 D2）。42230 的意义是「一个骑手拎不动」，
      // 与谁付钱无关——赠品是真的要装进同一个袋子、由同一个骑手带走的东西。
      // ⚠️ 重量要读赠品自己的 netWeightG：loadGiftLines 的 product select 特意带了这一列，
      // 少了它所有赠品都会按 defaultItemWeightG 兜底，42230 的判定就失真了。
      const totalItems =
        lines.reduce((n, l) => n + l.quantity, 0) + giftLines.reduce((n, g) => n + g.quantity, 0)
      const totalWeightKg =
        lines.reduce((w, l) => w + ((l.product.netWeightG ?? s.kd100.defaultItemWeightG) * l.quantity) / 1000, 0) +
        giftLines.reduce((w, g) => w + ((g.netWeightG ?? s.kd100.defaultItemWeightG) * g.quantity) / 1000, 0)
      if (totalItems > s.limits.maxItems || totalWeightKg > s.limits.maxWeightKg) {
        throw new AppError(42230, `单次配送最多 ${s.limits.maxItems} 件 / ${s.limits.maxWeightKg} kg，请分单或电话联系商家`)
      }
      if (q.fee > quoted.fee) throw new AppError(42227, '配送费已更新，请刷新后重新提交')
      shippingFee = q.fee
      localSnapshot = {
        receiverLatE6: address.latE6,
        receiverLngE6: address.lngE6,
        receiverPoiName: address.poiName,
        distanceM,
        // 这一单的运费是按运力方实测道路距离收的，还是 /local/quote 查价失败退回的直线估算——
        // 判定只发生在报价那一刻（下单端点不重新外呼），所以这里直接落 token 里签的值，不是
        // 重新判定。目的是让「查价失败时按估算价成交」这类单事后可查：不用去关联别的表推断，
        // 订单行上直接看得出这一单收没收贵/收没收亏（quoted.distanceSource 的信任边界见
        // services/local-settings.ts 的 QuotePayload.distanceSource 注释）。
        distanceSource: quoted.distanceSource,
        // ⚠️ **下单时不再写预计送达**（PO 2026-09-07）。
        // 原来这里写的是 `下单时刻 + 备餐 + 路上`，但备餐是从店员点「接单」才开始的——
        // 中间「等顾客付款 + 店里忙着没点接单」那一整段被白送掉了，高峰期能差十几分钟。
        // 之前没暴露，是因为骑行均速设成 15（实测 25.5）把路上时间高估了一倍，正好抵消；
        // 一旦把均速调准，这个缺口立刻在最忙的时候露出来。
        // 现在改成**接单那一刻**才算（routes/admin/delivery.ts 的 doAccept），
        // 顾客在结算页看到的是「大概多少分钟」而不是钟点，见 routes/local.ts 的报价响应。
        // 这里**不给这个字段**（列本身可空），接单时才落值。
      }
    } else {
      /**
       * 邮寄运费（批次一，spec §3/§4.1）。口径与同城一致：包邮/起送/不寄送按**下单时**的设置与**真实**小计判；
       * 报价数字只在两种来源里二选一——
       *   有凭证：验签 + 地址 + 清单指纹三项全对才信，QUOTE 口径锁凭证里的 quotedFeeFen（15 分钟），
       *           TABLE 口径现算（表就在设置里）；任一不符 → 42261 让客户端重报价。
       *   无凭证：老版本小程序。服务端自己走一遍同样的查价（带缓存）与计算——不能拒，小程序发版有滞后。
       * 两条路都不信客户端的任何金额。
       */
      const s = await getExpressSettings()
      const group = findRegionGroup(s, address.province)
      if (group.blocked) throw new AppError(42260, '该地区暂不支持邮寄')
      if (Buffer.byteLength(address.fullAddress, 'utf8') > MAX_ADDRESS_BYTES) throw new AppError(42262, '收货地址过长，请精简后再试')
      if (s.minOrderAmountFen > 0 && totalAmount < s.minOrderAmountFen) {
        throw new AppError(42210, `订单满 ¥${(s.minOrderAmountFen / 100).toFixed(2)} 起送，当前 ¥${(totalAmount / 100).toFixed(2)}`)
      }
      const hash = itemsHash(lines, gifts ?? [])
      const weightKg = calcPackageWeightKg(
        [...lines.map((l) => ({ netWeightG: l.product.netWeightG, quantity: l.quantity })), ...giftLines.map((g) => ({ netWeightG: g.netWeightG, quantity: g.quantity }))],
        s.weight,
      )
      const quoted = quoteToken ? verifyExpressQuote(quoteToken) : null
      // 地址是原地改的（PUT /api/addresses/:id 同 id 换省市区/详细地址），光比 addressId
      // 拦不住「报价成都、改地址到北京、拿着旧凭证下单」——凭证里的地址内容指纹也得对上。
      if (quoteToken && (!quoted || quoted.addressId !== address.id || quoted.addressHash !== addressHash(address.fullAddress) || quoted.itemsHash !== hash)) {
        throw new AppError(42261, '运费已更新，请重新确认')
      }
      let fee: FeeCalc, snapshotQuotes: { kuaidicom: string; serviceType: string | null; priceFen: number | null }[], pricedWeightKg: number
      if (quoted) {
        // QUOTE 锁价：重量随凭证；TABLE 现算：重量与表都用当前值
        pricedWeightKg = quoted.feeSource === 'QUOTE' ? quoted.weightKg : weightKg
        fee = calcExpressFee(s, group, pricedWeightKg, null, totalAmount, quoted.feeSource === 'QUOTE' ? { quotedFeeFen: quoted.quotedFeeFen } : null)
        snapshotQuotes = quoted.quotes
      } else {
        pricedWeightKg = weightKg
        const live = await fetchCourierQuotes(s, address.id, address.fullAddress, weightKg)
        fee = calcExpressFee(s, group, weightKg, live, totalAmount)
        snapshotQuotes = (live ?? []).map((q) => ({ kuaidicom: q.kuaidicom, serviceType: q.serviceType, priceFen: q.priceFen }))
      }
      shippingFee = fee.feeFen
      expressSnapshot = {
        expressQuoteSnapshot: {
          feeFen: fee.feeFen, quotedFeeFen: fee.quotedFeeFen, feeSource: fee.feeSource, groupName: group.name,
          weightKg: pricedWeightKg, itemsHash: hash, fromToken: !!quoted, quotes: snapshotQuotes,
        },
        expressRegionGroup: group.name,
        expressWeightG: Math.round(pricedWeightKg * 1000),
      }
    }
    // 计价顺序是 spec §5.1 的产品决策，逐字执行：小计 → 券 → 运费（**按券前小计**判包邮/起送）→ 实付。
    // 上面两条渠道分支里的 calcLocalFee / calcExpressFee / belowMin / minOrderAmount
    // 收到的都是券前 totalAmount，**一个字都没动**——顾客不因为用券失去包邮或跌破起送线。
    const discount = coupon?.discount ?? 0
    const { actualAmount } = computeCheckout({ subtotal: totalAmount, discount, shippingFee })
    // 0 元订单走不了微信支付，会掉进「没有支付回调」的死角（spec §5.1 与 §10 风险表第一行）。
    // 这一步必须在这里拒——computeCheckout 是纯函数，它只负责算对，拒不拒是业务判断。
    if (actualAmount === 0) throw new AppError(42251, '该券金额已超过本单可抵扣范围')

    // 赠品行：不进小计（productPrice/subtotal 恒为 0），但**照常扣真实库存、加真实销量**——
    // 它是真的从货架上拿走的一份货（spec §5.3）。
    const giftItemsData = giftLines.map((g) => ({
      productId: g.productId,
      skuId: g.skuId,
      specText: g.specText,
      productName: g.productName,
      productImage: g.productImage,
      productPrice: 0,
      quantity: g.quantity,
      subtotal: 0,
      isGift: true,
      pointsCost: g.pointsCost,
    }))

    // 5. 事务：创建订单 + 减库存 + 增销量 + 落实优惠 + 清购物车
    //
    // ⚠️ 显式 timeout：Prisma 交互式事务默认 5 秒。M2 往这个事务里又加了券核销、consumePoints
    // （1 次 findMany + 最多 2 轮 × N 次 updateMany + user.update + ledger.create）、GIFT 行
    // expiresAt 回填、以及每个赠品各一次名额占用 + 库存扣减。默认值下晚高峰会出现「下单偶发
    // P2028」这种极难复现的故障——它不会稳定重现，因此也不会被任何测试抓到。
    // 单号在**事务外**先取（services/order-no.ts 说明了为什么不能放进来：
    // 计数器那一行的锁会被这整笔交易持有，下单就被串行化了）。
    const orderNo = await allocateOrderNo()

    const order = await prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          orderNo,
          clientRequestId: clientRequestId ?? null,
          userId,
          status: 'PENDING_PAYMENT',
          totalAmount,
          shippingFee,
          actualAmount,
          deliveryType,
          ...expressSnapshot,
          remark,
          receiverName: address.receiverName,
          receiverPhone: address.receiverPhone,
          receiverProvince: address.province,
          receiverCity: address.city,
          receiverDistrict: address.district,
          receiverDetail: address.detail,
          receiverFullAddress: address.fullAddress,
          ...localSnapshot,
          couponId: coupon?.id ?? null,
          discountAmount: discount,
          pointsUsed,
          items: { create: [...orderItemsData, ...giftItemsData] },
        },
      })

      // 原子减库存（updateMany 带 stock >= quantity 条件，防超卖）。
      // 赠品行一并遍历——它扣真实库存、加真实销量，与付费行走同一段逻辑（spec §5.3）。
      const stockLines = [
        ...lines.map((l) => ({ productId: l.productId, skuId: l.skuId, quantity: l.quantity, label: l.sku ? `${l.product.name}（${l.sku.specText}）` : l.product.name })),
        ...giftLines.map((g) => ({ productId: g.productId, skuId: g.skuId, quantity: g.quantity, label: g.specText ? `${g.productName}（${g.specText}）` : g.productName })),
      ]
      for (const line of stockLines) {
        if (line.skuId) {
          const skuUpdated = await tx.productSku.updateMany({
            where: { id: line.skuId, stock: { gte: line.quantity } },
            data: { stock: { decrement: line.quantity } },
          })
          if (skuUpdated.count === 0) {
            throw new AppError(42201, `${line.label} 库存不足，请刷新重试`)
          }
          await tx.product.update({
            where: { id: line.productId },
            data: { stock: { decrement: line.quantity }, salesCount: { increment: line.quantity } },
          })
        } else {
          const updated = await tx.product.updateMany({
            where: { id: line.productId, stock: { gte: line.quantity } },
            data: { stock: { decrement: line.quantity }, salesCount: { increment: line.quantity } },
          })
          if (updated.count === 0) {
            throw new AppError(42201, `${line.label} 库存不足，请刷新重试`)
          }
        }
      }

      // 券核销 / 积分扣减 / 赠品名额——三步都用条件更新判 count，是并发防线。
      // 放在库存扣减之后：库存是最可能失败的一步，先做能让大多数冲突更早回滚。
      await applyOrderBenefits(tx, { orderId: newOrder.id, userId, coupon, giftLines, pointsUsed })

      if (cartItemIds) {
        await tx.cart.deleteMany({ where: { id: { in: cartItemIds }, userId } })
      }
      return newOrder
    }, { timeout: 15000 }).catch(async (e) => {
      // 并发重试：两次提交几乎同时到达，前置查询都落空，唯一索引让其中一个的事务整体回滚
      // （库存、券、积分一起回滚，不会出现「扣了库存但没建单」）。输的那一边把赢家原样返回。
      // 只吞 (user_id, client_request_id) 这一个索引的冲突——别的 P2002（比如 orderNo 撞车）
      // 是真问题，必须继续往上抛。
      if (
        clientRequestId &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002' &&
        String((e.meta as { target?: string } | undefined)?.target ?? '').includes('client_request_id')
      ) {
        const winner = await prisma.order.findFirst({ where: { userId, clientRequestId } })
        if (winner) return winner
      }
      throw e
    })

    success(res, await orderCreatedView(order, coupon?.name ?? null))
  } catch (e) {
    next(e)
  }
})

// GET /api/orders
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
    const status = req.query.status as string | undefined
    // 支持逗号分隔多状态（如「待发货」tab = PAID,PREPARING）
    const statuses = status ? status.split(',').filter(Boolean) : []
    // 渠道过滤（「我的订单」默认只看当前渠道，可切「全部」）。
    // **必须在服务端过滤**：客户端拿分页结果再筛会漏单——第 1 页 20 条里可能一条同城都没有，
    // 顾客会以为自己的同城单丢了。
    //
    // 非法值走 zod 抛错（→ HTTP 400），**不静默回退成「全部」**：
    // 前端把参数拼错时那样会毫无征兆，顾客在「同城」页里看到邮寄单而没有任何人收到信号。
    // 空串按不传处理——前端拼 query 时很容易拼出一个 `&deliveryType=`。
    const rawDeliveryType = req.query.deliveryType
    const deliveryType = rawDeliveryType
      ? z.enum(['EXPRESS', 'LOCAL']).parse(rawDeliveryType)
      : undefined

    const where = {
      userId,
      ...(deliveryType ? { deliveryType } : {}),
      ...(statuses.length === 1 ? { status: statuses[0] } : statuses.length > 1 ? { status: { in: statuses } } : {}),
    }

    const [list, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        include: {
          items: {
            // isGift / pointsCost：M4 的订单列表要给赠品行打「赠」标。订单级的优惠字段
            // （discountAmount/pointsUsed/pointsEarned）不用在这里列——这条查询是 include
            // 无顶层 select，Order 的全部标量本来就在返回里。
            select: { id: true, productName: true, productImage: true, productPrice: true, quantity: true, subtotal: true, specText: true, isGift: true, pointsCost: true },
          },
          refunds: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, amount: true } },
          afterSales: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.order.count({ where }),
    ])

    paginate(
      res,
      list.map(({ refunds, afterSales, ...o }) =>
        withPayExpire({ ...o, latestRefund: refunds[0] ?? null, afterSale: afterSales[0] ?? null })
      ),
      total,
      page,
      pageSize
    )
  } catch (e) {
    next(e)
  }
})

// GET /api/orders/meta — 下单页需要的公共参数（订阅消息模板、支付超时），必须注册在 /:id 之前
router.get('/meta', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // 运费规则一并下发，省下单页一次请求。
    // 前端拿它只为「提交前把运费显示给顾客」，实际收费以下单时服务端重算为准。
    success(res, {
      subscribeTemplateIds: getSubscribeTemplateIds(),
      payTimeoutMin: config.order.payTimeoutMin,
      shipping: legacyShippingView(await getExpressSettings()),
    })
  } catch (e) {
    next(e)
  }
})

/**
 * 顾客端配送单可见字段白名单——绝不含 callbackSalt / quotedFee / actualFee / providerTaskId
 * 等运营/结算敏感字段。新增字段前先想一遍是不是也该进白名单，而不是直接展开整行。
 */
function customerDeliveryView(d: { status: string; courierName: string | null; courierMobile: string | null; courierCompany: string | null; pickedUpAt: Date | null; deliveredAt: Date | null }) {
  return {
    status: d.status,
    statusLabel: DELIVERY_STATUS_LABEL[d.status] ?? d.status,
    courierName: d.courierName,
    courierMobile: d.courierMobile,
    // 回调里是运力编码（fengniaotongcheng），顾客看到拼音串会以为出了错；翻成汉字再给
    courierCompany: providerLabel(d.courierCompany) || null,
    pickedUpAt: d.pickedUpAt,
    deliveredAt: d.deliveredAt,
  }
}

// GET /api/orders/:id/courier — 骑手位置（本人订单；仅在途单且已上路才查）
// 注册在 GET /:id 之前防吞：虽然 /:id 只匹配单段路径本不会吞掉 /:id/courier，
// 但两个路由都以 /:id 开头，放在前面更直观，也避免未来改动引入吞噬风险。
//
// 取数与 20 秒缓存搬到了 services/delivery/courier-location.ts，与管理端共用一份
// （两份缓存 + 两份负缓存迟早会 drift）。
//
// 响应里**只多给 etaMinutes**，不给 fetchedAt / 距店距离那些——那些是店家的运营信息。
// 顾客端本来就在页面上按坐标自己算「骑手距您约 x.x km」，所以坐标与距离不是秘密；
// 但「这份位置是 20 秒前取的」对顾客没有意义，只会让他盯着一个抖动的数字。
//
// etaMinutes 只在**骑手已取货**（DELIVERING）时才非空——这就是 PO 2026-09-07 定的「第三段」：
// 取货之前给的都是「备餐 + 距离÷均速」的大概，取货之后剩下的只有路上那一段，
// 用骑手实时位置算出来才配叫「真正的预计送达」。
router.get('/:id/courier', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!
    const order = await prisma.order.findFirst({
      where: { id, userId },
      select: { id: true, receiverLatE6: true, receiverLngE6: true },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    const { location, delivery } = await getCourierLocationByOrder(id)
    let etaMinutes: number | null = null
    if (location && delivery?.status === 'DELIVERING' && order.receiverLatE6 != null && order.receiverLngE6 != null) {
      const s = await getLocalSettings()
      // 与管理端同一套算法（routes/admin/delivery.ts 的 /courier）：直线 × 绕路系数 ÷ 均速。
      // 运力方不提供「骑手到目的地」的道路距离，也不提供 ETA（调研文档 §6：接口不返回预计送达时间），
      // 所以这是我们能给出的最准的一个数——但它仍是估算，文案上必须写「预计」。
      const legM = Math.round(haversineM(location.latE6, location.lngE6, order.receiverLatE6, order.receiverLngE6) * s.detourFactor)
      etaMinutes = Math.max(1, Math.round((legM / 1000 / s.riderSpeedKmh) * 60))
    }
    success(res, { location, etaMinutes })
  } catch (e) {
    next(e)
  }
})

// GET /api/orders/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!

    const order = await prisma.order.findFirst({
      where: { id, userId },
      include: {
        items: true,
        shipment: true,
        refunds: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true, amount: true, reason: true, createdAt: true, successTime: true },
        },
        afterSales: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, reason: true, description: true, images: true, status: true, reply: true, createdAt: true, handledAt: true },
        },
      },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)

    const { afterSales, ...rest } = order
    const remaining = remainingRefundable(order)
    const activeAfterSale = afterSales[0] && ['PENDING', 'APPROVED'].includes(afterSales[0].status) ? afterSales[0] : null
    let delivery: ReturnType<typeof customerDeliveryView> | null = null
    if (order.deliveryType === 'LOCAL') {
      const d = await prisma.delivery.findFirst({ where: { orderId: id }, orderBy: { id: 'desc' } })
      delivery = d ? customerDeliveryView(d) : null
    }
    // 顾客白名单：不给手机号、不给费用（同城 customerDeliveryView 同一原则）。
    // FAILED/VOID 对顾客等同「没预约」；CANCELLED 也下发，顾客端按「商家备货中」显示（Task 7 处理）。
    let expressBooking: { status: string; statusLabel: string; courierLabel: string; courierName: string | null; slotText: string; kuaidinum: string | null } | null = null
    let track: { updatedAt: string | null; signed: boolean; items: { context: string; ftime: string }[] } | null = null
    if (order.deliveryType === 'EXPRESS') {
      const b = await prisma.expressBooking.findFirst({ where: { orderId: id }, orderBy: { id: 'desc' } })
      if (b && !['FAILED', 'VOID'].includes(b.status)) {
        const v = bookingView(b)
        expressBooking = { status: v.status, statusLabel: v.statusLabel, courierLabel: v.courierLabel, courierName: v.courierName, slotText: v.slotText, kuaidinum: v.kuaidinum }
        // 轨迹只给非取消的预约；最多 30 条、最新在上（服务端已排好序）。老邮寄单/同城单没有预约行，自然是 null。
        const st = b.status !== 'CANCELLED' ? parseStoredTrack(b.trackJson) : null
        if (st && st.items.length) track = { updatedAt: b.trackUpdatedAt ? b.trackUpdatedAt.toISOString() : null, signed: st.ischeck, items: st.items.slice(0, 30) }
      }
    }
    // 券只在详情页带，列表不带——列表带就是 N+1（Order.couponId 是普通 Int 列，
    // 没有关系字段可 include，只能一单一查）。顾客在列表上看到「优惠 −¥X」已经够了，
    // 想知道用的哪张券点进详情。
    const coupon = order.couponId
      ? await prisma.userCoupon.findUnique({
          where: { id: order.couponId },
          // 白名单：不给顾客 issuedBy / remark / sourceRef（赔偿券的备注可能是「投诉客」这类内部话）
          select: { name: true, code: true, amount: true },
        })
      : null
    success(res, {
      ...withPayExpire(rest),
      coupon,
      ...(await cancelWindowOf(order)),
      afterSale: afterSales[0] ?? null,
      // 可申请售后：已发货/已完成、还有可退余额、当前无处理中的售后单
      canApplyAfterSale: ['SHIPPED', 'COMPLETED'].includes(order.status) && remaining > 0 && !activeAfterSale,
      subscribeTemplateIds: getSubscribeTemplateIds(),
      delivery,
      expressBooking,
      track,
    })
  } catch (e) {
    next(e)
  }
})

// POST /api/orders/:id/cancel-request — 同城订单接单后宽限期内申请取消（订单状态不变，店员确认后全额退）
const cancelRequestSchema = z.object({ note: z.string().trim().max(255).optional() })
router.post('/:id/cancel-request', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!
    const { note } = cancelRequestSchema.parse(req.body ?? {})
    const order = await prisma.order.findFirst({ where: { id, userId } })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    // 「已申请过」与「已超窗口」是两种不同原因，必须分开判断且前者优先：
    // 顾客在窗口内申请后，等到窗口过了再点一次，他需要知道的是「已在处理中」而不是「超时了」。
    if (order.cancelRequestedAt) {
      throw new AppError(42229, '已提交过取消申请，商家会尽快处理')
    }
    const win = await cancelWindowOf(order)
    if (!win.canRequestCancel) {
      throw new AppError(42229, order.status === 'PAID' ? '商家尚未接单，请直接申请退款' : '已超过可取消时间，如有问题请联系商家')
    }
    // 快照有效 Delivery/ExpressBooking 的当前状态（无在途单则 NONE）：店员处理取消申请时据此判断
    // 骑手是否已在路上/快递员是否已在路上，而不是等到点开详情才发现——申请那一刻的状态才是决策依据。
    const cancelRequestedAt = new Date()
    const snapshotStatus =
      order.deliveryType === 'LOCAL'
        ? ((await prisma.delivery.findFirst({ where: { activeOrderId: id } }))?.status ?? 'NONE')
        : ((await prisma.expressBooking.findFirst({ where: { activeOrderId: id } }))?.status ?? 'NONE')
    const moved = await prisma.order.updateMany({
      where: { id, status: 'PREPARING', cancelRequestedAt: null },
      data: {
        cancelRequestedAt, cancelRequestNote: note ?? null, cancelRequestDeliveryStatus: snapshotStatus,
        // 上一次申请若被驳回过，痕迹要清掉：顾客在窗口内还能再申请一次（比如第一次没说清理由），
        // 不清的话工作台会同时显示「有待处理申请」和「已驳回」，顾客端也会同时看到两种结论。
        cancelRequestRejectedAt: null, cancelRequestRejectedBy: null,
      },
    })
    // 真并发兜底：两个请求同时读到 cancelRequestedAt=null，只有一个能写入
    if (moved.count === 0) throw new AppError(42229, '已提交过取消申请')
    // notifyCancelRequest 不再自己读配置：win.cancelGraceMin 是这次请求刚判过窗口用的那个值，
    // 同城传同城的、邮寄传邮寄的，两边不会因为读的时机不同而对不上。
    // 通知本身仍是 fire-and-forget（不阻塞这次请求的响应），失败只留痕，不能让推送失败连累取消申请本身
    notifyCancelRequest(
      { orderNo: order.orderNo, actualAmount: order.actualAmount, receiverName: order.receiverName, receiverPhone: order.receiverPhone, note },
      win.cancelGraceMin,
      order.deliveryType === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
    ).catch((err) => console.error('[orders] notifyCancelRequest 失败:', (err as Error).message))
    // 出票（规格 §8b「顾客申请取消」）：这一步只是挂起申请、订单状态未变，但厨房该立刻知道「先别做了」，
    // 不必等店员处理完才收到消息——票面是给店内看的物理提醒，与走推送通知的 notifyCancelRequest 并列。
    // H6：kind 用独立的 CANCEL_REQUEST（不是 CANCEL）——这只是「申请」，店员可能驳回，票面文案、
    // printCancel 开关判断、打印记录筛选都要能跟真正的「取消」区分开。seq 用 cancelRequestedAt 的
    // 时间戳而不是固定 0：驳回后 cancelRequestedAt 会被清空，顾客可以再申请一次，固定 seq 会被
    // dedupe 当成「已出过同一张票」吞掉，第二次申请就再也传不到厨房。
    enqueueOrderTicket(id, 'CANCEL_REQUEST', { seq: cancelRequestedAt.getTime() }).catch((err) => {
      console.error('[orders] enqueueOrderTicket 失败（cancel-request）:', (err as Error).message)
    })
    success(res, { cancelRequestedAt })
  } catch (e) {
    next(e)
  }
})

// PUT /api/orders/:id/confirm — 确认收货（SHIPPED → COMPLETED）
router.put('/:id/confirm', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!

    const order = await prisma.order.findFirst({ where: { id, userId } })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    // 同城单的 SHIPPED 只表示骑手已取货、菜还在路上：由顾客手点 COMPLETED 会绕开退款侧
    // 「有在途配送单不许退款」的拦截（COMPLETED 免检），骑手到达前就能部分退款；
    // 且之后 720 回退也因不再是 SHIPPED 而落空。同城单的完成一律由 520 回调 / 店员「标记已送达」
    // / 兜底任务写入，这里对 LOCAL 直接拒绝。
    if (order.deliveryType === 'LOCAL') throw new AppError(42204, '同城订单由骑手送达后自动完成')
    if (order.status !== 'SHIPPED') throw new AppError(42204, '仅已发货订单可确认收货')

    // 条件写：上面读到的 status 是快照，与退款/售后并发时以先落库者为准，不能无条件 update
    const moved = await prisma.order.updateMany({
      where: { id, userId, status: 'SHIPPED' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新')
    // fire-and-forget：积分发放失败不影响确认收货这次响应，由 settleMissedPoints 兜底任务补发
    void settlePoints(id)
    const updated = await prisma.order.findUniqueOrThrow({ where: { id } })
    success(res, withPayExpire(updated))
  } catch (e) {
    next(e)
  }
})

// PUT /api/orders/:id/cancel — 客户自助取消
// 待付款：直接取消（并关闭微信订单）
// 已付款且商家未接单：秒退——回滚库存、订单转 REFUNDING 后立即向微信发起全额退款，无需店员审核；
//   发起失败时订单停在 REFUNDING 并通知店员到后台重试
// 已接单/已发货：不允许自助，请联系商家协商（员工在后台退款）
router.put('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!
    const order = await prisma.order.findFirst({
      where: { id, userId },
      include: { items: true, payment: { select: { outTradeNo: true, paymentType: true } } },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)

    if (order.status === 'PENDING_PAYMENT') {
      const updated = await prisma.$transaction(async (tx) => {
        const moved = await tx.order.updateMany({
          where: { id, status: 'PENDING_PAYMENT' },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: '用户取消' },
        })
        if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新')
        await rollbackOrderStock(tx, order.items)
        // 未支付取消：把券与赠品积分还回去（spec §5.5）。紧跟在 rollbackOrderStock 之后、
        // 且在状态翻转判 count 成功之后——releaseOrderBenefits 的幂等性依赖这个前提。
        await releaseOrderBenefits(tx, order)
        return tx.order.findUniqueOrThrow({ where: { id } })
      })
      if (!config.mock.pay && order.payment?.paymentType === 'WECHAT' && order.payment.outTradeNo) {
        void closeOrder(order.payment.outTradeNo)
      }
      // PENDING_PAYMENT 下 quoteSnapshot/quotedAt 必为 null（还没接单，取不到报价），
      // 包一层不构成实际脱敏，但统一走 withPayExpire 免得日后这两列提前到更早状态写入时
      // 这里又漏一次。
      return success(res, withPayExpire(updated))
    }

    if (order.status === 'PAID' && !order.acceptedAt) {
      await prisma.$transaction(async (tx) => {
        // 条件更新：与店员「接单」并发时以先落库者为准（已接单则本次取消失败）
        const moved = await tx.order.updateMany({
          where: { id, status: 'PAID', acceptedAt: null },
          data: { status: 'REFUNDING', cancelledAt: new Date(), cancelReason: '用户申请退款' },
        })
        if (moved.count === 0) throw new AppError(42204, '商家已接单备餐，请电话联系商家协商退款')
        await rollbackOrderStock(tx, order.items)
      })
      // 出票（规格 §8b「订单被取消」）：付款成功那一刻已经出过 NEW_ORDER 票，厨房可能已经在备料——
      // 这里的判断是「决定取消」就立刻出 CANCEL 提醒票，不等下面的微信退款请求完成/回调确认。
      // 退款是否成功不影响「这单不用做了」这个事实，让厨房等退款确认才知道，只会白白多耽误几分钟。
      enqueueOrderTicket(id, 'CANCEL').catch((err) => {
        console.error('[orders] enqueueOrderTicket 失败（用户自助取消）:', (err as Error).message)
      })
      // 秒退：走公共退款逻辑（REFUNDING 状态下全额），mock 即时到账，微信一般数秒内回调
      let autoRefunded = false
      try {
        const result = await initiateRefund({
          orderId: id,
          amount: remainingRefundable(order),
          reason: '用户申请退款',
          operator: 'customer',
        })
        autoRefunded = result.refund.status === 'SUCCESS' || result.refund.status === 'PROCESSING' || result.refund.status === 'PENDING'
      } catch (e) {
        // 微信发起失败：退款单已标 FAILED 并告警，通知店员到后台「退款」标签重试
        console.warn('[orders] 自助退款自动发起失败:', (e as Error).message)
        const latest = await prisma.order.findUniqueOrThrow({ where: { id } })
        notifyRefundRequest(latest)
      }
      const updated = await prisma.order.findUniqueOrThrow({ where: { id } })
      return success(res, { ...withPayExpire(updated), autoRefunded })
    }

    throw new AppError(
      42204,
      order.status === 'PAID' || order.status === 'PREPARING'
        ? '商家已接单备餐，请电话联系商家协商退款'
        : `订单状态为 ${order.status}，不可取消`
    )
  } catch (e) {
    next(e)
  }
})

// ─────────────────────────────────────────────────────────
// 售后申请（收货后：少发/错发/变质破损/其他 → 店员审核后部分/全额退款）
// ─────────────────────────────────────────────────────────
const afterSaleSchema = z.object({
  reason: z.enum(AFTER_SALE_REASONS),
  description: z.string().trim().max(200).optional(),
  images: z.array(z.string().url().max(500)).max(3).default([]),
})

router.post('/:id/after-sale', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!
    const { reason, description, images } = afterSaleSchema.parse(req.body ?? {})
    if (reason === 'OTHER' && !description) throw new AppError(40001, '选择「其他」时请填写说明')

    const order = await prisma.order.findFirst({
      where: { id, userId },
      include: { afterSales: { where: { status: { in: ['PENDING', 'APPROVED'] } }, take: 1 } },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (!['SHIPPED', 'COMPLETED'].includes(order.status)) throw new AppError(42204, '仅已发货/已完成订单可申请售后')
    if (remainingRefundable(order) <= 0) throw new AppError(42206, '该订单已全额退款')
    if (order.afterSales.length > 0) throw new AppError(42208, '已有售后申请处理中，请等待商家处理')

    const afterSale = await prisma.afterSale.create({
      data: { orderId: id, orderNo: order.orderNo, userId, reason, description: description || null, images },
    })
    notifyAfterSaleRequest(order, {
      reasonLabel: AFTER_SALE_REASON_LABEL[reason as AfterSaleReason],
      description,
      imageCount: images.length,
    })
    success(res, afterSale)
  } catch (e) {
    next(e)
  }
})

router.get('/:id/after-sale', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!
    const list = await prisma.afterSale.findMany({
      where: { orderId: id, userId },
      orderBy: { createdAt: 'desc' },
    })
    success(res, list)
  } catch (e) {
    next(e)
  }
})

// ─────────────────────────────────────────────────────────
// POST /api/orders/:id/pay
// ─────────────────────────────────────────────────────────
router.post('/:id/pay', payLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderId = Number(req.params.id)
    const userId = req.userId!
    // Mock 支付默认关闭：仅 WECHAT_PAY_MOCK=true 时启用（config.ts 保证生产环境无法开启）
    const useMockPay = config.mock.pay

    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { payment: true },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (order.status === 'PAID') throw new AppError(42203, '订单已支付')
    if (order.status !== 'PENDING_PAYMENT') throw new AppError(42204, '订单状态不允许支付')
    if (isPayExpired(order)) throw new AppError(42209, '订单已超时，请重新下单')

    if (useMockPay) {
      const paidAt = new Date()
      await prisma.$transaction(async (tx) => {
        await tx.payment.upsert({
          where: { orderId },
          update: { status: 'SUCCESS', paidAt, paymentType: 'MOCK' },
          create: {
            orderId,
            orderNo: order.orderNo,
            paymentType: 'MOCK',
            amount: order.actualAmount,
            status: 'SUCCESS',
            paidAt,
          },
        })
        // 条件写，与 wechat-notify.ts 的真实回调同形：并发取消已经释放过券与赠品积分时
        // 绝不能把状态写回 PAID（否则「已释放的权益」与「一张要履约的 PAID 单」共存）。
        // mock 路径生产禁用，但 e2e 天天走它——两条路的语义必须一致，否则 e2e 验的不是生产行为。
        const moved = await tx.order.updateMany({
          where: { id: orderId, status: 'PENDING_PAYMENT' },
          data: { status: 'PAID', paidAt },
        })
        if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新后重试')
      })
      prisma.orderItem
        .findMany({ where: { orderId }, select: { productName: true, specText: true, quantity: true, isGift: true } })
        .then((items) => {
          notifyOrderPaid({ ...order, paidAt }, items)
          if (req.openid) sendPaidSubscribeMessage(req.openid, { ...order, paidAt }, items[0]?.productName)
        })
        .catch(() => undefined)
      // 出票（规格 §8b）：与 notifyOrderPaid 并列的 fire-and-forget，独立起一条 promise 链而不是塞进
      // 上面那条——打印失败绝不能通过任何路径影响这个已经在走的 mock 支付响应，也不该等 orderItem
      // 查询才触发（enqueueOrderTicket 内部自己会重新按 orderId 查订单与商品）。
      enqueueOrderTicket(orderId, 'NEW_ORDER').catch((err) => {
        console.error('[orders] enqueueOrderTicket 失败（mock 支付）:', (err as Error).message)
      })
      return success(res, { mode: 'mock', status: 'PAID', paidAt })
    }

    // Real WeChat Pay
    validatePayConfig()
    const openid = req.openid
    if (!openid) throw new AppError(40101, '未登录或 token 缺少 openid，无法发起微信支付', 401)

    // 已有未过期的预下单：直接复用 prepay_id，避免重复点「去支付」时 out_trade_no 被覆盖
    const existing = order.payment
    if (existing && existing.status === 'PENDING' && existing.paymentType === 'WECHAT' && existing.wxPrepayId && existing.outTradeNo) {
      return success(res, { mode: 'wechat', ...generatePayParams(existing.wxPrepayId) })
    }

    const outTradeNo = `order_${orderId}_${Date.now()}`
    const prepayId = await createJsapiOrder({
      outTradeNo,
      description: `订单 ${order.orderNo}`,
      amount: order.actualAmount, // fen
      openid,
      notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL!,
      timeExpire: payExpireAtOf(order.createdAt, config.order.payTimeoutMin),
    })

    await prisma.payment.upsert({
      where: { orderId },
      update: { outTradeNo, wxPrepayId: prepayId, status: 'PENDING', paymentType: 'WECHAT' },
      create: {
        orderId,
        orderNo: order.orderNo,
        outTradeNo,
        paymentType: 'WECHAT',
        amount: order.actualAmount,
        status: 'PENDING',
        wxPrepayId: prepayId,
      },
    })

    return success(res, { mode: 'wechat', ...generatePayParams(prepayId) })
  } catch (e) {
    next(e)
  }
})

export default router
