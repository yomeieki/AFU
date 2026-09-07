import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useUnsavedSettings } from '../components/UnsavedSettings'
import { centerTabs } from '../navigation'

export default function SettingsCenter() {
  const location = useLocation()
  const navigate = useNavigate()
  const { confirmLeave } = useUnsavedSettings()

  const leave = async (to: string) => {
    if (to === location.pathname) return
    if (!(await confirmLeave())) return
    navigate(to)
  }

  return (
    <div className="space-y-5">
        <header>
          <h2 className="text-xl font-semibold text-gray-800">店铺设置</h2>
          <p className="mt-1 text-sm text-gray-500">按配送方式分别维护规则，保存只作用于当前设置页。</p>
        </header>
        <nav className="overflow-x-auto rounded-xl border border-gray-200 bg-white px-2 shadow-sm" aria-label="店铺设置导航">
          <div className="flex min-w-max" role="tablist">
            {centerTabs.settings.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end
                role="tab"
                onClick={(event) => {
                  event.preventDefault()
                  void leave(tab.to)
                }}
                className={({ isActive }) =>
                  `border-b-2 px-4 py-3 text-sm transition-colors ${
                    isActive
                      ? 'border-brand-500 text-brand-600 font-medium'
                      : 'border-transparent text-gray-600 hover:text-gray-900'
                  }`
                }
              >
                {tab.label}
              </NavLink>
            ))}
          </div>
        </nav>
        <Outlet />
    </div>
  )
}
