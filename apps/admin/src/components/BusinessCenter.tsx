import { NavLink, Outlet } from 'react-router-dom'
import type { CenterTab } from '../navigation'

interface BusinessCenterProps {
  title: string
  description: string
  tabs: CenterTab[]
}

export default function BusinessCenter({ title, description, tabs }: BusinessCenterProps) {
  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-xl font-semibold text-gray-800">{title}</h2>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
      </header>
      <nav className="overflow-x-auto rounded-xl border border-gray-200 bg-white px-2 shadow-sm" aria-label={`${title}功能导航`}>
        <div className="flex min-w-max" role="tablist">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end
              role="tab"
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
