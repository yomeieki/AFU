/**
 * 配送报价取数（规格 §6b 的「取数与管道」部分）。
 *
 * 只做三件事：查价、存快照、把快照交出去。**不做呼叫策略**——「默认只呼最低价 + 3 分钟无人接
 * 自动并呼六家」整套建立在「实际扣费 = 中标运力的报价」这个尚未证实的假设上（规格 §6b
 * 「联调必须验证」），若快递100 实为统一定价则策略本身失去意义。真实联调验证之后再做，
 * 而快照本身无论那个答案是什么都有价值：它既是对账依据，也正是那次验证要用的数据。
 *
 * ── 快照结构（Order.quoteSnapshot / Delivery.quoteSnapshot 两列同一结构）──
 * {
 *   "at": "2026-09-04T03:12:00.000Z",      // 查询完成时间；与 quotedAt 列同值
 *   "provider": "KD100",                    // 取数实现（KD100 | MOCK），mock 数据不会被误当成真账
 *   "quotes": [                             // 每家运力一条：编码 + 金额（分）+ 距离（米）
 *     { "provider": "meituantongcheng", "feeFen": 650, "distanceM": 1800 },
 *     { "provider": "shansongtongcheng", "feeFen": 1200, "distanceM": 1800 }
 *   ],
 *   "lowest": { "provider": "meituantongcheng", "feeFen": 650 }   // 无报价时为 null
 * }
 *
 * 为什么恰好是这些字段：规格 §6b「数据要求」要它能回答两个问题——
 *  ① 只呼最低价到底省了多少 = lowest 与 quotes 里其余各家的差；
 *  ② 扣费是否与报价一致 = 用回调带回的中标运力（Delivery.courierCompany，与 quotes[].provider
 *    同为快递100 kuaidicom 编码）在 quotes 里找出那一家的 feeFen，与 Delivery.quotedFee /
 *    actualFee 比对。
 * 因此「每家的运力标识 + 金额」与「查询时间」是硬要求；distanceM 附带，因为比价只有在
 * 距离一致时才可比（同一次查询六家距离本应相同，不同就说明运力方各自算路，值得知道）。
 * at 写进 JSON 而不是只留 quotedAt 列，是为了把快照单独导出去对账时不必再回表关联。
 */
import prisma from '../../utils/prisma'
import { AppError } from '../../middlewares/error'
import { getLocalSettings, LocalDeliverySettings } from '../local-settings'
import { getDeliveryProvider } from './provider'
import { ProviderError, ProviderQuote } from './types'

/** 规格 §6b：超过 5 分钟的报价算「已过期」，定时任务也按这个阈值重查 */
export const QUOTE_FRESH_MS = 5 * 60 * 1000

/**
 * 顾客侧查价的超时预算。店员侧仍用 provider 默认的 8 秒（见 DeliveryProvider.price 注释）：
 * 顾客站在地址页等这个数字，5 秒不回就该拿估算值先给他看，而不是让他盯着转圈。
 */
export const CUSTOMER_QUOTE_TIMEOUT_MS = 5000

/**
 * 拿运力方返回的**真实道路距离**（米）。查不到就返回 null，由调用方退回 Haversine 估算——
 * 这里永远不抛异常。
 *
 * 为什么顾客侧要用真实距离而不是「直线 × 系数」：店主 2026-09-04 用免费的 batchPrice 打了 8 个方向，
 * 实测比值 1.30–2.12（正西 2.12 vs 东北 1.30，差 63%）。自贡是山城又夹着釜溪河，任何固定系数
 * 在某些方向都必然错得离谱——原来的 1.35 平均低估 19%、最差方向低估 36%，每单都在倒贴。
 *
 * 超时做了两层：
 *  ① `timeoutMs` 传进 provider，让底层 fetch 真的 abort（否则连接会挂在那儿等 8 秒才释放）；
 *  ② 外层再 race 一个稍宽的计时器兜底，保证**无论 provider 怎么实现**顾客都不会等超过这个预算。
 *     ② 单独存在不够（socket 会泄漏到 8 秒），① 单独存在也不够（provider 可以忽略这个参数）。
 *
 * 返回距离**与最低报价**。最低报价不是原样透出去给顾客看的——顾客看到的是
 * `quoteBaseFee()` 算出来的「最低价 + 加价（取整）」，成本本身仍然不出现在任何顾客侧字段里
 * （见 routes/local.ts 的响应体：只有 fee，没有 quotes/feeFen）。
 * 取**最低**而不是各家平均：最低那家正是三级阶梯第一级会呼的那家，也就是我们真正要付的钱。
 */
export async function measureRoadQuote(
  s: LocalDeliverySettings,
  receiver: { latE6: number; lngE6: number },
  timeoutMs: number = CUSTOMER_QUOTE_TIMEOUT_MS
): Promise<{ distanceM: number; lowestFen: number | null } | null> {
  if (s.store.latE6 === null || s.store.lngE6 === null) return null
  let timer: NodeJS.Timeout | undefined
  try {
    const priced = await Promise.race([
      getDeliveryProvider().price({
        sender: {
          name: s.store.name, mobile: s.store.phone, province: s.store.province, city: s.store.city,
          district: s.store.district, address: s.store.address, latE6: s.store.latE6, lngE6: s.store.lngE6,
        },
        // 报价只用坐标算路，收件人信息在这一步没有意义（顾客可能还没选好地址）——
        // 用门店自己的行政区 + 占位人名，避免把顾客姓名手机号送给运力方做一次无谓的外发。
        receiver: {
          name: '报价', mobile: s.store.phone, province: s.store.province, city: s.store.city,
          district: s.store.district, address: '报价点', latE6: receiver.latE6, lngE6: receiver.lngE6,
        },
        timeoutMs,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`查价超时 ${timeoutMs}ms`)), timeoutMs + 300)
      }),
    ])
    const d = priced.distanceM
    // 0 与负数不是「很近」，是运力方没算出路来。当成没查到，别拿它去判范围和算钱。
    if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return null
    // 最低价要**按设置里的运力表过滤后**再取：三级阶梯第一级挑的就是这个集合里最便宜那家
    // （见 orchestrator.resolveCallProviders 的 `usable`）。不过滤的话，店主刚把达达摘掉时
    // 会出现「按达达的价收钱、实际呼蜂鸟」——收的和付的不是同一家。
    const usable = (priced.quotes ?? [])
      .filter((q) => s.kd100.providers.includes(q.provider))
      .map((q) => q.feeFen)
      .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
    return { distanceM: Math.round(d), lowestFen: usable.length ? Math.min(...usable) : null }
  } catch (e) {
    console.warn('[quote] 顾客侧查价失败，退回直线估算:', (e as Error)?.message ?? e)
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface QuoteSnapshot {
  at: string
  provider: string
  quotes: ProviderQuote[]
  lowest: { provider: string; feeFen: number } | null
}

export function isQuoteStale(quotedAt: Date | null | undefined, now: number = Date.now()): boolean {
  return !quotedAt || now - quotedAt.getTime() > QUOTE_FRESH_MS
}

/**
 * 查一次六家报价并写进 Order。
 *
 * @returns persisted=false 表示查到了但没落库——订单在外呼那几百毫秒里离开了备餐中，
 *          或者期间已经有一份更新的报价落了库（见下面的时间守卫）。查价免费且无副作用，
 *          丢掉一份过期结果没有任何代价，因此不算失败。
 */
export async function refreshOrderQuote(orderId: number): Promise<{ snapshot: QuoteSnapshot; quotedAt: Date; persisted: boolean }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, status: true, deliveryType: true,
      receiverName: true, receiverPhone: true, receiverProvince: true, receiverCity: true,
      receiverDistrict: true, receiverDetail: true, receiverPoiName: true,
      receiverLatE6: true, receiverLngE6: true,
    },
  })
  if (!order) throw new AppError(40401, '订单不存在', 404)
  if (order.deliveryType !== 'LOCAL') throw new AppError(42204, '仅同城订单可查配送报价')
  if (order.status !== 'PREPARING') throw new AppError(42204, `订单状态为 ${order.status}，仅备餐中订单可查配送报价`)
  if (order.receiverLatE6 === null || order.receiverLngE6 === null) throw new AppError(42223, '订单缺少收货坐标，无法查价')

  const s = await getLocalSettings()
  if (s.store.latE6 === null || s.store.lngE6 === null) throw new AppError(42226, '门店尚未设置坐标')

  const provider = getDeliveryProvider()
  let priced: Awaited<ReturnType<typeof provider.price>>
  try {
    priced = await provider.price({
      sender: { name: s.store.name, mobile: s.store.phone, province: s.store.province, city: s.store.city, district: s.store.district, address: s.store.address, latE6: s.store.latE6, lngE6: s.store.lngE6 },
      receiver: { name: order.receiverName, mobile: order.receiverPhone, province: order.receiverProvince, city: order.receiverCity, district: order.receiverDistrict,
                  address: `${order.receiverDetail}${order.receiverPoiName ? `（${order.receiverPoiName}）` : ''}`, latE6: order.receiverLatE6, lngE6: order.receiverLngE6 },
    })
  } catch (e) {
    // batchPrice 免费、不下单、无任何副作用，所以失败一律是「这次没查到」，不存在 UNKNOWN 语义，
    // 也不熔断（余额不足不影响查价）。调用方自己决定是告警还是静默：接单路径静默，手动刷新要报错。
    if (e instanceof ProviderError) throw new AppError(42225, `查询配送报价失败：${e.message}`)
    throw e
  }

  const at = new Date()
  const lowest = priced.quotes.length
    ? priced.quotes.reduce((a, b) => (b.feeFen < a.feeFen ? b : a))
    : null
  const snapshot: QuoteSnapshot = {
    at: at.toISOString(),
    provider: provider.name,
    quotes: priced.quotes,
    lowest: lowest ? { provider: lowest.provider, feeFen: lowest.feeFen } : null,
  }

  // 两道写入守卫：
  //  ① status:'PREPARING' —— 不把报价写到已经取消/已发货的订单上（外呼期间订单可能已流转）；
  //  ② quotedAt 单调 —— 并发两次查价（比如定时任务与店员手动刷新撞上）时，先发后到的旧结果
  //     不得覆盖新结果，否则店员刚点完刷新看到的数字会被一份更老的报价顶掉。
  const written = await prisma.order.updateMany({
    where: { id: orderId, status: 'PREPARING', OR: [{ quotedAt: null }, { quotedAt: { lt: at } }] },
    data: { quoteSnapshot: snapshot as unknown as object, quotedAt: at },
  })
  return { snapshot, quotedAt: at, persisted: written.count > 0 }
}

/** 接单等主流程里的「锦上添花」调用：查价失败绝不能影响主流程，只留一行 warn */
export function kickOffQuote(orderId: number): void {
  void refreshOrderQuote(orderId).catch((e) => {
    console.warn('[quote] 订单', orderId, '预取配送报价失败（不影响接单）:', (e as Error)?.message ?? e)
  })
}
