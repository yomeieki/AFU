import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Copy, Phone, Printer, RefreshCw, Search, Truck } from 'lucide-react'
import { getOrders, acceptOrder, shipOrder, cancelOrder, completeOrder, reprintOrder } from '../api/admin'
import { toast } from '../components/ui/Toast'
import { confirmDialog } from '../components/ui/ConfirmDialog'
import Button from '../components/ui/Button'
import Modal from '../components/ui/Modal'
import Pagination from '../components/ui/Pagination'
import RefundDialog from '../components/RefundDialog'
import IssueCouponModal from '../components/IssueCouponModal'
import AfterSalePanel from '../components/AfterSalePanel'
import { usePendingOrders } from '../hooks/usePendingOrders'
import type { Order } from '../types'
import OrderListTable from '../components/orders/OrderListTable'
import OrderDateFilter from '../components/orders/OrderDateFilter'
import { orderDetailPath } from '../navigation'
import { readOrderDate, writeOrderDate, orderDateQuery, orderDateError, orderDateSummary } from '../utils/order-date-range'
import { canRefund, hasActiveRefund, refundLabel, canReprint, canIssueCoupon, REFUND_ATTENTION_FILTER, refundRetryLabel, refundingHint } from '../utils/order-actions'

// 状态 Tab（含「全部」）。「退款待处理」只列要人出手的退款中订单（伪状态，见 utils/order-actions.ts）；
// 正常退款中的单由自动补查推到结局，不单独给 Tab，在「全部」里能看到状态标签。
const STATUS_TABS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'PENDING_PAYMENT', label: '待付款' },
  { value: 'PAID', label: '待接单' },
  { value: 'PREPARING', label: '备餐中' },
  { value: 'SHIPPED', label: '已发货' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'CANCELLED', label: '已取消' },
  { value: REFUND_ATTENTION_FILTER, label: '退款待处理' },
  { value: 'REFUNDED', label: '已退款' },
  { value: 'AFTER_SALE', label: '售后' },
]

// 快递公司：常用 + 「其他」手填
const EXPRESS_COMPANIES = ['顺丰速运', '京东物流', '中通快递', '圆通速递', '韵达快递', '申通快递', '极兔速递', '邮政 EMS', '德邦快递']
const OTHER = '__other__'

const AUTO_REFRESH_MS = 30_000

function copyText(text: string) {
  navigator.clipboard?.writeText(text).then(
    () => toast.success('已复制'),
    () => toast.error('复制失败')
  )
}

export default function Orders() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [list, setList] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const filterStatus = searchParams.get('status') ?? ''
  const isAfterSaleTab = filterStatus === 'AFTER_SALE'
  const dateState = readOrderDate(searchParams)
  const now = new Date()
  const dateErr = orderDateError(dateState)
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(true)
  const [shipModal, setShipModal] = useState<Order | null>(null)
  const [shipForm, setShipForm] = useState({ company: '', otherCompany: '', expressNo: '', remark: '' })
  const [shipError, setShipError] = useState('')
  const [shipping, setShipping] = useState(false)
  const [refundTarget, setRefundTarget] = useState<Order | null>(null)
  const [couponTarget, setCouponTarget] = useState<Order | null>(null)
  const [reprintingId, setReprintingId] = useState<number | null>(null)
  const { afterSaleCount, refundAttentionCount } = usePendingOrders()
  const modalOpenRef = useRef(false)
  modalOpenRef.current = !!(shipModal || refundTarget)
  // 没有 catch 的话接口一挂就渲染「暂无订单」，店主会当成今天没单。
  // 显式刷新失败 → 错误态替换表格；30s 静默刷新失败 → 表格留着旧数据，
  // 但要有一条「已 N 分钟未更新」细条（思路同 Workbench 顶栏），否则店主分不清「没新单」和「页面早僵了」。
  const [loadFailed, setLoadFailed] = useState(false)
  const [lastOkAt, setLastOkAt] = useState<number | null>(null)
  const [silentFailCount, setSilentFailCount] = useState(0)

  const load = (p = page, silent = false) => {
    if (isAfterSaleTab) return
    if (dateErr) { setLoading(false); return }
    if (!silent) { setLoading(true); setLoadFailed(false) }
    getOrders({
      page: p,
      pageSize,
      status: filterStatus || undefined,
      keyword: keyword.trim() || undefined,
      deliveryType: 'EXPRESS',
      ...orderDateQuery(dateState, new Date()),
    })
      .then((res) => {
        setList(res.data.data.list)
        setTotal(res.data.data.total)
        setLoadFailed(false)
        setLastOkAt(Date.now())
        setSilentFailCount(0)
      })
      .catch(() => {
        // 计数递增而不是只置布尔：每次失败都触发一次重渲染，细条上的分钟数才会跟着走
        if (silent) setSilentFailCount((c) => c + 1)
        else setLoadFailed(true)
      })
      .finally(() => { if (!silent) setLoading(false) })
  }
  const staleMinutes = silentFailCount > 0 && lastOkAt != null ? Math.floor((Date.now() - lastOkAt) / 60000) : null

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [page, filterStatus, searchParams.get('range'), searchParams.get('startDate'), searchParams.get('endDate')])

  // 30s 自动静默刷新：页面可见且没有弹窗打开时（避免打断操作）
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || modalOpenRef.current || isAfterSaleTab) return
      load(page, true)
    }, AUTO_REFRESH_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, filterStatus, keyword, isAfterSaleTab, dateState.range, dateState.startDate, dateState.endDate])

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

  const handleDateChange = (s: Parameters<typeof writeOrderDate>[1]) => {
    setPage(1)
    setSearchParams((prev) => writeOrderDate(new URLSearchParams(prev), s), { replace: true })
  }

  const handleOpen = (order: Order) => {
    navigate(orderDetailPath(order.id), { state: { from: location.pathname + location.search } })
  }

  const withToast = async (fn: () => Promise<unknown>, okMsg: string, failMsg: string) => {
    try {
      await fn()
      toast.success(okMsg)
      load()
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? failMsg)
    }
  }

  const handleAccept = (order: Order) => withToast(() => acceptOrder(order.id), '已接单，开始备餐', '接单失败')

  // 票卡纸、被撕坏、店员没看见是日常——不弹确认框（不是危险操作，只是多打一张纸）
  const handleReprint = async (order: Order) => {
    setReprintingId(order.id)
    try {
      const r = await reprintOrder(order.id)
      toast[r.enqueued ? 'success' : 'error'](
        r.enqueued
          ? '已发送重打'
          : { PRINTER_DISABLED: '打印机功能未启用', NO_PRINTER_CONFIGURED: '该单所属渠道尚未配置打印机' }[r.reason ?? ''] ?? '重打失败'
      )
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '重打失败')
    } finally {
      setReprintingId(null)
    }
  }

  const handleComplete = async (order: Order) => {
    const ok = await confirmDialog({
      title: '标记完成',
      content: `确认订单 ${order.orderNo} 已送达并完成？（发货 7 天后系统也会自动完成）`,
      confirmText: '标记完成',
    })
    if (!ok) return
    withToast(() => completeOrder(order.id), '订单已完成', '操作失败')
  }

  const handleCancel = async (order: Order) => {
    const ok = await confirmDialog({
      title: '取消订单',
      content: `确认取消订单 ${order.orderNo}？库存将回滚。`,
      danger: true,
    })
    if (!ok) return
    withToast(() => cancelOrder(order.id), '订单已取消', '取消失败')
  }

  const openShipModal = (order: Order) => {
    setShipModal(order)
    setShipForm({ company: '', otherCompany: '', expressNo: '', remark: '' })
    setShipError('')
  }

  const handleShip = async () => {
    if (!shipModal) return
    const company = shipForm.company === OTHER ? shipForm.otherCompany.trim() : shipForm.company
    if (!company) { setShipError(shipForm.company === OTHER ? '请填写快递公司名称' : '请选择快递公司'); return }
    if (!shipForm.expressNo.trim()) { setShipError('请填写快递单号'); return }
    setShipping(true)
    setShipError('')
    try {
      await shipOrder(shipModal.id, {
        expressCompany: company,
        expressNo: shipForm.expressNo.trim(),
        remark: shipForm.remark.trim() || undefined,
      })
      setShipModal(null)
      toast.success('发货成功')
      load()
    } catch (err: unknown) {
      setShipError((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '发货失败')
    } finally {
      setShipping(false)
    }
  }

  // 退款相关按钮（卡片与表格共用同一套样式，见 renderActions 的说明）
  // 显示规则在 utils/order-actions.ts 一处判定，与 LocalOrders / DetailActions 共用
  const renderRefundActions = (order: Order, cls: { danger: string; muted: string }) => {
    const active = hasActiveRefund(order)
    if (order.status !== 'REFUNDING') {
      if (!canRefund(order)) return null
      return (
        <button onClick={() => setRefundTarget(order)} className={cls.danger} disabled={active} title={active ? '有退款处理中' : ''}>
          {refundLabel(order)}
        </button>
      )
    }
    const hint = refundingHint(order)
    return (
      <>
        {!active && (
          <button onClick={() => setRefundTarget(order)} className={cls.danger}>
            {refundRetryLabel(order)}
          </button>
        )}
        {hint === '微信处理中' ? <span className={cls.muted}>{hint}</span> : hint === '退款异常' ? <span className="text-red-500">{hint}</span> : null}
        {/* 「手动标记完成」2026-09-22 已去掉：不问微信、不核金额就把单标成已退款，误点就是一笔假退款；
            回调丢失的场景由自动补查（services/refund-reconcile.ts）自己查微信落账 */}
      </>
    )
  }

  const renderPhone = (order: Order) => (
    <span className="inline-flex items-center gap-1.5">
      <a href={`tel:${order.receiverPhone}`} className="text-brand-600 inline-flex items-center gap-0.5 hover:underline">
        <Phone className="w-3.5 h-3.5" />
        {order.receiverPhone}
      </a>
      <button onClick={() => copyText(order.receiverPhone)} className="text-gray-400 hover:text-gray-600" title="复制手机号" aria-label="复制手机号">
        <Copy className="w-3.5 h-3.5" />
      </button>
    </span>
  )

  // 详情页整合了原来那块可折叠的行内明细（收货地址/优惠明细/支付时间/退款/物流等），
  // 列表这里不再需要那个折叠开关——renderActions 只保留业务操作按钮，一字不改顺序。
  const renderActions = (order: Order, cls: { primary: string; danger: string; muted: string }) => (
    <>
      {order.status === 'PAID' && (
        <>
          <button onClick={() => handleAccept(order)} className={cls.primary}>接单</button>
          <button onClick={() => openShipModal(order)} className={cls.muted}>直接发货</button>
        </>
      )}
      {order.status === 'PREPARING' && <button onClick={() => openShipModal(order)} className={cls.primary}>发货</button>}
      {order.status === 'SHIPPED' && <button onClick={() => handleComplete(order)} className={cls.muted}>标记完成</button>}
      {renderRefundActions(order, cls)}
      {/* 「发赔偿券」对**有成功支付记录**的单显示（M3 D2 默认），与「退款」并列且可单独使用——
          spec §7：可以只发券不退款。待付款与已取消的单没有可赔偿的交易，不显示。
          order.userId 来自 orderListSelect（M2 加的），列表里就有，不用先点进详情 */}
      {canIssueCoupon(order) && (
        <button onClick={() => setCouponTarget(order)} className={cls.muted} title="给这位顾客发一张赔偿券（不退款）">
          发赔偿券
        </button>
      )}
      {order.status === 'PENDING_PAYMENT' && <button onClick={() => handleCancel(order)} className={cls.danger}>取消</button>}
      {canReprint(order) && (
        <button onClick={() => handleReprint(order)} disabled={reprintingId === order.id} className={`${cls.muted} disabled:opacity-40 inline-flex items-center gap-1`} title="重打该单小票（票卡纸/被撕坏/没看见时用）">
          <Printer className="w-3.5 h-3.5" />
          {reprintingId === order.id ? '发送中...' : '重打小票'}
        </button>
      )}
    </>
  )

  // 卡片与表格用同一套配色（桌面 hover 配色），不再需要分两套——按钮组里那个折叠开关已经去掉了
  const actionCls = {
    primary: 'text-brand-500 hover:text-brand-700 font-medium',
    danger: 'text-red-500 hover:text-red-700 font-medium disabled:opacity-40',
    muted: 'text-gray-500 hover:text-gray-700',
  }

  const summary = orderDateSummary(dateState, now)

  return (
    <div className="space-y-4">
      {/* 状态 Tab */}
      <div className="bg-white rounded-lg shadow-card px-2 overflow-x-auto">
        <div className="flex min-w-max">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => handleTabChange(tab.value)}
              className={`px-4 py-3 text-sm border-b-2 transition-colors whitespace-nowrap ${
                filterStatus === tab.value
                  ? 'border-brand-500 text-brand-600 font-medium'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`}
            >
              {tab.label}
              {tab.value === 'AFTER_SALE' && afterSaleCount > 0 && (
                <span className="ml-1 inline-flex min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-500 text-white text-[10px] items-center justify-center align-middle">
                  {afterSaleCount}
                </span>
              )}
              {/* 角标口径与 Tab 筛选同一个服务端 where；数的是全渠道，本页只列邮寄，所以角标可能比列表多 */}
              {tab.value === REFUND_ATTENTION_FILTER && refundAttentionCount > 0 && (
                <span className="ml-1 inline-flex min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-500 text-white text-[10px] items-center justify-center align-middle">
                  {refundAttentionCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {isAfterSaleTab ? (
        <AfterSalePanel />
      ) : (
        <>
          <div className="bg-white rounded-lg shadow-card p-3 md:p-4 space-y-2">
            <div className="flex gap-2 md:gap-3 items-end">
              <div className="flex-1 min-w-0">
                <label className="block text-xs text-gray-500 mb-1">搜索</label>
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
                  placeholder="订单号 / 收货人 / 手机号"
                  className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-full"
                />
              </div>
              <Button variant="secondary" size="sm" className="shrink-0" onClick={handleSearch}>
                <Search className="w-4 h-4" />
                搜索
              </Button>
              <Button variant="ghost" size="sm" className="shrink-0" onClick={() => load()} title="刷新（每 30 秒自动刷新）">
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
            <OrderDateFilter value={dateState} onChange={handleDateChange} />
          </div>

          {staleMinutes != null && !loadFailed && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-1.5 text-xs text-amber-800 flex items-center justify-between gap-3">
              <span>自动刷新失败，订单数据已 {staleMinutes < 1 ? '不足 1' : staleMinutes} 分钟未更新，下面可能不是最新的</span>
              <button onClick={() => load()} className="underline shrink-0">立即刷新</button>
            </div>
          )}

          {!dateErr && <p className="text-xs text-gray-500">{summary ? `${summary} · ` : ''}共 {total} 单</p>}

          <div className="bg-white rounded-lg shadow-card overflow-hidden">
            <OrderListTable
              list={list}
              loading={loading}
              loadFailed={loadFailed}
              emptyText={dateErr ? '选好起止日期后显示' : '暂无订单'}
              now={now}
              onOpen={handleOpen}
              renderActions={(o) => renderActions(o, actionCls)}
              onAfterSaleTag={() => handleTabChange('AFTER_SALE')}
              onRetry={() => load()}
            />
            {!loading && !loadFailed && !(dateErr && list.length === 0) && <Pagination page={page} total={total} pageSize={pageSize} onChange={setPage} />}
          </div>
        </>
      )}

      {refundTarget && (
        <RefundDialog
          order={refundTarget}
          onClose={() => setRefundTarget(null)}
          onDone={() => {
            setRefundTarget(null)
            load()
          }}
        />
      )}

      {couponTarget?.userId !== undefined && couponTarget && (
        <IssueCouponModal
          userId={couponTarget.userId}
          userLabel={couponTarget.receiverName}
          defaultOrderNo={couponTarget.orderNo}
          onClose={() => setCouponTarget(null)}
          onDone={() => setCouponTarget(null)}
        />
      )}

      {shipModal && (
        <Modal
          title="订单发货"
          width="sm"
          onClose={() => setShipModal(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setShipModal(null)}>取消</Button>
              <Button loading={shipping} onClick={handleShip}>
                <Truck className="w-4 h-4" />
                {shipping ? '发货中...' : '确认发货'}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <div className="text-xs text-gray-500 space-y-1 bg-gray-50 rounded-md p-3">
              <p>订单号：<span className="font-mono">{shipModal.orderNo}</span></p>
              <p>收货人：{shipModal.receiverName} {renderPhone(shipModal)}</p>
              <p>地址：{shipModal.receiverFullAddress}</p>
              {shipModal.remark && <p className="text-orange-700">买家备注：{shipModal.remark}</p>}
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">快递公司 *</label>
                <select
                  value={shipForm.company}
                  onChange={(e) => setShipForm({ ...shipForm, company: e.target.value })}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-400"
                >
                  <option value="">请选择快递公司</option>
                  {EXPRESS_COMPANIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  <option value={OTHER}>其他（手动填写）</option>
                </select>
                {shipForm.company === OTHER && (
                  <input
                    value={shipForm.otherCompany}
                    autoFocus
                    maxLength={64}
                    onChange={(e) => setShipForm({ ...shipForm, otherCompany: e.target.value })}
                    placeholder="请输入快递公司名称"
                    className="mt-2 w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">快递单号 *</label>
                <input
                  value={shipForm.expressNo}
                  onChange={(e) => setShipForm({ ...shipForm, expressNo: e.target.value })}
                  placeholder="请输入快递单号"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">备注</label>
                <input
                  value={shipForm.remark}
                  onChange={(e) => setShipForm({ ...shipForm, remark: e.target.value })}
                  placeholder="可选，顾客可见"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                />
              </div>
            </div>
            {shipError && <p className="text-red-500 text-sm">{shipError}</p>}
          </div>
        </Modal>
      )}
    </div>
  )
}
