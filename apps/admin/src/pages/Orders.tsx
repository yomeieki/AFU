import { Fragment, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, Truck } from 'lucide-react'
import { getOrders, acceptOrder, shipOrder, cancelOrder, registerRefund, completeRefund } from '../api/admin'
import { toast } from '../components/ui/Toast'
import { confirmDialog } from '../components/ui/ConfirmDialog'
import Button from '../components/ui/Button'
import Modal from '../components/ui/Modal'
import Table from '../components/ui/Table'
import Pagination from '../components/ui/Pagination'
import StatusBadge from '../components/ui/StatusBadge'
import type { Order } from '../types'

// 状态 Tab（含「全部」；REFUNDED 单量少，并入下拉搜索即可不占 Tab 位）
const STATUS_TABS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'PENDING_PAYMENT', label: '待付款' },
  { value: 'PAID', label: '待接单' },
  { value: 'PREPARING', label: '备餐中' },
  { value: 'SHIPPED', label: '已发货' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'CANCELLED', label: '已取消' },
  { value: 'REFUNDING,REFUNDED', label: '退款' },
]

export default function Orders() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [list, setList] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const filterStatus = searchParams.get('status') ?? ''
  const [filterOrderNo, setFilterOrderNo] = useState('')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [shipModal, setShipModal] = useState<Order | null>(null)
  const [shipForm, setShipForm] = useState({ expressCompany: '', expressNo: '', remark: '' })
  const [shipError, setShipError] = useState('')
  const [shipping, setShipping] = useState(false)

  const load = (p = page) => {
    setLoading(true)
    getOrders({
      page: p,
      pageSize,
      status: filterStatus || undefined,
      orderNo: filterOrderNo || undefined,
    })
      .then((res) => {
        setList(res.data.data.list)
        setTotal(res.data.data.total)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [page, filterStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    setPage(1)
    load(1)
  }

  const handleTabChange = (value: string) => {
    setPage(1)
    setSearchParams(value ? { status: value } : {}, { replace: true })
  }

  const handleAccept = async (order: Order) => {
    try {
      await acceptOrder(order.id)
      toast.success('已接单，开始备餐')
      load()
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '接单失败'
      )
    }
  }

  const handleRegisterRefund = async (order: Order) => {
    const shipped = order.status === 'SHIPPED'
    const ok = await confirmDialog({
      title: '登记退款',
      content: `确认为订单 ${order.orderNo} 登记退款？${shipped ? '（已发货订单不回滚库存）' : '库存将回滚。'}登记后请到微信商户平台完成打款，再回来标记「退款完成」。`,
      danger: true,
      confirmText: '登记退款',
    })
    if (!ok) return
    try {
      await registerRefund(order.id)
      toast.success('已登记，请到商户平台完成打款')
      load()
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '操作失败'
      )
    }
  }

  const handleCompleteRefund = async (order: Order) => {
    const ok = await confirmDialog({
      title: '退款完成',
      content: `确认已在微信商户平台完成订单 ${order.orderNo} 的退款打款？`,
      confirmText: '已完成打款',
    })
    if (!ok) return
    try {
      await completeRefund(order.id)
      toast.success('已标记退款完成')
      load()
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '操作失败'
      )
    }
  }

  const openShipModal = (order: Order) => {
    setShipModal(order)
    setShipForm({ expressCompany: '', expressNo: '', remark: '' })
    setShipError('')
  }

  const handleShip = async () => {
    if (!shipModal) return
    if (!shipForm.expressCompany.trim()) { setShipError('请填写快递公司'); return }
    if (!shipForm.expressNo.trim()) { setShipError('请填写快递单号'); return }
    setShipping(true)
    setShipError('')
    try {
      await shipOrder(shipModal.id, {
        expressCompany: shipForm.expressCompany.trim(),
        expressNo: shipForm.expressNo.trim(),
        remark: shipForm.remark.trim() || undefined,
      })
      setShipModal(null)
      toast.success('发货成功')
      load()
    } catch (err: unknown) {
      setShipError(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '发货失败'
      )
    } finally {
      setShipping(false)
    }
  }

  const handleCancel = async (order: Order) => {
    const ok = await confirmDialog({
      title: '取消订单',
      content: `确认取消订单 ${order.orderNo}？库存将回滚。`,
      danger: true,
    })
    if (!ok) return
    try {
      await cancelOrder(order.id)
      toast.success('订单已取消')
      load()
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '取消失败'
      )
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-800">订单管理</h2>

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
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-card p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">订单号</label>
          <input
            value={filterOrderNo}
            onChange={(e) => setFilterOrderNo(e.target.value)}
            placeholder="搜索订单号"
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-44"
          />
        </div>
        <Button variant="secondary" size="sm" onClick={handleSearch}>
          <Search className="w-4 h-4" />
          搜索
        </Button>
      </div>

      <div className="bg-white rounded-lg shadow-card overflow-hidden">
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
                    <StatusBadge status={order.status} />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-sm text-gray-800">
                      {order.receiverName} {order.receiverPhone}
                    </span>
                    <span className="text-base font-semibold text-brand-600">
                      ¥{(order.actualAmount / 100).toFixed(2)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    {new Date(order.createdAt).toLocaleString('zh-CN')}
                  </p>
                  <div className="mt-2 flex gap-3 text-sm">
                    {order.status === 'PAID' && (
                      <>
                        <button onClick={() => handleAccept(order)} className="text-brand-500 font-medium">接单</button>
                        <button onClick={() => openShipModal(order)} className="text-gray-500">直接发货</button>
                      </>
                    )}
                    {order.status === 'PREPARING' && (
                      <button onClick={() => openShipModal(order)} className="text-brand-500 font-medium">发货</button>
                    )}
                    {['PAID', 'PREPARING', 'SHIPPED'].includes(order.status) && (
                      <button onClick={() => handleRegisterRefund(order)} className="text-red-400">登记退款</button>
                    )}
                    {order.status === 'REFUNDING' && (
                      <button onClick={() => handleCompleteRefund(order)} className="text-brand-500 font-medium">退款完成</button>
                    )}
                    {order.status === 'PENDING_PAYMENT' && (
                      <button onClick={() => handleCancel(order)} className="text-red-500">取消</button>
                    )}
                    <button
                      onClick={() => setExpanded(expanded === order.id ? null : order.id)}
                      className="text-blue-500"
                    >
                      {expanded === order.id ? '收起' : '详情'}
                    </button>
                  </div>
                  {expanded === order.id && (
                    <div className="mt-2 pt-2 border-t border-gray-100 space-y-1.5">
                      <p className="text-xs text-gray-500">收货地址：{order.receiverFullAddress}</p>
                      {order.paidAt && (
                        <p className="text-xs text-gray-500">支付时间：{new Date(order.paidAt).toLocaleString('zh-CN')}</p>
                      )}
                      {order.shipment?.expressNo && (
                        <p className="text-xs text-gray-500">
                          物流：{order.shipment.expressCompany} {order.shipment.expressNo}
                        </p>
                      )}
                      {order.items.map((item, i) => (
                        <div key={i} className="flex justify-between text-xs text-gray-700">
                          <span className="truncate">
                            {item.productName}
                            {item.specText && <span className="text-gray-400"> [{item.specText}]</span>}
                            {' '}× {item.quantity}
                          </span>
                          <span className="shrink-0">¥{(item.subtotal / 100).toFixed(2)}</span>
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
                <td className="px-4 py-3 font-mono text-gray-700">{order.orderNo}</td>
                <td className="px-4 py-3 text-gray-800">
                  {order.receiverName} {order.receiverPhone}
                </td>
                <td className="px-4 py-3 text-right font-semibold text-brand-600">
                  ¥{(order.actualAmount / 100).toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right">
                  <StatusBadge status={order.status} />
                </td>
                <td className="px-4 py-3 text-right text-gray-500">
                  {new Date(order.createdAt).toLocaleString('zh-CN')}
                </td>
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  {order.status === 'PAID' && (
                    <>
                      <button
                        onClick={() => handleAccept(order)}
                        className="text-brand-500 hover:text-brand-700 font-medium"
                      >
                        接单
                      </button>
                      <button
                        onClick={() => openShipModal(order)}
                        className="text-gray-500 hover:text-gray-700"
                      >
                        直接发货
                      </button>
                    </>
                  )}
                  {order.status === 'PREPARING' && (
                    <button
                      onClick={() => openShipModal(order)}
                      className="text-brand-500 hover:text-brand-700 font-medium"
                    >
                      发货
                    </button>
                  )}
                  {['PAID', 'PREPARING', 'SHIPPED'].includes(order.status) && (
                    <button
                      onClick={() => handleRegisterRefund(order)}
                      className="text-red-400 hover:text-red-600"
                    >
                      登记退款
                    </button>
                  )}
                  {order.status === 'REFUNDING' && (
                    <button
                      onClick={() => handleCompleteRefund(order)}
                      className="text-brand-500 hover:text-brand-700 font-medium"
                    >
                      退款完成
                    </button>
                  )}
                  {order.status === 'PENDING_PAYMENT' && (
                    <button
                      onClick={() => handleCancel(order)}
                      className="text-red-500 hover:text-red-700"
                    >
                      取消
                    </button>
                  )}
                  <button
                    onClick={() => setExpanded(expanded === order.id ? null : order.id)}
                    className="text-blue-500 hover:text-blue-700"
                  >
                    {expanded === order.id ? '收起' : '展开'}
                  </button>
                </td>
              </tr>
              {expanded === order.id && (
                <tr>
                  <td colSpan={6} className="px-4 py-3 bg-gray-50">
                    <div className="text-xs text-gray-500 mb-2">
                      收货地址：{order.receiverFullAddress}
                      {order.paidAt && `　支付时间：${new Date(order.paidAt).toLocaleString('zh-CN')}`}
                      {order.remark && `　买家备注：${order.remark}`}
                    </div>
                    {order.shipment?.expressNo && (
                      <div className="text-xs text-gray-500 mb-2">
                        物流：{order.shipment.expressCompany} {order.shipment.expressNo}
                        {order.shipment.shippedAt &&
                          `（${new Date(order.shipment.shippedAt).toLocaleString('zh-CN')} 发货）`}
                        {order.shipment.remark && ` 备注：${order.shipment.remark}`}
                      </div>
                    )}
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
                              {item.productName}
                              {item.specText && (
                                <span className="ml-1.5 text-xs text-gray-400">[{item.specText}]</span>
                              )}
                            </td>
                            <td className="py-1 text-right text-gray-600">
                              ¥{(item.productPrice / 100).toFixed(2)}
                            </td>
                            <td className="py-1 text-right text-gray-600">{item.quantity}</td>
                            <td className="py-1 text-right text-gray-800">
                              ¥{(item.subtotal / 100).toFixed(2)}
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
        {!loading && <Pagination page={page} total={total} pageSize={pageSize} onChange={setPage} />}
      </div>

      {/* 发货弹窗 */}
      {shipModal && (
        <Modal
          title="订单发货"
          width="sm"
          onClose={() => setShipModal(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setShipModal(null)}>
                取消
              </Button>
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
              <p>收货人：{shipModal.receiverName} {shipModal.receiverPhone}</p>
              <p>地址：{shipModal.receiverFullAddress}</p>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">快递公司 *</label>
                <input
                  value={shipForm.expressCompany}
                  onChange={(e) => setShipForm({ ...shipForm, expressCompany: e.target.value })}
                  placeholder="如 顺丰速运"
                  list="express-companies"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                />
                <datalist id="express-companies">
                  <option value="顺丰速运" />
                  <option value="京东物流" />
                  <option value="圆通速递" />
                  <option value="中通快递" />
                  <option value="申通快递" />
                  <option value="韵达快递" />
                  <option value="邮政 EMS" />
                </datalist>
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
                  placeholder="可选"
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
