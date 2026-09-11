/**
 * 「顾客申请取消」的处理引导：取消配送 → 全额退款，两步走在同一个 Modal 里步进。
 *
 * 用工作台自己的弹窗形态（.wb__modal-mask 那套 CSS 变量），而不是通用 Modal + 固定 Tailwind 色——
 * 后者深色主题下是一整块白（Workbench.css 文件头注释正是为此存在）；确认按钮也要跟随卡片渠道色（§6）。
 * 只有 Workbench 会渲染这个组件，Workbench.tsx 已经全局引入了 Workbench.css，这里显式再引一次
 * 是为了不依赖渲染顺序，且这个组件若被其它地方复用时也不会缺样式。
 */
import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import '../pages/Workbench.css'
import type { OrderChannel } from '../types'
import { approveExpressCancelRequest, approvePickupCancelRequest, precancelDelivery, cancelDelivery, refundOrder } from '../api/admin'

interface Props {
  orderId: number
  /** PO 2026-09-09 定：店内认单一律只用手机尾号，不再显示订单号 */
  receiverPhone: string
  /** 本次要退的金额（分）——传订单的可退余额 */
  amountFen: number
  /** 卡片渠道，确认按钮取这个颜色（§6） */
  channel: OrderChannel
  /** 在途配送单/取件预约状态文案，用于第一步的说明 */
  deliveryStatusLabel?: string | null
  /** 无在途配送单/无活跃取件预约时，同城直接从第二步（退款）起；邮寄仍是一步走，但说明文案会不一样 */
  hasActiveDelivery: boolean
  /**
   * 仅 EXPRESS 用：预约状态原始值（BOOKED/ACCEPTED/UNKNOWN/…）。UNKNOWN 是「快递100 没确认成不成单」
   * 的中间态——这时候先取消再退款可能把一张其实已经成立的预约悬空（钱退了、快递员还是会来），
   * 所以按钮要禁用，引导店员先在「作废预约」或等系统对账把它变成确定的终态。LOCAL 传 null 即可。
   */
  expressBookingStatus?: string | null
  onClose: () => void
  onDone: () => void
}

const yuan = (fen: number) => (fen / 100).toFixed(2)
const chColor = (c: OrderChannel) => (c === 'LOCAL' ? 'var(--local)' : c === 'PICKUP' ? 'var(--pickup)' : 'var(--express)')
const apiMessage = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback
const apiCode = (e: unknown) => (e as { response?: { data?: { code?: number } } })?.response?.data?.code

export default function CancelAndRefundModal({
  orderId, receiverPhone, amountFen, channel, deliveryStatusLabel, hasActiveDelivery, expressBookingStatus, onClose, onDone,
}: Props) {
  const isExpress = channel === 'EXPRESS'
  const isPickup = channel === 'PICKUP'
  const isUnknown = isExpress && expressBookingStatus === 'UNKNOWN'
  const [step, setStep] = useState<1 | 2>(hasActiveDelivery ? 1 : 2)
  const [cancelFee, setCancelFee] = useState<number | null | undefined>(undefined) // undefined=还没问到
  const [feeError, setFeeError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadFee = useCallback(async () => {
    setFeeError('')
    try {
      setCancelFee((await precancelDelivery(orderId)).data.data.cancelFeeFen)
    } catch (e) {
      setCancelFee(null)
      setFeeError(apiMessage(e, '取消费预估失败，仍可继续取消'))
    }
  }, [orderId])

  useEffect(() => {
    // 邮寄没有 precancel 接口（快递100 不支持提前问取消费），只有同城的两步流程要问
    if (!isExpress && step === 1) void loadFee()
  }, [isExpress, step, loadFee])

  const doCancel = async () => {
    setBusy(true); setError('')
    try {
      await cancelDelivery(orderId, '顾客申请取消')
      setStep(2)
    } catch (e) {
      // 42238：取消请求超时，状态没变——留在第一步让店员重试，别把人推进退款
      setError(apiCode(e) === 42238 ? '运力方响应超时，请稍后重试' : apiMessage(e, '取消配送失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  const doRefund = async () => {
    setBusy(true); setError('')
    try {
      await refundOrder(orderId, { amount: amountFen, reason: '顾客申请取消' })
      onDone()
    } catch (e) {
      setError(apiMessage(e, '退款失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  // 邮寄一步走：服务端 approveExpressCancelRequest 自己先取消预约（有的话）再退款，
  // 这里不用像同城那样分两步点两次——UI 上只是一个确认键，中间的顺序是服务端事务保证的。
  // 没有活跃预约时同一个端点照样能调，服务端会跳过取消这一步直接退款。
  const doApproveExpress = async () => {
    setBusy(true); setError('')
    try {
      await approveExpressCancelRequest(orderId)
      onDone()
    } catch (e) {
      setError(apiMessage(e, '处理失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  // 自取一步走：服务端 approve = 全额退并清标记（没有配送单/预约要取消）
  const doApprovePickup = async () => {
    setBusy(true); setError('')
    try { await approvePickupCancelRequest(orderId); onDone() }
    catch (e) { setError(apiMessage(e, '处理失败，请重试')) }
    finally { setBusy(false) }
  }

  const stepDot = (n: 1 | 2, text: string) => (
    <span className="wb__step" style={step === n ? { color: 'var(--text-1)', fontWeight: 600 } : undefined}>
      <span className="wb__step-dot" style={step === n ? { background: chColor(channel), color: '#fff' } : undefined}>{n}</span>
      {text}
    </span>
  )

  if (isPickup) {
    return (
      <div className="wb__modal-mask" role="dialog" aria-modal="true">
        <div className="wb__modal">
          <div className="wb__modal-head">
            <span>处理取消申请</span>
            <button className="wb__iconbtn" onClick={onClose} disabled={busy} aria-label="关闭"><X className="w-4 h-4" /></button>
          </div>
          <div className="wb__modal-body">
            <div className="wb__meta">尾号 <b>{receiverPhone.slice(-4)}</b></div>
            <p>同意顾客的取消申请：把货款原路退回顾客微信，订单转为已退款终态；已经做了的菜由门店自行处理。</p>
            <p className="wb__meta">顾客会看到：退款通知，1-3 个工作日到账。不同意请关闭本窗，在卡片上点「驳回」。</p>
            <div className="wb__redbar">
              {amountFen > 0
                ? `确认后退款 ¥${yuan(amountFen)} 原路退回，此操作不可撤销。`
                : '本单已无可退余额，无需再退款，可直接关闭。'}
            </div>
          </div>
          {error && <div className="wb__redbar wb__modal-error">{error}</div>}
          <div className="wb__modal-foot">
            <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>暂不处理</button>
            <button className="wb__btn wb__btn--fill" style={{ background: chColor(channel) }}
              disabled={busy || amountFen <= 0} onClick={() => void doApprovePickup()}>
              {busy ? '处理中…' : '同意取消并退款'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (isExpress) {
    return (
      <div className="wb__modal-mask" role="dialog" aria-modal="true">
        <div className="wb__modal">
          <div className="wb__modal-head">
            <span>处理取消申请</span>
            <button className="wb__iconbtn" onClick={onClose} disabled={busy} aria-label="关闭"><X className="w-4 h-4" /></button>
          </div>

          <div className="wb__modal-body">
            <div className="wb__meta">尾号 <b>{receiverPhone.slice(-4)}</b></div>
            <p>
              {hasActiveDelivery
                ? `这一步会先向快递100 取消当前取件预约${deliveryStatusLabel ? `（当前：${deliveryStatusLabel}）` : ''}，快递员不再来取件，再把货款原路退回顾客微信，订单转为已退款终态。`
                : '这单目前没有活跃的取件预约，这一步会直接把货款原路退回顾客微信，订单转为已退款终态。'}
            </p>
            <p className="wb__meta">顾客会看到：{hasActiveDelivery ? '取件预约已取消、' : ''}退款通知，1-3 个工作日到账。</p>
            {isUnknown && (
              <div className="wb__amber">
                这条预约「待核对」（快递100 还没确认成不成单）：先在抽屉里点「作废预约」，或等系统自动查单确认之后，再回来处理这条取消申请——现在处理有可能把一张其实已经成立的预约悬空（钱退了、快递员还是会来）。
              </div>
            )}
            <div className="wb__redbar">
              {amountFen > 0
                ? `确认后退款 ¥${yuan(amountFen)} 原路退回，此操作不可撤销。`
                : '本单已无可退余额，无需再退款，可直接关闭。'}
            </div>
          </div>

          {error && <div className="wb__redbar wb__modal-error">{error}</div>}

          <div className="wb__modal-foot">
            <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>暂不处理</button>
            <button
              className="wb__btn wb__btn--fill" style={{ background: chColor(channel) }}
              disabled={busy || isUnknown || amountFen <= 0}
              onClick={() => void doApproveExpress()}
            >
              {busy ? '处理中…' : '取消预约并退款'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="wb__modal-mask" role="dialog" aria-modal="true">
      <div className="wb__modal">
        <div className="wb__modal-head">
          <span>处理取消申请</span>
          <button className="wb__iconbtn" onClick={onClose} disabled={busy} aria-label="关闭"><X className="w-4 h-4" /></button>
        </div>

        <div className="wb__modal-body">
          <div className="wb__steps">
            {stepDot(1, '取消配送')}
            <span className="wb__step-sep">›</span>
            {stepDot(2, '全额退款')}
          </div>
          {/* PO 2026-09-09 定：与卡片、小票同口径，一律只显示手机尾号，不再显示订单号 */}
          <div className="wb__meta">尾号 <b>{receiverPhone.slice(-4)}</b></div>

          {step === 1 ? (
            <>
              <p>
                这一步会向运力方取消当前配送单
                {deliveryStatusLabel ? `（当前：${deliveryStatusLabel}）` : ''}，骑手不再来取货；订单本身还在，退款是下一步。
              </p>
              <p className="wb__meta">顾客会看到：配送已取消，等待商家退款。</p>
              <div className="wb__amber">
                {cancelFee === undefined
                  ? '正在向运力方预估取消费…'
                  : cancelFee === null
                    ? `取消费未知${feeError ? `（${feeError}）` : ''}——骑手已接单的单通常会产生几元取消费。`
                    : cancelFee > 0
                      ? `本次取消费约 ¥${yuan(cancelFee)}，由门店承担。`
                      : '本次取消不产生取消费。'}
              </div>
            </>
          ) : (
            <>
              <p>这一步会把货款原路退回顾客微信，订单转为已退款终态。</p>
              <p className="wb__meta">顾客会看到：退款通知，1-3 个工作日到账。</p>
              <div className="wb__redbar">
                {amountFen > 0
                  ? `确认后退款 ¥${yuan(amountFen)} 原路退回，此操作不可撤销。`
                  : '本单已无可退余额，无需再退款，可直接关闭。'}
              </div>
            </>
          )}
        </div>

        {/* 恒可见：body 会滚动，同 Workbench.tsx 的 WbModal 错误条处理（见其注释） */}
        {error && <div className="wb__redbar wb__modal-error">{error}</div>}

        <div className="wb__modal-foot">
          <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>暂不处理</button>
          {step === 1 ? (
            <button className="wb__btn wb__btn--fill" style={{ background: chColor(channel) }} disabled={busy} onClick={() => void doCancel()}>
              {busy ? '处理中…' : '取消配送'}
            </button>
          ) : (
            <button
              className="wb__btn wb__btn--fill" style={{ background: chColor(channel) }}
              disabled={busy || amountFen <= 0} onClick={() => void doRefund()}
            >
              {busy ? '处理中…' : `退款 ¥${yuan(amountFen)}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
