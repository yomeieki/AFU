import { useEffect, useState } from 'react'
import { getUsers, getUserOrders } from '../api/admin'
import type { AdminUser, UserOrder, OrderStatus } from '../types'

const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_PAYMENT: '待付款',
  PAID: '已付款',
  SHIPPED: '已发货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
}

export default function Users() {
  const [list, setList] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(true)

  // 用户订单弹窗
  const [ordersModal, setOrdersModal] = useState<AdminUser | null>(null)
  const [userOrders, setUserOrders] = useState<UserOrder[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)

  const load = (p = page) => {
    setLoading(true)
    getUsers({ page: p, pageSize, keyword: keyword || undefined })
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

  const openOrders = (user: AdminUser) => {
    setOrdersModal(user)
    setOrdersLoading(true)
    getUserOrders(user.id, { page: 1, pageSize: 20 })
      .then((res) => setUserOrders(res.data.data.list))
      .finally(() => setOrdersLoading(false))
  }

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-800">用户管理</h2>

      <div className="bg-white rounded-lg shadow-sm p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">关键词</label>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索昵称/手机号"
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-44"
          />
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
                  <th className="text-left px-4 py-3">用户</th>
                  <th className="text-left px-4 py-3">手机号</th>
                  <th className="text-right px-4 py-3">订单数</th>
                  <th className="text-right px-4 py-3">状态</th>
                  <th className="text-right px-4 py-3">最近登录</th>
                  <th className="text-right px-4 py-3">注册时间</th>
                  <th className="text-right px-4 py-3">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((u) => (
                  <tr key={u.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {u.avatarUrl ? (
                          <img src={u.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover" />
                        ) : (
                          <span className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs text-gray-500">
                            {(u.nickname ?? 'U').slice(0, 1)}
                          </span>
                        )}
                        <span className="text-gray-800">{u.nickname ?? `用户 #${u.id}`}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{u.phone ?? '-'}</td>
                    <td className="px-4 py-3 text-right text-gray-800">{u.orderCount}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`px-2 py-0.5 rounded-full text-xs ${u.status === 1 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {u.status === 1 ? '正常' : '禁用'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('zh-CN') : '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500">
                      {new Date(u.createdAt).toLocaleDateString('zh-CN')}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => openOrders(u)} className="text-blue-500 hover:text-blue-700">
                        查看订单
                      </button>
                    </td>
                  </tr>
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

      {/* 用户订单弹窗 */}
      {ordersModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6 space-y-4 mx-4 max-h-[80vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-800">
              {ordersModal.nickname ?? `用户 #${ordersModal.id}`} 的订单
            </h3>
            {ordersLoading ? (
              <p className="text-sm text-gray-500">加载中...</p>
            ) : userOrders.length === 0 ? (
              <p className="text-sm text-gray-500">暂无订单</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-left px-3 py-2">订单号</th>
                    <th className="text-left px-3 py-2">商品</th>
                    <th className="text-right px-3 py-2">金额</th>
                    <th className="text-right px-3 py-2">状态</th>
                    <th className="text-right px-3 py-2">下单时间</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {userOrders.map((o) => (
                    <tr key={o.id}>
                      <td className="px-3 py-2 font-mono text-gray-700">{o.orderNo}</td>
                      <td className="px-3 py-2 text-gray-600">
                        {o.items.map((it) => `${it.productName}×${it.quantity}`).join('、')}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-800">
                        ¥{(o.actualAmount / 100).toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600">{STATUS_LABEL[o.status]}</td>
                      <td className="px-3 py-2 text-right text-gray-500">
                        {new Date(o.createdAt).toLocaleString('zh-CN')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="flex justify-end">
              <button
                onClick={() => setOrdersModal(null)}
                className="text-sm px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
