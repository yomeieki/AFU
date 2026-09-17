import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, Outlet } from 'react-router-dom'
import type { CenterTab } from '../navigation'

const CenterActionSlot = createContext<HTMLElement | null>(null)

/**
 * 把子页的主操作按钮（新增商品 / 新建模板…）渲染进业务中心页签行的右端，
 * 而不是让它自己在下面另起一行——那一行只有一个按钮，白占一截高度。
 *
 * 用 portal 而不是把按钮当 prop 传给 BusinessCenter：按钮的 onClick 依赖子页
 * 自己的状态（openCreate 会重置表单、清空编辑目标），当 prop 传就得把那份
 * 状态一起提升到中心壳里。
 */
export function CenterAction({ children }: { children: ReactNode }) {
  const slot = useContext(CenterActionSlot)
  return slot ? createPortal(children, slot) : null
}

interface BusinessCenterProps {
  title: string
  description: string
  tabs: CenterTab[]
  /** 传了就接管页签跳转（店铺设置用它拦未保存的修改） */
  onTabClick?: (to: string) => void
}

export default function BusinessCenter({ title, description, tabs, onTabClick }: BusinessCenterProps) {
  // ref 回调 + state 而非 useRef：portal 的目标必须是已挂载的真实节点，
  // useRef 在首次渲染时还是 null 且不会触发重渲染，按钮就永远不出现。
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null)

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-xl font-semibold text-gray-800">{title}</h2>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
      </header>

      {/* flex-wrap + nav 的 flex-auto（基准 = 页签实际宽度）：宽度够就页签与主操作同排，
          不够就让按钮整个落到第二行，而不是把最后一个页签挤进横向滚动区里看不见。

          窄屏通栏（-mx-4 抵掉 main 的 p-4，md 起恢复常规卡片）：页签条被 main 的左右内边距
          各吃 16px、自己再吃 8px，一共 48px。375px 手机上「店铺设置」四项实测需要 404px、
          只剩 327px 可用——最后一个页签要横划才看得见，而这是改名之前就有的老问题。
          通栏把那 48px 还给页签，五个中心才能在手机上都一行装下、行为一致。
          通栏条去掉圆角与左右边框（rounded-none border-x-0），否则贴边时边框会切在屏幕边上。 */}
      <div className="-mx-4 flex flex-wrap items-center gap-2 border-y border-gray-200 bg-white px-2 shadow-sm md:mx-0 md:rounded-xl md:border">
        <nav className="min-w-0 flex-auto overflow-x-auto" aria-label={`${title}功能导航`}>
          <div className="flex min-w-max" role="tablist">
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end
                role="tab"
                onClick={
                  onTabClick
                    ? (event) => {
                        event.preventDefault()
                        onTabClick(tab.to)
                      }
                    : undefined
                }
                className={({ isActive }) =>
                  // 手机上收一格内边距：会员营销是 3 个页签 + 新建按钮，px-4 时
                  // 375px 差几像素放不下，最后一个页签会被挤进滚动区看不见
                  `border-b-2 px-3 py-3 text-sm transition-colors sm:px-4 ${
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
        {/* py-1.5 让同排时这一格高度与 py-3 的页签一致（36+12 = 48），行高不被撑大 */}
        <div ref={setActionSlot} className="ml-auto flex shrink-0 items-center gap-2 py-1.5 pl-2" />
      </div>

      <CenterActionSlot.Provider value={actionSlot}>
        <Outlet />
      </CenterActionSlot.Provider>
    </div>
  )
}
