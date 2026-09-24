import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useSearchParams, Link } from 'react-router-dom'
import { Search, Users as UsersIcon, ChevronRight, ArrowDown, Copy } from 'lucide-react'
import { getUsers, getUser, getUserOrders, getUserPointsLedger, getUserCoupons } from '../api/admin'
import Button from '../components/ui/Button'
import Modal from '../components/ui/Modal'
import Table from '../components/ui/Table'
import Pagination from '../components/ui/Pagination'
import StatusBadge from '../components/ui/StatusBadge'
import Spinner from '../components/ui/Spinner'
import EmptyState from '../components/ui/EmptyState'
import { toast } from '../components/ui/Toast'
import IssueCouponModal from '../components/IssueCouponModal'
import { copyText } from '../components/orders/copyText'
import type { AdminUser, UserOrder, PointsLedgerRow, UserCouponRow } from '../types'
import { fmtDate, fmtDateTime, fmtMonthDayTime } from '../utils/time'
import { userDisplayName, userPhoneInfo } from '../utils/user-label'
import { fmtYuanGrouped } from '../utils/money'
import { itemsSummary, userOrderChannel } from '../utils/order-list'
import { readUsersQuery, writeUsersQuery } from '../utils/users-query'
import { orderDetailPath } from '../navigation'
import { isModifiedLinkClick } from '../utils/link-click'

const userLabel = userDisplayName
const yuan = (fen: number) => (fen / 100).toFixed(2)
const CHANNEL_LABEL: Record<string, string> = { ALL: '通用', LOCAL: '仅同城', EXPRESS: '仅邮寄' }
const SOURCE_LABEL: Record<string, string> = {
  ADMIN: '手动发放',
  POINTS: '积分兑换',
  CAMPAIGN: '领券中心',
  NEWCOMER: '新人礼',
}
const COUPON_STATUS: Record<string, { text: string; cls: string }> = {
  UNUSED: { text: '未使用', cls: 'bg-green-50 text-green-600' },
  USED: { text: '已使用', cls: 'bg-gray-100 text-gray-500' },
  EXPIRED: { text: '已过期', cls: 'bg-gray-100 text-gray-400' },
}

/** 券记录的四个页签。「可用」= 未使用**且**未到期——只看 status 会把还没被定时任务扫到的过期券算进去 */
const COUPON_TABS = [
  { key: 'ALL', label: '全部' },
  { key: 'USABLE', label: '可用' },
  { key: 'USED', label: '已用' },
  { key: 'EXPIRED', label: '已过期' },
] as const
type CouponTab = (typeof COUPON_TABS)[number]['key']

function filterCoupons(list: UserCouponRow[], tab: CouponTab): UserCouponRow[] {
  const now = Date.now()
  if (tab === 'ALL') return list
  if (tab === 'USED') return list.filter((c) => c.status === 'USED')
  const expired = (c: UserCouponRow) => c.status === 'EXPIRED' || new Date(c.expiresAt).getTime() <= now
  if (tab === 'EXPIRED') return list.filter((c) => c.status !== 'USED' && expired(c))
  return list.filter((c) => c.status === 'UNUSED' && !expired(c))
}

/** 订单号 + 复制按钮，可选带跳详情的链接。流水「关联」列与券记录「使用订单」列共用 */
function OrderRefCell({ text, orderId, from }: { text: string; orderId: number | null; from: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {orderId ? (
        <Link to={orderDetailPath(orderId)} state={{ from }} className="font-mono text-blue-500 hover:text-blue-700">
          {text}
        </Link>
      ) : (
        <span className="font-mono text-gray-700">{text}</span>
      )}
      <button
        type="button"
        onClick={() => copyText(text)}
        className="text-gray-400 hover:text-gray-600"
        aria-label="复制订单号"
        title="复制订单号"
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
    </span>
  )
}

export default function Users() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { kw, hasOrders, page, sort, ordersUserId } = readUsersQuery(searchParams)
  const pageSize = 20

  // 关键词输入框是一份「草稿」，点「搜索」才写进 URL（kw）——避免打字过程中反复触发列表刷新
  const [keywordDraft, setKeywordDraft] = useState(kw)
  useEffect(() => { setKeywordDraft(kw) }, [kw])

  const [list, setList] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  // 没有 catch 的话接口一挂就渲染「暂无用户 / 暂无订单」，店主会当成真的没有
  const [loadFailed, setLoadFailed] = useState(false)

  // 用户订单弹窗（打开来源：行内按钮，或 URL 的 orders=<id> 在挂载/返回/刷新时自动重开）
  const [ordersModal, setOrdersModal] = useState<AdminUser | null>(null)
  const [userOrders, setUserOrders] = useState<UserOrder[]>([])
  const [ordersPage, setOrdersPage] = useState(1)
  const [ordersTotal, setOrdersTotal] = useState(0)
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [ordersMoreLoading, setOrdersMoreLoading] = useState(false)
  const [ordersFailed, setOrdersFailed] = useState(false)

  // 发券
  const [issueFor, setIssueFor] = useState<AdminUser | null>(null)

  // 积分明细弹窗（服务端分页）
  const [ledgerFor, setLedgerFor] = useState<AdminUser | null>(null)
  const [ledger, setLedger] = useState<PointsLedgerRow[]>([])
  const [ledgerTotal, setLedgerTotal] = useState(0)
  const [ledgerPage, setLedgerPage] = useState(1)
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [ledgerFailed, setLedgerFailed] = useState(false)

  // 券记录弹窗（一次全取，页签在前端切——服务端的 status 过滤挡不住「未使用但已到期」）
  const [couponsFor, setCouponsFor] = useState<AdminUser | null>(null)
  const [coupons, setCoupons] = useState<UserCouponRow[]>([])
  const [couponTab, setCouponTab] = useState<CouponTab>('ALL')
  const [couponsLoading, setCouponsLoading] = useState(false)
  const [couponsFailed, setCouponsFailed] = useState(false)

  const load = () => {
    setLoading(true)
    setLoadFailed(false)
    getUsers({ page, pageSize, keyword: kw || undefined, hasOrders: hasOrders ? 1 : undefined, sort: sort === 'spend' ? 'spend' : undefined })
      .then((res) => {
        setList(res.data.data.list)
        setTotal(res.data.data.total)
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false))
  }

  // 四个筛选/排序维度全在 URL 里，任一变化都重新拉取
  useEffect(() => { load() }, [kw, hasOrders, page, sort]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    setSearchParams((prev) => writeUsersQuery(new URLSearchParams(prev), { kw: keywordDraft.trim(), page: 1 }), { replace: true })
  }

  const handleHasOrdersChange = (checked: boolean) => {
    setSearchParams((prev) => writeUsersQuery(new URLSearchParams(prev), { hasOrders: checked, page: 1 }), { replace: true })
  }

  const handleSortToggle = () => {
    setSearchParams(
      (prev) => writeUsersQuery(new URLSearchParams(prev), { sort: sort === 'spend' ? 'created' : 'spend', page: 1 }),
      { replace: true }
    )
  }

  const handlePageChange = (p: number) => {
    setSearchParams((prev) => writeUsersQuery(new URLSearchParams(prev), { page: p }), { replace: true })
  }

  const loadLedger = (user: AdminUser, p: number) => {
    setLedgerLoading(true)
    setLedgerFailed(false)
    getUserPointsLedger(user.id, { page: p, pageSize: 20 })
      .then((d) => {
        setLedger(d.list)
        setLedgerTotal(d.total)
      })
      .catch(() => setLedgerFailed(true))
      .finally(() => setLedgerLoading(false))
  }

  const openLedger = (user: AdminUser) => {
    setLedgerFor(user)
    setLedgerPage(1)
    setLedger([])
    loadLedger(user, 1)
  }

  const loadCoupons = (user: AdminUser) => {
    setCouponsLoading(true)
    setCouponsFailed(false)
    getUserCoupons(user.id)
      .then(setCoupons)
      .catch(() => setCouponsFailed(true))
      .finally(() => setCouponsLoading(false))
  }

  const openCoupons = (user: AdminUser) => {
    setCouponsFor(user)
    setCouponTab('ALL')
    setCoupons([])
    loadCoupons(user)
  }

  // ── 用户订单弹窗 ──────────────────────────────────────────────────────────
  const loadUserOrders = (userId: number, p: number) => {
    if (p === 1) { setOrdersLoading(true); setOrdersFailed(false) } else { setOrdersMoreLoading(true) }
    getUserOrders(userId, { page: p, pageSize: 20 })
      .then((res) => {
        setOrdersPage(p)
        setOrdersTotal(res.data.data.total)
        setUserOrders((prev) => (p === 1 ? res.data.data.list : [...prev, ...res.data.data.list]))
      })
      .catch(() => { if (p === 1) setOrdersFailed(true); else toast.error('加载更多失败，请重试') })
      .finally(() => { if (p === 1) setOrdersLoading(false); else setOrdersMoreLoading(false) })
  }

  const openOrders = (user: AdminUser) => {
    setOrdersModal(user)
    setUserOrders([])
    setOrdersTotal(0)
    setOrdersPage(1)
    setSearchParams((prev) => writeUsersQuery(new URLSearchParams(prev), { ordersUserId: user.id }), { replace: true })
    loadUserOrders(user.id, 1)
  }

  const closeOrders = () => {
    setOrdersModal(null)
    setUserOrders([])
    setSearchParams((prev) => writeUsersQuery(new URLSearchParams(prev), { ordersUserId: null }), { replace: true })
  }

  // URL 的 orders=<id> 在挂载、浏览器「返回」、刷新时都会变化（或就是初始值）——据此自动重开弹窗；
  // 弹窗已经是这个用户时不重复请求（行内按钮点击已经 setOrdersModal 过）。
  useEffect(() => {
    if (ordersUserId === null) {
      if (ordersModal) setOrdersModal(null)
      return
    }
    if (ordersModal?.id === ordersUserId) return
    getUser(ordersUserId)
      .then((row) => {
        setOrdersModal(row)
        setUserOrders([])
        setOrdersTotal(0)
        setOrdersPage(1)
        loadUserOrders(ordersUserId, 1)
      })
      .catch(() => {
        toast.error('用户不存在')
        setSearchParams((prev) => writeUsersQuery(new URLSearchParams(prev), { ordersUserId: null }), { replace: true })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordersUserId])

  const handleOrderRowClick = (e: React.MouseEvent, o: UserOrder) => {
    if (isModifiedLinkClick(e)) {
      window.open(orderDetailPath(o.id), '_blank', 'noopener')
      return
    }
    navigate(orderDetailPath(o.id), { state: { from: location.pathname + location.search } })
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-800">用户管理</h2>

      <div className="bg-white rounded-lg shadow-card p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">关键词</label>
          <input
            value={keywordDraft}
            onChange={(e) => setKeywordDraft(e.target.value)}
            placeholder="搜收货人姓名/手机号（可只输尾号）"
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-56"
          />
        </div>
        <Button variant="secondary" size="sm" onClick={handleSearch}>
          <Search className="w-4 h-4" />
          搜索
        </Button>
        <label className="flex items-center gap-1.5 text-sm text-gray-600 pb-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hasOrders}
            onChange={(e) => handleHasOrdersChange(e.target.checked)}
            className="rounded border-gray-300"
          />
          只看下过单的
        </label>
        {/* 手机端没有表头可点，用一个开关驱动同一个 sort 参数 */}
        <label className="flex items-center gap-1.5 text-sm text-gray-600 pb-1.5 cursor-pointer select-none md:hidden">
          <input
            type="checkbox"
            checked={sort === 'spend'}
            onChange={handleSortToggle}
            className="rounded border-gray-300"
          />
          按累计消费排序
        </label>
      </div>

      <div className="bg-white rounded-lg shadow-card overflow-hidden">
        {loadFailed ? (
          <div className="py-10 flex flex-col items-center gap-3 text-sm text-red-600">
            <span>用户列表加载失败，当前显示的不是真实数据</span>
            <Button size="sm" variant="secondary" onClick={() => load()}>重试</Button>
          </div>
        ) : (
        <Table
          columns={11}
          loading={loading}
          isEmpty={list.length === 0}
          emptyText={hasOrders ? '暂无下过单的用户，可取消勾选「只看下过单的」再看看' : '暂无用户'}
          head={
            <tr>
              <th className="text-left px-4 py-3">用户</th>
              <th className="text-left px-4 py-3">手机号</th>
              <th className="text-right px-4 py-3">订单数</th>
              <th className="text-right px-4 py-3">
                <button
                  type="button"
                  onClick={handleSortToggle}
                  aria-sort={sort === 'spend' ? 'descending' : 'none'}
                  className={`inline-flex items-center gap-1 ${sort === 'spend' ? 'font-semibold text-gray-800' : ''}`}
                >
                  累计消费
                  {sort === 'spend' && <ArrowDown className="w-3.5 h-3.5" />}
                </button>
              </th>
              <th className="text-right px-4 py-3">最近下单</th>
              <th className="text-right px-4 py-3">积分</th>
              <th className="text-right px-4 py-3">可用券</th>
              <th className="text-right px-4 py-3">状态</th>
              <th className="text-right px-4 py-3">最近登录</th>
              <th className="text-right px-4 py-3">注册时间</th>
              <th className="text-right px-4 py-3">操作</th>
            </tr>
          }
          mobileCards={
            <>
              {list.map((u) => {
                const phoneInfo = userPhoneInfo(u)
                return (
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
                      <span className="text-sm text-gray-800 truncate">{userLabel(u)}</span>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-xs shrink-0 ${u.status === 1 ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'}`}>
                      {u.status === 1 ? '正常' : '禁用'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1.5">
                    {phoneInfo ? phoneInfo.phone : '无手机号'} · 订单 {u.orderCount} · 累计 {fmtYuanGrouped(u.spendFen)}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    最近下单 {fmtMonthDayTime(u.latestOrder?.createdAt, '-')} · 注册 {fmtDate(u.createdAt)}
                  </p>
                  {/* 号码来自订单收货人快照而非微信绑定号时，必须标出来源，不然店主会当成本人手机号 */}
                  {phoneInfo?.source === 'order' && u.latestOrder && (
                    <p className="text-xs text-gray-400">最近一单收货人 · {fmtDate(u.latestOrder.createdAt)}</p>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    积分 <span className="text-gray-800 font-medium">{u.pointsBalance}</span> · 可用券{' '}
                    <span className="text-gray-800 font-medium">{u.availableCoupons}</span>
                  </p>
                  {/* 四个动作在 375px 下一行放不下，靠 flex-wrap 自然折成两行 */}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
                    <button onClick={() => openOrders(u)} className="text-blue-500">查看订单</button>
                    <button onClick={() => setIssueFor(u)} className="text-brand-600">发券</button>
                    <button onClick={() => openLedger(u)} className="text-blue-500">积分明细</button>
                    <button onClick={() => openCoupons(u)} className="text-blue-500">券记录</button>
                  </div>
                </div>
                )
              })}
            </>
          }
        >
          {list.map((u) => {
            const phoneInfo = userPhoneInfo(u)
            return (
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
                  <span className="text-gray-800">{userLabel(u)}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-gray-600">
                {phoneInfo ? (
                  <>
                    <div>{phoneInfo.phone}</div>
                    {phoneInfo.source === 'order' && u.latestOrder && (
                      <div className="text-xs text-gray-400">最近一单收货人 · {fmtDate(u.latestOrder.createdAt)}</div>
                    )}
                  </>
                ) : '-'}
              </td>
              <td className="px-4 py-3 text-right text-gray-800">{u.orderCount}</td>
              <td className="px-4 py-3 text-right text-gray-800">{fmtYuanGrouped(u.spendFen)}</td>
              <td className="px-4 py-3 text-right text-gray-500">{fmtMonthDayTime(u.latestOrder?.createdAt, '-')}</td>
              <td className="px-4 py-3 text-right text-gray-800">{u.pointsBalance}</td>
              <td className="px-4 py-3 text-right text-gray-800">{u.availableCoupons}</td>
              <td className="px-4 py-3 text-right">
                <span className={`px-2 py-0.5 rounded-full text-xs ${u.status === 1 ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'}`}>
                  {u.status === 1 ? '正常' : '禁用'}
                </span>
              </td>
              <td className="px-4 py-3 text-right text-gray-500">
                {fmtDateTime(u.lastLoginAt, '-')}
              </td>
              <td className="px-4 py-3 text-right text-gray-500">
                {fmtDate(u.createdAt)}
              </td>
              <td className="px-4 py-3 text-right">
                <div className="flex justify-end gap-3 whitespace-nowrap">
                  <button onClick={() => openOrders(u)} className="text-blue-500 hover:text-blue-700">订单</button>
                  <button onClick={() => setIssueFor(u)} className="text-brand-600 hover:text-brand-700">发券</button>
                  <button onClick={() => openLedger(u)} className="text-blue-500 hover:text-blue-700">积分明细</button>
                  <button onClick={() => openCoupons(u)} className="text-blue-500 hover:text-blue-700">券记录</button>
                </div>
              </td>
            </tr>
            )
          })}
        </Table>
        )}
        {!loading && !loadFailed && <Pagination page={page} total={total} pageSize={pageSize} onChange={handlePageChange} />}
      </div>

      {/* 用户订单弹窗 */}
      {ordersModal && (
        <Modal
          title={
            <>
              {userLabel(ordersModal)} 的订单
              {!ordersLoading && !ordersFailed && (
                <span className="ml-2 text-sm font-normal text-gray-400">共 {ordersTotal} 单</span>
              )}
            </>
          }
          width="lg"
          onClose={closeOrders}
          footer={
            <Button variant="secondary" onClick={closeOrders}>
              关闭
            </Button>
          }
        >
          {ordersLoading ? (
            <p className="flex items-center gap-2 text-sm text-gray-500">
              <Spinner /> 加载中...
            </p>
          ) : ordersFailed ? (
            <div className="py-6 flex flex-col items-center gap-3 text-sm text-red-600">
              <span>订单加载失败，当前显示的不是真实数据</span>
              <Button size="sm" variant="secondary" onClick={() => loadUserOrders(ordersModal.id, 1)}>重试</Button>
            </div>
          ) : userOrders.length === 0 ? (
            <EmptyState icon={UsersIcon} text="暂无订单" />
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <table className="w-full text-sm hidden md:table">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-left px-3 py-2">订单号</th>
                    <th className="text-left px-3 py-2">商品</th>
                    <th className="text-right px-3 py-2">金额</th>
                    <th className="text-right px-3 py-2">状态</th>
                    <th className="text-right px-3 py-2">下单时间</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {userOrders.map((o) => {
                    const ch = userOrderChannel(o.deliveryType)
                    return (
                      <tr
                        key={o.id}
                        onClick={(e) => handleOrderRowClick(e, o)}
                        className="cursor-pointer hover:bg-brand-50"
                      >
                        <td className="px-3 py-2">
                          <span className="font-mono text-gray-700">{o.orderNo}</span>
                          <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded ${ch.cls}`}>{ch.label}</span>
                        </td>
                        <td className="px-3 py-2 text-gray-600">
                          {itemsSummary(o.items)}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-brand-600">
                          ¥{(o.actualAmount / 100).toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <StatusBadge status={o.status} />
                        </td>
                        <td className="px-3 py-2 text-right text-gray-500">
                          {fmtDateTime(o.createdAt)}
                        </td>
                        <td className="px-2 py-2 text-gray-300"><ChevronRight className="w-4 h-4" /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="md:hidden divide-y divide-gray-100">
                {userOrders.map((o) => {
                  const ch = userOrderChannel(o.deliveryType)
                  return (
                    <div
                      key={o.id}
                      onClick={(e) => handleOrderRowClick(e, o)}
                      className="py-3 flex items-center justify-between gap-2 cursor-pointer active:bg-gray-50"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-base font-semibold text-brand-600">¥{(o.actualAmount / 100).toFixed(2)}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${ch.cls}`}>{ch.label}</span>
                          <StatusBadge status={o.status} />
                        </div>
                        <p className="text-xs text-gray-500 truncate mt-1">
                          {itemsSummary(o.items)} · {fmtMonthDayTime(o.createdAt)}
                        </p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-gray-300 shrink-0" />
                    </div>
                  )
                })}
              </div>
              {userOrders.length < ordersTotal && (
                <div className="pt-3 text-center">
                  <Button size="sm" variant="secondary" disabled={ordersMoreLoading} onClick={() => loadUserOrders(ordersModal.id, ordersPage + 1)}>
                    {ordersMoreLoading ? '加载中...' : '加载更多'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}

      {/* 发券（两步确认）。成功后重新拉当前页——「可用券」那一列要立刻 +1，
          不刷新的话店员会以为没发出去，然后再点一次 */}
      {issueFor && (
        <IssueCouponModal
          userId={issueFor.id}
          userLabel={userLabel(issueFor)}
          onClose={() => setIssueFor(null)}
          onDone={() => {
            load()
            if (couponsFor?.id === issueFor.id) loadCoupons(couponsFor)
          }}
        />
      )}

      {/* 积分明细 */}
      {ledgerFor && (
        <Modal
          title={`${userLabel(ledgerFor)} 的积分明细（余额 ${ledgerFor.pointsBalance}）`}
          width="lg"
          onClose={() => setLedgerFor(null)}
          footer={<Button variant="secondary" onClick={() => setLedgerFor(null)}>关闭</Button>}
        >
          {ledgerLoading ? (
            <p className="flex items-center gap-2 text-sm text-gray-500"><Spinner /> 加载中...</p>
          ) : ledgerFailed ? (
            <div className="py-6 flex flex-col items-center gap-3 text-sm text-red-600">
              <span>积分明细加载失败，当前显示的不是真实数据</span>
              <Button size="sm" variant="secondary" onClick={() => loadLedger(ledgerFor, ledgerPage)}>重试</Button>
            </div>
          ) : ledger.length === 0 ? (
            <EmptyState icon={UsersIcon} text="暂无积分记录" />
          ) : (
            <>
              <div className="max-h-[60vh] overflow-auto">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="text-left px-3 py-2">时间</th>
                      <th className="text-left px-3 py-2">类型</th>
                      <th className="text-right px-3 py-2">变动</th>
                      <th className="text-right px-3 py-2">变动后</th>
                      <th className="text-left px-3 py-2">关联</th>
                      <th className="text-left px-3 py-2">备注</th>
                      <th className="text-right px-3 py-2">到期</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {ledger.map((r) => (
                      <tr key={r.id}>
                        <td className="px-3 py-2 text-gray-500">{fmtDateTime(r.createdAt)}</td>
                        <td className="px-3 py-2 text-gray-700">{r.typeLabel}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${r.delta >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                          {r.delta >= 0 ? `+${r.delta}` : r.delta}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-800">{r.balanceAfter}</td>
                        <td className="px-3 py-2">
                          {r.orderNo ? (
                            <OrderRefCell text={r.orderNo} orderId={r.orderId} from={location.pathname + location.search} />
                          ) : (
                            <span className="text-gray-400">{r.refType} #{r.refId}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-600 whitespace-normal max-w-[16rem]">{r.remark ?? '-'}</td>
                        <td className="px-3 py-2 text-right text-gray-500">
                          {fmtDate(r.expiresAt, '-')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={ledgerPage}
                total={ledgerTotal}
                pageSize={20}
                onChange={(p) => { setLedgerPage(p); loadLedger(ledgerFor, p) }}
              />
            </>
          )}
        </Modal>
      )}

      {/* 券记录 */}
      {couponsFor && (
        <Modal
          title={`${userLabel(couponsFor)} 的优惠券`}
          width="lg"
          onClose={() => setCouponsFor(null)}
          footer={<Button variant="secondary" onClick={() => setCouponsFor(null)}>关闭</Button>}
        >
          <div className="flex gap-2 mb-3">
            {COUPON_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setCouponTab(t.key)}
                className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                  couponTab === t.key
                    ? 'bg-brand-50 border-brand-400 text-brand-600 font-medium'
                    : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400'
                }`}
              >
                {t.label}
                {!couponsLoading && !couponsFailed && ` ${filterCoupons(coupons, t.key).length}`}
              </button>
            ))}
          </div>
          {couponsLoading ? (
            <p className="flex items-center gap-2 text-sm text-gray-500"><Spinner /> 加载中...</p>
          ) : couponsFailed ? (
            <div className="py-6 flex flex-col items-center gap-3 text-sm text-red-600">
              <span>券记录加载失败，当前显示的不是真实数据</span>
              <Button size="sm" variant="secondary" onClick={() => loadCoupons(couponsFor)}>重试</Button>
            </div>
          ) : filterCoupons(coupons, couponTab).length === 0 ? (
            <EmptyState icon={UsersIcon} text="暂无优惠券" />
          ) : (
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-left px-3 py-2">券名</th>
                    <th className="text-left px-3 py-2">券码</th>
                    <th className="text-right px-3 py-2">面额</th>
                    <th className="text-right px-3 py-2">状态</th>
                    <th className="text-left px-3 py-2">来源</th>
                    <th className="text-left px-3 py-2">操作人</th>
                    <th className="text-left px-3 py-2">备注</th>
                    <th className="text-right px-3 py-2">到期</th>
                    <th className="text-left px-3 py-2">使用订单</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filterCoupons(coupons, couponTab).map((c) => {
                    // 只看 status 会把「还没被定时任务扫到的过期券」显示成未使用
                    const expired = c.status !== 'USED' && new Date(c.expiresAt).getTime() <= Date.now()
                    const badge = COUPON_STATUS[expired ? 'EXPIRED' : c.status] ?? { text: c.status, cls: 'bg-gray-100 text-gray-500' }
                    // 显示值：优先核销单号，其次赔偿针对的单号；对应 id 分别取 orderId / sourceRefOrderId
                    const refText = c.orderNo ?? c.sourceRef ?? null
                    const refOrderId = c.orderNo ? c.orderId : c.sourceRefOrderId
                    return (
                      <tr key={c.id}>
                        <td className="px-3 py-2 text-gray-800">
                          {c.name}
                          <span className="ml-1 text-xs text-gray-400">
                            {c.threshold > 0 ? `满${yuan(c.threshold)}` : '无门槛'}·{CHANNEL_LABEL[c.channel] ?? c.channel}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-gray-600">{c.code}</td>
                        <td className="px-3 py-2 text-right font-semibold text-brand-600">¥{yuan(c.amount)}</td>
                        <td className="px-3 py-2 text-right">
                          <span className={`px-2 py-0.5 rounded-full text-xs ${badge.cls}`}>{badge.text}</span>
                        </td>
                        <td className="px-3 py-2 text-gray-600">{SOURCE_LABEL[c.source] ?? c.source}</td>
                        <td className="px-3 py-2 text-gray-600">{c.issuedBy ?? '-'}</td>
                        <td className="px-3 py-2 text-gray-600 whitespace-normal max-w-[14rem]">{c.remark ?? '-'}</td>
                        <td className="px-3 py-2 text-right text-gray-500">
                          {fmtDate(c.expiresAt)}
                        </td>
                        <td className="px-3 py-2 font-mono text-gray-600">
                          {refText ? (
                            <OrderRefCell text={refText} orderId={refOrderId} from={location.pathname + location.search} />
                          ) : '-'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
