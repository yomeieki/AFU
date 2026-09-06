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

export type TicketChannel = 'LOCAL' | 'EXPRESS'

export interface TicketItemInput {
  productName: string
  specText: string | null
  quantity: number
  /** 分 */
  subtotal: number
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
  const qtyAmt = ` x${item.quantity} ${yuan(item.subtotal)}`
  const nameWidth = Math.max(2, width - strWidth(qtyAmt))
  const name = esc(item.productName)
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
  const name = esc(item.productName)
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
  const header: string[] = [
    `<CB>${isLocal ? '同城配送' : '全国邮寄'}</CB>`,
    ...(o.announceNo !== null && o.announceNo !== undefined ? [`<C>第 ${o.announceNo} 次催单</C>`] : []),
    // PO 2026-09-06 定：顶部只放**加大的后 4 位**。完整单号 20 字符在 32 列纸上占大半行，
    // 而店里认单靠这 4 位，没人逐位核对前缀。完整单号挪到 footer 小字——客服对单、查退款仍需要。
    // 同日一并去掉了「今日第 N 单」（PO：不显示今日订单数），连带省掉每张票一次 dailyOrderSeq 查询。
    `<CB>#${o.orderNo.slice(-4)}</CB>`,
    `下单：${fmtDateTime(o.createdAt)}`,
    `付款：${fmtDateTime(o.paidAt)}`,
  ]

  const receiverBlock: string[] = isLocal
    ? [
        // PO 2026-09-06 定：收货人与电话**各占一行并放大**——这两项是骑手在袋子堆里认单、
        // 联系顾客时唯一要看的东西，挤在一行小字里最容易看错。
        // ⚠️ 放大后一个汉字占 4 列，32 列只能放 8 个汉字，所以标签用空格不用「：」：
        //    `电话：139****0042` 放大后是 34 列会折行，`电话 139****0042` 正好 32 列。
        `<B>收货人 ${esc(o.receiverName)}</B>`,
        `<B>电话 ${maskPhone(esc(o.receiverPhone))}</B>`,
        // 同城单省市恒为门店所在地，对厨房是纯噪音；58mm 只有 32 列，
        // 砍掉这 6 个字等于多出小半行给楼栋门牌。区不能省——配送范围可能跨区。
        `地址：${esc([o.receiverPoiName, localShortAddress(o)].filter(Boolean).join(' '))}`,
        ...(o.distanceM !== null && o.distanceM !== undefined ? [`距离：${distanceText(o.distanceM)}`] : []),
        ...(o.estimatedDeliveryAt ? [`预计送达：${fmtDateTime(o.estimatedDeliveryAt)}`] : []),
      ]
    : [
        `<B>收件人 ${esc(o.receiverName)}</B>`,
        `<B>电话 ${maskPhone(esc(o.receiverPhone))}</B>`,
        `地址：${esc(o.receiverFullAddress)}`,
      ]

  // 备注要突出：<CB> 居中放大加粗。规格 §8b 提到的「餐具标记」目前 Order 无对应字段
  // （精细餐具选项是 §12 明确的二期项），先不渲染，等那个字段落地后在这里补一行。
  // remark 是顾客自填的自由文本，必须先 esc 再拼进票面——不然顾客填一个 <CUT> 就能在商品明细
  // 之前提前切纸（金额/明细落到下一段），填 <QR> 之类飞鹅不认识的标签会让内容校验失败、
  // 整单一张纸都不出（H2）。上限 20 字由接口与小程序共同约束（PO 2026-09-06 定，见 orders.ts）。
  const remarkBlock: string[] = o.remark ? [`<CB>备注：${esc(o.remark)}</CB>`] : []

  const footer: string[] = [
    `合计：${yuan(o.totalAmount)}`,
    `运费：${yuan(o.shippingFee)}`,
    `<B>实付：${yuan(o.actualAmount)}</B>`,
    `单号：${o.orderNo}`,
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
      `<CB>#${o.orderNo.slice(-4)}</CB>`,
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
  let kitchen: string[] | null = isLocal ? buildKitchen(0, null) : null

  if (totalBytes(itemLines, kitchen) > TICKET_BYTE_LIMIT) {
    // ①②③ 先降级厨房联（PO：保全配送联）
    if (isLocal) {
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
        if (isLocal) kitchen = buildKitchen(1, 0)
      }
    }
  }

  return deliveryOf(itemLines) + (kitchen ? assemble(kitchen) : '')
}

/** 未接单重复播报的精简「催接单」小票（D7；repeat.reprint=false 时用这个，而不是整张全票）。
 *  announceNo 是这一单第几次被催（M12：不是当日流水号，命名与文案上都要跟"今日第N单"分开，
 *  不然店员会把催单次数误读成流水号）。 */
export function renderReminderTicket(input: { orderNo: string; channel: TicketChannel; waitedMin: number; announceNo: number }): string {
  const lines = [
    '<CB>催接单</CB>',
    `${input.channel === 'LOCAL' ? '同城' : '邮寄'}订单：${input.orderNo}`,
    `<B>已等待 ${input.waitedMin} 分钟未接单（第 ${input.announceNo} 次催单）</B>`,
    '请到工作台接单',
  ]
  return assemble(lines)
}

/** 取消/退款提醒票 */
export function renderCancelTicket(input: { orderNo: string; channel: TicketChannel; reason: string; at: Date }): string {
  const lines = [
    '<CB>订单取消</CB>',
    `${input.channel === 'LOCAL' ? '同城' : '邮寄'}订单：${input.orderNo}`,
    `时间：${fmtDateTime(input.at)}`,
    `<BOLD>原因：${input.reason}</BOLD>`,
  ]
  return assemble(lines)
}

/** 顾客申请取消（H6）：订单状态未变，只是店员还没确认，票面必须跟真正的「取消」区分开，
 *  厨房看到这张要暂停制作，等结果，不是当场停工。 */
export function renderCancelRequestTicket(input: { orderNo: string; channel: TicketChannel; at: Date }): string {
  const lines = [
    '<CB>顾客申请取消</CB>',
    `${input.channel === 'LOCAL' ? '同城' : '邮寄'}订单：${input.orderNo}`,
    `时间：${fmtDateTime(input.at)}`,
    '<BOLD>待店员确认，请暂停制作</BOLD>',
  ]
  return assemble(lines)
}

/** 取消申请被店员驳回（H6）：顾客还是要这一单，厨房该继续做 */
export function renderResumeTicket(input: { orderNo: string; channel: TicketChannel; at: Date }): string {
  const lines = [
    '<CB>取消申请已驳回</CB>',
    `${input.channel === 'LOCAL' ? '同城' : '邮寄'}订单：${input.orderNo}`,
    `时间：${fmtDateTime(input.at)}`,
    '<BOLD>请继续制作</BOLD>',
  ]
  return assemble(lines)
}

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
