import { useEffect, useState } from 'react'
import { Search, Users as UsersIcon } from 'lucide-react'
import { getUsers, getUserOrders, getUserPointsLedger, getUserCoupons } from '../api/admin'
import Button from '../components/ui/Button'
import Modal from '../components/ui/Modal'
import Table from '../components/ui/Table'
import Pagination from '../components/ui/Pagination'
import StatusBadge from '../components/ui/StatusBadge'
import Spinner from '../components/ui/Spinner'
import EmptyState from '../components/ui/EmptyState'
import { toast } from '../components/ui/Toast'
import IssueCouponModal from '../components/IssueCouponModal'
import type { AdminUser, UserOrder, PointsLedgerRow, UserCouponRow } from '../types'
import { fmtDate, fmtDateTime } from '../utils/time'
import { userDisplayName, userPhoneInfo } from '../utils/user-label'

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

export default function Users() {
  const [list, setList] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [keyword, setKeyword] = useState('')
  // 「只看下过单的」默认勾上——店主找人多半是为了对一张订单，压根没下过单的行只会添乱。
  // 与「订单数」列同一口径（orders: some {}，任一状态都算），见 utils/order-actions 同款注释风格。
  const [hasOrders, setHasOrders] = useState(true)
  const [loading, setLoading] = useState(true)

  // 用户订单弹窗
  const [ordersModal, setOrdersModal] = useState<AdminUser | null>(null)
  const [userOrders, setUserOrders] = useState<UserOrder[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  // 没有 catch 的话接口一挂就渲染「暂无用户 / 暂无订单」，店主会当成真的没有
  const [loadFailed, setLoadFailed] = useState(false)
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

  const load = (p = page) => {
    setLoading(true)
    setLoadFailed(false)
    getUsers({ page: p, pageSize, keyword: keyword || undefined, hasOrders: hasOrders ? 1 : undefined })
      .then((res) => {
        setList(res.data.data.list)
        setTotal(res.data.data.total)
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false))
  }

  // hasOrders 进依赖：勾选状态一变就自动重载，不用每个改状态的地方都记得手动 load()。
  useEffect(() => { load() }, [page, hasOrders]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    setPage(1)
    load(1)
  }

  // 勾选/取消「只看下过单的」：先回第 1 页再改状态——顺序反过来的话，若当前停在第 3 页，
  // setHasOrders 触发的 effect 会先用旧页码打一次接口，页码没变时接口没变、只是浪费一次请求，
  // 但更糟的是 setPage(1) 和 setHasOrders 都各自触发 effect 依赖变化，React 会合并成一次渲染
  // 只跑一次 effect——保险起见仍然两个都设，靠依赖数组去重，不手动再多调一次 load()。
  const handleHasOrdersChange = (checked: boolean) => {
    setHasOrders(checked)
    setPage(1)
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

  const openOrders = (user: AdminUser) => {
    setOrdersModal(user)
    setOrdersLoading(true)
    setOrdersFailed(false)
    setUserOrders([])
    getUserOrders(user.id, { page: 1, pageSize: 20 })
      .then((res) => setUserOrders(res.data.data.list))
      .catch(() => setOrdersFailed(true))
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
              <th className="text-left px-4 py-3">用户</th>
              <th className="text-left px-4 py-3">手机号</th>
              <th className="text-right px-4 py-3">订单数</th>
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
                    {phoneInfo ? phoneInfo.phone : '无手机号'}　订单 {u.orderCount}　注册 {fmtDate(u.createdAt)}
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
        {!loading && !loadFailed && <Pagination page={page} total={total} pageSize={pageSize} onChange={setPage} />}
      </div>

      {/* 用户订单弹窗 */}
      {ordersModal && (
        <Modal
          title={`${userLabel(ordersModal)} 的订单`}
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
          ) : ordersFailed ? (
            <div className="py-6 flex flex-col items-center gap-3 text-sm text-red-600">
              <span>订单加载失败，当前显示的不是真实数据</span>
              <Button size="sm" variant="secondary" onClick={() => openOrders(ordersModal)}>重试</Button>
            </div>
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
                        {fmtDateTime(o.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                            <button
                              type="button"
                              className="font-mono text-blue-500 hover:text-blue-700"
                              title="点击复制订单号"
                              onClick={() => {
                                // clipboard API 在 http:// 下不可用（后台常经 IP 直连），失败要说清楚而不是静默
                                navigator.clipboard
                                  ?.writeText(r.orderNo!)
                                  .then(() => toast.success('已复制订单号'))
                                  .catch(() => toast.error('复制失败，请手动选中'))
                              }}
                            >
                              {r.orderNo}
                            </button>
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
                        <td className="px-3 py-2 font-mono text-gray-600">{c.orderNo ?? c.sourceRef ?? '-'}</td>
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
