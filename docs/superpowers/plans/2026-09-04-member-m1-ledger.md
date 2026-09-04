# 会员 M1：积分账本与券的生命周期 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

设计依据：`docs/superpowers/specs/2026-09-04-member-points-coupon-design.md`（下称 spec）。开工前必读 spec §5（服务端核心规则）与 §11（硬依赖）。

**Goal:** 在不改变现有下单与退款任何行为的前提下，把「积分账本」和「优惠券生命周期」两套底座建起来：积分能在订单完成时按规则发放、能按先到期先扣的顺序消耗、能过期、能在退款时按比例扣回且永不为负；券能从四条来源发出、能过期、状态可查。**M1 不碰下单计价，不碰前端**——顾客还看不到任何变化，但服务端已经能正确记账。

**Architecture:** 一次 Prisma 迁移落下 M1–M2 全部表结构（`PointsLedger`、`CouponTemplate`、`UserCoupon`、`PointsGood`、`User.pointsBalance`、`Order` 四列 + `pointsSettledAt`、`OrderItem` 两列），本计划只使用其中 M1 需要的部分，计价相关列留给 M2。`services/member/points.ts` 是积分的唯一实现（发放/FIFO 扣减/过期/退款扣回），`services/member/coupons.ts` 是券的唯一实现（发放/过期/查询），`services/member/settings.ts` 照抄 `services/settings.ts` 的 KV 缓存范式。发放入口一律 fire-and-forget，正确性由 `@@unique` 幂等键与 scheduler 兜底任务共同保证。

**Tech Stack:** Node 25 / Express 4 / Prisma 5.22 (MySQL 8) / zod 4。测试：`scripts/e2e.sh`（bash+curl+jq，后端 `PORT=3100 WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true`）+ `apps/server/scripts/selftest-member.ts`（ts-node 纯函数自测）。无单元测试框架，不引入。

## Global Constraints

- 金额一律 **分**（Int）；积分是无量纲 Int。状态一律 `String @db.VarChar(16)` + 注释枚举，**不使用 Prisma enum**。
- 迁移目录名 `<YYYYMMDDHHMMSS>_member_points_coupon`，**时间戳必须晚于仓库中已有的最新迁移**（落地前用 `ls apps/server/prisma/migrations | tail -1` 确认，截至写稿是同城分支的 `20260905000000`）。
- `PointsLedger` 的 `@@unique([type, refType, refId])` 是幂等唯一防线：任何写流水的地方都必须能容忍 P2002 并把它当作「已经做过」。
- **`Order.pointsSettledAt` 是唯一的「已结算」标记**，禁止用 `pointsEarned === 0` 判断（spec §5.4）。
- 可用积分行 = `type IN ('EARN','GIFT_REVERT') && remaining > 0 && expiresAt > now`；FIFO 按 `expiresAt ASC, id ASC`。
- 扣减一律 `updateMany({ where: { id, remaining: { gte: take } }, data: { remaining: { decrement: take } } })` 判 count，count=0 视为被并发抢走。
- 退款扣回三重上限：`floor(refund.amount/100)×rate`、`pointsEarned − 已扣回`、`user.pointsBalance`，**结果不得为负**。
- 所有 `/member/*` 端点一律 `where: { userId: req.user.id }`，禁止接受前端传入的 userId。
- 新错误码：`42250` 积分不足 · `42251` 优惠券不可用 · `42253` 该券已领完或已达每人上限 · `42254` 券模板已停用。（`42252` 赠品相关留给 M2。）
- 积分开关 `member.points.enabled=false` 时：`settlePoints` 与 `settleMissedPoints` 直接返回，不写任何数据。
- 本计划**不改** `routes/orders.ts` 的计价逻辑、不改 `apps/admin`、不改 `apps/miniapp`。
- 提交信息用中文、`type(scope): 摘要` 格式。

---

## 文件结构（本计划涉及）

| 路径 | 职责 |
|---|---|
| `apps/server/prisma/schema.prisma` + `prisma/migrations/<ts>_member_points_coupon/migration.sql` | 全部新表与新列（M1–M2） |
| `apps/server/src/services/member/settings.ts` | `member` 设置读写 + 60s 缓存（照抄 `services/settings.ts`） |
| `apps/server/src/services/member/points.ts` | 发放 / FIFO 扣减 / 过期 / 退款扣回 的唯一实现 |
| `apps/server/src/services/member/coupons.ts` | 发券 / 过期 / 查询 的唯一实现 |
| `apps/server/scripts/selftest-member.ts` | 纯函数自测（earn 取整、扣回上限、code 生成） |
| `apps/server/src/routes/member.ts` | `GET /member/summary`、`/member/points/ledger`、`/member/coupons` |
| `apps/server/src/routes/orders.ts` | 仅在 `PUT /orders/:id/confirm` 后追加一行 `settlePoints` 调用 |
| `apps/server/src/services/scheduler.ts` | 任务表新增 3 项 |
| `apps/server/src/services/refund.ts` | `finalizeRefundSuccess` 末尾追加退款扣回 |
| `apps/server/src/routes/auth.ts`（或 wechat-login 所在文件） | 新用户创建后发新客券 |
| `apps/server/src/routes/admin/settings.ts` | `GET/PUT /admin/settings/member` |
| `apps/server/prisma/seed.ts` | 非生产追加 3 个券模板样例 |
| `scripts/e2e.sh` | 新增用例段 |
| `scripts/check-points-consistency.mjs` | 余额 = Σ入账行 remaining 的只读校验 |
| `docs/api.md` | 新端点说明 |

---

### Task 1: Prisma 迁移（一次落库 M1–M2 全部结构）

**Files:**
- Modify: `apps/server/prisma/schema.prisma`
- Create: `apps/server/prisma/migrations/<ts>_member_points_coupon/migration.sql`

**Interfaces:**
- Produces: `PointsLedger`、`CouponTemplate`、`UserCoupon`、`PointsGood` 四个模型；`User.pointsBalance`；`Order.couponId/discountAmount/pointsUsed/pointsEarned/pointsSettledAt`；`OrderItem.isGift/pointsCost`。字段定义逐字照抄 spec §4。

- [ ] **Step 1: 确认迁移时间戳**
  `ls apps/server/prisma/migrations | tail -3`，新目录名的时间戳必须**严格大于**最后一个。若本分支尚未包含同城迁移，仍要按 spec §11.3 用一个足够靠后的时间戳，避免将来与同城合并时乱序。
- [ ] **Step 2: 按 spec §4 写 schema**
  注意四处易错：① `PointsLedger.@@unique([type, refType, refId])`；② `Order.@@index([status, pointsSettledAt, completedAt])`；③ `UserCoupon` 的四个快照列（name/amount/threshold/channel）不是关系字段；④ `PointsGood.@@unique([productId, skuId])` 在 MySQL 下不约束 NULL，代码里要先 `findFirst`。
- [ ] **Step 3: 生成并校对 migration.sql**
  `npx prisma migrate dev --create-only`，改名到确定的时间戳目录，人工核对：新列全部有 `DEFAULT` 或可空（存量行不能报错）；`user_coupons.code` 的唯一索引存在；无任何 `DROP`。
- [ ] **Step 4: 应用并验证**
  `npm run db:migrate:deploy` 后 `npx prisma studio` 或 SQL 抽查四张新表结构；跑一次现有 `scripts/e2e.sh` 确认**全部既有用例仍绿**（本步骤零行为变更）。

**Acceptance:** 迁移可在空库与存量库上分别成功应用；既有 e2e 全绿；`git diff` 只含 schema 与迁移文件。

---

### Task 2: 会员设置（`services/member/settings.ts`）

**Files:**
- Create: `apps/server/src/services/member/settings.ts`
- Modify: `apps/server/src/routes/admin/settings.ts`

**Interfaces:**
- Produces: `MemberSettings` 类型、`getMemberSettings()`、`setMemberSettings()`、`clearMemberSettingsCache()`；`GET/PUT /api/admin/settings/member`。

- [ ] **Step 1: 照抄 `services/settings.ts` 的结构**
  key `'member'`，60s 进程内缓存，`sanitize()` 兜底所有字段，读失败时返回**保守默认**（`enabled: false`，即读不到设置就不发分，避免误发）。默认值：`points { enabled: true, earnRatePerYuan: 1, validDays: 365 }`、`newcomer { templateId: null }`、`rulesText: ''`。
- [ ] **Step 2: 校验规则**
  `earnRatePerYuan` 为 1..100 的整数；`validDays` 为 1..3650 的整数；`newcomer.templateId` 若非空必须指向存在且 `source='NEWCOMER'` 的模板，否则 400。
- [ ] **Step 3: 挂管理端点**
  沿用 `admin/settings.ts` 里 shipping 的写法，`PUT` 后 `clearMemberSettingsCache()`。

**Acceptance:** `curl` 读到默认值；写入非法比例被拒；写入后立刻读到新值（缓存已清）。

---

### Task 3: 积分账本核心（`services/member/points.ts`）

**Files:**
- Create: `apps/server/src/services/member/points.ts`
- Create: `apps/server/scripts/selftest-member.ts`

**Interfaces:**
- Produces: `calcEarn(actualAmount, refundedAmount, rate)`、`consumePoints(tx, userId, amount, meta)`、`settlePoints(orderId)`、`expirePointsBatch(limit)`、`deductPointsOnRefund(tx, order, refund)`、`getPointsSummary(userId)`、`listLedger(userId, page)`。

- [ ] **Step 1: 先写纯函数与自测**
  `calcEarn` = `Math.floor(Math.max(0, actual − refunded) / 100) × rate`；退款扣回上限函数 `calcRefundDeduct(refundAmount, rate, earned, alreadyDeducted, balance)` 取三者最小值且不小于 0。在 `selftest-member.ts` 里覆盖边界：金额 0、金额 99 分（得 0）、金额 100 分、已退款超过实付、扣回三重上限各自触顶、余额为 0。**先跑通自测再写下面的 DB 逻辑。**
- [ ] **Step 2: `consumePoints`（FIFO 扣减）**
  按 spec §5.4：取入账行 `expiresAt ASC, id ASC`，逐行条件扣减判 count；被并发抢走则重取一次，两轮仍不足抛 `AppError(42250)`。成功后写一条负 delta 流水（`balanceAfter` 取扣减后的余额）+ `User.pointsBalance decrement`。**必须在调用方传入的事务 `tx` 内执行**，不自开事务。
- [ ] **Step 3: `settlePoints(orderId)`**
  严格按 spec §5.4 的五条前置与两个分支（`earn <= 0` 只写标记；`earn > 0` 写流水 + 标记 + 余额）。P2002 视为已发过，补写标记后正常返回。函数自身 try/catch 全包，**永不向调用方抛错**（调用点都是 fire-and-forget）。
- [ ] **Step 4: `expirePointsBatch`**
  扫过期入账行，批 200，逐行 `remaining → 0` + EXPIRE 流水（`refType='LEDGER'`, `refId` = 该行 id）+ 余额递减。返回处理条数。
- [ ] **Step 5: `deductPointsOnRefund`**
  在 `finalizeRefundSuccess` 的事务里被调用：算已扣回量（该订单全部 `REFUND_DEDUCT` 流水 delta 绝对值之和）→ 三重上限 → 先扣本单那条 EARN 行的 remaining，不足按 FIFO 扣其他入账行，仍不足扣到 0 为止 → 写 `REFUND_DEDUCT` 流水（`refType='REFUND'`, `refId=refund.id`）。`deduct === 0` 时不写流水直接返回。
- [ ] **Step 6: 只读查询**
  `getPointsSummary` 返回 `{ balance, expiringSoon: { points, date } | null }`（30 天内将过期的入账行合计与最早日期）；`listLedger` 分页倒序，每行带类型中文文案与关联订单号。

**Acceptance:** `npx ts-node apps/server/scripts/selftest-member.ts` 全绿；手工造数据验证 FIFO 先扣早到期那笔；重复调 `settlePoints` 只发一次分。

---

### Task 4: 券的生命周期（`services/member/coupons.ts`）

**Files:**
- Create: `apps/server/src/services/member/coupons.ts`

**Interfaces:**
- Produces: `issueCoupon(tx, {userId, template, source, sourceRef, issuedBy, remark})`、`redeemByPoints(userId, templateId)`、`claimCampaign(userId, templateId)`、`issueNewcomerCoupon(userId)`、`expireCouponsBatch(limit)`、`listUserCoupons(userId, status)`、`countAvailable(userId)`。

- [ ] **Step 1: `issueCoupon` 公共发放函数**
  生成 `code` = `'C' + 8 位 Crockford base32 随机`，唯一冲突重试 3 次；快照 name/amount/threshold/channel；`expiresAt = now + template.validDays 天`。模板 `status='OFF'` 直接抛 `AppError(42254)`。
- [ ] **Step 2: `redeemByPoints`**
  事务：校验 `source='POINTS'` 且 `pointsCost > 0`；`perUserLimit` 用该用户该模板已发数判定（超出 42253）；`consumePoints` 扣分；`issueCoupon`；写 REDEEM 流水（`refType='COUPON'`, `refId=userCouponId`）。**注意顺序**：券要先建出来才有 id 可写进流水，故先发券再写流水，两者同事务。
- [ ] **Step 3: `claimCampaign`**
  `updateMany({ where: { id, status:'ON', ...(totalLimit != null ? { issuedCount: { lt: totalLimit } } : {}) }, data: { issuedCount: { increment: 1 } } })`，count=0 → 42253；再 `issueCoupon`。两步同事务，发券失败则回滚计数。
- [ ] **Step 4: `issueNewcomerCoupon`**
  读设置取模板；模板为空/OFF 直接返回；查 `UserCoupon(userId, templateId, source='NEWCOMER')` 已存在则返回；否则发。整体 try/catch 吞错（登录不能因发券失败而挂）。
- [ ] **Step 5: `expireCouponsBatch`**
  `updateMany({ where: { status: 'UNUSED', expiresAt: { lt: now } }, data: { status: 'EXPIRED' } })`，分批返回条数。
- [ ] **Step 6: 读取一律按时间判定**
  `listUserCoupons` 与 `countAvailable` 的「可用」条件必须同时含 `status='UNUSED' && expiresAt > now`，**不依赖定时任务是否已跑**。

**Acceptance:** 三条发放路径各发出一张券；停用模板发放被拒；限量券并发领取不超发（用两个并发 curl 验证）；过期券不出现在可用列表里。

---

### Task 5: 接入发放与扣回的调用点

**Files:**
- Modify: `apps/server/src/routes/orders.ts`（`PUT /orders/:id/confirm` 之后）
- Modify: `apps/server/src/services/scheduler.ts`（`autoCompleteShippedOrders` 之后）
- Modify: `apps/server/src/services/refund.ts`（`finalizeRefundSuccess` 内）
- Modify: 微信登录所在路由（新用户创建后）

- [ ] **Step 1: 确认收货后发分**
  在订单成功转 COMPLETED 的那次 `updateMany` 判 count 之后追加 `void settlePoints(orderId)`，**不 await 影响响应**，不放进事务。
- [ ] **Step 2: 自动收货后发分**
  `autoCompleteShippedOrders` 每成功完成一单即 `void settlePoints(id)`。
- [ ] **Step 3: 退款扣回**
  在 `finalizeRefundSuccess` 已有事务的末尾（`refundedAmount` 累加与订单状态更新之后）调 `deductPointsOnRefund(tx, order, refund)`。**必须在同一事务内**，否则退款成功但扣回失败会留下不一致。
- [ ] **Step 4: 新客券**
  微信登录里「新建 User」分支之后 `void issueNewcomerCoupon(user.id)`。
- [ ] **Step 5: 同城的两条 COMPLETED 路径**
  同城分支的配送 520 回调与店员「标记已送达」也要加 `settlePoints`。**若本分支尚未包含同城代码，本步骤记为待办写进 `docs/api.md` 的交接说明，不要凭空创建文件。** 兜底任务能覆盖这两条路径，功能不受影响。

**Acceptance:** 完成一单后查库有 EARN 流水且 `pointsSettledAt` 非空；部分退款后有 `REFUND_DEDUCT` 流水且余额未变负；新用户首登有券、二次登录不重复发。

---

### Task 6: 定时任务

**Files:**
- Modify: `apps/server/src/services/scheduler.ts`

- [ ] **Step 1: 任务表新增三项**
  `settleMissedPoints`（每 tick）、`expirePoints`（每日）、`expireCoupons`（每日）。沿用现有 `const tasks: [string, () => Promise<number>][]` 结构与逐项 try/catch + `notifySystemAlert` 的写法。
- [ ] **Step 2: 每日任务的执行判定**
  用 `Setting` key `member_cron_state` 存 `{ lastExpirePointsAt, lastExpireCouponsAt }`，到日切才跑，避免进程重启后重复跑或整天不跑。
- [ ] **Step 3: `settleMissedPoints` 的扫描条件**
  严格按 spec §5.4：`COMPLETED && pointsSettledAt IS NULL && isTest = false && completedAt BETWEEN now−7d AND now−2min`，批 100。**开关关闭时直接返回 0。** `isTest` 列若在本分支不存在，条件先省略并在代码注释里标明「同城合并后必须补上」（spec §11.1）。
- [ ] **Step 4: 支持 e2e 强制触发**
  扩展 `POST /admin/system/run-scheduler` 的 overrides，让 e2e 能把 `settleMissedPoints` 的下界与每日任务的日切判定绕过。

**Acceptance:** 手工把一条 EARN 的 `expiresAt` 改到过去 → 触发任务 → `remaining=0` 且余额同步；漏挂钩子的订单在 2 分钟后被补发。

---

### Task 7: 顾客端只读接口

**Files:**
- Create: `apps/server/src/routes/member.ts`
- Modify: 路由注册处（`app.ts` 或 `routes/index.ts`）

- [ ] **Step 1: 三个只读端点**
  `GET /member/summary`、`GET /member/points/ledger?page=&pageSize=`、`GET /member/coupons?status=available|used|expired`。全部走用户鉴权中间件。
- [ ] **Step 2: 输出白名单**
  券对象只返回 `id, code, name, amount, threshold, channel, status, source, expiresAt, usedAt`；**不返回** `issuedBy / remark / sourceRef / templateId`。流水只返回 `type 文案, delta, refType, refId, remark, createdAt`。
- [ ] **Step 3: 限流**
  复用 `rate-limit.ts` 的写法给这三个端点加宽松限流（含 `ipKeyGenerator` 兜底）。

**Acceptance:** 三个端点返回正确；A 用户查不到 B 的数据；未登录 401。

---

### Task 8: e2e 与一致性校验

**Files:**
- Modify: `scripts/e2e.sh`
- Create: `scripts/check-points-consistency.mjs`

- [ ] **Step 1: 一致性脚本**
  只读校验「每个用户的 `pointsBalance` == Σ(未过期入账行 remaining)」，不一致则列出用户与差额并以非 0 退出。
- [ ] **Step 2: e2e 用例段**（插在现有清理段之前，沿用 `== N. 中文描述 ==` + `assert_eq` 的写法）
  按 spec §9 覆盖：发分幂等、`earn=0` 不重扫（跑两次任务后 `pointsSettledAt` 仍只写一次且无流水）、FIFO 先扣早到期、余额不足 42250、过期清零、退款扣回按比例且不为负、连续两次部分退款不超扣、三条发券路径、停用模板 42254、限量券并发不超发、每人限领、新客券不重复、过期券不在可用列表、越权 403/404。
- [ ] **Step 3: 把一致性脚本接进 e2e**
  在用例段末尾 `node scripts/check-points-consistency.mjs`，非 0 退出即判红。

**Acceptance:** `bash scripts/e2e.sh` 全绿（既有用例 + 新增用例）；一致性脚本在正常数据上退出码 0。

---

### Task 9: 种子数据与文档

**Files:**
- Modify: `apps/server/prisma/seed.ts`
- Modify: `docs/api.md`

- [ ] **Step 1: seed 三个券模板样例**（非生产才插，沿用 `upsert` + 空 `update: {}` 的写法，重跑不覆盖）
  「新人礼 满30减5」`source=NEWCOMER`；「积分兑 满50减10」`source=POINTS, pointsCost=200`；「客服补偿 无门槛10元」`source=ADMIN`。
- [ ] **Step 2: `docs/api.md`**
  新增会员端点段与四个错误码；把 Task 5 Step 5 的同城交接待办写进文末「已知待办」。

**Acceptance:** 空库 seed 后能直接跑通 Task 8 的 e2e；文档与实际端点一致。

---

## 完成标准（M1 整体）

1. `bash scripts/e2e.sh` 全绿，且新增用例覆盖 spec §9 的积分与券条目。
2. `npx ts-node apps/server/scripts/selftest-member.ts` 全绿。
3. `node scripts/check-points-consistency.mjs` 退出码 0。
4. 双端 `tsc` 零错误（`apps/server` 必跑；admin/miniapp 本里程碑未改动）。
5. 顾客端与后台**没有任何可见变化**——M1 是纯底座，看得见的东西在 M2–M4。
6. 交接说明：同城分支的两条 COMPLETED 路径与 `isTest` 过滤是否已补，明确写在 PR 描述里。
