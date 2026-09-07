# 单行顶部导航改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将后台左侧栏替换为仅一行的顶部主导航，并将低频入口归入分组“更多”菜单。

**Architecture:** `navigation.ts` 作为主导航和更多菜单的纯数据来源，使路由选择可用 Node 内置测试验证。`Layout.tsx` 消费这些数据渲染固定顶部栏、页面级更多弹层和现有未保存设置保护；业务中心的页面内标签和既有路由保持不变。

**Tech Stack:** React 18、React Router 6、TypeScript、Tailwind CSS、Lucide React、Node 内置测试运行器。

**Spec:** `docs/superpowers/specs/2026-09-07-admin-business-centers-design.md`

## Global Constraints

- 只改 `apps/admin` 前端和设计/计划文档；不修改 API、数据库、业务状态机或部署配置。
- 保持 `/workbench` 独立全屏路由和现有旧地址重定向。
- 顶部只保留一行；业务中心内的分类页签继续显示在内容区，而非全局第二行导航。
- 使用用户提供的 Logo，导航中不展示品牌名称。
- 窄屏不得出现全局导航横向滚动；低优先级入口通过“更多”可达。

---

### Task 1: 定义可测试的顶部导航信息架构

**Files:**
- Modify: `apps/admin/src/navigation.ts`
- Modify: `apps/admin/src/navigation.test.ts`

**Interfaces:**
- Produces: `topNavigation`，包含 `workbench`、`dashboard`、`orders`、`catalog` 四个高频入口。
- Produces: `moreNavigationSections`，包含 `会员营销`、`店铺设置`、`后台工具` 三个分组及其目标路由。
- Consumes: `Layout.tsx` 通过 `to`、`prefix`、`label` 渲染按钮和活动状态，并在布局内将路由映射为图标。

- [ ] **Step 1: Write the failing test**

在 `navigation.test.ts` 中导入 `moreNavigationSections` 与 `topNavigation`，新增以下两项测试：

```ts
test('keeps only high-frequency entry points in the single top row', () => {
  assert.deepEqual(topNavigation.map((item) => item.to), [
    '/workbench', '/dashboard', '/orders/local', '/catalog/products',
  ])
})

test('groups every low-frequency route under More', () => {
  assert.deepEqual(moreNavigationSections.map((section) => section.label), [
    '会员营销', '店铺设置', '后台工具',
  ])
  assert.deepEqual(moreNavigationSections[0].items.map((item) => item.to), [
    '/membership/settings', '/membership/coupons', '/membership/points-goods',
  ])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`

Expected: FAIL because `topNavigation` and `moreNavigationSections` are not exported.

- [ ] **Step 3: Write minimal implementation**

在 `navigation.ts` 中新增 `NavigationItem` 与 `NavigationSection` 接口；导出四个高频入口和三个分组。每个项目携带实际路由、路径前缀和中文标签；会员设置作为会员营销分组第一个项目。Lucide 图标继续只在 `Layout.tsx` 中引用，保持数据模块可由 Node 测试直接加载。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`

Expected: PASS，原有路由与渠道测试也全部通过。

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/navigation.ts apps/admin/src/navigation.test.ts
git commit -m "feat(admin): define top navigation groups"
```

### Task 2: 以顶部栏替换左侧栏

**Files:**
- Modify: `apps/admin/src/components/Layout.tsx`
- Create: `apps/admin/public/brand-logo.png`

**Interfaces:**
- Consumes: `topNavigation`、`moreNavigationSections`、`useUnsavedSettings()`、`usePendingOrders()`。
- Produces: 一行 `header` 主导航、可访问的“更多”菜单以及原有 `<Outlet />` 内容区。

- [ ] **Step 1: Preserve the failing contract**

保留 Task 1 的导航测试作为 Layout 数据契约。手动验证目标：删除侧栏容器后，`/orders/local` 仍能显示订单页，`/catalog/products` 仍能显示商品页，`/membership/settings` 可从更多菜单进入。

- [ ] **Step 2: Implement the top-level layout**

删除 `aside`、抽屉遮罩、`sidebarOpen` 和移动菜单按钮。将 `Layout` 根节点改为纵向容器，顶部 `header` 由左至右渲染：

```tsx
<NavLink to="/dashboard" aria-label="经营概览" className="shrink-0">
  <img src="/brand-logo.png" alt="阿福凉菜" className="h-8 w-8 rounded-md object-contain" />
</NavLink>
<nav aria-label="主导航" className="flex min-w-0 items-center gap-1">
  {/* topNavigation */}
  {/* 更多按钮与菜单 */}
</nav>
```

接单工作台保留聚合待处理徽标；订单管理保留同一聚合徽标。活动状态继续使用 `location.pathname.startsWith(item.prefix)`。在可用宽度不足时，所有主导航按钮隐藏文字但保留图标、`title` 与 `aria-label`；不出现横向滚动，Logo、接单工作台、经营概览、订单管理、商品管理和“更多”始终可见。

- [ ] **Step 3: Implement More menu and leave protection**

使用 `moreOpen` 状态控制一个绝对定位的下拉面板。按钮具有 `aria-expanded={moreOpen}` 与 `aria-controls="more-navigation"`；菜单按 `moreNavigationSections` 显示标题和链接。把 `handleNavigation` 改为关闭菜单后再导航；存在未保存设置时，继续先调用 `confirmLeave()`，确认后才关闭菜单并跳转。

- [ ] **Step 4: Add the supplied logo asset**

将用户提供的 `/Users/yumingyi/Desktop/阿福凉菜/six-logos-hd/image.png` 复制为 `apps/admin/public/brand-logo.png`。不裁剪、不改色；浏览器以 32px 等比显示，避免将图片中文字作为顶部品牌文案。

- [ ] **Step 5: Run focused verification**

Run: `npm test && npm run build`

Expected: 所有导航测试通过，TypeScript 与 Vite 构建成功。

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/components/Layout.tsx apps/admin/public/brand-logo.png
git commit -m "feat(admin): replace sidebar with top navigation"
```

### Task 3: 验收单行导航

**Files:**
- Modify: `docs/superpowers/specs/2026-09-07-admin-business-centers-design.md`
- Modify: `docs/superpowers/plans/2026-09-07-admin-top-navigation.md`

- [ ] **Step 1: Verify source hygiene**

Run: `git diff --check && git status --short`

Expected: 无空白错误；只包含本次顶部导航、Logo 与文档改动。

- [ ] **Step 2: Verify in the existing local preview**

打开 `http://127.0.0.1:4173/dashboard`，确认：没有左侧栏；主导航仅一行；Logo 无文字；“更多”中能找到会员营销、店铺设置和后台工具；订单和商品页面仍在内容区显示其分类标签。

- [ ] **Step 3: Commit documentation**

```bash
git add docs/superpowers/specs/2026-09-07-admin-business-centers-design.md docs/superpowers/plans/2026-09-07-admin-top-navigation.md
git commit -m "docs(admin): record top navigation design"
```
