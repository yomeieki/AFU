# 分类页左右联动（分组锚点） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **工序声明**：本文件是「模型分工协议」的 **00 规划 · fable** 产物，等级 **M**（小程序单端多页改动 + 服务端加一个响应字段，零迁移；涉及顾客端主路径，另加一轮 02 复核）。
> 链路：**00 规划 · fable → 01 执行 · sonnet（逐任务子代理）→ 02 复核 · opus（新会话，只给需求 + 最终 diff + 验收标准）→ 03 回判 · fable → 04 机械核对 · haiku**。验收标准只在本文件定义，后续工序不得新增或放宽。
> 基线：worktree `/Users/yumingyi/food-shop/.claude/worktrees/category-anchor`，分支 `claude/category-anchor`，HEAD **9753a3e**（main 合并基 5e9668e）。

**Goal:** 分类页右侧不再翻页，一次拉全本渠道的菜、按分类分段展示；左侧点分类滚到该段，右侧滚动时左侧高亮跟随；去掉「全部」项；空分类照常显示并可滚到、可高亮；邮寄搜索保留（平铺 + 翻页）。同城与全国邮寄同一套代码。

**Architecture:** 服务端只在 `GET /api/products` 的 `select` 加 `categoryId`。小程序新增 ES5 纯函数模块 `utils/catalog-groups.js`（`groupByCategory` / `activeGroupOf`）承载分组与高亮判定规则，先有单测再改页面；`api/catalog.js` 加 `getAllProducts`（按页循环拉到没有为止，20 页上限）；`pages/product/list` 改为「分组视图（默认）/ 搜索视图（仅邮寄、保留分页）」两种右侧形态，左侧渲染 `groups`。滚动联动全在页面内：`createSelectorQuery` 量各段锚点位置一次，`bindscroll` 节流 100ms 比对、点击锁 500ms、最后一段补白。

**Tech Stack:** 微信原生小程序（基础库 `libVersion` 2.25.0；新增 js 必须 ES5，`node scripts/check-miniapp-es5.mjs <file>`）；`node --test` + CommonJS 单测（`npm run test:miniapp`）；Express + Prisma 服务端（`npx tsc --noEmit -p apps/server/tsconfig.json`）。

**Spec:** `docs/superpowers/specs/2026-09-17-category-anchor-design.md`（决策 C1–C9；C6 已改为「空分类照常显示」）。

---

## Global Constraints（每个任务隐含包含本节）

- 工作目录 `/Users/yumingyi/food-shop/.claude/worktrees/category-anchor`。不要 cd 到主检出；不要 `git stash`。
- **ES5 硬约束**：新建的 `apps/miniapp/utils/catalog-groups.js` 必须通过 `node scripts/check-miniapp-es5.mjs`；`api/catalog.js` 现在是 ES5、改完仍须通过；`pages/product/list.js` 现状**不是**纯 ES5（第 7 行 `const { … } = require`、方法用 ES6 简写），本批不回头改它，但**本批新增/改写的每一行只许 `var` / `function`，不用 `let` / `const` / 箭头函数 / 模板字符串 / 解构 / 简写属性**（沿用文件里既有的 `onLoad() {}` 方法简写体例即可）。
- **数据契约（逐字）**：
  - `groups: [{ id: number|'other', name: string, items: Product[] }]`；空分类 `items` 为 `[]` 且**保留**；`categoryId` 不在分类表里的商品归到末尾 `{ id: 'other', name: '其他' }`，没有这种商品时不出现「其他」段。
  - 锚点 id 规则 `'g-' + id`（例 `g-12`、`g-other`）；锚点节点同时带 `data-gid="{{id}}"`，量位置时从 `rect.dataset.gid` 取 id，不解析字符串。
  - `offsets: [{ id, top }]`，`top` 为该段顶相对 scroll-view 内容顶的像素值（`rect.top - panelRect.top + scrollOffset.scrollTop`），按段顺序升序。
  - `activeGroupOf(offsets, scrollTop, tolerance)`：返回 `top <= scrollTop + tolerance` 的**最后一段**的 id；一段都不满足返回第一段 id；`offsets` 为空返回 `null`。页面调用时 `tolerance = 2`。
  - 全量拉取：`pageSize = 50`（服务端上限），循环到 `已拉条数 >= total` 或 `list` 为空；上限 **20 页**，触顶时停下、`console.warn('[catalog] 商品超过 1000 条，已截断')`、结果带 `truncated: true`。
- **不改的东西**：`api/catalog.js` 的 `buildProductsUrl` 拼串与参数顺序（`tests/miniapp/catalog.test.cjs` 既有断言一条不动）；`app.js` 的 `pendingCategoryId / pendingCategoryName / pendingCategoryAll` 三个全局意图的名字与写入方（首页 `goToList` / `goToAllProducts` 不动）；`list.json`（不新增组件）；同城三块组件（`local-store-header` / `local-mode-bar` / `local-cart-bar`）与 `local-sku-picker` 的用法（`selectComponent('#local-sku-picker').open(product)` 只要 `{ id, stock }`）。
- **分页状态保留但只在搜索模式生效**：`page / pageSize / total / hasMore / loading / onScrollToLower / loadProducts / buildQueryKey` 都留下；`onScrollToLower` 函数体第一行必须是 `if (!this.data.searchKeyword) return`。
- 既有测试的**期望值**除本计划 Task 4 明确点名的两处外一律不改（改了就是行为偏离，按上报触发条件 6 处理）。
- 每个任务结束前跑本任务的测试；提交信息中文（`feat/fix/test/docs`），尾注按当前会话系统提示给的 `Co-Authored-By` 行；`git add` 只加白名单文件。

## 允许修改的文件白名单

```
apps/server/src/routes/products.ts                       （只加 select 的 categoryId: true 一行 + 注释）
docs/api.md                                              （只在 GET /api/products 响应示例补 "categoryId" 一行）
apps/miniapp/utils/catalog-groups.js                     （新建，ES5）
apps/miniapp/api/catalog.js                              （加 getAllProducts；buildProductsUrl 不动）
apps/miniapp/pages/product/list.js
apps/miniapp/pages/product/list.wxml
apps/miniapp/pages/product/list.wxss
tests/miniapp/catalog-groups.test.cjs                    （新建）
tests/miniapp/catalog.test.cjs                           （只追加 getAllProducts 用例，既有用例不动）
tests/miniapp/category-anchor-page.test.cjs              （新建，页面级行为锁）
tests/miniapp/channel-pages.test.cjs                     （只改 Task 4 点名的两条用例 + wx 桩补两个方法）
tests/miniapp/local-mode.test.cjs                        （只给 wx 桩补 nextTick / createSelectorQuery，断言不动）
docs/miniapp-release-checklist.md                        （可选：在「同城分类页点「+」」那条附近加一条分类联动检查项）
docs/superpowers/plans/2026-09-17-category-anchor.md     （本文件：勘误与验收记录）
```

**明确禁止**：`apps/miniapp/pages/index/**`（首页本批不动）、`apps/miniapp/app.js`、`apps/miniapp/pages/product/list.json`、`apps/miniapp/components/**`、`apps/admin/**`、`apps/server/**` 除 `src/routes/products.ts` 之外的任何文件、`tools/miniapp-preview/**`、`docs/superpowers/specs/**`（spec 不改；发现冲突写进本文件末尾「勘误与验收记录」并上报）。

## 上报触发条件（遇到即 BLOCKED，停下回报，不自行绕过）

1. `scroll-view` 的 `scroll-into-view` 在微信开发者工具（或真机）里点左侧不滚动、或只在第一次有效——**不要自行改成 `scroll-top` 定位方案**，停下上报（备选方案见 Task 5 末尾，是否切换由 00/店主定）。
2. `wx.createSelectorQuery().select().boundingClientRect() / scrollOffset() / selectAll()` 或 `wx.nextTick` 在本项目基础库 2.25.0 下不可用、`exec` 回调拿不到 `dataset` / 返回空数组（本仓库此前**没有任何一处**用过 `createSelectorQuery`，这是第一次引入）。
3. 需要改公开接口 `GET /api/products` 除 `categoryId` 之外的任何响应字段、排序、分页上限（50）或 `total` 语义。
4. 搜索模式与分组视图在同一个 `scroll-view` 里无法共存（例如切换时 `scroll-into-view` 残留值导致错位、或搜索结果与分段互相覆盖），需要改交互。
5. 需要改白名单之外的文件（含首页、`app.js`、`list.json`、任何组件、后台、服务端其他文件）。
6. 既有测试用例的**期望值**（不是 fixture / 桩）需要改动才能通过——除 Task 4 Step 6 点名的 `channel-pages.test.cjs` 两条。
7. `<template>` 内的 `wxs` 模块或事件绑定在真机/工具里不工作——允许的退路只有一种：把商品行 wxml 复制两份（分组视图一份、搜索视图一份），并在报告里写明；其他改法一律上报。
8. 本地或线上任一渠道 `getAllProducts` 触到 20 页上限（说明数据异常，不是代码问题）。
9. 全量 `setData({ groups })` 在开发者工具里报「数据量过大」警告或单次超过 1MB。

---

## Task 1（服务端）：公开商品列表返回 `categoryId`

**Files:** `apps/server/src/routes/products.ts`、`docs/api.md`

**Interfaces（Produces）:** `GET /api/products` 每个列表项多一个 `categoryId: number`。不改排序、不改分页、不改其它字段。

- [ ] **Step 1** `products.ts` 的 `GET /` 的 `select` 里在 `id: true,` 下一行加：
  ```ts
  // 分类页左右联动（2026-09-17 分组锚点设计 §4）：小程序按 categoryId 分段。老版本小程序看不见新字段，不受影响
  categoryId: true,
  ```
  `GET /:id` 不动（它已经 `include category`）。
- [ ] **Step 2** `docs/api.md` 的「GET /api/products」响应示例，在 `"id": 1,` 下一行加 `"categoryId": 3,`。
- [ ] **Step 3** `npx tsc --noEmit -p apps/server/tsconfig.json` 通过。若本机 `apps/server/.env` 指向的库与端口可用，可选核对：`curl -s "http://127.0.0.1:<PORT>/api/products?channel=LOCAL&pageSize=1" | grep -o categoryId`（本机 3000 端口常被占用，起不来不算失败，线上核对见验收 A3）。
- [ ] **Step 4** 提交 `feat(server): 公开商品列表返回 categoryId（分类页分组用）`。

**依赖**：无。可与 Task 2 并行；可先于小程序单独上线（零迁移）。

## Task 2（小程序 · 纯函数）：`utils/catalog-groups.js` + 单测（先测后写）

**Files:** `apps/miniapp/utils/catalog-groups.js`（新）、`tests/miniapp/catalog-groups.test.cjs`（新）

**Interfaces（Produces）:**
```js
// utils/catalog-groups.js（ES5，module.exports）
groupByCategory(categories, products)  // -> [{ id, name, items }]
activeGroupOf(offsets, scrollTop, tolerance)  // -> id | null
```

- [ ] **Step 1 先写 `tests/miniapp/catalog-groups.test.cjs`**（照 `tests/miniapp/local-catalog.test.cjs` 的写法：文件头一段「为什么」注释、`node:test` + `node:assert/strict`、`require('../../apps/miniapp/utils/catalog-groups')`），至少这些例：
  1. **分组顺序按 categories 顺序**：`categories = [{id:2,name:'凉菜'},{id:1,name:'特色菜'}]`，`products` 里先出现 categoryId 1 的再出现 2 的 → 结果 `map(g => g.id)` 为 `[2, 1]`。
  2. **空分类保留且 items 为空数组**（邮寄 3 个空分类场景）：7 个分类、只有 4 个有菜 → 7 段，空段 `deepEqual(items, [])`，名字保留。
  3. **未知 categoryId 归到末尾「其他」**：一个商品 `categoryId: 99` → 最后一段 `{ id: 'other', name: '其他', items: [那个商品] }`；所有商品都能对上时**不出现**「其他」段（`groups.some(g => g.id === 'other') === false`）。
  4. **段内顺序保持输入顺序**（服务端排好，小程序不排）：同一分类三件按输入顺序原样。
  5. **分类为空 / null 但商品非空** → 只有一个「其他」段（分类拉失败不丢菜）；`products` 为 `null` → 每段 `items` 为 `[]`；两者都空 → `[]`。
  6. **`activeGroupOf` 边界**（`offsets = [{id:1,top:0},{id:2,top:400},{id:3,top:900}]`）：`scrollTop=0` → 1；正好在段顶 `400` → 2；段间 `399` → 1；`398, tolerance 2` → 2（容差）；滚到底 `5000` → 3；`-10`（iOS 回弹）→ 1；`offsets=[]` → `null`；`tolerance` 缺省按 0（`activeGroupOf(offsets, 399)` → 1）。
  跑 `node --test tests/miniapp/catalog-groups.test.cjs` 看到全红（模块不存在）。
- [ ] **Step 2 写 `utils/catalog-groups.js`**：
  ```js
  // 分类页分组与高亮判定的纯函数（2026-09-17 分组锚点设计 §5.1）。
  // 页面只负责量位置和 setData；「哪段该亮」「菜归哪段」全在这里，tests/miniapp/catalog-groups.test.cjs 钉住。
  // ⚠️ 本文件必须保持 ES5（scripts/check-miniapp-es5.mjs 把守）。
  var OTHER_ID = 'other'
  var OTHER_NAME = '其他'

  /** 按 categories 给定顺序分段；空分类保留（items 为 []）；对不上分类的菜进末尾「其他」段，不丢菜 */
  function groupByCategory(categories, products) {
    var cats = categories || []
    var list = products || []
    var groups = []
    var byId = {}
    var i
    for (i = 0; i < cats.length; i++) {
      var g = { id: cats[i].id, name: cats[i].name, items: [] }
      groups.push(g)
      byId[String(cats[i].id)] = g
    }
    var other = null
    for (i = 0; i < list.length; i++) {
      var p = list[i]
      var g2 = p && p.categoryId != null ? byId[String(p.categoryId)] : null
      if (!g2) {
        if (!other) other = { id: OTHER_ID, name: OTHER_NAME, items: [] }
        other.items.push(p)
      } else {
        g2.items.push(p)
      }
    }
    if (other) groups.push(other)
    return groups
  }

  /** 「段顶 <= scrollTop + 容差」的最后一段；一段都不满足取第一段；没有段返回 null */
  function activeGroupOf(offsets, scrollTop, tolerance) {
    var list = offsets || []
    if (!list.length) return null
    var limit = (Number(scrollTop) || 0) + (typeof tolerance === 'number' ? tolerance : 0)
    var active = list[0].id
    for (var i = 0; i < list.length; i++) {
      if (list[i].top <= limit) active = list[i].id
      else break
    }
    return active
  }

  module.exports = { OTHER_ID: OTHER_ID, groupByCategory: groupByCategory, activeGroupOf: activeGroupOf }
  ```
- [ ] **Step 3** `node --test tests/miniapp/catalog-groups.test.cjs` 全绿；`node scripts/check-miniapp-es5.mjs apps/miniapp/utils/catalog-groups.js` 通过。提交 `feat(miniapp): 分类页分组与高亮判定纯函数及单测`。

**依赖**：无。**必须先于 Task 4/5**（先有可测的规则，再改页面）。

## Task 3（小程序 · 查询层）：`api/catalog.js` 加 `getAllProducts` + 单测

**Files:** `apps/miniapp/api/catalog.js`、`tests/miniapp/catalog.test.cjs`

**Interfaces（Produces）:**
```js
// api/catalog.js
var ALL_PAGE_SIZE = 50   // 服务端上限
var ALL_MAX_PAGES = 20   // 上限保护：1000 条
getAllProducts(channel)  // -> Promise<{ list: Product[], total: number, truncated: boolean }>
```

- [ ] **Step 1 先在 `tests/miniapp/catalog.test.cjs` 末尾追加用例**（既有 7 条一字不动）。桩：`global.wx = { getStorageSync: function() { return '' }, request: function(o) { … } }`，用 `o.url.replace(/^https?:\/\/[^/]+(\/api)?/, '')` 记 URL，按 `page=` 查询参数返回不同页（写法照 `channel-pages.test.cjs` 的 `makeCtx`；`utils/request` 只在鉴权失败路径才 `getApp()`，这里不用给）。用例：
  1. **按页循环直到拉全**：`total = 120`，page 1/2 各 50 条、page 3 返回 20 条 → 发出的 URL 依次是 `/products?channel=LOCAL&page=1&pageSize=50`、`…page=2…`、`…page=3…`，共 3 个请求；结果 `list.length === 120`、`total === 120`、`truncated === false`；**URL 里不含 `categoryId=` 也不含 `keyword=`**。
  2. **`total = 0`** → 只发 1 个请求，`list` 为 `[]`。
  3. **上限保护**：桩永远返回 50 条且 `total = 99999` → 恰好 20 个请求后停，`truncated === true`，`list.length === 1000`（同时 `console.warn` 被调用一次——用 `const warn = console.warn; console.warn = () => { n++ }` 包一下再还原）。
  4. **渠道显式**：`getAllProducts('EXPRESS')` 的每个 URL 都含 `channel=EXPRESS`；脏值 `getAllProducts('local')` 回落 `channel=EXPRESS`（沿用 `normalizeChannel`）。
  跑看到红。
- [ ] **Step 2 写 `getAllProducts`**（`getProducts` 之后、`module.exports` 之前；ES5）：
  ```js
  // 分组视图一次拉全本渠道的菜（2026-09-17 分组锚点设计 §5.2 / C4）：按页循环到没有为止，不写死总数。
  // 20 页（1000 条）上限只防接口异常时死循环——正常单渠道一百多道，触顶就是数据出了问题，要告警不要静默。
  var ALL_PAGE_SIZE = 50
  var ALL_MAX_PAGES = 20

  function getAllProducts(channel) {
    var acc = []
    function step(page) {
      return getProducts({ channel: channel, page: page, pageSize: ALL_PAGE_SIZE }).then(function(data) {
        var list = (data && data.list) || []
        var total = (data && data.total) || 0
        acc = acc.concat(list)
        if (!list.length || acc.length >= total) return { list: acc, total: total, truncated: false }
        if (page >= ALL_MAX_PAGES) {
          console.warn('[catalog] 商品超过 ' + (ALL_PAGE_SIZE * ALL_MAX_PAGES) + ' 条，已截断')
          return { list: acc, total: total, truncated: true }
        }
        return step(page + 1)
      })
    }
    return step(1)
  }
  ```
  `module.exports` 加 `ALL_PAGE_SIZE`、`ALL_MAX_PAGES`、`getAllProducts`。`buildProductsUrl` **不动**（`categoryId` 分支留着，`pages/index` 可能还用得到）。
- [ ] **Step 3** `node --test tests/miniapp/catalog.test.cjs` 全绿；`node scripts/check-miniapp-es5.mjs apps/miniapp/api/catalog.js` 通过。提交 `feat(miniapp): 查询层加 getAllProducts 按页拉全（20 页上限）`。

**依赖**：无（与 Task 2 并行亦可）。Task 4 消费它。

## Task 4（小程序 · 页面数据流）：分组视图 + 搜索视图共存、全局意图改「定位」、既有测试同步

**Files:** `apps/miniapp/pages/product/list.js`、`list.wxml`、`list.wxss`、`tests/miniapp/channel-pages.test.cjs`、`tests/miniapp/local-mode.test.cjs`、`tests/miniapp/category-anchor-page.test.cjs`（新）

**Interfaces（Consumes）:** Task 2 的 `groupByCategory`、Task 3 的 `getAllProducts`、Task 1 的 `categoryId`。

**Interfaces（Produces，Task 5 依赖）:** `data.groups / activeGroupId / activeGroupName / scrollIntoView / tailHeight / catalogLoading`；页面私有 `this._products`（全量、已装饰）、`this._offsets`（Task 5 填）、`this._pendingLocateId`；方法 `loadCatalog()` / `locateGroup(id)` / `setActiveGroup(id)` / `findProduct(id)` / `afterGroupsRendered()`（Task 5 在这里挂量位置）。

### 4.1 `list.js` 要删 / 要留 / 要加（逐一点名）

**删**：
- 第 13–14 行 `ALL_CATEGORY` 常量及三处引用（`data.categories: [ALL_CATEGORY]`、`reloadForChannel` 里 `categories: [ALL_CATEGORY]`、`loadCategories` 里 `[ALL_CATEGORY].concat(cats)`）。
- `data.activeCategoryId`（作为**筛选条件**的用法整个去掉）、`applyCategory(id)`、`loadCategories()`（并进 `loadCatalog`）。
- `loadProducts` 里 `categoryId: this.data.activeCategoryId` 这一参数；`buildQueryKey` 里 `'c:' + activeCategoryId` 分支。
- 文件头注释第 1–5 行改写成新形态的说明（左分类 / 右分段、点左滚右、滚右亮左；邮寄多一个搜索）。

**留（只在搜索模式生效）**：`keyword / searchKeyword / list / page / pageSize(20) / total / hasMore / loading`、`onSearchInput / onSearchConfirm / clearSearch / loadProducts / buildQueryKey / onScrollToLower / resetRightScroll`；同城那几段 `meta / mode / headBlocking / loadMeta / applyMode / onModeChange / onSwitchMode / onGoExpress / refreshCartBar / onCartChange / onAdded / onAddToCart`（`onAddToCart` 改用 `findProduct`）。

**加**：
```js
// data 新增
groups: [],            // [{ id, name, items }]，左侧与右侧分段都渲染它
activeGroupId: null,   // 当前高亮段；搜索模式下 wxml 不画高亮
activeGroupName: '',   // 右侧顶部浮动条文字
scrollIntoView: '',    // 'g-<id>'，点左侧时设置
tailHeight: 0,         // 最后一段之后的补白（px），Task 5 量出来
catalogLoading: false, // 分组视图拉全量中 → 骨架屏
```

- [ ] **Step 1 先写 `tests/miniapp/category-anchor-page.test.cjs`**（`loadPage` / `makeCtx` 照抄 `channel-pages.test.cjs`，但 `makeCtx` 接受一个 `respond(url)` 回调决定 `/products` 的返回，并给 `wx` 桩加 `nextTick: (fn) => setTimeout(fn, 0)` 与一个可注入结果的 `createSelectorQuery`（默认 `exec(cb)` 回 `[{ top: 0, height: 600 }, { scrollTop: 0 }, []]`——Task 5 会用到它，本任务只要它不抛）。`settle()` 多 await 几次（全量循环是串行 then 链，3 页至少 await 4 次）。用例：
  1. **进页拉全量、按分类分段、默认高亮第一段**：categories `[{id:1,name:'特色菜'},{id:2,name:'凉菜'},{id:3,name:'礼盒'}]`，products 两页（`total 60`：page1 50 条、page2 10 条，categoryId 分布在 1/2）→ URL 含 `page=1&pageSize=50` 与 `page=2&pageSize=50`，**不含 `categoryId=`**；`groups.map(g => g.id)` 为 `[1,2,3]`；`groups[2].items` 为 `[]`（空分类保留）；`activeGroupId === 1`、`activeGroupName === '特色菜'`；`catalogLoading === false`；每件商品有 `priceText / stockLabel / hasSkus`。
  2. **左侧没有「全部」**：`groups.some(g => g.id === null) === false`；`page.data.categories` 若仍存在也不含 `id: null`。
  3. **点左侧 = 定位**：`onSelectCategory({ currentTarget: { dataset: { id: 2 } } })` → `scrollIntoView === 'g-2'`、`activeGroupId === 2`、`activeGroupName === '凉菜'`；**不发新请求**（URL 数不变）。
  4. **同一分类再点一次仍能触发滚动**：先点 2，再 `setData({ scrollIntoView: 'g-2' })` 保持不变后再点 2 → 过程中 `scrollIntoView` 被置空过一次再回到 `'g-2'`（把 `setData` 桩改成记录每次 patch 的数组来断言）。
  5. **首页意图 → 定位**：`app.globalData.pendingCategoryId = 2` 后 `onShow()` → `scrollIntoView === 'g-2'`、`activeGroupId === 2`、globalData 三个意图被清空；`pendingCategoryAll = true` 后 `onShow()` → `activeGroupId === 1`（第一段）、`searchKeyword === ''`、意图清空。
  6. **意图先于数据到达**：新页面 `onLoad()` 之前先设 `pendingCategoryId = 2`，`onLoad()` 后立刻 `onShow()`（此时 `groups` 还空）→ 拉完之后 `activeGroupId === 2`（`_pendingLocateId` 生效）。
  7. **搜索模式保留分页且与分组互不干扰**（EXPRESS）：`setData({ keyword: '兔' })` → `onSearchConfirm()` → URL 含 `keyword=%E5%85%94&`、`page=1&pageSize=20`；`groups` 仍是分组数据没被清；`onScrollToLower()` 在搜索模式下会再发 `page=2`；`clearSearch()` 后 `searchKeyword === ''`、`list` 为 `[]`、`activeGroupId === 1`，且**不重新拉全量**（`/products?…pageSize=50` 的请求数不变）。
  8. **分组视图下 `onScrollToLower` 不发请求**：`searchKeyword === ''` 时调用 → URL 数不变。
  9. **切渠道清空**：`reloadForChannel()` 那一刻 `groups === []`、`activeGroupId === null`、`searchKeyword === ''`、`scrollIntoView === ''`、`catalogLoading === true`。
  10. **分类接口失败不丢菜**：categories 桩 `o.fail()`/返回 `code 50001`，products 正常 → `groups` 只有一个 `{ id: 'other', name: '其他' }` 段且 items 齐全。
  11. **`findProduct`**：分组视图能按 id 找到全量里的商品；搜索模式优先在 `list` 里找。
  跑 `node --test tests/miniapp/category-anchor-page.test.cjs` 看到红。
- [ ] **Step 2 `list.js` 数据流**：
  - 顶部 `var catalogGroups = require('../../utils/catalog-groups')`（沿用文件既有 `require` 风格即可，但新加的这一行用 `var`）。
  - `decorateProduct(p)`：把现在 `loadProducts` 里的 `Object.assign({}, p, { priceText, stockLabel, hasSkus })` 抽成页面方法，两个视图共用。
  - `reloadForChannel()`：`setData` 里把 `categories: [ALL_CATEGORY], activeCategoryId: null` 换成 `groups: [], activeGroupId: null, activeGroupName: '', scrollIntoView: '', tailHeight: 0, catalogLoading: true`；`this._products = []; this._offsets = []`；`this.loadCategories(); this.loadProducts(true)` 换成 `this.loadCatalog()`。同城 `loadMeta(true)` 那行不动。
  - `loadCatalog()`：
    ```js
    loadCatalog() {
      var self = this
      var channel = this.data.channel
      var seq = (this._catalogSeq = (this._catalogSeq || 0) + 1)   // 切渠道时让在途的旧结果作废
      this.setData({ catalogLoading: true })
      Promise.all([
        catalogApi.getCategories(channel).then(function(d) { return d || [] }, function() { return [] }),  // 分类拉失败不丢菜：全归「其他」
        catalogApi.getAllProducts(channel),
      ]).then(function(r) {
        if (seq !== self._catalogSeq) return
        var cats = r[0].map(function(c) { return { id: c.id, name: c.name } })
        var products = (r[1].list || []).map(function(p) { return self.decorateProduct(p) })
        self._products = products
        var groups = catalogGroups.groupByCategory(cats, products)
        var first = groups.length ? groups[0] : null
        self.setData({ groups: groups, catalogLoading: false, activeGroupId: first ? first.id : null, activeGroupName: first ? first.name : '' })
        self.afterGroupsRendered()      // Task 5：量锚点；本任务先留一个只调 nextTick 的空实现
        if (self._pendingLocateId != null) { var id = self._pendingLocateId; self._pendingLocateId = null; self.locateGroup(id) }
      }).catch(function() {
        if (seq === self._catalogSeq) self.setData({ catalogLoading: false })
      })
    },
    ```
  - `setActiveGroup(id)`：在 `groups` 里找，找到就 `setData({ activeGroupId, activeGroupName })`，找不到不动。
  - `locateGroup(id)`：`id` 规范化（`typeof id === 'string' && id !== 'other' ? Number(id) : id`）；`groups` 为空 → `this._pendingLocateId = id; return`；不在 `groups` 里 → return（切渠道时 app 已清意图，这里只是兜底）；若 `searchKeyword` 非空 → 先按 `clearSearch()` 的方式退出搜索（不重拉全量）；`setActiveGroup(id)`；`this._lockUntil = Date.now() + 500`（Task 5 用）；目标 `'g-' + id`：若 `this.data.scrollIntoView === target` 先 `setData({ scrollIntoView: '' })` 再 `setData({ scrollIntoView: target })`，否则直接设（同值不触发滚动，是 `scroll-into-view` 的既定行为）。
  - `onSelectCategory(e)` → `this.locateGroup(e.currentTarget.dataset.id)`。
  - `onShow()`：`pendingCategoryAll` 分支改为：清三个意图 → 若在搜索模式 `clearSearch()` → `resetRightScroll()` → `setActiveGroup(groups[0].id)`（`groups` 为空则 `_pendingLocateId = null` 即可，拉完默认就是第一段）；`pendingCategoryId` 分支改为 `this.locateGroup(id)`。渠道变了走 `reloadForChannel()` 提前 return 的逻辑不动。
  - `buildQueryKey()` → `this.data.channel + '|' + (this.data.searchKeyword ? 'k:' + this.data.searchKeyword : 'g')`。
  - `loadProducts(reset)`：函数体第一行加 `if (!this.data.searchKeyword) return`；参数去掉 `categoryId`；`newItems` 用 `decorateProduct`。
  - `onScrollToLower()`：函数体第一行 `if (!this.data.searchKeyword) return`。
  - `clearSearch()`：现有 `setData` 之后不再 `loadProducts(true)`，改为 `resetRightScroll()` + `setActiveGroup(第一段)` + `afterGroupsRendered()`（分段重新渲染后要重量）。
  - `onSearchConfirm()`：不动（进入搜索模式仍 `resetRightScroll()` + `loadProducts(true)`）。
  - `findProduct(id)`：先在 `data.list`（搜索结果）里找，再在 `this._products` 里找；`onAddToCart` 改用它。
  - `afterGroupsRendered()`：本任务先写成 `var self = this; var run = function() { self.measureOffsets() }; if (wx.nextTick) wx.nextTick(run); else setTimeout(run, 0)`，`measureOffsets()` 先留空函数（Task 5 填），注释写明。
- [ ] **Step 3 `list.wxml` 分段渲染**（联动相关的属性在 Task 5 补）：
  - 左侧 `wx:for="{{categories}}"` 改 `wx:for="{{groups}}"`，`wx:key="id"`，class 判定改 `!searchKeyword && activeGroupId === item.id`。
  - 把商品行（现在第 72–113 行那个 `product-row`）抽成文件顶部的 `<template name="product-row">…</template>`，`data="{{ item, channel }}"`；行内 `bindtap="goToDetail"`、`catchtap="onAddToCart"`、`pricefmt` 用法原样（同一文件里的 `wxs` 模块在 template 内可用；不行按上报触发条件 7）。
  - 右侧 `scroll-view` 外包一层 `<view class="prod-wrap">`（Task 5 的浮动条要一个定位父级）。`scroll-view` 内部：
    ```xml
    <!-- 分组视图：拉全量中骨架屏 → 空 → 分段 -->
    <block wx:if="{{!searchKeyword}}">
      <view wx:if="{{catalogLoading}}" class="skeleton-list">
        <view class="skeleton-row" wx:for="{{[1,2,3,4,5]}}" wx:key="*this">
          <view class="skeleton-img skeleton-shine"></view>
          <view class="skeleton-lines"><view class="skeleton-line skeleton-shine"></view><view class="skeleton-line skeleton-line-short skeleton-shine"></view></view>
        </view>
      </view>
      <empty-state wx:elif="{{groups.length === 0}}" type="product" text="{{channel === 'LOCAL' ? '同城菜单还在准备中' : '暂无商品'}}" />
      <block wx:else>
        <view wx:for="{{groups}}" wx:key="id" wx:for-item="g" id="g-{{g.id}}" data-gid="{{g.id}}" class="group-anchor">
          <view class="group-head">{{g.name}}</view>
          <view wx:if="{{g.items.length === 0}}" class="group-empty">该分类暂无商品</view>
          <view wx:else class="product-list">
            <template wx:for="{{g.items}}" wx:key="id" is="product-row" data="{{item: item, channel: channel}}" />
          </view>
        </view>
        <view class="group-tail" style="height: {{tailHeight}}px;"></view>
      </block>
    </block>
    <!-- 搜索视图（仅邮寄）：平铺 + 翻页，原样保留 -->
    <block wx:else>
      <empty-state wx:if="{{list.length === 0 && !loading}}" type="product" text="没有找到相关商品" />
      <view class="product-list">
        <template wx:for="{{list}}" wx:key="id" is="product-row" data="{{item: item, channel: channel}}" />
      </view>
      <view wx:if="{{loading}}" class="footer-tip"><text>加载中...</text></view>
      <view wx:elif="{{!hasMore && list.length > 0}}" class="footer-tip"><text>- 没有更多了 -</text></view>
    </block>
    ```
    `scroll-view` 现有属性（`scroll-y / enhanced / show-scrollbar / scroll-top / lower-threshold / bindscrolltolower`）保留。搜索框、搜索 chip、`local-store-header`、`local-mode-bar`、`local-sku-picker`、`local-cart-bar` 五块**一个字符不改**。
- [ ] **Step 4 `list.wxss`**：`.prod-panel` 的 `flex: 1; min-width: 0` 挪到新的 `.prod-wrap { flex: 1; min-width: 0; position: relative; height: 100%; }`，`.prod-panel` 改 `width: 100%; height: 100%; background-color: var(--card);`；`.page-local .prod-panel` 的 padding 规则不动。新增：
  ```css
  /* 分段：段头与 Task 5 的浮动条尺寸必须完全一致，滚到 0 时两者重叠得看不出是两层 */
  .group-anchor { padding-bottom: 8rpx; }
  .group-head { height: 64rpx; line-height: 64rpx; padding: 0 20rpx; font-size: 26rpx; font-weight: 600; color: var(--text-1); background-color: var(--card); }
  /* 空段要有高度：太矮的话滚过去后「段顶 <= scrollTop」立刻被下一段接管，高亮停不住 */
  .group-empty { min-height: 200rpx; display: flex; align-items: center; justify-content: center; font-size: 24rpx; color: var(--text-disabled); }
  .group-tail { width: 100%; }
  /* 骨架屏（样式从 pages/index/index.wxss 抄，页面样式互不可见） */
  .skeleton-list { padding: 16rpx 20rpx; display: flex; flex-direction: column; gap: 16rpx; }
  .skeleton-row { display: flex; gap: 20rpx; padding: 16rpx; border: 1rpx solid var(--divider); border-radius: var(--radius-lg); }
  .skeleton-img { width: 160rpx; height: 160rpx; border-radius: var(--radius-md); background: var(--divider); flex-shrink: 0; }
  .skeleton-lines { flex: 1; }
  .skeleton-line { height: 28rpx; border-radius: 8rpx; background: var(--divider); margin-top: 8rpx; }
  .skeleton-line-short { width: 55%; margin-top: 16rpx; }
  .skeleton-shine { animation: skeleton-breath 1.2s ease-in-out infinite; }
  @keyframes skeleton-breath { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  ```
- [ ] **Step 5** `node --test tests/miniapp/category-anchor-page.test.cjs` 全绿。
- [ ] **Step 6 既有测试同步**（这是本计划唯一允许改期望值的地方）：
  - `channel-pages.test.cjs`「分类页的请求钥匙里必须含渠道」：`setData({ channel: 'LOCAL', activeCategoryId: 3, searchKeyword: '' })` 改为 `setData({ channel: 'LOCAL', searchKeyword: '牛肉' })`（钥匙如今只有「搜索」与「分组」两种形态，渠道仍必须在里面）；断言不变。
  - `channel-pages.test.cjs`「分类页切渠道会清空分类、商品与搜索词」：`setData` 改为 `{ list: [{ id: 1 }], searchKeyword: '牛肉', groups: [{ id: 3, name: 'x', items: [] }], activeGroupId: 3 }`；后两条断言改为 `assert.equal(page.data.activeGroupId, null, '旧渠道的分类 id 会指向一个新渠道没有的分类')` 与 `assert.deepEqual(page.data.groups, [])`；前两条不动。
  - `channel-pages.test.cjs` 与 `local-mode.test.cjs` 的 `makeCtx` 的 `wx` 桩各加 `nextTick(fn) { setTimeout(fn, 0) }` 与 `createSelectorQuery: () => { const q = { in: () => q, select: () => q, selectAll: () => q, boundingClientRect: () => q, scrollOffset: () => q, exec: (cb) => cb([{ top: 0, height: 600 }, { scrollTop: 0 }, []]) }; return q }`（`groups` 为空时页面本就不量，但桩要在，免得改动顺序一变就炸）。其余断言一条不动。
- [ ] **Step 7** `npm run -s test:miniapp` 全绿。提交 `feat(miniapp): 分类页改分组视图（一次拉全、无「全部」、首页意图改定位），搜索保留分页`。

**依赖**：Task 2、Task 3。

## Task 5（小程序 · 滚动联动）：量锚点、滚动高亮、点击锁、浮动段头、尾部补白

**Files:** `apps/miniapp/pages/product/list.js`、`list.wxml`、`list.wxss`、`tests/miniapp/category-anchor-page.test.cjs`

**Interfaces（Consumes）:** Task 2 的 `activeGroupOf`、Task 4 的 `afterGroupsRendered / setActiveGroup / _lockUntil / data.tailHeight`。

- [ ] **Step 1 先补页面级用例**（同一测试文件）：
  1. **量锚点**：`createSelectorQuery` 桩的 `exec` 回 `[{ top: 100, height: 600 }, { scrollTop: 40 }, [{ dataset: { gid: 1 }, top: 100, height: 300 }, { dataset: { gid: 2 }, top: 400, height: 250 }, { dataset: { gid: 3 }, top: 650, height: 120 }]]`，`wx.getWindowInfo` 回 `windowHeight: 812`（桩已有）→ 拉完后 `page._offsets` deepEqual `[{ id: 1, top: 40 }, { id: 2, top: 340 }, { id: 3, top: 590 }]`（`rect.top - panel.top + scrollTop`）；`tailHeight === 480`（`min(panel.height 600, 812 - 100) - 最后段高 120`）。最后段比可视区高时 `tailHeight === 0`。
  2. **滚动 → 高亮跟随（节流后）**：`onRightScroll({ detail: { scrollTop: 345 } })` → 立刻 `activeGroupId` 仍是 1；`await` 120ms 后 `activeGroupId === 2`；连续调 10 次不同 `scrollTop` 只触发一次 `setData`（用记录型 `setData` 桩数 `activeGroupId` 出现次数）。
  3. **点击锁**：`onSelectCategory(id 3)` 后立刻 `onRightScroll({ detail: { scrollTop: 345 } })` 并 `await` 120ms → `activeGroupId` 仍是 3（500ms 内忽略滚动）；`page._lockUntil = 0` 后再滚一次 → 变 2。
  4. **搜索模式不联动**：`searchKeyword` 非空时 `onRightScroll` 不改 `activeGroupId`。
  5. **图片加载去抖**：`onImageLoad()` 连调 5 次 → `await` 350ms → `createSelectorQuery` 桩只被再调 1 次。
  跑看到红。
- [ ] **Step 2 `list.js` 联动**：
  - `measureOffsets()`：
    ```js
    // 量各段顶部位置（相对 scroll-view 内容顶）与最后一段的补白。只在分段渲染完成后调，滚动时只做数值比较。
    measureOffsets() {
      if (this.data.searchKeyword || !this.data.groups.length || !wx.createSelectorQuery) return
      var self = this
      wx.createSelectorQuery()
        .select('.prod-panel').boundingClientRect()
        .select('.prod-panel').scrollOffset()
        .selectAll('.group-anchor').boundingClientRect()
        .exec(function(res) {
          var panel = res[0], scroll = res[1], rects = res[2] || []
          if (!panel || !scroll || !rects.length) return
          var offsets = []
          for (var i = 0; i < rects.length; i++) {
            var gid = rects[i].dataset && rects[i].dataset.gid
            if (typeof gid === 'string' && gid !== 'other' && gid !== '' && !isNaN(Number(gid))) gid = Number(gid)
            offsets.push({ id: gid, top: rects[i].top - panel.top + scroll.scrollTop })
          }
          self._offsets = offsets
          // 最后一段顶不上去就永远亮不了：补白 = 可视高 − 最后段高。可视高取 scroll-view 自身高与「窗口底到面板顶」的较小值
          // （同城下 .prod-panel 有给购物车条让位的 padding-bottom，盒子比可视区高，多补一点空白无害，少补才是 bug）
          var win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
          var visible = Math.min(panel.height, win.windowHeight - panel.top)
          var tail = Math.max(0, Math.round(visible - rects[rects.length - 1].height))
          if (tail !== self.data.tailHeight) self.setData({ tailHeight: tail })
        })
    },
    ```
  - `onRightScroll(e)`（尾随节流 100ms，保证最后一次滚动位置一定被处理）：
    ```js
    onRightScroll(e) {
      if (this.data.searchKeyword) return
      this._pendingScrollTop = e.detail.scrollTop
      if (this._scrollTimer) return
      var self = this
      this._scrollTimer = setTimeout(function() {
        self._scrollTimer = null
        if (Date.now() < (self._lockUntil || 0)) return   // 点左侧后的滚动动画期间不让中间经过的段抢高亮
        var id = catalogGroups.activeGroupOf(self._offsets, self._pendingScrollTop, 2)
        if (id != null && id !== self.data.activeGroupId) self.setActiveGroup(id)
      }, 100)
    },
    ```
  - `onImageLoad()`：`clearTimeout(this._imgTimer); this._imgTimer = setTimeout(function() { self.measureOffsets() }, 300)`。（商品图盒子是固定 160rpx，图片撑不动布局；这一步是按 spec §5.2 留的保险，成本一个定时器。）
  - `onHide()` / `onUnload()`：清 `_scrollTimer`、`_imgTimer`（tabBar 页 `onUnload` 基本不触发，`onHide` 必须清，否则定时器在别的 tab 上 setData）。
  - `applyMode()` 之后（同城切外送/自取会改页头高度）调 `afterGroupsRendered()`；`loadMeta` 回来 `setData` 后同样调一次（门店头第一次画出来会把右侧往下推）。
- [ ] **Step 3 `list.wxml`**：
  - `scroll-view` 加 `scroll-into-view="{{scrollIntoView}}"`、`scroll-with-animation="{{true}}"`、`bindscroll="onRightScroll"`。
  - `.prod-wrap` 内、`scroll-view` 之前加浮动段头：`<view wx:if="{{!searchKeyword && !catalogLoading && activeGroupName}}" class="group-head group-float">{{activeGroupName}}</view>`。
  - template 里的 `<image>` 加 `bindload="onImageLoad"`。
- [ ] **Step 4 `list.wxss`**：`.group-float { position: absolute; top: 0; left: 0; right: 0; z-index: 5; border-bottom: 1rpx solid var(--divider); }`（其余尺寸继承 `.group-head`，两者必须一样高，否则滚到 0 时露出双层段头）。
- [ ] **Step 5** `npm run -s test:miniapp` 全绿；`node scripts/check-miniapp-es5.mjs apps/miniapp/utils/catalog-groups.js apps/miniapp/api/catalog.js` 通过。提交 `feat(miniapp): 分类页左右联动——量锚点、滚动高亮节流、点击锁、浮动段头与尾部补白`。
- [ ] **Step 6 开发者工具自测**（执行方在微信开发者工具里跑一遍验收 B 的 1–5、9，把现象写进报告；B6–B8 留给店主真机）。**若 B3 点左侧不滚**：按上报触发条件 1 停下。备选方案（仅供 00/店主决策，执行方不得自行切换）：`locateGroup` 改为从 `_offsets` 取该段 `top`，写到 `rightScrollTop`（同值时先写 `top + 0.5`），`scroll-into-view` 属性去掉。

**依赖**：Task 4。

## Task 6（收尾）：机械核对项、发布清单

**Files:** `docs/miniapp-release-checklist.md`（可选）、本文件

- [ ] **Step 1** 依次跑验收 A1–A8，把输出摘进报告。
- [ ] **Step 2**（可选）`docs/miniapp-release-checklist.md` 在「同城分类页点「+」」那条之后加一条：「分类页：左侧无「全部」，点分类右侧滚到该段、右侧滑动左侧高亮跟着走；邮寄的 3 个空分类能点、能亮、显示「该分类暂无商品」」。
- [ ] **Step 3** 本文件末尾「勘误与验收记录」追加执行记录（偏离方案的逐条说明、A 类命令输出摘要、开发者工具自测现象）。提交 `docs: 分类页分组锚点计划补执行记录`。

---

## 验收标准（只在此定义；04 机械核对按此打 PASS/FAIL）

### A. 可脚本化

| # | 命令（仓库根目录） | 期望 |
|---|---|---|
| A1 | `npm run -s test:miniapp` | `fail 0`；`tests` 总数 ≥ 117 + 26，其中 `node --test tests/miniapp/catalog-groups.test.cjs` ≥ 6 例、`tests/miniapp/catalog.test.cjs` ≥ 11 例（既有 7 + 追加 ≥ 4）、`tests/miniapp/category-anchor-page.test.cjs` ≥ 16 例 |
| A2 | `npx tsc --noEmit -p apps/server/tsconfig.json` | 无输出、退出码 0 |
| A3 | 服务端上线后：`curl -s 'https://api.yuegui-hotel.online/api/products?channel=LOCAL&pageSize=1' \| grep -o categoryId` | 输出 `categoryId`（上线前用本机服务端同样命令，起不来则本项由部署后补验） |
| A4 | `grep -rn "ALL_CATEGORY\|activeCategoryId\|applyCategory\|loadCategories" apps/miniapp tests/miniapp` | 无结果 |
| A5 | `grep -n -A1 "onScrollToLower()" apps/miniapp/pages/product/list.js` | 下一行是 `if (!this.data.searchKeyword) return` |
| A6 | `grep -c "categoryId: true" apps/server/src/routes/products.ts` | `1`；且 `git diff 9753a3e..HEAD --stat -- apps/server` 只有 `products.ts` 一个文件、增行 ≤ 3 |
| A7 | `node scripts/check-miniapp-es5.mjs apps/miniapp/utils/catalog-groups.js apps/miniapp/api/catalog.js` | 两个 `ES5 ✔`，退出码 0 |
| A8 | `git diff --name-only 9753a3e..HEAD` | 每一行都在白名单内；`apps/miniapp/pages/index/`、`apps/miniapp/app.js`、`apps/miniapp/pages/product/list.json`、`apps/miniapp/components/`、`apps/admin/` 零命中 |
| A9 | `grep -n "scroll-into-view\|bindscroll=\"onRightScroll\"\|group-float\|group-tail\|data-gid" apps/miniapp/pages/product/list.wxml` | 五个都命中 |
| A10 | `grep -n "getAllProducts\|groupByCategory\|activeGroupOf\|_lockUntil\|measureOffsets" apps/miniapp/pages/product/list.js` | 五个都命中 |
| C | 提交前缀（`feat/fix/test/docs`）与尾注合规 | — |

### B. 真机（微信开发者工具 + 店主手机；每条写「操作 → 期望」）

1. **同城进分类页**：封面 → 同城 → 底部「分类」tab。→ 左侧从上到下 9 项（特色菜、凉菜、风味菜、鱼、素菜、炒饭、汤、酒水饮料、白米饭），**没有「全部」**；默认高亮第一项；右侧第一段段头与顶部浮动条都是第一项的名字，段内是该分类的菜；拉取过程中右侧是骨架屏，不会先出现半截菜单。
2. **右侧一路滑到底**：手指慢慢往下拖。→ 左侧高亮依次变到凉菜、风味菜……；滑到最底时左侧停在「白米饭」，浮动条显示「白米饭」，最后一段能被顶到浮动条正下方（底部有一段空白属正常）。
3. **点左侧「汤」**：→ 右侧动画滚到「汤」段，段头贴在浮动条位置；滚动过程中左侧高亮**直接是「汤」**、中途不闪到风味菜/素菜等；停下后仍是「汤」。
4. **同一项再点一次**：手动往下滑离开「汤」段后再点左侧「汤」。→ 右侧仍会滚回「汤」段（不是没反应）。
5. **邮寄进分类页**：封面 → 全国邮寄 → 「分类」。→ 左侧 7 项，含礼盒、预包装食品、素食三个空分类；右侧对应三段各显示一行「该分类暂无商品」。
6. **空分类能滚到、能高亮**：点左侧「礼盒」。→ 右侧滚到「礼盒」段，浮动条显示「礼盒」，段内一行「该分类暂无商品」，左侧高亮停在「礼盒」不跳走；随后手指慢慢滑过这一段，左侧高亮会依次经过它而不是跳过。
7. **邮寄搜索**：搜索框输「兔」回车。→ 右侧变平铺结果、无段头、无浮动条，左侧无高亮；结果多时滑到底会加载下一页并出现「- 没有更多了 -」；点 chip 的 × → 回到分组视图、回到顶部、左侧高亮第一项，且不重新转骨架屏（不重拉）。
8. **首页点分类进来**：主页任一分类图标（例「汤」）。→ 分类页直接停在「汤」段并高亮；主页「全部 ›」→ 分类页停在顶部、高亮第一项。
9. **同城一切照旧**：门店头（店名 + 状态胶囊）、外送/自取切换栏、点「+」弹规格 → 加购 → 底部购物车条出现并紧贴 tabBar、角标更新；切外送/自取后左右联动仍正常（页头高度变了不影响定位）。
10. **弱网**：开发者工具「Slow 3G」进分类页。→ 右侧骨架屏直到全部拉完才一次性出现分段；期间点左侧不报错。

## 复核与收尾（02–04）

- **02 复核 · opus（新会话，最小上下文）**——只给这三样输入，不给本计划的推理、不给执行对话历史：
  1. 原始需求：`docs/superpowers/specs/2026-09-17-category-anchor-design.md` 全文；
  2. 最终 diff：`git diff 9753a3e..HEAD`（含测试）；
  3. 验收标准：本文件「验收标准」一节（A1–A10 + B1–B10）原文。
  输出问题清单，每条标 [阻断/需改/建议] 并指明违反哪条验收标准；无问题明确写「无阻断项」。
- **03 回判 · fable**：输入需求 + 本计划 + 02 清单，逐条判 [成立/误判/需澄清]；成立项派 sonnet 修复后再过一轮 A 类命令。
- **04 机械核对 · haiku**：只跑 A1–A10 与 C，逐条打 PASS/FAIL 贴原始输出；不调模型判断，不看 B 类。
- **上线顺序**：先部署服务端（零迁移，回滚即上一版 SHA）→ 小程序合 main（开发者工具读主仓磁盘）→ 上传体验版 → 店主验 B1–B10 → 提审。审核通过前线上仍是旧分类页，新字段对它无影响。

## 勘误与验收记录（执行时追加）

- **2026-09-17 00 规划时发现的 spec 与代码现状差异**（未改 spec，执行按本计划）：
  1. spec §5.2「图片首次撑开高度后重量」：现有 `.product-row-img-wrap` 是固定 160rpx 方盒，图片加载不改变布局；按 spec 保留 `onImageLoad` 去抖重量作为保险，但真正会改变右侧高度的是**同城门店头首次渲染与外送/自取切换**，本计划在 `loadMeta` 回来与 `applyMode` 后各补一次重量。
  2. spec §5.3 只提「删 `activeCategoryId` 筛选用法与 `ALL_CATEGORY`」，未提 `loadCategories` / `applyCategory` 两个函数——它们只服务于旧的筛选形态，一并并入 `loadCatalog` / `locateGroup`。
  3. spec 未提既有测试：`tests/miniapp/channel-pages.test.cjs` 有两条用例直接 `setData({ activeCategoryId: 3, categories: [{ id: null }, …] })` 并断言 `activeCategoryId === null`、`categories` 为 `[null]`——这是旧形态的行为锁，必须随改（Task 4 Step 6 点名），不算「放宽验收」。
  4. spec §5.2「点击设置 `scrollIntoView = 'g-' + id`」：`scroll-into-view` 同值不触发，顾客滑走后再点同一分类会没反应；本计划加「同值先置空再设」（Task 4 Step 2、B4 验收）。
  5. `pages/product/list.js` 现状不是纯 ES5（第 7 行 `const` + 解构），ES5 闸门只对新建文件生效（`scripts/check-miniapp-es5.mjs` 文件头已说明）；本批新增代码仍按 ES5 写。
  6. 本仓库小程序此前从未用过 `createSelectorQuery`，本批首次引入（上报触发条件 2 据此列出）。
  7. 与 `2026-09-17-category-product-sort-design.md`（分类内排序）的交集只有 `products.ts` 的 `select` 加 `categoryId`：两批谁先合都行，后合的一方 rebase 时该行取并集即可。

- **2026-09-17 工序 01 · sonnet 执行记录**（worktree `.claude/worktrees/category-anchor-miniapp`，分支 `claude/category-anchor-miniapp`）：
  1. **按上级指示跳过 Task 1**：本批不改 `apps/server/**` 与 `docs/api.md`，`categoryId` 字段由并行的「后台排序」批交付。Task 2–6 全部完成。白名单被上级进一步收窄为 `apps/miniapp/**` / `tests/miniapp/**` / 本计划文件本身（比原计划白名单更窄，不含 `docs/miniapp-release-checklist.md`）——曾误加一行到该文件，发现越界后已 `git checkout` 撤销，未提交。
  2. Task 2（`utils/catalog-groups.js` + 单测，commit `333feaa`）、Task 3（`api/catalog.js` 加 `getAllProducts` + 单测，commit `c3cb425`）、Task 4（页面数据流改分组视图，commit `8579143`）、Task 5（滚动联动，commit `973c4e8`）均按计划伪代码逐字落地，未发现需要偏离计划的新情况。
  3. 验收 A1、A4、A5、A7、A9、A10 全部按命令实测通过（输出见工序 01 回报）；A2（server tsc）、A3（curl 生产）、A6（`categoryId: true` 计数）因 Task 1 跳过而对本批不适用，只做了 A2 的知情性核对（`apps/server` 未改，tsc 仍通过）。A8 用 `git diff --name-only 9753a3e..HEAD` 会带出 00 规划阶段两条纯文档提交（`b76898f`、`a92d4a3`，均在本批开工前已产生），本批自身改动（`git diff --name-only 333feaa~1..HEAD`）逐行落在收窄后的白名单内。
  4. B 类真机/开发者工具验收未执行（本环境无微信开发者工具），如实标注留给人工，建议 02/店主按验收标准 B1–B10 补测。
  5. 未命中任何「命中即停」触发条件。
