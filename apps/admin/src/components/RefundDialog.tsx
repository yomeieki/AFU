import { useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import Modal from './ui/Modal'
import Button from './ui/Button'
import { toast } from './ui/Toast'
import { refundOrder, approveAfterSale } from '../api/admin'
import { ORDER_STATUS_LABEL } from './ui/StatusBadge'
import type { Order } from '../types'

interface Props {
  /** 订单（需含 actualAmount / refundedAmount / remainingRefundable / status） */
  order: Pick<Order, 'id' | 'orderNo' | 'status' | 'actualAmount' | 'refundedAmount' | 'remainingRefundable' | 'receiverName' | 'receiverPhone' | 'latestRefund'>
  /** 传入则为「同意售后」：走 /after-sales/:id/approve，金额与回复一起提交 */
  afterSaleId?: number
  /** 售后模式下的默认回复 */
  defaultReply?: string
  /** 该单配送成本（分）：已呼骑手运费/小费/取消费合计。传入则在金额输入框下展示参考行，纯展示不参与校验 */
  deliveryCostFen?: number
  onClose: () => void
  /** 退款请求成功（已退或已发起）后回调，父组件刷新列表 */
  onDone: () => void
}

const REASON_PRESETS = ['缺货', '客户取消', '协商退款', '其他'] as const
type ReasonPreset = (typeof REASON_PRESETS)[number]

function yuan(fen: number) {
  return (fen / 100).toFixed(2)
}

function parseYuan(input: string): number | null {
  const t = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  return Math.round(parseFloat(t) * 100)
}

/**
 * 退款双重确认：
 *  step 1 原因胶囊 + 金额输入（「全额」一键填入可退余额）+ 退后订单去向说明
 *  step 2 红色危险弹窗，必须重新手输与第一步一致的金额才能提交（禁用遮罩/Esc 关闭）
 * 部分退款：订单状态不变、货照发；全额（退完可退余额）：订单进入退款/取消流程。
 */
export default function RefundDialog({ order, afterSaleId, defaultReply, deliveryCostFen, onClose, onDone }: Props) {
  const [step, setStep] = useState<1 | 2>(1)
  const [preset, setPreset] = useState<ReasonPreset | ''>(afterSaleId ? '协商退款' : '')
  const [customReason, setCustomReason] = useState('')
  const [reply, setReply] = useState(defaultReply ?? '')
  const [amountInput, setAmountInput] = useState('')
  const [confirmInput, setConfirmInput] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 幂等键：一个弹窗实例只生成一次，重试原样复用（useRef 而非 useState——它不参与渲染，
  // 也绝不能因为某次 setState 重新生成）。服务端拿它 + 订单 + 金额去重，
  // 让「超时后再点一次」落回第一次那笔退款，而不是真的再打一笔出去。
  const idempotencyKeyRef = useRef(`ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)

  const remaining = order.remainingRefundable ?? Math.max(0, order.actualAmount - (order.refundedAmount ?? 0))
  const amountFen = parseYuan(amountInput)
  const amountValid = amountFen !== null && amountFen > 0 && amountFen <= remaining
  const isFull = amountValid && amountFen === remaining
  const isRetry = order.status === 'REFUNDING'
  const reason = preset === '其他' ? customReason.trim() : preset
  const reasonOk = preset !== '' && (preset !== '其他' || customReason.trim().length > 0)
  const confirmMatches = amountValid && parseYuan(confirmInput) === amountFen

  const afterEffect = !amountValid
    ? ''
    : isFull
      ? order.status === 'SHIPPED' || order.status === 'COMPLETED'
        ? '全额退款，订单转为「已退款」（货已出库，不回滚库存）'
        : isRetry
          ? '向微信重新发起全额退款'
          : '全额退款，订单取消，库存自动回滚'
      : `部分退款 ¥${yuan(amountFen!)}，订单状态不变，剩余 ¥${yuan(remaining - amountFen!)} 仍可再退`

  const handleSubmit = async () => {
    if (!confirmMatches || submitting || amountFen === null) return
    setSubmitting(true)
    setError('')
    try {
      if (afterSaleId) {
        const res = await approveAfterSale(afterSaleId, {
          amount: amountFen,
          reply: reply.trim() || undefined,
          idempotencyKey: idempotencyKeyRef.current,
        })
        const { mode, refund } = res.data.data
        toast.success(mode === 'mock' || refund.status === 'SUCCESS' ? `已退款 ¥${yuan(amountFen)}` : '已发起退款，等待微信处理')
      } else {
        const res = await refundOrder(order.id, {
          amount: amountFen,
          reason: reason || undefined,
          idempotencyKey: idempotencyKeyRef.current,
        })
        const { mode, refund } = res.data.data
        toast.success(mode === 'mock' || refund.status === 'SUCCESS' ? `已退款 ¥${yuan(amountFen)}` : '已发起退款，等待微信处理（到账后自动更新状态）')
      }
      onDone()
    } catch (err: unknown) {
      const serverMessage = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      setError(
        serverMessage ??
          // 没拿到 response = axios 10 秒超时或断网，微信那笔退款很可能还在路上，结果未知。
          // 这里绝不能再写「退款失败，请稍后重试」——店员照着提示重点一次，以前就是实打实的第二笔同额退款。
          '正在确认结果，请勿重复提交。稍后刷新订单查看退款状态；若长时间不更新，请到微信商户平台核对。'
      )
      setStep(1)
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls = (bad: boolean) =>
    `w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
      bad ? 'border-red-300 focus:ring-red-300' : 'border-gray-300 focus:ring-brand-400'
    }`

  if (step === 1) {
    return (
      <Modal
        title={afterSaleId ? '同意售后并退款' : isRetry ? '重新发起退款' : '退款'}
        width="sm"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              取消
            </Button>
            <Button variant="danger" disabled={!amountValid || (!afterSaleId && !reasonOk)} onClick={() => { setConfirmInput(''); setError(''); setStep(2) }}>
              下一步
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="text-xs text-gray-500 space-y-1 bg-gray-50 rounded-md p-3">
            <p>
              订单号：<span className="font-mono">{order.orderNo}</span>
            </p>
            <p className="flex flex-wrap gap-x-4">
              <span>实付 <span className="font-semibold text-gray-800">¥{yuan(order.actualAmount)}</span></span>
              {order.refundedAmount > 0 && <span>已退 <span className="text-gray-800">¥{yuan(order.refundedAmount)}</span></span>}
              <span>可退 <span className="font-semibold text-red-600">¥{yuan(remaining)}</span></span>
            </p>
            <p>
              收货人：{order.receiverName} {order.receiverPhone}　当前状态：{ORDER_STATUS_LABEL[order.status] ?? order.status}
            </p>
            {order.latestRefund?.errorMessage && (
              <p className="text-red-500">上次失败原因：{order.latestRefund.errorMessage}</p>
            )}
          </div>

          {!afterSaleId && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">退款原因（买家可见）</label>
              <div className="flex flex-wrap gap-2">
                {REASON_PRESETS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setPreset(r)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      preset === r
                        ? 'bg-brand-50 border-brand-400 text-brand-600 font-medium'
                        : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              {preset === '其他' && (
                <input
                  value={customReason}
                  maxLength={80}
                  autoFocus
                  onChange={(e) => setCustomReason(e.target.value)}
                  placeholder="请填写原因"
                  className={`${inputCls(false)} mt-2`}
                />
              )}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">退款金额（元）</label>
            <div className="flex gap-2">
              <input
                value={amountInput}
                inputMode="decimal"
                onChange={(e) => setAmountInput(e.target.value)}
                placeholder={`最多 ${yuan(remaining)}`}
                className={inputCls(!!amountInput && !amountValid)}
              />
              <Button type="button" variant="secondary" className="whitespace-nowrap shrink-0" onClick={() => setAmountInput(yuan(remaining))}>
                全额
              </Button>
            </div>
            {amountInput && !amountValid && (
              <p className="text-xs text-red-500 mt-1">
                {amountFen === null ? '请输入正确的金额，最多两位小数' : amountFen <= 0 ? '金额必须大于 0' : `不能超过可退余额 ¥${yuan(remaining)}`}
              </p>
            )}
            {afterEffect && <p className="text-xs text-gray-600 mt-1.5">{afterEffect}</p>}
            {!!deliveryCostFen && deliveryCostFen > 0 && (
              <p className="text-xs text-gray-400 mt-1">
                该单配送成本 ¥{yuan(deliveryCostFen)}（已呼骑手/小费/取消费合计），退款金额不含此成本
              </p>
            )}
          </div>

          {afterSaleId && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">给顾客的回复（可选，买家可见）</label>
              <input
                value={reply}
                maxLength={255}
                onChange={(e) => setReply(e.target.value)}
                placeholder="如：已按少发的一份退款，抱歉给您带来不便"
                className={inputCls(false)}
              />
            </div>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title={`确认退款 ¥${yuan(amountFen!)}`}
      width="sm"
      closeOnOverlay={false}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={() => setStep(1)} disabled={submitting}>
            上一步
          </Button>
          <Button variant="danger" onClick={handleSubmit} disabled={!confirmMatches} loading={submitting}>
            {submitting ? '退款中...' : '确认退款'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2 bg-red-50 text-red-700 rounded-md p-3 text-sm">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <p>
            此操作会立即向买家微信退回 <span className="font-semibold">¥{yuan(amountFen!)}</span>
            {isFull ? '（全额）' : '（部分）'}，<span className="font-semibold">不可撤销</span>。请再次输入退款金额以确认。
          </p>
        </div>
        <p className="text-xs text-gray-500">{afterEffect}</p>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">再次输入退款金额（元）</label>
          <input
            value={confirmInput}
            autoFocus
            inputMode="decimal"
            onChange={(e) => setConfirmInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit()
            }}
            placeholder={`请输入 ${yuan(amountFen!)}`}
            className={inputCls(!!confirmInput && !confirmMatches)}
          />
          {confirmInput && !confirmMatches && (
            <p className="text-xs text-red-500 mt-1">与第一步填写的 ¥{yuan(amountFen!)} 不一致</p>
          )}
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  )
}
