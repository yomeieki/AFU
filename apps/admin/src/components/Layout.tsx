import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'

const navItems = [
  { to: '/dashboard', label: '概览' },
  { to: '/categories', label: '分类管理' },
  { to: '/products', label: '商品管理' },
  { to: '/orders', label: '订单管理' },
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
        <div className="h-16 flex items-center justify-center border-b">
          <span className="text-lg font-bold text-orange-500">食品商城管理</span>
        </div>
        <nav className="flex-1 py-4">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `block px-6 py-3 text-sm transition-colors ${
                  isActive
                    ? 'bg-orange-50 text-orange-600 font-medium border-r-2 border-orange-500'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`
              }
            >
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
            className="text-sm text-gray-500 hover:text-red-500 transition-colors"
          >
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
