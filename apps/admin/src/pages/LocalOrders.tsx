import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import { RefreshCw, Search } from 'lucide-react'
import { getOrders, getOrderDelivery } from '../api/admin'
import Button from '../components/ui/Button'
import Pagination from '../components/ui/Pagination'
import RefundDialog from '../components/RefundDialog'
import { toast } from '../components/ui/Toast'
import OrderListTable from '../components/orders/OrderListTable'
import OrderDateFilter from '../components/orders/OrderDateFilter'
import type { DeliveryInfo, Order } from '../types'
import { orderDetailPath } from '../navigation'
import { readOrderDate, writeOrderDate, orderDateQuery, orderDateError, orderDateSummary } from '../utils/order-date-range'
import { showWorkbenchLink } from '../utils/order-list'
import { usePendingCounts } from '../hooks/usePendingOrders'
import { canRefund, hasActiveRefund, refundLabel, REFUND_ATTENTION_FILTER, refundRetryLabel, refundingHint } from '../utils/order-actions'

// 状态 Tab：同城订单历史检索用（工作台不做检索，见 workbench-ui-spec.md §10）
const STATUS_TABS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'PAID', label: '待接单' },
  { value: 'PREPARING', label: '备餐中' },
  { value: 'SHIPPED', label: '配送中/待取餐' },
  { value: 'COMPLETED', label: '已完成' },
  // 只列要人出手的退款中订单（伪状态，见 utils/order-actions.ts）；正常退款中的单由自动补查推到结局
  { value: REFUND_ATTENTION_FILTER, label: '退款待处理' },
  { value: 'REFUNDED', label: '已退款' },
]

// 渠道筛选：全部 = 服务端 channel=LOCAL（外送 + 自取）；外送/自取各用 deliveryType
const TYPE_TABS: { value: '' | 'LOCAL' | 'PICKUP'; label: string }[] = [
  { value: '', label: '全部' }, { value: 'LOCAL', label: '外送' }, { value: 'PICKUP', label: '自取' },
]

// 预约/尽快筛选：只对外送（含全部）有意义，自取单没有预约送达这个维度
const SCHED_TABS: { value: '' | 'SCHEDULED' | 'ASAP'; label: string }[] = [
  { value: '', label: '全部' }, { value: 'SCHEDULED', label: '预约' }, { value: 'ASAP', label: '尽快' },
]

/**
 * 该单配送成本（分）。**优先用服务端算好的 costFen**：它按这一单的**全部**配送单聚合，
 * 而这里能拿到的 `delivery` 只是最近那一张——「3 分钟无人接自动升级并呼」会留下一张已取消的
 * D-1，那张上的取消费也是真花出去的钱，只看最近一张会把它漏掉。
 */
function deliveryCostFen(data: { costFen?: number; delivery: DeliveryInfo | null } | null | undefined): number {
  if (!data) return 0
  if (typeof data.costFen === 'number') return data.costFen
  const d = data.delivery
  return d ? (d.actualFee ?? d.quotedFee ?? 0) + d.tipFee + d.cancelFee : 0
}

/**
 * 同城订单历史页：查账页，不是操作面。筛选/检索 + 日期筛选 + 退款入口 + 点整卡进详情页；
 * 接单、呼叫骑手、取消配送、标记送达等操作一律去「接单工作台」（/workbench）做。
 */
export default function LocalOrders() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get('status') ?? ''
  const type = (searchParams.get('type') === 'LOCAL' || searchParams.get('type') === 'PICKUP') ? searchParams.get('type') as 'LOCAL' | 'PICKUP' : ''
  const sched = (searchParams.get('sched') === 'SCHEDULED' || searchParams.get('sched') === 'ASAP') ? searchParams.get('sched') as 'SCHEDULED' | 'ASAP' : ''
  const dateState = readOrderDate(searchParams)
  const now = new Date()
  const dateErr = orderDateError(dateState)
  const [keyword, setKeyword] = useState('')
  const [list, setList] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [deliveryCache, setDeliveryCache] = useState<Record<number, { delivery: DeliveryInfo | null; costFen: number }>>({})
  const [refundTarget, setRefundTarget] = useState<Order | null>(null)
  // 从 Layout 那份轮询取计数，不自己再挂一份（复核 R13）
  const { refundAttentionByChannel } = usePendingCounts()
  const refundAttentionCount = refundAttentionByChannel.LOCAL

  const load = (p = page) => {
    if (dateErr) { setLoading(false); return }
    setLoading(true)
    setLoadFailed(false)
    getOrders({
      page: p,
      pageSize,
      status: status || undefined,
      keyword: keyword.trim() || undefined,
      ...(type ? { deliveryType: type } : { channel: 'LOCAL' }),
      ...(sched && type !== 'PICKUP' ? { schedule: sched } : {}),
      ...orderDateQuery(dateState, new Date()),
    })
      .then((res) => {
        setList(res.data.data.list)
        setTotal(res.data.data.total)
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [page, status, type, sched, searchParams.get('range'), searchParams.get('startDate'), searchParams.get('endDate')])

  const handleSearch = () => {
    setPage(1)
    load(1)
  }

  const handleTabChange = (value: string) => {
    setPage(1)
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      if (value) p.set('status', value); else p.delete('status')
      return p
    }, { replace: true })
  }

  const handleTypeChange = (value: '' | 'LOCAL' | 'PICKUP') => {
    setPage(1)
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      if (value) p.set('type', value); else p.delete('type')
      if (value === 'PICKUP') p.delete('sched') // 自取没有预约/尽快这个维度
      return p
    }, { replace: true })
  }

  const handleSchedChange = (value: '' | 'SCHEDULED' | 'ASAP') => {
    setPage(1)
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      if (value) p.set('sched', value); else p.delete('sched')
      return p
    }, { replace: true })
  }

  const handleDateChange = (s: Parameters<typeof writeOrderDate>[1]) => {
    setPage(1)
    setSearchParams((prev) => writeOrderDate(new URLSearchParams(prev), s), { replace: true })
  }

  // 退款弹窗要用的配送成本：只在打开退款弹窗那一刻现取，不再为每一行预取
  const openRefund = async (order: Order) => {
    if (order.deliveryType === 'LOCAL' && !deliveryCache[order.id]) {
      try {
        const res = await getOrderDelivery(order.id)
        setDeliveryCache((m) => ({ ...m, [order.id]: res.data.data }))
      } catch {
        toast.error('配送信息加载失败，可稍后重试')
      }
    }
    setRefundTarget(order)
  }

  const handleOpen = (order: Order) => {
    navigate(orderDetailPath(order.id), { state: { from: location.pathname + location.search } })
  }

  const summary = orderDateSummary(dateState, now)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-gray-400">查账与检索用；接单、呼叫骑手等操作请到「接单工作台」；点整张卡片看完整详情</p>
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
          {type !== 'PICKUP' && (
            <>
              <span className="text-gray-200">|</span>
              {SCHED_TABS.map((t) => (
                <button
                  key={t.value}
                  onClick={() => handleSchedChange(t.value)}
                  className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap ${
                    sched === t.value ? 'bg-brand-50 text-brand-600 font-medium' : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </>
          )}
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
              {/* 角标口径与 Tab 筛选同一个服务端 where，且只数同城（含自取）——本页只列同城，角标必须与列表同渠道（复核 R9）。
                  角标不随页内二级筛选（外送/自取、日期、关键词）收窄，与「售后」角标同口径：它答的是「全局还有没有活」（复核 R14） */}
              {t.value === REFUND_ATTENTION_FILTER && refundAttentionCount > 0 && (
                <span className="ml-1 inline-flex min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-500 text-white text-[10px] items-center justify-center align-middle">
                  {refundAttentionCount}
                </span>
              )}
            </button>
          ))}
          <button onClick={() => load()} className="ml-auto text-gray-400 hover:text-gray-600 shrink-0" title="刷新" aria-label="刷新">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <OrderDateFilter value={dateState} onChange={handleDateChange} />
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

      {!dateErr && (
        <p className="text-xs text-gray-500">{summary ? `${summary} · ` : ''}共 {total} 单</p>
      )}

      <div className={`bg-white rounded-lg shadow-card overflow-hidden${loading && list.length > 0 ? ' opacity-60 pointer-events-none' : ''}`}>
        <OrderListTable
          list={list}
          loading={loading}
          loadFailed={loadFailed}
          emptyText={dateErr ? '选好起止日期后显示' : type === 'PICKUP' ? '暂无自取订单' : type === 'LOCAL' ? '暂无外送订单' : '暂无同城订单'}
          now={now}
          onOpen={handleOpen}
          renderActions={(o) => (
            <>
              {showWorkbenchLink(o, now) && (
                <Link to="/workbench" className="px-2 py-0.5 rounded-full text-xs bg-brand-50 text-brand-600">
                  去工作台 ›
                </Link>
              )}
              {/* 显示规则在 utils/order-actions.ts 一处判定（2026-09-22 前这里只看余额，
                  没付款就取消的单也画出了退款按钮） */}
              {canRefund(o) && (
                <Button size="sm" variant="danger" onClick={() => openRefund(o)} disabled={hasActiveRefund(o)} title={hasActiveRefund(o) ? '有退款处理中' : ''}>
                  {refundLabel(o)}
                </Button>
              )}
              {/* 退款中：与邮寄页 / 详情页同一套——微信还在走就只给提示，走到失败/异常/没记录才给按钮
                  （2026-09-22 前这页对退款中的单什么都不显示，要点进详情页才有重试） */}
              {o.status === 'REFUNDING' && (
                <>
                  {!hasActiveRefund(o) && (
                    <Button size="sm" variant="danger" onClick={() => openRefund(o)}>
                      {refundRetryLabel(o)}
                    </Button>
                  )}
                  {refundingHint(o) && (
                    <span className={`text-xs self-center whitespace-nowrap ${refundingHint(o) === '退款异常' ? 'text-red-500' : 'text-gray-500'}`}>{refundingHint(o)}</span>
                  )}
                </>
              )}
            </>
          )}
          onRetry={() => load()}
        />
        {!loading && !loadFailed && !(dateErr && list.length === 0) && <Pagination page={page} total={total} pageSize={pageSize} onChange={setPage} />}
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
