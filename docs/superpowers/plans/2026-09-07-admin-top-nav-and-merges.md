# 后台顶部导航 + 推广运营/系统维护合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把后台一级导航从左侧栏改为顶部单行 9 项，品牌区只留印章 Logo，并把「轮播管理 + 扫码统计」合并为「推广运营」、「打印机设置 + 系统状态」合并为「系统维护」。

**Architecture:** `navigation.ts` 继续做纯数据源（顶部导航项、各中心页签、旧地址映射），可被 `node --test` 直接加载验证；`Layout.tsx` 消费这些数据渲染吸顶顶栏与窄屏九宫格面板；两个新中心复用第一轮已有的 `BusinessCenter` 外壳，原页面组件原样挂进去当子页。

**Tech Stack:** React 18、React Router 6、TypeScript、Tailwind CSS 3、lucide-react 1.23.0、Node 内置测试运行器、sips（macOS 自带缩图）。

**Spec:** `docs/superpowers/specs/2026-09-07-admin-business-centers-design.md`（第二轮修订，§4 / §10 / §11 / §12 / §15 / §16）

## Global Constraints

- 工作目录 `/Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers`，分支 `codex/admin-business-centers`。
- 只改 `apps/admin` 前端与文档；不动 API、数据库、业务状态机、部署配置，不改小程序顾客端。
- `/workbench` 保持鉴权内、`Layout` 外的独立全屏路由，本计划不进入 `Workbench.tsx`。
- 一级导航在任何断点都**不允许横向滚动**；不设「更多」下拉菜单。
- 页面上不得再出现「阿福凉菜」文字与 `UtensilsCrossed` 图标；Logo 的 `alt` 必须是 `阿福凉菜`。
- 顶栏高度 56px（`h-14`），Logo 高 32px（`h-8`）。
- 徽标口径：接单工作台 = `localPendingCount`；订单管理 = `pendingCount + afterSaleCount`。超过 99 显示 `99+`。
- 每个任务结束都要跑 `npm test`（在 `apps/admin` 下）并保持全绿。
- 命令一律在 `apps/admin` 目录下执行，除非步骤另有说明。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `apps/admin/public/brand-logo.png` | 顶栏 Logo 1x（高 80px） | 创建 |
| `apps/admin/public/brand-logo@2x.png` | 顶栏 Logo 2x（高 160px） | 创建 |
| `apps/admin/src/navigation.ts` | 顶部导航项、六个中心页签、旧地址映射、当前页名 | 修改 |
| `apps/admin/src/navigation.test.ts` | 上述纯数据的单元测试 | 修改 |
| `apps/admin/src/pages/PromotionCenter.tsx` | 推广运营中心外壳 | 创建 |
| `apps/admin/src/pages/SystemCenter.tsx` | 系统维护中心外壳 | 创建 |
| `apps/admin/src/App.tsx` | 两个新中心的路由与旧地址重定向 | 修改 |
| `apps/admin/src/pages/Banners.tsx` | 去掉自带 `<h2>轮播管理` | 修改 |
| `apps/admin/src/pages/ScanStats.tsx` | 去掉自带 `<h2>扫码统计` | 修改 |
| `apps/admin/src/pages/PrinterSettings.tsx` | 去掉两处自带 `<h2>打印机设置` | 修改 |
| `apps/admin/src/pages/SystemStatus.tsx` | 去掉自带 `<h2>系统状态` | 修改 |
| `apps/admin/tailwind.config.js` | 新增 `nav: 1100px` 断点 | 修改 |
| `apps/admin/src/components/Layout.tsx` | 顶栏三档响应式 + 九宫格面板 + 徽标拆分 | 整文件替换 |

---

### Task 1: Logo 资源缩制

原图在被 revert 的提交 `0c230b4` 里（1295×1214 透明 PNG，776 KB），顶栏只需 32px 高，必须缩图后入库。

**Files:**
- Create: `apps/admin/public/brand-logo.png`
- Create: `apps/admin/public/brand-logo@2x.png`

**Interfaces:**
- Produces: 两个静态资源，Task 4 用 `<img src="/brand-logo.png" srcSet="/brand-logo.png 1x, /brand-logo@2x.png 2x">` 引用。

- [ ] **Step 1: 从被 revert 的提交取回源图**

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers
git show 0c230b4:apps/admin/public/brand-logo.png > /tmp/brand-logo-src.png
sips -g pixelWidth -g pixelHeight /tmp/brand-logo-src.png
```

Expected: `pixelWidth: 1295` / `pixelHeight: 1214`

- [ ] **Step 2: 缩成 1x / 2x 两张**

`--resampleHeight` 按高缩放并保持比例；顶栏渲染高 32px，1x 给 80px 是为了在 100%–250% 浏览器缩放下都不糊。

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers/apps/admin
sips --resampleHeight 80  /tmp/brand-logo-src.png --out public/brand-logo.png
sips --resampleHeight 160 /tmp/brand-logo-src.png --out public/brand-logo@2x.png
```

- [ ] **Step 3: 验证尺寸与体积**

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers/apps/admin
ls -l public/brand-logo.png public/brand-logo@2x.png
sips -g pixelWidth -g pixelHeight public/brand-logo.png public/brand-logo@2x.png
```

Expected: 两文件均存在；`brand-logo.png` 高 80、`brand-logo@2x.png` 高 160；两者合计远小于源图 776 KB（预期各 10–40 KB）。若任一文件大于 100 KB，说明 sips 没压住，改用 `sips -s format png -s formatOptions 70` 重出。

- [ ] **Step 4: 确认透明通道没丢**

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers/apps/admin
sips -g hasAlpha public/brand-logo.png
```

Expected: `hasAlpha: yes`。印章是不规则外形，丢了 alpha 会在白底顶栏上出现黑框。

- [ ] **Step 5: Commit**

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers
git add apps/admin/public/brand-logo.png apps/admin/public/brand-logo@2x.png
git commit -m "feat(admin): 加入顶栏印章 Logo 的 1x/2x 资源"
```

---

### Task 2: navigation.ts 扩展为顶部导航数据源

**Files:**
- Modify: `apps/admin/src/navigation.ts`
- Modify: `apps/admin/src/navigation.test.ts`

**Interfaces:**
- Produces: `NavItem { to: string; prefix: string; label: string }`
- Produces: `topNavigation: NavItem[]`（9 项，顺序即顶栏顺序，第 0 项是 `/workbench`）
- Produces: `activeNavLabel(pathname: string): string`
- Produces: `centerTabs` 新增 `promotion`、`system` 两个键
- Produces: `legacyRoutes` 新增 `/banners`、`/scan-stats`、`/printer-settings` 三条
- Consumes: Task 3 用 `centerTabs.promotion` / `centerTabs.system`；Task 4、5 用 `topNavigation` 与 `activeNavLabel`

- [ ] **Step 1: 写失败的测试**

把下面 4 个 `test(...)` 追加到 `apps/admin/src/navigation.test.ts` 末尾，并把文件第 3 行的 import 改成：

```ts
import { activeNavLabel, centerTabs, isChannel, legacyTarget, readChannel, topNavigation } from './navigation.ts'
```

```ts
test('lists all nine top-level entries in navigation order', () => {
  assert.deepEqual(topNavigation.map((item) => item.label), [
    '接单工作台', '经营概览', '商品管理', '订单管理',
    '会员营销', '店铺设置', '用户管理', '推广运营', '系统维护',
  ])
})

test('defines the child tabs for the two newly merged centers', () => {
  assert.deepEqual(centerTabs.promotion.map((tab) => tab.to), [
    '/promotion/banners', '/promotion/scan-stats',
  ])
  assert.deepEqual(centerTabs.system.map((tab) => tab.to), [
    '/system/printer', '/system/status',
  ])
})

test('redirects the four routes absorbed by the new centers', () => {
  assert.equal(legacyTarget('/banners', '').pathname, '/promotion/banners')
  assert.equal(legacyTarget('/scan-stats', '').pathname, '/promotion/scan-stats')
  assert.equal(legacyTarget('/printer-settings', '').pathname, '/system/printer')
})

test('names the active entry from any of its child routes', () => {
  assert.equal(activeNavLabel('/promotion/scan-stats'), '推广运营')
  assert.equal(activeNavLabel('/system/status'), '系统维护')
  assert.equal(activeNavLabel('/orders/express?ignored'), '订单管理')
  assert.equal(activeNavLabel('/unknown'), '经营概览')
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers/apps/admin
npm test
```

Expected: FAIL —— `topNavigation` 与 `activeNavLabel` 尚未导出，报 `SyntaxError: The requested module './navigation.ts' does not provide an export named 'activeNavLabel'`。

- [ ] **Step 3: 写最小实现**

在 `apps/admin/src/navigation.ts` 的 `CenterTab` 接口之后插入：

```ts
export interface NavItem {
  /** 点击后去的实际地址（中心项指向其默认子页） */
  to: string
  /** 判定高亮用的路径前缀，一个中心的所有子页共用一个前缀 */
  prefix: string
  label: string
}

/**
 * 顶栏一级导航，数组顺序即渲染顺序。
 * 第 0 项 /workbench 是唯一实色强调项，由 Layout 单独取样式，不要靠位置隐式约定。
 */
export const topNavigation: NavItem[] = [
  { to: '/workbench', prefix: '/workbench', label: '接单工作台' },
  { to: '/dashboard', prefix: '/dashboard', label: '经营概览' },
  { to: '/catalog/products', prefix: '/catalog', label: '商品管理' },
  { to: '/orders/local', prefix: '/orders', label: '订单管理' },
  { to: '/membership/coupons', prefix: '/membership', label: '会员营销' },
  { to: '/settings/express', prefix: '/settings', label: '店铺设置' },
  { to: '/users', prefix: '/users', label: '用户管理' },
  { to: '/promotion/banners', prefix: '/promotion', label: '推广运营' },
  { to: '/system/printer', prefix: '/system', label: '系统维护' },
]

/** 窄屏顶栏要显示当前所在的一级入口名；认不出时退回「经营概览」，与根路由的落点一致 */
export const activeNavLabel = (pathname: string) =>
  topNavigation.find((item) => pathname.startsWith(item.prefix))?.label ?? '经营概览'
```

把 `centerTabs` 的类型与内容改成：

```ts
export const centerTabs: Record<
  'catalog' | 'orders' | 'membership' | 'settings' | 'promotion' | 'system',
  CenterTab[]
> = {
  catalog: [
    { to: '/catalog/products', label: '商品列表' },
    { to: '/catalog/categories', label: '分类管理' },
  ],
  orders: [
    { to: '/orders/local', label: '同城配送' },
    { to: '/orders/express', label: '全国邮寄' },
  ],
  membership: [
    { to: '/membership/coupons', label: '优惠券' },
    { to: '/membership/points-goods', label: '积分赠品' },
    { to: '/membership/settings', label: '会员设置' },
  ],
  settings: [
    { to: '/settings/express', label: '全国邮寄设置' },
    { to: '/settings/local', label: '同城配送设置' },
  ],
  promotion: [
    { to: '/promotion/banners', label: '轮播图' },
    { to: '/promotion/scan-stats', label: '扫码统计' },
  ],
  system: [
    { to: '/system/printer', label: '打印机' },
    { to: '/system/status', label: '系统状态' },
  ],
}
```

在 `legacyRoutes` 对象里追加三条（`/system` 不放这里——它已变成中心根，由 App.tsx 的 index 路由重定向）：

```ts
  '/banners': '/promotion/banners',
  '/scan-stats': '/promotion/scan-stats',
  '/printer-settings': '/system/printer',
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers/apps/admin
npm test
```

Expected: PASS，`pass 9`（原 5 条 + 新 4 条），`fail 0`。

- [ ] **Step 5: Commit**

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers
git add apps/admin/src/navigation.ts apps/admin/src/navigation.test.ts
git commit -m "feat(admin): navigation 扩展出顶部导航项与两个新中心"
```

---

### Task 3: 推广运营 / 系统维护两个中心与路由

**Files:**
- Create: `apps/admin/src/pages/PromotionCenter.tsx`
- Create: `apps/admin/src/pages/SystemCenter.tsx`
- Modify: `apps/admin/src/App.tsx`
- Modify: `apps/admin/src/pages/Banners.tsx:149`
- Modify: `apps/admin/src/pages/ScanStats.tsx:95`
- Modify: `apps/admin/src/pages/PrinterSettings.tsx:104,255`
- Modify: `apps/admin/src/pages/SystemStatus.tsx:201`

**Interfaces:**
- Consumes: Task 2 的 `centerTabs.promotion`、`centerTabs.system`、`legacyTarget`
- Produces: 路由 `/promotion/banners`、`/promotion/scan-stats`、`/system/printer`、`/system/status`，供 Task 4 的 `topNavigation` 落点使用

- [ ] **Step 1: 建两个中心外壳**

`apps/admin/src/pages/PromotionCenter.tsx`：

```tsx
import BusinessCenter from '../components/BusinessCenter'
import { centerTabs } from '../navigation'

export default function PromotionCenter() {
  return (
    <BusinessCenter
      title="推广运营"
      description="轮播图是顾客打开小程序第一眼的门面，扫码统计是包装二维码带来的复购数据。"
      tabs={centerTabs.promotion}
    />
  )
}
```

`apps/admin/src/pages/SystemCenter.tsx`：

```tsx
import BusinessCenter from '../components/BusinessCenter'
import { centerTabs } from '../navigation'

export default function SystemCenter() {
  return (
    <BusinessCenter
      title="系统维护"
      description="小票没出先看打印机在不在线，再看系统状态里的服务端配置。"
      tabs={centerTabs.system}
    />
  )
}
```

- [ ] **Step 2: 接进路由**

在 `apps/admin/src/App.tsx` 的 import 区加：

```tsx
import PromotionCenter from './pages/PromotionCenter'
import SystemCenter from './pages/SystemCenter'
```

把现有这四行：

```tsx
          <Route path="scan-stats" element={<ScanStats />} />
          <Route path="banners" element={<Banners />} />
          <Route path="printer-settings" element={<PrinterSettings />} />
          <Route path="system" element={<SystemStatus />} />
```

替换为：

```tsx
          <Route path="promotion" element={<PromotionCenter />}>
            <Route index element={<Navigate to="banners" replace />} />
            <Route path="banners" element={<Banners />} />
            <Route path="scan-stats" element={<ScanStats />} />
          </Route>
          {/* 打印机放默认子页：店员点进「系统维护」几乎总是为了打印机，不是看系统状态 */}
          <Route path="system" element={<SystemCenter />}>
            <Route index element={<Navigate to="printer" replace />} />
            <Route path="printer" element={<PrinterSettings />} />
            <Route path="status" element={<SystemStatus />} />
          </Route>
          <Route path="banners" element={<LegacyRedirect />} />
          <Route path="scan-stats" element={<LegacyRedirect />} />
          <Route path="printer-settings" element={<LegacyRedirect />} />
```

- [ ] **Step 3: 去掉四个子页自带的页面标题**

中心外壳已经渲染标题，子页再画一个 `<h2>` 会出现两层同义标题。逐个删掉整行：

`Banners.tsx:149` 删 `        <h2 className="text-xl font-semibold text-gray-800">轮播管理</h2>`

`ScanStats.tsx:95` 删 `      <h2 className="text-xl font-semibold text-gray-800">扫码统计</h2>`

`SystemStatus.tsx:201` 删 `        <h2 className="text-xl font-semibold text-gray-800">系统状态</h2>`

`PrinterSettings.tsx` 有两处（加载态与正常态），都要删：
- 第 104 行 `        <h2 className="text-xl font-semibold text-gray-800">打印机设置</h2>`
- 第 255 行 `        <h2 className="text-xl font-semibold text-gray-800 flex items-center gap-1.5"><Printer className="w-5 h-5" />打印机设置</h2>`

删完检查 `PrinterSettings.tsx` 的 `Printer` 图标是否还有别处引用；若没有，一并从 import 里删掉，否则 `tsc` 会因 `noUnusedLocals` 报错。

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers/apps/admin
grep -n "Printer" src/pages/PrinterSettings.tsx | head
```

- [ ] **Step 4: 类型检查与构建**

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers/apps/admin
npx tsc --noEmit && npm test
```

Expected: tsc 无输出（零错误）；`npm test` 仍 `pass 9 / fail 0`。

- [ ] **Step 5: Commit**

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers
git add apps/admin/src/App.tsx apps/admin/src/pages/PromotionCenter.tsx apps/admin/src/pages/SystemCenter.tsx apps/admin/src/pages/Banners.tsx apps/admin/src/pages/ScanStats.tsx apps/admin/src/pages/PrinterSettings.tsx apps/admin/src/pages/SystemStatus.tsx
git commit -m "feat(admin): 轮播+扫码并为推广运营，打印机+系统状态并为系统维护"
```

---

### Task 4: Layout 改为顶部导航（三档响应式）

桌面两档和窄屏九宫格必须一起交付：只做桌面档会留下「窄屏完全没有导航」的半成品，
评审无法只通过其中一半。

**Files:**
- Modify: `apps/admin/tailwind.config.js`
- Modify: `apps/admin/src/components/Layout.tsx`（整文件替换）

**Interfaces:**
- Consumes: Task 1 的 `/brand-logo.png`、`/brand-logo@2x.png`；Task 2 的 `topNavigation`、`activeNavLabel`
- Produces: 顶栏 `Layout`，`main` 区继续用 `<Outlet />` 挂各中心

- [ ] **Step 1: 加 1100px 断点**

`apps/admin/tailwind.config.js` 的 `theme.extend` 里加：

```js
      // 9 项文字导航 + Logo + 右侧铃铛/退出，低于 1100px 就放不下图标了
      screens: {
        nav: '1100px',
      },
```

- [ ] **Step 2: 整文件替换 Layout.tsx**

```tsx
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
      <header className="relative z-30 flex h-14 shrink-0 items-center gap-3 border-b border-gray-100 bg-white px-3 shadow-sm md:px-4 nav:px-6">
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

        {/* ≥768px：单行 9 项。<nav(1100px) 去掉图标只留文字，保证不换行也不横滚 */}
        <nav aria-label="主导航" className="hidden min-w-0 flex-1 items-center gap-1 md:flex">
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
                className={`relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm transition-colors nav:px-3 ${
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

        {/* <768px：顶栏只留当前页名 + 箭头，点开九宫格（规格 §4.3） */}
        <button
          onClick={() => setPanelOpen((v) => !v)}
          aria-expanded={panelOpen}
          aria-controls="nav-panel"
          className="ml-1 inline-flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 md:hidden"
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
            <span className="hidden sm:inline">退出登录</span>
          </button>
        </div>
      </header>

      {panelOpen && (
        <div
          className="fixed inset-0 top-14 z-20 bg-black/40 md:hidden"
          onClick={() => setPanelOpen(false)}
        />
      )}
      {/* 用 hidden 属性而非条件渲染：aria-controls 指向的元素必须始终在 DOM 里 */}
      <div
        id="nav-panel"
        hidden={!panelOpen}
        className="absolute inset-x-0 top-14 z-30 border-b border-gray-100 bg-white p-3 shadow-lg md:hidden"
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
```

原顶栏里的「欢迎，{admin?.username}」本轮删除——顶栏要放 9 个入口，没有位置。
因此 `useAuthStore()` 只解构 `clearAuth`；若仍解构 `admin` 会触发 `noUnusedLocals` 报错。

- [ ] **Step 3: 类型检查、测试与构建**

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers/apps/admin
npx tsc --noEmit && npm test && npm run build
```

Expected: tsc 零输出；`pass 9 / fail 0`；`vite build` 输出 `✓ built in ...`。

- [ ] **Step 4: 桌面两档验证**

预览在 `http://localhost:5192`（后端 3106）。在 1280px 与 900px 各看一次：
- 1280px：一行 9 项，每项带图标。
- 900px：一行 9 项，无图标只有文字。

两档都在控制台跑这段验「不横滚」的硬约束：

```js
const nav = document.querySelector('nav[aria-label="主导航"]')
;({ scrollW: nav.scrollWidth, clientW: nav.clientWidth, overflow: nav.scrollWidth > nav.clientWidth })
```

Expected: `overflow: false`。若为 true，先把 `nav:px-3` 降到 `nav:px-2.5`，再把 `gap-1` 降到 `gap-0.5`，每改一次重测。

- [ ] **Step 5: 375px 验证**

视口设 375×812，逐条核对：
1. 顶栏是 Logo + 当前页名 + ⌄ + 铃铛 + 退出图标，一行放得下不换行。
2. 点页名展开 3 列 × 3 行九宫格，9 项全可见，不需要滚动。
3. 点「推广运营」跳到 `/promotion/banners` 并自动收起，顶栏页名变为「推广运营」。
4. 再展开后点遮罩，面板收起且没有跳转。
5. 面板展开时下滑，背景列表不动。
6. 「接单工作台」与「订单管理」两格的徽标数字不同。

```js
document.querySelector('#nav-panel').querySelectorAll('a').length
```

Expected: `9`

- [ ] **Step 6: Commit**

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers
git add apps/admin/tailwind.config.js apps/admin/src/components/Layout.tsx
git commit -m "feat(admin): 侧栏改顶部三档响应式导航，去品牌文字只留 Logo，拆开两处徽标"
```

---

### Task 5: 全量回归

**Files:**
- Modify: `docs/superpowers/specs/2026-09-07-admin-business-centers-design.md:5`
- 其余无代码改动；出问题回到对应任务修

- [ ] **Step 1: 自动检查全绿**

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers/apps/admin
npm test && npx tsc --noEmit && npm run build
```

Expected: `pass 9 / fail 0`；tsc 零输出；`vite build` 成功。

- [ ] **Step 2: 旧地址重定向回归**

在预览页控制台跑（第一轮 9 条 + 本轮 3 条 + `/system` 中心根）：

```js
const cases=['/products','/categories','/orders','/local/orders','/coupons','/points-goods','/member-settings','/shop-settings','/local/settings','/banners','/scan-stats','/printer-settings','/system'];
const out=[];
for(const p of cases){history.pushState({},'',p+'?status=PAID');window.dispatchEvent(new PopStateEvent('popstate'));await new Promise(r=>setTimeout(r,150));out.push(p+' -> '+location.pathname+location.search)}
out
```

Expected：前 9 条与改造前一致；另外四条为
`/banners -> /promotion/banners?status=PAID`、
`/scan-stats -> /promotion/scan-stats?status=PAID`、
`/printer-settings -> /system/printer?status=PAID`、
`/system -> /system/printer?status=PAID`。

- [ ] **Step 3: 六个中心逐页目验**

依次打开，确认页面标题只出现一次（中心页头），子页内容与改造前一致：
`/catalog/products`、`/catalog/categories`、`/orders/local`、`/orders/express`、
`/membership/coupons`、`/membership/points-goods`、`/membership/settings`、
`/settings/express`、`/settings/local`、`/promotion/banners`、`/promotion/scan-stats`、
`/system/printer`、`/system/status`、`/dashboard`、`/users`。

- [ ] **Step 4: 未保存拦截仍生效**

进 `/settings/local`，改任一输入框，然后点顶栏「商品管理」。

Expected: 弹出「放弃未保存的修改？」；点取消留在原页，点「放弃并切换」才跳走。
375px 下从九宫格里点「商品管理」要有同样行为，且确认后面板收起。

- [ ] **Step 5: 控制台零报错**

在 `/dashboard` 刷新页面后，用 `read_console_messages` 且 `onlyErrors: true` 读取。

Expected: 无任何 error 级别输出。特别注意不能出现 `brand-logo@2x.png 404`
——`srcSet` 里的 2x 资源缺失在 1x 屏上不会报错，必须在 2x 屏或强制 devicePixelRatio 下确认：

```js
;[...document.querySelectorAll('img')].map((i) => ({ src: i.currentSrc, ok: i.naturalWidth > 0 }))
```

Expected: Logo 那项 `ok: true`。

- [ ] **Step 6: 工作台未受影响**

打开 `/workbench`，确认仍是全屏五列看板、顶栏不出现在其上方、日夜切换与全屏按钮可用。

- [ ] **Step 7: 更新规格状态并提交**

把规格文件第 5 行 `状态：方案已口头确认，等待文档复核` 改为 `状态：第二轮已实现，等待店主验收`。

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/codex-admin-business-centers
git add docs/superpowers/specs/2026-09-07-admin-business-centers-design.md
git commit -m "docs(admin): 标记顶部导航改造已实现待验收"
```

---

## 非目标

- 不改小程序顾客端页面与 `apps/miniapp/assets/brand/logo-standard.png`。
- 不改服务端接口、业务规则、数据库。
- 不重做接单工作台的手机形态（横滑五列保持现状，另轮处理）。
- 不补 `BusinessCenter` / `MemberSettings` 的未保存拦截缺口（已知遗留，另轮处理）。
- 不部署，不动生产环境变量与域名。
