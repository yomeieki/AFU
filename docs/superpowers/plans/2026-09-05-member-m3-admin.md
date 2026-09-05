# 会员 M3：后台管理（券模板 / 赠品 / 会员设置 / 用户页 / 赔偿券） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行本计划。步骤用 checkbox（`- [ ]`）语法追踪。
> **前置**：M1（账本）与 M2（结算链路，`docs/superpowers/plans/2026-09-05-member-m2-checkout.md`）已全部落地并合入。M2 已经把券模板与赠品的**服务端 CRUD**（`routes/admin/coupon-templates.ts`、`routes/admin/points-goods.ts`）落好，本计划只补用户维度的管理端接口，其余全是 `apps/admin` 页面。
> **本文档性质**：规划文档，由 Principal Engineer 角色撰写，本身不修改任何 `apps/` 代码。

设计依据：spec §7（后台）、§5.6（ADMIN 发券）、§5.7（越权与滥用）、§9（后台浏览器实测）；masterplan P2（赔偿一律发券）、P6（券来源含店员定向发放）、P7（退款不退券）。

**Goal:** 店主在后台能自己管理整套会员权益：建券模板、上赠品、调积分规则；在用户页看到每个人的积分与券、给任何人定向发一张赔偿券并留下操作人与备注、查这个人的积分明细与券记录；在订单页与售后面板看到「这单用了券 −¥X / 有赠品」，并能在退款之外（或不退款只补偿）直接给这单的顾客发赔偿券；退款弹窗上一眼看到「本单实付 ¥X（已用券 ¥Y）」，不会照商品原价退。做完 M3，店员侧的会员运营闭环完整；顾客侧仍无变化（M4）。

**Non-goals（详见文末《明确不做》）：** 不做小程序；不做积分手动加减（P4：不做店员手动送分，`ADMIN` 流水类型预留不开入口）；不做后台 RBAC；不做导航分组/折叠这类基础设施；不做报表。

---

## Global Constraints

- 后台加页面的固定三件套：`Layout.tsx` 的 `navItems` + `api/admin.ts` 端点包装 + `types.ts` 类型（spec §1「可直接复用」）。路由在 `App.tsx` 注册。
- 表格一律用 `components/ui/Table`，**必须传 `mobileCards`**（店主主要在手机上用后台）；金额输入用元、提交用分，照抄 `ShopSettings.tsx` / `LocalSettings.tsx` 的 `toFen/toYuan`（正则 `^\d+(\.\d{1,2})?$`）。
- 弹窗用 `components/ui/Modal`（`width: 'sm'|'md'|'lg'`），二次确认用 `confirmDialog()`；本项目没有 Drawer 组件，「抽屉」一律用 `Modal width="lg"` + `max-h-[60vh] overflow-y-auto`（`Users.tsx` 的订单弹窗就是这个写法），**不新建 Drawer 组件**。
- 加载失败必须显式提示「当前显示的不是真实数据」+ 重试按钮（`Users.tsx` 的 `loadFailed` 范式）——空 catch 会让店主把接口挂掉当成「没数据」。
- 发赔偿券的服务端：`POST /admin/users/:id/coupons { templateId, remark, orderNo? }`，`remark` 必填、记 `issuedBy = req.adminUsername`、`sourceRef = orderNo`；**只允许 `source='ADMIN'` 且 `status='ON'` 的模板**（POINTS 模板有积分价、CAMPAIGN 模板有总量计数，手工发会把计数搞乱）。
- 所有管理端新端点在 `verifyAdminToken` 之后注册；发券端点加限流（沿用 `rate-limit.ts` 写法，每管理员每分钟 30 次足够）。
- 金额一律分；状态写入沿用 `updateMany` 判 `count`。
- 提交信息中文、`type(scope): 摘要`。

---

## 前置条件表

| # | 条件 | 现状（2026-09-05 写稿时） | 未满足时怎么办 |
|---|---|---|---|
| P1 | 批次一（同城）已走完上线路径；M1、M2 已合入 | ⬜ 见 M2 计划前置表 P1/P2 | 等 |
| P2 | M2 Task 3 的 `routes/admin/coupon-templates.ts`、`routes/admin/points-goods.ts` 已存在且有 e2e 冒烟 | ⬜ 随 M2 | 缺了先按 M2 Task 3 补，不要在 M3 里另起一套 |
| P3 | M1 Task 2 的 `GET/PUT /admin/settings/member` 已存在 | ⬜ 随 M1 | 缺了先补（照 `admin/settings.ts` 的 shipping 写法） |
| P4 | M2 Task 8 已把 `userId`、`couponId`、`discountAmount`、`pointsUsed`、`pointsEarned`、`items[].isGift/pointsCost` 加进 `orderListSelect` 与售后摘要 | ⬜ 随 M2 | 本计划 Task 7 的「发赔偿券」按钮靠列表行的 `userId` 定位顾客；缺了按钮做不出来 |
| P5 | 后台本地能起：`.claude/launch.json` 的 `admin`（5173，代理到 3100）+ `api-3100` | ✅ 配置在 | — |
| P6 | 现有后台页面手机端布局基线：`Users.tsx`、`Orders.tsx` 的 `mobileCards` 已存在 | ✅ | 新页面照抄 |

---

## 文件结构（本计划涉及）

| 路径 | 职责 |
|---|---|
| `apps/server/src/routes/admin/users.ts` | **Modify**。列表加 `pointsBalance/availableCoupons`；新增 `GET /:id/points-ledger`、`GET /:id/coupons`、`POST /:id/coupons` |
| `apps/server/src/middlewares/rate-limit.ts` | **Modify**。`adminIssueLimiter` |
| `apps/admin/src/types.ts` | **Modify**。`CouponTemplate`、`UserCouponRow`、`PointsGood`、`PointsLedgerRow`、`MemberSettings`；`AdminUser` 加两列；`Order/OrderItem` 加优惠字段（M2 若已加则跳过） |
| `apps/admin/src/api/admin.ts` | **Modify**。全部新端点包装 |
| `apps/admin/src/components/Layout.tsx` | **Modify**。导航加 3 项 |
| `apps/admin/src/App.tsx` | **Modify**。3 条路由 |
| `apps/admin/src/pages/Coupons.tsx` | **Create**。券模板管理 |
| `apps/admin/src/pages/PointsGoods.tsx` | **Create**。随单赠品管理 |
| `apps/admin/src/pages/MemberSettings.tsx` | **Create**。积分规则设置 |
| `apps/admin/src/components/IssueCouponModal.tsx` | **Create**。发券弹窗（用户页与订单页共用） |
| `apps/admin/src/pages/Users.tsx` | **Modify**。两列 + 三个操作 |
| `apps/admin/src/pages/Orders.tsx` | **Modify**。展开区优惠/赠品 + 「发赔偿券」 |
| `apps/admin/src/components/AfterSalePanel.tsx` | **Modify**。「发赔偿券」 |
| `apps/admin/src/components/RefundDialog.tsx` | **Modify**。实付/已用券灰字行 |
| `scripts/e2e.sh` | **Modify**。用户维度管理端接口用例 |
| `docs/api.md` | **Modify**。附录 D 追加 |

---

### Task 1: 用户维度的管理端接口

**Files:**
- Modify: `apps/server/src/routes/admin/users.ts`
- Modify: `apps/server/src/middlewares/rate-limit.ts`

**Interfaces:**
- `GET /admin/users` 每行加 `pointsBalance`（直接取 `User.pointsBalance`）与 `availableCoupons`（`UserCoupon` 中 `status='UNUSED' && expiresAt > now` 的计数）。计数用一次 `groupBy({ by: ['userId'], where: { userId: { in: ids }, … }, _count })`，**不要在 map 里逐用户查**。
- `GET /admin/users/:id/points-ledger?page=&pageSize=` → 分页倒序流水：`type`、`typeLabel`（中文：消费得分 / 兑换券 / 随单赠品 / 取消退回 / 退款扣回 / 过期）、`delta`、`balanceAfter`、`refType`、`refId`、`orderNo?`（`refType='ORDER'` 时联查）、`remark`、`expiresAt`、`createdAt`。
- `GET /admin/users/:id/coupons?status=` → 该用户全部券（含已用/过期），每行带 `name/code/amount/threshold/channel/status/source/sourceRef/issuedBy/remark/expiresAt/usedAt/orderNo?/createdAt`。管理端**可以**看 `issuedBy/remark`（顾客端不行，M1 Task 7 已定）。
- `POST /admin/users/:id/coupons { templateId, remark, orderNo? }` → 校验用户存在；模板存在、`source='ADMIN'`、`status='ON'`（否则 42254 / 40001）；`remark` 1..255；`orderNo` 若传必须是该用户的订单（否则 40001「订单不属于该用户」）；调 M1 的 `issueCoupon(tx, { userId, template, source: 'ADMIN', sourceRef: orderNo, issuedBy: req.adminUsername, remark })`；返回新券。

- [ ] **Step 1: 列表两列**（`groupBy` 一次查）
- [ ] **Step 2: 两个只读端点**（用户不存在 40401；分页上限 50）
- [ ] **Step 3: 发券端点** + `adminIssueLimiter`（`keyGenerator` 用管理员名，`ipKeyGenerator` 兜底）
- [ ] **Step 4: curl 冒烟**：发一张、列表 `availableCoupons` +1、券记录里有 `issuedBy` 与备注；用 POINTS 模板发 → 被拒；`orderNo` 填别人的 → 40001。

**Acceptance:** 四个端点可用；e2e 用例在 Task 8 落。

---

### Task 2: 类型、API 包装、导航与路由

**Files:**
- Modify: `apps/admin/src/types.ts`、`apps/admin/src/api/admin.ts`、`apps/admin/src/components/Layout.tsx`、`apps/admin/src/App.tsx`

- [ ] **Step 1: `types.ts`**
  按 spec §4 逐字段建 `CouponTemplate`、`UserCouponRow`、`PointsGood`（含展开的 `product: { name, coverImage, channel, status, deletedAt }` 与 `sku?`）、`PointsLedgerRow`、`MemberSettings`；`AdminUser` 加 `pointsBalance`、`availableCoupons`；`Order` 加 `userId`、`couponId`、`discountAmount`、`pointsUsed`、`pointsEarned`、`coupon?`；`OrderItem` 加 `isGift`、`pointsCost`（M2 Task 9 若已加则跳过）。
- [ ] **Step 2: `api/admin.ts`**
  `getCouponTemplates / createCouponTemplate / updateCouponTemplate / getCouponTemplateIssued`；`getPointsGoods / createPointsGood / updatePointsGood / deletePointsGood`；`getMemberSettings / updateMemberSettings`；`getUserPointsLedger / getUserCoupons / issueUserCoupon`。
- [ ] **Step 3: 导航**
  `navItems` 在「店铺设置」之后、「同城订单」之前插三项：`{ to: '/coupons', label: '优惠券', icon: Ticket }`、`{ to: '/points-goods', label: '积分赠品', icon: Gift }`、`{ to: '/member-settings', label: '会员设置', icon: Star }`（lucide 图标名执行时核对存在）。**平铺，不做分组**（见 D1）。
- [ ] **Step 4: `App.tsx` 三条路由**；`npx tsc --noEmit` 零错误后再进 Task 3。

**Acceptance:** 三个导航项能点开空页；`tsc` 零错误。

---

### Task 3: `Coupons.tsx` 券模板管理

**Files:**
- Create: `apps/admin/src/pages/Coupons.tsx`

**页面结构**：顶部筛选（来源 ALL/ADMIN/POINTS/CAMPAIGN/NEWCOMER、状态）+「新建模板」；表格列：名称 / 面额 / 门槛（0 显示「无门槛」）/ 渠道 / 来源 / 有效期 N 天 / 已发 `issuedCount`（CAMPAIGN 显示 `已发/总量`）/ 已用 `usedCount` / 状态 / 操作（编辑、停用|启用、发放记录）。`mobileCards` 双渲染。

- [ ] **Step 1: 列表 + 筛选 + 失败态**
- [ ] **Step 2: 新建/编辑弹窗**
  字段：名称、描述、面额（元→分）、门槛（元→分，0=代金券）、渠道、有效天数、来源（**新建时选，编辑时只读**）；按来源动态显隐：POINTS → 积分价（必填）；CAMPAIGN → 总量（可空=不限）、每人限领；NEWCOMER → 提示「在会员设置里选中才会发」；ADMIN → 提示「店员在用户页/订单页手动发」。校验与服务端 zod 一致，错误显示在字段下方。
- [ ] **Step 3: 停用/启用**
  `confirmDialog` 文案明确「停用只影响再发放，已发出去的券顾客照常可用」。
- [ ] **Step 4: 发放记录弹窗**（`Modal width="lg"`）
  表格：用户 / 券码 / 状态 / 来源 / 操作人 / 备注 / 关联订单 / 发放时间；分页。
- [ ] **Step 5: 375px 宽度目测**：卡片能读、按钮不溢出。

**Acceptance:** 增改停用与记录四个动作走通；表单校验与服务端一致（提交非法值服务端 400 时前端能显示 message）。

---

### Task 4: `PointsGoods.tsx` 随单赠品管理

**Files:**
- Create: `apps/admin/src/pages/PointsGoods.tsx`

**页面结构**：表格列：商品（图 + 名 + 规格）/ 渠道（只读，随商品）/ 积分价 / 每单限购 / 总量（`issuedCount/stockLimit` 或「不限」）/ 商品状态（在架 / 已下架 / 已删除——后两者高亮提示「顾客端不会显示」）/ 状态 / 操作（编辑、启停、删除）。

- [ ] **Step 1: 选商品**
  新建弹窗里一个关键词搜索框 → `getProducts({ keyword, pageSize: 20 })` → 单选；有 SKU 的商品必须再选 SKU（列出 `specText`）。**不新建通用「商品选择器」组件**——本页是唯一用处，YAGNI。
- [ ] **Step 2: 积分价 / 每单限购（默认 1）/ 总量（可空）**；同商品同 SKU 重复 → 显示服务端 40001 消息。
- [ ] **Step 3: 删除** 用 `confirmDialog`；文案说明「已下单的赠品不受影响」。
- [ ] **Step 4: 375px 目测**。

**Acceptance:** 能给无 SKU 与有 SKU 商品各建一条赠品；渠道列正确；删除后 `checkout-options` 不再返回它（curl 验）。

---

### Task 5: `MemberSettings.tsx` 积分规则设置

**Files:**
- Create: `apps/admin/src/pages/MemberSettings.tsx`

- [ ] **Step 1: 表单**
  积分开关；每消费 1 元得分（整数 1..100）；积分有效期天数（1..3650）；新客券下拉（`getCouponTemplates({ source: 'NEWCOMER' })` 的 ON 模板 + 「不发」）；规则说明补充文案（多行，≤ 500 字，提示「会显示在小程序会员中心规则说明的末尾」）。
- [ ] **Step 2: 保存前校验**，失败态与 `LocalSettings.tsx` 一致；保存成功 `toast.success`。
- [ ] **Step 3: 关闭开关时的说明文案**：「关闭后不再发放积分；顾客已有积分仍可使用至过期」（对应 M2 计划 D1 的默认，若 PO 改了 D1 这里同步改）。

**Acceptance:** 改比例后立刻读回新值（M1 的缓存清除生效）；非法值被前后端双双拦住。

---

### Task 6: `Users.tsx` 积分/券列 + 发券 + 两个抽屉

**Files:**
- Create: `apps/admin/src/components/IssueCouponModal.tsx`
- Modify: `apps/admin/src/pages/Users.tsx`

**Interfaces:**
- `IssueCouponModal({ userId, userLabel, defaultOrderNo?, onClose, onDone })`：拉 `source=ADMIN` 且 ON 的模板列表 → 单选（显示面额/门槛/渠道/有效期）→ 备注必填（预设胶囊：少发补偿 / 品质问题 / 配送延误 / 其他手填，照 `RefundDialog` 的 `REASON_PRESETS` 写法）→ 关联订单号（可编辑，订单页打开时预填）→ 「下一步」→ 红色确认页复述「给 {userLabel} 发 {券名}，{面额}，{有效期}」→ 确认。成功 `toast.success('已发券 C…')`，`onDone` 由父组件刷新。

- [ ] **Step 1: 表格加两列**「积分」「可用券」，`columns` 从 7 改 9；`mobileCards` 的摘要行加「积分 N · 券 M」。
- [ ] **Step 2: 操作列三个动作**：查看订单（已有）、发券、积分明细、券记录（手机卡片上四个文字按钮一行放不下就两行）。
- [ ] **Step 3: `IssueCouponModal`**（两步确认）。
- [ ] **Step 4: 积分明细弹窗**：`Modal width="lg"`，表格：时间 / 类型 / 变动（正绿负红）/ 变动后余额 / 关联（订单号可复制）/ 备注 / 到期；分页 20。
- [ ] **Step 5: 券记录弹窗**：状态 Tab（全部/可用/已用/已过期）；列：券名 / 券码 / 面额 / 状态 / 来源 / 操作人 / 备注 / 到期 / 使用订单。
- [ ] **Step 6: 发券后列表行 `availableCoupons` 刷新**（重新 `load()` 当前页即可）。

**Acceptance:** 给一个用户发券 → 列表 +1 → 券记录里能看到操作人与备注 → 顾客端 `GET /member/coupons` 能查到（curl）。

---

### Task 7: `Orders.tsx` / `AfterSalePanel` / `RefundDialog`

**Files:**
- Modify: `apps/admin/src/pages/Orders.tsx`、`apps/admin/src/components/AfterSalePanel.tsx`、`apps/admin/src/components/RefundDialog.tsx`

- [ ] **Step 1: `Orders.tsx` 展开区**
  `renderDetailLines` 加「优惠券 −¥X」（`discountAmount > 0`）与「赠品抵扣 N 积分」（`pointsUsed > 0`）；商品表格 `isGift` 行名称前加「赠」标、单价/小计列显示 `积分 {pointsCost}` / `—`。桌面表格与 `mobileCards` 两处都改。
- [ ] **Step 2: `Orders.tsx` 操作列加「发赔偿券」**
  `renderActions` 里，对**有成功支付记录**的订单（`status ∉ PENDING_PAYMENT/CANCELLED`）显示；点开 `IssueCouponModal({ userId: order.userId, userLabel: order.receiverName, defaultOrderNo: order.orderNo })`。与「退款」并列、可单独使用（spec §7：可只发券不退款）。
- [ ] **Step 3: `AfterSalePanel`**
  每条售后卡片加「发赔偿券」（`AfterSale.userId` 就有）；展示订单摘要时若 `order.discountAmount > 0` 加一行灰字。
- [ ] **Step 4: `RefundDialog`**
  `Props.order` 的 `Pick` 加 `discountAmount`；第一步信息块「实付 ¥X」后追加 `（商品 ¥A − 券 ¥B + 运费 ¥C）`，`discountAmount > 0` 时再加一行橙色提示「本单用了优惠券，可退金额以实付为准，退款不退券」。**不改任何金额校验**（服务端已兜住，见 M2 Task 7）。
- [ ] **Step 5: 用 M2 的 e2e 造一张用券 + 赠品的单，浏览器看三处**。

**Acceptance:** 用券单在列表/展开/退款弹窗/售后面板四处显示一致；「发赔偿券」从订单页发出的券 `sourceRef = 订单号`。

---

### Task 8: e2e + 浏览器实测清单 + docs

**Files:**
- Modify: `scripts/e2e.sh`、`docs/api.md`

- [ ] **Step 1: e2e 「管理端会员：用户维度」段**
  `GET /admin/users` 含 `pointsBalance/availableCoupons` → 发券成功且 `issuedBy=admin`、`remark` 对、`sourceRef` 对 → `remark` 缺 40001 → POINTS 模板 40001/42254 → 别人的 `orderNo` 40001 → `GET /:id/coupons` 含刚发的券 → `GET /:id/points-ledger` 分页可用 → 顾客端 `GET /member/coupons` 能看到、但**看不到** `issuedBy/remark`（越权字段白名单）→ 停用模板后再发 42254。
- [ ] **Step 2: 浏览器实测清单**（桌面 + 375px，写进 PR 描述逐项打勾）
  券模板：建/改/停用/记录；赠品：无 SKU 与有 SKU 各一条、删除；会员设置：改比例/新客券/文案；用户页：两列、发券两步确认、两个弹窗；订单页：展开区、发赔偿券、退款弹窗灰字；售后面板：发赔偿券。每项截图一张。
- [ ] **Step 3: `docs/api.md` 附录 D** 追加用户维度四个端点。
- [ ] **Step 4: 全量 e2e 两轮全绿；`apps/admin` 与 `apps/server` `tsc` 零错误。**

**Acceptance:** 新增用例 ≥ 12 条全绿；实测清单全勾。

---

## 完成标准（M3 整体）

1. `bash scripts/e2e.sh` 连续两轮全绿；新增用例覆盖 Task 8 Step 1 全部条目。
2. `apps/admin`、`apps/server` `tsc --noEmit` 零错误。
3. 浏览器实测清单（Task 8 Step 2）全勾且有截图。
4. 三个新页面在 375px 宽度可用（`mobileCards` 存在且能操作）。
5. 顾客端**仍无任何可见变化**（M4 才动小程序）；`GET /member/*` 的输出白名单没有因为管理端需求被放宽（e2e 锁住）。
6. 每一张 ADMIN 券都能在「券记录」里追到操作人、备注、关联订单（spec §5.7）。

---

## 明确不做（本计划范围外）

1. 不做小程序（M4）。
2. 不做积分手动加减/店员送分（P4）；`PointsLedger.type='ADMIN'` 继续预留，无入口。
3. 不做导航分组、折叠菜单、Drawer 组件等基础设施——平铺三项、弹窗当抽屉。
4. 不做通用商品选择器组件；赠品页内联搜索即可。
5. 不做券模板删除（spec 只有停用）；不做模板复制、批量发券、按标签发券。
6. 不做「按是否用券」筛选订单、券使用率报表、积分负债报表。
7. 不做后台 RBAC（谁能发券）——目前后台单账号体系，`issuedBy` 记的是登录名。
8. 不改退款金额校验（M2 Task 7 已定：服务端兜住）。

---

## 需 PO 决定（本计划已给默认，PO 不反对即按默认执行）

| # | 问题 | spec 现状 | 本计划默认 | 为什么要问 |
|---|---|---|---|---|
| D1 | 导航「营销」是分组（下挂券模板与赠品）还是平铺 | spec §7 写「或平铺两项」二选一 | **平铺三项**：优惠券 / 积分赠品 / 会员设置 | 分组要给 `Layout` 加折叠逻辑；平铺后侧栏 15 项，手机抽屉需要滚动 |
| D2 | 「发赔偿券」按钮对哪些订单显示 | spec 只说「订单详情与售后面板加」 | **有成功支付记录的订单**（含已完成、已退款）；待付款与已取消不显示 | 若 PO 希望「只对已完成/已退款的单赔偿」，默认范围偏宽 |
| D3 | 赔偿券备注的预设胶囊文案 | 未提 | 少发补偿 / 品质问题 / 配送延误 / 其他 | 会原样出现在券记录里，属于店内口径 |
| D4 | 券模板编辑时哪些字段可改 | 未提；快照机制保证已发券不受影响 | **除 `source` 外都可改**（面额/门槛/渠道/有效期/限量） | 改面额后「同一模板发出的券面额不同」会让店员对不上账；替代方案是「面额门槛也锁死、只能改名与描述」 |
| D5 | 「积分明细」「券记录」是否也让店员看到**顾客端不显示**的字段（`issuedBy/remark`） | spec §5.7 说管理端可查发放记录 | 显示 | 备注里可能有对顾客不友好的话（「投诉客」），只在后台可见 |
