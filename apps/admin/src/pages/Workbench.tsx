/**
 * 接单工作台：店员默认落地页。界面规格 docs/design/workbench-ui-spec.md 为唯一依据。
 *
 * 三条最容易做坏的规矩，改这个文件前先读懂：
 * 1) 列内顺序由服务端排好（同城恒排邮寄之上，不比等待时长）——前端只按数组顺序渲染，绝不再排一次。
 * 2) 渠道靠三重编码识别：色条 + 徽章 + 字段差异，缺一不可（余光扫过、灯光偏色、色觉障碍都会认错颜色）。
 * 3) 确认框分级：打给骑手/看进度/查物流不弹。确认框的效力来自稀缺——都弹就等于都不弹。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Bike, CircleAlert, CircleQuestionMark, Copy, Ellipsis, LogOut, Maximize, Moon, Package, Phone, Printer, Sun, X } from 'lucide-react'
import './Workbench.css'
import type {
  Channel, CourierLive, DeliveryEventInfo, DeliveryInfo, LocalDeliverySettings, Order, OrderItem,
  QuoteSnapshot, RejectReason, WorkbenchCard, WorkbenchSnapshot,
} from '../types'
import {
  acceptAndCallLocalOrder, acceptLocalOrder, acceptOrder, addDeliveryTip, callRider, cancelDelivery,
  getLocalSettings, getOrder, getOrderDelivery, getWorkbenchSnapshot, markOrderDelivered, precancelDelivery,
  rejectOrder, reprintOrder, resetKd100Circuit, selfDeliverOrder, shipOrder, voidUnknownDelivery,
  refreshOrderQuote, getCourierLive,
} from '../api/admin'
import StatusBadge from '../components/ui/StatusBadge'
import { toast } from '../components/ui/Toast'
import CancelAndRefundModal from '../components/CancelAndRefundModal'
import { usePendingOrders, requestNotifyPermission } from '../hooks/usePendingOrders'
import { useIsPhone } from '../hooks/useIsPhone'
import { fmtHHmm, fmtMonthDayTime, fmtMonthDayCn } from '../utils/time'
import { providerLabel, callStrategyLabel } from '../utils/providers'

type ColKey = keyof WorkbenchSnapshot['columns']

const COLUMNS: { key: ColKey; title: string }[] = [
  { key: 'pending', title: '待接单' }, { key: 'preparing', title: '备餐中' },
  { key: 'waitingCourier', title: '等待配送员' }, { key: 'delivering', title: '配送中' },
  { key: 'done', title: '已完成' },
]

// useIsPhone 已抽到 hooks/useIsPhone.ts（经营概览页共用）。
// ⚠ 其中的 PHONE_QUERY 必须与 Workbench.css 的 `@media (max-width:700px)` 逐字一致——
// 两边对不上会出现「手机 DOM 套桌面样式」，比两端都不改更糟。
// 700 这条线是为了把 iPad 排除在外（iPad mini 竖屏 744、iPad 竖屏 768/810/834）。

/** 顶栏营业状态：桌面顶栏与手机顶栏共用，措辞只此一处 */
function openStateOf(snap: WorkbenchSnapshot | null): { text: string; cls: string } {
  if (!snap) return { text: '加载中', cls: '' }
  if (snap.paused) return { text: `已暂停：${snap.paused.reason || '手动暂停'}`, cls: 'wb__dot--danger' }
  if (!snap.localEnabled) return { text: '同城已关闭', cls: '' }
  return snap.localOpenNow ? { text: '营业中', cls: 'wb__dot--ok' } : { text: '非营业时间', cls: 'wb__dot--warn' }
}

/** 配送单已结束（不再是「在途」）的三个终态 */
const TERMINAL_DELIVERY = ['DELIVERED', 'CANCELLED', 'FAILED']

/** 顶栏打印机状态灯：四态归并口径见服务端 workbench.ts 的 summarizePrinterStatus */
const PRINTER_STATUS_TEXT: Record<WorkbenchSnapshot['printer']['status'], string> = {
  NOT_CONNECTED: '未接入', ONLINE: '正常', ABNORMAL: '异常', OFFLINE: '离线',
}
const PRINTER_DOT_CLS: Record<WorkbenchSnapshot['printer']['status'], string> = {
  NOT_CONNECTED: '', ONLINE: 'wb__dot--ok', ABNORMAL: 'wb__dot--warn', OFFLINE: 'wb__dot--danger',
}
const EXPRESS_COMPANIES = ['顺丰速运', '京东物流', '中通快递', '圆通速递', '韵达快递', '申通快递', '极兔速递', '邮政 EMS', '德邦快递']
/** 服务端 QUOTE_FRESH_MS 的兜底值（quote.ts:36），仅在旧版接口没下发 quoteFreshMs 时使用 */
const DEFAULT_QUOTE_FRESH_MS = 5 * 60 * 1000
/**
 * 按当前时间对 quotedAt 实时判定新鲜度，不读服务端一次性算好又被前端冻住的 stale 布尔。
 *
 * skewMs（服务端时间 - 本机时间，见 Workbench 组件的 skewRef）默认 0，但呼叫弹窗必须传真值——
 * 店里的平板时钟经常偏几分钟，纯用 Date.now() 比服务端 quotedAt 会在平板慢表时把已经过期
 * 的报价误判成新鲜（平板慢 3 分钟时，7 分钟前的报价算出来只有 4 分钟，蹭进 5 分钟阈值内）。
 */
const isQuoteStaleNow = (quotedAt: string | null | undefined, freshMs: number, skewMs = 0) =>
  !quotedAt || (Date.now() + skewMs) - Date.parse(quotedAt) > freshMs
/**
 * 小费步进器（规格 §6）：**步长 ¥1、默认 ¥1、下限 ¥1**，上限取「单次上限」与「本单剩余额度」的小者。
 *
 * 默认值 2026-09-07 由店主从规格里的 ¥3 再压到 ¥1：从下限起步，加多少全是店员按着
 * 当时的情况一次次点出来的，系统一分钱都不替他先垫。规格那条「不想用系统默认值把店员
 * 锚定在高位」的理由，压到 ¥1 是它的极端形式。
 *
 * 原来这里是四个固定档 `[200, 500, 1000, 2000]`，从第一版起就是，规格那条一直没落地
 * （2026-09-07 店主发现）。两处代价：
 *   · ¥1/¥3/¥4/¥6… 全点不出来，而规格要的正是「金额由店员定，不写死」；
 *   · 默认落在 ¥5，而规格白纸黑字写「默认取 ¥3 而非 ¥5，是不想用系统默认值把店员
 *     锚定在高位」——固定档把要避免的那件事正好做成了。
 * 服务端 `tipSchema` 收任意 ≥1 分的整数、上限交给 tip.maxPerCall/maxPerOrder 校验，
 * 所以 ¥1 步长不需要任何服务端改动。
 */
const TIP_STEP = 100
const TIP_MIN = 100
const TIP_DEFAULT = 100
const OTHER_COMPANY = '__other__'

const yuan = (fen: number) => (fen / 100).toFixed(2)
/**
 * 「还剩多久自动回绝退菜」。接单 + acceptGraceMin 分钟到点，服务端会自动回绝并放行呼叫。
 *
 * 倒计时**走本地秒表**（每秒重渲染），不依赖 10 秒轮询；`now` 已用服务端时间校准过时钟偏差
 * （见 skewRef），所以店员那台电脑时间不准也不会算歪。
 *
 * 归零之后**不显示 0:00 也不留空**：真正的回绝由调度器执行，60 秒一跳，再加一次快照轮询，
 * 最坏要等约 70 秒才翻成「已回绝」。这段空窗里若什么都不写，店员会以为倒计时卡死了；
 * 写死「0:00」同样像卡住。所以归零后改说「即将自动回绝」——它描述的是真实状态。
 */
function autoRejectLeft(acceptedAt: string | null | undefined, graceMin: number, now: number): string | null {
  if (!acceptedAt || !graceMin) return null
  const deadline = new Date(acceptedAt).getTime() + graceMin * 60_000
  if (!Number.isFinite(deadline)) return null
  const left = Math.floor((deadline - now) / 1000)
  if (left <= 0) return '（即将自动回绝）'
  return `（约 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后自动回绝）`
}

/**
 * 屏幕上一律只显示后四位（与小票同口径，PO 2026-09-07）。
 * 完整单号在这一屏里没有用处——店员比对的是手上那张小票，而后四位就够区分同时在做的十几单；
 * 整串 ORD+日期+序号 反而把卡片最显眼的一行挤满，读起来还得逐位对。
 * 需要完整单号的场合只有一个（退款/客诉时去微信、快递100后台查），那里留了整串 + 复制按钮。
 */
const shortNo = (no: string | null | undefined) => (no ? `#${no.slice(-4)}` : '--')

/** 米 → 给人读的距离。1 km 以内用米（「800 m」比「0.8 km」好判断要不要等） */
const km = (m: number | null | undefined) =>
  m == null ? '--' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`
const chColor = (c: Channel) => (c === 'LOCAL' ? 'var(--local)' : 'var(--express)')
/** 服务端错误码 42221/42225/42228/42232-42238 的 message 是写给店员看的，不能吞掉换成「操作失败」 */
const apiMessage = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback
const apiCode = (e: unknown) => (e as { response?: { data?: { code?: number } } })?.response?.data?.code

// 时间一律按 Asia/Shanghai 渲染（utils/time.ts）。原来这两个函数用 getHours()/getDate()，
// 那是按**看的人那台电脑**的时区解读——库里存的是 UTC，东七区的电脑上首单 19:59 会显示成 18:59。
const hhmm = fmtHHmm
const dateTime = fmtMonthDayTime

// ─────────────────────────────────────────────────────────
// 卡片紧急度（PO 2026-09-07）
//
// 屏幕上有两套颜色，各管各的，任何时候都不许互相顶替：
//   · **渠道** = 左侧 4px 竖条 + 徽章（同城橘红 / 邮寄蓝）。这两个颜色**永不随状态变化**，
//     所以「卡片变热」永远读不成「换了渠道」。
//   · **紧急度** = 整卡外圈光晕 + 极淡底色。光晕画在卡片轮廓**之外**（box-shadow 扩散），
//     竖条在轮廓**之内**——不同的平面、不同的形状，扫一眼不会看成同一根线。
//
// 紧急度由两把尺子取更严重的那把：
//   ① 列内停留时长——「这张单没人碰」
//   ② 距承诺送达还剩多久——「这张单要迟到了」，顾客感知的是这把
// ─────────────────────────────────────────────────────────
type Urgency = '' | 'warn' | 'late'

/**
 * 每列「正常停留多久」差得很远：付了钱该秒回，而备餐本来就要 20 分钟。
 * 原来五列共用一套 3 分钟 / 6 分钟阈值，于是备餐中的卡片开工六分钟后**全部**变红——
 * 全红等于没有红（§0：红是这一屏最稀缺的信号）。所以阈值按列给，备餐那一档
 * 直接取设置里的备餐时长（高峰自动取高峰值），店主改设置这里跟着走。
 * 邮寄单图例写明「可以稍后处理」，给一套宽得多的阈值：只有真被忘了才亮。
 * 返回 null = 这一列不看停留时长（配送中在路上多久取决于距离，只看承诺送达）。
 */
function dwellBudget(colKey: ColKey, channel: Channel, prepMin: number): [number, number] | null {
  if (channel === 'EXPRESS') return [60, 240]
  switch (colKey) {
    case 'pending': return [2, 5]
    case 'preparing': return [prepMin, prepMin + 8]
    case 'waitingCourier': return [6, 12]
    default: return null
  }
}
/** 距承诺送达还剩这么多分钟就开始烧（第二把尺子）。已经过点一律算超时。 */
const DEADLINE_WARN_MIN = 15
const DEADLINE_LATE_MIN = 5

/** 当下该用哪个备餐时长：高峰取上界。窗口比较用 Asia/Shanghai 的 'HH:mm' 字符串——
 *  零填充过的时刻串可以直接比大小，也就不用在前端再引一套时区换算。 */
function prepMinutesNow(s: LocalDeliverySettings | null, now: number): number {
  if (!s) return 20
  const cur = fmtHHmm(now, '')
  const peak = !!cur && s.peak.windows.some((w) => cur >= w.start && cur < w.end)
  return peak ? s.peak.prepMaxMinutes : s.prepMinutes
}

/** 「已完成」列永不参与：给已经做完的事上色只会稀释红色（I7）。 */
function urgencyOf(card: WorkbenchCard, colKey: ColKey, now: number, prepMin: number): Urgency {
  if (colKey === 'done') return ''
  let u: Urgency = ''
  const budget = dwellBudget(colKey, card.channel, prepMin)
  if (budget) {
    const min = (now - Date.parse(card.waitSince)) / 60_000
    if (min >= budget[1]) u = 'late'
    else if (min >= budget[0]) u = 'warn'
  }
  const est = card.local?.estimatedDeliveryAt
  if (est) {
    const left = (Date.parse(est) - now) / 60_000
    if (left <= DEADLINE_LATE_MIN) u = 'late'
    else if (left <= DEADLINE_WARN_MIN && u !== 'late') u = 'warn'
  }
  return u
}

/** 等待胶囊：m:ss 等宽数字；>3:00 琥珀、>6:00 红底白字（§4）—— 按秒比较，3:00/6:00 整点不提前变色 */
function waitLabel(sinceIso: string, now: number, urgency: Urgency): { text: string; cls: string } {
  const sec = Math.max(0, Math.floor((now - Date.parse(sinceIso)) / 1000))
  const min = Math.floor(sec / 60)
  const text = `${min}:${String(sec % 60).padStart(2, '0')}`
  return { text, cls: urgency === 'late' ? 'wb__wait--danger' : urgency === 'warn' ? 'wb__wait--warn' : '' }
}

/** ≤2 样列全名；≥3 样给「前两菜名 等 N 样 / M 份」，「等 N 样」用渠道色（§4） */
function itemsSummary(items: WorkbenchCard['items'], channel: Channel): ReactNode {
  if (items.kinds <= 2) return items.first.join(' · ')
  return (
    <>
      {items.first.map((s) => s.replace(/ ×\d+$/, '')).join('、')}
      <span className="wb__kinds" style={{ color: chColor(channel) }}> 等 {items.kinds} 样 / {items.units} 份</span>
    </>
  )
}

function copyText(text: string) {
  navigator.clipboard?.writeText(text).then(() => toast.success('已复制'), () => toast.error('复制失败'))
}

// ─────────────────────────────────────────────────────────
// 自绘弹窗外壳：不用通用 ConfirmDialog，因为规格 §6 要求确认按钮跟随卡片渠道色，
// 且弹窗要活在 .wb 的日夜 token 里（通用 Modal 是固定白底）。
// ─────────────────────────────────────────────────────────
function WbModal({ title, children, footer, error, onClose }: {
  title: string; children: ReactNode; footer: ReactNode
  /** 服务端错误（42221/42225/…系列，写给店员看的）：必须放在 .wb__modal-body 外面，
   *  否则店员点确认后按钮变回原样、屏幕上「什么都没变」——body 是 overflow-y:auto，
   *  内容长的弹窗（拒单）里追加的错误条基本落在折线以下。foot 是 flex:none，恒可见。 */
  error?: string
  onClose: () => void
}) {
  return (
    <div className="wb__modal-mask" role="dialog" aria-modal="true">
      <div className="wb__modal">
        <div className="wb__modal-head">
          <span>{title}</span>
          <button className="wb__iconbtn" onClick={onClose} aria-label="关闭"><X className="w-4 h-4" /></button>
        </div>
        <div className="wb__modal-body">{children}</div>
        {error && <div className="wb__redbar wb__modal-error">{error}</div>}
        <div className="wb__modal-foot">{footer}</div>
      </div>
    </div>
  )
}

/** 弹窗必须写的三件事（§6）：这一步会发生什么 / 顾客会看到什么 / 花多少钱 */
function WhatBlock({ what, customer, cost }: { what: string; customer: string; cost: string }) {
  return (
    <div className="wb__what">
      <div><b>会发生什么：</b>{what}</div>
      <div><b>顾客会看到：</b>{customer}</div>
      <div><b>花多少钱：</b>{cost}</div>
    </div>
  )
}

function FillButton({ channel, onClick, disabled, children }: {
  channel: Channel; onClick: () => void; disabled?: boolean; children: ReactNode
}) {
  return (
    <button className="wb__btn wb__btn--fill" style={{ background: chColor(channel) }} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}

interface ConfirmSpec {
  title: string
  channel: Channel
  what: string
  customer: string
  cost: string
  /** 花钱的操作额外给一块琥珀提示（§6） */
  amber?: string
  /**
   * 确认块与琥珀之间的自定义内容（呼叫弹窗用它放各家报价，见 CallQuoteBlock）。
   * 收一个「当前要呼哪几家」的回调：报价块里点刷新或改选之后，确认键的文案和真正发出去的
   * providers 都必须跟着变——spec 是点击那一刻存进 state 的，不回传就会停在旧值上。
   */
  extra?: (onPick: (p: CallPick | null) => void) => ReactNode
  /** 有实时选择时用它生成确认键文案；没有就退回 confirmText */
  confirmTextOf?: (pick: CallPick) => string
  confirmText: string
  okMsg: string
  /** 呼叫弹窗把当前选择传进来；其它弹窗忽略这个参数即可 */
  run: (pick?: CallPick | null) => Promise<unknown>
}

/**
 * 呼叫弹窗里「这一次要呼谁」。
 * providers 为空 = 不指定，按后台策略走（服务端自己挑最便宜的 N 家）；
 * 非空 = 店员手点过，覆盖策略，服务端记成 MANUAL。
 */
interface CallPick {
  providers: string[]
  quotes: { provider: string; feeFen: number }[]
  manual: boolean
}

/**
 * 呼叫弹窗里的报价块（UI spec §6b）。
 *
 * 自己持有并刷新报价，不从外面接一个快照进来——弹窗的 spec 是点击那一刻存进 state 的，
 * 外层 detail 再刷新也不会传导进来，接快照会得到一个点完刷新还显示旧数字的按钮。
 *
 * batchPrice 免费、不下单、不落库，所以刷新按钮可以随便点。
 */
function CallQuoteBlock({ orderId, initial, mode, cheapestN, freshMs, skewMs, onPick }: {
  orderId: number
  initial: { snapshot: QuoteSnapshot | null; quotedAt: string | null; stale: boolean } | null
  /** 后台设定的呼叫方式，决定「不动手时默认呼谁」 */
  mode: 'SOLO_LOWEST' | 'CHEAPEST_N' | 'ALL'
  cheapestN: number
  /** 服务端定义的新鲜度阈值（quote.ts 的 QUOTE_FRESH_MS），与 quotedAt 一起实时重算 stale */
  freshMs: number
  /**
   * 服务端时间 - 本机时间（Workbench 组件的 skewRef.current）。传常量、不要传每秒变的 now——
   * spec 是点击那一刻建好的快照，传 now 只会把某一秒的偏移值冻进去，毫无意义；
   * 传 skewRef.current 才能让每次渲染都按「服务端此刻的真实时间」校正过期判断。
   */
  skewMs: number
  onPick: (p: CallPick | null) => void
}) {
  const [q, setQ] = useState(initial)
  const [busy, setBusy] = useState(false)
  /** null = 不指定，按后台策略走；非 null = 店员点中的那一家 */
  const [sel, setSel] = useState<string | null>(null)
  // initial.stale 只是「打开抽屉那一刻」服务端算好的快照，弹窗可能被店员晾很久才点确认——
  // 久留期间不会有任何请求把它刷新掉。改成每次渲染都用 quotedAt+freshMs 对着当前时间重算，
  // 并用一个每秒跳一次的 tick 强制重新渲染，这样弹窗开着不动时新鲜度也会自己翻成「已过期」，
  // 而不是停在打开那一刻的判断上把一个其实已经过期的报价/运力承诺给店员。
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [])
  const stale = isQuoteStaleNow(q?.quotedAt, freshMs, skewMs)
  const refresh = async () => {
    setBusy(true)
    try {
      const r = await refreshOrderQuote(orderId)
      setQ({ snapshot: r.data.data.snapshot, quotedAt: r.data.data.quotedAt, stale: false })
    } catch { /* 查价失败不影响呼叫本身：呼叫时服务端还会自己再查一次 */ }
    finally { setBusy(false) }
  }
  const sorted = useMemo(
    () => [...(q?.snapshot?.quotes ?? [])].sort((a, b) => a.feeFen - b.feeFen),
    [q],
  )
  // 不动手时策略会呼谁——高亮的就是这几家，让店员在按下去之前看到系统的选择
  const byStrategy = useMemo(() => {
    if (!sorted.length) return []
    if (mode === 'ALL') return sorted
    if (mode === 'SOLO_LOWEST') return sorted.slice(0, 1)
    return sorted.slice(0, Math.max(1, cheapestN))
  }, [sorted, mode, cheapestN])
  const picked = sel ? sorted.filter((x) => x.provider === sel) : byStrategy
  // 报价过期时不把金额报上去：过期意味着服务端下单前会自己重查一次，那时的价可能不是
  // 眼前这个——此刻在按钮上写死一个数字就是空头承诺。运力选择本身仍然有效（MANUAL 只认家数）。
  useEffect(() => {
    onPick(sorted.length
      ? { providers: sel ? [sel] : [], quotes: stale ? [] : picked, manual: !!sel }
      : null)
    // picked 是每次渲染新建的数组，放进依赖会自激；用它的内容做依赖
  }, [onPick, sel, stale, sorted.length, picked.map((x) => `${x.provider}:${x.feeFen}`).join(',')])

  if (!sorted.length) {
    return (
      <div className="wb__quote">
        <span className="wb__muted">暂无报价（呼叫时会自动查一次）</span>
        <button className="wb__iconbtn" onClick={() => void refresh()} disabled={busy}>{busy ? '查价中…' : '↻ 查价'}</button>
      </div>
    )
  }
  const min = sorted[0].feeFen
  const extraFen = sel ? (sorted.find((x) => x.provider === sel)?.feeFen ?? min) - min : 0
  return (
    <div className={`wb__quote${stale ? ' wb__quote--stale' : ''}`}>
      <div className="wb__quote-head">
        <span>{stale ? '报价已过期' : '选一家呼 · 点行切换，打勾的就是要呼的'}</span>
        <button className="wb__iconbtn" onClick={() => void refresh()} disabled={busy}>{busy ? '查价中…' : '↻ 刷新'}</button>
      </div>
      {/* 报价新鲜度靠时钟偏移校正过，店员没法从「过期/未过期」倒推查价的实际时间——
          直接写出查价时刻（按上海时区，与小票/其他时间戳同口径），比自己心算靠谱 */}
      <div className="wb__muted">查于 {fmtHHmm(q?.quotedAt)}</div>
      {sorted.map((x) => {
        const on = picked.some((p) => p.provider === x.provider)
        return (
          <button
            type="button"
            key={x.provider}
            className={`wb__quote-row${on ? ' wb__quote-row--on' : ''}`}
            aria-pressed={on}
            /* 再点一次选中的那一家 = 取消手选、回到策略默认。没有这条，店员点错了就只能关掉弹窗重来 */
            onClick={() => setSel(sel === x.provider ? null : x.provider)}
          >
            <span>
              <span className="wb__quote-tick">{on ? '✓' : ''}</span>
              {providerLabel(x.provider)}
              {x.feeFen === min && <span className="wb__muted"> 最低</span>}
            </span>
            <span className="wb__fee">¥{yuan(x.feeFen)}</span>
          </button>
        )
      })}
      {sel
        ? (
          <div className={`wb__quote-note${extraFen > 0 ? ' wb__quote-note--warn' : ''}`}>
            只呼 {providerLabel(sel)}
            {extraFen > 0 ? `，比最低价多 ¥${yuan(extraFen)}` : ''}。再点一次可改回默认。
          </div>
        )
        : (
          <div className="wb__quote-note">
            {mode === 'SOLO_LOWEST'
              ? '默认给你选好了最便宜的这家；要更快就点闪送那一行。'
              : `打勾的是按后台设置会呼的 ${picked.length} 家，谁先接算谁的。`}
          </div>
        )}
    </div>
  )
}

function ConfirmModal({ spec, onClose, onDone }: { spec: ConfirmSpec; onClose: () => void; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 报价块回传的「当前要呼谁」（点刷新或改选之后会变）。useCallback 定住引用，
  // 否则每次渲染都是新函数，会把子组件的 useEffect 变成无限循环。
  const [pick, setPick] = useState<CallPick | null>(null)
  const onPick = useCallback((p: CallPick | null) => setPick(p), [])
  const confirmText = pick && spec.confirmTextOf ? spec.confirmTextOf(pick) : spec.confirmText
  const submit = async () => {
    setBusy(true); setError('')
    try { await spec.run(pick); onDone(spec.okMsg) }
    catch (e) { setError(apiMessage(e, '操作失败，请重试')) }
    finally { setBusy(false) }
  }
  return (
    <WbModal
      title={spec.title}
      onClose={onClose}
      error={error}
      footer={
        <>
          <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>再想想</button>
          <FillButton channel={spec.channel} onClick={submit} disabled={busy}>
            {busy ? '处理中…' : confirmText}
          </FillButton>
        </>
      }
    >
      <WhatBlock what={spec.what} customer={spec.customer} cost={spec.cost} />
      {spec.extra?.(onPick)}
      {spec.amber && <div className="wb__amber">{spec.amber}</div>}
    </WbModal>
  )
}

/** 取消配送 / 取消呼叫：先问运力方取消费，把钱写进确认文案再让人点（§6） */
function CancelDeliveryModal({ orderId, channel, title, onClose, onDone }: {
  orderId: number; channel: Channel; title: string; onClose: () => void; onDone: (msg: string) => void
}) {
  const [fee, setFee] = useState<number | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    precancelDelivery(orderId).then(
      (r) => { if (alive) setFee(r.data.data.cancelFeeFen) },
      () => { if (alive) setFee(null) }
    )
    return () => { alive = false }
  }, [orderId])
  const submit = async () => {
    setBusy(true); setError('')
    try { await cancelDelivery(orderId, '商家取消'); onDone('已取消配送') }
    catch (e) {
      setError(apiCode(e) === 42238 ? '运力方响应超时，请稍后重试（配送单状态未变化）' : apiMessage(e, '取消失败，请重试'))
    } finally { setBusy(false) }
  }
  const costText = fee === undefined ? '正在向运力方预估取消费…'
    : fee === null ? '取消费未知——骑手已接单的单通常会产生几元取消费，由门店承担。'
      : fee > 0 ? `本次取消费约 ¥${yuan(fee)}，由门店承担。` : '本次取消不产生取消费。'
  return (
    <WbModal
      title={title}
      onClose={onClose}
      error={error}
      footer={
        <>
          <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>再想想</button>
          <FillButton channel={channel} onClick={submit} disabled={busy || fee === undefined}>
            {busy ? '处理中…' : '确认取消配送'}
          </FillButton>
        </>
      }
    >
      <WhatBlock
        what="向运力方取消这张配送单，骑手不再来取货；订单退回「备餐中」，你可以重新呼叫或改自己送。"
        customer="顾客看到配送已取消，订单仍在备餐中。"
        cost={costText}
      />
      {fee !== 0 && <div className="wb__amber">{costText}</div>}
    </WbModal>
  )
}

/** 加小费：额度必须写清楚（§6） */
function TipModal({ orderId, tippedFen, limits, onClose, onDone }: {
  orderId: number; tippedFen: number; limits: LocalDeliverySettings['tip'] | null
  onClose: () => void; onDone: (msg: string) => void
}) {
  const maxPerCall = limits?.maxPerCall ?? 2000
  const maxPerOrder = limits?.maxPerOrder ?? 5000
  const remain = Math.max(0, maxPerOrder - tippedFen)
  const lo = TIP_MIN
  // 上限同时受「单次上限」和「本单还剩多少额度」约束——只看单次上限的话，
  // 累计快满时步进器还能加到 ¥20，点确认才被服务端打回来
  const hi = Math.min(maxPerCall, remain)
  const canTip = hi >= lo
  const [amount, setAmount] = useState(() => Math.min(Math.max(TIP_DEFAULT, lo), Math.max(hi, lo)))
  const bump = (d: number) => setAmount((a) => Math.min(hi, Math.max(lo, a + d)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    setBusy(true); setError('')
    try { await addDeliveryTip(orderId, amount); onDone(`已加小费 ¥${yuan(amount)}`) }
    catch (e) { setError(apiMessage(e, '加小费失败，请刷新后核对再重试')) }
    finally { setBusy(false) }
  }
  return (
    <WbModal
      title="加小费"
      onClose={onClose}
      error={error}
      footer={
        <>
          <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>再想想</button>
          <FillButton channel="LOCAL" onClick={submit} disabled={busy || !canTip}>
            {busy ? '处理中…' : `确认加 ¥${yuan(amount)}`}
          </FillButton>
        </>
      }
    >
      <WhatBlock
        what="给这张配送单加价，提高骑手接单意愿；配送单仍停在「待抢单」，加完继续等。"
        customer="顾客看不到小费，页面上仍是「正在为您呼叫骑手」。"
        cost={`本次 ¥${yuan(amount)}，由门店承担。`}
      />
      {/* 加减步进器，不是固定档：规格 §6「小费金额由店员定，不写死」。
          到边界置灰而不是隐藏——按钮位置不变，店员不用重新找。 */}
      <div className="wb__stepper">
        <button type="button" className="wb__step-btn" aria-label="减 1 元"
          onClick={() => bump(-TIP_STEP)} disabled={busy || !canTip || amount <= lo}>−</button>
        <div className="wb__step-val" aria-live="polite">¥{yuan(amount)}</div>
        <button type="button" className="wb__step-btn" aria-label="加 1 元"
          onClick={() => bump(TIP_STEP)} disabled={busy || !canTip || amount >= hi}>+</button>
      </div>
      {/* 规格 §6 要求「旁边给区间参考」。没有参考值，步进器就只是让店员在真空里猜数字——
          固定档时代至少还暗示了「常见档位」，改成自由步进后这句话反而更不能少。
          规格另有一档「骑手已接单」的参考语，但那一档现在**走不到**：加小费按钮只在
          待抢单（CALLING）时出现，服务端 addTip 也只放行 CALLING。要么把按钮开放到
          已接单，要么把规格那一行退掉——这是产品决定，先不在这里替它做主。 */}
      <div className="wb__amber">
        高峰期通常 ¥3–5 就有人接；偏远或恶劣天气可能要更多。
        单次上限 ¥{(maxPerCall / 100).toFixed(0)}，本单已加 ¥{yuan(tippedFen)}，累计上限 ¥{(maxPerOrder / 100).toFixed(0)}。
      </div>
      {remain <= 0 && <div className="wb__redbar">本单小费已到累计上限，无法再加。</div>}
      {/* 剩余额度不足 ¥1 时步进器一格也走不了，说清楚为什么，别让店员对着置灰的键猜 */}
      {remain > 0 && !canTip && (
        <div className="wb__redbar">本单小费剩余额度不足 ¥{(TIP_MIN / 100).toFixed(0)}，无法再加。</div>
      )}
    </WbModal>
  )
}

/** 填单号发货（邮寄） */
function ShipModal({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: (msg: string) => void }) {
  const [company, setCompany] = useState('')
  const [otherCompany, setOtherCompany] = useState('')
  const [expressNo, setExpressNo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const finalCompany = company === OTHER_COMPANY ? otherCompany.trim() : company
  const submit = async () => {
    if (!finalCompany) { setError(company === OTHER_COMPANY ? '请填写快递公司名称' : '请选择快递公司'); return }
    if (!expressNo.trim()) { setError('请填写快递单号'); return }
    setBusy(true); setError('')
    try { await shipOrder(order.id, { expressCompany: finalCompany, expressNo: expressNo.trim() }); onDone('已发货') }
    catch (e) { setError(apiMessage(e, '发货失败，请重试')) }
    finally { setBusy(false) }
  }
  return (
    <WbModal
      title="填单号发货"
      onClose={onClose}
      error={error}
      footer={
        <>
          <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>再想想</button>
          <FillButton channel="EXPRESS" onClick={submit} disabled={busy}>{busy ? '处理中…' : '确认发货'}</FillButton>
        </>
      }
    >
      <WhatBlock
        what="订单转「已发货」，运单号写入订单，顾客可以查物流。"
        customer="顾客收到发货通知，能看到快递公司与运单号。"
        cost="不产生额外费用（运费已在下单时结算）。"
      />
      <select className="wb__select" value={company} onChange={(e) => setCompany(e.target.value)}>
        <option value="">选择快递公司</option>
        {EXPRESS_COMPANIES.map((c) => <option key={c} value={c}>{c}</option>)}
        <option value={OTHER_COMPANY}>其他（手填）</option>
      </select>
      {company === OTHER_COMPANY && (
        <input className="wb__input" placeholder="快递公司名称" value={otherCompany} onChange={(e) => setOtherCompany(e.target.value)} />
      )}
      <input className="wb__input" placeholder="快递单号" value={expressNo} onChange={(e) => setExpressNo(e.target.value)} />
    </WbModal>
  )
}

/** 自己送（同城）：建一张 SELF 配送单，订单直接转配送中 */
function SelfDeliverModal({ orderId, defaultPhone, onClose, onDone }: {
  orderId: number; defaultPhone: string; onClose: () => void; onDone: (msg: string) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState(defaultPhone)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!name.trim()) { setError('请填写送货人姓名'); return }
    if (!phone.trim()) { setError('请填写送货人电话'); return }
    setBusy(true); setError('')
    try { await selfDeliverOrder(orderId, { name: name.trim(), phone: phone.trim() }); onDone('已改为自己送') }
    catch (e) { setError(apiMessage(e, '操作失败，请重试')) }
    finally { setBusy(false) }
  }
  return (
    <WbModal
      title="自己送"
      onClose={onClose}
      error={error}
      footer={
        <>
          <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>再想想</button>
          <FillButton channel="LOCAL" onClick={submit} disabled={busy}>{busy ? '处理中…' : '确认自己送'}</FillButton>
        </>
      }
    >
      <WhatBlock
        what="记为店内自送，订单立即转「配送中」，不再呼叫骑手；送到后回来点「标记已送达」。"
        customer="顾客看到「商家配送中」，以及这里填的送货人姓名与电话。"
        cost="不产生运力费用。"
      />
      <input className="wb__input" placeholder="送货人姓名" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="wb__input" placeholder="送货人电话" value={phone} onChange={(e) => setPhone(e.target.value)} />
    </WbModal>
  )
}

const REJECT_REASONS: { value: RejectReason; label: string }[] = [
  { value: 'SOLD_OUT', label: '菜品售罄' },
  { value: 'OUT_OF_RANGE', label: '超出配送范围' },
  { value: 'PAST_ACCEPT_TIME', label: '已过接单时间' },
  { value: 'CUSTOMER_CANCEL', label: '顾客电话要求取消' },
  { value: 'OTHER', label: '其他原因' },
]

/** 拒单（§7）：必须选原因；售罄联动下架；其他原因强制说明 ≤40 字；红条写明退款金额 */
function RejectModal({ order, channel, onClose, onDone }: {
  order: Order; channel: Channel; onClose: () => void; onDone: (msg: string) => void
}) {
  const [reason, setReason] = useState<RejectReason | null>(null)
  const [note, setNote] = useState('')
  const [soldOut, setSoldOut] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 同一个商品可能在订单里出现多行（不同规格），下架按商品去重
  const products = useMemo(() => {
    const map = new Map<number, string>()
    for (const it of order.items as OrderItem[]) {
      if (typeof it.productId === 'number') map.set(it.productId, it.productName)
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [order.items])
  const deletedItems = (order.items as OrderItem[]).filter((it) => typeof it.productId !== 'number')
  const refundFen = order.remainingRefundable
  const blocked = !reason
    || (reason === 'OTHER' && !note.trim())
    || (reason === 'SOLD_OUT' && soldOut.length === 0)

  const submit = async () => {
    if (!reason || blocked) return
    setBusy(true); setError('')
    try {
      // note 只在「其他原因」发送——服务端会把它原样拼进 cancelReason 给顾客看，
      // 换成别的原因后如果还带着上一次没清空的说明，顾客会看到文不对题的话（§I4）
      const res = await rejectOrder(order.id, {
        reason,
        note: reason === 'OTHER' ? note.trim() : undefined,
        soldOutProductIds: reason === 'SOLD_OUT' ? soldOut : undefined,
      })
      if (reason === 'SOLD_OUT' && soldOut.length > 0) {
        // 服务端联动下架失败不回滚（退款已成既成事实），只告警——店员是唯一能补救的人，
        // 固定文案「已拒单并发起退款」会把失败说成成功，必须按真实 offShelfCount 回执（§I5）
        const off = res.data.data.offShelfCount
        if (off >= soldOut.length) {
          onDone(`已拒单并发起退款，已下架 ${off} 个菜品`)
        } else {
          toast.error(off > 0
            ? `菜品下架 ${off}/${soldOut.length} 个成功，其余请手动下架`
            : '菜品下架失败，请手动下架')
          onDone('已拒单并发起退款')
        }
      } else {
        onDone('已拒单并发起退款')
      }
    } catch (e) {
      setError(apiCode(e) === 42221
        ? `${apiMessage(e, '该订单有在途配送单')}——请先在「等待配送员」里取消配送，再回来拒单。`
        : apiMessage(e, '拒单失败，请重试'))
    } finally { setBusy(false) }
  }

  return (
    <WbModal
      title="拒单"
      onClose={onClose}
      error={error}
      footer={
        <>
          <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>再想想</button>
          <FillButton channel={channel} onClick={submit} disabled={busy || blocked}>
            {busy ? '处理中…' : '确认拒单'}
          </FillButton>
        </>
      }
    >
      <WhatBlock
        what="订单直接终止并全额退款，不能撤回。"
        customer={'顾客会原样看到你选的这条原因' + (reason === 'OTHER' ? '，以及你填的说明。' : '。')}
        cost={`退回顾客 ¥${yuan(refundFen)}，门店这单不产生收入。`}
      />
      <div className="wb__block-t">拒单原因（顾客原样可见，必选）</div>
      {REJECT_REASONS.map((r) => (
        <label key={r.value} className={`wb__opt ${reason === r.value ? 'wb__opt--on' : ''}`}>
          <input type="radio" name="wb-reject" checked={reason === r.value} onChange={() => setReason(r.value)} />
          <span>{r.label}</span>
        </label>
      ))}

      {reason === 'SOLD_OUT' && (
        <div className="wb__soldout">
          <div className="wb__block-t">
            勾选售罄的菜，确认后自动下架——不下架的话下一位顾客照样点得到，同样的单会再来一遍。
          </div>
          {products.map((p) => (
            <label key={p.id} className="wb__line" style={{ cursor: 'pointer' }}>
              <span style={{ color: 'inherit' }}>
                <input
                  type="checkbox"
                  checked={soldOut.includes(p.id)}
                  onChange={(e) => setSoldOut((s) => (e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id)))}
                />{' '}
                {p.name}
              </span>
            </label>
          ))}
          {deletedItems.length > 0 && (
            <div className="wb__block-t">{deletedItems.length} 个商品已从商品库删除，无法自动下架。</div>
          )}
          {products.length === 0 && <div className="wb__redbar">本单商品都已从商品库删除，请改选其他原因。</div>}
        </div>
      )}

      {reason === 'OTHER' && (
        <>
          <textarea
            className="wb__textarea" rows={2} maxLength={40} value={note}
            placeholder="写一句给顾客看的说明（必填，最多 40 字）"
            onChange={(e) => setNote(e.target.value.slice(0, 40))}
          />
          <div className="wb__count">{note.length}/40</div>
        </>
      )}

      <div className="wb__redbar">
        确认后全额退款 ¥{yuan(refundFen)} 原路退回，顾客会收到退款通知。此操作不可撤销。
      </div>
    </WbModal>
  )
}

// ─────────────────────────────────────────────────────────
// 卡片（§3/§4）：三重编码 = 4px 色条 + 徽章（图标+文字）+ 渠道各自的字段
// ─────────────────────────────────────────────────────────
/** 图例内容。桌面常驻在看板上方，手机收进「?」说明层——两处共用，避免文案漂移 */
function LegendContent() {
  return (
    <>
      <span className="wb__legend-g">
        <span className="wb__badge wb__badge--local"><Bike className="w-3.5 h-3.5" />同城配送</span>
        <span>骑手送，恒排在邮寄单上面</span>
        <span className="wb__badge wb__badge--express"><Package className="w-3.5 h-3.5" />全国邮寄</span>
        <span>可以稍后处理</span>
      </span>
      <span className="wb__legend-sep" />
      <span className="wb__legend-g">
        <span className="wb__chip">正常</span>
        <span className="wb__chip wb__chip--warn">该催了</span>
        <span className="wb__chip wb__chip--late">要延误</span>
        <span>整圈发光 = 急，左边那条竖色条只说渠道、不会变色</span>
      </span>
    </>
  )
}

/** 唯一写明「多久算久」的地方。桌面在看板下方，手机收进「?」说明层 */
function HintContent({ prepMin }: { prepMin: number }) {
  return (
    <>
      等待时长从进入本列时算起，每列的「正常」不一样：待接单 2/5 分钟，备餐中 {prepMin}/{prepMin + 8} 分钟，
      等待配送员 6/12 分钟；配送中不看等待时长，只看离预计送达还剩多久（≤15 分转琥珀、≤5 分或已过点转红）。
      邮寄单可以稍后处理，60/240 分钟才变色。红框最急 = 顾客申请退菜或配送异常，先处理它。
    </>
  )
}

/**
 * 手机顶栏（规格 §9.1）：桌面那条 169px 高的顶栏在 375px 上会折成三行，
 * 加上图例一共吃掉首屏 39%。这里只留「一眼要看的四样」——店名、营业、打印机、告警，
 * 统计与三个按钮进「⋯」。全屏在小程序 web-view 里本来就调不起来，更不该占一级位置。
 */
function PhoneTopBar({ snap, shopName, onExplain, onMenu }: {
  snap: WorkbenchSnapshot | null; shopName: string; onExplain: () => void; onMenu: () => void
}) {
  const openState = openStateOf(snap)
  const alerts = snap?.pendingAlerts ?? 0
  return (
    <div className="wb__ptop">
      <div className="wb__ptop-l">
        <span className="wb__shop">{shopName}</span>
        <span className="wb__meta"><i className={`wb__dot ${openState.cls}`} />{openState.text}</span>
        {snap && (
          <span className="wb__meta" title={`打印机 ${PRINTER_STATUS_TEXT[snap.printer.status]}`}>
            <Printer className="w-3.5 h-3.5" />
            <i className={`wb__dot ${PRINTER_DOT_CLS[snap.printer.status]}`} />
          </span>
        )}
        <span className={`wb__alerts ${alerts > 0 ? 'wb__alerts--on' : ''}`}>
          <Bell className="w-3.5 h-3.5" />{alerts}
        </span>
      </div>
      <div className="wb__ptop-r">
        <button className="wb__iconbtn" onClick={onExplain} aria-label="颜色和时间怎么看">
          <CircleQuestionMark className="w-4 h-4" />
        </button>
        <button className="wb__iconbtn" onClick={onMenu} aria-label="更多">
          <Ellipsis className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

/**
 * 列切换条（规格 §9.1）：手机上换列的**主**方式。
 * 横滑找列在这里用不了——待接单一列 120 张卡时页面高 18,000px，
 * 想横滑得先纵向滚回顶部。
 */
function ColumnTabs({ snap, active, onPick }: {
  snap: WorkbenchSnapshot | null; active: ColKey; onPick: (k: ColKey) => void
}) {
  return (
    <div className="wb__tabs" role="tablist" aria-label="订单列">
      {COLUMNS.map((col) => {
        const n = snap ? snap.columns[col.key].length : 0
        const on = col.key === active
        return (
          <button
            key={col.key}
            role="tab"
            aria-selected={on}
            className={`wb__tab${on ? ' wb__tab--on' : ''}`}
            onClick={() => onPick(col.key)}
          >
            {col.title}<span className="wb__tab-n">{n}</span>
          </button>
        )
      })}
    </div>
  )
}

function Card({ card, colKey, now, graceMin, prepMin, onOpen, onHandleCancel }: {
  card: WorkbenchCard; colKey: ColKey; now: number
  /** 顾客可申请取消 / 店员可处理的窗口（分钟，接单起算），用来算「还剩多久自动回绝」 */
  graceMin: number
  /** 当下的备餐时长（分，高峰取上界）——「备餐中」那一列的正常停留时长就是它 */
  prepMin: number
  onOpen: () => void; onHandleCancel: () => void
}) {
  const local = card.channel === 'LOCAL'
  const d = card.local?.delivery ?? null
  const badFlow = !!d && ['ABNORMAL', 'UNKNOWN', 'FAILED'].includes(d.status)
  // 呼叫失败是「立即处理」级别（§5 红框）：不重呼或改自送，这单就一直停在备餐中没人送
  const callFailed = !!d?.callFailed
  const alert = !!card.local && (card.local.cancelRequested || badFlow || callFailed)
  // 已完成列不再用等待胶囊的琥珀/红底：红是本页面最稀缺的信号（§0/§5「红框=立即处理」），
  // 用它标注「已经做完的事」会稀释这个信号——到下午最后一列全红，等于没有红（I7）。
  // 改显示静态的完成时刻（服务端给 done 列的锚点就是 completedAt，即 card.waitSince）。
  const urg = alert ? 'late' : urgencyOf(card, colKey, now, prepMin)
  // 已完成列用：自送和骑手送要分开说，不然「骑手 店员小李」读着别扭
  const doneBy = !d
    ? '送达方式未记录'
    : d.provider === 'SELF'
      ? `自送${d.courierName ? ` ${d.courierName}` : ''}`
      : `骑手 ${d.courierName ?? d.statusLabel}`
  const w = colKey === 'done' ? { text: `完成于 ${hhmm(card.waitSince)}`, cls: '' } : waitLabel(card.waitSince, now, urg)
  // 距离来自运力方的报价/接单回执（providerDistanceM）。没呼叫配送员时它必然是 null，
  // 印一行「距离 --」只是在卡片上占一格空话，所以整行不渲染（PO 2026-09-07）。
  const kmText = card.local?.distanceM != null ? `${(card.local.distanceM / 1000).toFixed(1)} km` : null
  return (
    <div
      className={`wb__card ${local ? 'wb__card--local' : 'wb__card--express'} ${alert ? 'wb__card--alert' : urg ? `wb__card--${urg}` : ''}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}
    >
      <div className="wb__card-top">
        <span className={`wb__badge ${local ? 'wb__badge--local' : 'wb__badge--express'}`}>
          {local ? <Bike className="w-3.5 h-3.5" /> : <Package className="w-3.5 h-3.5" />}
          {local ? '同城配送' : '全国邮寄'}
        </span>
        <span className={`wb__wait ${w.cls}`}>{w.text}</span>
      </div>

      {/* 尾号与单号同行：骑手在柜台报的是手机尾号，店员对袋子时不用翻抽屉 */}
      <div className="wb__no">
        <span><span className="wb__shortno">{shortNo(card.orderNo)}</span>{local && card.receiver.phone && <span className="wb__tail"> 尾号{card.receiver.phone.slice(-4)}</span>}</span>
        <b>¥{yuan(card.amountFen)}</b>
      </div>
      <div className="wb__items">{itemsSummary(card.items, card.channel)}</div>

      {/* 无备注必须明写，留空则「没看见」与「没有」无法区分（§4） */}
      {card.note ? <div className="wb__note">{card.note}</div> : <div className="wb__nonote">无备注</div>}

      <div className="wb__fields">
        {local ? (colKey === 'done' ? (
          /* 已完成的单只回答一件事：**最后是谁送的**。
             这里原来照抄了在途卡片的两行，于是显示成「骑手 未呼叫 · 预计送达 15:06」——
             送到了却说没呼叫骑手，还配一个未来时刻的预计送达，两条都是假的
             （送达时 activeOrderId 被清空，服务端就查不到那张配送单了，现已按 orderId 补回）。
             送达时刻不用再写一遍：右上角那枚胶囊已经是「完成于 14:36」。 */
          <>
            {kmText && <span>距离 {kmText}</span>}
            <span>{doneBy}</span>
          </>
        ) : (
          <>
            {kmText && <span>距离 {kmText}</span>}
            <span>骑手 {d?.courierName ? `${d.courierName}${d.courierMobile ? ` ${d.courierMobile}` : ''}` : (d ? d.statusLabel : '未呼叫')}</span>
            <span>预计送达 {hhmm(card.local?.estimatedDeliveryAt)}</span>
          </>
        )) : (
          <>
            <span>{card.express?.province}{card.express?.city && card.express.city !== card.express.province ? ` ${card.express.city}` : ''}</span>
            <span>{card.express?.expressCompany ?? '未发货'}</span>
            <span>{card.express?.expressNo ?? '无运单号'}</span>
          </>
        )}
      </div>

      {/* 取消申请：不用「去处理」，因为**不处理就是驳回**——接单满 acceptGraceMin 分钟系统自动
          回绝（服务端 autoRejectStaleCancelRequests，「甲」口径）。所以这条只需要回答一件事：
          「你要不要退他钱」，以及「不动的话还剩多久自动回绝」。倒计时归零后本条会随下一次
          快照刷新自然消失（变成下面那条「已驳回」）。 */}
      {card.local?.cancelRequested && (
        <div className="wb__strip wb__strip--warn">
          <span>顾客要退菜{autoRejectLeft(card.local.acceptedAt, graceMin, now) ?? ''}</span>
          <button className="wb__iconbtn" onClick={(e) => { e.stopPropagation(); onHandleCancel() }}>同意退款</button>
        </div>
      )}
      {/* 驳回之后厨房要继续做。PO 2026-09-07 定：这件事只显示在屏幕上，不再出票 */}
      {!card.local?.cancelRequested && card.local?.cancelRejected && (
        <div className="wb__strip">
          <span>{card.local.cancelRejected === 'AUTO' ? '超时未处理，已自动回绝退菜' : '已回绝退菜'} · 继续完成此订单</span>
        </div>
      )}
      {(badFlow || callFailed) && d && (
        <div className="wb__strip wb__strip--danger">
          {/* 呼叫失败时统一写「呼叫失败」而不是 statusLabel：FAILED 的 statusLabel 是运力方措辞，店员看不出该做什么 */}
          <span><CircleAlert className="w-3.5 h-3.5 inline" /> {callFailed ? '呼叫失败' : d.statusLabel}</span>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// 顶栏（§8）
// ─────────────────────────────────────────────────────────
function TopBar({
  snap, shopName, targetTheme, onToggleTheme, focus, isFullscreen, onFullscreen, onExit,
}: {
  snap: WorkbenchSnapshot | null; shopName: string; targetTheme: 'light' | 'dark'
  onToggleTheme: () => void; focus: boolean; isFullscreen: boolean; onFullscreen: () => void; onExit: () => void
}) {
  const today = new Date()
  const openState = openStateOf(snap)
  const alerts = snap?.pendingAlerts ?? 0
  return (
    <>
      <div className="wb__top">
        <div className="wb__top-l">
          <span className="wb__shop">{shopName}</span>
          <span className="wb__meta">{fmtMonthDayCn(today)}</span>
          <span className="wb__meta"><i className={`wb__dot ${openState.cls}`} />{openState.text}</span>
          {/* 打印机状态灯：接飞鹅后 snap.printer.status 是真实健康检测结果，四态归并口径见服务端
              workbench.ts 的 summarizePrinterStatus——多台打印机取「最差」。NOT_CONNECTED（未启用/
              未绑定任何打印机）沿用旧灰点 + 「未接入」文案，不算异常，不用告警色。 */}
          {snap && (
            <span className="wb__meta">
              <Printer className="w-3.5 h-3.5" />
              <i className={`wb__dot ${PRINTER_DOT_CLS[snap.printer.status]}`} />
              打印机 {PRINTER_STATUS_TEXT[snap.printer.status]}
            </span>
          )}
          <span className={`wb__alerts ${alerts > 0 ? 'wb__alerts--on' : ''}`}>
            <Bell className="w-3.5 h-3.5" />待处理告警 {alerts}
          </span>
        </div>
        <div className="wb__top-r">
          <div className="wb__stats">
            <span>今日单数<b>{snap?.stats.todayOrders ?? '--'}</b></span>
            <span>营业额<b>¥{snap ? yuan(snap.stats.todayRevenueFen) : '--'}</b></span>
            <span>平均送达<b>{snap?.stats.avgDeliverMinutes != null ? `${snap.stats.avgDeliverMinutes} 分` : '--'}</b></span>
          </div>
          {/* 图标与文案统一描述「点击后会变成什么」，不描述当前状态——否则跟随系统时会出现图标指向和实际切换方向相反（§8） */}
          <button className="wb__iconbtn" onClick={onToggleTheme}>
            {targetTheme === 'dark' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            {targetTheme === 'dark' ? '深色' : '浅色'}
          </button>
          {/* 三个状态互不相同：真全屏 / 退化的专注模式 / 普通。按钮必须说出「再点会发生什么」，
              而 focus 只代表专注模式——用它当全屏指示，真全屏时按钮会永远停在「全屏」（§8） */}
          <button className="wb__iconbtn" onClick={onFullscreen}>
            <Maximize className="w-4 h-4" />{isFullscreen ? '退出全屏' : focus ? '退出专注' : '全屏'}
          </button>
          <button className="wb__iconbtn" onClick={onExit}><LogOut className="w-4 h-4" />退出工作台</button>
        </div>
      </div>
    </>
  )
}

/**
 * 断线提示与熔断横幅。**故意不放在 TopBar 里**——它们是两种顶栏都必须有的东西。
 *
 * 手机模式（2026-09-07 上线）把 TopBar 整个换成了 PhoneTopBar，这两条就跟着一起没了：
 * 余额一空系统悄悄停呼，店员在手机上点「呼叫骑手」只拿到 42232，看不出原因，
 * 「恢复」按钮也一起消失，只能先退出工作台去系统状态页。同理，轮询连续失败时
 * 手机上没有「数据已 N 分钟未更新」，店员会对着一块已经不动的板子接单。
 * 提到顶栏之外由两种模式共用，就不会再随顶栏的改版丢一次。
 */
function TopAlerts({ snap, staleMinutes, onResetCircuit, circuitBusy }: {
  snap: WorkbenchSnapshot | null
  staleMinutes: number | null
  onResetCircuit: () => void
  circuitBusy: boolean
}) {
  return (
    <>
      {/* 细条，不是满屏红字（I1 原注释的道理一样适用）：断线时店员该知道，但不该被吓到 */}
      {staleMinutes != null && (
        <div className="wb__stale">
          {staleMinutes < 0
            ? '尚未连接上服务器，正在重连…'
            : `数据已 ${staleMinutes < 1 ? '不足 1' : staleMinutes} 分钟未更新，正在重连…`}
        </div>
      )}
      {snap?.circuit.tripped && (
        <div className="wb__banner">
          <span>快递100 余额不足已暂停呼叫。充值后点「恢复」，或改用「自己送」。</span>
          <button className="wb__iconbtn" onClick={onResetCircuit} disabled={circuitBusy}>{circuitBusy ? '处理中…' : '恢复'}</button>
        </div>
      )}
    </>
  )
}

type ModalState =
  | { kind: 'confirm'; spec: ConfirmSpec }
  | { kind: 'cancelDelivery'; title: string }
  | { kind: 'tip' }
  | { kind: 'ship' }
  | { kind: 'self' }
  | { kind: 'reject' }
  | { kind: 'cancelRefund' }
  | { kind: 'exit' }
  | null

/** 点日夜按钮后会切到的目标主题——按钮图标/文案要描述这个，不是当前主题（§8） */
function nextTheme(theme: 'light' | 'dark' | null): 'light' | 'dark' {
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  return theme === null ? (systemDark ? 'light' : 'dark') : theme === 'dark' ? 'light' : 'dark'
}

function readTheme(): 'light' | 'dark' | null {
  // localStorage 在无痕/被禁用 cookie 的机器上直接抛异常，工作台不能因为记个主题就白屏
  try {
    const v = localStorage.getItem('wb-theme')
    return v === 'dark' || v === 'light' ? v : null
  } catch { return null }
}

export default function Workbench() {
  const navigate = useNavigate()
  const rootRef = useRef<HTMLDivElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  /** 服务端时间 - 本机时间：店里的平板时钟经常偏几分钟，等待胶囊按服务端锚点算才准 */
  const skewRef = useRef(0)
  /** load() 请求序号：只应用「已发出的请求里最新那个」的响应，丢弃后到的旧快照（I2） */
  const loadSeqRef = useRef(0)
  const appliedSeqRef = useRef(0)
  /** loadDetail() 请求序号：openCard / afterAction / 轮询换列都会调它，网络不保序时
   *  必须丢弃后发先至的旧响应，否则可能用旧详情覆盖刚刚才落地的新详情（同 I2 的道理） */
  const detailSeqRef = useRef(0)
  const appliedDetailSeqRef = useRef(0)

  const [snap, setSnap] = useState<WorkbenchSnapshot | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [settings, setSettings] = useState<LocalDeliverySettings | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark' | null>(readTheme)
  const [focus, setFocus] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [drawer, setDrawer] = useState<{ card: WorkbenchCard; colKey: ColKey } | null>(null)
  const [detail, setDetail] = useState<{
    order: Order; delivery: DeliveryInfo | null; events: DeliveryEventInfo[]
    // 服务端早就返回 quote/costFen 了，此前前端一直原样丢掉——报价块与「配送成本」都要用
    // quoteFreshMs：服务端下发的新鲜度阈值，配合 quotedAt 由 CallQuoteBlock 自己实时重算 stale
    quote: { snapshot: QuoteSnapshot | null; quotedAt: string | null; stale: boolean; quoteFreshMs: number } | null
    costFen: number
  } | null>(null)
  // 轮询发现抽屉换列/配送状态变了，但新详情还没拉回来这段窗口期：renderActions 的按钮
  // 全部由 detail.delivery 算，此时 detail 仍是旧列的——不置这个标记的话按钮会短暂
  // 全部消失或显示上一列的按钮（见复核纪要「抽屉随快照轮询自动换列」）。
  const [detailRefreshing, setDetailRefreshing] = useState(false)
  // 轮询发现抽屉里的卡片在所有列里都找不到了（订单被取消/退款/以其他方式离开看板）：
  // 不是「换列」，是「消失」——detail.delivery 停在最后一次落地的旧值，renderActions
  // 继续用它算按钮会显示一堆再也点不动（或点了也没意义）的操作。见下面轮询换列的 useEffect。
  const [gone, setGone] = useState(false)
  // 骑手实时位置：只在骑手真的上路的那几个状态下轮询，抽屉一关就停（见下面的 useEffect）
  const [courier, setCourier] = useState<CourierLive | null>(null)
  // 已完成列默认收起（见下面渲染处的注释）。刻意不持久化：每天开工都是干净的四列。
  const [doneOpen, setDoneOpen] = useState(false)
  // ── 手机模式（规格 §9.1）。isPhone 只在 ≤700px 为真，iPad 与电脑走原来那套。
  const isPhone = useIsPhone()
  /** 手机上当前显示哪一列。默认「待接单」——规格 §9 本来就是这么定的 */
  const [phoneCol, setPhoneCol] = useState<ColKey>('pending')
  /** 手机顶栏的两个浮层：'explain' = 图例+阈值说明，'menu' = 统计与三个按钮 */
  const [sheet, setSheet] = useState<null | 'explain' | 'menu'>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const [modal, setModal] = useState<ModalState>(null)
  const [pendingCancelRefund, setPendingCancelRefund] = useState(false)
  const [circuitBusy, setCircuitBusy] = useState(false)
  /** 最近一次轮询成功的时间 + 连续失败拍数：区分「没有新单」和「已经断线五分钟」（I1） */
  const [lastOkAt, setLastOkAt] = useState<number | null>(null)
  const [pollFailCount, setPollFailCount] = useState(0)
  const [reprinting, setReprinting] = useState(false)

  const load = useCallback(async (fresh = false) => {
    const seq = ++loadSeqRef.current
    try {
      const data = (await getWorkbenchSnapshot(fresh)).data.data
      // 弱网下顺序不保证：这份响应对应的请求比「已经生效的那份」更旧，说明是迟到的旧快照，丢弃（I2）
      if (seq < appliedSeqRef.current) return
      appliedSeqRef.current = seq
      skewRef.current = Date.parse(data.now) - Date.now()
      setSnap(data)
      setLastOkAt(Date.now())
      setPollFailCount(0)
    } catch {
      // 轮询失败静默，下一拍重试——满屏红字对站着的店员没有帮助；
      // 但连续失败要留痕，否则店员分不清「没有新单」和页面已经僵住多久（§I1，见 TopBar 的细条）
      setPollFailCount((c) => c + 1)
    }
  }, [])

  // 10s 轮询；页面隐藏时降到 60s（省电又不至于回前台一片旧数据）。
  // 用「上一拍落地后再排下一拍」代替 setInterval：弱网下一发不回也不会继续叠加下一发，
  // 叠加的请求越攒越多，回来的顺序又不保证，正是 I2 剧本里旧快照打回新状态的放大器。
  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const clear = () => { if (timer !== null) { window.clearTimeout(timer); timer = null } }
    const scheduleNext = () => {
      if (cancelled) return
      timer = window.setTimeout(run, document.hidden ? 60_000 : 10_000)
    }
    const run = async () => {
      await load()
      scheduleNext()
    }
    const onVisibilityChange = () => {
      clear()
      if (!document.hidden) void run()
      else scheduleNext()
    }
    void load(true).then(scheduleNext)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      cancelled = true
      clear()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [load])

  // 等待胶囊要走秒
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now() + skewRef.current), 1000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => { getLocalSettings().then(setSettings, () => { /* 店名/小费上限取不到就用兜底值 */ }) }, [])

  // I8：工作台是店员整天待着的落地页（渲染在 Layout 外，见 App.tsx），却是唯一没有新单提醒的页面——
  // 新单只会在下一次 10s 快照轮询后静静出现在「待接单」列。挂上和 Layout 同一套三层提醒
  // （toast / 系统 Notification / 标签页标题闪烁）。系统 Notification 点击后不导航离开——
  // 店员本来就在这页，把他踢去邮寄订单页只会打断他正在处理的单；改成把看板滚回「待接单」列。
  usePendingOrders({ onNotificationClick: () => boardRef.current?.scrollTo({ left: 0, behavior: 'smooth' }) })

  // 工作台没有铃铛按钮可供「点一下再要权限」，就借第一次真实点击（几乎必然在几秒内发生：
  // 点卡片、点按钮）当用户手势申请系统通知权限，比在挂载时直接调用更贴近浏览器的期望
  useEffect(() => {
    const onFirstClick = () => requestNotifyPermission()
    document.addEventListener('click', onFirstClick, { once: true })
    return () => document.removeEventListener('click', onFirstClick)
  }, [])

  // <900px 五列变横滑，默认停在「待接单」（§9）——它是第一列，滚回 0 即是
  useEffect(() => { boardRef.current?.scrollTo({ left: 0 }) }, [])

  // Esc 逐层退出：先关弹窗，再关抽屉。关掉弹窗＝没执行操作，所以不危险
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (modal) setModal(null)
      else if (drawer) closeDrawer()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modal, drawer])

  // 用户按 Esc/F11 原生退出真全屏时，document.fullscreenElement 会变 null——若 focus 这时仍是
  // true（理论上不该发生，见 toggleFullscreen 的注释），在这里兜底复位，避免卡在专注模式要再点一次
  // 真全屏状态只能问浏览器要：用户按 Esc/F11 原生退出时不会经过我们的按钮，
  // 自己记一个布尔值早晚会和现实脱节。
  useEffect(() => {
    const onFsChange = () => {
      const on = !!document.fullscreenElement
      setIsFullscreen(on)
      if (!on) setFocus(false)
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const loadDetail = useCallback(async (orderId: number, channel: Channel) => {
    const seq = ++detailSeqRef.current
    setDetailLoading(true)
    try {
      const [o, d] = await Promise.all([getOrder(orderId), channel === 'LOCAL' ? getOrderDelivery(orderId) : null])
      // 弱网下这次响应可能是后发先至的旧请求（openCard/afterAction/轮询换列都会调 loadDetail）：
      // 只应用最新那一发，否则旧详情落地会把刚刚已经生效的新详情又盖回去
      if (seq < appliedDetailSeqRef.current) return
      appliedDetailSeqRef.current = seq
      setDetail({
        order: o.data.data,
        delivery: d?.data.data.delivery ?? null,
        events: d?.data.data.events ?? [],
        quote: d?.data.data.quote ?? null,
        costFen: d?.data.data.costFen ?? 0,
      })
      setDetailRefreshing(false)
    } catch (e) {
      if (seq < appliedDetailSeqRef.current) return
      toast.error(apiMessage(e, '订单详情加载失败'))
      // 卡片「去处理」把标志位置了 true，详情却加载失败：不复位的话下一次任意一次成功加载都会莫名弹出退款引导
      setPendingCancelRefund(false)
      setDetailRefreshing(false)
    } finally { setDetailLoading(false) }
  }, [])

  const openCard = (card: WorkbenchCard, colKey: ColKey, wantCancelRefund = false) => {
    setDrawer({ card, colKey })
    setDetail(null); setShowEvents(false); setModal(null)
    setDetailRefreshing(false)
    setGone(false)
    setPendingCancelRefund(wantCancelRefund)
    void loadDetail(card.orderId, card.channel)
  }

  const closeDrawer = () => {
    setDrawer(null); setDetail(null); setModal(null); setPendingCancelRefund(false); setCourier(null)
    setDetailRefreshing(false)
    setGone(false)
  }

  /**
   * 骑手位置轮询：30 秒一次，只在骑手真的上路的那几个状态下开（服务端还有 20 秒缓存兜着，
   * 所以真打到快递100 的频率上限是每单每 20 秒一次）。抽屉一关、状态一离开在途，立刻停。
   *
   * 失败静默：位置查不到时整块隐藏就好，不该在店员正忙的时候弹一个红条——
   * 这也是原来 queryCourier 传错参数半个月没人发现的原因，所以这里只吞 UI 提示，
   * 服务端那侧仍然会 console.warn。
   */
  const courierDelivery = detail?.delivery
  const courierLive = !!courierDelivery && ['ACCEPTED', 'ARRIVING', 'ARRIVED', 'DELIVERING'].includes(courierDelivery.status)
  const courierOrderId = drawer?.card.orderId
  useEffect(() => {
    if (!courierLive || !courierOrderId) { setCourier(null); return }
    let alive = true
    const tick = async () => {
      try {
        const r = await getCourierLive(courierOrderId)
        if (alive) setCourier(r.data.data)
      } catch { /* 见上：位置拿不到就隐藏，不打扰店员 */ }
    }
    void tick()
    const t = setInterval(() => void tick(), 30_000)
    return () => { alive = false; clearInterval(t) }
  }, [courierLive, courierOrderId])

  // 卡片上点「去处理」时详情还没到，等详情到齐再弹退款引导（金额要用可退余额，不能瞎猜）
  useEffect(() => {
    if (pendingCancelRefund && detail) { setModal({ kind: 'cancelRefund' }); setPendingCancelRefund(false) }
  }, [pendingCancelRefund, detail])

  // 快照刷新后把抽屉里的卡片换成新的一份（订单可能已经换列）。
  //
  // 列位置/卡片来自这份快照，10 秒一轮；但按钮真正依赖的 detail.delivery 只在 openCard/
  // afterAction 两处加载，不会因为这里换了列就跟着重取。以前只换 drawer.card/colKey、
  // 不重拉详情，会出现两种情况：①换列瞬间 renderActions 用旧 detail.delivery 算出的
  // active 跟新列对不上，一个操作按钮都不出（或还显示上一列的按钮）；②同一列内配送状态
  // 变了（如骑手接单 CALLING→ACCEPTED，colKey 仍是 waitingCourier）也不会被发现，「打给
  // 骑手」永远不出现、姓名电话卡死在旧值。这里额外比对 colKey 与卡片自身的状态字段，
  // 两者任一变化都同步重拉详情；重拉期间用 detailRefreshing 标记，renderActions 据此
  // 显示「刷新中…」占位而不是让按钮区空白或显示错列的按钮。
  useEffect(() => {
    if (!snap || !drawer) return
    for (const col of COLUMNS) {
      const found = snap.columns[col.key].find((c) => c.orderId === drawer.card.orderId)
      if (found) {
        const colChanged = col.key !== drawer.colKey
        const statusChanged = found.status !== drawer.card.status
          || found.local?.delivery?.status !== drawer.card.local?.delivery?.status
        if (found !== drawer.card || colChanged) setDrawer({ card: found, colKey: col.key })
        if (colChanged || statusChanged) {
          setDetailRefreshing(true)
          void loadDetail(found.orderId, found.channel)
        }
        return
      }
    }
    // 五列都没找到：订单已经离开看板（顾客取消退款、或被别的渠道/店员处理掉）。
    // 抽屉还开着，但 detail 是最后一次成功加载时的旧快照——不置 gone 的话 renderActions
    // 会照旧渲染上一列的按钮，店员点下去大概率是对着一个已经不存在的状态操作。
    setGone(true)
  }, [snap, drawer, loadDetail])

  const afterAction = async (msg: string) => {
    toast.success(msg)
    setModal(null)
    await load(true)
    if (drawer) await loadDetail(drawer.card.orderId, drawer.card.channel)
  }

  const toggleTheme = () => {
    const next = nextTheme(theme)
    setTheme(next)
    try { localStorage.setItem('wb-theme', next) } catch { /* 存不下就只在本次会话生效 */ }
  }

  // 全屏两条路径都要有：被浏览器/iframe（小程序 web-view 就是）拒绝时退化成专注模式（§8）。
  // 成功进入真全屏时不设 focus——focus 只表示「退化专注模式」，图例条常驻（§3）不该因真全屏成功而被隐藏。
  // 全屏目标必须是 document.documentElement，不能是 .wb 这个子节点：ToastHost/ConfirmDialogHost
  // 挂在 App.tsx 里、是 <Routes> 的兄弟节点，不在 .wb 子树内。全屏元素进 top layer 后 ::backdrop 会把
  // 文档其余部分整个盖住，这两个 host 会既画不出来也接不到点击（退出确认框、所有 toast 全部失效）。
  // 工作台本来就是整页路由（在 Layout 之外），全屏根元素视觉上等价，同时规避非根元素的
  // :fullscreen UA 样式（强制 position:fixed + height:100%，内容溢出时既出屏又不可滚动）。
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => undefined)
      setFocus(false)
      return
    }
    if (focus) { setFocus(false); return }
    const el = document.documentElement
    const req = el.requestFullscreen?.bind(el)
    if (!req) { setFocus(true); toast.info('当前环境不支持全屏，已切到专注模式'); return }
    try {
      const p = req()
      if (p && typeof p.then === 'function') {
        p.catch(() => { setFocus(true); toast.info('浏览器不允许全屏，已切到专注模式') })
      }
      // 同步/无 Promise 的旧浏览器：成功与否交给下面的 fullscreenchange 监听去判断，这里不猜。
    } catch { setFocus(true); toast.info('浏览器不允许全屏，已切到专注模式') }
  }

  // 用工作台自绘弹窗（WbModal），不用通用 ConfirmDialog——那个固定 bg-white，深色主题下是一整块白
  // （Workbench.css 文件头注释警告的就是这件事，见 CancelAndRefundModal.tsx 顶部同款说明）
  const exitWorkbench = () => setModal({ kind: 'exit' })

  const resetCircuit = async () => {
    setCircuitBusy(true)
    try { await resetKd100Circuit(); toast.success('已恢复呼叫'); await load(true) }
    catch (e) { toast.error(apiMessage(e, '恢复失败，请重试')) }
    finally { setCircuitBusy(false) }
  }

  // ── 操作区（§6 分级确认：改状态或花钱的全弹；打给骑手/看进度/查物流不弹）──
  const renderActions = (): ReactNode => {
    if (!drawer || !detail) return null
    // 订单已经离开看板（顾客取消退款等）：detail 是留在手里的最后一份旧快照，继续用它
    // 渲染按钮就是在给一个不存在的状态配操作。让店员明确知道要关闭重开，而不是照旧点按钮。
    if (gone) return <span className="wb__muted">该单已离开看板，请关闭重开</span>
    // 轮询发现列/配送状态变了、新详情还在路上：detail 此刻仍是上一列的，renderActions
    // 下面全部靠它算 active——不挡住的话要么按钮全消失，要么显示上一列的按钮。
    // 用占位文案顶住这段窗口（通常一次轮询周期内、≤10 秒），比空白或错误按钮更不容易让店员误操作。
    if (detailRefreshing) return <span className="wb__muted">刷新中…</span>
    const { card, colKey } = drawer
    const { order, delivery } = detail
    const ch = card.channel
    const active = delivery && delivery.activeOrderId === order.id && !TERMINAL_DELIVERY.includes(delivery.status)
      ? delivery : null
    const confirm = (spec: ConfirmSpec) => setModal({ kind: 'confirm', spec })
    // 「实际约 ¥5–8」这句已被实测推翻（2026-09-06 首单 8.94 km 实扣 ¥23.32，1.1 km 那组
    // 最贵的也报 ¥11.22），改成不给死数字，让店员看下面报价块里的真实金额。
    const CALL_AMBER = '会预扣配送费，实际以中标运力的预扣为准。若之后取消已接单的骑手，可能产生约 ¥2 取消费。'
    // 呼叫方式来自设置（默认并呼最便宜的 N 家）。拿不到设置时按「并呼全部」措辞——
    // 宁可文案保守，也不要让店员以为只花一家的钱、结果按并呼冻结了 N 笔。
    const callMode = settings?.callStrategy?.mode ?? 'ALL'
    const cheapestN = settings?.callStrategy?.cheapestN ?? 3
    // 最低价不在这里取：确认键的金额由弹窗内的报价块实时回传（见 ConfirmSpec.confirmTextOf），
    // 这里取一次会停在打开抽屉那一刻的快照上，店员在弹窗里点过刷新之后就成了错数字。
    const escalateMin = settings?.callStrategy?.escalateAfterMin ?? 0
    const btns: ReactNode[] = []
    const fill = (key: string, label: string, onClick: () => void) => (
      <FillButton key={key} channel={ch} onClick={onClick}>{label}</FillButton>
    )
    const ghost = (key: string, label: string, onClick: () => void) => (
      <button key={key} className="wb__btn wb__btn--ghost" onClick={onClick}>{label}</button>
    )
    // 拨号不弹确认：它没有后果，而店员一天点几十次（§6）
    const tel = (key: string, label: string, phone: string) => (
      <a key={key} className="wb__btn wb__btn--ghost" href={`tel:${phone}`}><Phone className="w-4 h-4" />{label}</a>
    )
    /**
     * 呼叫确认弹窗。文案随呼叫方式变——呼几家在**冻结多少钱**上差一个数量级
     * （首单那组报价：只呼最低 ¥16.23／最便宜 3 家约 ¥51.76／全部 7 家 ¥75.08），
     * 店员按下去之前必须知道是哪种。
     * `hasQuote=false` 用于「接单并呼叫」：那一刻还没查过价，报价块给不出数字，
     * 也就没得选——只能说明会先查价，选运力这件事留给之后单独点「呼叫骑手」。
     */
    // 三级阶梯（店主 2026-09-07 定）：第一次呼你在上面选中的，之后系统一级一级往上加人。
    // 后半句对**任何**第一次都成立——包括手选的那一家（服务端把 MANUAL 也纳入了升级范围），
    // 所以不能只在「没手选」时显示，否则店员会以为手选的单没人兜。
    const strategyText = callMode === 'SOLO_LOWEST' ? '只呼你选中的那一家'
      : callMode === 'CHEAPEST_N' ? `并呼最便宜的 ${cheapestN} 家，谁先接算谁的`
        : '并呼设置里的全部运力，谁先接算谁的'
    const escalateText = escalateMin > 0 && callMode !== 'ALL'
      ? `；没人接的话系统会自动往上加人——约 ${escalateMin} 分钟后改为并呼最便宜 ${cheapestN} 家，再过 ${escalateMin} 分钟并呼全部运力`
      : ''
    const callSpec = (
      title: string, confirmText: string, what: string,
      run: (pick?: CallPick | null) => Promise<unknown>, hasQuote = true,
    ): ConfirmSpec => {
      return {
        title, channel: ch,
        // 确认键上带运力名与金额，是「按下去要花多少钱」最后一道提示。
        // 取的是**弹窗里那块报价当前的选择**（点刷新或改选都会跟着变），而不是打开抽屉那一刻
        // 的快照；报价过期时 CallQuoteBlock 报空 quotes，这里就退回不带金额的文案——
        // 过期意味着服务端下单前会自己重查，此刻写死一个价就是空头承诺。
        confirmTextOf: hasQuote
          ? (p) => {
            const sum = p.quotes.reduce((n, x) => n + x.feeFen, 0)
            if (p.manual) return `只呼${providerLabel(p.providers[0])}${p.quotes.length ? ` ¥${yuan(sum)}` : ''}`
            if (p.quotes.length === 1) return `呼叫${providerLabel(p.quotes[0].provider)} ¥${yuan(p.quotes[0].feeFen)}`
            if (p.quotes.length > 1) return `并呼 ${p.quotes.length} 家 共冻 ¥${yuan(sum)}`
            return confirmText
          }
          : undefined,
        confirmText,
        okMsg: '已呼叫骑手',
        what: hasQuote ? `${what}${strategyText}${escalateText}。` : `${what}接单后先查价，再${strategyText}。`,
        customer: '顾客看到「正在为您呼叫骑手」。',
        cost: callMode === 'SOLO_LOWEST'
          ? '只冻结这一家的配送费。'
          : '并呼几家就同时冻结几笔预扣，只有中标那家最终扣款，其余释放。',
        extra: hasQuote
          ? (onPick) => (
            <CallQuoteBlock
              orderId={order.id}
              initial={detail?.quote ?? null}
              mode={callMode} cheapestN={cheapestN}
              freshMs={detail?.quote?.quoteFreshMs ?? DEFAULT_QUOTE_FRESH_MS}
              skewMs={skewRef.current}
              onPick={onPick}
            />
          )
          : undefined,
        amber: CALL_AMBER, run,
      }
    }
    // 「作废重呼」出现在「备餐中」「等待配送员」两列，文案（含琥珀警示的钱字）必须一字不差——
    // 抽成一处，改文案不会漏改另一份（Minor）
    const voidRecallSpec: ConfirmSpec = {
      title: '作废重呼', channel: ch, confirmText: '确认作废并重呼', okMsg: '已作废并重新呼叫',
      what: '先把这张「状态未确认」的配送单作废，再重新呼叫一次骑手。',
      customer: '顾客看到「正在为您呼叫骑手」。',
      cost: '会预扣一次新的配送费。',
      amber: '作废前请先在快递100 后台确认这张单确实不存在；若它其实已成单，重呼会变成两张单、两笔钱。',
      run: async () => { await voidUnknownDelivery(order.id); await callRider(order.id) },
    }

    if (colKey === 'pending') {
      btns.push(fill('accept', '接单', () => confirm({
        title: '接单', channel: ch, confirmText: '确认接单', okMsg: '已接单',
        what: ch === 'LOCAL' ? '订单转入「备餐中」，开始做货；之后再呼叫骑手。' : '订单转入「备餐中」，开始打包；之后再填单号发货。',
        customer: '顾客小程序显示「商家已接单」。',
        cost: '不产生任何费用。',
        run: () => (ch === 'LOCAL' ? acceptLocalOrder(order.id) : acceptOrder(order.id)),
      })))
      if (ch === 'LOCAL') {
        btns.push(ghost('accept-call', '接单并呼叫', () => confirm(callSpec(
          '接单并呼叫骑手', '确认接单并呼叫',
          '先接单，随即向快递100 发单呼叫骑手；骑手会来店里取货。',
          () => acceptAndCallLocalOrder(order.id),
          false,   // 这一刻还没接单、没查过价，报价块给不出数字
        ))))
      }
    }

    if (colKey === 'preparing') {
      if (ch === 'LOCAL') {
        if (active?.status === 'UNKNOWN') {
          btns.push(fill('void-recall', '作废重呼', () => confirm(voidRecallSpec)))
        } else {
          const failed = delivery?.status === 'FAILED'
          btns.push(fill('call', failed ? '重新呼叫骑手' : '呼叫骑手', () => confirm(callSpec(
            failed ? '重新呼叫骑手' : '呼叫骑手', failed ? '确认重呼' : '确认呼叫',
            '向快递100 发单，等骑手接单并到店取货。',
            // 手选了才传 providers：传了服务端就记 MANUAL、原样照办；
            // 不传才走后台策略（并呼最便宜的 N 家），两条路在配送单上分得开，事后能对账
            (pick) => callRider(order.id, pick?.manual ? pick.providers : undefined),
          ))))
          btns.push(ghost('self', '自己送', () => setModal({ kind: 'self' })))
        }
      } else {
        btns.push(fill('ship', '填单号发货', () => setModal({ kind: 'ship' })))
      }
    }

    if (colKey === 'waitingCourier') {
      if (active?.status === 'CALLING') {
        btns.push(fill('tip', '加小费', () => setModal({ kind: 'tip' })))
        btns.push(ghost('cancel-call', '取消呼叫', () => setModal({ kind: 'cancelDelivery', title: '取消呼叫' })))
      } else if (active?.status === 'UNKNOWN') {
        btns.push(fill('void-recall2', '作废重呼', () => confirm(voidRecallSpec)))
      } else if (active) {
        btns.push(ghost('cancel-dlv', '取消配送', () => setModal({ kind: 'cancelDelivery', title: '取消配送' })))
      }
      if (active?.courierMobile) btns.push(tel('call-rider', '打给骑手', active.courierMobile))
    }

    if (colKey === 'delivering') {
      if (ch === 'LOCAL') {
        btns.push(fill('delivered', '标记已送达', () => confirm({
          title: '标记已送达', channel: ch, confirmText: '确认已送达', okMsg: '已标记送达',
          what: '配送单结束，订单转「已完成」。',
          customer: '顾客看到「已送达」，之后可以评价或申请售后。',
          cost: '不产生费用。',
          run: () => markOrderDelivered(order.id),
        })))
        if (active?.courierMobile) btns.push(tel('call-rider2', '打给骑手', active.courierMobile))
      } else {
        const no = order.shipment?.expressNo ?? card.express?.expressNo ?? ''
        // 查物流不弹确认（§6）
        btns.push(ghost('track', '查物流', () => {
          if (!no) { toast.error('本单还没有运单号'); return }
          copyText(no)
          window.open(`https://www.kuaidi100.com/chaxun?nu=${encodeURIComponent(no)}`, '_blank', 'noopener')
        }))
      }
    }

    if (ch === 'LOCAL' && delivery) {
      btns.push(ghost('progress', showEvents ? '收起进度' : '看进度', () => setShowEvents((v) => !v)))
    }
    if (order.receiverPhone) btns.push(tel('call-customer', '打给顾客', order.receiverPhone))
    return btns
  }

  // 每秒重渲染一次，卡片有几十张——高峰判定只算一次，别每张卡各跑一遍 Intl
  const prepMin = prepMinutesNow(settings, now)

  // ── 详情抽屉（§5）──
  const renderDrawer = (): ReactNode => {
    if (!drawer) return null
    const { card, colKey } = drawer
    const local = card.channel === 'LOCAL'
    const o = detail?.order
    const d = detail?.delivery ?? null
    // 与卡片同规则：已完成不再用会变色的等待胶囊（I7）；紧急度也走同一个函数，
    // 否则抽屉里的胶囊会和它背后那张卡片显示不同的颜色
    const w = colKey === 'done'
      ? { text: `完成于 ${hhmm(card.waitSince)}`, cls: '' }
      : waitLabel(card.waitSince, now, urgencyOf(card, colKey, now, prepMin))
    const canReject = !!o && ['PENDING_PAYMENT', 'PAID', 'PREPARING'].includes(o.status)
    return (
      <>
        <div className="wb__mask" onClick={closeDrawer} />
        <aside className="wb__drawer" role="dialog" aria-modal="true">
          <div className="wb__drawer-head">
            <span className={`wb__badge ${local ? 'wb__badge--local' : 'wb__badge--express'}`}>
              {local ? <Bike className="w-3.5 h-3.5" /> : <Package className="w-3.5 h-3.5" />}
              {local ? '同城配送' : '全国邮寄'}
            </span>
            <span><span className="wb__shortno">{shortNo(card.orderNo)}</span>{local && card.receiver.phone && <span className="wb__tail"> 尾号{card.receiver.phone.slice(-4)}</span>}</span>
            <button className="wb__iconbtn" onClick={closeDrawer} aria-label="关闭"><X className="w-4 h-4" /></button>
          </div>

          <div className="wb__drawer-body">
            {card.local?.cancelRequested && (
              <div className="wb__strip wb__strip--warn">
                <span>顾客申请取消{o?.cancelRequestNote ? `：${o.cancelRequestNote}` : ''}</span>
                {/* 详情刷新中/订单已离开看板时置灰：退款引导要用可退余额，这两种情况下
                    detail 要么还没落地要么已经是废弃的旧快照，点了要么弹不出、要么金额是错的 */}
                <button className="wb__iconbtn" disabled={!detail || detailRefreshing || gone} onClick={() => setModal({ kind: 'cancelRefund' })}>去处理</button>
              </div>
            )}

            {/* 备注放大（§5 第一项）；无备注同样必须写出来 */}
            {card.note ? <div className="wb__note wb__note--lg">{card.note}</div> : <div className="wb__nonote">无备注</div>}

            <div className="wb__block">
              <div className="wb__actions" style={{ alignItems: 'center' }}>
                <StatusBadge status={o?.status ?? card.status} />
                {local && d && <StatusBadge status={d.status} />}
                <span className={`wb__wait ${w.cls}`}>{w.text}</span>
                {local && d?.provider === 'SELF' && <span className="wb__meta">店内自送</span>}
              </div>
            </div>

            <div className="wb__block">
              <div className="wb__block-t">商品清单</div>
              {(o ? o.items : []).map((it, i) => (
                <div className="wb__item" key={i}>
                  <span className="wb__item-name">
                    {/* 赠品必须标：它 subtotal 是 0，不标的话店员看到「¥0.00」会以为是数据错误 */}
                    {it.isGift ? '赠 ' : ''}{it.productName}
                    {it.specText ? <span className="wb__item-spec"> {it.specText}</span> : null}
                  </span>
                  <span className="wb__qty">×{it.quantity}</span>
                  {/* 赠品金额列显示积分而不是 ¥0.00，与小票同口径 */}
                  <span className="wb__amt">{it.isGift ? `${(it.pointsCost ?? 0) * it.quantity} 积分` : `¥${yuan(it.subtotal)}`}</span>
                </div>
              ))}
              {!o && <div className="wb__empty">{detailLoading ? '加载中…' : '加载失败'}</div>}
            </div>

            <div className="wb__block">
              <div className="wb__block-t">收货信息</div>
              <div className="wb__line"><span>收货人</span><span>{o?.receiverName ?? card.receiver.name}</span></div>
              <div className="wb__line">
                <span>电话</span>
                <a className="wb__tel" style={{ color: chColor(card.channel) }} href={`tel:${o?.receiverPhone ?? card.receiver.phone}`}>{o?.receiverPhone ?? card.receiver.phone}</a>
              </div>
              <div className="wb__line"><span>地址</span><span style={{ textAlign: 'right' }}>{o?.receiverDisplayAddress ?? o?.receiverFullAddress ?? '--'}</span></div>
              {local ? (
                <>
                  {card.local?.distanceM != null && (
                    <div className="wb__line"><span>距离</span><span>{(card.local.distanceM / 1000).toFixed(1)} km</span></div>
                  )}
                  <div className="wb__line"><span>预计送达</span><span>{hhmm(o?.estimatedDeliveryAt)}</span></div>
                </>
              ) : (
                <>
                  <div className="wb__line"><span>快递公司</span><span>{o?.shipment?.expressCompany ?? card.express?.expressCompany ?? '未发货'}</span></div>
                  <div className="wb__line">
                    <span>运单号</span>
                    <span>
                      {o?.shipment?.expressNo ?? card.express?.expressNo ?? '--'}
                      {(o?.shipment?.expressNo ?? card.express?.expressNo) && (
                        <button className="wb__iconbtn" style={{ marginLeft: 6 }}
                          onClick={() => copyText((o?.shipment?.expressNo ?? card.express?.expressNo)!)}>
                          <Copy className="w-3 h-3" />复制
                        </button>
                      )}
                    </span>
                  </div>
                </>
              )}
            </div>

            {local && d && (
              <div className="wb__block">
                <div className="wb__block-t">配送员</div>
                <div className="wb__line"><span>配送单</span><span>{d.deliveryNo}</span></div>
                {/* 哪一家接的单——数据一直在库里（courierCompany 也在管理端白名单里），
                    只是从来没显示过。首单时店员完全不知道是闪送接的。 */}
                <div className="wb__line"><span>运力</span><span>{providerLabel(d.courierCompany)}</span></div>
                <div className="wb__line"><span>呼叫方式</span><span>{callStrategyLabel(d.callStrategy, d.calledProviders, d.courierCompany)}</span></div>
                <div className="wb__line"><span>姓名</span><span>{d.courierName ?? '未接单'}</span></div>
                <div className="wb__line">
                  <span>电话</span>
                  {d.courierMobile
                    ? <a className="wb__tel" style={{ color: chColor(card.channel) }} href={`tel:${d.courierMobile}`}>{d.courierMobile}</a>
                    : <span>--</span>}
                </div>
                {/* 骑手实时位置。距离是「直线 × 绕路系数」的估算，运力方不提供到目的地的道路距离，
                    所以文案一律带「约」——店员会拿这个数去答复顾客，不能让它看起来像精确值。 */}
                {courier?.location && (
                  <div className="wb__line">
                    <span>骑手位置</span>
                    <span style={{ textAlign: 'right' }}>
                      {courier.phase === 'TO_RECEIVER'
                        ? `距顾客约 ${km(courier.toReceiverM)}`
                        : `距店约 ${km(courier.toStoreM)}`}
                      {courier.etaMinutes != null && `　预计 ${courier.etaMinutes} 分钟${courier.phase === 'TO_RECEIVER' ? '送达' : '到店'}`}
                      {courier.fetchedAt && <><br /><span className="wb__muted">位置更新于 {hhmm(courier.fetchedAt)}</span></>}
                    </span>
                  </div>
                )}
                {/* 各家报价：最低价加「最低」标、中标方加「中标」标——「并呼让最贵的抢到」
                    这件事只有把两个标放在一起才看得出来（首单：最低 ¥16.23，中标 ¥23.32）。
                    优先用 orderFees（下单那一刻的真预扣），没有才退回呼叫前的报价快照。 */}
                {(() => {
                  const rows = d.orderFees?.length ? d.orderFees : (d.quoteSnapshot?.quotes ?? [])
                  if (!rows.length) return null
                  const min = Math.min(...rows.map((q) => q.feeFen))
                  return (
                    <div style={{ marginTop: 6 }}>
                      <div className="wb__line"><span>各家报价</span><span className="wb__muted">{d.orderFees?.length ? '下单预扣' : '呼叫前报价'}</span></div>
                      {[...rows].sort((a, b) => a.feeFen - b.feeFen).map((q) => (
                        <div className="wb__line" key={q.provider}>
                          <span>
                            {providerLabel(q.provider)}
                            {q.feeFen === min && <span className="wb__muted"> 最低</span>}
                            {q.provider === d.courierCompany && <span style={{ color: chColor(card.channel) }}> 中标</span>}
                          </span>
                          <span className="wb__fee">
                            ¥{yuan(q.feeFen)}
                            {q.distanceM != null && <span className="wb__muted"> · {km(q.distanceM)}</span>}
                          </span>
                        </div>
                      ))}
                    </div>
                  )
                })()}
                {d.failReason && <div className="wb__line"><span>失败原因</span><span>{d.failReason}</span></div>}
                {showEvents && (
                  <div style={{ marginTop: 6 }}>
                    {detail?.events.length
                      ? detail.events.map((ev) => (
                        <div className="wb__line" key={ev.id}>
                          <span>{dateTime(ev.createdAt)}</span>
                          <span style={{ textAlign: 'right' }}>{ev.statusDesc ?? ev.source}</span>
                        </div>
                      ))
                      : <div className="wb__empty">暂无进度记录</div>}
                  </div>
                )}
              </div>
            )}

            <div className="wb__block">
              <div className="wb__block-t">金额明细</div>
              <div className="wb__line"><span>商品小计</span><span className="wb__amt">¥{yuan(o?.totalAmount ?? 0)}</span></div>
              {/* 券在「小计」与「运费」之间——顺序与顾客在结算页看到的一致（小计→券→运费→实付），
                  也与小票上那三行一致。店员三处对账时能逐行对上，不用换算 */}
              {!!o?.discountAmount && <div className="wb__line"><span>优惠券</span><span className="wb__amt">-¥{yuan(o.discountAmount)}</span></div>}
              <div className="wb__line"><span>配送费/运费</span><span className="wb__amt">¥{yuan(o?.shippingFee ?? 0)}</span></div>
              <div className="wb__line"><span>顾客实付</span><span className="wb__amt">¥{yuan(o?.actualAmount ?? card.amountFen)}</span></div>
              {/* 赠品抵扣放在「实付」之后：它不参与上面那个加减法（赠品价 0、积分另算），
                  混进去会让店员以为实付里减过它 */}
              {!!o?.pointsUsed && <div className="wb__line"><span>赠品抵扣</span><span className="wb__amt">{o.pointsUsed} 积分</span></div>}
              {!!o?.refundedAmount && <div className="wb__line"><span>已退款</span><span className="wb__amt">-¥{yuan(o.refundedAmount)}</span></div>}
              {local && d && (
                <>
                  {/* 「下单预扣」而不是「运力报价」：并呼时每家各冻一笔，这一列是其中最低的那笔，
                      不是中标方扣的钱。首单就是在这里显示 ¥16.23（达达报价）而实扣 ¥23.32（闪送）。 */}
                  <div className="wb__line"><span>下单预扣</span><span className="wb__amt">{d.quotedFee != null ? `¥${yuan(d.quotedFee)}` : '--'}</span></div>
                  <div className="wb__line">
                    <span>实扣（中标）</span>
                    <span className="wb__amt">{d.actualFee != null ? `¥${yuan(d.actualFee)}` : <span className="wb__muted">待接单</span>}</span>
                  </div>
                  {d.tipFee > 0 && <div className="wb__line"><span>已加小费</span><span className="wb__amt">¥{yuan(d.tipFee)}</span></div>}
                  {d.cancelFee > 0 && <div className="wb__line"><span>取消费</span><span className="wb__amt">¥{yuan(d.cancelFee)}</span></div>}
                  {/* 本单配送总成本：含自动升级留下的那张已取消配送单的取消费，
                      所以不能只看当前这一张（服务端 costFen 已按全部配送单聚合） */}
                  {!!detail && detail.costFen !== (d.actualFee ?? d.quotedFee ?? 0) + d.tipFee + d.cancelFee && (
                    <div className="wb__line"><span>配送成本合计</span><span className="wb__amt">¥{yuan(detail.costFen)}</span></div>
                  )}
                </>
              )}
            </div>

            <div className="wb__block">
              <div className="wb__line">
                <span>订单号</span>
                <span>
                  {card.orderNo}
                  <button className="wb__iconbtn" style={{ marginLeft: 6 }} onClick={() => copyText(card.orderNo)}>
                    <Copy className="w-3 h-3" />复制
                  </button>
                </span>
              </div>
              <div className="wb__line"><span>下单</span><span>{dateTime(o?.createdAt)}</span></div>
              <div className="wb__line"><span>付款</span><span>{dateTime(o?.paidAt)}</span></div>
              <div className="wb__line"><span>接单</span><span>{dateTime(o?.acceptedAt)}</span></div>
              {!!o?.completedAt && <div className="wb__line"><span>完成</span><span>{dateTime(o.completedAt)}</span></div>}
            </div>
          </div>

          <div className="wb__drawer-foot">
            <div className="wb__actions">{renderActions()}</div>
            {/* 重打小票：同城才是最需要它的地方 —— 票是 2 联（厨房 + 骑手），
                丢一张骑手就没地址。放抽屉不放卡片，是因为它低频且会真出纸，
                跟拒单同一个取向（§7：低频操作放抽屉，卡片上容易误点）。
                不弹确认框：多打一张纸不是危险操作，而票丢了店员是急着要的。 */}
            <button
              className="wb__reject"
              style={{ borderColor: '#d4d4d8', color: '#52525b' }}
              disabled={reprinting}
              title="重打该单小票（票卡纸 / 被撕坏 / 没看见时用）"
              onClick={async () => {
                setReprinting(true)
                try {
                  const r = await reprintOrder(card.orderId)
                  toast[r.enqueued ? 'success' : 'error'](
                    r.enqueued
                      ? '已发送重打'
                      : { PRINTER_DISABLED: '打印机功能未启用', NO_PRINTER_CONFIGURED: '该单所属渠道尚未配置打印机' }[r.reason ?? ''] ?? '重打失败'
                  )
                } catch (err: unknown) {
                  toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '重打失败')
                } finally {
                  setReprinting(false)
                }
              }}
            >{reprinting ? '发送中…' : '重打小票'}</button>
            {/* 拒单入口只在抽屉底部（§7）：低频但要退款，放卡片上容易误点 */}
            {canReject && (
              // 同样的道理：刷新窗口内 canReject 是按旧 detail.order.status 算出来的，
              // 订单已离开看板时更是对着废弃状态操作，两种情况都先置灰
              <button className="wb__reject" disabled={detailRefreshing || gone} onClick={() => setModal({ kind: 'reject' })}>拒单并全额退款</button>
            )}
          </div>
        </aside>
      </>
    )
  }

  const renderModal = (): ReactNode => {
    if (!modal) return null
    const card = drawer?.card
    const o = detail?.order
    const d = detail?.delivery ?? null
    const ch: Channel = card?.channel ?? 'LOCAL'
    const close = () => setModal(null)
    if (modal.kind === 'confirm') return <ConfirmModal spec={modal.spec} onClose={close} onDone={afterAction} />
    // 退出不依赖抽屉里的订单详情，必须在 !o || !card 的早退之前处理——顶栏随时可能点「退出工作台」
    if (modal.kind === 'exit') {
      return (
        <WbModal
          title="退出工作台？"
          onClose={close}
          footer={
            <>
              <button className="wb__btn wb__btn--ghost" onClick={close}>留在工作台</button>
              <button className="wb__btn wb__btn--neutral" onClick={() => { close(); navigate('/dashboard') }}>
                退出
              </button>
            </>
          }
        >
          {/* 这句不能改：不写清楚，店员会以为退出就收不到来单提醒，于是没人敢退（§8） */}
          <p>工作台仍在后台接单、出票和播报，退出不影响来单提醒</p>
        </WbModal>
      )
    }
    if (!o || !card) return null
    switch (modal.kind) {
      case 'cancelDelivery':
        return <CancelDeliveryModal orderId={o.id} channel={ch} title={modal.title} onClose={close} onDone={afterAction} />
      case 'tip':
        return <TipModal orderId={o.id} tippedFen={d?.tipFee ?? 0} limits={settings?.tip ?? null} onClose={close} onDone={afterAction} />
      case 'ship':
        return <ShipModal order={o} onClose={close} onDone={afterAction} />
      case 'self':
        return <SelfDeliverModal orderId={o.id} defaultPhone={settings?.store.phone ?? ''} onClose={close} onDone={afterAction} />
      case 'reject':
        return <RejectModal order={o} channel={ch} onClose={close} onDone={async (m) => { await afterAction(m); closeDrawer() }} />
      case 'cancelRefund':
        return (
          <CancelAndRefundModal
            orderId={o.id}
            orderNo={o.orderNo}
            amountFen={o.remainingRefundable}
            channel={ch}
            deliveryStatusLabel={card.local?.delivery?.statusLabel ?? null}
            hasActiveDelivery={!!d && d.activeOrderId === o.id && !TERMINAL_DELIVERY.includes(d.status)}
            onClose={close}
            onDone={async () => { await afterAction('已取消配送并退款'); closeDrawer() }}
          />
        )
      default:
        return null
    }
  }

  // 连续 2 拍轮询失败才算「断线」，别为偶发一次抖动就提醒；分钟数按服务端锚点算（I1）。
  // -1 是「从没成功连接过」的哨兵值，跟「连接过、断了 N 分钟」区分开，文案不同
  const staleMinutes = pollFailCount >= 2 ? (lastOkAt != null ? Math.floor((now - lastOkAt) / 60000) : -1) : null

  return (
    <div className={`wb ${focus ? 'wb--focus' : ''}`} data-theme={theme ?? undefined} ref={rootRef}>
      {isPhone ? (
        <PhoneTopBar
          snap={snap} shopName={settings?.store.name || '接单工作台'}
          onExplain={() => setSheet('explain')} onMenu={() => setSheet('menu')}
        />
      ) : (
        <TopBar
          snap={snap} shopName={settings?.store.name || '接单工作台'} targetTheme={nextTheme(theme)} onToggleTheme={toggleTheme}
          focus={focus} isFullscreen={isFullscreen} onFullscreen={toggleFullscreen} onExit={exitWorkbench}
        />
      )}

      {/* 紧贴顶栏之下，两种模式共用：断线提示与熔断横幅在手机上同样要出现，
          «恢复» 是余额充值后唯一的入口，藏在桌面顶栏里等于手机上没有。
          位置也要紧跟顶栏——排到图例下面会把这一屏最紧急的一条压到第三行去。 */}
      <TopAlerts snap={snap} staleMinutes={staleMinutes} onResetCircuit={() => void resetCircuit()} circuitBusy={circuitBusy} />

      {isPhone ? (
        <ColumnTabs snap={snap} active={phoneCol} onPick={setPhoneCol} />
      ) : (
        /* 图例常驻（§3）；专注模式下让位给看板。
           两组颜色分工写在屏幕上：左边一组是「这是什么单」（永不变），右边一组是「急不急」（会变）。
           不写的话，新店员看到一张烧红的邮寄单，第一反应会是「这是同城吧？」 */
        <div className="wb__legend"><LegendContent /></div>
      )}

      <div className={`wb__board${doneOpen ? ' wb__board--done-open' : ''}`} ref={boardRef}>
        {(isPhone ? COLUMNS.filter((c) => c.key === phoneCol) : COLUMNS).map((col) => {
          // 顺序由服务端排定（同城恒上），前端只按数组顺序渲染，不再排一次
          const list = snap ? snap.columns[col.key] : []
          // 「已完成」默认折叠成一条窄边栏（PO 2026-09-07 定）：这一列里没有任何待办，
          // 却常年占着和前四列一样的宽度。收起来之后干活的四列各自变宽约 25%，
          // 卡片上的地址、备注、骑手电话少折一行。默认每次进页面都是收起的——
          // 不记忆展开状态：每天开工看到的应该是干净的四列，想看完成情况点开即可。
          // 折叠成竖条是桌面的做法；手机上「已完成」就是切换条里的最后一格，
          // 不折叠也不占位——否则 grid-auto-columns 会把它撑成整屏宽的空白（改造前的 bug）
          const collapsed = !isPhone && col.key === 'done' && !doneOpen
          if (collapsed) {
            return (
              <section className="wb__col wb__col--collapsed" key={col.key}
                onClick={() => setDoneOpen(true)} title="点击展开已完成">
                <div className="wb__col-collapsed-inner">
                  <span className="wb__col-count">{list.length}</span>
                  <span className="wb__col-collapsed-t">{col.title}</span>
                </div>
              </section>
            )
          }
          return (
            <section className="wb__col" key={col.key}>
              <div className="wb__col-head">
                <span>{col.title}</span>
                <span className="wb__col-count">{list.length}</span>
                {col.key === 'done' && (
                  <button className="wb__iconbtn" onClick={() => setDoneOpen(false)}>收起</button>
                )}
              </div>
              {/* 卡片区单独滚动：每列各滚各的，列头和另外四列都不动。
                  整页滚的话，滑到备餐中的第 12 张，待接单那一列就被推出屏幕了——
                  而「有没有新单等着接」恰恰是这一屏最不能丢的信息。 */}
              <div className="wb__col-body">
                {list.length === 0
                  ? <div className="wb__empty">{snap ? '暂无订单' : '加载中…'}</div>
                  : list.map((c) => (
                    <Card
                      key={c.orderId} card={c} colKey={col.key} now={now}
                      onOpen={() => openCard(c, col.key)}
                      graceMin={snap?.acceptGraceMin ?? 0}
                      prepMin={prepMin}
                      onHandleCancel={() => openCard(c, col.key, true)}
                    />
                  ))}
              </div>
            </section>
          )
        })}
      </div>

      {/* 底部这行是唯一写明「多久算久」的地方。原来写死 3/6 分钟，改成按列给预算之后
          必须跟着改——不然店员照着这行读，看到备餐中 10 分钟还没变色会以为页面坏了。
          手机上它和图例一起收进顶栏的「?」。 */}
      {!isPhone && <div className="wb__hint"><HintContent prepMin={prepMin} /></div>}

      {sheet === 'explain' && (
        <WbModal title="颜色和时间怎么看" onClose={() => setSheet(null)}
          footer={<button className="wb__btn wb__btn--ghost" onClick={() => setSheet(null)}>知道了</button>}>
          <div className="wb__sheet-legend"><LegendContent /></div>
          <div className="wb__hint" style={{ display: 'block', padding: '12px 0 0' }}>
            <HintContent prepMin={prepMin} />
          </div>
        </WbModal>
      )}

      {sheet === 'menu' && (
        <WbModal title="工作台" onClose={() => setSheet(null)}
          footer={<button className="wb__btn wb__btn--ghost" onClick={() => setSheet(null)}>关闭</button>}>
          <div className="wb__sheet-row"><span>今日单数</span><b>{snap?.stats.todayOrders ?? '--'}</b></div>
          <div className="wb__sheet-row"><span>营业额</span><b>¥{snap ? yuan(snap.stats.todayRevenueFen) : '--'}</b></div>
          <div className="wb__sheet-row">
            <span>平均送达</span>
            <b>{snap?.stats.avgDeliverMinutes != null ? `${snap.stats.avgDeliverMinutes} 分` : '--'}</b>
          </div>
          <div className="wb__actions" style={{ paddingTop: 12 }}>
            {/* 文案说的是「点了会变成什么」，与桌面顶栏同一套口径（§8） */}
            <button className="wb__btn wb__btn--ghost" onClick={toggleTheme}>
              {nextTheme(theme) === 'dark' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
              {nextTheme(theme) === 'dark' ? '深色' : '浅色'}
            </button>
            <button className="wb__btn wb__btn--ghost" onClick={toggleFullscreen}>
              <Maximize className="w-4 h-4" />{isFullscreen ? '退出全屏' : focus ? '退出专注' : '全屏'}
            </button>
            {/* 先收起本层再走退出确认，避免弹层叠弹层 */}
            <button className="wb__btn wb__btn--ghost" onClick={() => { setSheet(null); exitWorkbench() }}>
              <LogOut className="w-4 h-4" />退出工作台
            </button>
          </div>
        </WbModal>
      )}

      {renderDrawer()}
      {renderModal()}
    </div>
  )
}
