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
  Channel, DeliveryEventInfo, DeliveryInfo, LocalDeliverySettings, Order, OrderItem, RejectReason,
  WorkbenchCard, WorkbenchSnapshot,
} from '../types'
import {
  acceptAndCallLocalOrder, acceptLocalOrder, acceptOrder, addDeliveryTip, callRider, cancelDelivery,
  getLocalSettings, getOrder, getOrderDelivery, getWorkbenchSnapshot, markOrderDelivered, precancelDelivery,
  rejectOrder, resetKd100Circuit, selfDeliverOrder, shipOrder, voidUnknownDelivery,
} from '../api/admin'
import StatusBadge from '../components/ui/StatusBadge'
import { toast } from '../components/ui/Toast'
import { confirmDialog } from '../components/ui/ConfirmDialog'
import CancelAndRefundModal from '../components/CancelAndRefundModal'

type ColKey = keyof WorkbenchSnapshot['columns']

const COLUMNS: { key: ColKey; title: string }[] = [
  { key: 'pending', title: '待接单' }, { key: 'preparing', title: '备餐中' },
  { key: 'waitingCourier', title: '等待配送员' }, { key: 'delivering', title: '配送中' },
  { key: 'done', title: '已完成' },
]

/** 配送单已结束（不再是「在途」）的三个终态 */
const TERMINAL_DELIVERY = ['DELIVERED', 'CANCELLED', 'FAILED']
const EXPRESS_COMPANIES = ['顺丰速运', '京东物流', '中通快递', '圆通速递', '韵达快递', '申通快递', '极兔速递', '邮政 EMS', '德邦快递']
const TIP_STEPS = [200, 500, 1000, 2000]
const OTHER_COMPANY = '__other__'

const yuan = (fen: number) => (fen / 100).toFixed(2)
const chColor = (c: Channel) => (c === 'LOCAL' ? 'var(--local)' : 'var(--express)')
/** 服务端错误码 42221/42225/42228/42232-42238 的 message 是写给店员看的，不能吞掉换成「操作失败」 */
const apiMessage = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback
const apiCode = (e: unknown) => (e as { response?: { data?: { code?: number } } })?.response?.data?.code

function hhmm(iso: string | null | undefined) {
  if (!iso) return '--'
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function dateTime(iso: string | null | undefined) {
  if (!iso) return '--'
  const d = new Date(iso)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${hhmm(iso)}`
}

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
function WbModal({ title, children, footer, onClose }: {
  title: string; children: ReactNode; footer: ReactNode; onClose: () => void
}) {
  return (
    <div className="wb__modal-mask" role="dialog" aria-modal="true">
      <div className="wb__modal">
        <div className="wb__modal-head">
          <span>{title}</span>
          <button className="wb__iconbtn" onClick={onClose} aria-label="关闭"><X className="w-4 h-4" /></button>
        </div>
        <div className="wb__modal-body">{children}</div>
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
  confirmText: string
  okMsg: string
  run: () => Promise<unknown>
}

function ConfirmModal({ spec, onClose, onDone }: { spec: ConfirmSpec; onClose: () => void; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
      footer={
        <>
          <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>再想想</button>
          <FillButton channel={spec.channel} onClick={submit} disabled={busy}>
            {busy ? '处理中…' : spec.confirmText}
          </FillButton>
        </>
      }
    >
      <WhatBlock what={spec.what} customer={spec.customer} cost={spec.cost} />
      {spec.amber && <div className="wb__amber">{spec.amber}</div>}
      {error && <div className="wb__redbar">{error}</div>}
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
      {error && <div className="wb__redbar">{error}</div>}
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
      {error && <div className="wb__redbar">{error}</div>}
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
      {error && <div className="wb__redbar">{error}</div>}
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
      {error && <div className="wb__redbar">{error}</div>}
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
      await rejectOrder(order.id, {
        reason,
        note: note.trim() || undefined,
        soldOutProductIds: reason === 'SOLD_OUT' ? soldOut : undefined,
      })
      onDone('已拒单并发起退款')
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
      {error && <div className="wb__redbar">{error}</div>}
    </WbModal>
  )
}

// ─────────────────────────────────────────────────────────
// 卡片（§3/§4）：三重编码 = 4px 色条 + 徽章（图标+文字）+ 渠道各自的字段
// ─────────────────────────────────────────────────────────
function Card({ card, now, onOpen, onHandleCancel }: {
  card: WorkbenchCard; now: number; onOpen: () => void; onHandleCancel: () => void
}) {
  const local = card.channel === 'LOCAL'
  const d = card.local?.delivery ?? null
  const badFlow = !!d && ['ABNORMAL', 'UNKNOWN', 'FAILED'].includes(d.status)
  const alert = !!card.local && (card.local.cancelRequested || badFlow)
  const w = waitLabel(card.waitSince, now)
  const km = card.local?.distanceM != null ? `${(card.local.distanceM / 1000).toFixed(1)} km` : '--'
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

      <div className="wb__no"><span>{card.orderNo}</span><b>¥{yuan(card.amountFen)}</b></div>
      <div className="wb__items">{itemsSummary(card.items, card.channel)}</div>

      {/* 无备注必须明写，留空则「没看见」与「没有」无法区分（§4） */}
      {card.note ? <div className="wb__note">{card.note}</div> : <div className="wb__nonote">无备注</div>}

      <div className="wb__fields">
        {local ? (
          <>
            <span>距离 {km}</span>
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

      {card.local?.cancelRequested && (
        <div className="wb__strip wb__strip--warn">
          <span>顾客申请取消</span>
          <button className="wb__iconbtn" onClick={(e) => { e.stopPropagation(); onHandleCancel() }}>去处理</button>
        </div>
      )}
      {badFlow && d && (
        <div className="wb__strip wb__strip--danger">
          <span><CircleAlert className="w-3.5 h-3.5 inline" /> {d.statusLabel}</span>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// 顶栏（§8）
// ─────────────────────────────────────────────────────────
function TopBar({ snap, shopName, targetTheme, onToggleTheme, focus, onFullscreen, onExit, onResetCircuit, circuitBusy }: {
  snap: WorkbenchSnapshot | null; shopName: string; targetTheme: 'light' | 'dark'
  onToggleTheme: () => void; focus: boolean; onFullscreen: () => void; onExit: () => void
  onResetCircuit: () => void; circuitBusy: boolean
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
          <span className="wb__meta">{today.getMonth() + 1} 月 {today.getDate()} 日</span>
          <span className="wb__meta"><i className={`wb__dot ${openState.cls}`} />{openState.text}</span>
          {/* 打印机：M2b 接飞鹅前恒为占位 */}
          <span className="wb__meta"><Printer className="w-3.5 h-3.5" /><i className="wb__dot" />打印机 未接入</span>
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
          <button className="wb__iconbtn" onClick={onFullscreen}>
            <Maximize className="w-4 h-4" />{focus ? '退出专注' : '全屏'}
          </button>
          <button className="wb__iconbtn" onClick={onExit}><LogOut className="w-4 h-4" />退出工作台</button>
        </div>
      </div>
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
  const timerRef = useRef<number | null>(null)
  /** 服务端时间 - 本机时间：店里的平板时钟经常偏几分钟，等待胶囊按服务端锚点算才准 */
  const skewRef = useRef(0)

  const [snap, setSnap] = useState<WorkbenchSnapshot | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [settings, setSettings] = useState<LocalDeliverySettings | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark' | null>(readTheme)
  const [focus, setFocus] = useState(false)
  const [drawer, setDrawer] = useState<{ card: WorkbenchCard; colKey: ColKey } | null>(null)
  const [detail, setDetail] = useState<{ order: Order; delivery: DeliveryInfo | null; events: DeliveryEventInfo[] } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const [modal, setModal] = useState<ModalState>(null)
  const [pendingCancelRefund, setPendingCancelRefund] = useState(false)
  const [circuitBusy, setCircuitBusy] = useState(false)

  const load = useCallback(async (fresh = false) => {
    try {
      const data = (await getWorkbenchSnapshot(fresh)).data.data
      skewRef.current = Date.parse(data.now) - Date.now()
      setSnap(data)
    } catch { /* 轮询失败静默，下一拍重试——满屏红字对站着的店员没有帮助 */ }
  }, [])

  // 10s 轮询；页面隐藏时降到 60s（§ 计划：省电又不至于回前台一片旧数据）
  useEffect(() => {
    const schedule = () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
      timerRef.current = window.setInterval(() => void load(), document.hidden ? 60_000 : 10_000)
      if (!document.hidden) void load()
    }
    void load(true)
    timerRef.current = window.setInterval(() => void load(), 10_000)
    document.addEventListener('visibilitychange', schedule)
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [load])

  // 等待胶囊要走秒
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now() + skewRef.current), 1000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => { getLocalSettings().then(setSettings, () => { /* 店名/小费上限取不到就用兜底值 */ }) }, [])

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
  useEffect(() => {
    const onFsChange = () => { if (!document.fullscreenElement) setFocus(false) }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const loadDetail = useCallback(async (orderId: number, channel: Channel) => {
    setDetailLoading(true)
    try {
      const [o, d] = await Promise.all([getOrder(orderId), channel === 'LOCAL' ? getOrderDelivery(orderId) : null])
      setDetail({ order: o.data.data, delivery: d?.data.data.delivery ?? null, events: d?.data.data.events ?? [] })
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

  const closeDrawer = () => { setDrawer(null); setDetail(null); setModal(null); setPendingCancelRefund(false) }

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
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => undefined)
      setFocus(false)
      return
    }
    if (focus) { setFocus(false); return }
    const el = rootRef.current
    const req = el?.requestFullscreen?.bind(el)
    if (!req) { setFocus(true); toast.info('当前环境不支持全屏，已切到专注模式'); return }
    try {
      const p = req()
      if (p && typeof p.then === 'function') {
        p.catch(() => { setFocus(true); toast.info('浏览器不允许全屏，已切到专注模式') })
      }
      // 同步/无 Promise 的旧浏览器：成功与否交给下面的 fullscreenchange 监听去判断，这里不猜。
    } catch { setFocus(true); toast.info('浏览器不允许全屏，已切到专注模式') }
  }

  const exitWorkbench = async () => {
    const ok = await confirmDialog({
      title: '退出工作台？',
      // 这句不能改：不写清楚，店员会以为退出就收不到来单提醒，于是没人敢退（§8）
      content: '工作台仍在后台接单、出票和播报，退出不影响来单提醒',
      confirmText: '退出',
      cancelText: '留在工作台',
    })
    if (ok) navigate('/dashboard')
  }

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
    const CALL_AMBER = '会预扣配送费，实际约 ¥5–8。若之后取消已接单的骑手，可能产生约 ¥2 取消费。'
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
    const callSpec = (title: string, confirmText: string, what: string, run: () => Promise<unknown>): ConfirmSpec => ({
      title, channel: ch, confirmText, okMsg: '已呼叫骑手', what,
      customer: '顾客看到「正在为您呼叫骑手」。',
      cost: '会预扣配送费，实际以运力方结算为准。',
      amber: CALL_AMBER, run,
    })

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
        ))))
      }
    }

    if (colKey === 'preparing') {
      if (ch === 'LOCAL') {
        if (active?.status === 'UNKNOWN') {
          btns.push(fill('void-recall', '作废重呼', () => confirm({
            title: '作废重呼', channel: ch, confirmText: '确认作废并重呼', okMsg: '已作废并重新呼叫',
            what: '先把这张「状态未确认」的配送单作废，再重新呼叫一次骑手。',
            customer: '顾客看到「正在为您呼叫骑手」。',
            cost: '会预扣一次新的配送费。',
            amber: '作废前请先在快递100 后台确认这张单确实不存在；若它其实已成单，重呼会变成两张单、两笔钱。',
            run: async () => { await voidUnknownDelivery(order.id); await callRider(order.id) },
          })))
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
        btns.push(fill('void-recall2', '作废重呼', () => confirm({
          title: '作废重呼', channel: ch, confirmText: '确认作废并重呼', okMsg: '已作废并重新呼叫',
          what: '先把这张「状态未确认」的配送单作废，再重新呼叫一次骑手。',
          customer: '顾客看到「正在为您呼叫骑手」。',
          cost: '会预扣一次新的配送费。',
          amber: '作废前请先在快递100 后台确认这张单确实不存在；若它其实已成单，重呼会变成两张单、两笔钱。',
          run: async () => { await voidUnknownDelivery(order.id); await callRider(order.id) },
        })))
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
    const { card } = drawer
    const local = card.channel === 'LOCAL'
    const o = detail?.order
    const d = detail?.delivery ?? null
    const w = waitLabel(card.waitSince, now)
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
            <span>{card.orderNo}</span>
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
                    {it.productName}
                    {it.specText ? <span className="wb__item-spec"> {it.specText}</span> : null}
                  </span>
                  <span className="wb__qty">×{it.quantity}</span>
                  <span className="wb__amt">¥{yuan(it.subtotal)}</span>
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
              <div className="wb__line"><span>地址</span><span style={{ textAlign: 'right' }}>{o?.receiverFullAddress ?? '--'}</span></div>
              {local ? (
                <>
                  <div className="wb__line"><span>距离</span><span>{card.local?.distanceM != null ? `${(card.local.distanceM / 1000).toFixed(1)} km` : '--'}</span></div>
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
                <div className="wb__line"><span>姓名</span><span>{d.courierName ?? '未接单'}</span></div>
                <div className="wb__line">
                  <span>电话</span>
                  {d.courierMobile
                    ? <a className="wb__tel" style={{ color: chColor(card.channel) }} href={`tel:${d.courierMobile}`}>{d.courierMobile}</a>
                    : <span>--</span>}
                </div>
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
              <div className="wb__line"><span>配送费/运费</span><span className="wb__amt">¥{yuan(o?.shippingFee ?? 0)}</span></div>
              <div className="wb__line"><span>顾客实付</span><span className="wb__amt">¥{yuan(o?.actualAmount ?? card.amountFen)}</span></div>
              {!!o?.refundedAmount && <div className="wb__line"><span>已退款</span><span className="wb__amt">-¥{yuan(o.refundedAmount)}</span></div>}
              {local && d && (
                <>
                  <div className="wb__line"><span>运力报价</span><span className="wb__amt">{d.quotedFee != null ? `¥${yuan(d.quotedFee)}` : '--'}</span></div>
                  {d.tipFee > 0 && <div className="wb__line"><span>已加小费</span><span className="wb__amt">¥{yuan(d.tipFee)}</span></div>}
                  {d.cancelFee > 0 && <div className="wb__line"><span>取消费</span><span className="wb__amt">¥{yuan(d.cancelFee)}</span></div>}
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

  return (
    <div className={`wb ${focus ? 'wb--focus' : ''}`} data-theme={theme ?? undefined} ref={rootRef}>
      <TopBar
        snap={snap} shopName={settings?.store.name || '接单工作台'} targetTheme={nextTheme(theme)} onToggleTheme={toggleTheme}
        focus={focus} onFullscreen={toggleFullscreen} onExit={() => void exitWorkbench()}
        onResetCircuit={() => void resetCircuit()} circuitBusy={circuitBusy}
      />

      {/* 图例常驻（§3）；专注模式下让位给看板 */}
      <div className="wb__legend">
        <span className="wb__badge wb__badge--local"><Bike className="w-3.5 h-3.5" />同城配送</span>
        <span>骑手送，晚十分钟菜就凉了——每列里恒排在邮寄单上面</span>
        <span className="wb__badge wb__badge--express"><Package className="w-3.5 h-3.5" />全国邮寄</span>
        <span>快递发出，可以稍后处理</span>
      </div>

      <div className="wb__board" ref={boardRef}>
        {COLUMNS.map((col) => {
          // 顺序由服务端排定（同城恒上），前端只按数组顺序渲染，不再排一次
          const list = snap ? snap.columns[col.key] : []
          return (
            <section className="wb__col" key={col.key}>
              <div className="wb__col-head">
                <span>{col.title}</span>
                <span className="wb__col-count">{list.length}</span>
              </div>
              {list.length === 0
                ? <div className="wb__empty">{snap ? '暂无订单' : '加载中…'}</div>
                : list.map((c) => (
                  <Card
                    key={c.orderId} card={c} now={now}
                    onOpen={() => openCard(c, col.key)}
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
