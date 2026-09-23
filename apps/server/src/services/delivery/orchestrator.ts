/**
 * 配送单编排层。铁律：
 *  - 外呼永远在事务外；外呼前（占位）后（落结果）各一段短事务
 *  - 进入终态的所有路径，同一条 update 里 activeOrderId: null
 *  - Delivery 并发防线 = activeOrderId 唯一索引（照抄 refund.ts 的 P2002 范式）
 */
import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { AppError } from '../../middlewares/error'
import { config } from '../../config'
import { getLocalSettings, KD100_PROVIDERS } from '../local-settings'
import { getDeliveryProvider } from './provider'
import { ProviderError, CreateDeliveryOrderInput } from './types'
import { isQuoteStale, refreshOrderQuote, QuoteSnapshot } from './quote'
import { isCircuitTripped, tripCircuit } from './circuit'
import { recordDeliveryEvent, adminEventKey, trunc } from './events'
import { notifySystemAlert } from '../notify'
import { notifyLocalDeliveryAlert } from '../order-notify'
import { TERMINAL, providerLabel } from './state'
import { ACTIVE_REFUND_STATUSES } from '../refund'
import { settlePoints } from '../member/points'

export async function getActiveDelivery(orderId: number) {
  return prisma.delivery.findFirst({ where: { activeOrderId: orderId } })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface CallRiderInput {
  orderId: number
  operator: string
  source: 'ADMIN' | 'SCHEDULER'
  /**
   * 指定本次呼叫的运力（kuaidicom 编码），不传 = 用设置里的默认列表并呼。
   * 规格 §10 的口子：将来做「并呼六家 / 某家一对一」二选一时只改配置、不动接口结构，
   * 所以是具名列表而不是 oneToOne 布尔值——哪家算「一对一」不该焊死在代码里。
   * v1 后台界面不暴露，但接口与 Delivery.calledProviders 已经能承载它。
   */
  providers?: string[]
  /**
   * **内部字段，不从 HTTP 收**：覆盖本次呼叫记进 Delivery.callStrategy 的标签。
   *
   * 只有自动升级任务用它——升级时要显式带全表 providers 去并呼，若不覆盖就会被下面的
   * 「传了 providers = 店员指定」判成 MANUAL，把「系统升级并呼」错记成人工操作，
   * 而 §7.2 的观察项（升级并呼到底会不会收到 720）恰恰要靠这个标签把这批单捞出来。
   */
  callStrategy?: DeliveryCallStrategy
  /**
   * **内部字段，不从 HTTP 收**：这一次按哪种方式挑运力，覆盖设置里的 callStrategy.mode。
   *
   * 只有自动升级任务用它。升级是一级一级往上走的（第一次一家 → 第二次最便宜 N 家 →
   * 第三次全部），每一级都要重新按**当时**的报价挑人，而不能拿三分钟前那份快照里
   * 算好的名单：报价会变，运力表也可能被店主改过。把「挑谁」这件事整个交回
   * resolveCallProviders，就能顺带复用它的重新查价、按运力表过滤、挑不出来退回并呼
   * 这三段逻辑，不用在升级任务里再抄一份。
   */
  forceMode?: 'SOLO_LOWEST' | 'CHEAPEST_N' | 'ALL'
  /**
   * **内部字段，不从 HTTP 收**：预约单的呼叫来源（计划差异②）。SCHEDULED_AUTO = 已备好后到点自动发单
   * （schedule-tasks / `/ready` 到点即呼）；MANUAL_EARLY = 店员「立即呼叫」跳过等待；不传 = 普通手动 / 升级。
   */
  origin?: DeliveryCallOrigin
}

/**
 * Delivery.callStrategy 的取值域。
 * SOLO      = 只呼了报价最低那一家
 * CHEAPEST  = 并呼了报价最低的 N 家（2026-09-07 起的默认策略）
 * ALL       = 并呼全表
 * MANUAL    = 店员在弹窗里指定的
 * *_HELD    = 只由升级任务写：等超时了但预估取消费 > 0，放弃自动升级、留原样等人工决定。
 *             不是一次呼叫的结果，所以和上面几个分开取值。
 */
export type DeliveryCallStrategy =
  | 'SOLO' | 'CHEAPEST' | 'ALL' | 'MANUAL'
  | 'SOLO_HELD' | 'CHEAPEST_HELD' | 'MANUAL_HELD'

export type DeliveryCallOrigin = 'SCHEDULED_AUTO' | 'MANUAL_EARLY'

/**
 * 超时未接时，各策略对应的「放弃升级」标记。没有对应值的策略不参与自动升级。
 *
 * MANUAL 在 2026-09-07 被加了进来。原来把它排除在外，理由是「店员亲手指定的运力，
 * 系统不该在背后换掉」——那条理由在店主定下新阶梯之后不成立了：
 * **第一次就是店员从全部报价里挑一家，第二次一律并呼全部**。把 MANUAL 排除在外，
 * 等于店员一旦手选，这单就永远等不到第二次，菜做好了却挂在那儿没人送。
 * 升级只在「仍是 CALLING（没人接）且预估取消费为 0」时才动手，所以不会撤掉已接单的骑手。
 */
export const HELD_OF: Partial<Record<DeliveryCallStrategy, DeliveryCallStrategy>> = {
  SOLO: 'SOLO_HELD', CHEAPEST: 'CHEAPEST_HELD', MANUAL: 'MANUAL_HELD',
}

/**
 * 超时未接时，当前策略的**下一级**该怎么呼（店主 2026-09-12 改成两级）：
 *      一家（SOLO / 店员手选 MANUAL，含「极速」只呼闪送）→ 最便宜 N 家 → 到头，只提醒店员
 * 有对应值 = 还能往上升；CHEAPEST / ALL / *_HELD 不在表里，走到头了。
 * 原来第三级是「并呼全部」，店主 2026-09-12 去掉：三家都没人接再全呼多半也没人，
 * 白冻一笔 ¥75，不如立刻叫人处理（tasks.ts 的 escalateSoloCalls 到头时发一次告警）。
 * 「走到第几级」由当前策略本身表达，不需要另设计数器。
 */
export const NEXT_RUNG: Partial<Record<DeliveryCallStrategy, 'CHEAPEST_N'>> = {
  SOLO: 'CHEAPEST_N', MANUAL: 'CHEAPEST_N',
}

/**
 * 呼叫成功那条事件的文案。店员在时间线上看到的第一行就是它，所以要一眼看出
 * 「这单呼了谁、花多少、接下来会自动发生什么」——原来固定写「并呼抢单中」，
 * 只呼最低价上线后那句话会变成谎话。
 */
function callEventDesc(
  strategy: DeliveryCallStrategy,
  called: string[],
  lowest: { provider: string; feeFen: number } | null,
  escalateAfterMin: number,
  cheapestN: number,
  chosen?: { provider: string; feeFen: number }[],
): string {
  const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`
  // 两级阶梯：第一级（一家）到点升到最便宜 N 家；第二级到点不再加人，只提醒店员
  const upTail = escalateAfterMin > 0 ? `（约 ${escalateAfterMin} 分钟无人接自动改为并呼最便宜 ${cheapestN} 家）` : '（不自动升级）'
  const endTail = escalateAfterMin > 0 ? `（约 ${escalateAfterMin} 分钟无人接将提醒店员，不再自动加人）` : '（不自动升级）'
  if (strategy === 'SOLO' && lowest) {
    return `只呼最低价 ${providerLabel(lowest.provider)} ${yuan(lowest.feeFen)}${upTail}`
  }
  if (strategy === 'CHEAPEST' && chosen?.length) {
    // 把选中的几家连价一起写出来：对账时「为什么冻了这么多」只看这一行就够
    const list = chosen.map((q) => `${providerLabel(q.provider)} ${yuan(q.feeFen)}`).join('、')
    const total = chosen.reduce((n, q) => n + q.feeFen, 0)
    return `并呼最便宜 ${chosen.length} 家：${list}；合计冻结约 ${yuan(total)}${endTail}`
  }
  if (strategy === 'MANUAL') return `已向指定运力下单：${called.map(providerLabel).join('、')}${upTail}`
  return `已向运力方下单（并呼 ${called.length} 家抢单中）`
}

/**
 * 决定这一次呼谁：最便宜的 N 家、只呼最低那一家，还是并呼全表。
 *
 * 三条边界，每条都有代价不对称的理由：
 *  - 店员在弹窗里指定了运力 → 原样照办（MANUAL），策略不插手人工决定；
 *  - 快照过期就同步重查一次：`batchPrice` 免费、不下单、不落库，约 1 秒。「接单并呼叫」
 *    路径上占位时快照几乎必空（见 callRider 里的注释），不重查的话那条路径永远退回并呼，
 *    策略等于没上；
 *  - **查不到报价 → 退回并呼，而不是拒绝呼叫**。顾客已经付过钱、菜已经做好了，
 *    此刻宁可多花几块钱把单送出去，也不能因为查价失败把订单卡在备餐中。
 */
async function resolveCallProviders(
  orderId: number,
  s: Awaited<ReturnType<typeof getLocalSettings>>,
  order: { quoteSnapshot: Prisma.JsonValue | null; quotedAt: Date | null },
  input: CallRiderInput,
): Promise<{
  providers: string[] | undefined
  callStrategy: DeliveryCallStrategy
  lowest: { provider: string; feeFen: number } | null
  /** CHEAPEST 实际选中的那几家（含价），只用于事件文案与对账 */
  chosen: { provider: string; feeFen: number }[]
  /** 策略**实际据以决策**的那份快照；只在这里现查了一次时非空，用于覆盖占位行上更旧的那份 */
  fresh: { snapshot: QuoteSnapshot; quotedAt: Date } | null
}> {
  const none = { chosen: [] as { provider: string; feeFen: number }[] }
  if (input.callStrategy) return { providers: input.providers, callStrategy: input.callStrategy, lowest: null, fresh: null, ...none }
  if (input.providers?.length) return { providers: input.providers, callStrategy: 'MANUAL', lowest: null, fresh: null, ...none }
  // 升级任务用 forceMode 指定这一级该怎么挑；平时为空，走设置里的 mode
  const mode = input.forceMode ?? s.callStrategy.mode
  if (mode === 'ALL') return { providers: undefined, callStrategy: 'ALL', lowest: null, fresh: null, ...none }

  let snapshot: QuoteSnapshot | null = null
  let fresh: { snapshot: QuoteSnapshot; quotedAt: Date } | null = null
  if (!isQuoteStale(order.quotedAt)) {
    snapshot = (order.quoteSnapshot as QuoteSnapshot | null) ?? null
  } else {
    try {
      const r = await refreshOrderQuote(orderId)
      snapshot = r.snapshot
      // 现查的这份就是策略的依据，必须跟着落到配送单上——否则抽屉里显示的是几分钟前
      // 那份旧报价，看不出「为什么挑了这一家」，对账时也对不上。
      fresh = { snapshot: r.snapshot, quotedAt: r.quotedAt }
    } catch (e) {
      // 查价失败不是呼叫失败：记一行、退回并呼。refreshOrderQuote 自己已经把 ProviderError
      // 包成 AppError，这里连它一起吞——见函数头「宁可多花几块钱也要把单送出去」。
      console.warn('[callRider] 订单', orderId, '呼叫前查价失败，退回并呼:', (e as Error)?.message ?? e)
    }
  }
  // 快照里挑出来的运力必须仍在设置的运力表里：店主可能刚把某家摘掉，而快照是几分钟前的。
  // 不在表里的一律先滤掉，不要拿一个已被摘掉的运力去下单。
  const usable = (snapshot?.quotes ?? [])
    .filter((q) => s.kd100.providers.includes(q.provider))
    .sort((a, b) => a.feeFen - b.feeFen)
    .map((q) => ({ provider: q.provider, feeFen: q.feeFen }))

  if (mode === 'CHEAPEST_N') {
    // 一家都挑不出来（没报价 / 全被摘了）才退回并呼；挑出 1 家也照呼——
    // 「只剩一家可呼」和「呼全表」是两回事，后者会多冻六笔钱。
    const chosen = usable.slice(0, s.callStrategy.cheapestN)
    return chosen.length
      ? { providers: chosen.map((q) => q.provider), callStrategy: 'CHEAPEST', lowest: chosen[0], chosen, fresh }
      : { providers: undefined, callStrategy: 'ALL', lowest: null, fresh, ...none }
  }

  const lowest = usable[0] ?? null
  return lowest
    ? { providers: [lowest.provider], callStrategy: 'SOLO', lowest, fresh, ...none }
    : { providers: undefined, callStrategy: 'ALL', lowest: null, fresh, ...none }
}

export async function callRider(input: CallRiderInput) {
  const { orderId, operator, source } = input
  if (isCircuitTripped()) throw new AppError(42232, '快递100 余额不足已暂停呼叫，请充值后在系统状态页点「恢复」')

  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: { include: { product: { select: { netWeightG: true } } } } } })
  if (!order) throw new AppError(40401, '订单不存在', 404)
  if (order.deliveryType !== 'LOCAL') throw new AppError(42204, '仅同城订单可呼叫骑手')
  if (order.status !== 'PREPARING') throw new AppError(42204, `订单状态为 ${order.status}，仅备餐中订单可呼叫骑手`)
  // 「处理」= 同意（取消配送+退款）或驳回（POST /admin/local/orders/:id/cancel-request/reject 清标记），二者之一做完才放行
  if (order.cancelRequestedAt) throw new AppError(42204, '顾客有待处理的取消申请，请先处理')
  if (order.receiverLatE6 === null || order.receiverLngE6 === null) throw new AppError(42223, '订单缺少收货坐标，无法呼叫骑手')

  const s = await getLocalSettings()
  if (s.store.latE6 === null || s.store.lngE6 === null) throw new AppError(42226, '门店尚未设置坐标')

  // 去重：调用方传重复编码（如页面表单误勾两次）会被原样传进 kuaidiComList，
  // 快递100 那边行为未定义，本地也没必要留两条一样的 calledProviders。
  const asked = input.providers?.length ? [...new Set(input.providers)] : undefined
  // 指定运力必须是已知编码：拼错一个字母，快递100 那边只会返回「没有可用运力」，
  // 到时候看起来像是运力紧张而不是参数写错——在本地就拦下来，错因才不会被掩埋。
  // ⚠️ 这道白名单必须在策略选择**之前**跑，且只校验调用方传进来的那份：拿到 40001
  // 的应该是「店员勾了个拼错的编码」，而不是策略引擎挑出来的（它已从 s.kd100.providers 里选）。
  const bad = (asked ?? []).filter((p) => !(KD100_PROVIDERS as readonly string[]).includes(p))
  if (bad.length) throw new AppError(40001, `未知运力编码：${bad.join(', ')}`)

  // 呼谁：只呼最低价 / 并呼全表 / 店员指定。查价可能有一次网络往返（约 1 秒），
  // 所以放在占位事务之前——占位一旦建好就占住了 activeOrderId，不该拿着它去等网络。
  const { providers, callStrategy, lowest, chosen, fresh } = await resolveCallProviders(orderId, s, order, { ...input, providers: asked })
  const calledProviders = providers?.length ? providers : s.kd100.providers
  // 策略若现查了一份新报价，它就是这次呼叫的依据，占位行直接用它（而不是 :45 读到的旧值）
  const snapshotForDelivery = fresh?.snapshot ?? order.quoteSnapshot
  const quotedAtForDelivery = fresh?.quotedAt ?? order.quotedAt

  // S1（2026-09-23 修）：调度器到点自动呼叫（SCHEDULER + SCHEDULED_AUTO）不得替店员「重新表达已备好」。
  // 店员在工作台点「取消呼叫/取消配送」等于撤回「已备好」（见 cancelDelivery），之后系统不该再自动把
  // readyAt 补回去——虽然 autoCallScheduled 的候选查询本身已要求 readyAt 非空（这条写从不会被它触发），
  // 这里仍显式排除，把「调度器绝不主动写 readyAt」的不变量钉死在这一处，不依赖候选查询这一层防线。
  const schedulerAuto = source === 'SCHEDULER' && input.origin === 'SCHEDULED_AUTO'
  // 预约单：呼叫即视为已备好（spec §4.5 不变量：有在途配送单 ⇒ readyAt 非空）。呼叫失败也保留——店员表达过「好了」。
  // 复核 R1：必须挪到占位 delivery.create 之前写——这样任何时刻只要有 delivery 行存在，readyAt 必已非空，
  // 不再有「占位已建但 readyAt 仍为 null」的窗口（下面的原子复核在占位创建之后才跑，补不上这半程）。
  // where 补 status: 'PREPARING'：此刻订单可能已被并发的秒退/取消翻走，不带状态条件会在 REFUNDING 上误写 readyAt。
  if (order.scheduledAt && !order.readyAt && !schedulerAuto) {
    await prisma.order.updateMany({ where: { id: orderId, status: 'PREPARING', readyAt: null }, data: { readyAt: new Date() } })
  }

  // 占位事务：activeOrderId 唯一索引 = 并发防线
  const seq = (await prisma.delivery.count({ where: { orderId } })) + 1
  const deliveryNo = `D${orderId}-${seq}`
  const callbackUrl = `${config.publicBaseUrl}/api/kd/${deliveryNo}`
  if (callbackUrl.length > 50) throw new AppError(42225, `回调地址超长（${callbackUrl.length}>50），请联系管理员缩短域名/路径`)
  const callbackSalt = crypto.randomBytes(8).toString('hex')   // 16 字符 ≤ VarChar(20)
  let deliveryId: number
  try {
    const created = await prisma.delivery.create({ data: {
      orderId, orderNo: order.orderNo, deliveryNo, activeOrderId: orderId,
      provider: getDeliveryProvider().name, status: 'PENDING', statusRank: 0,
      callbackSalt, operator: trunc(operator, 64) ?? operator,
      // 呼叫当次的报价快照从 Order 复制过来（规格 §6b「Delivery 必须存当次六家报价的快照」）。
      // 这里多半为空：报价是接单时后台异步取的（kickOffQuote，一次网络往返），占位创建
      // 到这里全是本地 DB 调用，几乎必然抢在查价落库之前。不为此阻塞呼叫——高峰期那一刻
      // 店员最急。空缺会在外呼成功后的落库事务里补（:129 附近），不会一直空着。
      quoteSnapshot: (snapshotForDelivery ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
      quotedAt: quotedAtForDelivery,
      calledProviders, callStrategy, callOrigin: input.origin ?? null,
    } })
    deliveryId = created.id
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(42228, '该订单已有在途配送单')
    }
    throw e
  }

  // 原子复核：:34 读到的是占位创建前的快照，纯 JS 判断挡不住之后几毫秒内插进来的退款/取消——
  // 那笔事务可能在我们创建占位之后、外呼之前才提交。占位已经拿到 activeOrderId 唯一索引，
  // 此刻再读一次订单当前状态，不行就照 :105 落库失败的形状释放占位，绝不能带着这单去外呼。
  // S1：调度器自动呼叫再加一条 readyAt 非空复核——「心跳已加载候选 → 店员取消提交（清空 readyAt）
  // → 心跳走到这里」这段毫秒级窗口里，占位建好后这次复核会发现 readyAt 已空，按下面同一形状
  // 释放占位并抛错，绝不外呼。ADMIN 来源（店员手动呼叫/立即呼叫）不受影响，不加这条件。
  const stillValid = await prisma.order.count({ where: { id: orderId, status: 'PREPARING', cancelRequestedAt: null, ...(schedulerAuto ? { readyAt: { not: null } } : {}) } })
  if (stillValid === 0) {
    await prisma.delivery.updateMany({ where: { id: deliveryId, status: 'PENDING' }, data: {
      status: 'FAILED', activeOrderId: null, errorCode: 'RACE', failReason: '占位后发现订单状态已变化（可能正在退款/取消），呼叫已取消',
    } })
    throw new AppError(42204, '订单状态已变化（可能正在退款/取消），呼叫骑手已取消')
  }

  const totalItems = order.items.reduce((n, it) => n + it.quantity, 0)
  const weightKg = order.items.reduce((w, it) => w + ((it.product?.netWeightG ?? s.kd100.defaultItemWeightG) * it.quantity) / 1000, 0)
  const req: CreateDeliveryOrderInput = {
    deliveryNo, callbackUrl, callbackSalt,
    providers,
    sender: { name: s.store.name, mobile: s.store.phone, province: s.store.province, city: s.store.city, district: s.store.district, address: s.store.address, latE6: s.store.latE6, lngE6: s.store.lngE6 },
    receiver: { name: order.receiverName, mobile: order.receiverPhone, province: order.receiverProvince, city: order.receiverCity, district: order.receiverDistrict,
                address: `${order.receiverDetail}${order.receiverPoiName ? `（${order.receiverPoiName}）` : ''}`, latE6: order.receiverLatE6, lngE6: order.receiverLngE6 },
    goods: { title: '凉菜', weightKg: Math.max(0.5, weightKg), totalPriceFen: order.totalAmount, count: totalItems },
    remark: order.remark ?? '',
  }

  // 外呼（事务外）。N7：ADMIN 不重试；SCHEDULER 对 CAPACITY 退避重试 2 次
  const provider = getDeliveryProvider()
  const delays = source === 'SCHEDULER' ? config.kd100.retryDelaysMs : []
  let lastErr: ProviderError | null = null
  let result: Awaited<ReturnType<typeof provider.createOrder>> | null = null
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try { result = await provider.createOrder(req); lastErr = null; break }
    catch (e) {
      if (!(e instanceof ProviderError)) throw e
      lastErr = e
      if (e.kind === 'TIMEOUT' || e.kind !== 'CAPACITY' || attempt === delays.length) break
      await sleep(delays[attempt])
    }
  }

  if (result) {
    try {
      await prisma.$transaction(async (tx) => {
        // 回填「接单并呼叫」路径上系统性落空的快照（:76 注释）：kickOffQuote 的查价是
        // 一次网络往返（秒级），而占位创建到这里全是本地 DB 调用（毫秒级），占位时几乎
        // 必然抢在查价落库之前，order.quoteSnapshot（:45 那次性读出）恒为空。但外呼本身
        // 通常耗时数秒，此刻查价异步任务大概率已经写完，值得再读一次补上。
        // 仅在占位时为空才回填——占位时若已带着快照（例如备餐几分钟后的手动「呼叫骑手」
        // 路径），那份就是「呼叫当时看到的价」，不能被此刻可能已被 5 分钟保鲜任务
        // 刷新过的新报价覆盖，快照的意义就在于锁定呼叫那一刻。
        const quoteBackfill = snapshotForDelivery
          ? null
          : await tx.order.findUnique({ where: { id: orderId }, select: { quoteSnapshot: true, quotedAt: true } })
        const landed = await tx.delivery.updateMany({ where: { id: deliveryId, status: 'PENDING' }, data: {
          status: 'CALLING', statusRank: 10, calledAt: new Date(),
          providerTaskId: trunc(result!.taskId, 64), providerOrderId: trunc(result!.providerOrderId, 64),
          quotedFee: result!.quotedFeeFen, providerDistanceM: result!.distanceM,
          // 下单那一刻各家的真预扣。空数组也要落成 JSON `[]` 而不是 DbNull——「查了但一家都没回」
          // 与「这一版代码还不记这个」是两件事，NULL 留给后者（历史行）。
          orderFees: result!.quotes as unknown as Prisma.InputJsonValue,
          ...(quoteBackfill?.quoteSnapshot
            ? { quoteSnapshot: quoteBackfill.quoteSnapshot as Prisma.InputJsonValue, quotedAt: quoteBackfill.quotedAt }
            : {}),
        } })
        if (landed.count === 0) {
          // where 里的 status:'PENDING' 本身已经保护了不变量（不会覆盖占位被挪去的其它状态），
          // 但结果就此静默丢弃：运力方已经真的下了单，本地却谁都不知道。今天只有 10 分钟陈旧
          // PENDING 清扫能抢走这一行，实践中够不到；一旦够到，必须有人去核对，不能悄悄过去。
          notifySystemAlert('呼叫骑手成功但占位状态已变化，结果被丢弃', [`订单 ${order.orderNo}（${deliveryNo}）`, `taskId=${result!.taskId ?? ''}`, '请到快递100 后台核对，必要时人工登记'], { key: `kd100-landing-race:${orderId}` })
          return
        }
        await recordDeliveryEvent(tx, { deliveryId, dedupeKey: adminEventKey(), source: 'API', statusDesc: callEventDesc(callStrategy, calledProviders, lowest, s.callStrategy.escalateAfterMin, s.callStrategy.cheapestN, chosen), operator })
      })
    } catch (e) {
      // 落库失败（如 providerTaskId 撞唯一索引）会让占位行永远停在 PENDING：
      // voidUnknownDelivery 只收 UNKNOWN、cancelDelivery 要求有 taskId，没有任何人能救它，
      // 该订单就此永久不可再呼。所以这里必须同条 update 释放占位再抛。
      await prisma.delivery.updateMany({ where: { id: deliveryId, status: 'PENDING' }, data: {
        status: 'FAILED', activeOrderId: null, errorCode: 'PERSIST',
        failReason: trunc(`下单成功但落库失败：${(e as Error).message}`, 255),
      } })
      notifySystemAlert('呼叫骑手成功但落库失败', [`订单 ${order.orderNo}（${deliveryNo}）`, '运力方可能已产生真实单，请到快递100 后台核对', (e as Error).message], { key: `kd100-persist:${orderId}` })
      throw new AppError(42225, '呼叫已发出但本地记录失败，请到快递100 后台核对后重试')
    }
    return { deliveryId, deliveryNo, status: 'CALLING' as const, quotedFeeFen: result.quotedFeeFen }
  }

  const err = lastErr!
  if (err.kind === 'TIMEOUT') {
    // 下单可能已成功：UNKNOWN 占位、不释放，等回调按 URL 认领或人工作废（决策见 spec §5.4）
    await prisma.$transaction(async (tx) => {
      const landed = await tx.delivery.updateMany({ where: { id: deliveryId, status: 'PENDING' }, data: { status: 'UNKNOWN', calledAt: new Date(), errorCode: trunc(err.code, 16), failReason: trunc(err.message, 255) } })
      if (landed.count === 0) {
        notifySystemAlert('下单响应超时但占位状态已变化，结果被丢弃', [`订单 ${order.orderNo}（${deliveryNo}）`, '本地占位行已被其它流程改动，超时未能落库为 UNKNOWN，请人工核对'], { key: `kd100-landing-race-timeout:${orderId}` })
        return
      }
      await recordDeliveryEvent(tx, { deliveryId, dedupeKey: adminEventKey(), source: 'API', statusDesc: `下单响应超时，等待回调认领：${err.message}`, operator })
    })
    notifySystemAlert('快递100 下单响应超时', [`订单 ${order.orderNo}（${deliveryNo}）`, '请到快递100 后台核对是否已产生真实单；回调到达会自动认领，确认没单可在看板作废'], { key: `kd100-timeout:${orderId}` })
    return { deliveryId, deliveryNo, status: 'UNKNOWN' as const, quotedFeeFen: null }
  }

  // 明确失败：FAILED + 释放（先落库再抛，照抄 refund 范式）
  const firstTrip = err.kind === 'BALANCE' ? tripCircuit(err.code) : false
  await prisma.$transaction(async (tx) => {
    const landed = await tx.delivery.updateMany({ where: { id: deliveryId, status: 'PENDING' }, data: {
      status: 'FAILED', activeOrderId: null, errorCode: trunc(err.code, 16), failReason: trunc(err.message, 255),
    } })
    if (landed.count === 0) {
      notifySystemAlert('呼叫失败但占位状态已变化，结果被丢弃', [`订单 ${order.orderNo}（${deliveryNo}）`, `${err.code}: ${err.message}`, '本地占位行已被其它流程改动，请人工核对'], { key: `kd100-landing-race-fail:${orderId}` })
      return
    }
    await recordDeliveryEvent(tx, { deliveryId, dedupeKey: adminEventKey(), source: 'API', statusDesc: `呼叫失败(${err.code})：${err.message}`, operator })
  })
  if (err.kind === 'CONFIG') notifySystemAlert('快递100 配置类错误', [`订单 ${order.orderNo}：${err.code} ${err.message}`], { key: `kd100-config:${err.code}` })
  if (err.kind === 'BALANCE' && firstTrip) notifySystemAlert('快递100 余额不足，已熔断呼叫', ['请充值后在 系统状态 页点「恢复」', `触发订单 ${order.orderNo}`], { key: 'kd100-balance' })
  // CAPACITY 配合 autoCallRiders 每分钟重试：占位失败会释放 activeOrderId，订单仍是 PREPARING、
  // 下一跳候选查询必然再次命中（tasks.ts 的候选 where 只排除「有在途单」），运力持续紧张时
  // 会对同一个订单反复告警。notifyLocalDeliveryAlert 本身无去重，这里按订单号传 key 接入
  // notifySystemAlert 同一套 5 分钟抑制，不然告警频道会被同一条刷屏。
  if (err.kind === 'CAPACITY') notifyLocalDeliveryAlert('呼叫骑手失败（运力异常）', [`订单 ${order.orderNo}`, err.message, '可稍后重试、加小费或改自己送'], { key: `dlv-capacity:${orderId}` })
  // BUSINESS：_mapReturnCode 把 CONFIG/BALANCE/CAPACITY 之外的一切返回码（含未归类业务拒绝码、
  // DNS/连接失败、非 JSON 响应）都落成这一类。收窄到 SCHEDULER：手动呼叫（ADMIN）失败时店员
  // 已经能在确认弹窗当场看到 42225 原文（本函数最后一行 throw 出去的那条），不需要再重复告警；
  // 真正的信息差在 autoCallDelayMin>0 时 SCHEDULER 触发的失败——此前只会 console.warn 悄悄丢掉，
  // 店员要等 10 分钟通用「未呼叫骑手」提醒才知道这单有问题，且提醒文案不带失败原因。
  if (err.kind === 'BUSINESS' && source === 'SCHEDULER') notifySystemAlert('快递100 呼叫失败（未归类）', [`订单 ${order.orderNo}`, `${err.code}: ${err.message}`], { key: `dlv-business:${orderId}` })
  throw new AppError(42225, `呼叫骑手失败：${err.message}`)
}

export async function voidUnknownDelivery(input: { orderId: number; operator: string }): Promise<void> {
  const d = await getActiveDelivery(input.orderId)
  if (!d) throw new AppError(42233, '无在途配送单')
  if (d.status !== 'UNKNOWN') throw new AppError(42234, `当前配送单状态为 ${d.status}，仅「状态未确认」可作废`)
  const moved = await prisma.delivery.updateMany({ where: { id: d.id, status: 'UNKNOWN' }, data: {
    status: 'FAILED', activeOrderId: null, errorCode: 'VOIDED', failReason: '人工作废', operator: trunc(input.operator, 64),
  } })
  if (moved.count === 0) throw new AppError(42237, '配送单状态已变化，请刷新')
  await recordDeliveryEvent(prisma, { deliveryId: d.id, dedupeKey: adminEventKey(), source: 'ADMIN', statusDesc: '人工作废（快递100 后台确认无单）', operator: input.operator })
}

async function requireActive(orderId: number) {
  const d = await getActiveDelivery(orderId)
  if (!d) throw new AppError(42233, '无在途配送单')
  if (d.status === 'UNKNOWN') throw new AppError(42234, '配送单状态未确认：请等回调认领，或确认快递100 后台无单后作废')
  return d
}
/**
 * 骑手已取货后取消 → SHIPPED 回退 PREPARING。**720 回调与主动取消共用这一个实现**
 * （callback.ts 里 720 分支直接调它，不许各写一份——两份护栏迟早会drift）。
 * 三重护栏全部写进 where：先读后写会在读与写之间放进一笔部分退款（部分退款不改订单状态，
 * 因此 status 白名单挡不住它），那正是护栏要防的事。
 *
 * ⚠️ 语义提醒（B2-06）：这次回退之后，同城单的 PREPARING **不再等价于「货没出门」**——
 * 骑手取货后取消（720）/自送半路取消都会把一张菜已经做好甚至已报废的单放回 PREPARING。
 * 所以任何按 order.status 判断「要不要回滚库存」的地方都会被它骗到：
 * 退款回滚库存的依据必须是「货有没有出门」本身——EXPRESS 看 Shipment 行是否存在，
 * LOCAL 看最近一张 Delivery 的 pickedUpAt 是否非空（310 回调与 selfDeliver 是仅有的两个写入点），
 * 而不是 status ∈ {PAID, PREPARING}。这条规则的落点在 services/refund.ts（initiateRefund），
 * 这里只负责把「PREPARING 可能是回退来的」这个事实说清楚，不在此处伪装成未出库。
 */
/**
 * @returns { rolled, wasShipped }：rolled 是实际回退的订单行数（0 或 1）；wasShipped 是**调用前**
 * 订单是否处于 SHIPPED（货已出门）。
 *
 * B3-02/B3-03：rolled===0 本身不能当异常——「取消呼叫」（配送单还在 CALLING、订单还在 PREPARING，
 * 货压根没出门）是最常见的正常路径，此时订单从来就不是 SHIPPED，三重护栏里的 status:'SHIPPED'
 * 恒不命中，rolled 必然是 0。只有调用前 wasShipped 为真、却仍 rolled===0（被「在途退款/售后」
 * 这两条真正的护栏挡住）才是需要人工核对的异常。调用方必须用 `wasShipped && rolled === 0`
 * 判定异常，不能只看 rolled === 0。
 */
export async function rollbackOrderAfterCancel(tx: Prisma.TransactionClient, orderId: number): Promise<{ rolled: number; wasShipped: boolean }> {
  const before = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } })
  const wasShipped = before?.status === 'SHIPPED'
  const moved = await tx.order.updateMany({ where: {
    id: orderId, deliveryType: 'LOCAL', status: 'SHIPPED', completedAt: null,
    refunds: { none: { status: { in: [...ACTIVE_REFUND_STATUSES] } } },
    afterSales: { none: { status: { in: ['PENDING', 'APPROVED'] } } },
  }, data: { status: 'PREPARING' } })
  return { rolled: moved.count, wasShipped }
}

export async function precancelDelivery(orderId: number): Promise<{ cancelFeeFen: number | null }> {
  const d = await requireActive(orderId)
  if (!d.providerTaskId) throw new AppError(42234, '配送单尚未成单，无法预估取消费')
  return { cancelFeeFen: (await getDeliveryProvider().precancelOrder({ taskId: d.providerTaskId })).cancelFeeFen }
}

export async function cancelDelivery(input: { orderId: number; operator: string; reason?: string; source?: 'ADMIN' | 'SCHEDULER' }): Promise<{ cancelFeeFen: number | null }> {
  const source = input.source ?? 'ADMIN'
  const d = await requireActive(input.orderId)
  let cancelFeeFen: number | null = 0
  if (d.provider !== 'SELF' && d.providerTaskId) {
    try {
      cancelFeeFen = (await getDeliveryProvider().cancelOrder({ taskId: d.providerTaskId, reason: input.reason ?? '商家取消' })).cancelFeeFen
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'TIMEOUT') throw new AppError(42238, '取消请求超时，请稍后重试（状态未变化）')
      if (e instanceof ProviderError) throw new AppError(42225, `取消配送单失败：${e.message}`)
      throw e
    }
  }
  await prisma.$transaction(async (tx) => {
    const moved = await tx.delivery.updateMany({ where: { id: d.id, status: { notIn: [...TERMINAL] } }, data: { status: 'CANCELLED', activeOrderId: null, cancelledAt: new Date(), cancelReason: trunc(input.reason, 255) ?? '商家取消', cancelFee: cancelFeeFen ?? 0 } })
    if (moved.count === 0) {
      // 外呼（取消费的扣费）在事务外已经发生；这里写入没命中，说明配送单在 8 秒外呼期间
      // 被别的路径抢先终态化（例如店员双击、或回调抢先到达）。钱已经真花给运力方了，
      // 本地却没有任何记录能对上账——照 addTip 对同样处境的先例，先告警再抛，且告诉店员
      // 「勿直接重试」：第二次点击会通过 requireActive 再调一次 cancelOrder，等于再花一次钱。
      notifySystemAlert('取消已扣费但未记账', [
        `配送单 ${d.deliveryNo}（订单 ${d.orderNo}）`,
        `取消费 ¥${((cancelFeeFen ?? 0) / 100).toFixed(2)} 已提交运力方，但本地写入未命中（配送单状态已变化）`,
        '请到快递100 后台核对实际扣费，勿直接重试（会产生第二笔取消费）',
      ], { key: `dlv-cancel-lost:${d.id}` })
      throw new AppError(42237, '配送单状态已变化，请刷新。取消费可能已在运力方生效，请先核对再决定是否重试')
    }
    const { rolled, wasShipped } = await rollbackOrderAfterCancel(tx, input.orderId)
    // B3-02：「取消呼叫」（骑手还没取货，订单还在 PREPARING）是最常见的正常路径——此时订单
    // 从来就不是 SHIPPED，回退 0 行是预期之内，不算异常。只有调用前订单确实是 SHIPPED（货已
    // 出门）却仍回退不了，才是三重护栏之一（多半是在途退款/售后）挡住的真异常。
    const rollbackStuck = wasShipped && rolled === 0
    if (rollbackStuck) {
      // 假成功的另一半：配送单已经真的 CANCELLED、取消费也真扣了，但订单没能回退到 PREPARING
      // （三重护栏之一挡住：多半是有在途退款/售后）。店员会收到 code:0，以为订单已经能重新走流程，
      // 实际它停在 SHIPPED 且无在途配送单——call/self-deliver 要 PREPARING、delivered 要在途单，
      // 全都会拒绝，只能等 autoCompleteLocalDelivered 或一笔退款自愈。必须当场告诉人，不能装没事。
      notifySystemAlert('取消配送成功但订单未回退', [
        `配送单 ${d.deliveryNo}（订单 ${d.orderNo}）已置为已取消`,
        '订单未能回退到备餐中（可能存在在途退款/售后），订单会停留在 SHIPPED 且无在途配送单，请人工核对',
      ], { key: `dlv-cancel-order-stuck:${d.id}` })
    }
    // S1（店主决定 D1）：ADMIN 来源（店员在工作台主动取消）= 撤回「已备好」——readyAt 清空后，
    // schedulePhase 回落到 CALL_DUE/PREPPING，autoCallScheduled 的候选查询（readyAt 非空）不会
    // 再选中这张单，系统到点不再自动重呼；店员需要重新点「已备好/立即呼叫」或改自己送。
    // SCHEDULER 来源（escalateSoloCalls 撤 D-1 建 D-2 的自动升级）不清：店员没有表达过「不要骑手」，
    // 菜还是那盘做好的菜，升级只是换一批运力接着呼。scheduledAt 非空限定只对预约单生效，
    // 立即单 scheduledAt 恒为空，这条 updateMany 恒不命中，零影响。
    const unreadied = source === 'ADMIN'
      ? await tx.order.updateMany({
          where: { id: input.orderId, deliveryType: 'LOCAL', scheduledAt: { not: null }, status: 'PREPARING', readyAt: { not: null } },
          data: { readyAt: null },
        })
      : null
    await recordDeliveryEvent(tx, { deliveryId: d.id, dedupeKey: adminEventKey(), source: 'ADMIN', statusDesc: `商家取消（取消费 ${((cancelFeeFen ?? 0) / 100).toFixed(2)} 元）${rollbackStuck ? '【订单未回退，请核对】' : ''}${unreadied && unreadied.count > 0 ? '【已撤回「已备好」，到点不再自动呼叫】' : ''}`, operator: input.operator })
  })
  return { cancelFeeFen }
}

export async function addTip(input: { orderId: number; amountFen: number; operator: string }): Promise<{ tipFeeFen: number }> {
  const d = await requireActive(input.orderId)
  if (d.status !== 'CALLING') throw new AppError(42235, '仅待抢单状态可加小费')
  const s = await getLocalSettings()
  if (input.amountFen > s.tip.maxPerCall) throw new AppError(42235, `单次小费上限 ¥${(s.tip.maxPerCall / 100).toFixed(0)}`)
  // 这里只是给操作员一个即时的说法；真正的封顶靠下面写入时的原子条件（读到的 tipFee 可能已过期）
  if (d.tipFee + input.amountFen > s.tip.maxPerOrder) throw new AppError(42235, `本单小费累计上限 ¥${(s.tip.maxPerOrder / 100).toFixed(0)}，已加 ¥${(d.tipFee / 100).toFixed(2)}`)
  if (!d.providerTaskId) throw new AppError(42234, '配送单尚未成单')
  try {
    await getDeliveryProvider().addTip({ taskId: d.providerTaskId, amountFen: input.amountFen })
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'TIMEOUT') throw new AppError(42236, '加小费请求超时，请稍后在配送明细里核对是否生效')
    if (e instanceof ProviderError) throw new AppError(42236, `加小费被运力拒绝：${e.message}`)
    throw e
  }
  const updated = await prisma.$transaction(async (tx) => {
    // 原子封顶：并发两笔小费各自读到旧 tipFee 都会通过上面的预检，只有条件写能真的拦住越顶；
    // 同时把 status 一并作为条件——外呼期间配送单可能已经不在 CALLING 了。
    const moved = await tx.delivery.updateMany({
      where: { id: d.id, status: 'CALLING', tipFee: { lte: s.tip.maxPerOrder - input.amountFen } },
      data: { tipFee: { increment: input.amountFen } },
    })
    if (moved.count === 0) {
      // 钱已经真的加到运力方了，本地却没记上。照 callRider 落库失败的先例发告警：
      // 不告警的话这笔支出既不在配送单上、也不在事件流里，对账时无从查起，
      // 而操作员看到的只是「请刷新重试」，很可能再加一次 = 再花一次钱。
      notifySystemAlert('加小费已扣费但未记账', [
        `配送单 ${d.deliveryNo}（订单 ${d.orderNo}）`,
        `本次 ¥${(input.amountFen / 100).toFixed(2)} 已提交运力方，但本地写入未命中（已达累计上限或配送单已离开待抢单状态）`,
        '请到快递100 后台核对实际扣费，勿直接重试',
      ], { key: `dlv-tip-lost:${d.id}` })
      throw new AppError(42235, '小费已达上限或配送单状态已变化。本次加价可能已在运力方生效，请先刷新核对再决定是否重试')
    }
    const r = await tx.delivery.findUniqueOrThrow({ where: { id: d.id }, select: { tipFee: true } })
    await recordDeliveryEvent(tx, { deliveryId: d.id, dedupeKey: adminEventKey(), source: 'ADMIN', statusDesc: `加小费 ¥${(input.amountFen / 100).toFixed(2)}（累计 ¥${(r.tipFee / 100).toFixed(2)}）`, operator: input.operator })
    return r
  })
  return { tipFeeFen: updated.tipFee }
}

export async function selfDeliver(input: { orderId: number; name: string; phone: string; operator: string }): Promise<{ deliveryId: number; deliveryNo: string }> {
  const order = await prisma.order.findUnique({ where: { id: input.orderId } })
  if (!order) throw new AppError(40401, '订单不存在', 404)
  if (order.deliveryType !== 'LOCAL') throw new AppError(42204, '仅同城订单')
  if (order.status !== 'PREPARING') throw new AppError(42204, `订单状态为 ${order.status}，仅备餐中订单可自己送`)
  const existing = await getActiveDelivery(input.orderId)
  if (existing) {
    if (existing.status === 'UNKNOWN') throw new AppError(42234, '有状态未确认的配送单，请先作废')
    throw new AppError(42228, '已有在途配送单，请先取消再改自己送')
  }
  const seq = (await prisma.delivery.count({ where: { orderId: input.orderId } })) + 1
  const deliveryNo = `D${input.orderId}-${seq}`
  try {
    return await prisma.$transaction(async (tx) => {
      const now = new Date()
      const d = await tx.delivery.create({ data: {
        orderId: input.orderId, orderNo: order.orderNo, deliveryNo, activeOrderId: input.orderId,
        provider: 'SELF', status: 'DELIVERING', statusRank: 50,
        callbackSalt: crypto.randomBytes(8).toString('hex'),
        courierName: trunc(input.name, 64), courierMobile: trunc(input.phone, 20),
        calledAt: now, acceptedAt: now, pickedUpAt: now, operator: trunc(input.operator, 64),
      } })
      // 注意：Order 没有 shippedAt 列（发货时间只存在于 Shipment，而 LOCAL 单永不写 Shipment）。
      // 同城单的「出发时间」以 Delivery.pickedUpAt 为准。
      const moved = await tx.order.updateMany({
        where: { id: input.orderId, deliveryType: 'LOCAL', status: 'PREPARING' },
        data: { status: 'SHIPPED', ...(order.scheduledAt && !order.readyAt ? { readyAt: now } : {}) },
      })
      if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新')
      await recordDeliveryEvent(tx, { deliveryId: d.id, dedupeKey: adminEventKey(), source: 'ADMIN', statusDesc: `店内自送：${input.name} ${input.phone}`, operator: input.operator })
      return { deliveryId: d.id, deliveryNo }
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError(42228, '已有在途配送单')
    throw e
  }
}

export async function markDelivered(input: { orderId: number; operator: string }): Promise<void> {
  const d = await requireActive(input.orderId)
  await prisma.$transaction(async (tx) => {
    const moved = await tx.delivery.updateMany({ where: { id: d.id, status: { notIn: [...TERMINAL] } }, data: { status: 'DELIVERED', statusRank: 100, activeOrderId: null, deliveredAt: new Date() } })
    if (moved.count === 0) throw new AppError(42237, '配送单状态已变化，请刷新')
    await tx.order.updateMany({ where: { id: input.orderId, deliveryType: 'LOCAL', status: { in: ['PREPARING', 'SHIPPED'] } }, data: { status: 'COMPLETED', completedAt: new Date() } })
    await recordDeliveryEvent(tx, { deliveryId: d.id, dedupeKey: adminEventKey(), source: 'ADMIN', statusDesc: '店员标记已送达', operator: input.operator })
  })
  // 会员积分（M1）：事务提交后才发分，fire-and-forget，失败由 settleMissedPoints 兜底
  void settlePoints(input.orderId)
}
