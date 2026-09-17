# 分类内商品排序（后台拖拽 / 按销量自动）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **工序声明**：本文件是「模型分工协议」的 **00 规划 · fable** 产物，等级 **L**（改数据结构：两处加列 + 一次迁移；跨服务端与后台两个模块）。
> 链路：**00 规划 · fable（本文件）→ 01 执行 · sonnet（逐任务子代理）→ 02 复核 · opus（新会话，只给需求 + 最终 diff + 验收标准）→ 03 回判 · fable → 04 机械核对 · haiku**。验收标准只在本文件定义，后续工序不得新增或放宽。
> 基线 commit：`9753a3e`（`docs: 分类内商品排序（拖拽/按销量）设计方案`，分支 `claude/category-anchor`）。

**Goal:** 后台给每个分类单独设「排序方式」（手动拖拽 / 近 30 天销量自动）；顾客端分类页该分类那一段按这个顺序显示；上线当天顾客端顺序不变；不改小程序。

**Architecture:** 服务端新增两个模块：`services/product-sort.ts` 是排序规则的**唯一实现**（纯函数 `sortProducts`，无 I/O，公开列表与后台列表共用）；`services/product-sales.ts` 负责近 30 天销量聚合（复用 `REAL_ORDERS` 口径，进程内 60 秒缓存，写法照 `services/local-settings.ts`）。数据落 `products.sort_order` 与 `categories.product_sort_mode` 两列。公开列表 `GET /api/products` 改为整表取回 → 内存排序 → 分页。后台商品页在选定分类时出现「排序方式」下拉与拖拽把手 / 上下按钮，松手即保存。

**Tech Stack:** Express + Prisma 5 / MySQL + zod；React 18 + Vite 后台（`node --test` 跑 `src/utils/*.test.ts`）；服务端自测用 `scripts/selftest-*.ts`（`npx ts-node --transpile-only`）；e2e 分片 `scripts/e2e.d/*.sh`。

**Spec:** `docs/superpowers/specs/2026-09-17-category-product-sort-design.md`（决策 S1–S8，已定稿）。

---

## Global Constraints（每个任务隐含包含本节）

- 工作目录 `/Users/yumingyi/food-shop/.claude/worktrees/category-anchor`（分支 `claude/category-anchor`，基线 `9753a3e`）。不要 cd 到主检出；不要裸 `git stash`。
- **本 worktree 目前没有 `node_modules`**（2026-09-17 实测）。动手前先在 worktree 根跑 `npm install`，再 `cd apps/server && npx prisma generate`。改完 `schema.prisma` 后必须再 `npx prisma generate` 一次（同一时刻只能有一个 agent 在跑 generate）。
- **本地库与端口**：新建独立库 `food_shop_psort`，服务端口 **3112**（3111 已被别的 worktree 占用，3000 长期被占）。`apps/server/.env` 在本 worktree 不存在，一律用环境变量：
  ```bash
  docker exec -i food-shop-mysql mysql -uroot -pfoodshop_root_password -e "DROP DATABASE IF EXISTS food_shop_psort; CREATE DATABASE food_shop_psort CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON food_shop_psort.* TO 'foodshop_user'@'%'; FLUSH PRIVILEGES;"
  export DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_psort"
  (cd apps/server && npx prisma migrate deploy && npx prisma db seed)
  PORT=3112 DATABASE_URL="$DATABASE_URL" WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true WECHAT_QRCODE_MOCK=true LOCAL_DELIVERY_PROVIDER_MOCK=true PRINTER_PROVIDER_MOCK=true SCHEDULER_DISABLED=true npm --prefix apps/server run dev
  ```
  e2e：`BASE=http://localhost:3112 DB_NAME=food_shop_psort bash scripts/e2e.sh`（全量约 10 分钟，`timeout ≥ 600000`；**只能在刚建的干净库上跑**）。
- **列名与取值（逐字）**：
  - Prisma `Product.sortOrder Int @default(0) @map("sort_order")`；`Category.productSortMode String @default("MANUAL") @map("product_sort_mode") @db.VarChar(16)`。
  - `productSortMode ∈ {'MANUAL','SALES_30D'}`，服务端与后台都用常量 `PRODUCT_SORT_MODES = ['MANUAL','SALES_30D'] as const`，不散写字符串。
  - 迁移目录 **`20260918000000_product_sort`**：**只加列、有默认值、不回填**，回滚代码不需要回滚库。
- **接口字段名**：公开列表每项新增 `categoryId`、`sortOrder`；后台列表每项新增 `sales30d`（整数，无销量为 0）；分类对象新增 `productSortMode`；新接口 `POST /api/admin/categories/:id/product-order` body `{ ids: number[] }` → `data: { updated: number }`。
- **排序规则（逐字，`sortProducts` 唯一实现，spec §4.1）**：
  1. `isRecommended` 降序；
  2. 分类 `sortOrder` 升序，相同再 `categoryId` 升序；
  3. 分类内：`MANUAL` → 商品 `sortOrder` 升序，相同 `createdAt` 升序；`SALES_30D` → 近 30 天销量降序，相同 `sortOrder` 升序、再 `createdAt` 升序；
  4. 最后 `id` 升序兜底。
  商品所属分类不在传入的分类表里（理论上不会发生）→ 视为 `sortOrder = Number.MAX_SAFE_INTEGER`、`MANUAL`，排到最后而不是抛错。
- **销量口径（spec §3.2，与 `routes/admin/stats/overview.ts` 热销榜同写法）**：`prisma.orderItem.groupBy({ by: ['productId'], where: { isGift: false, productId: { not: null }, order: { ...REAL_ORDERS, paidAt: { gte: now − 30d } } }, _sum: { quantity: true } })`。`REAL_ORDERS` 只是 `{ isTest: false }`，**不看订单 status、不排除已退款单**——与热销榜一致（见「spec 与现状差异」①）。`REAL_ORDERS` 必须 spread 自 `utils/stats-scope.ts`，不手写字面量。
- **缓存（收窄自 spec §4.1，见「spec 与现状差异」②）**：只缓存**销量聚合结果**（一个进程内 `Map<productId, qty>`，TTL 60 秒，写法照 `services/local-settings.ts` 的 `cached / CACHE_TTL_MS / clearLocalSettingsCache`）；商品列表本身**每次现查**，不缓存。`PUT /api/admin/categories/:id`（改了 `productSortMode` 时）与 `POST …/product-order` 成功后调 `clearProductSalesCache()`。
- **公开列表响应**：除新增 `categoryId`、`sortOrder` 外，**既有字段一个不增不减不改名**（`isRecommended`、`createdAt` 只用于排序，输出前剥掉）。
- **后台列表 `pageSize` 上限从 50 提到 200**（仅 `routes/admin/products.ts`，公开接口仍 50）：拖拽保存要求 ids 是分类全集，后台在选定分类时必须一页取完。
- **换分类（spec 未写，本计划按 S6 精神处理）**：`PUT /api/admin/products/:id` 带 `categoryId` 且与现值不同时，`sortOrder` 取新分类当前最大值 +1（否则旧值 0 会让它跳到新分类最前）。
- 不动小程序（`apps/miniapp/**` 零改动）；不动 `Product.salesCount` 冗余列及其写入；不引第三方拖拽库（浏览器原生 `draggable`）。
- 每个任务结束前跑本任务的验收命令；提交信息中文（`feat/fix/test/docs`），尾注 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`；`git add` 只加白名单文件（`apps/server/scripts/kd100-*`、`docs/research/*`、`apps/miniapp/.cloudbase/` 等既有未跟踪文件一律不要加）。

## 允许修改的文件白名单

```
apps/server/prisma/schema.prisma                                            （只加两行字段）
apps/server/prisma/migrations/20260918000000_product_sort/migration.sql      （新建）
apps/server/src/services/product-sort.ts                                     （新建）
apps/server/src/services/product-sales.ts                                    （新建）
apps/server/src/routes/products.ts                                           （只改 GET / 列表处理器）
apps/server/src/routes/admin/products.ts                                     （只改：GET / 列表、POST / 创建的 sortOrder、PUT /:id 换分类的 sortOrder）
apps/server/src/routes/admin/categories.ts                                   （schema 加 productSortMode、PUT 清缓存、新增 product-order 路由）
apps/server/scripts/selftest-product-sort.ts                                 （新建）
scripts/e2e.d/65-product-sort.sh                                             （新建）
docs/api.md
docs/database.md
docs/staff-guide.md
apps/admin/src/types.ts
apps/admin/src/api/admin.ts
apps/admin/src/utils/reorder.ts                                              （新建）
apps/admin/src/utils/reorder.test.ts                                         （新建）
apps/admin/src/pages/Products.tsx
docs/superpowers/plans/2026-09-17-category-product-sort.md                    （本文件：勘误与验收记录）
```

**点名禁改**：
- `apps/miniapp/**`（S8：不改小程序也能生效；分类联动那批另走）。
- `apps/server/src/routes/admin/products.ts` 里与排序无关的逻辑：规格/SKU 校验与同步（`validateSpecs`、`aggregateFromSkus`、SKU diff）、多图、换分类的渠道跟随与 `assertNoUnpaidAndPurgeCarts`、`batch-status`、二维码两个路由、软删除。
- `apps/server/src/routes/products.ts` 的 `GET /:id` 详情、`packingFeeEach` 计算。
- `apps/server/src/routes/admin/stats/**`、`apps/server/src/utils/stats-scope.ts`（只引用，不改）。
- `apps/server/src/services/local-settings.ts`、`services/settings.ts`（只照抄写法，不改）。
- `apps/server/src/routes/categories.ts`（公开分类接口不需要暴露排序方式）。
- `apps/admin/src/pages/Categories.tsx`（排序方式的入口放在商品页工具条；分类编辑弹窗走 partial 更新，不带 `productSortMode` 就不会动它，无需改）。
- `apps/admin/src/components/ui/Table.tsx`（拖拽只挂在 `Products.tsx` 自持的 `<tr>` / 卡片上，不改通用表格组件）。
- `apps/server/prisma/seed.ts`、任何已存在的迁移目录。
- `docs/superpowers/specs/2026-09-17-category-product-sort-design.md`（执行方不改 spec；差异只记到本文件末尾的勘误小节，由 03 回判处理）。

## 上报触发条件（遇到即 BLOCKED，停下回报，不自行绕过）

1. 迁移在本地库 `npx prisma migrate deploy` 失败，或 `prisma migrate diff` 报库与 schema 有差异。
2. `utils/stats-scope.ts` 的 `REAL_ORDERS` 不是 `{ isTest: false }`，或热销榜（`overview.ts` 的 `hot` 聚合 / `shared.ts` 的 `paidOrdersWhere`）口径与本文件「销量口径」一段描述不符。
3. 内存排序需要改公开接口 `GET /api/products` 的既有响应字段（增、删、改名、改类型），spec 明确要加的 `categoryId` / `sortOrder` 除外。
4. 需要引第三方拖拽库，或浏览器原生 `draggable` 在后台的 `<tr>` 上无法工作、必须改 `Table.tsx`。
5. 需要改白名单外的任何文件。
6. `apps/admin` 的 `npm test` 在基线上就不绿（先在改动前跑一遍确认基线）。
7. 发现公开列表在本地实测单渠道商品数 > 500（spec §7 的阈值），或整表取回耗时肉眼可感（> 300ms）。
8. 干净库 e2e 出现与本批无关的红（先对照记忆里的已知偶发项，再回报，不要自行改别的分片）。
9. zod 版本下 `z.enum(PRODUCT_SORT_MODES)` 类型报错且改成 `z.enum([...PRODUCT_SORT_MODES])` 仍不过。

---

## Task 1（服务端）：迁移与 schema

**Files:** `prisma/migrations/20260918000000_product_sort/migration.sql`（新）、`prisma/schema.prisma`

依赖：无（**必须最先做**；Task 2–7 全部依赖它生成的 Prisma Client 类型）。

- [ ] **Step 1** 新建迁移文件，内容照 `20260916000000_packing_fee` / `20260917000000_order_tableware` 的口吻：
  ```sql
  -- 分类内商品排序（2026-09-17 设计 §3.1）：两处加列，都有默认值、不回填；存量全为 0 / MANUAL，
  -- 顾客端顺序靠 created_at 兜底 = 上线前顺序（S5）。纯加列，回滚代码不需要回滚库。
  ALTER TABLE `products` ADD COLUMN `sort_order` INT NOT NULL DEFAULT 0;
  ALTER TABLE `categories` ADD COLUMN `product_sort_mode` VARCHAR(16) NOT NULL DEFAULT 'MANUAL';
  ```
- [ ] **Step 2** `schema.prisma`：`model Product` 在 `isRecommended` 之后加 `sortOrder Int @default(0) @map("sort_order")`（注释：`// 分类内手动排序值，同分类从小到大；与 category.sortOrder 无关（2026-09-17 分类内排序设计 §3.1）`）；`model Category` 在 `channel` 之后加 `productSortMode String @default("MANUAL") @map("product_sort_mode") @db.VarChar(16)`（注释：`// MANUAL=按 products.sort_order 手动排；SALES_30D=近 30 天销量降序`）。**不加索引**（单分类几十行，不值一个索引；spec 也没要求）。
- [ ] **Step 3** 按 Global Constraints 建库 `food_shop_psort`，跑 `npx prisma migrate deploy` 与 `npx prisma db seed`，再 `npx prisma generate`。
- [ ] **Step 4** 验收：
  - `cd apps/server && DATABASE_URL=… npx prisma migrate status` 输出含 `Database schema is up to date!`。
  - `DATABASE_URL=… npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code` 退出码 0（库与 schema 无差异）。
  - `docker exec -i food-shop-mysql mysql -ufoodshop_user -pfoodshop_password food_shop_psort -e "SHOW COLUMNS FROM products LIKE 'sort_order'; SHOW COLUMNS FROM categories LIKE 'product_sort_mode';"` 两行各有 `Default` 为 `0` / `MANUAL`、`Null` 为 `NO`。
  - `npx tsc --noEmit -p apps/server/tsconfig.json` 通过。
- [ ] **Step 5** 提交 `feat(server): 商品 sort_order 与分类 product_sort_mode 两列迁移`。

## Task 2（服务端）：排序纯函数、销量聚合与缓存、自测

**Files:** `src/services/product-sort.ts`（新）、`src/services/product-sales.ts`（新）、`scripts/selftest-product-sort.ts`（新）

依赖：Task 1。

- [ ] **Step 1 先写 `scripts/selftest-product-sort.ts`**（照 `selftest-packing.ts` 的 `t()` 写法，头注释写运行命令 `cd apps/server && npx ts-node --transpile-only scripts/selftest-product-sort.ts`），只 import `product-sort.ts`，不起库。用例至少：
  1. 推荐置顶：两个分类各两道菜，其中分类 B 的一道 `isRecommended=1` → 它排第一，其余按分类顺序。
  2. 分类顺序：`category.sortOrder` 小的在前；`sortOrder` 相同按 `categoryId` 升序。
  3. `MANUAL`：同分类按商品 `sortOrder` 升序；`sortOrder` 相同按 `createdAt` 升序；再相同按 `id` 升序。
  4. `SALES_30D`：销量高的在前；无销量记 0 排最后；销量相同按 `sortOrder`、`createdAt`、`id`。
  5. 两种模式并存：分类 A `MANUAL`、分类 B `SALES_30D`，互不影响。
  6. 分类不在表里的商品排到最后，不抛错。
  7. 分页稳定：对同一输入连跑两次 `sortProducts` 结果 id 序列逐项相等；`slice(0,2)` 与 `slice(2,4)` 拼起来等于整体前 4 项。
  8. 纯函数：不修改传入数组（比较调用前后原数组的 id 序列）。
  跑一次看到全部失败（模块尚不存在）。
- [ ] **Step 2** 写 `src/services/product-sort.ts`：
  ```ts
  export const PRODUCT_SORT_MODES = ['MANUAL', 'SALES_30D'] as const
  export type ProductSortMode = (typeof PRODUCT_SORT_MODES)[number]
  export interface SortableProduct { id: number; categoryId: number; isRecommended: number; sortOrder: number; createdAt: Date }
  export interface CategorySortInfo { sortOrder: number; productSortMode: ProductSortMode }
  /** 返回新数组，不改入参。规则见 2026-09-17 设计 §4.1。 */
  export function sortProducts<T extends SortableProduct>(list: readonly T[], categories: ReadonlyMap<number, CategorySortInfo>, sales30d: ReadonlyMap<number, number>): T[]
  ```
  比较器按 Global Constraints「排序规则」逐字实现；文件头注释写明它是公开列表与后台列表共用的唯一实现。
- [ ] **Step 3** 写 `src/services/product-sales.ts`：
  ```ts
  const CACHE_TTL_MS = 60 * 1000
  let cached: { value: Map<number, number>; at: number } | null = null
  export async function getSales30d(): Promise<Map<number, number>>   // 聚合写法见 Global Constraints「销量口径」
  export function clearProductSalesCache(): void                        // 后台写排序后调用
  ```
  头注释写：口径与热销榜一致、为什么只缓存聚合不缓存列表、单进程 fork 下 clear 即时生效（同 `local-settings.ts` 的说明）。聚合失败（库异常）时 `console.warn` 并返回空 Map（排序退化为 `MANUAL` 兜底顺序），不让公开列表 500。
- [ ] **Step 4** 验收：`npx ts-node --transpile-only scripts/selftest-product-sort.ts` 全 ✔（≥ 8 例，退出码 0）；`npx tsc --noEmit -p apps/server/tsconfig.json` 通过。
- [ ] **Step 5** 提交 `feat(server): 分类内排序纯函数与近 30 天销量聚合缓存`。

## Task 3（服务端）：公开列表改内存排序

**Files:** `src/routes/products.ts`

依赖：Task 2。

- [ ] **Step 1** `GET /` 处理器：保留 `where` 构造不动；把 `prisma.$transaction([findMany(skip/take), count])` 改成 `Promise.all([ prisma.product.findMany({ where, select: 现有字段 + categoryId, sortOrder, isRecommended, createdAt }), prisma.category.findMany({ where: { channel }, select: { id, sortOrder, productSortMode } }), getSales30d() ])`。构造 `Map<categoryId, { sortOrder, productSortMode }>`（`productSortMode` 需 `as ProductSortMode`），`sortProducts(rows, catMap, sales)`，`total = sorted.length`，`slice((page-1)*pageSize, page*pageSize)`。
- [ ] **Step 2** 输出映射：在现有 `list.map(({ _count, ...p }) => …)` 里**同时剥掉 `isRecommended`、`createdAt`**，保留 `categoryId`、`sortOrder`。把原 `orderBy` 上那段注释改写成指向 `services/product-sort.ts` 的说明（为什么放内存：不同分类不同规则，SQL 一条 ORDER BY 表达不了；数据量小）。
- [ ] **Step 3** 验收（服务端起在 3112；`GET /api/products` 挂在 `verifyUserToken` 之前，不需要 token）：
  - `curl -s 'http://localhost:3112/api/products?channel=LOCAL&pageSize=1' | jq '.data.list[0] | has("categoryId") and has("sortOrder") and (has("isRecommended")|not) and (has("createdAt")|not)'` → `true`。
  - `curl -s 'http://localhost:3112/api/products?channel=EXPRESS&pageSize=50' | jq '.data.list | map(.id)'` 与改动前（基线起的同库同端口）输出**逐项相等**（S5：上线当天顺序不变）。做法：Task 1 之前先用基线代码起一次并把该输出存到 scratchpad，Task 3 完成后比对。
  - `jq '.data.total'` 与 `curl …pageSize=50 | jq '.data.list|length'` 一致（seed 数据 < 50 时）。
  - `npx tsc --noEmit -p apps/server/tsconfig.json` 通过。
- [ ] **Step 4** 提交 `feat(server): 公开商品列表按分类排序模式在内存排序并补 categoryId/sortOrder`。

## Task 4（服务端）：后台接口

**Files:** `src/routes/admin/categories.ts`、`src/routes/admin/products.ts`

依赖：Task 2（Task 3 与本任务无依赖，可并行，但同一 agent 顺序做）。

- [ ] **Step 1 `admin/categories.ts`**：
  - `categoryBaseSchema` 加 `productSortMode: z.enum(PRODUCT_SORT_MODES)`（不加 `.default()`，理由同文件头注释；`categoryCreateSchema` 也不加默认——库默认 `MANUAL` 兜底）。
  - `PUT /:id`：`data.productSortMode !== undefined && data.productSortMode !== exists.productSortMode` 时，更新后调 `clearProductSalesCache()`。
  - 新增 `POST /:id/product-order`（注册在 `DELETE /:id` 之前即可，无路径冲突）：
    - body `z.object({ ids: z.array(z.number().int().positive()) })`。
    - 校验：分类存在（否则 40401）；`tx.product.findMany({ where: { categoryId: id, deletedAt: null }, select: { id } })` 取全集；`ids.length !== set.size` 或 `new Set(ids).size !== ids.length` 或任一 id 不在全集 → `AppError(40001, '商品列表与该分类当前商品不一致，请刷新后重试')`。
    - 事务内 `for (i, pid) → tx.product.update({ where: { id: pid }, data: { sortOrder: i } })`；**全集查询与更新在同一 `prisma.$transaction(async tx => …)` 里**。
    - 成功后 `clearProductSalesCache()`，`success(res, { updated: ids.length })`。
- [ ] **Step 2 `admin/products.ts` 列表 `GET /`**：
  - `pageSize` 上限 `Math.min(200, …)`（注释：选定分类时后台要一页取完做拖拽）。
  - `categoryId` 有值时：`findMany({ where, include: 现有 })` 不带 `skip/take` → 取该分类 `{ sortOrder, productSortMode }` → `sortProducts(rows, new Map([[categoryId, info]]), sales)` → `total = sorted.length` → 内存切页。
  - `categoryId` 无值时：保持 `orderBy: { createdAt: 'desc' }` 与 `$transaction([findMany, count])` 原样。
  - 两条路径都把 `sales30d: sales.get(p.id) ?? 0` 挂到每一项（`getSales30d()` 只调一次）。
- [ ] **Step 3 `admin/products.ts` 创建 `POST /`**：`prisma.product.create` 之前取 `const { _max } = await prisma.product.aggregate({ where: { categoryId: rest.categoryId, deletedAt: null }, _max: { sortOrder: true } })`，`data` 里加 `sortOrder: (_max.sortOrder ?? -1) + 1`（空分类得 0，存量全 0 的分类得 1 → 排最后，S6）。
- [ ] **Step 4 `admin/products.ts` 更新 `PUT /:id`**：在既有 `if (rest.categoryId !== undefined)` 块里，增加 `rest.categoryId !== exists.categoryId` 时用 `tx.product.aggregate` 算新分类 `_max.sortOrder`，把 `sortOrder: max + 1` 并入 `channelPatch` 旁的补丁对象。**不动**渠道跟随与 `assertNoUnpaidAndPurgeCarts` 那几行。
- [ ] **Step 5** 验收（3112，`$AT` 管理员 token 照 e2e.sh 取法）：
  - `PUT /api/admin/categories/:id` body `{"productSortMode":"SALES_30D"}` → `code 0` 且 `data.productSortMode == "SALES_30D"`；body `{"productSortMode":"X"}` → `code 40001`；body `{"name":"改名"}` 不带 mode → 响应里 `productSortMode` 仍是 `SALES_30D`（partial 不重置）。
  - `POST /api/admin/categories/:id/product-order`：ids 为该分类全集的乱序 → `code 0`、`updated == 全集数`，随后 `GET /api/admin/products?categoryId=:id&pageSize=200` 的 `list|map(.id)` 与 ids 相同、`map(.sortOrder)` 为 `[0,1,2,…]`；少一个 / 多一个跨分类 id / 有重复 → 三次都 `40001`，且 `sortOrder` 未变。
  - `GET /api/admin/products?categoryId=:id` 每项 `has("sales30d")` 为 `true`；不带 `categoryId` 时也有 `sales30d` 且顺序仍是 `createdAt desc`。
  - `POST /api/admin/products`（该分类下新建）→ 响应 `sortOrder == 之前最大值 + 1`。
  - `npx tsc --noEmit -p apps/server/tsconfig.json` 通过。
- [ ] **Step 6** 提交 `feat(server): 后台分类排序方式、拖拽保存接口与列表 sales30d`。

## Task 5（服务端）：e2e 分片 §65 与接口/表结构文档

**Files:** `scripts/e2e.d/65-product-sort.sh`（新）、`docs/api.md`、`docs/database.md`

依赖：Task 3、Task 4。

- [ ] **Step 1** 写 `scripts/e2e.d/65-product-sort.sh`（照 `63-packing-fee.sh` 体例：`echo "== 65. …"`、变量 `P65_` 前缀、复用 `req/code/ok/fail/assert_eq/sql`、`$AT/$UT/$LPID`）。**自建 LOCAL 分类** `P65_CAT`（`sortOrder: 97`，不复用 `$LCAT`，同 §63 的理由），顺序建 A/B/C 三道菜（价 ¥10/¥20/¥30，`stock 99`，`netWeightG 300`），断言：
  1. `GET /api/products?channel=LOCAL&categoryId=$P65_CAT&pageSize=50` 顺序 `[A,B,C]`，每项有 `categoryId==$P65_CAT`、`sortOrder==0`，无 `isRecommended`/`createdAt`。
  2. `POST …/product-order {"ids":[C,A,B]}` → `code 0`、`updated 3`；公开列表顺序 `[C,A,B]`；后台列表 `sortOrder` 为 `[0,1,2]`。
  3. 三种非法 ids（缺 B / 多 `$LPID` / `[C,C,A]`）→ 各 `40001`；顺序仍 `[C,A,B]`。
  4. 新建 D → 响应 `sortOrder==3`，公开列表末位是 D。
  5. `PUT /api/admin/products/A {"isRecommended":1}` → 公开列表首位是 A，其余 `[C,B,D]`。
  6. 为 B 下 2 份、为 D 下 1 份自取单并模拟支付（照 §63 的 `pickup-slots` + `POST /api/orders` `directItem` + `POST /api/orders/:id/pay` 写法；自取前置参数照 §63 的 `p63_put` 那一段自行设置一次）。`PUT /api/admin/categories/$P65_CAT {"productSortMode":"SALES_30D"}` → `code 0`；公开列表顺序 `[A,B,D,C]`（A 推荐置顶，B 2 件 > D 1 件 > C 0 件）；后台列表 B 的 `sales30d==2`、C 的 `sales30d==0`。
  7. 把 B 的那张单 `sql "UPDATE orders SET is_test=1 WHERE id=…"`，再 `PUT` 一次 mode（先切回 `MANUAL` 再切 `SALES_30D`，两次写都清缓存）→ 公开列表顺序 `[A,D,B,C]` 或 `[A,D,C,B]` 之一（B、C 同为 0 件，按 sortOrder：C=0、B=2 → 期望 **`[A,D,C,B]`**）；断言这一确定值，锁住 `REAL_ORDERS` 口径。
  8. 切回 `MANUAL` → 公开列表 `[A,C,B,D]`（手动顺序仍在库里，S 风险表第 3 条）。
  9. 收尾：四道菜 `DELETE`（软删）、分类 `PUT {"status":0}`（有软删商品的分类不能硬删，FK 在）。
- [ ] **Step 2** `docs/api.md`：
  - `GET /api/products` 响应示例每项加 `"categoryId": 1, "sortOrder": 0`，并加一段「排序规则」（四条，指向 spec §4.1）。
  - `GET /api/admin/products` 加一句：`categoryId` 有值时顺序与顾客端一致，每项含 `sortOrder`、`sales30d`；`pageSize` 上限 200。
  - `PUT /api/admin/categories/:id` 加 `productSortMode` 字段说明；新增 `POST /api/admin/categories/:id/product-order` 小节（body、校验、40001 文案、清缓存）。
- [ ] **Step 3** `docs/database.md`：2.3 `categories` 表加 `product_sort_mode | VARCHAR(16) | NOT NULL DEFAULT 'MANUAL'`；2.4 `products` 表加 `sort_order | INT | NOT NULL DEFAULT 0`。
- [ ] **Step 4** 验收：干净库全量 e2e（Global Constraints 的命令）**0 红且日志含 `== 65.`**；`grep -c "product-order" docs/api.md` ≥ 2；`grep -n "product_sort_mode\|sort_order" docs/database.md` 各至少一行。
- [ ] **Step 5** 提交 `test(server): e2e §65 分类内排序；docs: 接口与表结构补记`。

## Task 6（后台）：类型、API、纯函数、商品页排序控件

**Files:** `src/types.ts`、`src/api/admin.ts`、`src/utils/reorder.ts`（新）、`src/utils/reorder.test.ts`（新）、`src/pages/Products.tsx`

依赖：Task 4（接口契约）。开工前先跑一次 `npm test --workspace=apps/admin` 与 `npm run build:admin` 确认基线绿（触发条件 6）。

- [ ] **Step 1** `types.ts`：`export const PRODUCT_SORT_MODES = ['MANUAL','SALES_30D'] as const; export type ProductSortMode = (typeof PRODUCT_SORT_MODES)[number]`；`Category` 加 `productSortMode: ProductSortMode`；`Product` 加 `sortOrder: number` 与 `sales30d?: number`。
- [ ] **Step 2** `api/admin.ts`：新增 `reorderCategoryProducts = (id: number, ids: number[]) => client.post<ApiResponse<{ updated: number }>>(`/admin/categories/${id}/product-order`, { ids })`。`updateCategory` 已是 `Partial<Category>`，类型补上后可直接传 `{ productSortMode }`。
- [ ] **Step 3 先写 `utils/reorder.test.ts`**（照 `utils/tableware.test.ts`：`node:test` + `node:assert/strict`，import 带 `.ts` 后缀），用例：`moveItem` 前移 / 后移 / 同位不变 / 越界不变 / 不改入参；`moveAdjacent(ids, index, -1|+1)` 首项上移不变、末项下移不变、中间项交换。再写 `utils/reorder.ts`：
  ```ts
  export function moveItem<T>(list: readonly T[], from: number, to: number): T[]
  export function moveAdjacent<T>(list: readonly T[], index: number, dir: -1 | 1): T[]
  ```
- [ ] **Step 4 `Products.tsx`**（只在选定具体分类、关键词为空、状态为「全部」时启用「排序区」；三者任一不满足则不渲染排序控件，理由：保存接口要求 ids 是分类全集）：
  - 派生 `const sortCategory = filterCategoryId ? channelCategories.find(c => String(c.id) === filterCategoryId) : undefined; const sortActive = !!sortCategory && !filterKeyword && !filterStatus`。
  - `load()`：`sortActive` 时 `pageSize` 用 **200** 且 `page` 固定 1；否则维持 20。加载后若 `total > list.length`（超过 200），排序区显示「本分类商品超过 200 道，暂不支持拖拽」并禁用把手/按钮（不上报，写 UI 兜底即可）。
  - 工具条（在「状态」筛选之后、搜索按钮之前）加「排序方式」`<select>`：`手动排序` / `按近 30 天销量`。`onChange` → `updateCategory(id, { productSortMode })` → 成功后更新本地 `categories` 里那条的 `productSortMode` 并 `load(1)`，`toast.success('已切换，顾客端最多 60 秒内生效')`；失败 `toast.error` 并把 select 值回退。
  - `SALES_30D` 时：表格「销量」列表头改为「近 30 天销量」，单元格显示 `p.sales30d ?? 0`；把手与 ↑↓ 禁用（`disabled` + `title="当前按销量自动排序，如需手动请切回手动排序"`），并在工具条 select 旁显示同一句灰字提示。
  - `MANUAL` 时：桌面表格每行**最左**加一列把手（`<td>` 内 `⋮⋮` 或 lucide `GripVertical`，`draggable` 挂在 `<tr>` 上，`onDragStart` 记 index、`onDragOver` `preventDefault`、`onDrop` 计算目标 index）；最右「操作」列前加「↑ / ↓」两个小按钮（移动端卡片也加这两个按钮，卡片不做拖拽）。`Table columns` 在 `sortActive` 时为 9，否则 8。
  - 保存：`const applyOrder = async (next: Product[]) => { const prev = list; setList(next); try { await reorderCategoryProducts(sortCategory.id, next.map(p => p.id)); toast.success('顺序已保存') } catch (err) { setList(prev); toast.error(接口 message ?? '保存失败，已恢复原顺序') } }`。拖放与 ↑↓ 都走 `applyOrder(moveItem/moveAdjacent(list, …))`；同位/越界（返回同一引用或等序）不发请求。
  - 「全部」分类视图与非 `sortActive` 状态：**零 UI 变化**（列数、列名、销量列显示 `salesCount` 原样）。
- [ ] **Step 5** 验收：`npm test --workspace=apps/admin` 全绿（含 `reorder.test.ts` ≥ 8 例）；`npm run build:admin` 通过；`grep -n "react-dnd\|dnd-kit\|sortablejs" apps/admin/package.json` 无输出（未引库）；`git diff --stat apps/admin/package.json` 为空。
- [ ] **Step 6** 提交 `feat(admin): 商品页按分类拖拽排序与排序方式切换`。

## Task 7（文档 + 收尾）

**Files:** `docs/staff-guide.md`、本文件

依赖：Task 5、Task 6。

- [ ] **Step 1** `docs/staff-guide.md` 在「六、上新菜品」之后加小节「六点一、菜的先后顺序怎么排」：选分类 → 排序方式两种 → 手动时拖把手或点 ↑↓、松手即存 → 按销量时的提示与「切回手动顺序还在」 → 新菜排最后 → 顾客端最多 60 秒生效 → 保存失败会自动恢复、刷新重排。口吻照六点七/六点八。
- [ ] **Step 2** 最终全量验收（按下方「验收标准」逐条跑），把结果与偏离追加到本文件「勘误与验收记录」。
- [ ] **Step 3** 提交 `docs: 店员手册补分类内排序`。

---

## 验收标准（只在此定义；04 机械核对按此打 PASS/FAIL）

### A 类（可脚本化）

| # | 命令（worktree 根执行；服务端需已按 Global Constraints 起在 3112） | 期望 |
|---|---|---|
| A1 | `ls apps/server/prisma/migrations/20260918000000_product_sort/migration.sql && grep -c "ADD COLUMN" $_` | 存在；输出 `2` |
| A2 | `grep -n "sort_order\|product_sort_mode" apps/server/prisma/migrations/20260918000000_product_sort/migration.sql` | 两行，各含 `NOT NULL DEFAULT`；无 `UPDATE`、无 `INDEX` |
| A3 | `cd apps/server && DATABASE_URL=… npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code` | 退出码 0 |
| A4 | `npx tsc --noEmit -p apps/server/tsconfig.json` | 无输出，退出码 0 |
| A5 | `cd apps/server && npx ts-node --transpile-only scripts/selftest-product-sort.ts` | 全 ✔，≥ 8 例，退出码 0 |
| A6 | `npm test --workspace=apps/admin` | 全 pass，含 `reorder` 用例 ≥ 8 |
| A7 | `npm run build:admin` | 退出码 0 |
| A8 | `curl -s 'http://localhost:3112/api/products?channel=LOCAL&pageSize=1' \| jq -e '.data.list[0] \| has("categoryId") and has("sortOrder") and (has("isRecommended")\|not) and (has("createdAt")\|not)'` | `true` |
| A9 | `BASE=http://localhost:3112 DB_NAME=food_shop_psort bash scripts/e2e.sh`（干净库） | 0 红；日志含 `== 65.` |
| A10 | `grep -n "isTest:" apps/server/src/services/product-sales.ts; grep -c "REAL_ORDERS" apps/server/src/services/product-sales.ts` | 第一条无输出（不手写字面量）；第二条 ≥ 1（口径只能 spread 自 `REAL_ORDERS`） |
| A11 | `grep -rln "sortProducts(" apps/server/src` | 恰好三个文件：`services/product-sort.ts`、`routes/products.ts`、`routes/admin/products.ts` |
| A12 | `git diff --name-only 9753a3e..HEAD` | 每一行都在白名单内；`apps/miniapp/` 零命中；`apps/admin/package.json`、`package-lock.json` 零命中 |
| A13 | `git diff 9753a3e..HEAD -- apps/server/src/routes/admin/products.ts \| grep -c "validateSpecs\|aggregateFromSkus\|assertNoUnpaidAndPurgeCarts\|batch-status\|qrcode"` | `0`（与排序无关逻辑未动） |
| A14 | `git log 9753a3e..HEAD --format=%B \| grep -c "Co-Authored-By: Claude Fable 5.1"` | 等于提交数 |

### B 类（行为判据，人工执行；后台指向 3112，小程序用开发者工具指向 3112 或用 `curl` 代替顾客端）

| # | 步骤 | 期望现象 |
|---|---|---|
| B1 | 后台商品页选「同城配送」→ 分类选一个有 ≥ 3 道菜的分类 → 排序方式「手动排序」→ 把第三道拖到第一 | 松手即出现「顺序已保存」；F5 刷新后顺序保持；`curl …/api/products?channel=LOCAL&categoryId=<id>` 首项就是它（该分类若有推荐菜，推荐菜仍在整个列表最前） |
| B2 | 同一分类点最后一道的「↑」 | 它与上一道互换并保存；「↓」反向；首项「↑」与末项「↓」不发请求、无提示 |
| B3 | 排序方式切「按近 30 天销量」 | 列表按销量重排，「销量」列变「近 30 天销量」且显示数字；把手与 ↑↓ 变灰、悬停提示「当前按销量自动排序，如需手动请切回手动排序」；顾客端接口 60 秒内顺序跟着变 |
| B4 | 切回「手动排序」 | 恢复 B1 拖出来的顺序（手动顺序没丢） |
| B5 | 在该分类下新建一道菜（手动模式） | 出现在本分类最后；顾客端也在该分类段末尾 |
| B6 | 另一个分类保持「手动排序」 | 不受 B3 影响，顺序不变 |
| B7 | 分类选「全部」 | 工具条无「排序方式」；表格 8 列、无把手、无 ↑↓、「销量」列仍是累计销量 |
| B8 | 分类选定但关键词非空或状态选「上架」 | 排序控件不出现（提示不必有） |
| B9 | 手动模式下断开服务端（停掉 3112）再拖一次 | 顺序回滚到拖之前，红色提示保存失败 |
| B10 | 部署前后对比：基线代码与新代码在同一库上 `curl …/api/products?channel=EXPRESS&pageSize=50 \| jq '.data.list\|map(.id)'` | 逐项相等（S5：上线当天顾客端顺序不变） |

## 上线顺序

服务端 + 后台一批（`deploy.sh` 自动备份 → `prisma migrate deploy` 两条 `ADD COLUMN` → 编译 → 发布后台）。零小程序改动，顾客端当天生效。回滚：代码回上一版 SHA 即可，两列留着无害。上线后店主按 B1–B7 验一遍。与 `2026-09-17-category-anchor-design.md`（分类页左右联动）互不依赖；该批的小程序改动在其后单独提审。

## 复核与收尾（02–04）

- **02 复核 · opus（新会话）只给三样输入**：① 原始需求 = `docs/superpowers/specs/2026-09-17-category-product-sort-design.md` 全文；② 最终 diff = `git diff 9753a3e..HEAD`（不给本计划的 Task 推理、不给执行对话历史）；③ 本文件「验收标准」一节（A1–A14、B1–B10）。要求输出问题清单，每条标 [阻断/需改/建议] 并指明违反哪条验收标准；无问题明确写「无阻断项」。
- **03 回判 · fable**：输入需求 + 本计划 + 02 清单，逐条判 [成立/误判/需澄清]；同时处理下方「spec 与现状差异」①–⑤（是否要 spec 勘误由店主定，回判只给建议）。
- **04 机械核对 · haiku**：输入本文件「分步改动清单」+ 最终 diff，只跑 A1–A14 与白名单核对，不调模型判断。
- 每次交接在报告首行声明「工序 0X · 模型」。

## spec 与现状差异（00 规划时发现，未改 spec，留给 03 回判 / 店主）

1. **spec §7「取消/退款的单不在内（与后台热销榜一致）」两句互相矛盾**：热销榜 `paidOrdersWhere` 只过滤 `paidAt` 区间 + `isTest=false`，**不看订单 status、已付后退款/取消的单仍计**。本计划按「与热销榜一致」执行（付款即计），§7 那半句文案不成立。
2. **spec §4.1「列表同样加 60 秒缓存，缓存键含渠道、分类、关键词」**：公开列表现在是零缓存；若整份列表缓存 60 秒，后台的上下架 / 一键收档 / 改库存 / 改价与顾客下单扣库存都会在顾客端滞后最多 60 秒（spec 只写了排序写操作清缓存），是可见的回归。本计划**收窄为只缓存销量聚合**，列表现查；spec 承诺的「后台改完立刻见效」「顾客端 60 秒内生效」都仍成立。若店主坚持缓存整份列表，需追加：`admin/products.ts` 全部写路径、`admin/categories.ts` 写路径、`services/product-channel.ts`、下单扣库存处都要接 clear——那会把白名单扩大到本批之外。
3. **spec §6A「新增服务端单测 sortProducts」**：`apps/server` 没有测试脚本与 `*.test.ts`，项目惯例是 `scripts/selftest-*.ts` 手跑；本计划按惯例（A5）。`npm test --workspace=apps/admin` 存在（`node --test src/*.test.ts src/utils/*.test.ts`），新测试放 `src/utils/` 才会被跑到。
4. **spec 未写换分类时 `sort_order` 怎么处理**：`PUT /api/admin/products/:id` 换 `categoryId` 后旧值（多为 0）会让它跳到新分类最前。本计划按 S6 精神取新分类最大值 +1。
5. **spec §5 只说「全部分类」时不显示控件**：关键词 / 状态筛选同样会让列表不是分类全集，保存接口会 40001。本计划把启用条件收紧为「选定分类 且 关键词为空 且 状态为全部」，并把后台 `pageSize` 上限提到 200 一页取完（> 200 道时 UI 禁用并提示）。

## 勘误与验收记录（执行时追加）

（空）
