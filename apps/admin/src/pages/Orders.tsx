import { Fragment, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Copy, Phone, Printer, RefreshCw, Search, Truck } from 'lucide-react'
import { getOrders, acceptOrder, shipOrder, cancelOrder, completeRefund, completeOrder, reprintOrder } from '../api/admin'
import { toast } from '../components/ui/Toast'
import { confirmDialog } from '../components/ui/ConfirmDialog'
import Button from '../components/ui/Button'
import Modal from '../components/ui/Modal'
import Table from '../components/ui/Table'
import Pagination from '../components/ui/Pagination'
import StatusBadge from '../components/ui/StatusBadge'
import RefundDialog from '../components/RefundDialog'
import IssueCouponModal from '../components/IssueCouponModal'
import AfterSalePanel from '../components/AfterSalePanel'
import { usePendingOrders } from '../hooks/usePendingOrders'
import { AFTER_SALE_STATUS_LABEL, type Order } from '../types'
import { fmtDateTime } from '../utils/time'

// 状态 Tab（含「全部」；REFUNDED 单量少，并入「退款」）
const STATUS_TABS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'PENDING_PAYMENT', label: '待付款' },
  { value: 'PAID', label: '待接单' },
  { value: 'PREPARING', label: '备餐中' },
  { value: 'SHIPPED', label: '已发货' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'CANCELLED', label: '已取消' },
  { value: 'REFUNDING,REFUNDED', label: '退款' },
  { value: 'AFTER_SALE', label: '售后' },
]

const REFUND_LABEL: Record<string, string> = {
  PENDING: '已发起',
  PROCESSING: '微信处理中',
  SUCCESS: '已退款',
  ABNORMAL: '异常',
  CLOSED: '已关闭',
  FAILED: '发起失败',
}

// 快递公司：常用 + 「其他」手填
const EXPRESS_COMPANIES = ['顺丰速运', '京东物流', '中通快递', '圆通速递', '韵达快递', '申通快递', '极兔速递', '邮政 EMS', '德邦快递']
const OTHER = '__other__'

const AUTO_REFRESH_MS = 30_000

function yuan(fen: number) {
  return (fen / 100).toFixed(2)
}

function copyText(text: string) {
  navigator.clipboard?.writeText(text).then(
    () => toast.success('已复制'),
    () => toast.error('复制失败')
  )
}

export default function Orders() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [list, setList] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const filterStatus = searchParams.get('status') ?? ''
  const isAfterSaleTab = filterStatus === 'AFTER_SALE'
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [shipModal, setShipModal] = useState<Order | null>(null)
  const [shipForm, setShipForm] = useState({ company: '', otherCompany: '', expressNo: '', remark: '' })
  const [shipError, setShipError] = useState('')
  const [shipping, setShipping] = useState(false)
  const [refundTarget, setRefundTarget] = useState<Order | null>(null)
  const [couponTarget, setCouponTarget] = useState<Order | null>(null)
  const [reprintingId, setReprintingId] = useState<number | null>(null)
  const { afterSaleCount } = usePendingOrders()
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
    if (!silent) { setLoading(true); setLoadFailed(false) }
    getOrders({
      page: p,
      pageSize,
      status: filterStatus || undefined,
      keyword: keyword.trim() || undefined,
      deliveryType: 'EXPRESS',
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

  useEffect(() => { load() }, [page, filterStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  // 30s 自动静默刷新：页面可见且没有弹窗打开时（避免打断操作）
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || modalOpenRef.current || isAfterSaleTab) return
      load(page, true)
    }, AUTO_REFRESH_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, filterStatus, keyword, isAfterSaleTab])

  const handleSearch = () => {
    setPage(1)
    load(1)
  }

  const handleTabChange = (value: string) => {
    setPage(1)
    setSearchParams(value ? { status: value } : {}, { replace: true })
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

  const handleCompleteRefund = async (order: Order) => {
    const ok = await confirmDialog({
      title: '手动标记退款完成',
      content: `仅在已确认微信商户平台退款成功、但系统未收到回调时使用。确认将订单 ${order.orderNo} 标记为已退款？`,
      danger: true,
      confirmText: '确认标记',
    })
    if (!ok) return
    withToast(() => completeRefund(order.id), '已标记退款完成', '操作失败')
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

  // 退款相关按钮（移动卡片与桌面表格共用）
  const renderRefundActions = (order: Order, cls: { danger: string; muted: string }) => {
    const r = order.latestRefund
    const active = r && ['PENDING', 'PROCESSING', 'ABNORMAL'].includes(r.status)
    if (['PAID', 'PREPARING', 'SHIPPED', 'COMPLETED'].includes(order.status)) {
      if (order.remainingRefundable <= 0) return null
      return (
        <button onClick={() => setRefundTarget(order)} className={cls.danger} disabled={!!active} title={active ? '有退款处理中' : ''}>
          {order.refundedAmount > 0 ? '再退款' : '退款'}
        </button>
      )
    }
    if (order.status !== 'REFUNDING') return null
    return (
      <>
        {!active && (
          <button onClick={() => setRefundTarget(order)} className={cls.danger}>
            {r ? '重试退款' : '发起退款'}
          </button>
        )}
        {r?.status === 'PENDING' || r?.status === 'PROCESSING' ? (
          <span className={cls.muted}>微信处理中</span>
        ) : r?.status === 'ABNORMAL' ? (
          <span className="text-red-500">退款异常</span>
        ) : null}
        <button onClick={() => handleCompleteRefund(order)} className={cls.muted}>
          手动标记完成
        </button>
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

  const renderAfterSaleTag = (order: Order) =>
    order.afterSale && ['PENDING', 'APPROVED'].includes(order.afterSale.status) ? (
      <button
        onClick={() => handleTabChange('AFTER_SALE')}
        className={`px-2 py-0.5 rounded-full text-xs ${order.afterSale.status === 'PENDING' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}
      >
        售后{AFTER_SALE_STATUS_LABEL[order.afterSale.status]}
      </button>
    ) : null

  const renderDetailLines = (order: Order) => (
    <>
      <p className="text-xs text-gray-500 flex items-start gap-1">
        <span className="shrink-0">收货地址：{order.receiverDisplayAddress ?? order.receiverFullAddress}</span>
        <button onClick={() => copyText(`${order.receiverName} ${order.receiverPhone} ${order.receiverFullAddress}`)} className="text-gray-400 hover:text-gray-600 shrink-0" title="复制收件信息" aria-label="复制收件信息">
          <Copy className="w-3 h-3" />
        </button>
      </p>
      {order.remark && <p className="text-xs text-orange-700 bg-orange-50 rounded px-2 py-1">买家备注：{order.remark}</p>}
      {/* 会员优惠（M2）。放在支付时间之前：店员看这一段是为了核对「顾客到底付了多少、为什么」，
          优惠是这个问题的一部分，时间不是。两个字段服务端只在 >0 时才有意义，为 0 就不占一行 */}
      {(order.discountAmount ?? 0) > 0 && (
        <p className="text-xs text-gray-500">
          优惠券：<span className="text-red-500">−¥{yuan(order.discountAmount!)}</span>
          <span className="ml-1 text-gray-400">（商品 ¥{yuan(order.totalAmount)} 运费 ¥{yuan(order.shippingFee)}）</span>
        </p>
      )}
      {(order.pointsUsed ?? 0) > 0 && (
        <p className="text-xs text-gray-500">赠品抵扣：{order.pointsUsed} 积分</p>
      )}
      {order.paidAt && <p className="text-xs text-gray-500">支付时间：{fmtDateTime(order.paidAt)}</p>}
      {order.cancelReason && (order.status === 'CANCELLED' || order.status === 'REFUNDING' || order.status === 'REFUNDED') && (
        <p className="text-xs text-gray-500">原因：{order.cancelReason}</p>
      )}
      {(order.refundedAmount > 0 || order.latestRefund) && (
        <p className={`text-xs ${order.latestRefund && !['SUCCESS'].includes(order.latestRefund.status) ? 'text-red-500' : 'text-gray-500'}`}>
          退款：已退 ¥{yuan(order.refundedAmount)}
          {order.latestRefund && ` · 最近一笔 ${REFUND_LABEL[order.latestRefund.status]} ¥${yuan(order.latestRefund.amount)}`}
          {order.latestRefund?.errorMessage && `（${order.latestRefund.errorMessage}）`}
        </p>
      )}
      {order.shipment?.expressNo && (
        <p className="text-xs text-gray-500">
          物流：{order.shipment.expressCompany} {order.shipment.expressNo}
          {order.shipment.shippedAt && `（${fmtDateTime(order.shipment.shippedAt)} 发货）`}
          {order.shipment.remark && ` 备注：${order.shipment.remark}`}
        </p>
      )}
    </>
  )

  const renderActions = (order: Order, cls: { primary: string; danger: string; muted: string; link: string }, expandLabel: [string, string]) => (
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
      {order.userId !== undefined && !['PENDING_PAYMENT', 'CANCELLED'].includes(order.status) && (
        <button onClick={() => setCouponTarget(order)} className={cls.muted} title="给这位顾客发一张赔偿券（不退款）">
          发赔偿券
        </button>
      )}
      {order.status === 'PENDING_PAYMENT' && <button onClick={() => handleCancel(order)} className={cls.danger}>取消</button>}
      {order.status !== 'PENDING_PAYMENT' && (
        <button onClick={() => handleReprint(order)} disabled={reprintingId === order.id} className={`${cls.muted} disabled:opacity-40 inline-flex items-center gap-1`} title="重打该单小票（票卡纸/被撕坏/没看见时用）">
          <Printer className="w-3.5 h-3.5" />
          {reprintingId === order.id ? '发送中...' : '重打小票'}
        </button>
      )}
      <button onClick={() => setExpanded(expanded === order.id ? null : order.id)} className={cls.link}>
        {expanded === order.id ? expandLabel[1] : expandLabel[0]}
      </button>
    </>
  )

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-800">邮寄订单</h2>

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
            </button>
          ))}
        </div>
      </div>

      {isAfterSaleTab ? (
        <AfterSalePanel />
      ) : (
        <>
          <div className="bg-white rounded-lg shadow-card p-3 md:p-4 flex gap-2 md:gap-3 items-end">
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

          {staleMinutes != null && !loadFailed && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-1.5 text-xs text-amber-800 flex items-center justify-between gap-3">
              <span>自动刷新失败，订单数据已 {staleMinutes < 1 ? '不足 1' : staleMinutes} 分钟未更新，下面可能不是最新的</span>
              <button onClick={() => load()} className="underline shrink-0">立即刷新</button>
            </div>
          )}

          <div className="bg-white rounded-lg shadow-card overflow-hidden">
            {loadFailed ? (
              <div className="py-10 flex flex-col items-center gap-3 text-sm text-red-600">
                <span>订单列表加载失败，当前显示的不是真实数据</span>
                <Button size="sm" variant="secondary" onClick={() => load()}>重试</Button>
              </div>
            ) : (
            <Table
              columns={6}
              loading={loading}
              isEmpty={list.length === 0}
              emptyText="暂无订单"
              head={
                <tr>
                  <th className="text-left px-4 py-3">订单号</th>
                  <th className="text-left px-4 py-3">收货人</th>
                  <th className="text-right px-4 py-3">实付金额</th>
                  <th className="text-right px-4 py-3">状态</th>
                  <th className="text-right px-4 py-3">下单时间</th>
                  <th className="text-right px-4 py-3">操作</th>
                </tr>
              }
              mobileCards={
                <>
                  {list.map((order) => (
                    <div key={order.id} className="border border-gray-100 rounded-lg p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-gray-600 truncate">{order.orderNo}</span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          {renderAfterSaleTag(order)}
                          <StatusBadge status={order.status} />
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <span className="text-sm text-gray-800 flex items-center gap-1.5 min-w-0">
                          <span className="truncate">{order.receiverName}</span>
                          {renderPhone(order)}
                        </span>
                        <span className="text-base font-semibold text-brand-600 shrink-0">¥{yuan(order.actualAmount)}</span>
                      </div>
                      {order.remark && <p className="text-xs text-orange-700 bg-orange-50 rounded px-2 py-1 mt-1.5">备注：{order.remark}</p>}
                      <p className="text-xs text-gray-400 mt-1">
                        {fmtDateTime(order.createdAt)}
                        {order.refundedAmount > 0 && <span className="ml-2 text-red-500">已退 ¥{yuan(order.refundedAmount)}</span>}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
                        {renderActions(
                          order,
                          { primary: 'text-brand-500 font-medium', danger: 'text-red-500 font-medium disabled:opacity-40', muted: 'text-gray-500', link: 'text-blue-500' },
                          ['详情', '收起']
                        )}
                      </div>
                      {expanded === order.id && (
                        <div className="mt-2 pt-2 border-t border-gray-100 space-y-1.5">
                          {renderDetailLines(order)}
                          {order.items.map((item, i) => (
                            <div key={i} className="flex justify-between text-xs text-gray-700">
                              <span className="truncate">
                                {item.isGift && <span className="mr-1 text-[10px] text-orange-600 bg-orange-50 rounded px-1">赠</span>}
                                {item.productName}
                                {item.specText && <span className="text-gray-400"> [{item.specText}]</span>}
                                {' '}× {item.quantity}
                              </span>
                              {/* 赠品行 subtotal 恒为 0，直接显示 ¥0.00 会被当成 0 元 bug；印出积分价才说得清 */}
                              <span className="shrink-0">
                                {item.isGift ? `积分 ${item.pointsCost ?? 0}` : `¥${yuan(item.subtotal)}`}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              }
            >
              {list.map((order) => (
                <Fragment key={order.id}>
                  <tr className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-gray-700">
                      {order.orderNo}
                      {order.remark && <span className="ml-1.5 text-[10px] text-orange-600 bg-orange-50 rounded px-1" title={order.remark}>备注</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-800">
                      {order.receiverName} {renderPhone(order)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-brand-600">
                      ¥{yuan(order.actualAmount)}
                      {order.refundedAmount > 0 && <div className="text-xs font-normal text-red-500">已退 ¥{yuan(order.refundedAmount)}</div>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="inline-flex items-center gap-1.5">
                        {renderAfterSaleTag(order)}
                        <StatusBadge status={order.status} />
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500">{fmtDateTime(order.createdAt)}</td>
                    <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                      {renderActions(
                        order,
                        {
                          primary: 'text-brand-500 hover:text-brand-700 font-medium',
                          danger: 'text-red-500 hover:text-red-700 font-medium disabled:opacity-40',
                          muted: 'text-gray-500 hover:text-gray-700',
                          link: 'text-blue-500 hover:text-blue-700',
                        },
                        ['展开', '收起']
                      )}
                    </td>
                  </tr>
                  {expanded === order.id && (
                    <tr>
                      <td colSpan={6} className="px-4 py-3 bg-gray-50">
                        <div className="space-y-1 mb-2">{renderDetailLines(order)}</div>
                        <table className="w-full text-xs">
                          <thead className="text-gray-500">
                            <tr>
                              <th className="text-left pb-1">商品</th>
                              <th className="text-right pb-1">单价</th>
                              <th className="text-right pb-1">数量</th>
                              <th className="text-right pb-1">小计</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-200">
                            {order.items.map((item, i) => (
                              <tr key={i}>
                                <td className="py-1 text-gray-700">
                                  {item.isGift && <span className="mr-1 text-[10px] text-orange-600 bg-orange-50 rounded px-1">赠</span>}
                                  {item.productName}
                                  {item.specText && <span className="ml-1.5 text-xs text-gray-400">[{item.specText}]</span>}
                                </td>
                                {/* 赠品的 productPrice/subtotal 恒为 0。显示 ¥0.00 会让人以为算错了，
                                    单价栏印积分价、小计栏印「—」，才看得出这是一件不收钱的东西 */}
                                <td className="py-1 text-right text-gray-600">
                                  {item.isGift ? `积分 ${item.pointsCost ?? 0}` : `¥${yuan(item.productPrice)}`}
                                </td>
                                <td className="py-1 text-right text-gray-600">{item.quantity}</td>
                                <td className="py-1 text-right text-gray-800">
                                  {item.isGift ? '—' : `¥${yuan(item.subtotal)}`}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </Table>
            )}
            {!loading && !loadFailed && <Pagination page={page} total={total} pageSize={pageSize} onChange={setPage} />}
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
