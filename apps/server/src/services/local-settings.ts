/**
 * 同城配送运营参数（settings 表 key=local_delivery）+ 全部纯计算。
 *
 * 这里是运费/范围/营业判定的唯一实现：小程序只展示 /local/quote 的结果，不再本地复刻算法
 * （邮寄运费两端各写一遍的教训见 pages/order/confirm.js 注释）。
 * 缓存策略与 services/settings.ts 一致：60 秒进程内缓存，保存即失效。
 */
import crypto from 'crypto'
import prisma from '../utils/prisma'
import { config } from '../config'
import { publicPromotionView } from './promotion'

export const LOCAL_SETTINGS_KEY = 'local_delivery'
const CACHE_TTL_MS = 60 * 1000
/**
 * 报价凭证有效期。5 → 15 分钟：凭证里每一个「会变」的量（运费、配送范围、起送门槛）在下单时
 * 都用当前设置重新求值，唯一不能重算的是运力方给的道路距离——而同一对坐标之间的道路 15 分钟内
 * 不会变。把窗口开大只放宽「顾客在结算页磨蹭多久要重报一次价」，不放宽任何一条计费保护。
 */
const QUOTE_TTL_MS = 15 * 60 * 1000

export interface BusinessHour { start: string; end: string }

export interface PickupSettings {
  /** 自取开关。与 enabled（外送开关）各自独立；同城入口只要任一开着就显示 */
  enabled: boolean
  paused: { until: string | null; reason: string } | null
  /** 时段粒度（分钟） */
  slotMinutes: number
  /** 接单缓冲：最早可取 = 现在 + 它 + 备餐时长 */
  acceptBufferMin: number
  /** 0 = 只当天，1 = 当天 + 明天 */
  daysAhead: number
  /** 自取起送门槛（分），0 = 不限 */
  minOrderAmountFen: number
  /** PERCENT: value=95 即按 95% 收（9.5 折）；FIXED: value 为立减分 */
  discount: { type: 'NONE' | 'PERCENT' | 'FIXED'; value: number }
  /** 取餐时间过后多久没点「已取走」就自动完成 */
  autoCompleteAfterMin: number
  /** 取餐时间过后多久提醒店员「有单未取」 */
  unpickedRemindAfterMin: number
}

/**
 * 打包费（2026-09-13 打包费设计 §2.3）：同城外送 + 到店自取按份收，全店一个默认值；
 * 每道菜可在商品上单独覆盖（`Product.packingFeeFen`：null=跟随本节 perItemFen，0=不收，>0=改这个数）。
 * `enabled` 是总开关——关掉整店临时不收，商品上的覆盖值原样保留，重新打开立刻按原样生效。
 */
export interface PackingSettings {
  enabled: boolean
  /** 全店默认每份打包费（分）。0–10_000（¥100）夹取，默认 100（¥1） */
  perItemFen: number
}

/**
 * 全店自动满减（2026-09-17 设计 §3.1/§4）：达标自动减，不用领券。
 *
 * `channels` 的键**直接用 `DeliveryType`**（`LOCAL`/`PICKUP`/`EXPRESS`），不是 spec 草稿里的
 * `LOCAL_DELIVERY`——两套值域本来就是一一对应，多一层映射只会多一处将来对不上的地方
 * （00 规划定稿后由店主裁定，见本批实施计划「冲突 5」的裁定记录）。
 */
export const PROMO_CHANNELS = ['LOCAL', 'PICKUP', 'EXPRESS'] as const
export type PromoChannel = (typeof PROMO_CHANNELS)[number]
export interface PromotionTier { minFen: number; cutFen: number }
export interface PromotionSettings {
  enabled: boolean
  /** 活动名称，1–20 字，默认「全店满减」 */
  name: string
  /** ISO 8601（带时区）。null = 立即生效 */
  startAt: string | null
  /** ISO 8601（带时区）。null = 长期有效 */
  endAt: string | null
  /** 三个渠道各自的开关；到店自取默认不勾——自取本身有折扣，叠加会亏本，交给店主自己算完再开 */
  channels: Record<PromoChannel, boolean>
  /** 按 minFen 升序、去重、≤ 10 档 */
  tiers: PromotionTier[]
}

export interface LocalDeliverySettings {
  version: number
  enabled: boolean
  paused: { until: string | null; reason: string } | null
  store: {
    name: string; phone: string
    province: string; city: string; district: string; address: string
    latE6: number | null; lngE6: number | null
  }
  radiusKm: number
  detourFactor: number
  /**
   * 运费。**两套定价口径**（PO 2026-09-08 定）：
   *
   *   QUOTE（默认）—— 顾客输完地址那一刻本来就在向运力方查一次道路距离，那一次
   *     `batchPrice` 同时带回了各家报价。取**最低那家**（也正是三级阶梯第一级会呼的那家）
   *     加 `quoteMarkupFen`，就是收顾客的钱。好处是运费跟着真实行情走，而且和成本严丝合缝：
   *     第一级接得掉，每单利润恒等于加价。
   *   TABLE —— 起步价 + 每公里的固定表（旧口径）。**没有被废弃**：查价超时/运力方报错时
   *     QUOTE 无价可依，必须退回它，否则顾客就看不到运费了。
   *
   * 为什么不用「各家平均价」（PO 最初的想法）：平均和我们实付的钱没有绑定关系——
   * 我们付的是最低价，平均是另外几家共同决定的；而且**报价家数会变**（配了 7 家，
   * 2026-09-06 两次实测都只有 4 家回价），少一家平均就跳一次，顾客付多少变成
   * 「今天哪几家报了价」的函数，既解释不了也控制不住。最低价 + 固定加价没有这个问题。
   *
   * 实测依据（2026-09-06，两组真实报价）：
   *   1.11 km 达达 ¥5.83 / 蜂鸟 ¥6.05 / 顺丰 ¥10.78 / 闪送 ¥11.22 —— 旧表收 ¥6.00，利润 +¥0.17
   *   8.94 km 达达 ¥16.23 / 顺丰 ¥17.38 / 蜂鸟 ¥18.15 / 闪送 ¥23.32 —— 旧表收 ¥21.00，利润 +¥4.77
   * 旧表是「近单几乎不赚、远单过度收费」；改成最低价 +¥2.5 后两端都稳定在 +¥2.50。
   */
  fee: {
    baseFee: number; baseKm: number; perKmFee: number; minOrderAmount: number
    /**
     * **阶梯满额免运费**（PO 2026-09-08）。空数组 = 关闭。
     *
     * 旧规则是「满 ¥99 免运费，不看距离」——生产实测 9.5 km 的运费已经 ¥21.50，
     * 一张 ¥99 的单跑那么远，我们白送掉订单金额的 21.7%。改成「跑得越远，要求点得越多」。
     *
     * 判定：在所有**已达标**的档里取 `maxKm` **最大**的那一档（不是最后一档，也不是第一档），
     * 这样店主把行的顺序写乱了结果也不会变。距离在那一档以内 → 运费归零。
     *
     * ⚠️ 用**券前**的商品小计判（PO 2026-09-08 定）。含义是「你点了多少菜」，不是「你付了多少钱」。
     * 好处是选券不会让运费跳动，结算页不必在换券时重新查价；代价是 ¥100 的单用 ¥30 券、
     * 实付 ¥70 也照样免运费——这个敞口是知情选择。
     */
    freeShipTiers: { minAmountFen: number; maxKm: number }[]
    mode: 'TABLE' | 'QUOTE'
    /**
     * QUOTE 口径下，在最低报价之上加多少（分）。第一级接得掉时，这就是这一单的毛利。
     *
     * **分两档**（PO 2026-09-08）：`quoteNearKm` 以内用 `quoteNearMarkupFen`，以外用本字段。
     * 近单加价薄一点是**定价决定**，不是成本决定——近单的绝对运费低（实测 ¥5.83 那一档），
     * 按远单同样加 ¥2.5 相当于在旧价 ¥6 上涨 42%，怕吓走最核心的那批近距离顾客。
     * 但也不能退回旧的固定 ¥6：按 80% 第一级接单率算，¥6 的近单期望是 **−¥0.17/单**
     * （那 20% 升级的单成本跳到 ¥6–10.78，一单吃掉三十几单的利润），¥7.50 才转正到 +¥1.33。
     */
    quoteMarkupFen: number
    /** 近单分界（km，按**道路距离**）。0 = 不分档，一律用 quoteMarkupFen */
    quoteNearKm: number
    /** 近单（≤ quoteNearKm）的加价（分） */
    quoteNearMarkupFen: number
    /** 向上取整到这个粒度（分）。50 = 五毛；0 = 不取整（¥8.33 这种零头会原样出现在结算页） */
    roundToFen: number
  }
  /**
   * 休业总开关（spec 2026-09-11 P12）：节假日/装修整店停，外送与自取一起停；邮寄不受影响。
   * until 是恢复营业日期 `YYYY-MM-DD`（含当天仍休业，次日恢复）；null = 手动恢复。
   * 与 paused 的区别：paused 是「今天临时停一下」，按时刻；holiday 是「这几天不开门」，按日。
   */
  holiday: { until: string | null; reason: string } | null
  pickup: PickupSettings
  packing: PackingSettings
  promotion: PromotionSettings
  businessHours: BusinessHour[]
  /**
   * 平时的备餐时长（分钟）。**这段时间是从店员点「接单」开始算的**，不是从顾客下单开始——
   * 顾客下单到店员接单之间那一段（等付款、店里正忙）不属于备餐，也不该由这个数来兜。
   * 预计送达因此在**接单那一刻**才计算（routes/admin/delivery.ts 的 doAccept）。
   */
  prepMinutes: number
  /**
   * 高峰时段：备餐排队，出餐比平时慢。
   *
   * 为什么要单列而不是把 prepMinutes 直接调大：一天里只有两个小时是高峰，用高峰的数去报
   * 全天的单，平时那些单会被报得离谱地晚，顾客看到「预计 45 分钟」就走了。
   *
   * prepMin/prepMax 是**范围**：结算页如实告诉顾客「25–30 分钟」，而算预计送达一律取
   * **上界**——报晚了顾客早收到是惊喜，报早了是投诉。
   */
  peak: {
    /** 高峰时段（Asia/Shanghai，与营业时段同结构，后台可改） */
    windows: BusinessHour[]
    prepMinMinutes: number
    prepMaxMinutes: number
  }
  riderSpeedKmh: number
  /**
   * **呼叫骑手 → 骑手到店把餐拿走**要多久（分钟）。首单实测 10.4 分（晚 8 点、闪送）。
   *
   * 2026-09-08 之前这一段**根本不在预计送达里**：公式是「备餐 + 路上」，等于默认
   * 「骑手在备餐期间就已经站在店里等着了」。店主实测 3 km 报 27 分钟（备餐 15 + 路上 12），
   * 一眼就看出不可能——叫单、骑手赶过来这两段凭空消失了。
   */
  callToPickupMin: number
  acceptGraceMin: number
  autoCallDelayMin: number
  defaultProvider: 'KD100' | 'SELF'
  kd100: {
    providers: string[]; goodsType: string; defaultItemWeightG: number
    insurance: boolean; autoDowngradeToSelfOnNoBalance: boolean
    /**
     * 「一对一 / 指定单家运力」将来要用的槽（规格 §10）。v1 界面不暴露、服务端也不消费它——
     * 呼叫接口已经收 providers?: string[]，真要启用时把这个值传进去即可，接口与数据结构都不用动。
     * 之所以先把槽留在设置里：换运力是运营决策，不该每次都改代码。
     */
    soloProvider: string | null
  }
  /**
   * 呼叫策略。2026-09-06 首单实测把这件事从「假设」变成了「账」：
   * 并呼 7 家，最贵的闪送 ¥23.32 抢到，而最低的达达报 ¥16.23 —— 一单多付 ¥7.09；
   * 且**每一家在下单瞬间各冻结一笔**（那一单冻了 ¥75.08，实付 ¥23.32）。
   *
   * **店主 2026-09-12 定的阶梯（两级；原第三级「并呼全部」去掉了）**：
   *   第一次 —— 自动挑**最便宜的一家**（mode 默认 SOLO_LOWEST）。工作台弹窗只给两个选项：
   *             「普通配送」= 走这里；「极速配送」= 只呼闪送一对一，记 MANUAL。
   *   第二次 —— escalateAfterMin 分钟仍无人接：取消旧单，**并呼最便宜 cheapestN 家**。
   *   到头   —— 再过 escalateAfterMin 分钟仍无人接：不再加人，**只提醒店员一次**处理。
   *   不分第一次是怎么呼的——SOLO 和店员手选 MANUAL（极速）走同一条阶梯。
   *   每一级都按**当时**的报价重新挑人（不拿三分钟前那份名单）。
   *
   * mode 决定的只是「店员不动手时第一次呼谁」：
   *   SOLO_LOWEST 默认。只呼报价最低那一家，冻结最省。
   *   CHEAPEST_N  按报价从低到高取 cheapestN 家并呼。抢单成功率更高，代价是冻结按家数放大。
   *   ALL         并呼设置里的全部运力。后台页面已不再提供这个选项（2026-09-12），
   *               服务端仍接受，是不必部署就能关掉策略的应急开关（改库或用 API）。
   *   查不到报价一律退回 ALL（不因此拒绝呼叫）。
   *
   * ⚠️ 冻结额度按「同时并呼几家」放大，这是三级阶梯存在的全部理由。按首单那组报价：
   *      一家 ¥16.23／单 · 最便宜 3 家 ≈ ¥51.76／单 · 全部 7 家 ¥75.08／单
   *    以充值 100 元计，能同时挂的单数分别是 6 / 1 / 1。绝大多数单在第一级就被接走，
   *    只冻一笔；真没人接的那少数才逐级摊开
   *    （kd100.autoDowngradeToSelfOnNoBalance 是余额见底后的最后一道兜底）。
   *
   * cheapestN: 第二级并呼几家。可选家数不足时有几家呼几家。
   * escalateAfterMin: 每一级等这么久仍无人接就升下一级。0 = 不自动升级
   *   （只靠 callTimeoutMin 的人工提醒）。调度器 60 秒一跳，所以实际升级发生在 N ~ N+1 分钟之间；
   *   走完两级最长约 2×(N+1) 分钟，之后是告警。
   */
  callStrategy: { mode: 'SOLO_LOWEST' | 'CHEAPEST_N' | 'ALL'; cheapestN: number; escalateAfterMin: number }
  limits: { maxItems: number; maxWeightKg: number }
  callTimeoutMin: number
  acceptedStuckMin: number
  deliveringTimeoutMin: number
  tip: { maxPerCall: number; maxPerOrder: number }
}

export const KD100_PROVIDERS = [
  'shunfengtongcheng', 'fengniaotongcheng', 'meituantongcheng', 'shansongtongcheng',
  'dadatongcheng', 'uupaotui', 'gxdtongcheng',
] as const

export const DEFAULT_LOCAL_SETTINGS: LocalDeliverySettings = {
  version: 0,
  enabled: false,
  paused: null,
  store: {
    name: '阿福凉菜', phone: '15309003232',
    // district 必须写**正式行政区**「自流井区」而不是俗称「汇东新区」——它会原样作为
    // sendManDistrict 传给运力方（见 services/delivery/kd100.ts 的 _buildOrderParam）。
    province: '四川省', city: '自贡市', district: '自流井区', address: '丹桂街道丹桂40栋底楼',
    // 店主 2026-09-04 现场用微信「经纬度查询」小程序取得，腾讯与高德返回一致 = GCJ-02
    // （百度那组是 BD-09、谷歌/GPS 那组是 WGS-84，都不能直接用）。
    // 已用 batchPrice 交叉验证：正北 1998m 的点，四家运力返回 3057–3400m，坐标被正确解读。
    latE6: 29341126, lngE6: 104779018,
  },
  // 半径按**道路距离**判，不是直线（见 billableDistanceM 与 §配送报价）。
  // 5 km 而不是 7-8：5 km 骑手成本已 ¥14.5（实测），7-8 km 约 ¥20，
  // 对一单五六十块的凉菜吃不消；凉菜夏天也有食安顾虑，送太远不合适。
  radiusKm: 5,
  // ⚠ 1.35 是拍脑袋的初值，店主 2026-09-04 用免费 batchPrice 打了 8 个方向实测，证明它系统性低估：
  //   正北2km 1.67 / 正南2km 1.53 / 正东2km 1.88 / 正西2km 2.12
  //   东北3km 1.30 / 西南3km 1.54 / 正北5km 1.74 / 正东5km 1.58
  //   均值 1.67、中位 1.67、范围 1.30–2.12 —— 1.35 平均低估 19%，最差方向低估 36%。
  // 但**结论不是改成 1.67**：方向间差 63%（正西 2.12 vs 东北 1.30），自贡是山城又夹着釜溪河，
  // 任何固定系数在某些方向都必然错得离谱。正解是用 batchPrice 返回的真实道路距离算运费，
  // 这个系数只在查价失败时兜底——所以取 1.7 而不是 1.67：高估只是少赚，低估是每单倒贴。
  detourFactor: 1.7,
  // 店主 2026-09-04 按实测骑手成本定：2km ¥7.15–8.58 / 3km ¥7.98–9.19 / 5km ¥13.75–15.35。
  // 账（顾客付 / 骑手成本 / 店家担）：
  //   3km ¥40 单 → ¥6 / ¥8.5 / 担 ¥2.5
  //   5km ¥40 单 → ¥11 / ¥14.5 / 担 ¥3.5
  //   5km ¥99 单 → 免运费 / ¥14.5 / 担 ¥14.5
  // 每单补贴占订单 6-9%，毛利扛得住。免运门槛特意设在 ¥99——5 km 成本 ¥14.5，
  // 只有把客单价推上去才摊得平。先跑一个月看单量与距离分布再调。
  fee: {
    baseFee: 600, baseKm: 3, perKmFee: 250, minOrderAmount: 4000,
    // 默认值与升级前的「满 ¥99 免运费、不看距离」等价（radiusKm 默认 5）。
    // 真正的阶梯由店主在后台按自家毛利算完再配——见 run-log「运费经济性」那一节。
    freeShipTiers: [{ minAmountFen: 9900, maxKm: 5 }],
    mode: 'QUOTE', quoteMarkupFen: 250, quoteNearKm: 2, quoteNearMarkupFen: 150, roundToFen: 50,
  },
  holiday: null,
  pickup: {
    enabled: false, paused: null, slotMinutes: 30, acceptBufferMin: 5, daysAhead: 1,
    minOrderAmountFen: 0, discount: { type: 'NONE', value: 0 },
    autoCompleteAfterMin: 120, unpickedRemindAfterMin: 30,
  },
  // 默认开、¥1/份（P2/P7）：新店直接生效，不用店主上线当天先记得来开一次开关。
  packing: { enabled: true, perItemFen: 100 },
  // 默认关（P4/风险预案）：存量生产库没有这个块，回落到这份默认值——部署后活动关着，
  // 店主自己去「满减活动」页开，不会出现「一部署就在悄悄打折」的意外。
  promotion: {
    enabled: false, name: '全店满减', startAt: null, endAt: null,
    channels: { LOCAL: true, PICKUP: false, EXPRESS: true },
    tiers: [],
  },
  businessHours: [{ start: '09:00', end: '20:00' }],
  // 15 → 20（PO 2026-09-07）：15 是拍脑袋的初值。首单实测接单→取货 10.4 分钟，看着够，
  // 但那是晚上 8 点的单；而且原来的预计送达从**下单**起算，把「下单→付款→接单」那一段
  // 白送掉了，两个误差正好被偏慢的骑行均速（15 vs 实测 25.5）盖住。现在计时改到接单起算，
  // 这个数就必须是真实的备餐时长。
  prepMinutes: 20,
  peak: {
    // 午市与晚市各一小时（PO 2026-09-07 定，后台可改）
    windows: [{ start: '12:00', end: '13:00' }, { start: '17:00', end: '18:00' }],
    prepMinMinutes: 25,
    prepMaxMinutes: 30,
  },
  riderSpeedKmh: 15,
  // 12 而不是实测的 10.4：那一单是晚 8 点的闪送（一对一专送，来得快），
  // 而第一级呼的是达达这类顺路带单，赶到店里只会更慢。宁可报晚。
  callToPickupMin: 12,
  acceptGraceMin: 5,
  autoCallDelayMin: 0,
  // 日常主力是第三方骑手；店内自送是常规备选（高峰无人接单、近距离单自己走两步就到、
  // 余额用尽、骑手取消或改派失败），店员在看板上一键可切，不是降级兜底。
  defaultProvider: 'KD100',
  kd100: {
    providers: [...KD100_PROVIDERS], goodsType: '食品', defaultItemWeightG: 300,
    insurance: false, autoDowngradeToSelfOnNoBalance: false, soloProvider: null,
  },
  // 三级阶梯：一家 →（3 分钟）最便宜 3 家 →（再 3 分钟）全部。
  // 3 分钟这个数：凉菜等不起再挑一轮。与 docs/design/workbench-ui-spec.md §6b 一致。
  callStrategy: { mode: 'SOLO_LOWEST', cheapestN: 3, escalateAfterMin: 3 },
  limits: { maxItems: 30, maxWeightKg: 10 },
  callTimeoutMin: 10,
  acceptedStuckMin: 30,
  deliveringTimeoutMin: 120,
  tip: { maxPerCall: 2000, maxPerOrder: 5000 },
}

// ── sanitize ────────────────────────────────────────────────
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
/**
 * 满减 startAt/endAt 专用的格式闸门。**只用 `Number.isFinite(Date.parse(v))` 不够**——
 * 实测 `Date.parse('2026/10/08')` 是有限数（JS 把斜杠日期当本地时区解析），
 * 这正是本批 e2e §66 与 selftest 用来验证「格式不正确」的例子，若只查 Date.parse
 * 会被它悄悄放过、变成一个「看似正确」的日期，而不是报错——同 F13 休业日期一个坑，
 * 但更隐蔽。要求必须是 `YYYY-MM-DDTHH:mm[:ss][.sss](Z|±HH:mm)` 这种带 `T`、破折号分隔的
 * ISO 8601 形状，`Date.parse` 只作二次确认。
 */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/
const asObj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const int = (v: unknown, fb: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : fb
}
const num = (v: unknown, fb: number, min = 0, max = 1e9) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= min && n <= max ? n : fb
}
const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb)
const str = (v: unknown, fb: string, max = 128) => (typeof v === 'string' ? v.trim().slice(0, max) : fb)
const intOrNull = (v: unknown, min: number, max: number) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}
// 满减 startAt/endAt 专用：非空字符串且能被 Date.parse 认出才存归一化后的 ISO，
// 否则一律 null（= 立即生效 / 长期有效）——与 F13 休业日期同一类坑，打错的日期不该被静默接受，
// 但这里是 sanitize（已经过 validateRawLocalSettings 拦过一轮格式），职责只是给出可用值。
const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && ISO_DATETIME.test(v.trim()) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null

export function sanitizeLocalSettings(raw: unknown): LocalDeliverySettings {
  const o = asObj(raw)
  const D = DEFAULT_LOCAL_SETTINGS
  const store = asObj(o.store), fee = asObj(o.fee), kd = asObj(o.kd100), lim = asObj(o.limits), tip = asObj(o.tip)
  const cs = asObj(o.callStrategy), peak = asObj(o.peak)
  // 阶梯免运费的老配置翻译要用到半径，先算出来
  const radius = num(o.radiusKm, D.radiusKm, 0.5, 50)
  const paused = o.paused && typeof o.paused === 'object'
    ? { until: str(asObj(o.paused).until, '', 40) || null, reason: str(asObj(o.paused).reason, '', 60) }
    : null
  const hours = Array.isArray(o.businessHours)
    ? o.businessHours
        .map((h) => ({ start: str(asObj(h).start, '', 5), end: str(asObj(h).end, '', 5) }))
        .filter((h) => HHMM.test(h.start) && HHMM.test(h.end))
    : D.businessHours
  const providers = Array.isArray(kd.providers)
    ? kd.providers.filter((p): p is string => typeof p === 'string' && (KD100_PROVIDERS as readonly string[]).includes(p))
    : D.kd100.providers
  const pk = asObj(o.pickup), pkd = asObj(pk.discount)
  const pkg = asObj(o.packing)
  const promo = asObj(o.promotion)
  const promoChannels = asObj(promo.channels)
  // 乱序 + 重复 minFen + 非法行 + 超过 10 档：先过滤掉任一字段为 -1（越界/非整数/缺字段）的行，
  // 再按 minFen 升序、minFen 相同按 cutFen 降序排（这样同门槛第一条就是减得多的那条），
  // 去重只留每个 minFen 的第一条，最后截到 10 档（P2：档位数量不限，但接口有上限）。
  const promoTiers: PromotionTier[] = Array.isArray(promo.tiers)
    ? (() => {
        const rows = (promo.tiers as unknown[])
          .map((t) => asObj(t))
          .map((t) => ({ minFen: int(t.minFen, -1, 1, 10_000_000), cutFen: int(t.cutFen, -1, 1, 10_000_000) }))
          .filter((t) => t.minFen !== -1 && t.cutFen !== -1)
          .sort((a, b) => a.minFen - b.minFen || b.cutFen - a.cutFen)
        const deduped: PromotionTier[] = []
        for (const t of rows) {
          if (deduped.length === 0 || deduped[deduped.length - 1].minFen !== t.minFen) deduped.push(t)
        }
        return deduped.slice(0, 10)
      })()
    : []
  const DATE = /^\d{4}-\d{2}-\d{2}$/
  const holiday = o.holiday && typeof o.holiday === 'object'
    ? (() => {
        const h = asObj(o.holiday)
        const until = str(h.until, '', 10)
        return { until: DATE.test(until) ? until : null, reason: str(h.reason, '', 60) }
      })()
    : null
  const pickupPaused = pk.paused && typeof pk.paused === 'object'
    ? { until: str(asObj(pk.paused).until, '', 40) || null, reason: str(asObj(pk.paused).reason, '', 60) }
    : null
  const discountType = pkd.type === 'PERCENT' || pkd.type === 'FIXED' ? pkd.type : 'NONE'
  const discount = discountType === 'PERCENT'
    ? { type: 'PERCENT' as const, value: int(pkd.value, 100, 1, 100) }
    : discountType === 'FIXED'
      ? { type: 'FIXED' as const, value: int(pkd.value, 0, 0, 10_000_000) }
      : { type: 'NONE' as const, value: 0 }
  return {
    version: int(o.version, 0),
    enabled: bool(o.enabled, false),
    paused,
    store: {
      name: str(store.name, D.store.name, 64), phone: str(store.phone, D.store.phone, 20),
      province: str(store.province, D.store.province, 32), city: str(store.city, D.store.city, 32),
      district: str(store.district, D.store.district, 32), address: str(store.address, D.store.address, 255),
      latE6: intOrNull(store.latE6, -90_000_000, 90_000_000), lngE6: intOrNull(store.lngE6, -180_000_000, 180_000_000),
    },
    radiusKm: radius,
    detourFactor: num(o.detourFactor, D.detourFactor, 1, 3),
    fee: {
      baseFee: int(fee.baseFee, D.fee.baseFee, 0, 100_000), baseKm: num(fee.baseKm, D.fee.baseKm, 0, 50),
      perKmFee: int(fee.perKmFee, D.fee.perKmFee, 0, 100_000),
      // 阶梯免运费。**只有整个字段缺失时**才回落到老的 freeThreshold——
      // 传了空数组必须当成「店主真的关掉了」，不能好心帮他恢复成默认档。
      freeShipTiers: Array.isArray(fee.freeShipTiers)
        ? (fee.freeShipTiers as unknown[])
            .map((t) => asObj(t))
            .map((t) => ({
              minAmountFen: int(t.minAmountFen, -1, 0, 10_000_000),
              maxKm: num(t.maxKm, -1, 0, 50),
            }))
            .filter((t) => t.minAmountFen >= 0 && t.maxKm > 0)
            .sort((a, b) => a.maxKm - b.maxKm)
            .slice(0, 10)
        : int(fee.freeThreshold, 0, 0, 10_000_000) > 0
          // 老配置一次性翻译成等价的一档：「满 X 免运费、不看距离」= 「满 X 免到配送半径」
          ? [{ minAmountFen: int(fee.freeThreshold, 0, 0, 10_000_000), maxKm: radius }]
          : [],
      minOrderAmount: int(fee.minOrderAmount, D.fee.minOrderAmount, 0, 10_000_000),
      // 只认这两个字面量：脏值回默认（QUOTE），不要静默退回旧口径——
      // 静默退回意味着「以为在按报价收钱，其实在按老表收钱」，而两者近单差 ¥2.5。
      mode: fee.mode === 'TABLE' || fee.mode === 'QUOTE' ? fee.mode : D.fee.mode,
      // 上限 5000 分（¥50）：加价比这还高的话，问题多半出在别处，不该靠运费找补。
      quoteMarkupFen: int(fee.quoteMarkupFen, D.fee.quoteMarkupFen, 0, 5_000),
      quoteNearKm: num(fee.quoteNearKm, D.fee.quoteNearKm, 0, 50),
      quoteNearMarkupFen: int(fee.quoteNearMarkupFen, D.fee.quoteNearMarkupFen, 0, 5_000),
      // 0 = 不取整；上限 500 分（¥5），再粗顾客会觉得在乱收
      roundToFen: int(fee.roundToFen, D.fee.roundToFen, 0, 500),
    },
    holiday,
    pickup: {
      enabled: bool(pk.enabled, false),
      paused: pickupPaused,
      slotMinutes: int(pk.slotMinutes, D.pickup.slotMinutes, 5, 120),
      acceptBufferMin: int(pk.acceptBufferMin, D.pickup.acceptBufferMin, 0, 60),
      daysAhead: int(pk.daysAhead, D.pickup.daysAhead, 0, 7),
      minOrderAmountFen: int(pk.minOrderAmountFen, D.pickup.minOrderAmountFen, 0, 10_000_000),
      discount,
      autoCompleteAfterMin: int(pk.autoCompleteAfterMin, D.pickup.autoCompleteAfterMin, 10, 1440),
      unpickedRemindAfterMin: int(pk.unpickedRemindAfterMin, D.pickup.unpickedRemindAfterMin, 5, 1440),
    },
    packing: {
      enabled: bool(pkg.enabled, D.packing.enabled),
      perItemFen: int(pkg.perItemFen, D.packing.perItemFen, 0, 10_000),
    },
    promotion: {
      enabled: bool(promo.enabled, false),
      name: str(promo.name, D.promotion.name, 20) || D.promotion.name,
      startAt: isoOrNull(promo.startAt),
      endAt: isoOrNull(promo.endAt),
      channels: {
        LOCAL: bool(promoChannels.LOCAL, D.promotion.channels.LOCAL),
        PICKUP: bool(promoChannels.PICKUP, D.promotion.channels.PICKUP),
        EXPRESS: bool(promoChannels.EXPRESS, D.promotion.channels.EXPRESS),
      },
      tiers: promoTiers,
    },
    businessHours: hours,
    prepMinutes: int(o.prepMinutes, D.prepMinutes, 0, 180),
    peak: {
      // 与 businessHours 同一套过滤：格式不合法的行直接丢掉，不让脏值进来。
      // 高峰时段允许为空数组（= 全天不分高峰），所以这里不做「空则回默认」的兜底——
      // 店主真想关掉高峰加时，清空这一栏就该真的关掉。
      windows: Array.isArray(peak.windows)
        ? peak.windows
            .map((h) => ({ start: str(asObj(h).start, '', 5), end: str(asObj(h).end, '', 5) }))
            .filter((h) => HHMM.test(h.start) && HHMM.test(h.end))
        : D.peak.windows,
      prepMinMinutes: int(peak.prepMinMinutes, D.peak.prepMinMinutes, 0, 180),
      // 上界不得小于下界：范围倒置会让结算页打出「30–25 分钟」，也会让取上界算出来的
      // 预计送达比下界还早。取两者的大值，而不是丢弃或报错——这里是 sanitize，职责是给出可用值。
      prepMaxMinutes: Math.max(
        int(peak.prepMaxMinutes, D.peak.prepMaxMinutes, 0, 180),
        int(peak.prepMinMinutes, D.peak.prepMinMinutes, 0, 180),
      ),
    },
    riderSpeedKmh: num(o.riderSpeedKmh, D.riderSpeedKmh, 5, 60),
    callToPickupMin: int(o.callToPickupMin, D.callToPickupMin, 0, 60),
    acceptGraceMin: int(o.acceptGraceMin, D.acceptGraceMin, 0, 30),
    autoCallDelayMin: int(o.autoCallDelayMin, D.autoCallDelayMin, 0, 60),
    defaultProvider: o.defaultProvider === 'SELF' ? 'SELF' : D.defaultProvider,
    kd100: {
      providers, goodsType: str(kd.goodsType, D.kd100.goodsType, 16),
      defaultItemWeightG: int(kd.defaultItemWeightG, D.kd100.defaultItemWeightG, 50, 20_000),
      insurance: bool(kd.insurance, false), autoDowngradeToSelfOnNoBalance: bool(kd.autoDowngradeToSelfOnNoBalance, false),
      // 只认已知运力编码，别的（含空串）一律归 null——留着的槽也不该能被写进垃圾值
      soloProvider: typeof kd.soloProvider === 'string' && (KD100_PROVIDERS as readonly string[]).includes(kd.soloProvider) ? kd.soloProvider : null,
    },
    callStrategy: {
      // 只认这三个值，别的（含未来某天写进去的错拼）一律回落默认。⚠️ 生产库里已有的
      // local_delivery 行若没有这个字段 → 回落默认 → **部署即生效**，不需要店主再点一次。
      // 反过来说：改默认值等于改生产行为，改之前必须先跟店主确认
      // （2026-09-07 最终确认：第一次由店员选、默认预选最低那家；第二次并呼全部）。
      mode: cs.mode === 'ALL' || cs.mode === 'SOLO_LOWEST' || cs.mode === 'CHEAPEST_N' ? cs.mode : D.callStrategy.mode,
      // 上界取运力表长度：填 9 也只有 7 家可呼，把它夹到真实可选范围内，
      // 免得后台显示一个永远达不到的数
      cheapestN: int(cs.cheapestN, D.callStrategy.cheapestN, 1, KD100_PROVIDERS.length),
      escalateAfterMin: int(cs.escalateAfterMin, D.callStrategy.escalateAfterMin, 0, 30),
    },
    limits: { maxItems: int(lim.maxItems, D.limits.maxItems, 1, 500), maxWeightKg: num(lim.maxWeightKg, D.limits.maxWeightKg, 0.5, 100) },
    callTimeoutMin: int(o.callTimeoutMin, D.callTimeoutMin, 1, 120),
    acceptedStuckMin: int(o.acceptedStuckMin, D.acceptedStuckMin, 1, 240),
    deliveringTimeoutMin: int(o.deliveringTimeoutMin, D.deliveringTimeoutMin, 10, 600),
    tip: { maxPerCall: int(tip.maxPerCall, D.tip.maxPerCall, 0, 100_000), maxPerOrder: int(tip.maxPerOrder, D.tip.maxPerOrder, 0, 500_000) },
  }
}

// ── 校验 ────────────────────────────────────────────────────
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** 保存时校验（结构合法但业务上不允许的组合） */
export function validateLocalSettings(s: LocalDeliverySettings): string[] {
  const errs: string[] = []
  const sorted = [...s.businessHours].sort((a, b) => toMin(a.start) - toMin(b.start))
  for (const h of sorted) {
    if (toMin(h.start) >= toMin(h.end)) errs.push(`营业时段 ${h.start}-${h.end}：结束须晚于开始（首期不支持跨零点）`)
  }
  for (let i = 1; i < sorted.length; i++) {
    if (toMin(sorted[i].start) < toMin(sorted[i - 1].end)) errs.push(`营业时段 ${sorted[i - 1].start}-${sorted[i - 1].end} 与 ${sorted[i].start}-${sorted[i].end} 重叠`)
  }
  if (s.autoCallDelayMin !== 0 && (s.autoCallDelayMin < s.acceptGraceMin || s.autoCallDelayMin > 15)) {
    errs.push(`自动呼叫延迟须为 0（手动）或介于顾客可取消窗口 ${s.acceptGraceMin} 分钟与 15 分钟之间`)
  }
  if (s.tip.maxPerCall > s.tip.maxPerOrder) errs.push('单次小费上限不能大于单笔订单累计上限')
  if (s.pickup.unpickedRemindAfterMin >= s.pickup.autoCompleteAfterMin) {
    errs.push(`「过时未取提醒」(${s.pickup.unpickedRemindAfterMin} 分钟) 须早于「自动完成」(${s.pickup.autoCompleteAfterMin} 分钟)`)
  }
  for (const t of s.promotion.tiers) {
    if (t.cutFen >= t.minFen) {
      errs.push(`满 ¥${(t.minFen / 100).toFixed(2)} 减 ¥${(t.cutFen / 100).toFixed(2)}：减的比门槛还多，这样配会亏本`)
    }
  }
  if (s.promotion.startAt && s.promotion.endAt && s.promotion.startAt >= s.promotion.endAt) {
    errs.push('活动结束时间须晚于开始时间')
  }
  if (s.promotion.enabled && s.promotion.tiers.length === 0) {
    errs.push('启用满减至少要配一档')
  }
  return errs
}

/**
 * 针对**原始请求体**的校验，必须在 sanitize 之前跑。
 *
 * sanitize 对营业时段的策略是「逐条丢掉不合法的项」，而管理端那一栏是自由文本
 * （每行 `HH:mm-HH:mm`）。于是店主把 `09:00` 打成中文冒号 `09：00` 或少写一位 `9:00`，
 * 这一行会被**静默丢掉**、接口照样返回 code:0、页面提示「已保存」。若他有两段营业时间
 * 只错了一段，`validateForEnable` 的「至少一个时段」也拦不住——结果是营业时段被悄悄收窄，
 * 非营业时段的同城单直接被 42222 拒单，而店主完全不知道为什么。
 *
 * sanitize 之后的对象已经看不出「丢了几条」，所以这个比对只能在这里做。
 */
export function validateRawLocalSettings(raw: unknown): string[] {
  const o = asObj(raw)
  const errs: string[] = []
  if (Array.isArray(o.businessHours)) {
    o.businessHours.forEach((h, i) => {
      const item = asObj(h)
      const start = typeof item.start === 'string' ? item.start.trim() : ''
      const end = typeof item.end === 'string' ? item.end.trim() : ''
      if (!HHMM.test(start) || !HHMM.test(end)) {
        errs.push(
          `营业时段第 ${i + 1} 行「${start || '(空)'}-${end || '(空)'}」格式不正确，应形如 09:00-20:00（半角冒号、小时两位）`
        )
      }
    })
  }
  // F13：休业恢复日期填错（如打成 2026/10/08 或 26-10-08）会被 sanitize 静默丢成 null =
  // 手动恢复，等同「永久休业」直到店主自己发现——必须在原始请求体上拦，sanitize 之后已经看不出来。
  if (o.holiday && typeof o.holiday === 'object') {
    const until = asObj(o.holiday).until
    if (typeof until === 'string' && until.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(until.trim())) {
      errs.push(`休业恢复日期「${until}」格式不正确，应形如 2026-10-08；留空表示手动恢复`)
    }
  }
  // 同一类坑：startAt/endAt 打错格式会被 sanitize 的 isoOrNull 静默变成 null
  // （= 立即生效 / 长期有效），必须在原始请求体上拦住。
  if (o.promotion && typeof o.promotion === 'object') {
    const p = asObj(o.promotion)
    if (typeof p.startAt === 'string' && p.startAt.trim() !== '' && !(ISO_DATETIME.test(p.startAt.trim()) && Number.isFinite(Date.parse(p.startAt)))) {
      errs.push(`活动开始时间「${p.startAt}」格式不正确`)
    }
    if (typeof p.endAt === 'string' && p.endAt.trim() !== '' && !(ISO_DATETIME.test(p.endAt.trim()) && Number.isFinite(Date.parse(p.endAt)))) {
      errs.push(`活动结束时间「${p.endAt}」格式不正确`)
    }
  }
  return errs
}

/** 开启总开关前的完整性校验 */
export function validateForEnable(s: LocalDeliverySettings): string[] {
  const errs = validateLocalSettings(s)
  if (s.store.latE6 === null || s.store.lngE6 === null) errs.push('请先设置门店坐标（推荐在小程序商家端一键定位）')
  if (!s.store.phone) errs.push('请填写门店电话')
  if (!s.store.address) errs.push('请填写门店地址')
  if (s.businessHours.length === 0) errs.push('至少设置一个营业时段')
  if (s.radiusKm <= 0) errs.push('配送半径须大于 0')
  return errs
}

/** 打开自取开关前的完整性校验：不要求门店坐标（自取不算距离），但要有地址/电话/营业时段 */
export function validateForPickupEnable(s: LocalDeliverySettings): string[] {
  const errs = validateLocalSettings(s)
  if (!s.store.phone) errs.push('请填写门店电话（自取单顾客要联系店里）')
  if (!s.store.address) errs.push('请填写门店地址（自取单要显示取餐地点）')
  if (s.businessHours.length === 0) errs.push('至少设置一个营业时段（自取时段只落在营业时间内）')
  return errs
}

// ── 读写 + 缓存 ─────────────────────────────────────────────
let cached: { value: LocalDeliverySettings; at: number } | null = null

export async function getLocalSettings(): Promise<LocalDeliverySettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  let value = DEFAULT_LOCAL_SETTINGS
  try {
    const row = await prisma.setting.findUnique({ where: { key: LOCAL_SETTINGS_KEY } })
    if (row) value = sanitizeLocalSettings(JSON.parse(row.value))
  } catch (e) {
    // 读不到配置 = 默认值（enabled=false），同城入口关闭而不是放行错误运费
    console.warn('[local-settings] 读取失败，回退默认值:', (e as Error).message)
  }
  cached = { value, at: Date.now() }
  return value
}

export async function setLocalSettings(next: LocalDeliverySettings): Promise<LocalDeliverySettings> {
  const current = await getLocalSettings()
  const value = sanitizeLocalSettings({ ...next, version: current.version + 1 })
  const json = JSON.stringify(value)
  await prisma.setting.upsert({
    where: { key: LOCAL_SETTINGS_KEY },
    create: { key: LOCAL_SETTINGS_KEY, value: json },
    update: { value: json },
  })
  cached = { value, at: Date.now() }
  return value
}

// 这里的「patch」只对顶层字段生效：patch.fee/kd100/limits/tip 等嵌套对象一旦传入就会整体替换当前值，
// 不会跟 current 做字段级合并。这不是漏洞——Partial<LocalDeliverySettings> 只把顶层字段变成可选，
// 嵌套对象本身仍是完整类型，`npx tsc --noEmit` 会在编译期拒绝任何只传嵌套对象部分字段的调用
// （例如 patchLocalSettings({ fee: { minOrderAmount: 3000 } }) 会报 TS2739 缺 baseFee/baseKm/perKmFee/freeShipTiers）。
// 所以调用方要改嵌套对象里的某一个字段时，正确写法是先 getLocalSettings() 取当前值、展开后再覆盖那个字段
// （Task 5 的门店坐标接口就是这么写的）。下面 store 这一处的展开合并是冗余的防御代码——类型系统已经保证
// 不会有调用方能绕过完整嵌套对象的要求触发它——保留不动只是为了不改动已通过复查的运行时行为。
export async function patchLocalSettings(patch: Partial<LocalDeliverySettings>): Promise<LocalDeliverySettings> {
  const current = await getLocalSettings()
  return setLocalSettings({ ...current, ...patch, store: { ...current.store, ...(patch.store ?? {}) } })
}

/**
 * 仅供测试/脚本按需清缓存。**线上没有调用方，也不需要有**：`ecosystem.config.js` 是单进程 fork，
 * `setLocalSettings` 写库后立刻刷本进程的 `cached`，陈旧窗口实际为 0 而不是 CACHE_TTL_MS。
 * 保留它是为了将来真起多进程时有个现成的手柄，不代表现在存在一套「失效机制」。
 */
export function clearLocalSettingsCache(): void {
  cached = null
}

// ── 营业判定（Asia/Shanghai，不依赖进程时区）────────────────
const SH_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })

export function shanghaiMinutes(now: Date = new Date()): number {
  const parts = SH_FMT.formatToParts(now)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return h * 60 + m
}

export function isPaused(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  if (!s.paused) return false
  if (!s.paused.until) return true
  const until = Date.parse(s.paused.until)
  return Number.isFinite(until) ? until > now.getTime() : true
}

function inHours(s: LocalDeliverySettings, now: Date): boolean {
  const cur = shanghaiMinutes(now)
  return s.businessHours.some((h) => cur >= toMin(h.start) && cur < toMin(h.end))
}

export function isOpenNow(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  return s.enabled && !isHolidayNow(s, now) && !isPaused(s, now) && inHours(s, now)
}

/**
 * 「店现在开着吗」——只看营业时段与临时停业，**不看同城配送的总开关**。
 *
 * 与 `isOpenNow` 的区别只在少了 `s.enabled` 那一项，但这一项差别很关键：
 * `enabled` 是「同城配送这个渠道开不开」，而营业时间是「人在不在店里」。
 * 打印机的「未接单催单」要绑的是后者——邮寄单在深夜不该催，理由是没人在店里，
 * 跟同城渠道开没开毫无关系。生产现在同城正是关着的，用 `isOpenNow` 会导致
 * 邮寄单**永远不催**。
 *
 * 营业时间只有同城这一套（存在 `local_delivery` 这个 Setting key 下），
 * 因为店就一个、开门时间就一套。这在概念上有点别扭——「同城设置」里的时间
 * 影响到了邮寄单的催单——但另存一份的代价是两处时间要分别维护，
 * 改了一处忘了另一处就会出怪事。PO 2026-09-06 定：复用这一套。
 *
 * 休业（holiday）**不**进这里——它只停外送与自取的下单，邮寄单在休业期间照常进来、照常播报
 * （spec 2026-09-11 P12）。
 */
export function isShopOpenNow(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  return !isPaused(s, now) && inHours(s, now)
}

/**
 * 现在不营业时，是「午间休息」还是「今天打烊了/还没开门」。
 * BREAK 当且仅当**已经过了一段**且**还有一段没开始**——2026-09-11 之前只看后半句，
 * 早上 9 点还没开门也被判成「午间休息」（店主实测发现）。
 */
export function closedKind(s: LocalDeliverySettings, now: Date = new Date()): 'OPEN' | 'BREAK' | 'CLOSED' {
  // 休业（holiday）整天不开门，优先于时段判断——哪怕此刻的钟点落在 businessHours 里，
  // 休业期间也不算「营业中」（F4）。
  if (isHolidayNow(s, now)) return 'CLOSED'
  if (inHours(s, now)) return 'OPEN'
  const cur = shanghaiMinutes(now)
  const passedOne = s.businessHours.some((h) => toMin(h.end) <= cur)
  const hasNext = s.businessHours.some((h) => toMin(h.start) > cur)
  return passedOne && hasNext ? 'BREAK' : 'CLOSED'
}

export function nextOpenText(s: LocalDeliverySettings, now: Date = new Date()): string {
  if (s.businessHours.length === 0) return '暂未设置营业时间'
  if (isHolidayNow(s, now)) {
    const until = s.holiday?.until
    return `休息中${until ? `，${until.slice(5).replace('-', '月')}日后恢复` : ''}`
  }
  const cur = shanghaiMinutes(now)
  const sorted = [...s.businessHours].sort((a, b) => toMin(a.start) - toMin(b.start))
  const today = sorted.find((h) => toMin(h.start) > cur)
  if (!today) return `明天 ${sorted[0].start} 营业`
  // 中间休息时说「继续营业」；开门前说「今天 X 营业」（两者靠 closedKind 分开）
  return closedKind(s, now) === 'BREAK' ? `午间休息，${today.start} 继续营业` : `今天 ${today.start} 营业`
}

// ── 休业 / 自取暂停 / 高峰（按分钟）────────────────────────────
const SH_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
/** 上海日期 `YYYY-MM-DD`（en-CA 的输出天然就是这个格式） */
export function shanghaiDateStr(now: Date = new Date()): string {
  return SH_DATE_FMT.format(now)
}
export function isHolidayOn(s: LocalDeliverySettings, dateStr: string): boolean {
  if (!s.holiday) return false
  return s.holiday.until === null ? true : dateStr <= s.holiday.until
}
export function isHolidayNow(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  return isHolidayOn(s, shanghaiDateStr(now))
}
export function isPickupPaused(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  const p = s.pickup.paused
  if (!p) return false
  if (!p.until) return true
  const until = Date.parse(p.until)
  return Number.isFinite(until) ? until > now.getTime() : true
}
/** 自取此刻能不能下单：开通 && 非休业 && 非自取暂停。**不看营业时段**（营业外可订明天） */
export function pickupAvailableNow(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  return s.pickup.enabled && !isHolidayNow(s, now) && !isPickupPaused(s, now)
}
/** 某个「一天中的分钟数」是否落在高峰窗口。给自取时段用：备餐时长按取餐时刻判，不按现在 */
export function minutesInPeak(s: LocalDeliverySettings, minutes: number): boolean {
  return s.peak.windows.some((h) => minutes >= toMin(h.start) && minutes < toMin(h.end))
}

// ── 距离与运费 ───────────────────────────────────────────────
const R_EARTH_M = 6371008.8
export function haversineM(aLatE6: number, aLngE6: number, bLatE6: number, bLngE6: number): number {
  const toRad = (e6: number) => (e6 / 1e6) * (Math.PI / 180)
  const dLat = toRad(bLatE6 - aLatE6), dLng = toRad(bLngE6 - aLngE6)
  const la1 = toRad(aLatE6), la2 = toRad(bLatE6)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h))))
}

/**
 * **兜底**计费距离 = 直线 × 绕路系数；门店未设坐标返回 null（调用方按 42226 处理）。
 *
 * 正常路径已经不走这里了：`POST /local/quote` 调运力方 batchPrice 拿真实道路距离
 * （见 services/delivery/quote.ts 的 measureRoadDistanceM），下单再信任 token 里签过名的那个值。
 * 这个函数只在「查价超时/失败」与「下单时没有可信 token」两种情况下顶上——所以 detourFactor
 * 取的是偏高的 1.7 而不是实测均值 1.67：高估只是少赚，低估是每单倒贴。
 */
export function billableDistanceM(s: LocalDeliverySettings, latE6: number, lngE6: number): number | null {
  if (s.store.latE6 === null || s.store.lngE6 === null) return null
  return Math.round(haversineM(s.store.latE6, s.store.lngE6, latE6, lngE6) * s.detourFactor)
}

/** 固定表口径的基础运费：起步价 + ⌈超出起步的公里数⌉ × 每公里价。与订单金额无关 */
export function tableBaseFee(s: LocalDeliverySettings, distanceM: number): number {
  const km = distanceM / 1000
  return s.fee.baseFee + Math.max(0, Math.ceil(km - s.fee.baseKm)) * s.fee.perKmFee
}

/** 这个距离该加多少钱。近单一档、其余一档；`quoteNearKm = 0` 关掉分档 */
export function markupFor(s: LocalDeliverySettings, distanceM: number): number {
  return s.fee.quoteNearKm > 0 && distanceM <= Math.round(s.fee.quoteNearKm * 1000)
    ? s.fee.quoteNearMarkupFen
    : s.fee.quoteMarkupFen
}

/**
 * QUOTE 口径的基础运费：**最低报价 + 加价**（加价按距离分档），再向上取整到 `roundToFen`。
 *
 * 取最低而不是平均，理由见 `LocalDeliverySettings.fee` 的注释。向上取整而不是四舍五入：
 * 取整这一步只该往我们有利的方向走，`¥7.33 → ¥7.50` 而不是 `→ ¥7.00`。
 *
 * ⚠️ 分档会在边界造成台阶：1.99 km 与 2.01 km 之间除了报价本身的差，还多跳一个加价差。
 * 旧的固定表本来就是台阶式的（≤3 km 一律 ¥6），顾客对这个形态不陌生，所以接受。
 */
export function quoteBaseFee(s: LocalDeliverySettings, lowestFen: number, distanceM: number): number {
  const raw = lowestFen + markupFor(s, distanceM)
  return s.fee.roundToFen > 0 ? Math.ceil(raw / s.fee.roundToFen) * s.fee.roundToFen : raw
}

/**
 * 最终运费 = 基础运费 叠加「与订单金额相关」的规则（目前只有满免）。
 *
 * `baseOverride` 是**报价那一刻**算出来的基础运费（QUOTE 口径下来自实时报价，签在 token 里）。
 * 下单端点必须走这条路：它按设计**不做第二次外呼**，重新算不出实时报价，
 * 而满免要用**下单时**的真实金额判（顾客报完价还会加菜），所以两件事必须分开——
 * 基础运费信 token，满免/起送在这里现算。不传 baseOverride 就退回固定表（老行为）。
 */
export function calcLocalFee(
  s: LocalDeliverySettings,
  distanceM: number,
  subtotal: number,
  baseOverride?: number | null
): { fee: number; inRange: boolean; belowMin: boolean } {
  const inRange = distanceM <= Math.round(s.radiusKm * 1000)
  const belowMin = s.fee.minOrderAmount > 0 && subtotal < s.fee.minOrderAmount
  let fee = baseOverride != null && Number.isFinite(baseOverride) && baseOverride >= 0
    ? baseOverride
    : tableBaseFee(s, distanceM)
  // 阶梯满额免运费：在所有达标档里取公里数最大的那一档，再看这一单的距离够不够近。
  // 用 reduce 取最大而不是 find/last——店主在后台把行写乱序时结果必须一样。
  const tier = s.fee.freeShipTiers.reduce<{ minAmountFen: number; maxKm: number } | null>(
    (best, t) => (subtotal >= t.minAmountFen && (best === null || t.maxKm > best.maxKm) ? t : best),
    null,
  )
  if (tier && distanceM <= Math.round(tier.maxKm * 1000)) fee = 0
  return { fee, inRange, belowMin }
}

/** 此刻是不是高峰时段（Asia/Shanghai）。空窗口列表 = 全天不分高峰 */
export function isPeakNow(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  const cur = shanghaiMinutes(now)
  return s.peak.windows.some((h) => cur >= toMin(h.start) && cur < toMin(h.end))
}

/** 骑手在路上的分钟数（不含备餐）。距离是门店→收货地址的道路距离 */
export function rideMinutes(s: LocalDeliverySettings, distanceM: number): number {
  return Math.round((distanceM / 1000 / s.riderSpeedKmh) * 60)
}

/**
 * 「从现在开始，还要多少分钟送到」的区间（分钟）。
 *
 * ⚠️ **计时起点是调用这个函数的那一刻**，而备餐是从店员点「接单」才开始的。
 * 所以它只有在**接单那一刻**调用才等于真实的预计送达；在下单那一刻调用得到的是
 * 「假设立刻接单」的乐观值——顾客下单到店员接单之间那一段（等付款、店里正忙）不在里面。
 * 这正是 2026-09-07 之前 estimatedDeliveryAt 系统性偏早的根因：它在下单时就写死了。
 * 现在下单路径只用它给顾客一个**大概**（结算页不显示钟点），真正的钟点在接单时才落库。
 *
 * 高峰返回真区间（如 25–30 + 路上），平时 min===max。调用方要一个单值时**一律取 max**：
 * 报晚了顾客早收到是惊喜，报早了是投诉。
 */
/**
 * 「接单 → 骑手把餐拿走」要多久。**这一段原来整个漏掉了**（2026-09-08 修）。
 *
 * 分两种情况，差别在于「骑手赶来」和「后厨备餐」是不是并行：
 *
 *   自动呼叫（`autoCallDelayMin > 0`）—— 接单后第 N 分钟自动发单，骑手一边赶来后厨一边做，
 *     两件事并行，取更晚的那个：`max(备餐, N + 呼叫到取货)`。
 *
 *   手动呼叫（`autoCallDelayMin === 0`，当前生产的设置）—— 什么时候呼取决于店员。
 *     **保守按串行算**：`备餐 + 呼叫到取货`。因为工作台上「呼叫骑手」是备餐中那一列的按钮，
 *     忙起来最可能的行为就是「菜装好了才想起来点」。按并行算等于替店员假设了一个
 *     他并没有承诺的习惯，而报早的代价是投诉。
 *
 * 想把这个数真正压下去，正确的做法不是改公式，是**把自动呼叫打开**——
 * 让骑手在备餐期间就在路上。
 */
export function pickupMinutes(s: LocalDeliverySettings, prep: number): number {
  return s.autoCallDelayMin > 0
    ? Math.max(prep, s.autoCallDelayMin + s.callToPickupMin)
    : prep + s.callToPickupMin
}

export function estimateMinutesRange(
  s: LocalDeliverySettings, distanceM: number, now: Date = new Date()
): { min: number; max: number; isPeak: boolean } {
  const ride = rideMinutes(s, distanceM)
  const peak = isPeakNow(s, now)
  const prepMin = peak ? s.peak.prepMinMinutes : s.prepMinutes
  const prepMax = peak ? s.peak.prepMaxMinutes : s.prepMinutes
  return {
    min: pickupMinutes(s, prepMin) + ride,
    max: pickupMinutes(s, prepMax) + ride,
    isPeak: peak,
  }
}

/**
 * 单值版（取区间上界）。用于要落一个具体时刻的地方——主要是接单时写 estimatedDeliveryAt。
 * 保留这个名字是因为它已经被小票、订阅消息等多处引用，语义没变（仍是「还要多少分钟」），
 * 变的只是它现在会按当前是否高峰给出不同的备餐时长。
 */
export function estimateMinutes(s: LocalDeliverySettings, distanceM: number, now: Date = new Date()): number {
  return estimateMinutesRange(s, distanceM, now).max
}

// ── 报价签名（防 quote 与下单之间金额漂移）───────────────────
/**
 * ── 凭证里签什么、为什么恰好是这些 ──
 *
 * 核心不变量：**token 里唯一不可在下单时重算的量是 `distanceM`**。它是运力方按「门店坐标 → 收货
 * 坐标」算出来的真实道路距离，下单端点信任它而不再自己重算（见 routes/orders.ts 的「token 信任
 * 边界」注释）。它只依赖两对坐标，所以两对坐标都必须签进去、下单时逐字段比对：
 *
 *  - 收货坐标（la/ln）：不签就有一条真实的薅价路径——顾客先对近处报价拿 token，再
 *    `PUT /addresses/:id` 把坐标改到 30 km 外，然后拿旧 token 下单，距离/范围/运费全按近处算。
 *  - 门店坐标（sla/sln）：概念上就是 geoVersion。店主改门店坐标（搬家、一键定位纠偏）之后，
 *    旧 token 里那段距离量的是另一条路，必须整张作废。用「把坐标签进去比对」而不是加一个计数器
 *    字段，是因为前者由结构保证、后者要靠「有人记得 +1」，且与收货坐标的做法对称。
 *
 * 其余每一个设置字段（运费阶梯、半径、起送门槛、免运门槛……）在下单路径上都用**当前**设置重新
 * 求值，所以这里**不签 `settings.version`**：那条粗粒度作废是纯冗余，删掉不丢任何保护，却会让
 * 店主改一次营业时间就把正在结算页的顾客全踢下来。
 *
 * 于是这个结构本身就是规格：**签进去的每一个字段都会在下单时被比对**，一个都不多——
 * `distanceSource` 是这条规则唯一的例外，见它自己的注释。
 */
interface QuotePayload {
  fee: number
  /**
   * 报价那一刻算出的**基础运费**（未叠加满免）。与 `fee` 分开签，是因为满免要用
   * **下单时**的金额判（顾客报完价还会加菜），而基础运费必须锁在报价那一刻。
   */
  baseFee: number
  /**
   * 这个基础运费是怎么来的，决定下单时**要不要重算**：
   *   QUOTE —— 来自报价那一刻的实时运力报价。下单端点按设计不做第二次外呼，
   *            重算不出来，只能信这一份签过名的 → 等于给顾客**锁价 15 分钟**。
   *   TABLE —— 来自固定表。表就在设置里，下单时重算得出来，所以**不信 token、现算**，
   *            店主中途调价能立刻生效（原有的 42227「配送费已更新」那条防线靠的就是这个）。
   */
  feeSource: 'QUOTE' | 'TABLE'
  distanceM: number; addressId: number
  latE6: number; lngE6: number
  storeLatE6: number; storeLngE6: number
  /**
   * ── `distanceSource` 不参与信任比对，纯属随行审计信息 ──
   *
   * 这一项和上面几项性质不同：它不是「下单时用来判断这张凭证还作不作数」的信任凭据，
   * 而是**报价那一刻发生了什么**的既成事实（这段 `distanceM` 到底是运力方 batchPrice 量出来的，
   * 还是 `/local/quote` 查价失败退回的直线估算）——下单端点没有第二次外呼去重新判定它，
   * 也不该有：判定只能发生一次，在报价那一刻。
   *
   * 之所以仍然签进 token（而不是让客户端在下单请求里另传一个字段）：HMAC 保证它不会被
   * 篡改成与实际报价不符的值，同时把它和这一次报价的 `distanceM/fee` 绑成同一个不可分割的
   * 事实，snapshot 到订单上才有意义。但**它不影响任何一条计费或作废判断**——不比对、
   * 不参与 42239/42227 的任何分支——纯粹是「这一单的运费当时是按实测还是估算收的」这一句
   * 事后审计要用的话，落在订单行上，见 routes/orders.ts。verifyQuote 里仍对它做白名单校验
   * （只认 'MEASURED'/'ESTIMATED'），这是防御性解析，不是安全边界。
   */
  distanceSource: 'MEASURED' | 'ESTIMATED'
}
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const hmac = (s: string) => crypto.createHmac('sha256', `quote:${config.jwt.userSecret}`).update(s).digest('hex').slice(0, 32)

/**
 * 报价凭证的过期时刻。
 *
 * 抽出来是为了让**客户端不再自己写一个 TTL**：小程序原来在 confirm.js 里硬编码
 * 「超过 10 分钟就算陈旧」，而这里签的是 15 分钟——两个数字各写各的，改一边另一边
 * 不知道，中间那 5 分钟里页面以为凭证还新鲜、服务端已经准备拒了。
 * 现在 /local/quote 随报价一起把这个时刻下发给客户端，两边共用同一个来源。
 */
export function quoteExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + QUOTE_TTL_MS)
}

export function signQuote(p: QuotePayload, now: Date = new Date()): string {
  const body = b64u(JSON.stringify({
    f: p.fee, b: p.baseFee, fs: p.feeSource, d: p.distanceM, a: p.addressId,
    la: p.latE6, ln: p.lngE6, sla: p.storeLatE6, sln: p.storeLngE6,
    ds: p.distanceSource,
    e: quoteExpiresAt(now).getTime(),
  }))
  return `${body}.${hmac(body)}`
}

export function verifyQuote(token: string, now: Date = new Date()): QuotePayload | null {
  const [body, sig] = token.split('.')
  // sig 恒为 32 位小写 hex：用字符集校验而非 sig.length===32（字符数），
  // 否则多字节字符（如中文）字符数也可能凑到 32，但 Buffer.byteLength 会远大于 32，
  // 传给 timingSafeEqual 两个长度不等的 Buffer 会直接抛 RangeError，
  // 冒泡到全局错误处理会当作 500 触发店主告警（构造 token 即可远程刷告警）。
  if (!body || !sig || !/^[0-9a-f]{32}$/.test(sig)) return null
  const expect = hmac(body)
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null
  } catch {
    // 防御未来改动导致长度校验被绕过：timingSafeEqual 抛异常时按校验失败处理，不冒泡成 500
    return null
  }
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof o.e !== 'number' || o.e < now.getTime()) return null
    // 坐标四项（la/ln 收货、sla/sln 门店）都是后加的字段：老格式 token 缺其中任何一个一律判无效，
    // 而不是当成 0——0 会与「点在赤道本初子午线」这种理论坐标相等，等于让老 token 永久绕过坐标比对。
    // 缺字段判无效在下单侧就是 42239（没有可信凭证），顾客重报一次价即可，不存在兼容包袱。
    // `b`（基础运费）与坐标四项同规则：后加字段，缺了一律判无效而不是兜个默认值——
    // 兜默认会让老 token 按固定表计费，而 QUOTE 口径下两者近单差 ¥2.5，等于静默漏钱。
    // token 只活 15 分钟，判无效的代价就是顾客重报一次价，没有兼容包袱。
    const fields = [o.f, o.b, o.d, o.a, o.la, o.ln, o.sla, o.sln]
    if (fields.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null
    // ds 同样是后加字段：白名单校验（只认这两个值），不是信任比对——它不参与任何计费/作废判断，
    // 见上面 QuotePayload.distanceSource 的注释。老格式 token 缺这一项一律判无效，与坐标四项同规则。
    if (o.ds !== 'MEASURED' && o.ds !== 'ESTIMATED') return null
    // fs 与 ds 同规则：白名单校验，缺了判无效。它决定下单时信不信 token 里的基础运费，
    // 兜个默认值就等于替店主做了「锁不锁价」的决定。
    if (o.fs !== 'QUOTE' && o.fs !== 'TABLE') return null
    return {
      fee: o.f, baseFee: o.b, feeSource: o.fs, distanceM: o.d, addressId: o.a,
      latE6: o.la, lngE6: o.ln, storeLatE6: o.sla, storeLngE6: o.sln,
      distanceSource: o.ds,
    }
  } catch {
    return null
  }
}

/** /local/meta 下发的公开子集（不含小费上限、运力配置等运营参数） */
export function publicLocalMeta(s: LocalDeliverySettings, now: Date = new Date()) {
  return {
    enabled: s.enabled,
    isOpen: isOpenNow(s, now),
    paused: isPaused(s, now) ? { reason: s.paused?.reason ?? '', until: s.paused?.until ?? null } : null,
    nextOpenText: nextOpenText(s, now),
    closedKind: closedKind(s, now),
    businessHours: s.businessHours,
    store: {
      name: s.store.name, phone: s.store.phone, province: s.store.province, city: s.store.city,
      district: s.store.district, address: s.store.address, latE6: s.store.latE6, lngE6: s.store.lngE6,
    },
    radiusKm: s.radiusKm,
    radiusStraightKm: Math.round((s.radiusKm / s.detourFactor) * 10) / 10,
    fee: s.fee,
    prepMinutes: s.prepMinutes,
    acceptGraceMin: s.acceptGraceMin,
    limits: s.limits,
    // ── 2026-09-11 起按履约方式分节；上面的老字段保留给老客户端 ──
    delivery: {
      enabled: s.enabled, isOpen: isOpenNow(s, now),
      paused: isPaused(s, now) ? { reason: s.paused?.reason ?? '', until: s.paused?.until ?? null } : null,
      closedKind: closedKind(s, now), nextOpenText: nextOpenText(s, now),
    },
    pickup: {
      enabled: s.pickup.enabled,
      paused: isPickupPaused(s, now) ? { reason: s.pickup.paused?.reason ?? '', until: s.pickup.paused?.until ?? null } : null,
      available: pickupAvailableNow(s, now),
      minOrderAmountFen: s.pickup.minOrderAmountFen,
      discount: s.pickup.discount,
      discountText: s.pickup.discount.type === 'PERCENT' && s.pickup.discount.value < 100
        ? `自取享 ${(s.pickup.discount.value / 10).toFixed(1).replace(/\.0$/, '')} 折`
        : s.pickup.discount.type === 'FIXED' && s.pickup.discount.value > 0
          ? `自取立减 ¥${(s.pickup.discount.value / 100).toFixed(2)}`
          : '',
      slotMinutes: s.pickup.slotMinutes,
      daysAhead: s.pickup.daysAhead,
    },
    packing: { enabled: s.packing.enabled, perItemFen: s.packing.perItemFen },
    promotion: publicPromotionView(s, now),
    holiday: isHolidayNow(s, now) ? { until: s.holiday?.until ?? null, reason: s.holiday?.reason ?? '' } : null,
  }
}
