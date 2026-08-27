import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  FolderTree,
  Package,
  ClipboardList,
  Users,
  LogOut,
  UtensilsCrossed,
  LucideIcon,
} from 'lucide-react'
import { useAuthStore } from '../store/auth'

const navItems: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/dashboard', label: '概览', icon: LayoutDashboard },
  { to: '/categories', label: '分类管理', icon: FolderTree },
  { to: '/products', label: '商品管理', icon: Package },
  { to: '/orders', label: '订单管理', icon: ClipboardList },
  { to: '/users', label: '用户管理', icon: Users },
]

export default function Layout() {
  const { admin, clearAuth } = useAuthStore()
  const navigate = useNavigate()

  const handleLogout = () => {
    clearAuth()
    navigate('/login')
  }

  return (
    <div className="flex h-screen bg-gray-100">
      <aside className="w-56 bg-white shadow-sm flex flex-col">
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
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 bg-white shadow-sm flex items-center justify-between px-6">
          <span className="text-sm text-gray-500">欢迎，{admin?.username}</span>
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-500 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            退出登录
          </button>
        </header>
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
