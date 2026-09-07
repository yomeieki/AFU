import { useState, type MouseEvent } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Package,
  ClipboardList,
  Users,
  ScanLine,
  Image,
  Settings,
  Store,
  LogOut,
  UtensilsCrossed,
  Bell,
  Menu,
  Printer,
  Ticket,
  LucideIcon,
} from 'lucide-react'
import { useAuthStore } from '../store/auth'
import { usePendingOrders, requestNotifyPermission } from '../hooks/usePendingOrders'
import { useUnsavedSettings } from './UnsavedSettings'

const navItems: { to: string; prefix: string; label: string; icon: LucideIcon }[] = [
  { to: '/dashboard', prefix: '/dashboard', label: '经营概览', icon: LayoutDashboard },
  { to: '/catalog/products', prefix: '/catalog', label: '商品管理', icon: Package },
  { to: '/orders/local', prefix: '/orders', label: '订单管理', icon: ClipboardList },
  { to: '/membership/coupons', prefix: '/membership', label: '会员营销', icon: Ticket },
  { to: '/settings/express', prefix: '/settings', label: '店铺设置', icon: Store },
  { to: '/users', prefix: '/users', label: '用户管理', icon: Users },
  { to: '/scan-stats', prefix: '/scan-stats', label: '扫码统计', icon: ScanLine },
  { to: '/banners', prefix: '/banners', label: '轮播管理', icon: Image },
  { to: '/printer-settings', prefix: '/printer-settings', label: '打印机设置', icon: Printer },
  { to: '/system', prefix: '/system', label: '系统状态', icon: Settings },
]

export default function Layout() {
  const { admin, clearAuth } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { dirty, confirmLeave } = useUnsavedSettings()
  const { count: pendingCount, afterSaleCount, localPendingCount } = usePendingOrders()
  const orderBadge = pendingCount + afterSaleCount + localPendingCount
  const navBadge: Record<string, number> = { '/orders/local': orderBadge }
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const handleBellClick = () => {
    requestNotifyPermission()
    navigate('/orders/express?status=PAID')
  }

  const handleLogout = () => {
    clearAuth()
    navigate('/login')
  }

  const handleNavigation = (event: MouseEvent, to: string) => {
    if (to === location.pathname) return
    if (!dirty) {
      setSidebarOpen(false)
      return
    }
    event.preventDefault()
    void confirmLeave().then((confirmed) => {
      if (!confirmed) return
      setSidebarOpen(false)
      navigate(to)
    })
  }

  return (
    <div className="flex h-screen bg-gray-100">
      {/* <md 抽屉遮罩 */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-56 bg-white shadow-sm flex flex-col transform transition-transform duration-200 md:static md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-16 flex items-center justify-center gap-2 border-b border-gray-100">
          <span className="w-8 h-8 rounded-lg bg-brand-gradient flex items-center justify-center">
            <UtensilsCrossed className="text-white" size={18} />
          </span>
          <span className="text-lg font-bold text-gray-800">阿福凉菜</span>
        </div>
        <div className="px-3 pt-4">
          <NavLink
            to="/workbench"
            onClick={(event) => handleNavigation(event, '/workbench')}
            className={`relative flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold transition-colors ${
              location.pathname === '/workbench'
                ? 'bg-brand-500 text-white shadow-sm'
                : 'bg-brand-50 text-brand-700 hover:bg-brand-100'
            }`}
          >
            <UtensilsCrossed className="h-5 w-5" strokeWidth={2} />
            接单工作台
            {orderBadge > 0 && (
              <span className={`ml-auto flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-xs ${
                location.pathname === '/workbench' ? 'bg-white text-brand-600' : 'bg-red-500 text-white'
              }`}>
                {orderBadge > 99 ? '99+' : orderBadge}
              </span>
            )}
          </NavLink>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={(event) => handleNavigation(event, item.to)}
              className={() =>
                `relative flex items-center gap-3 px-3 py-2.5 text-sm rounded-lg transition-colors ${
                  location.pathname.startsWith(item.prefix)
                    ? 'bg-brand-50 text-brand-600 font-medium before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-5 before:w-1 before:rounded-full before:bg-brand-500'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`
              }
            >
              <item.icon className="w-5 h-5" strokeWidth={1.8} />
              {item.label}
              {(navBadge[item.to] ?? 0) > 0 && (
                <span
                  className="ml-auto min-w-[1.25rem] h-5 px-1 rounded-full bg-red-500 text-white text-xs flex items-center justify-center"
                  title={`待处理 ${pendingCount} · 售后 ${afterSaleCount} · 同城待接单 ${localPendingCount}`}
                >
                  {navBadge[item.to] > 99 ? '99+' : navBadge[item.to]}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 bg-white shadow-sm flex items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden text-gray-600 hover:text-gray-900"
              aria-label="打开菜单"
            >
              <Menu className="w-5 h-5" />
            </button>
            <span className="text-sm text-gray-500 hidden sm:inline">欢迎，{admin?.username}</span>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={handleBellClick}
              className="relative text-gray-500 hover:text-brand-500 transition-colors"
              aria-label="待发货订单提醒"
              title="待发货订单"
            >
              <Bell className="w-5 h-5" />
              {pendingCount > 0 && (
                <span className="absolute -top-1.5 -right-2 min-w-[1.1rem] h-[1.1rem] px-0.5 rounded-full bg-red-500 text-white text-[10px] leading-none flex items-center justify-center">
                  {pendingCount > 99 ? '99+' : pendingCount}
                </span>
              )}
            </button>
            <button
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-500 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              退出登录
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
