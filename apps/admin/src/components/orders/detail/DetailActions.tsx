import { useState } from 'react'
import { Printer } from 'lucide-react'
import Button from '../../ui/Button'
import { toast } from '../../ui/Toast'
import { reprintOrder } from '../../../api/admin'
import type { OrderDetail } from '../../../types'
import { canRefund, hasActiveRefund, refundLabel, canReprint } from '../../../utils/order-actions'

interface Props {
  order: OrderDetail
  /** 点「退款/重试退款/发起退款」时触发；退款弹窗由页面（OrderDetail.tsx）唯一持有，
   * 不在这里渲染——本组件在 <md 下被放进 `position:fixed` 的底部操作栏，那本身是一个新的
   * 层叠上下文，弹窗在其中渲染会被顶栏压在下面（需改 3）。 */
  onRefund: () => void
  className?: string
}

/**
 * 事后处理：重打小票 + 退款。判定逻辑照抄 `pages/Orders.tsx` 的 `renderRefundActions`，
 * 不放宽——详情页不做接单/出餐/呼叫骑手/发货/标记完成/发赔偿券/取消，那些仍然只在
 * 对应列表页 / 工作台做（见实施计划 §1 T3③ DetailActions.tsx）。
 */
export default function DetailActions({ order, onRefund, className = '' }: Props) {
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

  const r = order.latestRefund
  const refundActive = hasActiveRefund(order)

  // 显示规则在 utils/order-actions.ts 一处判定，与 Orders / LocalOrders 共用
  const refundButton = (() => {
    if (order.status !== 'REFUNDING') {
      if (!canRefund(order)) return null
      return (
        <Button variant="danger" disabled={refundActive} title={refundActive ? '有退款处理中' : ''} onClick={onRefund} className="flex-1 md:flex-none whitespace-nowrap">
          {refundLabel(order)}（还可退 ¥{(order.remainingRefundable / 100).toFixed(2)}）
        </Button>
      )
    }
    return (
      <>
        {!refundActive && (
          <Button variant="danger" onClick={onRefund} className="flex-1 md:flex-none whitespace-nowrap">
            {r ? '重试退款' : '发起退款'}
          </Button>
        )}
        {r?.status === 'PENDING' || r?.status === 'PROCESSING' ? (
          <span className="text-sm text-gray-500 self-center whitespace-nowrap">微信处理中</span>
        ) : r?.status === 'ABNORMAL' ? (
          <span className="text-sm text-red-500 self-center whitespace-nowrap">退款异常</span>
        ) : null}
      </>
    )
  })()

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {canReprint(order) && (
        <Button variant="secondary" loading={reprinting} onClick={handleReprint} className="shrink-0 whitespace-nowrap" title="重打该单小票">
          <Printer className="w-4 h-4" />
          重打小票
        </Button>
      )}
      {refundButton}
    </div>
  )
}
