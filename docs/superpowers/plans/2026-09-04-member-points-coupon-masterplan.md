# 会员积分 + 积分商城 + 优惠券（含赔偿券）——方案与实施总计划

> **文件性质**：这是 2026-09-04 经 PO 批准的**顶层方案与实施总计划**，原本只存在于 Claude 的临时
> plan 目录（`~/.claude/plans/`），不在仓库里、git 看不见。2026-09-04 晚做 M4 前置核验时发现它
> 连同合规调研都未落盘，故原样收录进仓库保存。**正文未作任何改动**；核验带来的修正统一写在文末
> 《2026-09-04 落盘时的核验补充》一节，读的时候两处都要看。
>
> **执行状态：未开始。** 正文《本次要产出的文档》列的三份交付物中：
> - ① 合规调研 `docs/research/2026-09-03-member-wallet-points-coupon-compliance.md` —— ✅ 已随本次提交落盘
> - ② spec `docs/superpowers/specs/2026-09-04-member-points-coupon-design.md` —— ⬜ **尚未撰写**
> - ③ M1 实施计划 `docs/superpowers/plans/2026-09-04-member-m1-ledger.md` —— ⬜ **尚未撰写**
>
> **分支**：本文件所在的 `claude/member-points-coupon` 基于**生产实际运行的 `ca37137`**，是纯文档分支，
> 不含任何代码改动，同城分支将来进 main 时零冲突。正文 P9 决策（代码等同城进 main 后从 main 切新分支）
> 依然有效——本分支只承载文档。

---

# 会员积分 + 积分商城 + 优惠券(含赔偿券)——方案定稿与实施计划

## Context

丹桂阿福凉菜(个体工商户)的微信小程序已上架并在生产运行,全国邮寄全链路闭环;同城配送在独立分支高强度开发中(96 提交,M1 渠道基础、M2 配送引擎、M2b 工作台已完成,云打印出票与 M3 顾客端进行中)。定稿的首页封面画稿上留了「会员中心 / 会员储值 / 积分商城」三个次入口,目前全部弹「即将开通」;代码里零实现:`User` 没有任何金额字段,`Order` 没有折扣列,后台用户页只读。

用户本轮要补齐的是同城配送与全国邮寄之外的第二类能力:**会员储值、积分商城,以及给顾客做赔偿的代金券/积分**。合规调研否掉了储值,用户据此把范围收敛为**积分 + 积分商城 + 优惠券**,赔偿一律用券。

**本次任务的交付物是文档,不是代码。** 同城分支正在改的 12 个文件与会员功能改动面高度重叠(`orders.ts` +256 行、`schema.prisma` +157 行、`refund.ts`、`e2e.sh` +1004 行、后台导航与退款弹窗)。现在动代码,合并时要逐行人工拼接下单金额逻辑,拼错不会报错而是算错钱。用户已确认:**先定稿方案与实施计划并提交,同城进 main 后再从 main 开新分支写代码。**

与同城分支的边界已核对:同城 M3 计划与各子任务 brief 都明确「不做会员/积分」,同城 spec 二期清单也无会员项,两边规则不冲突。

## 合规结论(调研全文 `docs/research/2026-09-03-member-wallet-points-coupon-compliance.md`,已在工作区待提交)

- **储值本轮不做**:个体工商户法律上无需预付卡备案,但微信小程序含「会员卡预充值」需补选「商家自营-预付卡」类目,资质为备案公示材料或支付业务许可证,个体户两样都拿不到。另有 2024 消保法实施条例与 2025 年最高法预付式消费司法解释的硬性要求(书面协议、7 日退本金、余额可退、赠送金按比例折算)。
- **积分与积分商城可做**:官方明确「消费得积分、积分兑换商品」属正常运营。红线:不做积分提现、不做抽奖盲盒、须公示获取规则与有效期。不需新增类目。
- **券自建**:下单前减价,微信支付只看到实付金额。微信支付「代金券」普通商户可开但定向赔偿不灵活,「商家券」2025-12-15 起停止新接入。自建最合适。
- **不新增小程序权限**:不取手机号(省 0.03 元/次且免改隐私指引),积分与券绑 openid。

## 已拍板的产品决策(改动需重新确认)

| # | 决策 | 结论 |
|---|---|---|
| P1 | 主体 | 个体工商户 |
| P2 | 储值 | 本轮不做;赔偿一律发券,不发赔偿积分 |
| P3 | 兑换物 | 优惠券 + 本店商品作**随单赠品**(结算页用积分加购,随付费订单履约);不做单独 0 元兑换单 |
| P4 | 积分来源 | 只做消费得积分(订单 COMPLETED 时按实付发放);不做签到/分享/店员手动送分 |
| P5 | 券形态 | 只做固定金额满减(满 X 减 Y,X=0 即代金券),可限渠道,领取后 N 天有效;不做折扣券/商品券 |
| P6 | 券来源 | 积分兑换、店员定向发放(赔偿)、领券中心、新客券 |
| P7 | 退款与券 | 已支付订单任何退款(全额/部分)券**不退回**,赠品消耗的积分同样不退;未支付取消则释放 |
| P8 | 架构 | 账本式(积分带流水,券分模板与用户券) |
| P9 | 分支 | 先定稿文档;同城合并 main 后从 main 切新分支写代码 |
| P10 | 封面入口 | 三颗按钮改为 会员中心 / **优惠券** / 积分商城(原「会员储值」改词),画稿与封面 brief 同步更新 |

## 数据模型

一次迁移落库,时间戳须晚于同城当前最新的 `20260905000000`。沿用全项目约定:金额与积分用 `Int`,状态用 `String` + 注释枚举,表名 `@@map` 蛇形。

```
User            + pointsBalance Int @default(0)            // 冗余 = 未过期 EARN 行 remaining 之和

PointsLedger    id, userId, type, delta(±), balanceAfter, remaining(仅 EARN),
                refType, refId, remark, expiresAt?(仅 EARN), createdAt
                type: EARN | REDEEM | GIFT | GIFT_REVERT | REFUND_DEDUCT | EXPIRE | ADMIN(预留)
                @@index([userId, createdAt]) @@index([userId, type, expiresAt])
                @@unique([type, refType, refId])           // 幂等防线

CouponTemplate  id, name, description, amount, threshold(0=代金券), channel(ALL|LOCAL|EXPRESS),
                validDays, source(ADMIN|POINTS|CAMPAIGN|NEWCOMER), pointsCost?,
                totalLimit?, perUserLimit?, issuedCount, status, sortOrder

UserCoupon      id, userId, templateId, code, status(UNUSED|USED|EXPIRED), source, sourceRef,
                issuedBy?, expiresAt, usedAt, orderId?, createdAt
                + name/amount/threshold/channel 快照(模板停用不影响已发券)
                @@index([userId, status, expiresAt]) @@index([orderId])

PointsGood      id, productId, skuId?, pointsCost, perOrderLimit(默认1), stockLimit?, status, sortOrder

Order           + couponId?, discountAmount Int @default(0), pointsUsed Int @default(0), pointsEarned Int @default(0)
OrderItem       + isGift Boolean @default(false), pointsCost Int @default(0)
```

`Setting` key `member`(复用 `services/settings.ts` 的 KV + 60s 缓存范式,无需迁移):
`{ points:{ enabled, earnRatePerYuan:1, validDays:365 }, newcomer:{ templateId:null }, rulesText }`

## 核心规则(写死,不留给实施临场决定)

**计费顺序**:商品小计 → 券(`discount = min(coupon.amount, subtotal)`,门槛比对小计) → 运费(满额包邮 / 起送 / 同城起送一律按**券前小计**判断,顾客不因用券失去包邮) → `actualAmount = subtotal − discount + shippingFee`。微信支付金额 = `actualAmount`。同城报价凭证机制不受影响。

**积分发放**:订单进入 COMPLETED 的每条路径(确认收货 / 自动收货 / 同城 520 / 店员标记送达)后调 `settlePoints(orderId)`,`points = ⌊(actualAmount − refundedAmount) ÷ 100 × earnRatePerYuan⌋`,写 EARN 行(`remaining = delta`,`expiresAt = completedAt + validDays`),回写 `Order.pointsEarned` 与 `User.pointsBalance`。`@@unique([type,refType,refId])` 保证一单一次。**`Order.isTest` 的测试单不发积分**(同城分支新增字段)。scheduler `settleMissedPoints` 每分钟兜扫 `COMPLETED && pointsEarned=0 && completedAt < now-2min` 补发,漏挂钩子也不丢分。

**积分消耗**:换券与赠品按 `expiresAt` 升序 FIFO 扣各 EARN 行 `remaining`;不足返回 42250。

**积分过期**:scheduler `expirePoints` 每日,`remaining>0 && expiresAt<now` 清零并写 EXPIRE 流水、回写余额。顾客端展示「N 分将于 X 日过期」。

**退款扣回**:唯一入口是 `services/refund.ts` 的 `finalizeRefundSuccess`。订单已 COMPLETED 且 `pointsEarned>0` 时扣 `⌊refund.amount ÷ 100 × rate⌋`,上限 = `pointsEarned − 已扣回`;先扣该单 EARN 行 remaining,再扣其他 EARN 行,**扣到 0 为止不出现负余额**。

**券与赠品在下单时**:一单一券;赠品同种 ≤ `perOrderLimit`;赠品行 `productPrice/subtotal = 0` 但**扣真实库存**,取消时沿用 `utils/order-stock.ts` 的 `rollbackOrderStock`。券的核销与赠品扣分都在下单事务内完成。

**未支付取消**(含 15 分钟超时 `cancelExpiredOrders`):券恢复 UNUSED(未过期时),赠品积分写 GIFT_REVERT 退回。已支付后一律不退(P7)。

**退款上限公式不变**:`actualAmount − refundedAmount`,因为实付已是扣券后的金额;赠品行退款额为 0。

**券的发放与幂等**

| 来源 | 触发 | 限制 |
|---|---|---|
| NEWCOMER | `wechat-login` 首次创建 User 后,若配了模板 | 同用户同模板同来源仅一张,老用户不补发 |
| POINTS | `POST /member/points/redeem` 事务内 FIFO 扣分 + 发券 + REDEEM 流水 | `perUserLimit` |
| CAMPAIGN | `POST /member/coupons/claim` | `updateMany(issuedCount < totalLimit)` 原子限量 + `perUserLimit` |
| ADMIN(赔偿) | `POST /admin/users/:id/coupons {templateId, remark, orderNo?}` | 无上限,必留 `issuedBy` + 备注,可查发放记录 |

券过期:scheduler `expireCoupons` 每日置 EXPIRED,读取时同样按 `expiresAt` 判定,不依赖任务准时。模板停用只影响再发放。赔偿券**不推订阅消息**(一次性模板需顾客事先授权),靠「我的」页角标。

**错误码**:42250 积分不足 · 42251 券不可用 · 42252 赠品超限/售罄 · 42253 领券已达上限 · 42254 券模板停用。

## 页面

**小程序**(新增 5 页 + 1 组件):`pages/member/index` 会员中心(余额、即将过期、券数、入口、规则说明公示)、`member/mall` 积分商城(换券 / 随单赠品两 Tab)、`member/coupons`、`member/claim` 领券中心、`member/points-log`;公用组件 `components/checkout-benefits`(选券行 + 赠品区 + 优惠行 + 预计得分),邮寄结算页接入、同城确认页复用;订单详情与列表显示优惠与赠品行;「我的」页头加积分/券条;封面三入口按 P10 接到 会员中心 / 优惠券 / 积分商城。预览台补镜像页。

**后台**(新增 3 页):`Coupons.tsx` 券模板、`PointsGoods.tsx` 赠品、`MemberSettings.tsx` 规则设置;`Users.tsx` 加积分/券列与「发券」「积分明细」「券记录」操作;`Orders.tsx` / `AfterSalePanel` / `RefundDialog` 显示优惠与赠品,订单详情与售后面板加「发赔偿券」(可只发券不退款);`Layout.tsx` 加「营销」与「会员设置」。

## 本次要产出的文档(唯一交付物)

1. `docs/research/2026-09-03-member-wallet-points-coupon-compliance.md` —— 合规调研,文件已在工作区,本次提交。
2. `docs/superpowers/specs/2026-09-04-member-points-coupon-design.md` —— 顶层设计定稿:Context / 决策表 / 数据模型 / 核心规则 / 页面 / 里程碑 / 验证 / 风险与二期,体例对齐同城 spec。
3. `docs/superpowers/plans/2026-09-04-member-m1-ledger.md` —— M1 实施计划(任务级,TDD/e2e 驱动,体例对齐同城 M1 计划)。
4. M2–M5 只在 spec 里给出里程碑边界与验收标准,详细计划待 M1 落地后再写(沿用同城分支做法)。
5. 封面「会员储值 → 优惠券」改词在 spec 里记为交接事项,画稿实际修改留给封面所在分支执行,本分支不碰 `docs/design/`。

**里程碑边界**

- **M1 账本与规则**:迁移;`services/member/points.ts`(发放/FIFO 扣/过期/退款扣回)与 `services/member/coupons.ts`(发放/校验/核销/过期);`member` 设置;挂钩 COMPLETED 各路径、`finalizeRefundSuccess`、登录发新客券;scheduler 三任务;e2e 覆盖发放幂等、FIFO、过期、退款扣回不为负。
- **M2 结算链路**:`GET /member/checkout-options`;`POST /orders` 券与赠品分支;未支付取消释放;退款上限回归;订单详情字段;票面与工作台显示优惠。
- **M3 后台**:三个管理页 + 用户页发券 + 售后面板赔偿券。
- **M4 小程序**:会员五页 + 结算组件 + 详情 + 封面入口 + 预览台镜像。
- **M5 联调与文档**:真机一分钱走券/赠品/退款扣分;`docs/staff-guide.md` 新章节、`docs/api.md`、`docs/requirement.md` 移除「积分/优惠券后续规划」、`release-checklist` 加积分规则公示检查。

## 验证(文档阶段)

- spec 自检:无 TBD/占位;数据模型与核心规则不自相矛盾;每个错误码在规则里都有触发点;计费顺序与同城报价凭证机制不冲突。
- 交叉核对同城分支现状:`Order.isTest`、强制报价凭证、道路距离运费三项新事实已反映进方案;迁移时间戳晚于 `20260905000000`;同城 M3 计划的「不做会员/积分」边界未被本方案破坏。
- 用户审阅 spec 后再写 M1 计划;M1 计划完成后按 `superpowers:writing-plans` 体例自检任务粒度与验收标准。

## 明确不做(二期)

储值与余额支付;赔偿积分;折扣券与商品券;券到期订阅消息提醒;微信支付代金券对接;积分抽奖/盲盒/签到;积分兑换实物单独发货;会员等级。

---

## 2026-09-04 落盘时的核验补充

落盘时把正文依赖的前提逐条对着**同城分支**（`claude/same-city-delivery-plan-2ffa20` @ `914936b`）核了一遍。

### 已核实成立，正文无需改动

| 正文里的前提 | 核验结果 |
|---|---|
| `Setting` 复用 `services/settings.ts` 的 KV + 60s 缓存范式 | ✔ 文件存在 |
| 未支付取消沿用 `utils/order-stock.ts` 的 `rollbackOrderStock` | ✔ 文件与函数都在 |
| 退款扣回的唯一入口是 `services/refund.ts` 的 `finalizeRefundSuccess` | ✔ 函数存在 |
| 错误码 42250–42254 可用 | ✔ 全项目 `4225x` 零占用 |
| 迁移时间戳须晚于 `20260905000000` | ✔ 该迁移（`_add_order_is_test`）确为同城分支最新一个 |
| 「`Order.isTest` 的测试单不发积分」 | ✔ 字段存在于同城分支 |
| 计费顺序与同城报价凭证机制不冲突 | ✔ 券只作用于商品小计，运费判定用券前小计，不触碰报价凭证 |

### ⚠️ 需要修正的一条：P9 的解锁条件比正文预期长得多

正文 P9 写「同城合并 main 后从 main 切新分支写代码」。2026-09-04 晚只读核验生产后发现：

**同城配送不仅没有合并，连部署都没有。**

- 生产 `https://api.yuegui-hotel.online` 的 `/api/local/meta`、`/api/local/quote` 均为 **404**（`/health`、`/api/products` 200）
- 生产机 `162.14.114.95:/www/food-shop` 的 HEAD 是 **`ca37137`**，该版本无 KD100 代码、无 `WECHAT_TMPL_DELIVER`、无 `apps/miniapp/pages/local/`
- `scripts/deploy.sh:74` 是 `git reset --hard origin/main`，同城分支 `914936b` 未合并未 push

所以**代码阶段的真实解锁条件**不是「合并进 main」四个字，而是整条上线路径走完：
合并 → 部署 → 后台同城设置与 LOCAL 商品 → 上传体验版 → M4 Task 6 真机真钱联调 → 提审发布。
路径与逐步命令见 `docs/superpowers/notes/2026-09-04-local-delivery-golive-runbook.md`
（在分支 `claude/m4-pre-check-delivery-ca8aea`）。

**对本计划的影响**：

- **文档阶段（② spec、③ M1 计划）不受任何影响，现在就能写** —— 它们不碰代码，也不依赖同城是否上线。
- **代码阶段要往后排**，排期时按上面那条完整路径估，不要按「同城合并」估。
- 「测试单不发积分」依赖的 `Order.isTest` 只在同城分支上、**生产没有**，所以这条规则天然要求同城先合并。与 P9 方向一致，但**建议在 spec 里显式写死这个依赖**，避免将来有人在 main 上先写会员代码时踩空。

### 落盘时未做的事

- 未写 ② spec 与 ③ M1 计划 —— 留给持有完整上下文的原会话执行。
- 未改 `docs/design/`（正文 P10 的封面「会员储值 → 优惠券」改词），按正文约定留给封面所在分支。
- 未动 `docs/requirement.md:142,148`（「积分系统 / 复杂优惠券 = 后续规划」），按正文属 M5 收尾项。
