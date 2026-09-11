/**
 * 把订单渲染成飞鹅小票内容字符串。规格 §8b「票面（58mm，32 列）」。
 *
 * 两套长度约束，刻意分开处理：
 * - **列对齐**（商品名截断、数量/小计右对齐）用「显示宽度」——ASCII 记 1、其余（含中文）记 2，
 *   对应 58mm 纸「32 字节/16 汉字」的行业惯例排版目标，纯粹是视觉对齐，不代表传输编码。
 * - **≤5000 字节的硬限制**（飞鹅 Open_printMsg.content 参数）按用户指令用 UTF-8 字节数
 *   （`Buffer.byteLength(s, 'utf8')`，中文一个字 3 字节）计算——飞鹅官方文档与本次调研均未
 *   明确 content 实际传输编码是 UTF-8 还是老式票据机常见的 GBK（双字节/汉字），这里按更保守、
 *   更符合现代 HTTP 表单默认的 UTF-8 假设实现；**真机联调时如发现打印出来的字节数上限与本函数
 *   算出的不一致（比如同样文本真机允许更长），大概率是编码差异，需要按 GBK 双字节重算并调整
 * `TICKET_BYTE_LIMIT` 的判断逻辑**——这点在返回报告里作为待核实项列出。
 */

import { localShortAddress } from '../../utils/address'

export type TicketChannel = 'LOCAL' | 'EXPRESS' | 'PICKUP'
const CHANNEL_WORD: Record<TicketChannel, string> = { LOCAL: '同城', EXPRESS: '邮寄', PICKUP: '自取' }

export interface TicketItemInput {
  productName: string
  specText: string | null
  quantity: number
  /** 分。赠品行恒为 0 */
  subtotal: number
  /** M2：随单赠品。两联都要标——赠品是一道要做、要装袋的菜，漏标就是漏发 */
  isGift?: boolean
  /** M2：单件积分价。配送联用它代替 ¥0.00 显示 */
  pointsCost?: number
}

export interface TicketOrderInput {
  channel: TicketChannel
  orderNo: string
  createdAt: Date
  paidAt: Date | null
  items: TicketItemInput[]
  /** 商品小计（分） */
  totalAmount: number
  /** 运费（分） */
  shippingFee: number
  /** 实付（分） */
  actualAmount: number
  remark: string | null
  /** M2：券抵扣额（分）。>0 时配送联打一行「优惠券 −¥X」；**厨房联不打**（不印钱） */
  discountAmount?: number
  /** M2：赠品消耗的积分。>0 时配送联打一行；厨房联同样不打 */
  pointsUsed?: number
  receiverName: string
  receiverPhone: string
  receiverFullAddress: string
  // ── 同城专属（channel==='LOCAL' 时使用）──
  // 省市区拆分字段：同城票面只用「区 + 详细地址」，省市恒为门店所在地，是纯噪音
  receiverDistrict?: string | null
  receiverDetail?: string | null
  receiverPoiName?: string | null
  distanceM?: number | null
  estimatedDeliveryAt?: Date | null
  /** REPEAT（未接单重复播报）第几次催单，只在打整张全票时（repeat.reprint=true）打印。
   *  ⚠️ 曾经跟「今日第 N 单」并排显示，M12 修过一次「把播报次数当流水号」的误读；
   *  PO 2026-09-06 决定票面不再显示今日订单数，那一行连同 dailyOrderSeq 查询一起删了，
   *  所以现在这里不会再有混淆对象——但字段名仍然刻意叫 announceNo，别改回 seq。 */
  // ── 自取专属（channel==='PICKUP'）──
  pickupAt?: Date | null
  /** 「今天 12:00–12:30」，由调用方用 services/pickup 的 pickupSlotLabel 算好传进来（本文件不算时区） */
  pickupSlotLabel?: string | null
  /** 自取优惠（分）。>0 时取餐联在合计与券之间打一行；厨房联不打 */
  pickupDiscountAmount?: number
  announceNo?: number | null
}

const TICKET_BYTE_LIMIT = 5000
const LINE_WIDTH = 32
/**
 * `<B>` 包裹的行的可用列数。
 *
 * 飞鹅的 `<B>` 是**放大一倍**（不是加粗——加粗是 `<BOLD>`），所以一行只能放下普通行一半的内容。
 *
 * ✅ 2026-09-06 真机标尺实测（SN 222601993）：同一串 **32 个数字**，在 `<B>` 模式下**正好折成
 * 两行、每行 16 个**；对照组普通字号那行撑到第 31 列才折。所以 `<B>` 行的可用宽度就是 16 列。
 * （标尺票是意外做成的：`'…下面是<B>16格'` 这行的 `<B>` 忘了闭合，后面几行全被带成放大模式，
 * 反而一次同时给出了两种字号的折行位置，比原设计的"两条线比长短"更直接。）
 *
 * 厨房联的商品行整行套在 `<B>` 里，若仍按 32 列排版，纸上会折成两行、右侧补的空格还会把
 * 断点推到奇怪的位置。
 */
const BIG_LINE_WIDTH = LINE_WIDTH / 2

/**
 * 赠品行前缀。**两联用同一个标记**。
 *
 * 全角「赠」+ 半角空格 = 3 列。为什么不是 `[赠]`（4 列）或 `【赠】`（6 列）：厨房联走 `<B>`
 * 只有 16 列，减去 ` x1` 后留给菜名的不到 13 列——多占 3 列就少 1–2 个汉字，
 * 「秘制酱牛肉」这种五字菜名会被截。
 *
 * 两联标记必须一致：配送联宽松、厨房联紧张，很容易演变成两处各用一套，
 * 然后打包的人对着两张写法不同的票核对。3 列两边都放得下，那就统一。
 */
const GIFT_MARK = '赠 '

// ── 显示宽度（纯排版对齐用，不代表传输编码）───────────────────
function charWidth(ch: string): number {
  return (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1
}
function strWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}
function truncWidth(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  let w = 0
  let out = ''
  for (const ch of s) {
    const cw = charWidth(ch)
    if (w + cw > maxWidth) break
    out += ch
    w += cw
  }
  return out
}
function padRightWidth(s: string, width: number): string {
  const w = strWidth(s)
  return w >= width ? s : s + ' '.repeat(width - w)
}

// 顾客/商家可控字段（remark、收件信息、商品名/规格、打印机备注名）在拼进票面前一律先剥掉尖括号。
// 飞鹅票面用 <TAG> 做控制指令（<CUT> 切纸、<BR> 换行、<C> 居中、<B> 放大一倍、
// <CB> 居中放大、<BOLD> 加粗，见 assemble()），顾客能自填的
// 字段一旦原样带过 `<` `>`，就能在商品明细之前插入一次 <CUT>（金额/明细被切到下一段，极易被漏看）、
// 或塞进飞鹅内容校验不认识的标签把整单送不出去。直接剥字符而不是转义/替换成全角——票面本就没有
// 反向解析的需求，剥比转义更简单也更不容易被绕过（转义字符本身还是可能被拼接出新的 `<`/`>`）。
const esc = (s: string) => s.replace(/[<>]/g, '')

/**
 * 票面手机号脱敏（PO 2026-09-06 定）：小票会被贴在袋子上、看完随手扔进垃圾桶，
 * 顾客手机号不该以明文躺在上面。保留前 3 后 4，中间一律 `****`。
 *
 * **完整号码仍在两处**：后台订单详情（店家自己查）、骑手平台（呼叫骑手时按接口原样传，
 * 不经过票面）。所以要联系顾客是有路径的，只是不走这张纸。
 *
 * ⚠️ 代价说清楚：**光看这张票打不出电话**。若哪天改成店家自配送、且送货的人手上只有票，
 * 需要在这里放开——那时应该只放开配送联、并且明确这是个知情的取舍，而不是悄悄改回去。
 *
 * 非 11 位（座机、异常数据）不猜结构：长度 ≤7 时原样返回（遮了等于全遮，没意义），
 * 否则同样保留前 3 后 4。
 */
function maskPhone(raw: string): string {
  const s = raw.trim()
  if (s.length <= 7) return s
  return `${s.slice(0, 3)}****${s.slice(-4)}`
}

const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`

const SH_TZ = 'Asia/Shanghai'
const DATE_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: SH_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
})
function fmtDateTime(d: Date | null | undefined): string {
  if (!d) return '—'
  const parts = DATE_FMT.formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** 按显示宽度折行；不省略、不丢字。空串返回空数组 */
function wrapByWidth(s: string, width: number): string[] {
  if (width <= 0 || !s) return []
  const out: string[] = []
  let cur = ''
  let w = 0
  for (const ch of s) {
    const cw = charWidth(ch)
    if (w + cw > width) { out.push(cur); cur = ''; w = 0 }
    cur += ch
    w += cw
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 商品明细行。返回 1 或 2+ 行——**规格放不下时独占后续行，不再被截掉**。
 *
 * ⚠️ 2026-09-06 修：原实现是 `truncWidth(名称 + 规格, 22列)`，超出部分**静默丢弃、连省略号都没有**。
 * 邮寄 SKU 属性一多就出事，真机复现：
 *     秘制酱牛肉(500克/切片/微辣)       → `秘制酱牛肉(500克/切片/ x1 ¥41.00`
 *     秘制酱牛肉(500克/切片/微辣/真空装) → `秘制酱牛肉(500克/切片/ x2 ¥42.00`
 * **两个不同的 SKU 打出来一模一样**，打包的人分不出来；「微辣/不辣」这种属性直接消失 → 发错货。
 * 容量不是问题（改成两行式后邮寄单仍能装 48–106 件），信息完整才是。
 */
function formatItemLines(item: TicketItemInput, width = LINE_WIDTH): string[] {
  // 赠品行的金额列显示积分而不是 `¥0.00`——`subtotal` 恒为 0，打成 ¥0.00 会让打包员
  // 以为这一行漏收了钱、回头去问店主。显示「积分80」一眼就知道是怎么回事。
  const qtyAmt = item.isGift
    ? ` x${item.quantity} 积分${(item.pointsCost ?? 0) * item.quantity}`
    : ` x${item.quantity} ${yuan(item.subtotal)}`
  const nameWidth = Math.max(2, width - strWidth(qtyAmt))
  // 前缀拼在 esc() **之后**——esc 只剥 < >，全角字与空格都不会被剥，但把前缀塞进 esc 的入参
  // 会让它参与「顾客能否注入控制标签」的判断，语义就乱了
  const name = (item.isGift ? GIFT_MARK : '') + esc(item.productName)
  const spec = item.specText ? `(${esc(item.specText)})` : ''
  // 名称+规格一行放得下：保持原来的紧凑排版
  if (strWidth(name + spec) <= nameWidth) {
    return [padRightWidth(name + spec, nameWidth) + qtyAmt]
  }
  // 放不下：第一行「名称 + 数量金额」，规格缩进两格另起行（长规格继续折行，不丢字）
  const first = padRightWidth(truncWidth(name, nameWidth), nameWidth) + qtyAmt
  return spec ? [first, ...wrapByWidth(spec, width - 2).map((l) => '  ' + l)] : [first]
}

/**
 * 厨房联的商品行：菜名、规格、数量，**没有金额**。level 0=完整，1=省掉规格。
 *
 * **数量任何情况下都不省。** 一度设计过第三级「只留菜名」，是错的：数量是后厨最关键的信息
 * （做 2 份还是 5 份），而 ` x2` 只占 4 个字符、省掉它几乎不省空间。占地方的是规格，
 * 所以降级只降规格；再放不下就减少件数（`……等 N 件`），而不是让留下来的行缺数量。
 */
function kitchenItemLines(item: TicketItemInput, level: 0 | 1): string[] {
  // 厨房联同样要标赠品：它是一道要做、要装进袋子的菜，不标就会漏发。
  // 但**不打金额、不打优惠**——与「厨房联只有菜品和数量」一致（PO 2026-09-06 定）。
  const name = (item.isGift ? GIFT_MARK : '') + esc(item.productName)
  const qty = ` x${item.quantity}`
  const nameWidth = Math.max(2, BIG_LINE_WIDTH - strWidth(qty))
  const spec = level === 0 && item.specText ? `(${esc(item.specText)})` : ''
  // 菜名 + 数量放大（后厨隔着灶台要看清的就这两样），**规格用普通字号**：
  // 规格是辅助信息，放大后 16 列会把「微辣」这种词从中间劈开（实测 `(200克/去骨/微` / `辣)`），
  // 普通字号 32 列基本一行放得下，反而更好读。
  if (strWidth(name + spec) <= nameWidth) {
    return [`<B>${padRightWidth(name + spec, nameWidth) + qty}</B>`]
  }
  const first = `<B>${padRightWidth(truncWidth(name, nameWidth), nameWidth) + qty}</B>`
  return spec ? [first, ...wrapByWidth(spec, LINE_WIDTH - 2).map((l) => '  ' + l)] : [first]
}

function distanceText(m: number | null | undefined): string {
  if (m === null || m === undefined) return ''
  return m >= 1000 ? `${(m / 1000).toFixed(1)}公里` : `${m}米`
}

/**
 * 切纸前的补白行数。
 *
 * ⚠️ 2026-09-06 真机标定（SN 222601993，FP-V58-WHC）：**切刀在打印头下游约 5.5 行处**。
 * `<CUT>` 是就地切，末行此时还没走到切刀位置，于是刀落在票的中间——标定票的切点稳定落在
 * 「垫6」这一行中间，两段完全一致。后果是**每一张票都缺末尾几行**：订单票丢「实付」与
 * 「接单请在工作台操作」，测试页只有 4 行正文，整张都在切刀上游、直接被拦腰截断。
 * 这不是偶发，是所有票的必然行为，只是票越长越不容易被发现。
 *
 * 补 7 行 = 6 行（把内容顶出切刀范围）+ 1 行余量。
 *
 * ⚠️ 补白必须是**含一个空格的行**，不能用空字符串：`['a','','']` 经 `join('<BR>')` 得到
 * 连续的 `<BR><BR><BR>`，飞鹅会把它折叠掉，补白等于没写（第一次标定就栽在这里，
 * 补 0/2/4/6 行四段表现完全一样）。
 */
const CUT_PAD_LINES = 7

/** 组装含 `<BR>` 换行标签的整票内容；lines 里每一项已是一「行」（不含 `<BR>`） */
function assemble(lines: string[]): string {
  const body = lines.filter((l) => l !== undefined && l !== null)
  return [...body, ...Array(CUT_PAD_LINES).fill(' ')].join('<BR>') + '<BR><CUT>'
}

const HR = '-'.repeat(LINE_WIDTH)

/**
 * 渲染订单小票（NEW_ORDER / REPRINT / repeat.reprint=true 时的 REPEAT 均用这个）。
 *
 * **同城出双联**（PO 2026-09-06 定）：一次打印任务里放两段内容、中间 `<CUT>` 切开——
 * 第一段「配送联」带地址电话金额贴袋子，第二段「厨房联」只有菜品和备注、**不印地址不印钱**。
 * 后厨看到的信息越少越不容易出错，顾客住址电话也不必在后厨到处传。
 * 这比「copies=2 印两张一样的」好，还顺带解决了另一个问题：`copies` 是**每台打印机一个值**
 * （`PrinterEntry.copies`，且 `validatePrinterSettings` 拒绝重复 SN），一台机器同城邮寄共用时
 * 设成 2 会让**邮寄单也白打一张**。双联落地后 `copies` 回到 1。
 *
 * **邮寄仍是单联**——邮寄是照单拣货打包，没有"后厨"这个环节。
 *
 * 超 5000 字节时的降级顺序（PO 2026-09-06 定：**保全配送联**）：
 *   ① 厨房联省掉规格 → ② 厨房联减少件数（「……等 N 件」）→ ③ 配送联减少件数 → ④ 压缩备注
 * ①② 先动是因为 PO 选了「配送联优先保全」（骑手要逐件核对）。
 * **厨房联的数量列在任何一级都不省**——见 kitchenItemLines 的注释。
 *
 * 触发门槛：按 6 字菜名算要 22 件以上。生产现有订单**全是 1 件**，这套降级大概率永不执行。
 */
export function renderOrderTicket(o: TicketOrderInput): string {
  const isLocal = o.channel === 'LOCAL'
  const isPickup = o.channel === 'PICKUP'
  const hasKitchen = isLocal || isPickup // 自取也是后厨现拌 + 柜台装袋，两联
  const header: string[] = [
    `<CB>${isPickup ? '到店自取' : isLocal ? '同城配送' : '全国邮寄'}</CB>`,
    ...(o.announceNo !== null && o.announceNo !== undefined ? [`<C>第 ${o.announceNo} 次催单</C>`] : []),
    // PO 2026-09-06 定：顶部只放**加大的后 4 位**。完整单号 20 字符在 32 列纸上占大半行，
    // 而店里认单靠这 4 位，没人逐位核对前缀。完整单号挪到 footer 小字——客服对单、查退款仍需要。
    // 同日一并去掉了「今日第 N 单」（PO：不显示今日订单数），连带省掉每张票一次 dailyOrderSeq 查询。
    // 单号旁边放**手机尾号**（PO 2026-09-08）：快递100 的下单接口没有商户单号字段，
    // 骑手 app 上是运力方自己的单号，跟 #5203 对不上；但它一定显示收件人手机，
    // 尾号是全行业通用的取货核对键。放大到和单号同一行，骑手在柜台一眼对上袋子。
    // 厨房联同样印尾号，两联靠它联系（见 buildKitchen）。
    // 头部**只放尾号、不放单号**（PO 2026-09-08 再定）：骑手和店员在柜台对的只有尾号，
    // 单号在票头上只是干扰。票面与工作台都不再显示单号（PO 2026-09-09 定）；完整单号在后台订单页可查，退款/客诉查得到。
    `<CB>尾号${o.receiverPhone.slice(-4)}</CB>`,
    `下单：${fmtDateTime(o.createdAt)}`,
    `付款：${fmtDateTime(o.paidAt)}`,
  ]

  const receiverBlock: string[] = isPickup
    ? [
        // 取餐联：时间放大（顾客几点来是店员要看的第一眼），姓名与脱敏电话普通字号；不印地址——地址是店自己
        `<B>取餐 ${esc(o.pickupSlotLabel ?? '')}</B>`,
        `取餐人 ${esc(o.receiverName)}`,
        `电话 ${maskPhone(esc(o.receiverPhone))}`,
      ]
    : isLocal
      ? [
          // PO 2026-09-06 定：**姓名与地址放大、各占一行**——送货的人在袋子堆里认单、找门牌，
          // 靠的就是这两样，挤在一行小字里最容易看错。
          // **电话不放大**：已经脱敏了，放大也拨不出去，它只剩「跟后台核对是不是同一单」这一个用途。
          // ⚠️ `<B>` 行只有 16 列（真机标尺实测，见 BIG_LINE_WIDTH），所以标签用空格不用「：」。
          `<B>收货人 ${esc(o.receiverName)}</B>`,
          // 同城单省市恒为门店所在地，对厨房是纯噪音；区不能省——配送范围可能跨区。
          // 放大后会折成 2–3 行，这是有意的：地址是送货时唯一真正要看清的东西。
          `<B>地址 ${esc([o.receiverPoiName, localShortAddress(o)].filter(Boolean).join(' '))}</B>`,
          `电话 ${maskPhone(esc(o.receiverPhone))}`,
          ...(o.distanceM !== null && o.distanceM !== undefined ? [`距离：${distanceText(o.distanceM)}`] : []),
          ...(o.estimatedDeliveryAt ? [`预计送达：${fmtDateTime(o.estimatedDeliveryAt)}`] : []),
        ]
      : [
          `<B>收件人 ${esc(o.receiverName)}</B>`,
          // 邮寄地址比同城长（含省市），放大后能折到 5–6 行。仍然放大：这串字要被抄到快递单上，
          // 抄错一位就是一件退回来的货，多费几厘米纸换少一次抄错值得。
          `<B>地址 ${esc(o.receiverFullAddress)}</B>`,
          `电话 ${maskPhone(esc(o.receiverPhone))}`,
        ]

  // 备注要突出：<CB> 居中放大加粗。规格 §8b 提到的「餐具标记」目前 Order 无对应字段
  // （精细餐具选项是 §12 明确的二期项），先不渲染，等那个字段落地后在这里补一行。
  // remark 是顾客自填的自由文本，必须先 esc 再拼进票面——不然顾客填一个 <CUT> 就能在商品明细
  // 之前提前切纸（金额/明细落到下一段），填 <QR> 之类飞鹅不认识的标签会让内容校验失败、
  // 整单一张纸都不出（H2）。上限 20 字由接口与小程序共同约束（PO 2026-09-06 定，见 orders.ts）。
  const remarkBlock: string[] = o.remark ? [`<CB>备注：${esc(o.remark)}</CB>`] : []

  // 优惠两行只在**配送联**出现（PO 2026-09-06 定：厨房联只有菜品和数量，不印钱）。
  // 位置有讲究：券在「合计」与「运费」之间——顺序要和顾客在结算页看到的一致
  // （小计 → 券 → 运费 → 实付），店员对账时能逐行对上。
  // 赠品抵扣放在「实付」之后：它不参与这个加减法（赠品价 0、积分另算），
  // 混进上面那三行会让人以为实付里减过它。
  const footer: string[] = [
    `合计：${yuan(o.totalAmount)}`,
    ...(o.pickupDiscountAmount && o.pickupDiscountAmount > 0 ? [`自取优惠：−${yuan(o.pickupDiscountAmount)}`] : []),
    ...(o.discountAmount && o.discountAmount > 0 ? [`优惠券：−${yuan(o.discountAmount)}`] : []),
    ...(isPickup ? [] : [`运费：${yuan(o.shippingFee)}`]),
    `<B>实付：${yuan(o.actualAmount)}</B>`,
    ...(o.pointsUsed && o.pointsUsed > 0 ? [`赠品抵扣：${o.pointsUsed} 积分`] : []),
    // PO 2026-09-09 定：票面不印单号，认单只用尾号；完整单号在后台订单页。
    '接单请在工作台操作',
  ]

  const buildItemLines = (items: TicketItemInput[], omitted: number): string[] => {
    const lines = items.flatMap((it) => formatItemLines(it))
    if (omitted > 0) lines.push(`……等 ${omitted} 件`)
    return lines
  }

  /** 厨房联整段（不含 assemble 的补白与 CUT）。level 见 kitchenItemLines；keep=null 表示全列 */
  const buildKitchen = (level: 0 | 1, keep: number | null): string[] => {
    const items = keep === null ? o.items : o.items.slice(0, keep)
    const omitted = keep === null ? 0 : o.items.length - keep
    return [
      '<CB>厨房联</CB>',
      // 厨房联也用尾号（PO 2026-09-08 定）：两联靠同一个数联系，后厨出菜装袋时对得上配送联。
      // 尾号 4 位不是完整手机号，不算泄漏联系方式。
      `<CB>尾号${o.receiverPhone.slice(-4)}</CB>`,
      HR,
      ...items.flatMap((it) => kitchenItemLines(it, level)),
      ...(omitted > 0 ? [`<B>……等 ${omitted} 件</B>`] : []),
      ...(o.remark ? [HR, `<CB>备注：${esc(o.remark)}</CB>`] : []),
    ]
  }

  const deliveryOf = (itemLines: string[]) =>
    assemble([...header, ...receiverBlock, ...remarkBlock, ...itemLines, ...footer])
  const totalBytes = (itemLines: string[], kitchen: string[] | null) =>
    Buffer.byteLength(deliveryOf(itemLines), 'utf8') +
    (kitchen ? Buffer.byteLength(assemble(kitchen), 'utf8') : 0)

  let itemLines = buildItemLines(o.items, 0)
  let kitchen: string[] | null = hasKitchen ? buildKitchen(0, null) : null

  if (totalBytes(itemLines, kitchen) > TICKET_BYTE_LIMIT) {
    // ①②③ 先降级厨房联（PO：保全配送联）
    if (hasKitchen) {
      kitchen = buildKitchen(1, null)
      if (totalBytes(itemLines, kitchen) > TICKET_BYTE_LIMIT) {
        let keep = o.items.length
        while (keep > 0) {
          keep--
          kitchen = buildKitchen(1, keep)
          if (totalBytes(itemLines, kitchen) <= TICKET_BYTE_LIMIT) break
        }
      }
    }
    // ④ 还是超：减少配送联的展示件数
    if (totalBytes(itemLines, kitchen) > TICKET_BYTE_LIMIT) {
      let keep = o.items.length
      while (keep > 0) {
        keep--
        const candidate = buildItemLines(o.items.slice(0, keep), o.items.length - keep)
        itemLines = candidate
        if (totalBytes(candidate, kitchen) <= TICKET_BYTE_LIMIT) break
      }
      // ⑤ 最后手段：压缩备注。不牺牲单号/收货信息这类不可省略的关键信息。
      if (totalBytes(itemLines, kitchen) > TICKET_BYTE_LIMIT && o.remark) {
        const over = totalBytes(itemLines, kitchen) - TICKET_BYTE_LIMIT
        const shrink = Math.max(0, o.remark.length - Math.ceil(over / 2))
        remarkBlock[0] = `<CB>备注：${truncWidth(esc(o.remark), shrink)}…</CB>`
        if (hasKitchen) kitchen = buildKitchen(1, 0)
      }
    }
  }

  return deliveryOf(itemLines) + (kitchen ? assemble(kitchen) : '')
}

/** 未接单重复播报的精简「催接单」小票（D7；repeat.reprint=false 时用这个，而不是整张全票）。
 *  announceNo 是这一单第几次被催（M12：不是当日流水号，命名与文案上都要跟"今日第N单"分开，
 *  不然店员会把催单次数误读成流水号）。 */
export function renderReminderTicket(input: { channel: TicketChannel; waitedMin: number; announceNo: number; receiverPhone: string }): string {
  const lines = [
    '<CB>催接单</CB>',
    `<CB>尾号${input.receiverPhone.slice(-4)}</CB>`,
    `${CHANNEL_WORD[input.channel]}订单`,
    `<B>已等待 ${input.waitedMin} 分钟未接单（第 ${input.announceNo} 次催单）</B>`,
    '请到工作台接单',
  ]
  return assemble(lines)
}

/** 取消/退款提醒票 */
export function renderCancelTicket(input: { channel: TicketChannel; reason: string; at: Date; receiverPhone: string }): string {
  const lines = [
    '<CB>订单取消</CB>',
    `<CB>尾号${input.receiverPhone.slice(-4)}</CB>`,
    `${CHANNEL_WORD[input.channel]}订单`,
    `时间：${fmtDateTime(input.at)}`,
    `<BOLD>原因：${input.reason}</BOLD>`,
  ]
  return assemble(lines)
}

/**
 * 顾客申请取消。**这是取消流程里唯一一张票**（PO 2026-09-07 定）。
 *
 * 它的读者是**店员**，不是厨房——「厨房不用管，店员会通知」。所以票面回答两个问题：
 *  ① 停哪一单的哪几道菜（菜名 + 份数，照着停手就行，不必再拿单号去比对挂着的单）；
 *  ② 该不该退（顾客自己写的理由——「点错了」和「太久了」是两回事）。
 *
 * **不印时长**：这张票是在顾客点下申请的那一刻打的，而顾客只有接单后 5 分钟内点得动，
 * 所以任何「已备餐 X 分钟」印出来恒小于 5，是个废数字。要看等了多久请看工作台卡片。
 * 也不印地址金额：那些在新单票上已经有了，这张票不负责配送。
 */
export function renderCancelRequestTicket(input: {
  channel: TicketChannel; at: Date; receiverPhone: string
  items: TicketItemInput[]; note?: string | null
}): string {
  const lines = [
    '<CB>顾客申请取消</CB>',
    `<CB>尾号${input.receiverPhone.slice(-4)}</CB>`,
    `${CHANNEL_WORD[input.channel]}订单 · ${fmtDateTime(input.at)}`,
    HR,
    // 菜名与份数用厨房联那套放大渲染：这两样是隔着灶台要看清的
    ...input.items.flatMap((it) => kitchenItemLines(it, 0)),
    HR,
    ...(input.note ? wrapByWidth(`顾客说：${esc(input.note)}`, LINE_WIDTH) : []),
    '<BOLD>请到工作台确认处理</BOLD>',
  ]
  return assemble(lines)
}

// renderResumeTicket（取消申请被驳回 → 出票让厨房继续做）已于 2026-09-07 删除：
// PO 定「取消流程只留一张票，厨房不用管、店员会通知」，驳回改为在工作台卡片上显示
// 「已驳回 · 继续完成此订单」。见 routes/admin/delivery.ts 的驳回端点。

/** 后台「打印测试页」 */
export function renderTestTicket(printerName?: string): string {
  const lines: string[] = [
    '<CB>打印测试页</CB>',
    ...(printerName ? [`打印机：${esc(printerName)}`] : []),
    `时间：${fmtDateTime(new Date())}`,
    '若能正常出纸即打印链路正常',
  ]
  return assemble(lines)
}
