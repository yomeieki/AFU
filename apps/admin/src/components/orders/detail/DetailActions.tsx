import { useState } from 'react'
import { Printer } from 'lucide-react'
import Button from '../../ui/Button'
import { toast } from '../../ui/Toast'
import { confirmDialog } from '../../ui/ConfirmDialog'
import RefundDialog from '../../RefundDialog'
import { reprintOrder, completeRefund } from '../../../api/admin'
import type { OrderDetail } from '../../../types'

interface Props {
  order: OrderDetail
  /** 同城外送单传配送成本，传给 RefundDialog 展示参考行 */
  deliveryCostFen?: number
  onReload: () => void
  className?: string
}

/**
 * 事后处理：重打小票 + 退款。判定逻辑照抄 `pages/Orders.tsx` 的 `renderRefundActions`，
 * 不放宽——详情页不做接单/出餐/呼叫骑手/发货/标记完成/发赔偿券/取消，那些仍然只在
 * 对应列表页 / 工作台做（见实施计划 §1 T3③ DetailActions.tsx）。
 */
export default function DetailActions({ order, deliveryCostFen, onReload, className = '' }: Props) {
  const [refundOpen, setRefundOpen] = useState(false)
  const [reprinting, setReprinting] = useState(false)

  const handleReprint = async () => {
    setReprinting(true)
    try {
      const r = await reprintOrder(order.id)
      toast[r.enqueued ? 'success' : 'error'](
        r.enqueued
          ? '已发送重打'
          : ({ PRINTER_DISABLED: '打印机功能未启用', NO_PRINTER_CONFIGURED: '该单所属渠道尚未配置打印机' } as Record<string, string>)[r.reason ?? ''] ?? '重打失败'
      )
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '重打失败')
    } finally {
      setReprinting(false)
    }
  }

  const handleCompleteRefund = async () => {
    const ok = await confirmDialog({
      title: '手动标记退款完成',
      content: `仅在已确认微信商户平台退款成功、但系统未收到回调时使用。确认将订单 ${order.orderNo} 标记为已退款？`,
      danger: true,
      confirmText: '确认标记',
    })
    if (!ok) return
    try {
      await completeRefund(order.id)
      toast.success('已标记退款完成')
      onReload()
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '操作失败')
    }
  }

  const r = order.latestRefund
  const refundActive = !!r && ['PENDING', 'PROCESSING', 'ABNORMAL'].includes(r.status)

  const refundButton = (() => {
    if (['PAID', 'PREPARING', 'SHIPPED', 'COMPLETED'].includes(order.status)) {
      if (order.remainingRefundable <= 0) return null
      return (
        <Button variant="danger" disabled={refundActive} title={refundActive ? '有退款处理中' : ''} onClick={() => setRefundOpen(true)} className="flex-1 md:flex-none">
          {order.refundedAmount > 0 ? `再退款（还可退 ¥${(order.remainingRefundable / 100).toFixed(2)}）` : `退款（还可退 ¥${(order.remainingRefundable / 100).toFixed(2)}）`}
        </Button>
      )
    }
    if (order.status !== 'REFUNDING') return null
    return (
      <>
        {!refundActive && (
          <Button variant="danger" onClick={() => setRefundOpen(true)} className="flex-1 md:flex-none">
            {r ? '重试退款' : '发起退款'}
          </Button>
        )}
        {r?.status === 'PENDING' || r?.status === 'PROCESSING' ? (
          <span className="text-sm text-gray-500 self-center">微信处理中</span>
        ) : r?.status === 'ABNORMAL' ? (
          <span className="text-sm text-red-500 self-center">退款异常</span>
        ) : null}
        <Button variant="secondary" onClick={handleCompleteRefund}>手动标记完成</Button>
      </>
    )
  })()

  return (
    <>
      <div className={`flex items-center gap-2 ${className}`}>
        {order.status !== 'PENDING_PAYMENT' && (
          <Button variant="secondary" loading={reprinting} onClick={handleReprint} className="flex-1 md:flex-none" title="重打该单小票">
            <Printer className="w-4 h-4" />
            重打小票
          </Button>
        )}
        {refundButton}
      </div>
      {refundOpen && (
        <RefundDialog
          order={order}
          deliveryCostFen={deliveryCostFen}
          onClose={() => setRefundOpen(false)}
          onDone={() => {
            setRefundOpen(false)
            onReload()
          }}
        />
      )}
    </>
  )
}
