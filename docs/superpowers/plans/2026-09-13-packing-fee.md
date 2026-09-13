# 打包费 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **工序声明**：本文件是「模型分工协议」的 **00 规划 · fable** 产物，等级 **M**（三端各一小步，服务端一次小迁移）。
> 后续：01 执行 · sonnet（逐任务子代理）→ 02 复核 · opus（新会话，只给需求 + 最终 diff）→ 03 回判 · fable → 04 机械核对 · haiku。验收标准只在本文件定义。

**Goal:** 同城外送与到店自取按份收打包费（全店默认 ¥1，菜品可覆盖，赠品/邮寄不收），三端一致显示。

**Architecture:** 服务端一个纯函数 `services/packing-fee.ts` 是唯一的计费实现；下单时算好存进 `orders.packing_fee` 快照并计入 `actualAmount`，其余端只读这个字段。商品级覆盖存 `products.packing_fee_fen`（null=跟随默认、0=不收）；全店默认与开关存在 `local_delivery.packing`。小程序结算页按购物车行的 `packingFeeEach × quantity` 做预览，提交后以服务端为准。

**Tech Stack:** Express + Prisma/MySQL + zod 4；微信原生小程序（新文件 ES5，`node scripts/check-miniapp-es5.mjs <file>`）；React 18 + Vite 后台。

**Spec:** `docs/superpowers/specs/2026-09-13-packing-fee-design.md`（决策 P1–P9）。

---

## Global Constraints（每个任务隐含包含本节）

- 工作目录 `/Users/yumingyi/food-shop/.claude/worktrees/packing-fee`（分支 `claude/packing-fee`）。不要 cd 到主检出；不要 `git stash`。
- 独立库 `food_shop_packing`，服务端口 **3110**（`apps/server/.env` 已配好，mock 全开、`SCHEDULER_DISABLED=true`）。服务端启动：`cd apps/server && PORT=3110 npx ts-node-dev --respawn --transpile-only src/app.ts`。**e2e 只能在干净库跑**：`/tmp/packing-e2e-fresh.sh [logfile]`。
- **计费公式（逐字）**：`perItem(product) = product.packingFeeFen ?? settings.packing.perItemFen`；`packingFee = (settings.packing.enabled && deliveryType ∈ {LOCAL, PICKUP}) ? Σ(非赠品行 quantity × perItem) : 0`；`actualAmount = subtotal − pickupDiscount − couponDiscount + shippingFee + packingFee`。
- 起送门槛、阶梯免运、券门槛、自取折扣、券封顶**一律不看打包费**（继续用商品小计）。
- 默认设置 `packing: { enabled: true, perItemFen: 100 }`；`perItemFen` 越界回落默认 100（仓库既有 `int()` 语义，不是夹到边界）；商品 `packingFeeFen` 校验 0–10000 或 null，越界是 zod 400 拒绝。
- 展示顺序（结算页 / 详情 / 小票 / 工作台）：商品小计 → **打包费** → 自取优惠 → 优惠券 → 运费（外送）→ 实付。打包费为 0 时不显示该行（小票、详情、后台）；结算页在 `meta.packing.enabled=false` 时不显示。
- 文案逐字：「打包费」；商品编辑页标签「打包费（元）」，提示「留空 = 跟随全店默认 ¥X；填 0 = 这道菜不收」；同城设置卡片标题「打包费」，字段「默认每份打包费（元）」，开关文案「收取打包费（关闭 = 整店暂不收，商品上的设置保留）」。
- 老渠道零行为变化：EXPRESS 单 `packingFee` 恒 0，邮寄结算页/小票不出现打包费行。
- 每个任务结束前跑各自的测试；提交信息中文（`feat/fix/test/docs`），尾注 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`；`git add` 只加白名单文件。

## 允许修改的文件白名单

```
apps/server/prisma/schema.prisma
apps/server/prisma/migrations/20260916000000_packing_fee/migration.sql   （新建）
apps/server/src/services/packing-fee.ts                                  （新建）
apps/server/src/services/local-settings.ts
apps/server/src/services/member/pricing.ts
apps/server/src/routes/orders.ts
apps/server/src/routes/cart.ts
apps/server/src/routes/products.ts
apps/server/src/routes/admin/products.ts
apps/server/src/routes/admin/orders.ts
apps/server/src/services/ticket/{index,content}.ts
apps/server/scripts/selftest-packing.ts                                  （新建）
apps/server/scripts/selftest-local-settings.ts
apps/server/scripts/selftest-member.ts
scripts/e2e.sh                                                           （仅在段落列表登记 63）
scripts/e2e.d/63-packing-fee.sh                                          （新建）
scripts/e2e.d/{49-local-coupon,62-pickup}.sh                             （仅各加 `.packing.enabled=false` 到本段的设置钉死：老段验券公式，与打包费无关；Task 2 勘误）
docs/api.md
apps/miniapp/pages/local/{confirm,pickup}.{js,wxml}
apps/miniapp/pages/order/detail.{js,wxml}
apps/miniapp/utils/{local-checkout-state,pickup-checkout-state}.js
tests/miniapp/{local-checkout-state,pickup-checkout-state}.test.cjs
tools/miniapp-preview/pages/{local-confirm,local-pickup,order-detail-pickup}.html
apps/admin/src/types.ts
apps/admin/src/api/admin.ts
apps/admin/src/pages/{Products,LocalSettings,Workbench,LocalOrders,Orders}.tsx
docs/staff-guide.md
docs/superpowers/plans/2026-09-13-packing-fee.md（本文件：勘误与验收记录）
docs/superpowers/specs/2026-09-13-packing-fee-design.md（仅 02 复核 #2 的「夹取」口径修正）
apps/server/src/routes/admin/settings.ts（仅 02 复核 #4：整包 PUT 缺 packing 沿用当前值）
```

## 上报触发条件（遇到即 BLOCKED）

1. 需要改白名单之外的文件。
2. `computeCheckout` 现有封顶校验或 `orders.ts` 的计价顺序注释与本计划公式冲突。
3. 购物车接口返回的行里拿不到商品的 `packingFeeFen`（即需要改 `services/cart*` 之类白名单外文件）。
4. e2e 干净库跑出与打包费无关的红（先对照主检出记忆：§35/§45/§59/§60 脏库假红）。
5. 任务间接口与本计划 Interfaces 不一致。

---

## Task 1（服务端）：数据列、设置节、纯函数与 selftest

**Files:** `prisma/schema.prisma`、`prisma/migrations/20260916000000_packing_fee/migration.sql`、`services/local-settings.ts`、`services/packing-fee.ts`（新）、`services/member/pricing.ts`、`scripts/selftest-packing.ts`（新）、`scripts/selftest-local-settings.ts`

**Interfaces（Produces）:**
```ts
// services/local-settings.ts
export interface PackingSettings { enabled: boolean; perItemFen: number }
// LocalDeliverySettings 加 packing: PackingSettings；DEFAULT 为 { enabled: true, perItemFen: 100 }
// publicLocalMeta(s) 多 packing: { enabled, perItemFen }
// services/packing-fee.ts
export function packingFeeEach(s: LocalDeliverySettings, product: { packingFeeFen: number | null }): number   // s.packing.enabled ? (product.packingFeeFen ?? s.packing.perItemFen) : 0
export function calcPackingFee(s: LocalDeliverySettings, deliveryType: string, lines: { packingFeeFen: number | null; quantity: number; isGift?: boolean }[]): number
// services/member/pricing.ts
computeCheckout({ subtotal, discount, shippingFee, pickupDiscount?, packingFee? })  // packingFee 默认 0，与 shippingFee 同层相加，负数抛错
```

- [ ] Step 1 迁移：`schema.prisma` Product 加 `packingFeeFen Int? @map("packing_fee_fen")`（放在 `netWeightG` 后），Order 加 `packingFee Int @default(0) @map("packing_fee")`（放在 `shippingFee` 后）。`migration.sql`：
  ```sql
  ALTER TABLE `products` ADD COLUMN `packing_fee_fen` INT NULL;
  ALTER TABLE `orders` ADD COLUMN `packing_fee` INT NOT NULL DEFAULT 0;
  ```
  `cd apps/server && npx prisma migrate deploy && npx prisma generate`。
- [ ] Step 2 设置：`local-settings.ts` 加 `PackingSettings`、默认值、`sanitize`（`enabled` 布尔化，`perItemFen` 用既有 `int(...,0,10_000)`）、`publicLocalMeta` 输出 `packing`。selftest-local-settings 加 2 例（缺省补齐；`perItemFen` 越界夹取）。
- [ ] Step 3 先写 `scripts/selftest-packing.ts`（照 `selftest-pickup.ts` 的 `t()` 写法）6 例：默认 ¥1 两行 3 份 = 300；覆盖 0 的商品不收；覆盖 250 的商品按 250；赠品行不计；`enabled=false` 为 0；`deliveryType='EXPRESS'` 为 0。再写 `packing-fee.ts` 让其通过。
- [ ] Step 4 `computeCheckout` 加 `packingFee?: number`（默认 0，负数抛 `Error`），返回 `subtotal − pickupDiscount − discount + shippingFee + packingFee`；JSDoc 补一句。`selftest-member.ts` 里 `computeCheckout` 的用例加 1 例（含 packingFee）。
- [ ] Step 5 跑 `npx tsc --noEmit -p .`、三个 selftest；提交 `feat(server): 打包费数据列、设置节与计费纯函数`。

## Task 2（服务端）：下单接线、接口透传、小票、e2e

**Files:** `routes/orders.ts`、`routes/cart.ts`、`routes/products.ts`、`routes/admin/products.ts`、`routes/admin/orders.ts`、`services/ticket/{index,content}.ts`、`scripts/e2e.sh`、`scripts/e2e.d/63-packing-fee.sh`、`docs/api.md`

**Interfaces（Produces）:** 订单对象（顾客列表/详情、后台列表/详情、下单响应）多 `packingFee: number`；商品对象（`GET /api/products*`、购物车行的 `product`）多 `packingFeeFen: number | null` 与 `packingFeeEach: number`；`GET /api/local/meta` 已由 Task 1 输出 `packing`；`POST/PUT /admin/products` 接受 `packingFeeFen`。

- [ ] Step 1 下单：`routes/orders.ts` 组装 `lines` 时 `product` select 加 `packingFeeFen`；在算出 `pickupDiscount` 之后、`computeCheckout` 之前：`const packingFee = calcPackingFee(await getLocalSettings(), deliveryType, lines.map(l => ({ packingFeeFen: l.product.packingFeeFen, quantity: l.quantity })))`（`getLocalSettings` 有缓存，PICKUP/LOCAL 分支里已取过的 `s` 可复用）；`computeCheckout({..., packingFee})`；`tx.order.create` 写 `packingFee`。**不要**把 packingFee 传进任何门槛/免运/券封顶的计算。0 元拒单判断不变。
- [ ] Step 2 透传：`orders.ts` 的顾客列表/详情 select 与下单响应加 `packingFee`；`routes/admin/orders.ts` 的 `orderListSelect`/详情加 `packingFee`；`routes/products.ts`（列表/详情）与 `routes/cart.ts` 的 product select 加 `packingFeeFen`，并在响应里附 `packingFeeEach = packingFeeEach(settings, product)`（cart 与 products 各取一次 `getLocalSettings()`）。`routes/admin/products.ts` zod 加 `packingFeeFen: z.number().int().min(0).max(10_000).nullable().optional()`，create/update 写入。
- [ ] Step 3 小票：`ticket/index.ts` 的 `toTicketInput` 传 `packingFee`；`content.ts` `TicketOrderInput` 加 `packingFee?: number`，footer 在 `合计：` 之后、`自取优惠：` 之前插 `...(o.packingFee && o.packingFee > 0 ? [\`打包费：${yuan(o.packingFee)}\`] : [])`；厨房联不印。`selftest-member.ts` 自取小票用例加 `packingFee: 200` 并断言含 `打包费：¥2.00`。
- [ ] Step 4 e2e：新建 `scripts/e2e.d/63-packing-fee.sh`（照 62 的写法，变量前缀 `P63_`），并在 `scripts/e2e.sh` 段落列表登记。断言：① 默认设置下自取单 A×1 + B×2（B 由后台 PUT `packingFeeFen=0`）→ `packingFee=100`、`actualAmount = 小计−自取优惠−券+100`；② 商品 A PUT `packingFeeFen=250` → 再下单 `packingFee=250`；③ `packing.enabled=false` → 0，恢复；④ 同城外送单（用 e2e.sh 既有的 `lquote`/`LQTOKEN` 写法）`packingFee` = 行数 × 100；⑤ 邮寄单 `packingFee=0`；⑥ 券门槛 = 小计时仍可用（打包费不算进门槛）；⑦ 全额退款 `remainingRefundable` 含打包费；⑧ 小票内容含 `打包费：`；收尾把设置与商品改回。用 `/tmp/packing-e2e-fresh.sh` 跑全量，必须 0 红。
- [ ] Step 5 `docs/api.md` 加「附录 I：打包费」（字段、公式、错误无新增）。提交 `feat(server): 打包费下单接线、接口透传、小票与 e2e §63`。

## Task 3（小程序）：结算页预览、订单详情、单测、预览镜像

**Files:** `pages/local/{confirm,pickup}.{js,wxml}`、`pages/order/detail.{js,wxml}`、`utils/{local-checkout-state,pickup-checkout-state}.js`、`tests/miniapp/*.test.cjs`、`tools/miniapp-preview/pages/*.html`

**Interfaces（Consumes）:** 购物车行 `item.product.packingFeeEach`（Task 2）、`meta.packing.enabled`、订单 `packingFee`。

- [ ] Step 1 `utils/pickup-checkout-state.js` 加纯函数 `packingFeeOf(items, enabled)`（`Σ quantity × (item.product && item.product.packingFeeEach || 0)`，`enabled=false` 为 0，赠品行不在购物车里所以不需排除）与 `packingFeeText(items)`（「N 份 × ¥X.XX」只在所有份单价相同时给，否则只给份数「N 份」）；`computePickupPay(subtotal, rule, couponDiscount, packingFee)` 返回值加 `packingFee`，`payAmount` 加上它。`local-checkout-state.js` 不算金额（外送 payAmount 在页面里算），只导出同一份 `packingFeeOf`（从 pickup-checkout-state require 复用，别抄两份）。先写测试：pickup 2 例、local 1 例。
- [ ] Step 2 自取页 `pickup.js`：`recompute` 里 `packingFee = st.packingFeeOf(d.items, meta.packing && meta.packing.enabled !== false)`，传给 `computePickupPay`；`data` 加 `packingFee`、`packingFeeText`；wxml 金额明细在「商品金额」后加行 `<view wx:if="{{packingFee > 0}}" class="sum-row"><text class="sum-k">打包费</text><text class="sum-v">¥{{pricefmt.fen(packingFee)}}<text class="sum-sub">（{{packingFeeText}}）</text></text></view>`（`sum-sub` 若无样式则用现有 `slot-hint` 同款小灰字，wxss 不在白名单，复用已有类）。
- [ ] Step 3 外送页 `confirm.js`：报价成功分支 `patch.payAmount = subtotal − discount + fee + packingFee`（packingFee 在加载购物车后算好存入 data，`meta` 已在 onLoad 拉过）；wxml 同样加「打包费」行（放在「商品金额」与「优惠券」之间）。
- [ ] Step 4 详情页 `detail.js` 加 `packingFeeText`，wxml 在「商品金额」后加 `wx:if="{{order.packingFee > 0}}"` 的「打包费」行。
- [ ] Step 5 预览镜像：`local-confirm.html`、`local-pickup.html`、`order-detail-pickup.html` 各加一行打包费示例。ES5 检查改动的 js；`npm run test:miniapp` 全绿。提交 `feat(miniapp): 结算页/详情显示打包费并计入应付`。

## Task 4（后台 + 文档）

**Files:** `types.ts`、`api/admin.ts`、`pages/{Products,LocalSettings,Workbench,LocalOrders,Orders}.tsx`、`docs/staff-guide.md`

- [ ] Step 1 `types.ts`：`Product.packingFeeFen: number | null`、`Order.packingFee?: number`、`LocalDeliverySettings.packing: { enabled: boolean; perItemFen: number }`。`api/admin.ts` 商品创建/更新的 payload 类型跟着 `Product`。
- [ ] Step 2 `Products.tsx` 表单：在「净重（克）」旁加「打包费（元）」文本框（`inputMode="decimal"`，与页内金额字段同一套元↔分转换；留空提交 `null`，`0` 提交 `0`）；提示文案见 Global Constraints；默认值从 `getLocalSettings()` 取 `packing.perItemFen` 显示在提示里（取不到写「全店默认」）。
- [ ] Step 3 `LocalSettings.tsx` 加「打包费」section（放在「配送范围与运费」之后）：开关 checkbox + 「默认每份打包费（元）」；`money` 加 `packingPerItem`，`handleSave` payload `packing: { enabled: s.packing.enabled, perItemFen: fen.packingPerItem! }`；其余合并规则不动。
- [ ] Step 4 金额行：`Workbench.tsx` 抽屉金额明细在「商品小计」后加 `{!!o?.packingFee && <div className="wb__line"><span>打包费</span><span className="wb__amt">¥{yuan(o.packingFee)}</span></div>}`；`LocalOrders.tsx` 行内信息在「实付」旁加 `{!!o.packingFee && <span>打包费 ¥{yuan(o.packingFee)}</span>}`；`Orders.tsx` 邮寄页不动（恒 0）。
- [ ] Step 5 `docs/staff-guide.md` 在「六点六」之后加「六点七、打包费」（怎么设默认、怎么给单个菜设不收、赠品邮寄不收、票面在哪看）。`npm test && npm run build` 全绿。提交 `feat(admin): 商品打包费字段、同城设置打包费卡片、订单金额行；店员手册`。

---

## 验收标准（只在此定义；04 机械核对按此打 PASS/FAIL）

- **C1** `apps/server`：`npx tsc --noEmit -p .` 通过；`selftest-packing` 6/6、`selftest-local-settings` 与 `selftest-member` 全过；干净库 e2e 0 红且含 §63。
- **C2** 迁移文件存在且只加两列（`products.packing_fee_fen INT NULL`、`orders.packing_fee INT NOT NULL DEFAULT 0`）。
- **C3** `services/packing-fee.ts` 是唯一计算打包费的地方（`grep -rn "packing" apps/server/src` 中乘以 quantity 的只有它）；`computeCheckout` 接受 `packingFee` 并与 `shippingFee` 同层相加；门槛/免运/券封顶的调用点未传入 packingFee。
- **C4** `GET /api/local/meta` 含 `packing`；购物车行与商品接口含 `packingFeeFen`/`packingFeeEach`；订单四处响应含 `packingFee`；`POST/PUT /admin/products` 接受并落库 `packingFeeFen`。
- **C5** 小票 footer 顺序 `合计 → 打包费 → 自取优惠 → 优惠券 → 运费 → 实付`，`packingFee=0` 不印，厨房联不印。
- **C6** 小程序：`test:miniapp` 全绿含新增用例；`pickup.wxml`/`confirm.wxml`/`detail.wxml` 各有「打包费」行且条件为 `packingFee > 0`；`computePickupPay` 的 `payAmount` 含 packingFee；改动 js 通过 ES5 检查。
- **C7** 后台：`npm test`/`npm run build` 全绿；`Products.tsx` 有「打包费（元）」字段且留空→null、0→0；`LocalSettings.tsx` 有「打包费」section 与 `packing` 合并保存；`Workbench.tsx`/`LocalOrders.tsx` 有打包费行。
- **C8** `docs/api.md` 附录 I、`docs/staff-guide.md` 六点七 存在。
- **W** `git diff --name-only main..HEAD` 全在白名单内。
- **C** 提交前缀与尾注合规。

## 手工验收（合并前，店主）

1. 后台「同城配送设置 → 打包费」默认开、¥1.00；商品 A 设 0、商品 B 留空。
2. 小程序自取下 A×1 + B×2：结算页「打包费 ¥2.00（2 份 × ¥1.00）」，应付含它；详情、小票、工作台抽屉、同城订单列表都有 ¥2.00。
3. 同城外送同样；邮寄下单没有这一行。
4. 券门槛按商品小计能用；关掉开关再下单打包费 0，已下的单不变。
5. 全额退款金额含打包费。

## 勘误与验收记录（执行时追加）

- 执行完成 2026-09-13：11 提交 `69ac0ae..HEAD`。02 复核（opus）无阻断，03 回判采纳 #1 邮寄商品不显示打包费框、#2 文档「夹取」→「越界回落默认」、#4 整包 PUT 缺 packing 沿用当前值（扩白名单）、#5 前端 ¥100 上限、#7① 小票 0 不印断言、#9 手册补一句；#3 上线步骤记入部署单（打烊后部署 + 验单）；#6/#7②③/#8 延后。04 机械核对 C1–C8/C PASS，W 因 spec 文件改动未列白名单一次 FAIL → 本条勘误补入白名单。干净库 e2e 1657/0。

- Task 3 勘误：购物车行的 `packingFeeEach` 服务端放在**行级**（`item.packingFeeEach`），不在 `item.product` 下（`docs/api.md` 附录 I 以此为准）；商品接口仍在商品对象上。小程序两种形状都接。
- Task 2 上报：默认 `packing.enabled=true` 使 §49/§62 里六条按精确实付断言的老用例各多 ¥1（§62「券减到 0 → 42251」前提失效）。裁定：老段在各自的设置钉死里加 `.packing.enabled=false`（收尾本就恢复 ORIG），打包费只在 §63 验；白名单相应扩两文件。
- perItemFen 越界回落默认非夹取（02 复核 #2）。
