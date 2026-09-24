import { useEffect, useRef, useState } from 'react'
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
import {
  initialSession, openSession, closeSession, applyUserLoaded, applyOrdersPage, beginMore, applyOrdersError,
  type OrdersSession,
} from '../utils/user-orders-session'

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

  // 用户订单弹窗（打开来源：行内按钮，或 URL 的 orders=<id> 在挂载/返回/刷新时自动重开）。
  // 全部状态收进一个纯状态机对象（utils/user-orders-session.ts），每次打开/关闭/按 URL
  // 重开都领一个新的会话号 seq；迟到的网络响应带着发出时的 seq 回来，seq 不匹配就原样
  // 丢弃（同一引用，不重渲）——见 2026-09-24 复核 R1：弱网下 A 的「加载更多」结果会被
  // 追加进 B 的弹窗、按 URL 重开时会被切成别的用户。
  const [session, setSession] = useState<OrdersSession<AdminUser, UserOrder>>(initialSession)
  const seqRef = useRef(0)
  const ordersModal = session.user

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

  // ── 用户订单弹窗（会话号保护，见上方 session 注释） ─────────────────────────
  const loadUserOrders = (userId: number, p: number, seq: number) => {
    getUserOrders(userId, { page: p, pageSize: 20 })
      .then((res) => {
        setSession((s) => applyOrdersPage(s, { seq, page: p, list: res.data.data.list, total: res.data.data.total }))
      })
      .catch(() => {
        setSession((s) => applyOrdersError(s, { seq, page: p }))
        // 这次请求已经过期（弹窗换人/关闭）就不用再烦店主——seqRef 是当前最新会话号
        if (p > 1 && seqRef.current === seq) toast.error('加载更多失败，请重试')
      })
  }

  const openOrders = (user: AdminUser) => {
    const seq = ++seqRef.current
    setSession((s) => openSession(s, seq, user))
    setSearchParams((prev) => writeUsersQuery(new URLSearchParams(prev), { ordersUserId: user.id }), { replace: true })
    loadUserOrders(user.id, 1, seq)
  }

  const closeOrders = () => {
    const seq = ++seqRef.current
    setSession((s) => closeSession(s, seq))
    setSearchParams((prev) => writeUsersQuery(new URLSearchParams(prev), { ordersUserId: null }), { replace: true })
  }

  const retryOrders = () => {
    if (!session.user) return
    const seq = session.seq
    setSession((s) => openSession(s, seq, s.user))
    loadUserOrders(session.user.id, 1, seq)
  }

  const loadMoreOrders = () => {
    if (!session.user) return
    const seq = session.seq
    setSession((s) => beginMore(s, seq))
    loadUserOrders(session.user.id, session.page + 1, seq)
  }

  // URL 的 orders=<id> 在挂载、浏览器「返回」、刷新时都会变化（或就是初始值）——据此自动重开弹窗；
  // 弹窗已经是这个用户时不重复请求（行内按钮点击已经 openSession 过）。
  useEffect(() => {
    if (ordersUserId === null) {
      if (session.user) {
        const seq = ++seqRef.current
        setSession((s) => closeSession(s, seq))
      }
      return
    }
    if (session.user?.id === ordersUserId) return
    const seq = ++seqRef.current
    setSession((s) => openSession(s, seq, null))
    getUser(ordersUserId)
      .then((row) => {
        setSession((s) => applyUserLoaded(s, { seq, user: row }))
        loadUserOrders(ordersUserId, 1, seq)
      })
      .catch((err: unknown) => {
        // 这次 getUser 已经过期（弹窗又被别的操作换掉）——不弹 toast、不动 session/URL
        if (seqRef.current !== seq) return
        const status = (err as { response?: { status?: number; data?: { code?: number } } })?.response?.status
        const code = (err as { response?: { data?: { code?: number } } })?.response?.data?.code
        setSession((s) => closeSession(s, seq))
        if (status === 404 || code === 40401) {
          // 用户确实不存在：清掉地址栏的 orders 参数，不然刷新会再报一次
          toast.error('用户不存在')
          setSearchParams((prev) => writeUsersQuery(new URLSearchParams(prev), { ordersUserId: null }), { replace: true })
        } else {
          // 网络错误/5xx/超时：保留 orders 参数，刷新页面会重试
          toast.error('用户加载失败，请刷新重试')
        }
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
          columns={9}
          loading={loading}
          isEmpty={list.length === 0}
          emptyText={hasOrders ? '暂无下过单的用户，可取消勾选「只看下过单的」再看看' : '暂无用户'}
          head={
            <tr>
              <th className="text-left px-3 xl:px-4 py-3 whitespace-nowrap">用户</th>
              <th className="text-left px-3 xl:px-4 py-3 whitespace-nowrap">手机号</th>
              <th className="text-right px-3 xl:px-4 py-3 whitespace-nowrap">订单数</th>
              <th className="text-right px-3 xl:px-4 py-3 whitespace-nowrap">
                <button
                  type="button"
                  onClick={handleSortToggle}
                  aria-sort={sort === 'spend' ? 'descending' : 'none'}
                  className={`inline-flex items-center gap-1 whitespace-nowrap ${sort === 'spend' ? 'font-semibold text-gray-800' : ''}`}
                >
                  累计消费
                  {sort === 'spend' && <ArrowDown className="w-3.5 h-3.5" />}
                </button>
              </th>
              <th className="text-right px-3 xl:px-4 py-3 whitespace-nowrap">最近下单</th>
              {/* 「积分」「可用券」合并——2026-09-24 复核 R2：1280 原本单行的表头在加了
                  累计消费/最近下单两列后被挤成两行，1024 更是三行。信息不丢，挤进同一列两行显示。 */}
              <th className="text-right px-3 xl:px-4 py-3 whitespace-nowrap">积分/券</th>
              <th className="text-right px-3 xl:px-4 py-3 whitespace-nowrap">状态</th>
              {/* 「最近登录」「注册时间」合并，同上原因 */}
              <th className="text-right px-3 xl:px-4 py-3 whitespace-nowrap">登录/注册</th>
              <th className="text-right px-3 xl:px-4 py-3 whitespace-nowrap">操作</th>
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
                    最近下单 {fmtDate(u.latestOrder?.createdAt, '-')} · 注册 {fmtDate(u.createdAt)}
                  </p>
                  {/* 号码来自订单收货人快照而非微信绑定号时，必须标出来源，不然店主会当成本人手机号。
                      日期不重复放：上一行「最近下单」已经是同一个值（修订 2） */}
                  {phoneInfo?.source === 'order' && u.latestOrder && (
                    <p className="text-xs text-gray-400">最近一单收货人</p>
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
              <td className="px-3 xl:px-4 py-3">
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
              <td className="px-3 xl:px-4 py-3 text-gray-600">
                {phoneInfo ? (
                  <>
                    <div className="whitespace-nowrap">{phoneInfo.phone}</div>
                    {/* 日期不重复放：「最近下单」列已经是同一个值（修订 2，把 1024 行高从 77 压回 ≤62） */}
                    {phoneInfo.source === 'order' && u.latestOrder && (
                      <div className="text-xs text-gray-400 whitespace-nowrap">最近一单收货人</div>
                    )}
                  </>
                ) : '-'}
              </td>
              <td className="px-3 xl:px-4 py-3 text-right text-gray-800 whitespace-nowrap">{u.orderCount}</td>
              <td className="px-3 xl:px-4 py-3 text-right text-gray-800 whitespace-nowrap">{fmtYuanGrouped(u.spendFen)}</td>
              {/* 2026-09-24 R1-7：改成 YYYY-MM-DD（不带时分）——这一列回答的是「多久没来了」，
                  M-DD HH:mm 是工作台的紧凑格式，跨年看不出年份，也不适合客户名单 */}
              <td className="px-3 xl:px-4 py-3 text-right text-gray-500 whitespace-nowrap">{fmtDate(u.latestOrder?.createdAt, '-')}</td>
              <td className="px-3 xl:px-4 py-3 text-right text-gray-800 whitespace-nowrap">
                <div>{u.pointsBalance}</div>
                <div className="text-xs text-gray-500">可用券 {u.availableCoupons}</div>
              </td>
              <td className="px-3 xl:px-4 py-3 text-right whitespace-nowrap">
                <span className={`px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${u.status === 1 ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'}`}>
                  {u.status === 1 ? '正常' : '禁用'}
                </span>
              </td>
              <td className="px-3 xl:px-4 py-3 text-right text-gray-500 whitespace-nowrap">
                <div>{fmtDateTime(u.lastLoginAt, '-')}</div>
                <div className="text-xs text-gray-500">注册 {fmtDate(u.createdAt)}</div>
              </td>
              {/* <xl 时垂直内边距缩到 py-2：2×2 两行按钮（44px）+ py-3(24px) 会把行高顶到 77
                  （超过 1024 档 ≤70 的预算），py-2(16px) 收进预算；≥xl 单行按钮矮，恢复 py-3 */}
              <td className="px-3 xl:px-4 py-2 xl:py-3 text-right">
                {/* <xl（1024–1279）用 2 列 grid 让四个按钮严格折成 2×2（grid 按行主序自动放置，
                    不像 flex-wrap 那样受各按钮实际宽度影响换行点）；≥xl 改单行 */}
                <div className="grid grid-cols-2 xl:flex xl:flex-nowrap xl:justify-end gap-x-2 xl:gap-x-3 gap-y-1 justify-items-end ml-auto w-fit">
                  <button onClick={() => openOrders(u)} className="text-blue-500 hover:text-blue-700 whitespace-nowrap">订单</button>
                  <button onClick={() => setIssueFor(u)} className="text-brand-600 hover:text-brand-700 whitespace-nowrap">发券</button>
                  <button onClick={() => openLedger(u)} className="text-blue-500 hover:text-blue-700 whitespace-nowrap">积分明细</button>
                  <button onClick={() => openCoupons(u)} className="text-blue-500 hover:text-blue-700 whitespace-nowrap">券记录</button>
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
              {session.loading !== 'first' && !session.failed && (
                <span className="ml-2 text-sm font-normal text-gray-400">共 {session.total} 单</span>
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
          {session.loading === 'first' ? (
            <p className="flex items-center gap-2 text-sm text-gray-500">
              <Spinner /> 加载中...
            </p>
          ) : session.failed ? (
            <div className="py-6 flex flex-col items-center gap-3 text-sm text-red-600">
              <span>订单加载失败，当前显示的不是真实数据</span>
              <Button size="sm" variant="secondary" onClick={retryOrders}>重试</Button>
            </div>
          ) : session.list.length === 0 ? (
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
                    <th className="text-right px-3 py-2 whitespace-nowrap">下单时间</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {session.list.map((o) => {
                    const ch = userOrderChannel(o.deliveryType)
                    return (
                      <tr
                        key={o.id}
                        onClick={(e) => handleOrderRowClick(e, o)}
                        className="cursor-pointer hover:bg-brand-50"
                      >
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="font-mono text-gray-700">{o.orderNo}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded whitespace-nowrap ${ch.cls}`}>{ch.label}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-gray-600">
                          {itemsSummary(o.items)}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-brand-600">
                          ¥{(o.actualAmount / 100).toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <StatusBadge status={o.status} deliveryType={o.deliveryType} />
                        </td>
                        <td className="px-3 py-2 text-right text-gray-500 whitespace-nowrap">
                          {fmtDateTime(o.createdAt)}
                        </td>
                        <td className="px-2 py-2 text-gray-300"><ChevronRight className="w-4 h-4" /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="md:hidden divide-y divide-gray-100">
                {session.list.map((o) => {
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
                          <StatusBadge status={o.status} deliveryType={o.deliveryType} />
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
              {session.list.length < session.total && (
                <div className="pt-3 text-center">
                  <Button size="sm" variant="secondary" disabled={session.loading === 'more'} onClick={loadMoreOrders}>
                    {session.loading === 'more' ? '加载中...' : '加载更多'}
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
