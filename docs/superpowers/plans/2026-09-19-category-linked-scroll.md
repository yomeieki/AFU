# 分类页整页联动滚动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分类页先随手势收起店铺头，再浏览商品，同时让末尾分类和商品完整避开购物栏。

**Architecture:** 原生页面承载头部与右侧商品滚动，模式/搜索工具栏吸顶，左侧 scroll-view 独立滚动。文档坐标统一定位和高亮；实测购物栏高度用于侧栏可视范围与页面末尾留白。

**Tech Stack:** 微信小程序 WebView/WXML/WXSS/CommonJS、Node node:test、现有 HTML 预览服务、微信原生模板/样式编译器。

**Spec:** `docs/superpowers/specs/2026-09-19-category-linked-scroll-design.md`

## Global Constraints

- 只修改分类页、分类滚动专用工具/测试、预览镜像、该任务文档；不修改服务端、管理后台、支付、运费、满减计算或共享购物栏行为。
- 同城免运费继续使用现有后台动态配置，任何布局改动不得硬编码门槛。
- 保持 WebView 渲染及原生 tabBar；不引入 Skyline、新运行依赖或 npm install。
- 新增小程序逻辑文件为 ES5/CommonJS；既有文件新增逻辑使用 var/function，避免扩大语法兼容范围。
- 购物栏高度以 height 事件的实测整体值为准；为 0 时完整恢复空间；不硬编码设备高度、安全区或 tabBar 高度。
- 旧测试可随明确改变的滚动契约更新，必须用新的行为断言替代，不能删测试或跳过失败；与本次无关的计价/渠道测试保持语义。
- 浏览器镜像只能证明布局与模拟交互；微信真机惯性、原生 tabBar、安全区及触摸体验必须如实列为真机验收，不能用镜像通过代替。

## Review Focus

1. 购物栏从 0 到有高度/提示增减，左右底部同时变化且没有双重留白 —— Task 1 几何与页面事件测试，Task 2 浏览器覆盖。
2. 页面下滑到末分类后回到顶部，头部只在商品回顶后露出，短分组也能定位 —— Task 1 文档坐标测试，Task 2 滚动截图。
3. 旧测量回调在隐藏、切渠道后返回，不应重写新布局 —— Task 1 延迟 selector 回调行为测试。
4. 类别很多且用户手动滚左栏，自动跟随只拉回屏外目标，搜索清空恢复分类 —— Task 1 侧栏与搜索测试，Task 2 多分类镜像。
5. 320 宽、小视口、长通知或多行工具栏不应产生负高度或内容被固定栏挡住 —— Task 1 边界值测试，Task 2 尺寸矩阵。

## 分工与执行顺序

- 统筹/规划：GPT-6 (Codex)，负责任务拆分、接口裁定、证据与交付。
- 方案预审：独立 GPT-6 Agent，检查 WebView 技术可行性、坐标和遮挡边界，完成后进入执行。
- Task 1：GPT-5.6-Sol Agent，代码、测试与自检；独立 GPT-6 Agent 做任务规格/质量审核。
- Task 2：新的 GPT-5.6-Sol Agent，预览和验证；独立 GPT-5.6-Sol Agent 做任务审核。
- 全分支终审：新的 GPT-6 Agent，检查最终用户流程与跨任务遗漏。
- 每个执行 Agent 不再自行派生 Agent，所有评审由统筹分派；修复回原执行 Agent，再交审核。
- 本次执行在 `/Users/yumingyi/food-shop/.claude/worktrees/category-scroll`，分支 `codex/category-scroll`，基线 `c41ec3a`；主仓原有未跟踪文件保持完整。
- 用户已明确要求规划后交 Agent 执行与审核，此授权覆盖本计划的连续推进。完成后保留可审阅分支；不自动发布或替用户完成真机验收。

### Task 1: 分类页原生滚动、动态避让与行为测试

**Files:**
- Create: `apps/miniapp/utils/category-scroll.js`
- Modify: `apps/miniapp/pages/product/list.js`, `list.wxml`, `list.wxss`（必要时 `list.json`）
- Create: `tests/miniapp/category-scroll.test.cjs`
- Modify: `tests/miniapp/category-anchor-page.test.cjs`, `tests/miniapp/cart-bar-page.test.cjs`（只替换旧滚动/占位契约断言）

**Interfaces:**
- Consumes: 既有 `onCartHeight(e.detail.px)`、`catalogGroups.activeGroupOf(offsets, scrollTop, tolerance)`、`groups[{id,name,items}]`、`afterGroupsRendered()` 生命周期。
- Produces: `category-scroll.js` 导出 `layoutOf({viewportHeight,pinnedHeight,bodyTop,scrollTop,dockHeight,lastGroupHeight})` 返回 `{sidebarTop,sidebarHeight,tailHeight}`；`pageTarget(groupTop,pinnedHeight)`；`revealScrollTop({itemTop,itemHeight,scrollTop,viewportHeight})`。
- 页面 `onPageScroll({scrollTop})` 更新当前页面滚动、高亮、侧栏可视范围；`onReachBottom()` 触发现有搜索分页；`onResize()` 重量。原右侧 `scroll-view` 改为普通容器，所有定位迁移 `wx.pageScrollTo`。

- [ ] **Step 1: 先写纯几何与真实页面事件的失败测试。**

```js
const {layoutOf,pageTarget,revealScrollTop} = require('../../apps/miniapp/utils/category-scroll')
assert.deepEqual(layoutOf({viewportHeight:720,pinnedHeight:40,bodyTop:240,scrollTop:0,dockHeight:72,lastGroupHeight:120}), {sidebarTop:240,sidebarHeight:408,tailHeight:488})
assert.deepEqual(layoutOf({viewportHeight:720,pinnedHeight:40,bodyTop:240,scrollTop:300,dockHeight:72,lastGroupHeight:120}), {sidebarTop:40,sidebarHeight:608,tailHeight:488})
assert.equal(pageTarget(900,40),860)
assert.equal(revealScrollTop({itemTop:450,itemHeight:50,scrollTop:0,viewportHeight:400}),100)
assert.equal(revealScrollTop({itemTop:100,itemHeight:50,scrollTop:80,viewportHeight:400}),80)
```

补充负滚动按 0、缺失/非有限值按 0、dock 为 0 恢复空间、视口小于顶部+D 高度钳制 0。页面测试使用现有 `loadPage/makeCtx`，让 selector mock 按选择器返回相应矩形而非固定三项旧数组；记录 `wx.pageScrollTo` 调用。验证点击分组两次、首页 pendingCategoryId、搜索结果分页与清空、测量请求先后乱序、hide/unload、resize、cart height 改变、收起后异步头部变高/变矮时保持商品相对工具栏位置、搜索首批不足一屏自动补足。保留旧分类数据、购物车与优惠测试含义。

- [ ] **Step 2: 运行定向测试确认新行为失败。**

```sh
node --test tests/miniapp/category-scroll.test.cjs tests/miniapp/category-anchor-page.test.cjs tests/miniapp/cart-bar-page.test.cjs
```

- [ ] **Step 3: 实现纯函数和页面结构。**

纯函数的计算骨架（输入归一化在模块内统一处理）：
```js
var top = Math.max(pinnedHeight, bodyTop - Math.max(0, scrollTop))
return {sidebarTop: top, sidebarHeight: Math.max(0, viewportHeight - dockHeight - top), tailHeight: Math.max(0, viewportHeight - pinnedHeight - dockHeight - lastGroupHeight)}
// pageTarget: Math.max(0, groupTop - pinnedHeight)
// revealScrollTop: itemTop < scrollTop ? itemTop :
//   itemTop + itemHeight > scrollTop + viewportHeight ?
//     Math.max(0, itemTop + itemHeight - viewportHeight) : scrollTop
```

WXML 删除右侧内部滚动状态绑定，移除旧分组/搜索各自的 cart-spacer，留一份页面级占位和一份尾组补白（当前 cart-dock 已全宽不透明，不额外添加遮罩）。创建可测量 `.catalog-toolbar`、`.catalog-body`、`.cat-panel`、`.group-anchor`，给分类项带前缀 id。保留商品行 template、`catchtap` 加购、组件绑定。CSS `.page` 改为自然高度，`.catalog-toolbar` `position:sticky;top:0`；右侧内容自然撑高页面；左侧以专用容器正确设置 sticky/fixed + 动态高度且不遮盖工具栏。沿用当前全宽不透明 cart-dock 作底部视觉边界，保持购物栏层级与点击行为。

- [ ] **Step 4: 接入测量与滚动状态。**

```js
// 同一 selector query 中 selectViewport().scrollOffset() 配合布局节点测量。
// 每次测量捕获 generation；隐藏/切渠道/新测量使旧 generation 失效。
// groupTop = rect.top + viewport.scrollTop
// 点击分类：wx.pageScrollTo({scrollTop: pageTarget(groupTop, pinnedHeight), duration: 300})
// onPageScroll：保存 Y，header 区间仅更新必要布局数字，100ms 尾随高亮。
// 500ms 点击锁保留；相同目标仍调用 pageScrollTo；pending 定位等布局有效再执行。
// onReachBottom：this.onScrollToLower()；onResize/onShow/cart/meta：afterGroupsRendered。
```

禁止每个滚动事件都 query 全部商品或 setData groups。侧栏 `bindscroll` 记位置；需要揭示目标时才设置 `scroll-top`，同值再次需要滚动时保证触发。数据重载与切渠道取消旧定位、计时器和选择器回调。普通 onShow 保持位置；收起后头部高度变化通过布局前后 body 文档坐标差补偿 page scroll；补偿与测量不得形成循环。搜索短批次 hasMore 且可视区不足时继续取下一页，保留 loading/request key 防重复与串数据。右侧标题可使用每组 sticky 标题；锚点定位不得被固定栏遮住标题。

- [ ] **Step 5: 验证并提交。**

```sh
npm run -s test:miniapp
node scripts/check-miniapp-es5.mjs apps/miniapp/utils/category-scroll.js
git diff --check
git add apps/miniapp/utils/category-scroll.js apps/miniapp/pages/product tests/miniapp/category-scroll.test.cjs tests/miniapp/category-anchor-page.test.cjs tests/miniapp/cart-bar-page.test.cjs
git commit -m "优化分类页整页滚动与购物栏避让"
```

报告包含红绿测试日志路径、最终命令结果、坐标策略、主动验证过的边界和真机待验项。由统筹生成 diff 包交独立 Agent，修复全部阻断问题后 Task 2 才开始。

### Task 2: 交互预览、尺寸验证与验收记录

**Files:**
- Modify: `tools/miniapp-preview/pages/product-list.html`, `tools/miniapp-preview/serve.mjs`, `tools/miniapp-preview/README.md`
- Create if needed: `tools/miniapp-preview/pages/product-list-local.html`、共享的分类预览脚本（不要复制计价或后台逻辑）。
- Create: `docs/superpowers/reviews/2026-09-19-category-linked-scroll-verification.md`

**Interfaces:**
- Consumes: Task 1 最终 WXML/CSS 布局、`category-scroll.js` 几何契约；预览使用真实生成 CSS。
- Produces: 可打开的同城/邮寄交互镜像、截图与机器可读几何测量、实际原生编译输出、真机步骤。

- [ ] **Step 1: 同步镜像与确定性样例。**

原 `/pages/product-list.html` 保留邮寄场景，新增同城路径展示店铺、长营业提示、满减、外送/自取栏。至少 10 个分类、末尾“酒水/饮料”、末分类一个商品，使用脚本创建确定性重复商品。响应式宽度设 `width=device-width`，rpx 跟随视口；购物栏含优惠提示并可切换空车。绑定分类点击、页面滚动高亮、左侧自动揭示、模式切换、邮寄搜索/清空及底部加载示例。

```js
// 浏览器桥接只模拟 wx 页面布局交互；业务/支付不请求真实 API。
// group rect 文档坐标 = element.getBoundingClientRect().top + window.scrollY
// 点击使用 window.scrollTo({top: target, behavior: 'smooth'})
// 独立侧栏使用 overflow-y:auto；其余页面自然滚动。
```

- [ ] **Step 2: 浏览器验证并留证。**

使用现有 Playwright/Chrome 运行临时脚本，预览服务选择空闲端口（5181 优先），不停止用户已有 5180 服务。每个宽度 320/375/430、高度至少 640/812，检查初始/收起/末分类/恢复头部、空车与有车。以 DOM 矩形证明：`sidebar.bottom <= dock.top + 1`、末分类滚入后完整可见、末商品加购按钮高于 dock.top、工具栏收起后 top≈0、无水平溢出。截图命名标识尺寸、渠道、状态。结果写可持久证据目录，文档标注浏览器模拟。

- [ ] **Step 3: 编译与完整测试。**

```sh
npm run -s test:miniapp
node scripts/check-miniapp-es5.mjs apps/miniapp/utils/category-scroll.js
git diff --check
```

使用已安装微信开发者工具原生 `wcc`/`wcsc` 编译本次页面及引用组件，记录命令与退出码。不更改线上 API 配置，不上传体验版。若无法取得运行时真机，如实记录为待验而非通过。

- [ ] **Step 4: 记录审核证据并提交。**

验收文档逐条关联 spec 六项用户行为、自动测试、浏览器证据与真机待验；写入方案 Agent、执行 Agent、审核 Agent 实际模型，不冒用其他模型身份。README 更新预览入口与操作方法。

```sh
git add tools/miniapp-preview docs/superpowers/reviews/2026-09-19-category-linked-scroll-verification.md
git commit -m "补齐分类联动滚动预览与验收记录"
```

## 完成条件

任务审核通过、全分支独立审核没有未处理的阻断问题、测试与编译通过、预览可审阅。统筹最终提供分支、方案、审核结论、预览与真机待验项；本次布局变更完成不代表真机发布验收完成。
