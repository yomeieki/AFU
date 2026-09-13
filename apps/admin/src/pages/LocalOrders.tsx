import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronUp, Phone, RefreshCw, Search } from 'lucide-react'
import { getOrders, getOrderDelivery } from '../api/admin'
import Button from '../components/ui/Button'
import Pagination from '../components/ui/Pagination'
import StatusBadge from '../components/ui/StatusBadge'
import EmptyState from '../components/ui/EmptyState'
import Spinner from '../components/ui/Spinner'
import RefundDialog from '../components/RefundDialog'
import { toast } from '../components/ui/Toast'
import type { DeliveryEventInfo, DeliveryInfo, Order } from '../types'
import { fmtDateTime, fmtDateTimeSec } from '../utils/time'

// 状态 Tab：同城订单历史检索用（工作台不做检索，见 workbench-ui-spec.md §10）
const STATUS_TABS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'PAID', label: '待接单' },
  { value: 'PREPARING', label: '备餐中' },
  { value: 'SHIPPED', label: '配送中/待取餐' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'REFUNDED', label: '已退款' },
]

// 渠道筛选：全部 = 服务端 channel=LOCAL（外送 + 自取）；外送/自取各用 deliveryType
const TYPE_TABS: { value: '' | 'LOCAL' | 'PICKUP'; label: string }[] = [
  { value: '', label: '全部' }, { value: 'LOCAL', label: '外送' }, { value: 'PICKUP', label: '自取' },
]

function yuan(fen: number) {
  return (fen / 100).toFixed(2)
}

/**
 * 该单配送成本（分）。**优先用服务端算好的 costFen**：它按这一单的**全部**配送单聚合，
 * 而这里能拿到的 `delivery` 只是最近那一张——「3 分钟无人接自动升级并呼」会留下一张已取消的
 * D-1，那张上的取消费也是真花出去的钱，只看最近一张会把它漏掉。
 *
 * 退回本地计算只为兼容服务端还没返回这个字段的情况（部署顺序错开的那几秒）。
 */
function deliveryCostFen(data: { costFen?: number; delivery: DeliveryInfo | null } | null | undefined): number {
  if (!data) return 0
  if (typeof data.costFen === 'number') return data.costFen
  const d = data.delivery
  return d ? (d.actualFee ?? d.quotedFee ?? 0) + d.tipFee + d.cancelFee : 0
}

/**
 * 同城订单历史页：查账页，不是操作面。筛选/检索/看配送单时间线 + 退款入口；
 * 接单、呼叫骑手、取消配送、标记送达等操作一律去「接单工作台」（/workbench）做。
 */
export default function LocalOrders() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get('status') ?? ''
  const type = (searchParams.get('type') === 'LOCAL' || searchParams.get('type') === 'PICKUP') ? searchParams.get('type') as 'LOCAL' | 'PICKUP' : ''
  const [keyword, setKeyword] = useState('')
  const [list, setList] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [deliveryCache, setDeliveryCache] = useState<
    Record<number, { delivery: DeliveryInfo | null; events: DeliveryEventInfo[]; costFen: number }>
  >({})
  const [deliveryLoading, setDeliveryLoading] = useState<number | null>(null)
  const [refundTarget, setRefundTarget] = useState<Order | null>(null)

  const load = (p = page) => {
    setLoading(true)
    getOrders({
      page: p,
      pageSize,
      status: status || undefined,
      keyword: keyword.trim() || undefined,
      ...(type ? { deliveryType: type } : { channel: 'LOCAL' }),
    })
      .then((res) => {
        setList(res.data.data.list)
        setTotal(res.data.data.total)
      })
      .catch(() => { /* 网络抖动时保留当前列表，避免无提示地清空成空白页 */ })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [page, status, type]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    setPage(1)
    load(1)
  }

  const handleTabChange = (value: string) => {
    setPage(1)
    setSearchParams({ ...(value ? { status: value } : {}), ...(type ? { type } : {}) }, { replace: true })
  }

  const handleTypeChange = (value: '' | 'LOCAL' | 'PICKUP') => {
    setPage(1)
    setSearchParams({ ...(status ? { status } : {}), ...(value ? { type: value } : {}) }, { replace: true })
  }

  // 懒加载配送单 + 事件时间线，按订单 id 缓存，展开卡片与打开退款弹窗共用。
  // 配送成本只是参考展示，这个请求失败（网络抖动）不该挡住任何调用方——尤其是退款按钮（I6）
  const loadDelivery = async (orderId: number) => {
    if (deliveryCache[orderId]) return deliveryCache[orderId]
    setDeliveryLoading(orderId)
    try {
      const res = await getOrderDelivery(orderId)
      const data = res.data.data
      setDeliveryCache((m) => ({ ...m, [orderId]: data }))
      return data
    } catch {
      toast.error('配送信息加载失败，可稍后重试')
      return undefined
    } finally {
      setDeliveryLoading((cur) => (cur === orderId ? null : cur))
    }
  }

  const toggleExpand = (order: Order) => {
    if (expanded === order.id) {
      setExpanded(null)
      return
    }
    setExpanded(order.id)
    void loadDelivery(order.id)
  }

  const openRefund = async (order: Order) => {
    // 不用 await 的失败去挡住退款：loadDelivery 已经把异常吞掉，这里只是尽力而为地预取
    await loadDelivery(order.id)
    setRefundTarget(order)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-gray-400">查账与检索用；接单、呼叫骑手、取消配送等操作请到「接单工作台」</p>
      </div>

      <div className="bg-white rounded-lg shadow-card px-3 py-2 space-y-2">
        <div className="flex items-center gap-2 overflow-x-auto">
          {TYPE_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => handleTypeChange(t.value)}
              className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap ${
                type === t.value ? 'bg-brand-50 text-brand-600 font-medium' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 overflow-x-auto">
          {STATUS_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => handleTabChange(t.value)}
              className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap ${
                status === t.value ? 'bg-brand-50 text-brand-600 font-medium' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {t.label}
            </button>
          ))}
          <button onClick={() => load()} className="ml-auto text-gray-400 hover:text-gray-600 shrink-0" title="刷新" aria-label="刷新">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1 max-w-xs">
            <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="订单号 / 手机号"
              className="w-full border border-gray-300 rounded-md pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
          </div>
          <Button size="sm" variant="secondary" onClick={handleSearch}>
            搜索
          </Button>
        </div>
      </div>

      {/* 同 ui/Table：有旧列表时不换骨架，压淡保留，免得翻页/切筛选时页面塌回顶部 */}
      <div className={`bg-white rounded-lg shadow-card overflow-hidden${loading && list.length > 0 ? ' opacity-60 pointer-events-none' : ''}`}>
        {loading && list.length === 0 ? (
          <div className="p-3 space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-24 bg-gray-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState text={type === 'PICKUP' ? '暂无自取订单' : type === 'LOCAL' ? '暂无外送订单' : '暂无同城订单'} />
        ) : (
          <div className="divide-y divide-gray-100">
            {list.map((o) => {
              const dc = deliveryCache[o.id]
              const cost = deliveryCostFen(dc)
              return (
                <div key={o.id} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={o.status} deliveryType={o.deliveryType} />
                    {dc?.delivery && <StatusBadge status={dc.delivery.status} />}
                    <span className={`text-xs px-1.5 py-0.5 rounded ${o.deliveryType === 'PICKUP' ? 'bg-teal-50 text-teal-700' : 'bg-orange-50 text-orange-700'}`}>{o.deliveryType === 'PICKUP' ? '自取' : '外送'}</span>
                    <span className="font-mono text-xs text-gray-500">{o.orderNo}</span>
                    <span className="ml-auto text-xs text-gray-400">{fmtDateTime(o.createdAt)}</span>
                  </div>
                  <div className="text-sm text-gray-700 flex flex-wrap gap-x-4 gap-y-1">
                    <span>
                      {o.receiverName}{' '}
                      <a href={`tel:${o.receiverPhone}`} className="text-brand-600 inline-flex items-center gap-0.5">
                        <Phone className="w-3.5 h-3.5" />
                        {o.receiverPhone}
                      </a>
                    </span>
                    <span>实付 ¥{yuan(o.actualAmount)}</span>
                    {!!o.packingFee && <span>打包费 ¥{yuan(o.packingFee)}</span>}
                    {o.refundedAmount > 0 && <span>已退 ¥{yuan(o.refundedAmount)}</span>}
                    {o.deliveryType === 'PICKUP' ? (
                      <>
                        <span>取餐 {fmtDateTime(o.pickupAt)}</span>
                        {o.pickupReadyAt && <span>已备好 {fmtDateTime(o.pickupReadyAt)}</span>}
                        {o.status === 'COMPLETED' && o.completedAt && <span>已取走 {fmtDateTime(o.completedAt)}</span>}
                      </>
                    ) : (
                      <>
                        {dc && cost > 0 && <span className="text-gray-500">配送成本 ¥{yuan(cost)}</span>}
                        {dc?.delivery?.courierName && <span>骑手 {dc.delivery.courierName}</span>}
                      </>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">
                    {o.items.map((it) => `${it.productName}${it.specText ? `[${it.specText}]` : ''}×${it.quantity}`).join('，')}
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    {o.deliveryType !== 'PICKUP' && (
                      <button
                        onClick={() => toggleExpand(o)}
                        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
                      >
                        {deliveryLoading === o.id ? (
                          <Spinner className="w-3.5 h-3.5" />
                        ) : expanded === o.id ? (
                          <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                        配送时间线
                      </button>
                    )}
                    {o.remainingRefundable > 0 && (
                      <Button size="sm" variant="danger" onClick={() => openRefund(o)}>
                        {o.refundedAmount > 0 ? '再退款' : '退款'}
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" onClick={() => navigate('/workbench')}>
                      查看工作台
                    </Button>
                  </div>
                  {expanded === o.id && (
                    <div className="mt-2 border-t border-gray-100 pt-2">
                      {!dc ? (
                        <p className="text-xs text-gray-400">加载中…</p>
                      ) : !dc.delivery ? (
                        <p className="text-xs text-gray-400">尚未呼叫过骑手</p>
                      ) : dc.events.length === 0 ? (
                        <p className="text-xs text-gray-400">暂无事件记录</p>
                      ) : (
                        <ol className="space-y-1.5">
                          {dc.events.map((ev) => (
                            <li key={ev.id} className="text-xs text-gray-600 flex gap-2">
                              <span className="text-gray-400 shrink-0">{fmtDateTimeSec(ev.createdAt)}</span>
                              <span>
                                {ev.statusDesc ?? ev.source}
                                {ev.courierName ? `（${ev.courierName}）` : ''}
                                {ev.operator ? ` · ${ev.operator}` : ''}
                              </span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {!loading && <Pagination page={page} total={total} pageSize={pageSize} onChange={setPage} />}
      </div>

      {refundTarget && (
        <RefundDialog
          order={refundTarget}
          deliveryCostFen={deliveryCostFen(deliveryCache[refundTarget.id]) || undefined}
          onClose={() => setRefundTarget(null)}
          onDone={() => {
            setRefundTarget(null)
            load()
          }}
        />
      )}
    </div>
  )
}
