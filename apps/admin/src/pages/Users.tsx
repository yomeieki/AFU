import { useEffect, useState } from 'react'
import { Search, Users as UsersIcon } from 'lucide-react'
import { getUsers, getUserOrders } from '../api/admin'
import Button from '../components/ui/Button'
import Modal from '../components/ui/Modal'
import Table from '../components/ui/Table'
import Pagination from '../components/ui/Pagination'
import StatusBadge from '../components/ui/StatusBadge'
import Spinner from '../components/ui/Spinner'
import EmptyState from '../components/ui/EmptyState'
import type { AdminUser, UserOrder } from '../types'

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

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-800">用户管理</h2>

      <div className="bg-white rounded-lg shadow-card p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">关键词</label>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索昵称/手机号"
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
          columns={7}
          loading={loading}
          isEmpty={list.length === 0}
          emptyText="暂无用户"
          head={
            <tr>
              <th className="text-left px-4 py-3">用户</th>
              <th className="text-left px-4 py-3">手机号</th>
              <th className="text-right px-4 py-3">订单数</th>
              <th className="text-right px-4 py-3">状态</th>
              <th className="text-right px-4 py-3">最近登录</th>
              <th className="text-right px-4 py-3">注册时间</th>
              <th className="text-right px-4 py-3">操作</th>
            </tr>
          }
          mobileCards={
            <>
              {list.map((u) => (
                <div key={u.id} className="border border-gray-100 rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {u.avatarUrl ? (
                        <img src={u.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
                      ) : (
                        <span className="w-8 h-8 rounded-full bg-brand-50 flex items-center justify-center text-xs text-brand-500 font-medium shrink-0">
                          {(u.nickname ?? 'U').slice(0, 1)}
                        </span>
                      )}
                      <span className="text-sm text-gray-800 truncate">{u.nickname ?? `用户 #${u.id}`}</span>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-xs shrink-0 ${u.status === 1 ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'}`}>
                      {u.status === 1 ? '正常' : '禁用'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1.5">
                    {u.phone ?? '未绑定手机'}　订单 {u.orderCount}　注册 {new Date(u.createdAt).toLocaleDateString('zh-CN')}
                  </p>
                  <button onClick={() => openOrders(u)} className="mt-2 text-sm text-blue-500">
                    查看订单
                  </button>
                </div>
              ))}
            </>
          }
        >
          {list.map((u) => (
            <tr key={u.id} className="hover:bg-gray-50">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  {u.avatarUrl ? (
                    <img src={u.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover" />
                  ) : (
                    <span className="w-8 h-8 rounded-full bg-brand-50 flex items-center justify-center text-xs text-brand-500 font-medium">
                      {(u.nickname ?? 'U').slice(0, 1)}
                    </span>
                  )}
                  <span className="text-gray-800">{u.nickname ?? `用户 #${u.id}`}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-gray-600">{u.phone ?? '-'}</td>
              <td className="px-4 py-3 text-right text-gray-800">{u.orderCount}</td>
              <td className="px-4 py-3 text-right">
                <span className={`px-2 py-0.5 rounded-full text-xs ${u.status === 1 ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'}`}>
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
        </Table>
        {!loading && <Pagination page={page} total={total} pageSize={pageSize} onChange={setPage} />}
      </div>

      {/* 用户订单弹窗 */}
      {ordersModal && (
        <Modal
          title={`${ordersModal.nickname ?? `用户 #${ordersModal.id}`} 的订单`}
          width="lg"
          onClose={() => setOrdersModal(null)}
          footer={
            <Button variant="secondary" onClick={() => setOrdersModal(null)}>
              关闭
            </Button>
          }
        >
          {ordersLoading ? (
            <p className="flex items-center gap-2 text-sm text-gray-500">
              <Spinner /> 加载中...
            </p>
          ) : userOrders.length === 0 ? (
            <EmptyState icon={UsersIcon} text="暂无订单" />
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
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
                      <td className="px-3 py-2 text-right font-semibold text-brand-600">
                        ¥{(o.actualAmount / 100).toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <StatusBadge status={o.status} />
                      </td>
                      <td className="px-3 py-2 text-right text-gray-500">
                        {new Date(o.createdAt).toLocaleString('zh-CN')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
