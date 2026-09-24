import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useUnsavedSettings } from './UnsavedSettings'
import { isModifiedLinkClick } from '../utils/link-click'
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
  /**
   * 页签角标（按 `tab.to` 取数），如 { '/catalog/low-stock': 12 }。可选：不传则页签不带角标，
   * 对其余业务中心零影响（2026-09-24 库存预警只给「商品管理」传）。
   */
  badges?: Record<string, number>
}

export default function BusinessCenter({ title, description, tabs, badges }: BusinessCenterProps) {
  // ref 回调 + state 而非 useRef：portal 的目标必须是已挂载的真实节点，
  // useRef 在首次渲染时还是 null 且不会触发重渲染，按钮就永远不出现。
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null)

  // 未保存拦截内置在这里，而不是由各个中心自己传 onTabClick：
  // dirty 是 UnsavedSettingsProvider 里的全局单例（Provider 挂在 App 的 Layout 层），
  // 哪个中心有未保存的表单它就为真，所以守卫本来就该对所有中心一致生效。
  // 2026-09-17 满减页从「店铺设置」搬到「推广运营」时就因为只有 SettingsCenter 传了
  // onTabClick 而丢掉了这层保护——改动没保存点页签直接跳走、改动静默丢失。
  // 没有脏数据时 confirmLeave 立即返回 true，不弹框，所以对其余中心零影响。
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
        <h2 className="text-xl font-semibold text-gray-800">{title}</h2>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
      </header>

      {/* flex-wrap + nav 的 flex-auto（基准 = 页签实际宽度）：宽度够就页签与主操作同排，
          不够就让按钮整个落到第二行，而不是把最后一个页签挤进横向滚动区里看不见。

          窄屏通栏（-mx-4 抵掉 main 的 p-4，sm(640) 起恢复常规卡片）：页签条被 main 的左右内边距
          各吃 16px、自己再吃 8px，一共 48px。375px 手机上「店铺设置」四项实测需要 404px、
          只剩 327px 可用——最后一个页签要横划才看得见，而这是改名之前就有的老问题。
          通栏把那 48px 还给页签，五个中心才能在手机上都一行装下、行为一致。
          通栏条只写 border-y 就够：Tailwind preflight 已把四边 border-width 置 0、圆角为 none，
          所以贴边时天然没有左右边框和圆角（别以为有 rounded-none border-x-0 在兜着）。
          退出断点用 sm(640) 而不是 md(768)：640 以上早就不缺这 48px，而 640–767 之间 main
          仍是 p-4，mx-0 后条子与下方内容卡片正好对齐，不会出现「条贴边、卡片内缩」的断裂。 */}
      <div className="-mx-4 flex flex-wrap items-center gap-2 border-y border-gray-200 bg-white px-2 shadow-sm sm:mx-0 sm:rounded-xl sm:border">
        <nav className="min-w-0 flex-auto overflow-x-auto" aria-label={`${title}功能导航`}>
          <div className="flex min-w-max" role="tablist">
            {tabs.map((tab) => {
              const count = badges?.[tab.to] ?? 0
              return (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  end
                  role="tab"
                  onClick={(event) => {
                    if (isModifiedLinkClick(event)) return // 开新标签/新窗口，不离开本页，不用守
                    event.preventDefault()
                    void leave(tab.to)
                  }}
                  className={({ isActive }) =>
                    // 手机上收内边距：推广运营 5 个页签在 360dp 安卓上实测正好 344/344 卡满，
                    // 零余量——字号、字体或系统文字放大任何一点变化都会掉进横划。
                    // px-2.5 换来 10px 安全垫（5 个页签 × 左右各 1px）。触控高度不受影响（py-3 仍是 48px）。
                    `border-b-2 px-2.5 py-3 text-sm transition-colors sm:px-4 ${
                      isActive
                        ? 'border-brand-500 text-brand-600 font-medium'
                        : 'border-transparent text-gray-600 hover:text-gray-900'
                    }`
                  }
                >
                  {tab.label}
                  {count > 0 && (
                    <span className="ml-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-none text-white align-middle">
                      {count > 99 ? '99+' : count}
                    </span>
                  )}
                </NavLink>
              )
            })}
          </div>
        </nav>
        {/* py-1.5 让同排时这一格高度与 py-3 的页签一致（36+12 = 48），行高不被撑大。
            empty:hidden：没有主操作按钮的子页（满减、会员设置）这一格仍占 pl-2+gap-2 共 16px，
            窄屏放不下就整格换行，把 48px 高的条子撑成 68px——底下多一截没有内容的空白。 */}
        <div ref={setActionSlot} className="ml-auto flex shrink-0 items-center gap-2 py-1.5 pl-2 empty:hidden" />
      </div>

      <CenterActionSlot.Provider value={actionSlot}>
        <Outlet />
      </CenterActionSlot.Provider>
    </div>
  )
}
