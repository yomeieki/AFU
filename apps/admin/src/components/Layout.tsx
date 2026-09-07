import { useEffect, useState, type MouseEvent } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Bell, ChevronDown, ClipboardList, LayoutDashboard, LayoutGrid, LogOut, Megaphone,
  Package, Store, Ticket, Users, Wrench, type LucideIcon,
} from 'lucide-react'
import { useAuthStore } from '../store/auth'
import { usePendingOrders, requestNotifyPermission } from '../hooks/usePendingOrders'
import { useUnsavedSettings } from './UnsavedSettings'
import { activeNavLabel, topNavigation } from '../navigation'

/**
 * 图标按 to 取，不写进 navigation.ts —— 那个模块要能被 node --test 直接加载，
 * 一旦 import 了 lucide-react（含 JSX 运行时）测试就跑不起来。
 *
 * 工作台与订单管理必须是两个不同图标：上一版顶栏两者都用 ClipboardList，
 * 窄屏九宫格里只靠图标扫一眼时根本认不出是哪个。
 */
const navIcons: Record<string, LucideIcon> = {
  '/workbench': LayoutGrid,
  '/dashboard': LayoutDashboard,
  '/catalog/products': Package,
  '/orders/local': ClipboardList,
  '/membership/coupons': Ticket,
  '/settings/express': Store,
  '/users': Users,
  '/promotion/banners': Megaphone,
  '/system/printer': Wrench,
}

export default function Layout() {
  const { clearAuth } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { dirty, confirmLeave } = useUnsavedSettings()
  const { count: pendingCount, afterSaleCount, localPendingCount } = usePendingOrders()
  const [panelOpen, setPanelOpen] = useState(false)

  /**
   * 徽标拆开（规格 §4.2）：改造前两处挂的是同一个总数，店员看到两个一样的数字
   * 不知道该点哪个。工作台管同城待接单，订单管理管邮寄待处理与售后。
   */
  const navBadge: Record<string, number> = {
    '/workbench': localPendingCount,
    '/orders/local': pendingCount + afterSaleCount,
  }
  const badgeTitle: Record<string, string> = {
    '/workbench': `同城待接单 ${localPendingCount}`,
    '/orders/local': `待处理 ${pendingCount} · 售后 ${afterSaleCount}`,
  }
  const badgeOf = (to: string) => navBadge[to] ?? 0

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
    event.preventDefault()
    void confirmLeave().then((confirmed) => {
      if (!confirmed) return
      setPanelOpen(false)
      navigate(to)
    })
  }

  return (
    <div className="relative flex h-screen flex-col bg-gray-100">
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

        {/* ≥960px：单行 9 项。<nav(1200px) 去掉图标与「退出登录」文字，保证不换行也不横滚 */}
        <nav aria-label="主导航" className="hidden min-w-0 flex-1 items-center gap-0.5 navrow:flex">
          {topNavigation.map((item) => {
            const Icon = navIcons[item.to]
            const active = location.pathname.startsWith(item.prefix)
            const workbench = item.to === '/workbench'
            const count = badgeOf(item.to)
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={(event) => handleNavigation(event, item.to)}
                className={`relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm transition-colors ${
                  workbench
                    ? active
                      ? 'bg-brand-600 font-semibold text-white'
                      : 'bg-brand-50 font-semibold text-brand-700 hover:bg-brand-100'
                    : active
                      ? 'bg-brand-50 font-medium text-brand-600'
                      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <Icon className="hidden h-4 w-4 shrink-0 nav:block" strokeWidth={1.9} />
                {item.label}
                {count > 0 && (
                  <span
                    title={badgeTitle[item.to]}
                    className={`ml-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] leading-none ${
                      workbench && active ? 'bg-white text-brand-600' : 'bg-red-500 text-white'
                    }`}
                  >
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </NavLink>
            )
          })}
        </nav>

        {/* <960px：顶栏只留当前页名 + 箭头，点开九宫格（规格 §4.3） */}
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
            {/* 960–1199 档要把宽度让给 9 个导航项：这里只留图标，文字到 ≥1200 才回来 */}
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
        <div className="grid grid-cols-3 gap-2">
          {topNavigation.map((item) => {
            const Icon = navIcons[item.to]
            const active = location.pathname.startsWith(item.prefix)
            const count = badgeOf(item.to)
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
        <Outlet />
      </main>
    </div>
  )
}
