import { Fragment, useEffect, useState } from 'react'
import { getOrders, shipOrder, cancelOrder } from '../api/admin'
import type { Order, OrderStatus } from '../types'

const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_PAYMENT: '待付款',
  PAID: '已付款',
  SHIPPED: '已发货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
}

const STATUS_COLOR: Record<OrderStatus, string> = {
  PENDING_PAYMENT: 'bg-yellow-100 text-yellow-700',
  PAID: 'bg-blue-100 text-blue-700',
  SHIPPED: 'bg-indigo-100 text-indigo-700',
  COMPLETED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-500',
  REFUNDED: 'bg-red-100 text-red-600',
}

export default function Orders() {
  const [list, setList] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [filterStatus, setFilterStatus] = useState('')
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

  useEffect(() => { load() }, [page]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    setPage(1)
    load(1)
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
    if (!confirm(`确认取消订单 ${order.orderNo}？库存将回滚。`)) return
    try {
      await cancelOrder(order.id)
      load()
    } catch (err: unknown) {
      alert(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '取消失败'
      )
    }
  }

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-800">订单管理</h2>

      <div className="bg-white rounded-lg shadow-sm p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">订单号</label>
          <input
            value={filterOrderNo}
            onChange={(e) => setFilterOrderNo(e.target.value)}
            placeholder="搜索订单号"
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-44"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">状态</label>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm"
          >
            <option value="">全部</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <button
          onClick={handleSearch}
          className="bg-gray-800 hover:bg-gray-900 text-white text-sm px-4 py-1.5 rounded-md"
        >
          搜索
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-6 text-gray-500 text-sm">加载中...</div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-4 py-3">订单号</th>
                  <th className="text-left px-4 py-3">收货人</th>
                  <th className="text-right px-4 py-3">实付金额</th>
                  <th className="text-right px-4 py-3">状态</th>
                  <th className="text-right px-4 py-3">下单时间</th>
                  <th className="text-right px-4 py-3">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((order) => (
                  <Fragment key={order.id}>
                    <tr className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-mono text-gray-700">{order.orderNo}</td>
                      <td className="px-4 py-3 text-gray-800">
                        {order.receiverName} {order.receiverPhone}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-800 font-medium">
                        ¥{(order.actualAmount / 100).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_COLOR[order.status]}`}>
                          {STATUS_LABEL[order.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500">
                        {new Date(order.createdAt).toLocaleString('zh-CN')}
                      </td>
                      <td className="px-4 py-3 text-right space-x-2">
                        {order.status === 'PAID' && (
                          <button
                            onClick={() => openShipModal(order)}
                            className="text-orange-500 hover:text-orange-700 font-medium"
                          >
                            发货
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
                                  <td className="py-1 text-gray-700">{item.productName}</td>
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
              </tbody>
            </table>
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between text-sm text-gray-500">
              <span>共 {total} 条</span>
              <div className="flex gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                  className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
                >
                  上一页
                </button>
                <span className="px-3 py-1">{page} / {Math.max(1, totalPages)}</span>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                  className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 发货弹窗 */}
      {shipModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6 space-y-4 mx-4">
            <h3 className="text-lg font-semibold text-gray-800">订单发货</h3>
            <div className="text-xs text-gray-500 space-y-1">
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
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">快递单号 *</label>
                <input
                  value={shipForm.expressNo}
                  onChange={(e) => setShipForm({ ...shipForm, expressNo: e.target.value })}
                  placeholder="请输入快递单号"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">备注</label>
                <input
                  value={shipForm.remark}
                  onChange={(e) => setShipForm({ ...shipForm, remark: e.target.value })}
                  placeholder="可选"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                />
              </div>
            </div>
            {shipError && <p className="text-red-500 text-sm">{shipError}</p>}
            <div className="flex justify-end space-x-3 pt-2">
              <button
                onClick={() => setShipModal(null)}
                className="text-sm px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleShip}
                disabled={shipping}
                className="text-sm px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-md disabled:opacity-50"
              >
                {shipping ? '发货中...' : '确认发货'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
