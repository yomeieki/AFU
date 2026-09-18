import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { getOrder, getOrderDelivery, getExpressBooking } from '../api/admin'
import { toast } from '../components/ui/Toast'
import Spinner from '../components/ui/Spinner'
import DetailHero from '../components/orders/detail/DetailHero'
import DetailTimeline from '../components/orders/detail/DetailTimeline'
import DetailCustomer from '../components/orders/detail/DetailCustomer'
import DetailItems from '../components/orders/detail/DetailItems'
import DetailMoney from '../components/orders/detail/DetailMoney'
import DetailDelivery from '../components/orders/detail/DetailDelivery'
import DetailExpress from '../components/orders/detail/DetailExpress'
import DetailRefunds from '../components/orders/detail/DetailRefunds'
import DetailAfterSales from '../components/orders/detail/DetailAfterSales'
import DetailActions from '../components/orders/detail/DetailActions'
import { backTargetFor, timelineNodes } from '../utils/order-detail'
import type { DeliveryEventInfo, DeliveryInfo, ExpressBookingEventInfo, ExpressBookingView, ExpressTrack, OrderDetail as OrderDetailData } from '../types'

type LocalData = { delivery: DeliveryInfo | null; events: DeliveryEventInfo[]; costFen: number } | null
type ExpressData = { booking: ExpressBookingView | null; active: boolean; events: ExpressBookingEventInfo[]; track: ExpressTrack | null } | null

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const orderId = Number(id)
  const validId = Number.isInteger(orderId) && orderId > 0

  const [order, setOrder] = useState<OrderDetailData | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading] = useState(true)

  const [localData, setLocalData] = useState<LocalData>(null)
  const [localLoading, setLocalLoading] = useState(false)
  const [localFailed, setLocalFailed] = useState(false)

  const [expressData, setExpressData] = useState<ExpressData>(null)
  const [expressLoading, setExpressLoading] = useState(false)
  const [expressFailed, setExpressFailed] = useState(false)

  const loadLocal = () => {
    if (!validId) return
    setLocalLoading(true)
    setLocalFailed(false)
    getOrderDelivery(orderId)
      .then((res) => setLocalData(res.data.data))
      .catch(() => setLocalFailed(true))
      .finally(() => setLocalLoading(false))
  }

  const loadExpress = () => {
    if (!validId) return
    setExpressLoading(true)
    setExpressFailed(false)
    getExpressBooking(orderId)
      .then((res) => setExpressData(res.data.data))
      .catch(() => setExpressFailed(true))
      .finally(() => setExpressLoading(false))
  }

  const load = () => {
    if (!validId) {
      setNotFound(true)
      setLoading(false)
      return
    }
    setLoading(true)
    getOrder(orderId)
      .then((res) => {
        const o = res.data.data
        setOrder(o)
        setNotFound(false)
        if (o.deliveryType === 'LOCAL') loadLocal()
        if (o.deliveryType === 'EXPRESS') loadExpress()
      })
      .catch((err: unknown) => {
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status === 404) setNotFound(true)
        else toast.error('订单加载失败，请重试')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [orderId]) // eslint-disable-line react-hooks/exhaustive-deps

  const backTo = (location.state as { from?: string } | null)?.from ?? (order ? backTargetFor(order.deliveryType) : '/orders/express')
  const backLabel = backTo.startsWith('/orders/local') ? '返回同城订单' : '返回全国邮寄'

  if (notFound) {
    return (
      <div className="max-w-2xl mx-auto p-4 text-center space-y-3">
        <p className="text-gray-500">订单不存在</p>
        <Link to="/orders/express" className="text-brand-600 hover:underline">‹ 返回订单管理</Link>
      </div>
    )
  }

  if (loading && !order) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400">
        <Spinner className="w-6 h-6" />
      </div>
    )
  }

  if (!order) return null

  const nodes = timelineNodes(order, { delivery: localData?.delivery, booking: expressData?.booking })
  const costFen = localData?.costFen

  return (
    <div className="pb-24 md:pb-6">
      <div className="max-w-2xl lg:max-w-none mx-auto lg:mx-0 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <button onClick={() => navigate(backTo)} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
            <ChevronLeft className="w-4 h-4" />
            {backLabel}
          </button>
          <div className="hidden md:flex">
            <DetailActions order={order} deliveryCostFen={costFen} onReload={load} />
          </div>
        </div>

        <h1 className="sr-only">订单详情</h1>

        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-4 lg:items-start space-y-3 lg:space-y-0">
          {/* 手机/iPad 单栏顺序：订单头 → 进度 → 顾客 → 商品 → 金额 → 配送/取餐/物流 → 退款记录 → 售后 */}
          <div className="lg:hidden space-y-3">
            <DetailHero order={order} />
            <div className="bg-white rounded-lg shadow-card p-3 md:p-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-2">进度</h3>
              <DetailTimeline nodes={nodes} />
            </div>
            <DetailCustomer order={order} />
            <div className="bg-white rounded-lg shadow-card p-3 md:p-4">
              <DetailItems order={order} />
            </div>
            <div className="bg-white rounded-lg shadow-card p-3 md:p-4">
              <DetailMoney order={order} />
            </div>
            {order.deliveryType === 'LOCAL' && (
              <DetailDelivery data={localData} loading={localLoading} loadFailed={localFailed} onRetry={loadLocal} />
            )}
            {order.deliveryType === 'EXPRESS' && (
              <DetailExpress order={order} data={expressData} loading={expressLoading} loadFailed={expressFailed} onRetry={loadExpress} />
            )}
            <DetailRefunds order={order} />
            <DetailAfterSales order={order} />
          </div>

          {/* ≥lg 两栏：左栏（钱）商品+金额明细同一卡 / 退款记录 / 售后；右栏（人和过程）订单头 / 进度 / 收货 / 配送 */}
          <div className="hidden lg:block space-y-3">
            <div className="bg-white rounded-lg shadow-card p-4 space-y-3">
              <DetailItems order={order} />
              <div className="border-t border-gray-100 pt-3">
                <DetailMoney order={order} />
              </div>
            </div>
            <DetailRefunds order={order} />
            <DetailAfterSales order={order} />
          </div>
          <div className="hidden lg:block space-y-3">
            <DetailHero order={order} />
            <div className="bg-white rounded-lg shadow-card p-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-2">进度</h3>
              <DetailTimeline nodes={nodes} />
            </div>
            <DetailCustomer order={order} />
            {order.deliveryType === 'LOCAL' && (
              <DetailDelivery data={localData} loading={localLoading} loadFailed={localFailed} onRetry={loadLocal} />
            )}
            {order.deliveryType === 'EXPRESS' && (
              <DetailExpress order={order} data={expressData} loading={expressLoading} loadFailed={expressFailed} onRetry={loadExpress} />
            )}
          </div>
        </div>
      </div>

      {/* <md 底部固定操作栏 */}
      <div className="md:hidden fixed inset-x-0 bottom-0 bg-white border-t border-gray-100 px-3 pt-2" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
        <DetailActions order={order} deliveryCostFen={costFen} onReload={load} className="w-full" />
      </div>
    </div>
  )
}
