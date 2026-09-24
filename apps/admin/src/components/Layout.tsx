import { useEffect, useState, type MouseEvent } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Bell, ChevronDown, ClipboardList, LayoutDashboard, LayoutGrid, LogOut, Megaphone,
  Package, Store, Users, Wrench, type LucideIcon,
} from 'lucide-react'
import { useAuthStore } from '../store/auth'
import { usePendingOrders, requestNotifyPermission, PendingCountsContext } from '../hooks/usePendingOrders'
import { useUnsavedSettings } from './UnsavedSettings'
import { activeNavLabel, mainNavigation, topNavigation, workbenchNav } from '../navigation'
import { isModifiedLinkClick } from '../utils/link-click'
import VersionBanner from './VersionBanner'

/**
 * 图标表放在这里而不是 navigation.ts —— 那个模块要能被 node --test 直接加载，
 * 一旦 import 了 lucide-react（含 JSX 运行时）测试就跑不起来。
 * 代价是它与 navigation.ts 会各走各的，所以 navigation.test.ts 用源码级断言
 * 锁住「navIcons 的键 = 一级入口的 prefix」。（键为什么用 prefix 见下面那段。）
 *
 * 工作台与订单管理必须是两个不同图标：上一版顶栏两者都用 ClipboardList，
 * 窄屏那张入口网格里只靠图标扫一眼时根本认不出是哪个。
 */
// 键用各入口的 `prefix`（/promotion、/settings…），**不要用 `to`**。
// `to` 是默认子页地址，换个默认子页就会变；这张表以前按 `to` 索引，2026-09-17 把推广运营
// 默认子页从轮播图改成优惠券时漏改过一次，查不到就是 undefined，`<Icon />` 直接白屏。
// `prefix` 是一个中心的身份，只有整个中心改名换路才会变，那种改动不可能漏掉这里。
const navIcons: Record<string, LucideIcon> = {
  '/workbench': LayoutGrid,
  '/dashboard': LayoutDashboard,
  '/catalog': Package,
  '/orders': ClipboardList,
  '/promotion': Megaphone,
  '/settings': Store,
  '/users': Users,
  '/system': Wrench,
}

export default function Layout() {
  const { clearAuth } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { dirty, confirmLeave } = useUnsavedSettings()
  // 全后台唯一一份轮询（Workbench 在 Layout 外另挂）；结果经 PendingCountsContext 下发给子页面
  const pending = usePendingOrders()
  const { count: pendingCount, afterSaleCount, localPendingCount, refundAttentionCount, lowStockCount } = pending
  const [panelOpen, setPanelOpen] = useState(false)

  /**
   * 徽标拆开（规格 §4.2）：改造前两处挂的是同一个总数，店员看到两个一样的数字
   * 不知道该点哪个。工作台管同城待接单，订单管理管邮寄待处理与售后。
   */
  // 同 navIcons：按 `prefix` 索引而不是 `to`。按 `to` 索引时，谁把订单管理的默认子页
  // 从同城改成邮寄，这里的徽标就会**静默消失**——比图标错还难发现。
  const navBadge: Record<string, number> = {
    '/workbench': localPendingCount,
    '/orders': pendingCount + afterSaleCount + refundAttentionCount,
    '/catalog': lowStockCount,
  }
  const badgeTitle: Record<string, string> = {
    '/workbench': `同城待接单 ${localPendingCount}`,
    '/orders': `待处理 ${pendingCount} · 售后 ${afterSaleCount} · 退款待处理 ${refundAttentionCount}`,
    '/catalog': `售罄或紧张的规格 ${lowStockCount}`,
  }
  const badgeOf = (prefix: string) => navBadge[prefix] ?? 0

  // 面板展开时锁背景滚动：不锁的话手指在面板上滑会滚到下面的列表，收起后位置已经跑了
  useEffect(() => {
    if (!panelOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [panelOpen])

  useEffect(() => {
    if (!panelOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanelOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panelOpen])

  const handleBellClick = () => {
    requestNotifyPermission()
    navigate('/orders/express?status=PAID')
  }

  const handleLogout = () => {
    clearAuth()
    navigate('/login')
  }

  const handleNavigation = (event: MouseEvent, to: string) => {
    if (to === location.pathname) {
      setPanelOpen(false)
      return
    }
    if (!dirty) {
      setPanelOpen(false)
      return
    }
    // 与页签行同一判据：Cmd+点击顶栏入口是要开新标签，不离开本页，不该被守卫吞掉。
    // 少了这一条就会出现「同一屏上点页签能开新标签、点顶栏不能」的不一致。
    if (isModifiedLinkClick(event)) return
    event.preventDefault()
    void confirmLeave().then((confirmed) => {
      if (!confirmed) return
      setPanelOpen(false)
      navigate(to)
    })
  }

  return (
    <div className="relative flex h-screen flex-col bg-gray-100">
      <VersionBanner />
      <header className="relative z-30 flex h-14 shrink-0 items-center gap-3 border-b border-gray-100 bg-white px-3 shadow-sm md:px-4">
        <NavLink
          to="/dashboard"
          onClick={(event) => handleNavigation(event, '/dashboard')}
          className="shrink-0 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-400"
        >
          <img
            src="/brand-logo.png"
            srcSet="/brand-logo.png 1x, /brand-logo@2x.png 2x"
            alt="阿福凉菜"
            className="h-8 w-auto object-contain"
          />
        </NavLink>

        {/* ≥1000px：左侧一串 8 项（工作台不在其中，见下方右侧）。
            <nav(1240px) 去掉图标与「退出登录」文字，保证不换行也不横滚 */}
        <nav aria-label="主导航" className="hidden min-w-0 flex-1 items-center gap-0.5 navrow:flex">
          {mainNavigation.map((item) => {
            const Icon = navIcons[item.prefix]
            const active = location.pathname.startsWith(item.prefix)
            const count = badgeOf(item.prefix)
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={(event) => handleNavigation(event, item.to)}
                className={`relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm transition-colors ${
                  active
                    ? 'bg-brand-50 font-medium text-brand-600'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <Icon className="hidden h-4 w-4 shrink-0 nav:block" strokeWidth={1.9} />
                {item.label}
                {count > 0 && (
                  <span
                    title={badgeTitle[item.prefix]}
                    className="ml-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-none text-white"
                  >
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </NavLink>
            )
          })}
        </nav>

        {/* <1000px：顶栏只留当前页名 + 箭头，点开入口网格（规格 §4.3，8 个入口 4 列两行） */}
        <button
          onClick={() => setPanelOpen((v) => !v)}
          aria-expanded={panelOpen}
          aria-controls="nav-panel"
          className="ml-1 inline-flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 navrow:hidden"
        >
          <span className="truncate">{activeNavLabel(location.pathname)}</span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${panelOpen ? 'rotate-180' : ''}`}
          />
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-3 md:gap-4">
          {/* 接单工作台单独贴右：左侧那一串是「去哪儿改配置」，这里是「今天要干的活」，
              中间靠 nav 的 flex-1 撑开空白分开，再用一道竖线收边 */}
          <NavLink
            to={workbenchNav.to}
            onClick={(event) => handleNavigation(event, workbenchNav.to)}
            className={`relative hidden h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition-colors navrow:inline-flex ${
              location.pathname.startsWith(workbenchNav.prefix)
                ? 'bg-brand-600 text-white'
                : 'bg-brand-50 text-brand-700 hover:bg-brand-100'
            }`}
          >
            <LayoutGrid className="h-4 w-4 shrink-0" strokeWidth={1.9} />
            {workbenchNav.label}
            {badgeOf(workbenchNav.prefix) > 0 && (
              <span
                title={badgeTitle[workbenchNav.prefix]}
                className={`ml-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] leading-none ${
                  location.pathname.startsWith(workbenchNav.prefix)
                    ? 'bg-white text-brand-600'
                    : 'bg-red-500 text-white'
                }`}
              >
                {badgeOf(workbenchNav.prefix) > 99 ? '99+' : badgeOf(workbenchNav.prefix)}
              </span>
            )}
          </NavLink>
          <span className="hidden h-6 w-px shrink-0 bg-gray-200 navrow:block" />

          <button
            onClick={handleBellClick}
            className="relative text-gray-500 transition-colors hover:text-brand-500"
            aria-label="待发货订单提醒"
            title="待发货订单"
          >
            <Bell className="h-5 w-5" />
            {pendingCount > 0 && (
              <span className="absolute -right-2 -top-1.5 flex h-[1.1rem] min-w-[1.1rem] items-center justify-center rounded-full bg-red-500 px-0.5 text-[10px] leading-none text-white">
                {pendingCount > 99 ? '99+' : pendingCount}
              </span>
            )}
          </button>
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 transition-colors hover:text-red-500"
          >
            <LogOut className="h-4 w-4" />
            {/* 1000–1239 档要把宽度让给导航项：这里只留图标，文字到 ≥1240 才回来 */}
            <span className="hidden nav:inline">退出登录</span>
          </button>
        </div>
      </header>

      {panelOpen && (
        <div
          className="fixed inset-0 top-14 z-20 bg-black/40 navrow:hidden"
          onClick={() => setPanelOpen(false)}
        />
      )}
      {/* 用 hidden 属性而非条件渲染：aria-controls 指向的元素必须始终在 DOM 里 */}
      <div
        id="nav-panel"
        hidden={!panelOpen}
        className="absolute inset-x-0 top-14 z-30 border-b border-gray-100 bg-white p-3 shadow-lg navrow:hidden"
      >
        {/* 4 列：一级入口 8 个，正好两行铺满；3 列会剩「3+3+2」的半行。
            375px 下每格 82×72，最窄的 360dp 安卓也有 78px，「接单工作台」五个字不折行（实测）。 */}
        <div className="grid grid-cols-4 gap-2">
          {topNavigation.map((item) => {
            const Icon = navIcons[item.prefix]
            const active = location.pathname.startsWith(item.prefix)
            const count = badgeOf(item.prefix)
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={(event) => handleNavigation(event, item.to)}
                className={`relative flex min-h-[4.5rem] flex-col items-center justify-center gap-1 rounded-xl px-1 text-xs ${
                  active ? 'bg-brand-50 font-medium text-brand-600' : 'bg-gray-50 text-gray-700'
                }`}
              >
                <Icon className="h-5 w-5" strokeWidth={1.8} />
                <span className="text-center leading-tight">{item.label}</span>
                {count > 0 && (
                  <span className="absolute right-1.5 top-1.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-none text-white">
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </NavLink>
            )
          })}
        </div>
      </div>

      <main className="flex-1 overflow-auto p-4 md:p-6">
        <PendingCountsContext.Provider value={pending}>
          <Outlet />
        </PendingCountsContext.Provider>
      </main>
    </div>
  )
}
