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
import { Bell, Bike, CircleAlert, Copy, LogOut, Maximize, Moon, Package, Phone, Printer, Sun, X } from 'lucide-react'
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
import { fmtHHmm, fmtMonthDayTime, fmtMonthDayCn } from '../utils/time'
import { providerLabel, callStrategyLabel } from '../utils/providers'

type ColKey = keyof WorkbenchSnapshot['columns']

const COLUMNS: { key: ColKey; title: string }[] = [
  { key: 'pending', title: '待接单' }, { key: 'preparing', title: '备餐中' },
  { key: 'waitingCourier', title: '等待配送员' }, { key: 'delivering', title: '配送中' },
  { key: 'done', title: '已完成' },
]

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
const TIP_STEPS = [200, 500, 1000, 2000]
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

/** 等待胶囊：m:ss 等宽数字；>3:00 琥珀、>6:00 红底白字（§4）—— 按秒比较，3:00/6:00 整点不提前变色 */
function waitLabel(sinceIso: string, now: number): { text: string; cls: string } {
  const sec = Math.max(0, Math.floor((now - Date.parse(sinceIso)) / 1000))
  const min = Math.floor(sec / 60)
  const text = `${min}:${String(sec % 60).padStart(2, '0')}`
  return { text, cls: sec > 360 ? 'wb__wait--danger' : sec > 180 ? 'wb__wait--warn' : '' }
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
   * 收一个「把最新最低价报上来」的回调：报价块里点刷新之后，确认键上的运力名与金额
   * 必须跟着变——spec 是点击那一刻存进 state 的，不回传就会停在旧数字上。
   */
  extra?: (onLowest: (l: { provider: string; feeFen: number } | null) => void) => ReactNode
  /** 有实时最低价时用它生成确认键文案；没有就退回 confirmText */
  confirmTextOf?: (lowest: { provider: string; feeFen: number }) => string
  confirmText: string
  okMsg: string
  run: () => Promise<unknown>
}

/**
 * 呼叫弹窗里的报价块（UI spec §6b）。
 *
 * 自己持有并刷新报价，不从外面接一个快照进来——弹窗的 spec 是点击那一刻存进 state 的，
 * 外层 detail 再刷新也不会传导进来，接快照会得到一个点完刷新还显示旧数字的按钮。
 *
 * batchPrice 免费、不下单、不落库，所以刷新按钮可以随便点。
 */
function CallQuoteBlock({ orderId, initial, onLowest }: {
  orderId: number
  initial: { snapshot: QuoteSnapshot | null; quotedAt: string | null; stale: boolean } | null
  onLowest: (l: { provider: string; feeFen: number } | null) => void
}) {
  const [q, setQ] = useState(initial)
  const [busy, setBusy] = useState(false)
  // 把「当前这份报价的最低价」报给弹窗，让确认键上的运力名与金额始终与眼前这块一致。
  // 报价已过期时报 null：过期意味着服务端在真正下单前会自己重查一次，那时挑中的
  // 可能是另一家——此刻在按钮上写死一个价就是空头承诺。
  useEffect(() => {
    onLowest(q?.stale ? null : q?.snapshot?.lowest ?? null)
  }, [q, onLowest])
  const refresh = async () => {
    setBusy(true)
    try {
      const r = await refreshOrderQuote(orderId)
      setQ({ snapshot: r.data.data.snapshot, quotedAt: r.data.data.quotedAt, stale: false })
    } catch { /* 查价失败不影响呼叫本身：呼叫时服务端还会自己再查一次 */ }
    finally { setBusy(false) }
  }
  const quotes = q?.snapshot?.quotes ?? []
  if (!quotes.length) {
    return (
      <div className="wb__quote">
        <span className="wb__muted">暂无报价（呼叫时会自动查一次）</span>
        <button className="wb__iconbtn" onClick={() => void refresh()} disabled={busy}>{busy ? '查价中…' : '↻ 查价'}</button>
      </div>
    )
  }
  const min = Math.min(...quotes.map((x) => x.feeFen))
  return (
    <div className={`wb__quote${q?.stale ? ' wb__quote--stale' : ''}`}>
      <div className="wb__quote-head">
        <span>{q?.stale ? '报价已过期' : '当前报价'}</span>
        <button className="wb__iconbtn" onClick={() => void refresh()} disabled={busy}>{busy ? '查价中…' : '↻ 刷新'}</button>
      </div>
      {[...quotes].sort((a, b) => a.feeFen - b.feeFen).map((x) => (
        <div className="wb__line" key={x.provider}>
          <span>{providerLabel(x.provider)}{x.feeFen === min && <span className="wb__muted"> 最低</span>}</span>
          <span className="wb__fee">¥{yuan(x.feeFen)}</span>
        </div>
      ))}
    </div>
  )
}

function ConfirmModal({ spec, onClose, onDone }: { spec: ConfirmSpec; onClose: () => void; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 报价块回传的实时最低价（点了刷新之后会变）。useCallback 定住引用，
  // 否则每次渲染都是新函数，会把子组件的 useEffect 变成无限循环。
  const [liveLowest, setLiveLowest] = useState<{ provider: string; feeFen: number } | null>(null)
  const onLowest = useCallback((l: { provider: string; feeFen: number } | null) => setLiveLowest(l), [])
  const confirmText = liveLowest && spec.confirmTextOf ? spec.confirmTextOf(liveLowest) : spec.confirmText
  const submit = async () => {
    setBusy(true); setError('')
    try { await spec.run(); onDone(spec.okMsg) }
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
      {spec.extra?.(onLowest)}
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
  const options = TIP_STEPS.filter((v) => v <= maxPerCall && v <= remain)
  const [amount, setAmount] = useState(() => options.find((v) => v === 500) ?? options[0] ?? 0)
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
          <FillButton channel="LOCAL" onClick={submit} disabled={busy || amount <= 0}>
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
      <div className="wb__actions">
        {options.map((v) => (
          <button key={v} className={`wb__btn ${v === amount ? 'wb__btn--fill' : 'wb__btn--ghost'}`}
            style={v === amount ? { background: chColor('LOCAL') } : undefined} onClick={() => setAmount(v)}>
            ¥{yuan(v)}
          </button>
        ))}
      </div>
      <div className="wb__amber">
        本次 ¥{yuan(amount)}。单次上限 ¥{(maxPerCall / 100).toFixed(0)}，本单已加 ¥{yuan(tippedFen)}，累计上限 ¥{(maxPerOrder / 100).toFixed(0)}。
      </div>
      {remain <= 0 && <div className="wb__redbar">本单小费已到累计上限，无法再加。</div>}
      {remain > 0 && options.length === 0 && (
        <div className="wb__redbar">本单小费剩余额度不足最小档位 ¥{(TIP_STEPS[0] / 100).toFixed(0)}，无法再加。</div>
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
function Card({ card, colKey, now, graceMin, onOpen, onHandleCancel }: {
  card: WorkbenchCard; colKey: ColKey; now: number
  /** 顾客可申请取消 / 店员可处理的窗口（分钟，接单起算），用来算「还剩多久自动回绝」 */
  graceMin: number
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
  const w = colKey === 'done' ? { text: `完成于 ${hhmm(card.waitSince)}`, cls: '' } : waitLabel(card.waitSince, now)
  // 距离来自运力方的报价/接单回执（providerDistanceM）。没呼叫配送员时它必然是 null，
  // 印一行「距离 --」只是在卡片上占一格空话，所以整行不渲染（PO 2026-09-07）。
  const kmText = card.local?.distanceM != null ? `${(card.local.distanceM / 1000).toFixed(1)} km` : null
  return (
    <div
      className={`wb__card ${local ? 'wb__card--local' : 'wb__card--express'} ${alert ? 'wb__card--alert' : ''}`}
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

      <div className="wb__no"><span className="wb__shortno">{shortNo(card.orderNo)}</span><b>¥{yuan(card.amountFen)}</b></div>
      <div className="wb__items">{itemsSummary(card.items, card.channel)}</div>

      {/* 无备注必须明写，留空则「没看见」与「没有」无法区分（§4） */}
      {card.note ? <div className="wb__note">{card.note}</div> : <div className="wb__nonote">无备注</div>}

      <div className="wb__fields">
        {local ? (
          <>
            {kmText && <span>距离 {kmText}</span>}
            <span>骑手 {d?.courierName ? `${d.courierName}${d.courierMobile ? ` ${d.courierMobile}` : ''}` : (d ? d.statusLabel : '未呼叫')}</span>
            <span>预计送达 {hhmm(card.local?.estimatedDeliveryAt)}</span>
          </>
        ) : (
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
  snap, shopName, targetTheme, onToggleTheme, focus, isFullscreen, onFullscreen, onExit, onResetCircuit, circuitBusy, staleMinutes,
}: {
  snap: WorkbenchSnapshot | null; shopName: string; targetTheme: 'light' | 'dark'
  onToggleTheme: () => void; focus: boolean; isFullscreen: boolean; onFullscreen: () => void; onExit: () => void
  onResetCircuit: () => void; circuitBusy: boolean
  /** 连续轮询失败达到阈值时的「已停摆多久」；null = 正常（I1） */
  staleMinutes: number | null
}) {
  const today = new Date()
  const openState = !snap ? { text: '加载中', cls: '' }
    : snap.paused ? { text: `已暂停：${snap.paused.reason || '手动暂停'}`, cls: 'wb__dot--danger' }
      : !snap.localEnabled ? { text: '同城已关闭', cls: '' }
        : snap.localOpenNow ? { text: '营业中', cls: 'wb__dot--ok' } : { text: '非营业时间', cls: 'wb__dot--warn' }
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
    quote: { snapshot: QuoteSnapshot | null; quotedAt: string | null; stale: boolean } | null
    costFen: number
  } | null>(null)
  // 骑手实时位置：只在骑手真的上路的那几个状态下轮询，抽屉一关就停（见下面的 useEffect）
  const [courier, setCourier] = useState<CourierLive | null>(null)
  // 已完成列默认收起（见下面渲染处的注释）。刻意不持久化：每天开工都是干净的四列。
  const [doneOpen, setDoneOpen] = useState(false)
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
    setDetailLoading(true)
    try {
      const [o, d] = await Promise.all([getOrder(orderId), channel === 'LOCAL' ? getOrderDelivery(orderId) : null])
      setDetail({
        order: o.data.data,
        delivery: d?.data.data.delivery ?? null,
        events: d?.data.data.events ?? [],
        quote: d?.data.data.quote ?? null,
        costFen: d?.data.data.costFen ?? 0,
      })
    } catch (e) {
      toast.error(apiMessage(e, '订单详情加载失败'))
      // 卡片「去处理」把标志位置了 true，详情却加载失败：不复位的话下一次任意一次成功加载都会莫名弹出退款引导
      setPendingCancelRefund(false)
    } finally { setDetailLoading(false) }
  }, [])

  const openCard = (card: WorkbenchCard, colKey: ColKey, wantCancelRefund = false) => {
    setDrawer({ card, colKey })
    setDetail(null); setShowEvents(false); setModal(null)
    setPendingCancelRefund(wantCancelRefund)
    void loadDetail(card.orderId, card.channel)
  }

  const closeDrawer = () => { setDrawer(null); setDetail(null); setModal(null); setPendingCancelRefund(false); setCourier(null) }

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

  // 快照刷新后把抽屉里的卡片换成新的一份（订单可能已经换列）
  useEffect(() => {
    if (!snap || !drawer) return
    for (const col of COLUMNS) {
      const found = snap.columns[col.key].find((c) => c.orderId === drawer.card.orderId)
      if (found) {
        if (found !== drawer.card || col.key !== drawer.colKey) setDrawer({ card: found, colKey: col.key })
        return
      }
    }
  }, [snap, drawer])

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
    const { card, colKey } = drawer
    const { order, delivery } = detail
    const ch = card.channel
    const active = delivery && delivery.activeOrderId === order.id && !TERMINAL_DELIVERY.includes(delivery.status)
      ? delivery : null
    const confirm = (spec: ConfirmSpec) => setModal({ kind: 'confirm', spec })
    // 「实际约 ¥5–8」这句已被实测推翻（2026-09-06 首单 8.94 km 实扣 ¥23.32，1.1 km 那组
    // 最贵的也报 ¥11.22），改成不给死数字，让店员看下面报价块里的真实金额。
    const CALL_AMBER = '会预扣配送费，实际以中标运力的预扣为准。若之后取消已接单的骑手，可能产生约 ¥2 取消费。'
    // 呼叫方式来自设置（默认只呼最低价）。拿不到设置时按「并呼」措辞——宁可文案保守，
    // 也不要让店员以为只花一家的钱、结果按并呼冻结了 N 笔。
    const solo = settings?.callStrategy?.mode === 'SOLO_LOWEST'
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
     * 呼叫确认弹窗。文案随呼叫方式变——「只呼最低价」和「并呼」在**花多少钱**上差一个数量级
     * （首单实测：并呼 7 家一次冻结 ¥75.08，只呼一家冻 ¥16.23），店员按下去之前必须知道是哪种。
     * `hasQuote=false` 用于「接单并呼叫」：那一刻还没查过价，报价块给不出数字，只能说明会先查价。
     */
    const callSpec = (title: string, confirmText: string, what: string, run: () => Promise<unknown>, hasQuote = true): ConfirmSpec => {
      return {
        title, channel: ch,
        // 确认键上带运力名与金额，是「按下去要花多少钱」最后一道提示。
        // 金额取**弹窗里那块报价当前显示的**最低价（点了刷新会跟着变），而不是打开抽屉那一刻
        // 的快照；报价过期时 CallQuoteBlock 会报 null，这里就退回不带金额的通用文案——
        // 过期意味着服务端下单前会自己重查，此刻写死一个价就是空头承诺。
        confirmTextOf: solo && hasQuote
          ? (l) => `呼叫${providerLabel(l.provider)} ¥${yuan(l.feeFen)}`
          : undefined,
        confirmText,
        okMsg: '已呼叫骑手',
        what: solo
          ? (hasQuote
            ? `${what}按最低价只呼一家${escalateMin > 0 ? `，约 ${escalateMin} 分钟无人接自动改为并呼全部运力` : ''}。`
            : `${what}接单后先查价，再按最低价只呼一家。`)
          : `${what}并呼设置里的全部运力，谁先接算谁的。`,
        customer: '顾客看到「正在为您呼叫骑手」。',
        cost: solo
          ? '只冻结这一家的配送费。'
          : '每一家各冻结一笔预扣，只有中标那家最终扣款，其余释放。',
        extra: hasQuote
          ? (onLowest) => <CallQuoteBlock orderId={order.id} initial={detail?.quote ?? null} onLowest={onLowest} />
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
            () => callRider(order.id),
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

  // ── 详情抽屉（§5）──
  const renderDrawer = (): ReactNode => {
    if (!drawer) return null
    const { card, colKey } = drawer
    const local = card.channel === 'LOCAL'
    const o = detail?.order
    const d = detail?.delivery ?? null
    // 与卡片同规则：已完成不再用会变色的等待胶囊（I7）
    const w = colKey === 'done' ? { text: `完成于 ${hhmm(card.waitSince)}`, cls: '' } : waitLabel(card.waitSince, now)
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
            <span className="wb__shortno">{shortNo(card.orderNo)}</span>
            <button className="wb__iconbtn" onClick={closeDrawer} aria-label="关闭"><X className="w-4 h-4" /></button>
          </div>

          <div className="wb__drawer-body">
            {card.local?.cancelRequested && (
              <div className="wb__strip wb__strip--warn">
                <span>顾客申请取消{o?.cancelRequestNote ? `：${o.cancelRequestNote}` : ''}</span>
                <button className="wb__iconbtn" disabled={!detail} onClick={() => setModal({ kind: 'cancelRefund' })}>去处理</button>
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
              <button className="wb__reject" onClick={() => setModal({ kind: 'reject' })}>拒单并全额退款</button>
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
      <TopBar
        snap={snap} shopName={settings?.store.name || '接单工作台'} targetTheme={nextTheme(theme)} onToggleTheme={toggleTheme}
        focus={focus} isFullscreen={isFullscreen} onFullscreen={toggleFullscreen} onExit={exitWorkbench}
        onResetCircuit={() => void resetCircuit()} circuitBusy={circuitBusy} staleMinutes={staleMinutes}
      />

      {/* 图例常驻（§3）；专注模式下让位给看板 */}
      <div className="wb__legend">
        <span className="wb__badge wb__badge--local"><Bike className="w-3.5 h-3.5" />同城配送</span>
        <span>骑手送，晚十分钟菜就凉了——每列里恒排在邮寄单上面</span>
        <span className="wb__badge wb__badge--express"><Package className="w-3.5 h-3.5" />全国邮寄</span>
        <span>快递发出，可以稍后处理</span>
      </div>

      <div className={`wb__board${doneOpen ? ' wb__board--done-open' : ''}`} ref={boardRef}>
        {COLUMNS.map((col) => {
          // 顺序由服务端排定（同城恒上），前端只按数组顺序渲染，不再排一次
          const list = snap ? snap.columns[col.key] : []
          // 「已完成」默认折叠成一条窄边栏（PO 2026-09-07 定）：这一列里没有任何待办，
          // 却常年占着和前四列一样的宽度。收起来之后干活的四列各自变宽约 25%，
          // 卡片上的地址、备注、骑手电话少折一行。默认每次进页面都是收起的——
          // 不记忆展开状态：每天开工看到的应该是干净的四列，想看完成情况点开即可。
          const collapsed = col.key === 'done' && !doneOpen
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
              {list.length === 0
                ? <div className="wb__empty">{snap ? '暂无订单' : '加载中…'}</div>
                : list.map((c) => (
                  <Card
                    key={c.orderId} card={c} colKey={col.key} now={now}
                    onOpen={() => openCard(c, col.key)}
                    graceMin={snap?.acceptGraceMin ?? 0}
                    onHandleCancel={() => openCard(c, col.key, true)}
                  />
                ))}
            </section>
          )
        })}
      </div>

      <div className="wb__hint">
        等待时长从进入本列时算起：超过 3 分钟转琥珀，超过 6 分钟转红底。卡片变红框 = 顾客申请取消或配送异常，先处理它。
      </div>

      {renderDrawer()}
      {renderModal()}
    </div>
  )
}
