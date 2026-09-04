/**
 * 「顾客申请取消」的处理引导：取消配送 → 全额退款，两步走在同一个 Modal 里步进。
 * 刻意不嵌 confirmDialog——ConfirmDialogHost 与本 Modal 同为 z-50 且挂在更后面，
 * 弹出来会盖住本体，店员会以为退款弹窗消失了。
 */
import { useCallback, useEffect, useState } from 'react'
import Modal from './ui/Modal'
import Button from './ui/Button'
import { precancelDelivery, cancelDelivery, refundOrder } from '../api/admin'

interface Props {
  orderId: number
  orderNo: string
  /** 本次要退的金额（分）——传订单的可退余额 */
  amountFen: number
  /** 在途配送单状态文案，用于第一步的说明 */
  deliveryStatusLabel?: string | null
  /** 无在途配送单时直接从第二步（退款）起 */
  hasActiveDelivery: boolean
  onClose: () => void
  onDone: () => void
}

const yuan = (fen: number) => (fen / 100).toFixed(2)
const apiMessage = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback
const apiCode = (e: unknown) => (e as { response?: { data?: { code?: number } } })?.response?.data?.code

export default function CancelAndRefundModal({
  orderId, orderNo, amountFen, deliveryStatusLabel, hasActiveDelivery, onClose, onDone,
}: Props) {
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
    if (step === 1) void loadFee()
  }, [step, loadFee])

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

  const stepDot = (n: 1 | 2, text: string) => (
    <span className={`flex items-center gap-1.5 ${step === n ? 'text-gray-900 font-semibold' : 'text-gray-400'}`}>
      <span className={`w-5 h-5 rounded-full text-xs flex items-center justify-center ${step === n ? 'bg-brand-500 text-white' : 'bg-gray-200 text-gray-500'}`}>{n}</span>
      {text}
    </span>
  )

  return (
    <Modal
      title="处理取消申请"
      width="sm"
      closeOnOverlay={false}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>暂不处理</Button>
          {step === 1 ? (
            <Button variant="danger" loading={busy} onClick={doCancel}>取消配送</Button>
          ) : (
            <Button variant="danger" loading={busy} onClick={doRefund} disabled={amountFen <= 0}>
              退款 ¥{yuan(amountFen)}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3 text-sm text-gray-700">
        <div className="flex items-center gap-4 text-xs">
          {stepDot(1, '取消配送')}
          <span className="text-gray-300">›</span>
          {stepDot(2, '全额退款')}
        </div>
        <p className="text-gray-500">订单 {orderNo}</p>

        {step === 1 ? (
          <>
            <p>
              这一步会向运力方取消当前配送单
              {deliveryStatusLabel ? `（当前：${deliveryStatusLabel}）` : ''}，骑手不再来取货；订单本身还在，退款是下一步。
            </p>
            <p className="text-gray-500">顾客会看到：配送已取消，等待商家退款。</p>
            <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-700 px-3 py-2">
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
            <p className="text-gray-500">顾客会看到：退款通知，1-3 个工作日到账。</p>
            <div className="rounded-md bg-red-50 border border-red-200 text-red-600 px-3 py-2 font-semibold">
              {amountFen > 0
                ? `确认后退款 ¥${yuan(amountFen)} 原路退回，此操作不可撤销。`
                : '本单已无可退余额，无需再退款，可直接关闭。'}
            </div>
          </>
        )}

        {error && <p className="text-red-600">{error}</p>}
      </div>
    </Modal>
  )
}
