import { useState, type MouseEvent } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Bell,
  ClipboardList,
  Image,
  LayoutDashboard,
  LogOut,
  Package,
  Printer,
  ScanLine,
  Settings,
  Store,
  Ticket,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { moreNavigationSections, topNavigation } from '../navigation'
import { useAuthStore } from '../store/auth'
import { usePendingOrders, requestNotifyPermission } from '../hooks/usePendingOrders'
import { useUnsavedSettings } from './UnsavedSettings'

const navigationIcons: Record<string, LucideIcon> = {
  '/workbench': ClipboardList,
  '/dashboard': LayoutDashboard,
  '/orders/local': ClipboardList,
  '/catalog/products': Package,
  '/membership/settings': Users,
  '/membership/coupons': Ticket,
  '/membership/points-goods': Ticket,
  '/settings/express': Store,
  '/settings/local': Store,
  '/users': Users,
  '/scan-stats': ScanLine,
  '/banners': Image,
  '/printer-settings': Printer,
  '/system': Settings,
}

export default function Layout() {
  const { admin, clearAuth } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { dirty, confirmLeave } = useUnsavedSettings()
  const { count: pendingCount, afterSaleCount, localPendingCount } = usePendingOrders()
  const [moreOpen, setMoreOpen] = useState(false)
  const orderBadge = pendingCount + afterSaleCount + localPendingCount
  const moreActive = moreNavigationSections.some((section) =>
    section.items.some((item) => location.pathname.startsWith(item.prefix)),
  )

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
      setMoreOpen(false)
      return
    }
    if (!dirty) {
      setMoreOpen(false)
      return
    }
    event.preventDefault()
    void confirmLeave().then((confirmed) => {
      if (!confirmed) return
      setMoreOpen(false)
      navigate(to)
    })
  }

  return (
    <div className="flex h-screen flex-col bg-gray-100">
      <header className="z-20 flex h-16 shrink-0 items-center justify-between gap-3 border-b border-gray-100 bg-white px-3 shadow-sm sm:px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <NavLink
            to="/dashboard"
            onClick={(event) => handleNavigation(event, '/dashboard')}
            aria-label="经营概览"
            title="经营概览"
            className="shrink-0 rounded-md transition-opacity hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-2"
          >
            <img src="/brand-logo.png" alt="阿福凉菜" className="h-8 w-8 rounded-md object-contain" />
          </NavLink>

          <nav aria-label="主导航" className="flex min-w-0 items-center gap-1">
            {topNavigation.map((item) => {
              const Icon = navigationIcons[item.to]
              const active = location.pathname.startsWith(item.prefix)
              const isWorkbench = item.to === '/workbench'
              const isOrders = item.prefix === '/orders'

              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={(event) => handleNavigation(event, item.to)}
                  aria-label={item.label}
                  title={item.label}
                  className={`relative inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium transition-colors sm:px-2.5 lg:px-3 ${
                    isWorkbench
                      ? active
                        ? 'bg-brand-600 text-white shadow-sm'
                        : 'bg-brand-50 text-brand-700 hover:bg-brand-100'
                      : active
                        ? 'bg-brand-50 text-brand-700'
                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
                  <span className="hidden sm:inline">{item.label}</span>
                  {(isWorkbench || isOrders) && orderBadge > 0 && (
                    <span
                      className={`absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none ${
                        isWorkbench && active ? 'bg-white text-brand-600' : 'bg-red-500 text-white'
                      }`}
                      title={`待处理 ${pendingCount} · 售后 ${afterSaleCount} · 同城待接单 ${localPendingCount}`}
                    >
                      {orderBadge > 99 ? '99+' : orderBadge}
                    </span>
                  )}
                </NavLink>
              )
            })}

            <div className="relative">
              <button
                type="button"
                onClick={() => setMoreOpen((open) => !open)}
                aria-expanded={moreOpen}
                aria-controls="more-navigation"
                aria-label="更多后台功能"
                className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium transition-colors sm:px-2.5 lg:px-3 ${
                  moreActive ? 'bg-brand-50 text-brand-700' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <span className="text-lg leading-none" aria-hidden="true">⋯</span>
                <span className="hidden sm:inline">更多</span>
              </button>

              {moreOpen && (
                <div
                  id="more-navigation"
                  role="menu"
                  className="absolute left-0 top-11 z-30 w-52 rounded-xl border border-gray-100 bg-white p-2 shadow-lg"
                >
                  {moreNavigationSections.map((section, index) => (
                    <div key={section.label} className={index === 0 ? '' : 'mt-2 border-t border-gray-100 pt-2'}>
                      <p className="px-2 py-1 text-xs font-semibold text-gray-400">{section.label}</p>
                      {section.items.map((item) => {
                        const Icon = navigationIcons[item.to]
                        const active = location.pathname.startsWith(item.prefix)
                        return (
                          <NavLink
                            key={item.to}
                            role="menuitem"
                            to={item.to}
                            onClick={(event) => handleNavigation(event, item.to)}
                            className={`flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors ${
                              active ? 'bg-brand-50 text-brand-700' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                            }`}
                          >
                            <Icon className="h-4 w-4" strokeWidth={1.8} />
                            {item.label}
                          </NavLink>
                        )
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <span className="hidden text-sm text-gray-500 lg:inline">欢迎，{admin?.username}</span>
          <button
            onClick={handleBellClick}
            className="relative rounded-md p-1 text-gray-500 transition-colors hover:text-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-2"
            aria-label="待发货订单提醒"
            title="待发货订单"
          >
            <Bell className="h-5 w-5" />
            {pendingCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-none text-white">
                {pendingCount > 99 ? '99+' : pendingCount}
              </span>
            )}
          </button>
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-1.5 rounded-md p-1 text-sm text-gray-500 transition-colors hover:text-red-500 focus:outline-none focus:ring-2 focus:ring-red-300 focus:ring-offset-2 sm:px-2"
            aria-label="退出登录"
            title="退出登录"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden lg:inline">退出登录</span>
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  )
}
