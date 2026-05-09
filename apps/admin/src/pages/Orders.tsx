import { useEffect, useState } from 'react'
import { getOrders } from '../api/admin'
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
                  <th className="text-right px-4 py-3">详情</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((order) => (
                  <>
                    <tr key={order.id} className="hover:bg-gray-50">
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
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setExpanded(expanded === order.id ? null : order.id)}
                          className="text-blue-500 hover:text-blue-700"
                        >
                          {expanded === order.id ? '收起' : '展开'}
                        </button>
                      </td>
                    </tr>
                    {expanded === order.id && (
                      <tr key={`${order.id}-detail`}>
                        <td colSpan={6} className="px-4 py-3 bg-gray-50">
                          <div className="text-xs text-gray-500 mb-2">
                            收货地址：{order.receiverFullAddress}
                          </div>
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
                  </>
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
    </div>
  )
}
