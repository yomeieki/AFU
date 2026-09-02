import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import Modal from './ui/Modal'
import Button from './ui/Button'
import { toast } from './ui/Toast'
import { refundOrder } from '../api/admin'
import type { Order } from '../types'

interface Props {
  order: Order
  onClose: () => void
  /** 退款请求成功（已退或已发起）后回调，父组件刷新列表 */
  onDone: () => void
}

const STATUS_LABEL: Record<string, string> = {
  PAID: '待接单',
  PREPARING: '备餐中',
  SHIPPED: '已发货',
  REFUNDING: '退款中',
}

function yuan(fen: number) {
  return (fen / 100).toFixed(2)
}

/**
 * 一键退款双重确认：
 *  step 1 摘要 + 退款原因 → step 2 红色危险弹窗，必须手动输入与实付一致的金额才能提交。
 * step 2 禁用遮罩/Esc 关闭，防误触。
 */
export default function RefundDialog({ order, onClose, onDone }: Props) {
  const [step, setStep] = useState<1 | 2>(1)
  const [reason, setReason] = useState('')
  const [amountInput, setAmountInput] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const expected = yuan(order.actualAmount)
  const amountMatches =
    /^\d+(\.\d{1,2})?$/.test(amountInput.trim()) &&
    Math.round(parseFloat(amountInput.trim()) * 100) === order.actualAmount
  const isShipped = order.status === 'SHIPPED'
  const isRetry = order.status === 'REFUNDING'

  const handleSubmit = async () => {
    if (!amountMatches || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const res = await refundOrder(order.id, {
        amount: order.actualAmount,
        reason: reason.trim() || undefined,
      })
      const { mode, refund } = res.data.data
      if (mode === 'mock' || refund.status === 'SUCCESS') {
        toast.success(`已退款 ¥${expected}`)
      } else {
        toast.success('已发起退款，等待微信处理（到账后自动更新状态）')
      }
      onDone()
    } catch (err: unknown) {
      setError(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '退款失败，请稍后重试'
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (step === 1) {
    return (
      <Modal
        title={isRetry ? '重新发起退款' : '退款'}
        width="sm"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              取消
            </Button>
            <Button variant="danger" onClick={() => setStep(2)}>
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
            <p>
              实付金额：<span className="text-base font-semibold text-gray-800">¥{expected}</span>
            </p>
            <p>
              收货人：{order.receiverName} {order.receiverPhone}
            </p>
            <p>当前状态：{STATUS_LABEL[order.status] ?? order.status}</p>
            {order.latestRefund?.errorMessage && (
              <p className="text-red-500">上次失败原因：{order.latestRefund.errorMessage}</p>
            )}
          </div>
          <p className="text-sm text-gray-600">
            {isShipped
              ? '该订单已发货，退款不回滚库存。'
              : isRetry
                ? '订单已在退款中，将重新向微信发起退款。'
                : '退款后订单取消，库存自动回滚。'}
            款项将<span className="font-medium text-gray-800">全额原路退回</span>买家微信。
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">退款原因（可选，买家可见）</label>
            <input
              value={reason}
              maxLength={80}
              onChange={(e) => setReason(e.target.value)}
              placeholder="如：商品缺货 / 客户取消"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title={`确认退款 ¥${expected}`}
      width="sm"
      closeOnOverlay={false}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={() => setStep(1)} disabled={submitting}>
            上一步
          </Button>
          <Button variant="danger" onClick={handleSubmit} disabled={!amountMatches} loading={submitting}>
            {submitting ? '退款中...' : '确认退款'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2 bg-red-50 text-red-700 rounded-md p-3 text-sm">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <p>
            此操作会立即向买家微信退回 <span className="font-semibold">¥{expected}</span>，
            <span className="font-semibold">不可撤销</span>。请手动输入退款金额以确认。
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">退款金额（元）</label>
          <input
            value={amountInput}
            autoFocus
            inputMode="decimal"
            onChange={(e) => setAmountInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit()
            }}
            placeholder={`请输入 ${expected}`}
            className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
              amountInput && !amountMatches
                ? 'border-red-300 focus:ring-red-300'
                : 'border-gray-300 focus:ring-red-400'
            }`}
          />
          {amountInput && !amountMatches && (
            <p className="text-xs text-red-500 mt-1">与订单实付金额 ¥{expected} 不一致</p>
          )}
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  )
}
