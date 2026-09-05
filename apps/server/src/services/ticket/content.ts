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
  /** 当日流水号（调用方按需计算传入，缺省不打印这一行） */
  seq?: number | null
  /** REPEAT（未接单重复播报）第几次催单——只在打整张全票时（repeat.reprint=true）跟 seq 并排打印，
   *  避免跟当日流水号混成一件事（M12：旧实现把播报次数当当日流水打，店员会读错） */
  announceNo?: number | null
}

const TICKET_BYTE_LIMIT = 5000
const LINE_WIDTH = 32

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
// 飞鹅票面用 <TAG> 做控制指令（<CUT> 切纸、<CB>/<B> 加粗、<BR> 换行等，见 assemble()），顾客能自填的
// 字段一旦原样带过 `<` `>`，就能在商品明细之前插入一次 <CUT>（金额/明细被切到下一段，极易被漏看）、
// 或塞进飞鹅内容校验不认识的标签把整单送不出去。直接剥字符而不是转义/替换成全角——票面本就没有
// 反向解析的需求，剥比转义更简单也更不容易被绕过（转义字符本身还是可能被拼接出新的 `<`/`>`）。
const esc = (s: string) => s.replace(/[<>]/g, '')

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

function formatItemLine(item: TicketItemInput, width = LINE_WIDTH): string {
  const qtyAmt = ` x${item.quantity} ${yuan(item.subtotal)}`
  const qtyAmtWidth = strWidth(qtyAmt)
  const nameWidth = Math.max(2, width - qtyAmtWidth)
  const spec = item.specText ? `(${esc(item.specText)})` : ''
  const name = truncWidth(esc(item.productName) + spec, nameWidth)
  return padRightWidth(name, nameWidth) + qtyAmt
}

function distanceText(m: number | null | undefined): string {
  if (m === null || m === undefined) return ''
  return m >= 1000 ? `${(m / 1000).toFixed(1)}公里` : `${m}米`
}

/** 组装含 `<BR>` 换行标签的整票内容；lines 里每一项已是一「行」（不含 `<BR>`） */
function assemble(lines: string[]): string {
  return lines.filter((l) => l !== undefined && l !== null).join('<BR>') + '<BR><CUT>'
}

/**
 * 渲染完整订单小票（NEW_ORDER / REPRINT / repeat.reprint=true 时的 REPEAT 均用这个）。
 * 超过 5000 字节时优雅截断：保留头部（标题/序号/订单信息/收货信息/备注）与尾部（合计/提示语）不动，
 * 只压缩中段的商品明细，用「…等 N 件」占位，直到整票能放进限制里。
 */
export function renderOrderTicket(o: TicketOrderInput): string {
  const isLocal = o.channel === 'LOCAL'
  const header: string[] = [
    `<CB>${isLocal ? '同城配送' : '全国邮寄'}</CB>`,
    ...(o.seq !== null && o.seq !== undefined ? [`<C>今日第 ${o.seq} 单</C>`] : []),
    ...(o.announceNo !== null && o.announceNo !== undefined ? [`<C>第 ${o.announceNo} 次催单</C>`] : []),
    `订单号：${o.orderNo}`,
    `下单：${fmtDateTime(o.createdAt)}`,
    `付款：${fmtDateTime(o.paidAt)}`,
  ]

  const receiverBlock: string[] = isLocal
    ? [
        `收货人：${esc(o.receiverName)}　电话：${esc(o.receiverPhone)}`,
        // 同城单省市恒为门店所在地，对厨房是纯噪音；58mm 只有 32 列，
        // 砍掉这 6 个字等于多出小半行给楼栋门牌。区不能省——配送范围可能跨区。
        `地址：${esc([o.receiverPoiName, localShortAddress(o)].filter(Boolean).join(' '))}`,
        ...(o.distanceM !== null && o.distanceM !== undefined ? [`距离：${distanceText(o.distanceM)}`] : []),
        ...(o.estimatedDeliveryAt ? [`预计送达：${fmtDateTime(o.estimatedDeliveryAt)}`] : []),
      ]
    : [
        `收件人：${esc(o.receiverName)}　电话：${esc(o.receiverPhone)}`,
        `地址：${esc(o.receiverFullAddress)}`,
      ]
  // 备注要突出：<CB> 居中放大加粗。规格 §8b 提到的「餐具标记」目前 Order 无对应字段
  // （精细餐具选项是 §12 明确的二期项），先不渲染，等那个字段落地后在这里补一行。
  // remark 是顾客自填的自由文本（上限 255 字符），必须先 esc 再拼进票面——不然顾客填一个
  // <CUT> 就能在商品明细之前提前切纸（金额/明细落到第二段），填 <QR> 之类飞鹅不认识的标签
  // 会让内容校验失败、整单一张纸都不出（H2）。
  const remarkBlock: string[] = o.remark ? [`<CB>备注：${esc(o.remark)}</CB>`] : []

  const footer: string[] = [
    `合计：${yuan(o.totalAmount)}`,
    `运费：${yuan(o.shippingFee)}`,
    `<B>实付：${yuan(o.actualAmount)}</B>`,
    '接单请在工作台操作',
  ]

  const buildItemLines = (items: TicketItemInput[], omitted: number): string[] => {
    const lines = items.map((it) => formatItemLine(it))
    if (omitted > 0) lines.push(`……等 ${omitted} 件`)
    return lines
  }

  const fixed = [...header, ...receiverBlock, ...remarkBlock, ...footer]
  const fits = (itemLines: string[]) => Buffer.byteLength(assemble([...header, ...receiverBlock, ...remarkBlock, ...itemLines, ...footer]), 'utf8') <= TICKET_BYTE_LIMIT

  let itemLines = buildItemLines(o.items, 0)
  if (!fits(itemLines)) {
    // 商品明细本身就超限：逐步减少展示件数，直到（含占位行）能放进去
    let keep = o.items.length
    while (keep > 0) {
      keep--
      const candidate = buildItemLines(o.items.slice(0, keep), o.items.length - keep)
      if (fits(candidate)) { itemLines = candidate; break }
      itemLines = candidate
    }
    if (keep === 0 && !fits(itemLines)) {
      // 极端情况：连头尾固定段加一行占位都放不下（备注超长等）。最后手段是把备注截短，
      // 不牺牲订单号/收货信息这类不可省略的关键信息。
      const fixedBytes = Buffer.byteLength(assemble(fixed), 'utf8')
      const over = fixedBytes - TICKET_BYTE_LIMIT
      if (over > 0 && o.remark) {
        const shrink = Math.max(0, o.remark.length - Math.ceil(over / 2))
        remarkBlock[0] = `<CB>备注：${truncWidth(esc(o.remark), shrink)}…</CB>`
      }
    }
  }

  return assemble([...header, ...receiverBlock, ...remarkBlock, ...itemLines, ...footer])
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
