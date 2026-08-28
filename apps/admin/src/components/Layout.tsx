import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  FolderTree,
  Package,
  ClipboardList,
  Users,
  ScanLine,
  Image,
  Settings,
  LogOut,
  UtensilsCrossed,
  Bell,
  Menu,
  LucideIcon,
} from 'lucide-react'
import { useAuthStore } from '../store/auth'
import { usePendingOrders, requestNotifyPermission } from '../hooks/usePendingOrders'

const navItems: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/dashboard', label: '概览', icon: LayoutDashboard },
  { to: '/categories', label: '分类管理', icon: FolderTree },
  { to: '/products', label: '商品管理', icon: Package },
  { to: '/orders', label: '订单管理', icon: ClipboardList },
  { to: '/users', label: '用户管理', icon: Users },
  { to: '/scan-stats', label: '扫码统计', icon: ScanLine },
  { to: '/banners', label: '轮播管理', icon: Image },
  { to: '/system', label: '系统状态', icon: Settings },
]

export default function Layout() {
  const { admin, clearAuth } = useAuthStore()
  const navigate = useNavigate()
  const { count: pendingCount } = usePendingOrders()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const handleBellClick = () => {
    requestNotifyPermission()
    navigate('/orders?status=PAID')
  }

  const handleLogout = () => {
    clearAuth()
    navigate('/login')
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
          <span className="text-lg font-bold text-gray-800">食品商城</span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `relative flex items-center gap-3 px-3 py-2.5 text-sm rounded-lg transition-colors ${
                  isActive
                    ? 'bg-brand-50 text-brand-600 font-medium before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-5 before:w-1 before:rounded-full before:bg-brand-500'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`
              }
            >
              <item.icon className="w-5 h-5" strokeWidth={1.8} />
              {item.label}
              {item.to === '/orders' && pendingCount > 0 && (
                <span className="ml-auto min-w-[1.25rem] h-5 px-1 rounded-full bg-red-500 text-white text-xs flex items-center justify-center">
                  {pendingCount > 99 ? '99+' : pendingCount}
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
