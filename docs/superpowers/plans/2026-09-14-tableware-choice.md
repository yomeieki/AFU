# 结算页餐具选择 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **工序声明**：本文件是「模型分工协议」的 **00 规划** 产物，等级 **M**（三端各一步，服务端一次小迁移，另有旧版客户端兼容）。
> 后续：01 执行 · sonnet（逐任务子代理）→ 任务级复核（钱与兼容路径用 opus）→ 02 复核 · opus（新会话，只给需求 + 最终 diff）→ 03 回判 → 04 机械核对 · haiku。验收标准只在本文件定义。

**Goal:** 同城外送与到店自取结算页必选餐具（无需 / 需要·按餐量 / 需要·1–10 份），免费，按顾客记住上次选择；选择存进订单独立字段，小票两联、工作台、订单详情、同城订单列表各显示一行。

**Architecture:** 服务端 `services/tableware.ts` 是餐具的唯一规则来源（zod 校验、旧版备注前缀兼容、落库列、两套文案）；下单时写 `orders.tableware_mode / tableware_count`，其余端只读这两列。小程序新增 `components/tableware-sheet` 弹层组件（两个结算页共用）与 `utils/tableware.js`（ES5 纯函数）；两个按钮状态工具各加一个「请选择餐具」状态，动作 `tableware` 打开弹层。后台加 `utils/tableware.ts` 文案函数，工作台卡片/抽屉与同城订单列表各显示一行。

**Tech Stack:** Express + Prisma/MySQL + zod 4；微信原生小程序（ES5，`node scripts/check-miniapp-es5.mjs <file>`）；React 18 + Vite 后台。

**Spec:** `docs/superpowers/specs/2026-09-14-tableware-choice-design.md`（决策 T1–T10）。

---

## Global Constraints（每个任务隐含包含本节）

- 工作目录 `/Users/yumingyi/food-shop/.claude/worktrees/tableware`（分支 `claude/tableware`，基线 main fd678ea）。不要 cd 到主检出；不要 `git stash`。
- 独立库 `food_shop_tableware`，服务端口 **3111**（`apps/server/.env` 已配好，mock 全开、`SCHEDULER_DISABLED=true`）。启动：`cd apps/server && PORT=3111 npx ts-node-dev --respawn --transpile-only src/app.ts`。**e2e 只能在干净库跑**：`/tmp/tableware-e2e-fresh.sh [logfile]`（约 5–8 分钟，timeout ≥ 600000）。
- **取值（逐字）**：`mode ∈ {'NONE','BY_MEAL','COUNT'}`；`count` 仅 `COUNT` 时为 1–10 的整数，其余情况不得出现。
- **订单列**：Prisma `tablewareMode String? @db.VarChar(16) @map("tableware_mode")`、`tablewareCount Int? @map("tableware_count")`；迁移目录 `20260917000000_order_tableware`。
- **接口字段名**：订单对象 `tablewareMode` / `tablewareCount`；工作台卡片 `tableware: { mode, count } | null`；新接口 `GET /api/orders/tableware-last` → `{ mode, count } | null`；下单 body `tableware?: { mode, count? }`。
- **文案（逐字）**：
  - 界面（小程序、工作台、后台）：`NONE` →「无需餐具」；`BY_MEAL` →「需要餐具 · 按餐量」；`COUNT` →「需要餐具 · N 份」；null →「」（不显示）。中间是空格 + `·` + 空格。
  - 小票：`NONE` →「无需餐具」；`BY_MEAL` →「餐具：按餐量」；`COUNT` →「餐具：N 份」；null → 不印。
  - 弹层：标题「是否需要餐具」、「关闭」、「需要餐具」、「无需餐具」+ 绿色小字「环保助力」、「餐具数量」、「商家按餐量提供」、「N 份」、「确定」。
  - 结算页行：标签「餐具」，未选时右侧「请选择」（品牌色）。按钮新状态文案「请选择餐具」。
- **服务端不强制**：`LOCAL/PICKUP` 不带 `tableware` 也建单（两列 null）；`EXPRESS` 带了也忽略（两列 null）。
- **旧版前缀兼容**：请求体 `remark` 以 `/^\[需要餐具\]\s*/` 开头时，在 zod 解析**之前**剥掉；若同一请求没有 `tableware`，补 `{ mode: 'BY_MEAL' }`；剥完为空串则 `remark` 视为未填。
- **免费**：任何金额明细（结算页、小票、工作台、订单详情）都不出现餐具行。
- 老渠道零行为变化：邮寄结算页、邮寄小票、`apps/admin/src/pages/Orders.tsx` 不出现餐具。
- 发给运力方的骑手备注（`services/delivery/orchestrator.ts`）不改。
- 每个任务结束前跑本任务的测试；提交信息中文（`feat/fix/test/docs`），尾注 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`；`git add` 只加白名单文件。

## 允许修改的文件白名单

```
apps/server/prisma/schema.prisma
apps/server/prisma/migrations/20260917000000_order_tableware/migration.sql   （新建）
apps/server/src/services/tableware.ts                                        （新建）
apps/server/src/routes/orders.ts
apps/server/src/routes/admin/orders.ts
apps/server/src/routes/admin/workbench.ts
apps/server/src/services/ticket/{index,content}.ts
apps/server/scripts/selftest-tableware.ts                                    （新建）
apps/server/scripts/selftest-member.ts
scripts/e2e.d/64-tableware.sh                                                （新建）
docs/api.md
apps/miniapp/utils/tableware.js                                              （新建）
apps/miniapp/utils/{local-checkout-state,pickup-checkout-state}.js
apps/miniapp/components/tableware-sheet/index.{js,json,wxml,wxss}           （新建）
apps/miniapp/pages/local/{confirm,pickup}.{js,json,wxml,wxss}
apps/miniapp/pages/order/detail.{js,wxml}
apps/miniapp/api/order.js
tests/miniapp/tableware.test.cjs                                             （新建）
tests/miniapp/{local-checkout-state,pickup-checkout-state}.test.cjs
tools/miniapp-preview/serve.mjs
tools/miniapp-preview/index.html
tools/miniapp-preview/pages/{local-confirm,local-pickup,local-tableware-sheet}.html   （最后一个新建）
apps/admin/src/utils/tableware.ts                                            （新建）
apps/admin/src/utils/tableware.test.ts                                       （新建）
apps/admin/src/types.ts
apps/admin/src/pages/{Workbench,LocalOrders}.tsx
apps/admin/src/pages/Workbench.css
docs/staff-guide.md
docs/miniapp-release-checklist.md
docs/design/workbench-ui-spec.md
docs/superpowers/specs/2026-09-14-tableware-choice-design.md                 （仅勘误）
docs/superpowers/plans/2026-09-14-tableware-choice.md                         （本文件：勘误与验收记录）
```

## 上报触发条件（遇到即 BLOCKED）

1. 需要改白名单之外的文件。
2. zod 版本不支持本计划写法（先看 `apps/server/package.json` 的 zod 版本再动手）。
3. 在 `orders.ts` 里发现备注/下单 body 还有别的预处理路径，与「解析前剥前缀」冲突。
4. e2e 干净库跑出与餐具无关的红（先对照记忆：脏库 §35/§45/§59/§60 会假红）。
5. 按钮状态插入后，既有测试用例的**期望值**（不是 fixture）需要改动才能通过——说明优先级放错了。
6. 任务间接口与本计划 Interfaces 不一致。

---

## Task 1（服务端）：数据列、规则模块、下单接线、记住接口、工作台/后台透传

**Files:** `prisma/schema.prisma`、`prisma/migrations/20260917000000_order_tableware/migration.sql`、`services/tableware.ts`（新）、`routes/orders.ts`、`routes/admin/orders.ts`、`routes/admin/workbench.ts`、`scripts/selftest-tableware.ts`（新）

**Interfaces（Produces）:**
```ts
// services/tableware.ts
export const TABLEWARE_MODES: readonly ['NONE', 'BY_MEAL', 'COUNT']
export type TablewareMode = 'NONE' | 'BY_MEAL' | 'COUNT'
export const TABLEWARE_MAX: 10
export const tablewareSchema: z.ZodType<{ mode: TablewareMode; count?: number }>
export function applyLegacyTablewarePrefix(body: unknown): unknown
export function tablewareColumns(deliveryType: string, t: { mode: TablewareMode; count?: number } | undefined): { tablewareMode: TablewareMode | null; tablewareCount: number | null }
export function tablewareLabel(mode: string | null | undefined, count: number | null | undefined): string        // 界面文案
export function tablewareTicketText(mode: string | null | undefined, count: number | null | undefined): string   // 小票文案
```

- [ ] **Step 1 迁移**：`schema.prisma` 的 Order 在 `remark` 那一行之后加：
  ```prisma
  /// 餐具（2026-09-14 餐具选择设计）：NONE / BY_MEAL / COUNT；null = 未记录（邮寄单、老订单、旧版客户端未选）
  tablewareMode  String?  @map("tableware_mode") @db.VarChar(16)
  /// 仅 COUNT 时为 1–10
  tablewareCount Int?     @map("tableware_count")
  ```
  `migration.sql`：
  ```sql
  ALTER TABLE `orders` ADD COLUMN `tableware_mode` VARCHAR(16) NULL;
  ALTER TABLE `orders` ADD COLUMN `tableware_count` INT NULL;
  ```
  `cd apps/server && npx prisma migrate deploy && npx prisma generate`。

- [ ] **Step 2 先写 `scripts/selftest-tableware.ts`**（照 `selftest-packing.ts` 的 `t()` 写法），至少这些例：
  1. `tablewareLabel('NONE', null)` = `无需餐具`；`('BY_MEAL', null)` = `需要餐具 · 按餐量`；`('COUNT', 3)` = `需要餐具 · 3 份`；`(null, null)` = `''`。
  2. `tablewareTicketText` 同四例：`无需餐具` / `餐具：按餐量` / `餐具：3 份` / `''`。
  3. `tablewareSchema.safeParse`：`{mode:'COUNT',count:3}` 成功；`{mode:'COUNT'}`、`{mode:'COUNT',count:0}`、`{mode:'COUNT',count:11}`、`{mode:'COUNT',count:1.5}`、`{mode:'BY_MEAL',count:2}`、`{mode:'XX'}` 全部失败。
  4. `applyLegacyTablewarePrefix`：`{remark:'[需要餐具] 不要辣'}` → `remark:'不要辣'`、`tableware:{mode:'BY_MEAL'}`；无空格 `'[需要餐具]不要辣'` 同样；`{remark:'[需要餐具] '}` → `remark` 为 `undefined`；已带 `tableware:{mode:'NONE'}` 时保留 NONE 只剥前缀；`{remark:'不要辣'}` 原样返回（同一对象引用）；非对象（`null`、数组）原样返回。
  5. `tablewareColumns`：`('EXPRESS', {mode:'NONE'})` → 两列 null；`('PICKUP', undefined)` → 两列 null；`('LOCAL', {mode:'COUNT',count:2})` → `COUNT/2`；`('PICKUP', {mode:'BY_MEAL'})` → `BY_MEAL/null`。
  跑 `npx ts-node --transpile-only scripts/selftest-tableware.ts` 看到失败。

- [ ] **Step 3 写 `services/tableware.ts`**：
  ```ts
  /**
   * 餐具规则的唯一来源（2026-09-14 餐具选择设计）。
   * 纯模块，不 import prisma：下单校验、落库列、小票与工作台文案都从这里取，selftest 不起库就能跑。
   */
  import { z } from 'zod'

  export const TABLEWARE_MODES = ['NONE', 'BY_MEAL', 'COUNT'] as const
  export type TablewareMode = (typeof TABLEWARE_MODES)[number]
  export const TABLEWARE_MAX = 10

  export const tablewareSchema = z
    .object({
      mode: z.enum(TABLEWARE_MODES, { message: '餐具选项无效' }),
      count: z.number().int('餐具份数为 1–10 份').min(1, '餐具份数为 1–10 份').max(TABLEWARE_MAX, '餐具份数为 1–10 份').optional(),
    })
    // 指定份数时必须带 count；其余两种不得带——带了说明客户端状态机错位，宁可拒也不猜
    .refine((t) => (t.mode === 'COUNT') === (t.count !== undefined), { message: '指定餐具份数时请填写 1–10 份' })

  /** 旧版小程序把「需要餐具」拼在备注前面（占掉 20 字里的 7 个）。服务端在 zod 解析之前剥掉并补成按餐量（T9） */
  export const LEGACY_TABLEWARE_PREFIX = /^\[需要餐具\]\s*/

  export function applyLegacyTablewarePrefix(body: unknown): unknown {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body
    const b = body as Record<string, unknown>
    if (typeof b.remark !== 'string' || !LEGACY_TABLEWARE_PREFIX.test(b.remark)) return body
    const remark = b.remark.replace(LEGACY_TABLEWARE_PREFIX, '')
    return { ...b, remark: remark || undefined, tableware: b.tableware ?? { mode: 'BY_MEAL' } }
  }

  export function tablewareColumns(
    deliveryType: string,
    t: { mode: TablewareMode; count?: number } | undefined,
  ): { tablewareMode: TablewareMode | null; tablewareCount: number | null } {
    // 邮寄单没有餐具（T1）；同城/自取没选（旧版客户端）也不拒单，记 null（T9）
    if ((deliveryType !== 'LOCAL' && deliveryType !== 'PICKUP') || !t) return { tablewareMode: null, tablewareCount: null }
    return { tablewareMode: t.mode, tablewareCount: t.mode === 'COUNT' ? (t.count ?? null) : null }
  }

  export function tablewareLabel(mode: string | null | undefined, count: number | null | undefined): string {
    if (mode === 'NONE') return '无需餐具'
    if (mode === 'BY_MEAL') return '需要餐具 · 按餐量'
    if (mode === 'COUNT' && count) return `需要餐具 · ${count} 份`
    return ''
  }

  export function tablewareTicketText(mode: string | null | undefined, count: number | null | undefined): string {
    if (mode === 'NONE') return '无需餐具'
    if (mode === 'BY_MEAL') return '餐具：按餐量'
    if (mode === 'COUNT' && count) return `餐具：${count} 份`
    return ''
  }
  ```
  zod 4 的 `z.enum(values, { message })` 若在本仓库版本下类型报错，改用 `{ error: '餐具选项无效' }`，并在报告里写明。跑 selftest 通过。

- [ ] **Step 4 下单接线**（`routes/orders.ts`）：
  1. `import { tablewareSchema, applyLegacyTablewarePrefix, tablewareColumns } from '../services/tableware'`。
  2. `createOrderSchema` 的 object 里、`remark` 之后加 `tableware: tablewareSchema.optional(),`（refine 链不动——餐具自身的校验已在 `tablewareSchema` 内部）。
  3. handler 解构加 `tableware`，解析改成 `createOrderSchema.parse(applyLegacyTablewarePrefix(req.body))`。
  4. `tx.order.create` 的 `remark,` 下一行加 `...tablewareColumns(deliveryType, tableware),`。
  5. `orderCreatedView` 返回体在 `packingFee` 附近加 `tablewareMode: order.tablewareMode, tablewareCount: order.tablewareCount,`（幂等重放走同一函数）。
  6. 在 `GET /pickup-contact` 之后、`GET /:id` 之前加：
  ```ts
  // GET /api/orders/tableware-last — 该顾客最近一次选过的餐具，结算页预填用（餐具设计 T6，不加表）。
  // 只看同城/自取且列不为空的单：邮寄单、旧版客户端没选的单不会把上一次的选择冲掉。
  router.get('/tableware-last', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const last = await prisma.order.findFirst({
        where: { userId: req.userId!, deliveryType: { in: ['LOCAL', 'PICKUP'] }, tablewareMode: { not: null } },
        orderBy: { id: 'desc' },
        select: { tablewareMode: true, tablewareCount: true },
      })
      success(res, last ? { mode: last.tablewareMode, count: last.tablewareCount } : null)
    } catch (e) {
      next(e)
    }
  })
  ```
- [ ] **Step 5 透传**：`routes/admin/orders.ts` 的 `orderListSelect` 在 `remark: true,` 后加 `tablewareMode: true, tablewareCount: true,`。`routes/admin/workbench.ts` 的 `toCard` 在 `note: o.remark || null,` 后加 `tableware: o.tablewareMode ? { mode: o.tablewareMode, count: o.tablewareCount } : null,`（先确认 `OrderRow` 的查询是 `include` 全列；若是显式 select，按同文件写法把两列加进去——该文件在白名单内）。
- [ ] **Step 6** `npx tsc --noEmit -p .`、`selftest-tableware.ts`、`selftest-member.ts` 全过；提交 `feat(server): 餐具订单列、规则模块、下单接线与上次选择接口`。

## Task 2（服务端）：小票、e2e §64、接口文档

**Files:** `services/ticket/{index,content}.ts`、`scripts/selftest-member.ts`、`scripts/e2e.d/64-tableware.sh`（新）、`docs/api.md`

**Interfaces（Consumes）:** Task 1 的 `tablewareTicketText`、订单列、`GET /api/orders/tableware-last`、下单 body `tableware`。

- [ ] **Step 1 票面数据**：`ticket/index.ts` 的 `OrderForTicket` 类型加 `tablewareMode: string | null; tablewareCount: number | null`，`ORDER_SELECT` 加 `tablewareMode: true, tablewareCount: true`，`toTicketInput` 加 `tablewareMode: order.tablewareMode, tablewareCount: order.tablewareCount,`（三处缺一处就永远不印且没有编译错误——该文件注释已警告）。
- [ ] **Step 2 票面渲染**：`content.ts`
  - `TicketOrderInput` 在 `remark` 之后加：
    ```ts
    /** 餐具（2026-09-14 餐具设计 §4.5）。取餐/配送联在收件信息块之后、备注之前印一行；厨房联紧跟尾号印同一行；邮寄与老单为 null 不印 */
    tablewareMode?: string | null
    tablewareCount?: number | null
    ```
  - `import { tablewareTicketText } from '../tableware'`。
  - 删掉「规格 §8b 提到的『餐具标记』目前 Order 无对应字段……」那两行过期注释，改写成一句说明餐具已独立成行。
  - 在 `remarkBlock` 定义之前加：
    ```ts
    // 餐具单独成行、不进备注：票面超长时第⑤步只压缩备注，这一行永不截断——装袋的人少放一份餐具就是一条差评
    const tablewareText = tablewareTicketText(o.tablewareMode, o.tablewareCount)
    const tablewareBlock: string[] = tablewareText ? [`<B>${tablewareText}</B>`] : []
    ```
  - `buildKitchen` 在尾号那一行之后、`HR` 之前插 `...tablewareBlock,`。
  - `deliveryOf` 改为 `assemble([...header, ...receiverBlock, ...tablewareBlock, ...remarkBlock, ...itemLines, ...footer])`。
- [ ] **Step 3 selftest-member**（文件末尾 `console.log` 之前追加，照「自取小票」用例约 326 行的 `renderOrderTicket({...})` 写法）：
  1. **顺序**：复制「自取小票」那条的入参，改 `remark: '不要辣'`、加 `tablewareMode: 'COUNT', tablewareCount: 3`。断言 `(s.match(/<B>餐具：3 份<\/B>/g) ?? []).length === 2`；设 `a = s.indexOf('<B>餐具：3 份</B>')`、`b = s.indexOf('<B>餐具：3 份</B>', a + 1)`，断言 `s.indexOf('取餐人') < a`、`a < s.indexOf('<CB>备注：不要辣</CB>')`、`s.indexOf('<CB>厨房联</CB>') < b`。
  2. `tablewareMode: 'NONE'`（其余同上）→ `s.includes('<B>无需餐具</B>')`。
  3. 不传两列 → `!s.includes('餐具')`。
  4. **压缩到第⑤步仍保留**：现有用例没有一条走到第⑤步（它要求配送联把件数减到 0 后仍超 5000 字节），必须新造。用 `mkTicket({ receiverPoiName: '长'.repeat(1700), remark: '一二三四五六七八九十一二三四五六七八九十', tablewareMode: 'BY_MEAL', items: <30 件 { productName: '凉拌黑木耳', specText: null, quantity: 1, subtotal: 1200 }> })`（同城双联；1700 个汉字 ≈ 5100 字节，单凭地址就超限）。断言 `/<CB>备注：[^<]*…<\/CB>/.test(s)`（证明第⑤步真的执行了）且 `(s.match(/<B>餐具：按餐量<\/B>/g) ?? []).length === 2`。若该入参仍到不了第⑤步（第一条断言红），不许删断言凑绿——在报告里写明实测字节数并按上报触发条件处理。
  跑 `selftest-member.ts` 全过。
- [ ] **Step 4 e2e**：新建 `scripts/e2e.d/64-tableware.sh`（照 `63-packing-fee.sh` 的写法，变量前缀 `P64_`，复用 `req/code/ok/fail/assert_eq/sql/PJOBS/lquote/$UT/$AT/$LADDR/$LCAT`；`e2e.sh` 用 `for f in e2e.d/*.sh` 自动加载，**不改** `e2e.sh`）。自建一个同城商品（不复用 `$LPID`）；前置按 §63 的 `p63_put` 写法开通自取并钉死营业时段、起送线、`.packing.enabled=false`（本段不验打包费）。断言：
  **四个面的取数写法（①②④ 每种模式都要过这四个面）**：
  - 下单响应：`jq -r '.data.tablewareMode, .data.tablewareCount'`。
  - 顾客详情：`GET /api/orders/$ID`（`$UT`）。
  - 后台列表：**必须带渠道参数**，不带时默认只查 EXPRESS（`admin/orders.ts` 约 85 行）。写法 `req GET "/api/admin/orders?deliveryType=PICKUP&pageSize=50" "$AT" | jq -c "[.data.list[] | select(.id==$ID)][0]"`；同城外送单用 `deliveryType=LOCAL`。
  - 工作台卡片：快照只收**已付款**单，且有 3 秒缓存。先 `req POST "/api/orders/$ID/pay" "$UT" >/dev/null`，再 `req GET "/api/admin/workbench/snapshot?fresh=1" "$AT" | jq -c "[.data.columns[][] | select(.orderId==$ID)][0]"`（遍历所有列，不假设落在 pending）；先断言结果非 `null`（`[[ "$CARD" != "null" && -n "$CARD" ]] && ok … || fail …`，照 §62 ⑨），再断言 `.tableware`。
  1. 自取单 `tableware:{mode:"NONE"}` → 下单响应 `tablewareMode=NONE`、`tablewareCount=null`；顾客详情、后台列表同值；付款后工作台卡片 `.tableware.mode=NONE`、`.tableware.count=null`。
  2. 自取单 `{mode:"COUNT",count:3}` → 下单响应 `COUNT/3`；顾客详情、后台列表同值；付款后工作台卡片 `.tableware.mode=COUNT`、`.tableware.count=3`。
  3. 校验：`{mode:"COUNT"}`、`count:0`、`count:11`、`{mode:"BY_MEAL",count:2}`、`{mode:"XX"}` 下单均为 40001。
  4. 同城外送单（照 §63 ④ 的 `lquote $LADDR` + `LQTOKEN` 写法）带 `{mode:"BY_MEAL"}` → 下单响应 `BY_MEAL/null`；顾客详情、后台列表（`deliveryType=LOCAL`）同值；付款后工作台卡片 `.tableware.mode=BY_MEAL`、`.tableware.count=null`。
  5. 旧版前缀：自取单不带 `tableware`，`remark` 为 `"[需要餐具] 一二三四五六七八九十一二三四"`（前缀 7 字 + 14 字，共 21 字）→ code 0、落库 `remark=一二三四五六七八九十一二三四`、`tablewareMode=BY_MEAL`。
  6. 不带 `tableware`、备注无前缀的自取单 → `tablewareMode=null`。
  7. 邮寄单带 `tableware:{mode:"NONE"}` → 两列 null。
  8. `GET /api/orders/tableware-last`：在 ⑦ 之后仍返回 ⑥ 之前最近一张非空单的选择（按上面顺序应为 ⑤ 的 `BY_MEAL`）。
  9. 小票：按 §63 ⑧ 的写法临时配 mock 打印机，付款一张 `COUNT/3` 自取单，`NEW_ORDER` 票面 `grep -o "餐具：3 份" | wc -l` = 2；付款一张 `NONE` 单，票面含 `无需餐具`。
  收尾：恢复本段改过的同城设置与打印机设置；把本段所有 `PAID` 未接单的单 `UPDATE ... status='CANCELLED'`（照 §63 收尾），删 `print_jobs`，标 `is_test=1`。
  用 `/tmp/tableware-e2e-fresh.sh /tmp/tableware-e2e-task2.log` 跑全量，必须 0 红（把尾行与 §64 段输出摘进报告）。
- [ ] **Step 5 文档**：`docs/api.md` 末尾加「附录 J：餐具选择」：下单 body `tableware` 取值与 40001 规则；旧前缀兼容；`GET /api/orders/tableware-last`；订单对象 `tablewareMode/tablewareCount`；工作台卡片 `tableware`；小票两联位置；免费不进金额。
- [ ] **Step 6** `npx tsc --noEmit -p .`、`selftest-member.ts`、干净库 e2e 全过；提交 `feat(server): 餐具小票两联、e2e §64 与接口文档`。

## Task 3（小程序）：工具、弹层组件、两个结算页、订单详情、单测、预览

**Files:** `utils/tableware.js`（新）、`utils/{local-checkout-state,pickup-checkout-state}.js`、`components/tableware-sheet/*`（新）、`pages/local/{confirm,pickup}.{js,json,wxml,wxss}`、`pages/order/detail.{js,wxml}`、`api/order.js`、`tests/miniapp/{tableware,local-checkout-state,pickup-checkout-state}.test.cjs`、`tools/miniapp-preview/{serve.mjs,index.html,pages/*}`

**Interfaces（Consumes）:** `GET /api/orders/tableware-last`、下单 body `tableware`、订单 `tablewareMode/tablewareCount`。

- [ ] **Step 1 先写 `tests/miniapp/tableware.test.cjs`**：`tablewareLabel` 四例（同 Global Constraints 界面文案）；`normalizeTableware`：`{mode:'NONE'}`→`{mode:'NONE'}`，`{mode:'BY_MEAL',count:3}`→`{mode:'BY_MEAL'}`（丢掉多余 count），`{mode:'COUNT',count:3}`→原样，`{mode:'COUNT',count:0}`/`11`/`'3'`/缺失→`null`，`null`/`{mode:'XX'}`→`null`；`stepCount(1,-1)=1`、`stepCount(10,1)=10`、`stepCount(3,1)=4`、`stepCount(undefined,1)=2`。
- [ ] **Step 2 写 `utils/tableware.js`**（ES5）：
  ```js
  // 餐具选择的纯函数（2026-09-14 餐具设计）。文案与服务端 services/tableware.ts 的 tablewareLabel 逐字一致。
  // ⚠️ 本文件必须保持 ES5（scripts/check-miniapp-es5.mjs 把守）。
  var MAX = 10

  function tablewareLabel(mode, count) {
    if (mode === 'NONE') return '无需餐具'
    if (mode === 'BY_MEAL') return '需要餐具 · 按餐量'
    if (mode === 'COUNT' && count) return '需要餐具 · ' + count + ' 份'
    return ''
  }

  /** 服务端返回或本地状态 → 可以直接提交的形状；不合法一律 null（按「没选」处理，比猜一个值安全） */
  function normalizeTableware(v) {
    if (!v || typeof v !== 'object') return null
    if (v.mode === 'NONE' || v.mode === 'BY_MEAL') return { mode: v.mode }
    if (v.mode === 'COUNT' && typeof v.count === 'number' && v.count >= 1 && v.count <= MAX && Math.floor(v.count) === v.count) {
      return { mode: 'COUNT', count: v.count }
    }
    return null
  }

  function stepCount(count, delta) {
    var n = (typeof count === 'number' && count >= 1 ? count : 1) + delta
    return Math.max(1, Math.min(MAX, n))
  }

  module.exports = { MAX: MAX, tablewareLabel: tablewareLabel, normalizeTableware: normalizeTableware, stepCount: stepCount }
  ```
- [ ] **Step 3 按钮状态（先改测试再改实现）**：
  - `local-checkout-state.js`：`TEXT` 加 `NO_TABLEWARE: '请选择餐具'`，文件头「七种」注释改「八种」；JSDoc 参数加 `hasTableware 已选餐具`，`@returns` 的 action 加 `'tableware'`；在「报价过期」判断之后、`benefitsLoading` 之前插：
    ```js
    // 餐具必选（餐具设计 T2）。放在报价有效之后：先让顾客看到运费和应付，再提醒选餐具；
    // 按钮可点，动作是打开餐具弹层——页面必须按 action 分派
    if (!st.hasTableware) return result(false, TEXT.NO_TABLEWARE, 'ready', 'tableware')
    ```
  - `pickup-checkout-state.js`：同样加文案与 JSDoc；文件头优先级注释改为「阻塞 → 未选时段 → 时段失效 → 手机号 → 起送线 → 金额未知 → 餐具 → 优惠重算中 → 提交中」；在 `payAmount` 为空的判断之后、`benefitsLoading` 之前插同一行（文案、`'ready'`、`'tableware'`）。放在「金额未知」之后而不是之前，是为了 `amountState='ready'` 时金额一定算得出来（spec §5.3 的顺序据此勘误）。
  - 测试：两个文件的 `READY` 各加 `hasTableware: true`；local「文案只允许这七种」改为「八种」并把 `'请选择餐具'` 加进允许文案、`'tableware'` 加进允许 action，用例数组加 `on({ hasTableware: false })`；两边各加一条 deepEqual：`on({ hasTableware: false })` → `{ disabled:false, text:'请选择餐具', amountState:'ready', action:'tableware' }`；local 加优先级断言：`on({ hasTableware:false, quoteToken:null }).text === '正在计算运费'`、`on({ hasTableware:false, blockReason:'x' }).text === '暂不可配送'`、`on({ hasTableware:false, submitting:true }).text === '请选择餐具'`；pickup 加：`on({ hasTableware:false, belowMinGap:500 }).text === '还差 ¥5.00 起'`、`on({ hasTableware:false, payAmount:null }).text === '提交订单'`（金额未知优先）。**既有用例的期望值一个都不改**（改了就是优先级放错，按上报触发条件 5 处理）。
  - ⚠️ pickup 测试文件里「优先级：阻塞 > 未选时段 > …」那条（约 89–98 行）**不用 READY**，自带一个 `all` 对象，不改会在最后两条断言上变红。这是 fixture 调整、不算触发条件 5，按下面改：`all` 加 `hasTableware: false`；在「还差 ¥5.00 起」那条之后**插入**一条 `Object.assign({}, all, { blockReason: '', hasSlot: true, slotStale: false, phoneValid: true, belowMinGap: 0 })` → `.text === '请选择餐具'`；原「提交订单」「提交中」两条的覆盖对象各加 `hasTableware: true`（期望值不变）；用例标题改为 `'优先级：阻塞 > 未选时段 > 时段失效 > 手机号 > 起送 > 金额未知 > 餐具 > 优惠重算 > 提交中'`。local 测试文件的优先级用例全走 `on(...)`，只需 READY 加字段。
- [ ] **Step 4 弹层组件 `components/tableware-sheet`**：
  - `index.json`：`{ "component": true }`。
  - `index.js`（ES5）：
    ```js
    // 餐具选择弹层（餐具设计 §5.2）。两个结算页共用；只管弹层内的草稿，确定时把 { mode, count? } 抛给页面。
    var tw = require('../../utils/tableware')

    Component({
      options: { addGlobalClass: true },
      properties: {
        show: { type: Boolean, value: false },
        value: { type: null, value: null },
      },
      data: { needChoice: '', qtyMode: 'BY_MEAL', count: 1, max: tw.MAX },
      observers: {
        show: function(show) {
          if (!show) return
          // 每次打开都从页面当前值重建草稿：上次没点确定就关掉的改动不应残留
          var v = tw.normalizeTableware(this.properties.value)
          this.setData({
            needChoice: !v ? '' : (v.mode === 'NONE' ? 'NONE' : 'NEED'),
            qtyMode: v && v.mode === 'COUNT' ? 'COUNT' : 'BY_MEAL',
            count: v && v.mode === 'COUNT' ? v.count : 1,
          })
        },
      },
      methods: {
        noop: function() {},
        onClose: function() { this.triggerEvent('close') },
        onPickNeed: function() { this.setData({ needChoice: 'NEED' }) },
        onPickNone: function() { this.setData({ needChoice: 'NONE' }) },
        onPickByMeal: function() { this.setData({ qtyMode: 'BY_MEAL' }) },
        // 点步进器即切到指定份数；第一次点只切换不加减，免得顾客以为「按餐量」被悄悄改成了 2 份
        onMinus: function() {
          if (this.data.qtyMode !== 'COUNT') return this.setData({ qtyMode: 'COUNT' })
          this.setData({ count: tw.stepCount(this.data.count, -1) })
        },
        onPlus: function() {
          if (this.data.qtyMode !== 'COUNT') return this.setData({ qtyMode: 'COUNT' })
          this.setData({ count: tw.stepCount(this.data.count, 1) })
        },
        onConfirm: function() {
          var d = this.data
          if (!d.needChoice) return
          var value = d.needChoice === 'NONE' ? { mode: 'NONE' }
            : d.qtyMode === 'COUNT' ? { mode: 'COUNT', count: d.count } : { mode: 'BY_MEAL' }
          this.triggerEvent('confirm', value)
        },
      },
    })
    ```
  - `index.wxml`：
    ```xml
    <view wx:if="{{show}}" class="tw-mask" bindtap="onClose">
      <view class="tw-sheet" catchtap="noop">
        <view class="tw-head">
          <text class="tw-title">是否需要餐具</text>
          <text class="tw-close" bindtap="onClose">关闭</text>
        </view>
        <view class="tw-choices">
          <view class="tw-choice {{needChoice === 'NEED' ? 'active' : ''}}" bindtap="onPickNeed">
            <text class="tw-choice-name">需要餐具</text>
          </view>
          <view class="tw-choice {{needChoice === 'NONE' ? 'active' : ''}}" bindtap="onPickNone">
            <text class="tw-choice-name">无需餐具</text>
            <text class="tw-eco">环保助力</text>
          </view>
        </view>
        <block wx:if="{{needChoice === 'NEED'}}">
          <text class="tw-sub">餐具数量</text>
          <view class="tw-qty">
            <view class="tw-bymeal {{qtyMode === 'BY_MEAL' ? 'active' : ''}}" bindtap="onPickByMeal">商家按餐量提供</view>
            <view class="tw-stepper {{qtyMode === 'COUNT' ? 'active' : ''}}">
              <text class="tw-step {{qtyMode === 'COUNT' && count <= 1 ? 'disabled' : ''}}" bindtap="onMinus">−</text>
              <text class="tw-count">{{count}} 份</text>
              <text class="tw-step {{qtyMode === 'COUNT' && count >= max ? 'disabled' : ''}}" bindtap="onPlus">+</text>
            </view>
          </view>
        </block>
        <view class="tw-confirm btn-primary {{needChoice ? '' : 'btn-disabled'}}" bindtap="onConfirm">确定</view>
      </view>
    </view>
    ```
  - `index.wxss`：遮罩与底板照 `pages/local/pickup.wxss` 的 `.sheet-mask/.sheet/.sheet-head/.sheet-title/.sheet-close` 数值抄一份改名 `tw-*`；另加：两个选项等宽并排 `display:flex; gap:20rpx`，`.tw-choice` 高 120rpx、`border:2rpx solid var(--divider)`、圆角 `var(--radius-md)`、竖排居中；`.tw-choice.active` 与 `.tw-bymeal.active`、`.tw-stepper.active` 为 `border-color: var(--brand); background: var(--brand-bg); color: var(--brand)`；`.tw-eco { font-size:22rpx; color: var(--success, #16a34a) }`；`.tw-sub` 标题 28rpx 粗体上边距 28rpx；`.tw-qty` 两块等宽并排；`.tw-stepper` 内部三段 `space-between`，`.tw-step.disabled { color: var(--text-disabled) }`；`.tw-confirm` 上边距 32rpx、高 88rpx、居中。
- [ ] **Step 5 外送结算页 `pages/local/confirm`**：
  - `confirm.json` 的 `usingComponents` 加 `"tableware-sheet": "/components/tableware-sheet/index"`。
  - `confirm.js`：`require('../../utils/tableware')`；`data` 删 `needTableware`，加 `tableware: null`、`tablewareLabel: ''`、`tablewareOpen: false`；删 `onTablewareChange`；加
    ```js
    openTableware: function() { this.setData({ tablewareOpen: true }) },
    closeTableware: function() { this.setData({ tablewareOpen: false }) },
    // 顾客在弹层里确定的选择。_tablewareTouched 挡住「预填请求比顾客手慢」时把顾客刚选的值冲掉
    onTablewareConfirm: function(e) {
      var v = tableware.normalizeTableware(e.detail)
      if (!v) return
      this._tablewareTouched = true
      this.setData({ tableware: v, tablewareLabel: tableware.tablewareLabel(v.mode, v.count), tablewareOpen: false })
      this.syncAction()
    },
    applyLastTableware: function(raw) {
      var v = tableware.normalizeTableware(raw)
      if (!v || this._tablewareTouched || this.data.tableware) return
      this.setData({ tableware: v, tablewareLabel: tableware.tablewareLabel(v.mode, v.count) })
      this.syncAction()
    },
    ```
  - `loadData` 的 `Promise.all` 加第三项 `orderApi.getLastTableware().catch(function() { return null })`，拿到结果后调 `self.applyLastTableware(results[2])`（在 `setData items/address` 之后）。
  - `syncAction` 传给 `checkoutAction` 的对象加 `hasTableware: !!d.tableware,`。
  - `onSubmit` 最前面加 `if (act.action === 'tableware') { this.openTableware(); return }`。
  - `doSubmit` 守卫加 `|| !this.data.tableware`；删掉 `var remark = (...)` 那一行，body 改为 `remark: this.data.remark ? this.data.remark.slice(0, 20) : undefined,` 与 `tableware: this.data.tableware,`。
  - `confirm.wxml`：删掉 `<switch>` 那一整个 `tableware-row`，在 `remark-row` 之前换成
    ```xml
    <view class="tableware-row" bindtap="openTableware">
      <text class="row-label">餐具</text>
      <text class="tableware-value {{tableware ? '' : 'tableware-empty'}}">{{tableware ? tablewareLabel : '请选择'}}</text>
      <text class="tableware-arrow">›</text>
    </view>
    ```
    页面最后（`bottom-bar` 之前或之后均可，与 pickup 时段弹层同一层级）加 `<tableware-sheet show="{{tablewareOpen}}" value="{{tableware}}" bind:confirm="onTablewareConfirm" bind:close="closeTableware" />`。
  - `confirm.wxss`：`.row-label` 上方那段「需要餐具四个字要 108rpx」的注释改成「与自取页同宽，保持两页备注输入框对齐」（宽度不改）；加 `.tableware-value { flex: 1; text-align: right; color: var(--text-1); font-size: 26rpx; }`、`.tableware-empty { color: var(--brand); }`、`.tableware-arrow { color: var(--text-3); font-size: 30rpx; }`。
- [ ] **Step 6 自取结算页 `pages/local/pickup`**：与 Step 5 同构——`pickup.json` 注册组件；`pickup.js` 同样的 data/四个方法（`syncAction` 换成 `recompute`）；`loadAll` 的 `Promise.all` 加第四项 `orderApi.getLastTableware().catch(function() { return null })`，在 `setData` 之后 `self.applyLastTableware(results[3])`；`recompute` 的 `pickupCheckoutAction` 入参加 `hasTableware: !!d.tableware,`；`onSubmit` 最前面分派 `tableware`；`doSubmit` 守卫加 `|| !this.data.tableware`，body 加 `tableware: this.data.tableware,`。`pickup.wxml` 的 `remark-section` 里 `remark-row` 之前加同一段餐具行，文件末尾加同一个 `<tableware-sheet>`。`pickup.wxss` 加 `.tableware-row { display: flex; gap: 20rpx; align-items: center; padding: 10rpx 0; }` 与 Step 5 的三条样式。
- [ ] **Step 7 接口与详情**：`api/order.js` 加
  ```js
  // 该顾客最近一次选过的餐具（结算页预填），没有则 null。silent：拉不到就让顾客自己选
  function getLastTableware() {
    return request({ url: '/orders/tableware-last', silent: true })
  }
  ```
  并加入 `module.exports`。`pages/order/detail.js` 的 `decorateOrder`（约 297 行）返回对象加 `tablewareLabel: tablewareUtil.tablewareLabel(order.tablewareMode, order.tablewareCount),`（顶部 `var tablewareUtil = require('../../utils/tableware')`）；`detail.wxml` 在「备注」`info-row` 之后加
  ```xml
  <view class="info-row" wx:if="{{order.tablewareLabel}}">
    <text class="info-label">餐具</text>
    <text class="info-value">{{order.tablewareLabel}}</text>
  </view>
  ```
- [ ] **Step 8 预览台**：`local-confirm.html`、`local-pickup.html` 的备注卡片换成「餐具」行（一张显示「需要餐具 · 2 份」，一张显示橙色「请选择」）；新建 `pages/local-tableware-sheet.html`（基于 `local-pickup-picker.html` 的遮罩写法，展示「需要餐具」选中 + 「2 份」步进器选中），在 `serve.mjs` 的 `PAGE_WXSS` 登记 `'local-tableware-sheet': 'pages/local/pickup.wxss'`、`PAGE_COMPONENTS` 登记 `['checkout-benefits', 'tableware-sheet']`（并给 `local-confirm`、`local-pickup` 的组件列表补 `'tableware-sheet'`），`index.html` 的 `PAGES` 在「自取结算·选时段」后加 `['餐具选择弹层', 'components/tableware-sheet', 'local-tableware-sheet']`。镜像类名与真实 wxml 一致。
- [ ] **Step 9** `npm run -s test:miniapp` 全绿；`node scripts/check-miniapp-es5.mjs apps/miniapp/utils/tableware.js apps/miniapp/utils/local-checkout-state.js apps/miniapp/utils/pickup-checkout-state.js apps/miniapp/components/tableware-sheet/index.js apps/miniapp/pages/local/confirm.js apps/miniapp/pages/local/pickup.js` 全过（`detail.js` 原本就不是 ES5，不在检查范围）。提交 `feat(miniapp): 结算页餐具必选弹层、记住上次选择、订单详情显示餐具`。

## Task 4（后台 + 文档）

**Files:** `apps/admin/src/utils/tableware.ts`（新）、`apps/admin/src/utils/tableware.test.ts`（新）、`types.ts`、`pages/{Workbench,LocalOrders}.tsx`、`pages/Workbench.css`、`docs/staff-guide.md`、`docs/miniapp-release-checklist.md`、`docs/design/workbench-ui-spec.md`、`docs/superpowers/specs/2026-09-14-tableware-choice-design.md`

- [ ] **Step 1** 先写 `utils/tableware.test.ts`（照 `utils/weight.test.ts` 的 `node:test` 写法）四例，再写 `utils/tableware.ts`：`export function tablewareLabel(mode?: string | null, count?: number | null): string`，逐字同服务端界面文案。
- [ ] **Step 2** `types.ts`：`Order` 在 `remark?: string | null` 之后加 `tablewareMode?: string | null` 与 `tablewareCount?: number | null`（注释：列表与详情都返回；邮寄单、老订单为 null）；`WorkbenchCard` 在 `note: string | null` 之后加 `tableware: { mode: string; count: number | null } | null`。
- [ ] **Step 3** `Workbench.tsx`：
  - 卡片：`<div className="wb__items">…</div>` 之后、备注那一行之前加
    `{card.tableware && <div className="wb__tableware">{tablewareLabel(card.tableware.mode, card.tableware.count)}</div>}`
  - 抽屉：放大备注那一行（`wb__note wb__note--lg` / `wb__nonote`）之后加同一行。不进「金额明细」。
  - `Workbench.css` 加 `.wb__tableware { margin: 4px 0; font-size: 13px; font-weight: 600; color: var(--text-1); }`（深浅主题共用变量）。
- [ ] **Step 4** `LocalOrders.tsx`：行内信息在「打包费」那个 `<span>` 之后加 `{o.tablewareMode && <span>{tablewareLabel(o.tablewareMode, o.tablewareCount)}</span>}`。`Orders.tsx` 不动。
- [ ] **Step 5 文档**：
  - `docs/staff-guide.md` 在「## 六点七、打包费」之后、「## 七、优惠券与积分」之前加「## 六点八、餐具」：顾客在结算页必选；小票两联和工作台卡片/抽屉各有一行（「无需餐具」「餐具：按餐量」「餐具：3 份」）；「按餐量」= 按菜的份数配；老订单备注开头的「[需要餐具]」是旧写法，现在的单不会再出现；餐具免费，不进金额。
  - `docs/miniapp-release-checklist.md`：「结算页按顺序有」那一条里的「餐具备注」改为「餐具（必选弹层、份数 1–10）/ 备注」，并在「到店自取」一节末尾加一条「自取结算页餐具必选，预填上一次选择」。
  - `docs/design/workbench-ui-spec.md` §4 卡片与 §5 抽屉各补一句：同城/自取单在菜品摘要下（抽屉在备注下）显示餐具一行；老单与邮寄单不显示；不进金额明细。
  - spec 勘误：`2026-09-14-tableware-choice-design.md` §5.3 自取页优先级改为「……未达起送、金额未就绪**之后**，优惠加载中、提交中**之前**」，并在文末加「勘误」小节说明原因（`amountState='ready'` 需要金额已算出）。
- [ ] **Step 6** `cd apps/admin && npm test && npm run build` 全绿。提交 `feat(admin): 工作台与同城订单列表显示餐具；店员手册与检查清单`。

---

## 验收标准（只在此定义；04 机械核对按此打 PASS/FAIL）

- **C1** `apps/server`：`npx tsc --noEmit -p .` 通过；`selftest-tableware` 全过（≥ 5 组用例）、`selftest-member` 全过；干净库 e2e 0 红且含 §64。
- **C2** 迁移文件存在且只加两列（`orders.tableware_mode VARCHAR(16) NULL`、`orders.tableware_count INT NULL`）。
- **C3** `services/tableware.ts` 是餐具规则唯一来源：`routes/orders.ts` 用 `tablewareSchema`、`applyLegacyTablewarePrefix`（在 `createOrderSchema.parse` 的参数位置）、`tablewareColumns`；`grep -rn "需要餐具" apps/server/src` 只命中 `services/tableware.ts` 与 `services/ticket/content.ts` 的注释/文案。
- **C4** 下单响应、顾客详情、后台列表与详情含 `tablewareMode/tablewareCount`；工作台卡片含 `tableware`；`GET /api/orders/tableware-last` 注册在 `GET /:id` 之前。
- **C5** 小票：取餐/配送联餐具行在收件信息块之后、备注之前；厨房联在尾号之后；两者独立于 `remarkBlock`；null 不印；`selftest-member` 断言出现 2 次与压缩后仍在。
- **C6** 小程序：`test:miniapp` 全绿含新增用例；两个结算页 wxml 各有餐具行与 `<tableware-sheet>`；外送页不再有 `needTableware`、`onTablewareChange`、`<switch` 与 `[需要餐具]`；两页 `onSubmit` 分派 `tableware`、`doSubmit` 守卫含 `tableware`、body 含 `tableware`；两个状态工具新状态位置符合 Task 3 Step 3；改动 js 通过 ES5 检查。
- **C7** 后台：`npm test` / `npm run build` 全绿；`Workbench.tsx` 卡片与抽屉、`LocalOrders.tsx` 有餐具行；`Orders.tsx` 无改动；金额明细块内无「餐具」。
- **C8** 文档：`docs/api.md` 附录 J、`docs/staff-guide.md` 六点八、检查清单两处、`workbench-ui-spec.md` 两句、spec §5.3 勘误均存在。
- **W** `git diff --name-only fd678ea..HEAD` 全在白名单内。
- **C** 提交前缀与尾注合规。

## 手工验收（合并前，店主）

1. 新顾客进外送结算页：餐具行「请选择」，按钮「请选择餐具」；点按钮弹层，选「无需餐具」确定，按钮变「提交订单」。
2. 下单后再进结算页：餐具行已是「无需餐具」；改成「需要餐具」→ 步进器点到 3 份 → 确定，行显示「需要餐具 · 3 份」。
3. 自取结算页同样必选并预填上一次选择。
4. 小票取餐联和厨房联都有「餐具：3 份」；工作台卡片、抽屉、订单详情、同城订单列表都显示；金额明细里没有餐具。
5. 邮寄下单没有餐具行，小票没有。
6. 旧版体验版（未更新的手机）打开「需要餐具」并写满 20 字以内的备注仍能下单，后台显示「需要餐具 · 按餐量」。

## 上线顺序

先部署服务端（零停机、两列可空），再从主仓上传小程序体验版与提审。

## 勘误与验收记录（执行时追加）

- **2026-09-14 计划复核（opus 对抗审，16 agent，10 条存活）已并入本文**：pickup 优先级用例的 `all` fixture（原计划会让最后两条断言变红）；e2e 工作台断言补付款 + `snapshot?fresh=1` + 非空断言；压缩用例原写法走不到第⑤步，改为超长 POI 必达；顺序用例补备注；e2e ①②④ 每种模式覆盖四个面；后台列表必须带 `deliveryType`；`detail.js` 函数名为 `decorateOrder`。
- **2026-09-14 终审返工第 1 轮 R1**：§4.1 原文要求餐具校验做成 createOrderSchema 末尾追加的独立 refine；实现改为 tablewareSchema 内部 refine，以满足『餐具规则唯一来源』（验收 C3）。副作用仅限请求同时带非法 tableware 且缺地址/时段时的 40001 文案：zod 4 下枚举/类型错误时外层 refine 不再执行，只报餐具提示；范围错误时两条文案用『；』并列、餐具在前。正常客户端不会发出这种请求；不带或合法 tableware 的请求文案与改前逐字一致。
- **2026-09-14 终审返工第 1 轮 R4**：Task 2 Step 4 第 8 条（e2e §64 ⑧ `tableware-last`）改为临时 SQL 改 ④/⑦ 后断言再恢复——原写法 ④ 与 ⑤ 都是 `BY_MEAL`、⑦ 邮寄单两列本来就是 null，验不到「取的是最近一张同城/自取单」与「邮寄单有值也不采信」。
- **2026-09-14 终审返工第 1 轮 R6**：Task 3 Step 5/6 的预填改为独立请求、不进 Promise.all——spec §5.4「静默请求、不影响主流程」，原写法把商品/地址/报价（自取页还有取餐人/时段）都拖到预填请求回来才渲染。
- **2026-09-14 终审返工第 1 轮（合并汇总，HEAD 起点 1a08efc）**：
  - **R1** `services/tableware.ts` 的 `tablewareSchema` 拆成两条 `refine`（缺 count / 多带 count 各报各的文案），`z.number`/`z.object` 补 `error` 文案；`selftest-tableware.ts` 补断言与 2 例（`count:null`、`optional().parse(null)`）；spec §4.1 改为「校验放在 tablewareSchema 内部」，勘误小节追加回判说明；本文件同步追加摘要（上面一条）。
  - **R2** `applyLegacyTablewarePrefix` 的 `??` 改成 `=== undefined` 判断，显式 `tableware:null` 不再被误当「没传」补成 BY_MEAL；`selftest-tableware.ts` 补 1 断言 + 1 新例；`docs/api.md` 附录 J 补一句 EXPRESS 带非法 tableware 同样 40001。
  - **R3** `selftest-member.ts` 厨房联用例补两条断言（餐具行在尾号之后、在第一条菜品之前），锁住 C5「厨房联在尾号之后」。
  - **R4** `scripts/e2e.d/64-tableware.sh`：`p64_check_four` 顾客详情改单次取数；⑧ 段补临时 SQL 改 ④/⑦ 再断言再恢复，堵住「④⑤同为 BY_MEAL、⑦邮寄单本就是 null」两个盲区（摘要见上面一条）。
  - **R6** 两个结算页 `loadData`/`loadAll` 的 `getLastTableware()` 改成独立请求、不进 `Promise.all`（摘要见上面一条）。
  - **R7** `local-checkout-state.test.cjs`/`pickup-checkout-state.test.cjs` 各补 2/1 条边界断言（报价过期排餐具前、优惠加载中排餐具后）。
  - **R8** `tools/miniapp-preview/pages/local-pickup.html` 按钮文案改「请选择餐具」，与该页餐具行「请选择」态一致。
  - **R11** `docs/staff-guide.md` 336 行改为「上线前老单不回填、老单看备注前缀、上线后旧版客户端会被剥前缀」，不再声称服务端把老单转成新字段。
  - **R12** `docs/api.md` 1934 行改为「①–⑤ 所有降级都不动餐具行」，消除「第⑤步会动它」的歧义。
  - **R13** `docs/staff-guide.md` 332 行点明是「顾客小程序」的订单详情，并注明后台邮寄订单页没有这一行。
  - **R14** `services/ticket/content.ts` 的注释改为指向新 spec §4.5，不再挂错旧 spec §12。
  - **R16** `apps/miniapp/pages/local/confirm.wxml` 165 行注释「七种」改「八种」，与代码一致。
  - **R19** spec 勘误第一条改写，纠正因果（是「请选择餐具」这一格自己返回 `amountState='ready'`，必须排在 `payAmount` 判断之后，不是「amountState 是餐具判定要读的信号」）。
  - **R20** `docs/design/workbench-ui-spec.md` §5 自上而下清单补入「餐具」，与 `Workbench.tsx` 抽屉的实际顺序（备注 → 餐具 → 状态条）对齐。
  - **测试**：`cd apps/server && npx tsc --noEmit -p .` 通过；`npx ts-node --transpile-only scripts/selftest-tableware.ts` 29 例全过；`npx ts-node --transpile-only scripts/selftest-member.ts` 64 例全过；`npm run -s test:miniapp` 117 例全过；`node scripts/check-miniapp-es5.mjs apps/miniapp/pages/local/confirm.js apps/miniapp/pages/local/pickup.js` 全过；干净库全量 e2e（标签 final-r1，`/tmp/tableware-e2e-final-r1.log`）`通过 1706 / 失败 0`，§64 段全部 ✔（含 ⑧ 的新断言）。未touch `apps/admin`，未跑其 `npm test`/`build`。
