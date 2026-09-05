# 会员 M4：小程序顾客端（会员五页 / 结算组件 / 订单显示 / 封面入口 / 预览台） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行本计划。步骤用 checkbox（`- [ ]`）语法追踪。
> **前置**：M1–M3 已全部落地并合入。服务端的每一个 `/member/*` 端点、`POST /orders` 的 `couponId/gifts`、订单响应的优惠字段（M2 Task 8 定的名字，e2e §34 锁住）都已存在。本计划**只写小程序与预览台**，不改任何服务端与后台代码。
> **本文档性质**：规划文档，由 Principal Engineer 角色撰写，本身不修改任何 `apps/` 代码。

设计依据：spec §6（小程序）、§5.9（接口清单）、§2（合规：须公示积分规则；不新增权限；不发订阅消息）、§9（预览台五页截图）；masterplan P10（封面三入口：会员中心 / 优惠券 / 积分商城）与 §11.4（封面接线交接）。

**Goal:** 顾客在小程序里能看到并使用整套会员权益：会员中心（余额、即将过期、券数、规则公示）、积分商城（换券 / 随单赠品预览）、我的券、领券中心、积分明细五个页面；邮寄与同城两个结算页各接入同一个 `checkout-benefits` 组件（选券、加购赠品、优惠行、预计得分），**金额只显示服务端返回值**；订单详情与列表显示优惠行、赠品「赠」标与「本单获得 N 积分」；「我的」页头有积分/券条；**封面三个热区从 toast 换成真页面**，收口 `apps/miniapp/pages/cover/index.js:79` 的 TODO——这是提审前的硬门槛（「点了只弹 toast」= 审核判「功能不完整」）。预览台补五个镜像页与两个结算页的优惠区。

**Non-goals（详见文末《明确不做》）：** 不改服务端；不新增 `requiredPrivateInfos`、不取手机号；不发任何订阅消息；不做券到期提醒；不做积分抽奖/签到；不改 `docs/design/` 画稿（封面「会员储值 → 优惠券」的改词属封面所在分支，本计划只接线）。

---

## Global Constraints

- **原生 ES5 写法**：`var` + `function`，不用箭头函数、`const/let`、模板字符串、解构（现有页面就是这么写的，`cover/index.js` 是范本）。组件用 `Component({ properties, data, methods })`，`components/order-status-tag/index.js` 是范本。
- 请求一律走 `utils/request.js`（401 自动重登重试一次）；新建 `api/member.js` 集中封装，页面不直接拼 URL。`silent: true` 用于「失败不该 toast 的静默请求」（如结算页拉优惠项失败时由组件自己显示降级态）。
- **金额只用服务端返回值**（spec §6）：`discount`、`payAmount` 展示来自 `checkout-options` 的 `coupons[].discount` 与 `POST /orders` 响应的 `actualAmount`；本地只做 `subtotal − discount + shippingFee` 这一步加法用于提交前展示，且 `discount` 必须取自服务端。「预计得 N 分」按 `points.earnRatePerYuan` 与展示合计估算，文案必须带「预计」。
- 未登录：五个会员页 `onLoad` 先 `getApp()._tryLogin()`（app.js 已有，静默登录），失败显示「请先登录」占位 + 按钮（复用「我的」页 `onLogin` 的 `wx.login → wechatLogin` 流程）。**不能出现白屏或无提示的空页**。
- 错误码 → 文案：42250「积分不足」、42251 服务端 message 原样、42252 服务端 message 原样、42253「该券已领完或已达上限」、42254「该活动已结束」。结算页遇 4225x 先刷新组件的优惠项再 toast，**不清 `quoteToken`**（同城）。
- 新页面注册进 `app.json` 的 `pages`；不动 `tabBar`、`requiredPrivateInfos`、`permission`。
- 预览台每加一个页面同步 4 处：`tools/miniapp-preview/pages/<key>.html` 镜像、`serve.mjs` 的 `PAGE_WXSS`、`PAGE_COMPONENTS`（若用组件）、`index.html` 的 gallery 数组。
- 样式 token 与类名沿用 `app.wxss` 与 `docs/design-system.md`；价格用 `utils/price.wxs` 的 `pricefmt`。
- 提交信息中文、`type(scope): 摘要`；每个页面的 js 在提交前 `node --check`（封面 brief 的验收方式）。

---

## 前置条件表

| # | 条件 | 现状（2026-09-05 写稿时） | 未满足时怎么办 |
|---|---|---|---|
| P1 | 批次一（同城）已走完上线路径；M1、M2、M3 已合入 | ⬜ 见 M2 计划前置表 | 等 |
| P2 | e2e §34 已含 M2 Task 8 加的四条字段断言（`discountAmount/pointsUsed/pointsEarned/items[].isGift`） | ⬜ 随 M2 | 缺了先补——小程序按这些名字取值，名字漂了页面就静默显示空 |
| P3 | `GET /member/checkout-options`、`/member/summary`、`/member/points/ledger`、`/member/coupons`、`/member/mall`、`/member/campaign`、`POST /member/points/redeem`、`POST /member/coupons/claim` 八个端点全部可用（M1 Task 7 + M2 Task 3 Step 4） | ⬜ 随 M1/M2 | `curl` 逐个打一遍再开工；缺的回 M2 计划 P4 处理 |
| P4 | 封面页三个热区已存在并绑定 `goMember` + `data-key`（member / coupon / points） | ✅ `pages/cover/index.wxml` 三个 `.hot-*`；`index.js:79` 的 TODO 写明目标路径 | — |
| P5 | 微信开发者工具可用（真机预览 / 体验版上传由 M5 做） | ❓ 视执行者环境 | 至少要能在开发者工具里跑；预览台只做视觉近似 |
| P6 | `.claude/launch.json` 的 `miniapp-preview`（5180）与 `api-3100` 可起 | ✅ | — |
| P7 | 会员规则说明的固定条款文案（获取、有效期、不可提现、退款不退券）与用户协议新增章节文案 | ⬜ **需 PO 提供或确认**（见 D1） | 先用本计划给的草稿占位，PO 确认后替换；提审前必须是终稿 |

---

## 文件结构（本计划涉及）

| 路径 | 职责 |
|---|---|
| `apps/miniapp/api/member.js` | **Create**。八个端点的封装 |
| `apps/miniapp/app.json` | **Modify**。`pages` 加五项 |
| `apps/miniapp/pages/member/index.{js,json,wxml,wxss}` | **Create**。会员中心 |
| `apps/miniapp/pages/member/mall.{…}` | **Create**。积分商城（换券 / 随单赠品两 Tab） |
| `apps/miniapp/pages/member/coupons.{…}` | **Create**。我的券 |
| `apps/miniapp/pages/member/claim.{…}` | **Create**。领券中心 |
| `apps/miniapp/pages/member/points-log.{…}` | **Create**。积分明细 |
| `apps/miniapp/components/checkout-benefits/index.{js,json,wxml,wxss}` | **Create**。结算页优惠组件 |
| `apps/miniapp/pages/order/confirm.{js,json,wxml}` | **Modify**。接组件、提交带 `couponId/gifts`、合计 |
| `apps/miniapp/pages/local/confirm.{js,json,wxml}` | **Modify**。同上，且不碰 `quoteToken` 流程 |
| `apps/miniapp/pages/order/detail.{js,wxml,wxss}`、`pages/order/list.{js,wxml}` | **Modify**。优惠行 / 赠品标 / 得分 |
| `apps/miniapp/pages/user/index.{js,wxml,wxss}` | **Modify**。页头积分/券条 + 「我的券」菜单 |
| `apps/miniapp/pages/cover/index.js` | **Modify**。`goMember` 接真页面，删 TODO |
| `apps/miniapp/config/legal.js` | **Modify**。用户协议补「积分与优惠券」一节 |
| `tools/miniapp-preview/pages/{member-index,member-mall,member-coupons,member-claim,member-points-log}.html` | **Create**。镜像 |
| `tools/miniapp-preview/pages/{order-confirm,local-confirm}.html` | **Modify**。补优惠区 |
| `tools/miniapp-preview/serve.mjs`、`tools/miniapp-preview/index.html`、`tools/miniapp-preview/README.md` | **Modify**。登记 + 画廊 + 页数 |
| `scripts/e2e.sh` | **Modify**（可选）。§34 若 M2 漏锁字段在此补 |

---

### Task 1: API 层与页面注册

**Files:**
- Create: `apps/miniapp/api/member.js`
- Modify: `apps/miniapp/app.json`

**Interfaces（`api/member.js` 导出）：**
`getSummary()`、`getPointsLedger(page, pageSize)`、`getCoupons(status)`、`getMall()`、`redeemCoupon(templateId)`、`getCampaign()`、`claimCoupon(templateId)`、`getCheckoutOptions(channel, subtotal, silent)`。全部照 `api/order.js` 的写法（`request({ url, method, data, silent })`），查询串手拼。

- [ ] **Step 1: 写 `api/member.js`**（8 个函数 + `module.exports`）
- [ ] **Step 2: `app.json` 的 `pages` 追加**
  `pages/member/index`、`pages/member/mall`、`pages/member/coupons`、`pages/member/claim`、`pages/member/points-log`（放在 `pages/local/confirm` 之后；`pages[0]` 仍是封面）。
- [ ] **Step 3: 五个页面先建空壳**（`.json` 只含 `navigationBarTitleText`，`.wxml` 一个 `<view class="page">`），开发者工具能编译通过、能从封面跳到（Task 8 接线后）——先把「路径存在」这件事做实，再填内容。
- [ ] **Step 4: `node --check` 五个 js + `api/member.js`**。

**Acceptance:** 开发者工具编译零报错；`wx.navigateTo` 五个路径都能打开空壳页。

---

### Task 2: `pages/member/index` 会员中心

**Files:**
- Create: `apps/miniapp/pages/member/index.{js,json,wxml,wxss}`

**页面结构**（自上而下）：① 页头卡：积分余额（大字）、`expiringSoon` 存在时一行「N 分将于 M月D日 过期」、可用券数；② 四宫格入口：我的券 / 积分商城 / 领券中心 / 积分明细；③ 「规则说明」卡：固定条款（P7 草稿，见 D1）+ `rulesText`（来自 `GET /member/summary`——若 M1 的 summary 不带 `rulesText`，改从 `getMall()` 或单独加字段，**执行时先看 M1 实际返回**，不要假设）。

- [ ] **Step 1: 登录门**
  `onLoad`/`onShow` → `app._tryLogin().then(load).catch(showLoginPlaceholder)`；未登录态显示占位 + 「点击登录」（复用 `user/index.js` 的 `onLogin` 逻辑，抽到本页一个方法里，不做跨页共享模块——YAGNI）。
- [ ] **Step 2: 拉 `getSummary()`**，失败显示「加载失败，点此重试」（不是空态）。
- [ ] **Step 3: 四宫格 `navigateTo`**。
- [ ] **Step 4: 规则说明**
  固定条款草稿（占位，PO 确认后替换）：
  「1. 订单完成后按实付金额每 1 元得 {rate} 积分（不足 1 元部分不计）。2. 积分自获得之日起 {validDays} 天内有效，到期自动清零。3. 积分可在积分商城兑换优惠券，或在结算时兑换随单赠品；不可提现、不可转赠。4. 已支付订单发生退款时，按退款金额比例扣回已发积分；订单使用的优惠券与赠品消耗的积分不退回。5. 未支付订单取消，优惠券与积分自动退回。」
  `rate`/`validDays` 从 summary 或 checkout-options 的 `points` 字段取（哪个端点带，执行时定）。
- [ ] **Step 5: 空态**：新用户 0 分 0 券也要显示得像个页面（数字 0 + 「去下单赚积分」按钮 → `switchTab` 主页）。

**Acceptance:** 登录/未登录/加载失败/空态四种状态都有画面；规则说明全文可读（这是合规公示项，spec §2）。

---

### Task 3: `pages/member/mall` 积分商城

**Files:**
- Create: `apps/miniapp/pages/member/mall.{…}`

**页面结构**：顶部余额条；两个 Tab——「换优惠券」（`getMall().templates`：名称、面额/门槛、渠道标、有效天数、积分价、「兑换」按钮；余额不足按钮灰）、「随单赠品」（`getMall().gifts`：图、名、规格、积分价、每单限购、渠道标；**只展示不能在此兑换**，卡片下一行说明「结算时用积分加购，随订单一起送达」+ 按钮「去下单」→ 按渠道 `switchTab` 主页或 `navigateTo` 同城页）。

- [ ] **Step 1: 两 Tab 与数据**（失败态、空态各自有）。
- [ ] **Step 2: 兑换流程**
  `wx.showModal` 确认「用 N 积分兑换「券名」？」→ `redeemCoupon(templateId)` → 成功 toast「兑换成功」+ 刷新余额与列表；42250/42253/42254 各自文案。兑换按钮加 `_redeeming` 在途守卫防双击（沿用 `order/detail.js` 的 `_cancelling` 范式）。
- [ ] **Step 3: 赠品 Tab 的「去下单」**：渠道 EXPRESS → `wx.switchTab('/pages/index/index')`；LOCAL → 走 `app.ensurePrivacyAuthorize()` 再 `navigateTo('/pages/local/index')`（与封面 `goLocal` 同一套契约）。
- [ ] **Step 4: 375px 与长列表滚动**。

**Acceptance:** 换券成功后余额与「我的券」同步；三种错误码文案正确；赠品 Tab 无兑换按钮。

---

### Task 4: `pages/member/coupons` 我的券 + `pages/member/claim` 领券中心

**Files:**
- Create: `apps/miniapp/pages/member/coupons.{…}`、`apps/miniapp/pages/member/claim.{…}`

- [ ] **Step 1: 我的券**
  Tab：可用 / 已用 / 已过期（`getCoupons('available'|'used'|'expired')`）。券卡：面额大字、名称、门槛（0 显示「无门槛」）、渠道标（ALL 不显示；LOCAL「同城专享」；EXPRESS「邮寄专享」）、有效期至、券码（小字，客服核对用）；已用卡显示「已用于订单 …」（若 `orderId` 有则可点跳详情）；已过期灰。顶部一个「去领券」入口 → claim 页。空态：「暂无可用券」+ 「去领券」「去积分商城」。
- [ ] **Step 2: 领券中心**
  `getCampaign()`：每个活动券显示面额/门槛/渠道/有效天数、剩余（`remaining` 可空=不限）、「本人已领 N/M」；按钮「领取」→ `claimCoupon` → 42253 文案「已领完或已达上限」；成功后刷新并 toast。空态「暂无活动」。
- [ ] **Step 3: 两页各自的登录门、失败态、在途守卫**。

**Acceptance:** 三个 Tab 数据与 `GET /member/coupons` 一致；领券后「我的券」可用 Tab 立即能看到。

---

### Task 5: `pages/member/points-log` 积分明细

**Files:**
- Create: `apps/miniapp/pages/member/points-log.{…}`

- [ ] **Step 1: 分页列表**（`onReachBottom` 加载下一页，沿用 `order/list.js` 的分页写法）：每行 类型文案 / 时间 / 变动（正绿负红）/ 备注；`refType='ORDER'` 且有订单号时可点跳订单详情；EARN 行显示「有效期至」。
- [ ] **Step 2: 顶部固定一行**：当前余额 + `expiringSoon` 提示（复用 summary）。
- [ ] **Step 3: 空态、失败态、登录门**。

**Acceptance:** 流水与后台「积分明细」抽屉一致（同一用户对照）。

---

### Task 6: `components/checkout-benefits` 结算优惠组件

**Files:**
- Create: `apps/miniapp/components/checkout-benefits/index.{js,json,wxml,wxss}`

**Interfaces:**
- `properties`：`channel`（'EXPRESS'|'LOCAL'）、`subtotal`（分）、`disabled`（父页在提交中/报价中时置 true）。
- `data`：`options`（checkout-options 响应）、`selectedCouponId`、`gifts`（`{ [pointsGoodId]: quantity }`）、`discount`、`pointsUsed`、`state`（'loading'|'ready'|'failed'|'empty'）、`pickerOpen`。
- 触发 `change` 事件：`{ couponId: number|null, gifts: [{pointsGoodId, quantity}], discount: number, pointsUsed: number }`——父页只拿这四个值，**不看组件内部**。
- 方法 `refresh()`（父页在 4225x 错误后调用）。

**布局**：一张卡三段——① 「优惠券」行：右侧显示「−¥X（券名）」或「N 张可用 ›」或「暂无可用」，点开底部弹层列出全部券（可用在前、不可用灰并显示 `message`）；② 「积分赠品」区：赠品卡横向列表，每卡「积分 N」+ 加减步进（上限 `perOrderLimit`，且累计 `pointsUsed <= pointsBalance`，超出时加号灰并 toast「积分不足」）；`gifts` 为空时整段不渲染；③ 「优惠合计」行 + 「预计获得 N 积分」小字（`points.enabled` 才显示）。

- [ ] **Step 1: 拉取与降级**
  `subtotal` 或 `channel` 变化（observer）→ 防抖 300ms → `getCheckoutOptions(channel, subtotal, true)`；失败 → `state='failed'`，显示「优惠信息暂不可用，可直接下单」+ 重试，并**清空选择、触发一次 `change` 全 0**（不能让父页带着过期的 `couponId` 提交）。`coupons` 与 `gifts` 都空 → `state='empty'`，整张卡收成一行「暂无可用优惠」（不能占大块空白）。
- [ ] **Step 2: 选券**
  默认选择规则见 **D2**（默认：自动选 `usable` 且 `discount` 最大的一张；顾客可改为「不使用」）。弹层里选中即关闭并 `change`。`subtotal` 变了（购物车页回来）重新拉取后，若原选券不再 `usable`，自动取消并 toast「已取消不可用的优惠券」。
- [ ] **Step 3: 赠品步进**
  每次变化重算 `pointsUsed` 并 `change`。
- [ ] **Step 4: `disabled` 时整卡不可点**（提交中/报价中）。
- [ ] **Step 5: 组件单独在预览台镜像里摆三种状态**（有券有赠品 / 空 / 失败）。

**Acceptance:** 组件在两个父页表现一致；失败态不阻塞下单且不会提交过期选择；`change` 事件的四个字段永远与画面一致。

---

### Task 7: 接入邮寄结算页 `pages/order/confirm`

**Files:**
- Modify: `apps/miniapp/pages/order/confirm.{js,json,wxml}`

- [ ] **Step 1: `confirm.json` 注册组件**，`wxml` 在「备注」与「金额区」之间插 `<checkout-benefits channel="EXPRESS" subtotal="{{totalAmount}}" disabled="{{submitting}}" bind:change="onBenefitsChange" />`。
- [ ] **Step 2: `data` 加 `couponId: null, gifts: [], discount: 0, pointsUsed: 0`**；`onBenefitsChange` 写入并调 `applyShipping()`。
- [ ] **Step 3: `applyShipping()` 改合计**
  运费判定（包邮线 / 起送线）**继续用 `subtotal = totalAmount`（券前）**——与服务端一致，顾客不因用券失去包邮；`payAmount = subtotal − discount + shippingFee`。金额区加两行：「优惠券 −¥X」（`discount > 0`）、「积分赠品 N 分」（`pointsUsed > 0`），底部合计与提交按钮用 `payAmount`。
- [ ] **Step 4: 提交带字段**
  `createOrder({ …, couponId: couponId || undefined, gifts: gifts.length ? gifts : undefined })`；成功后用响应的 `actualAmount` 发起支付（现有流程已是如此）。**若响应 `actualAmount` 与本地 `payAmount` 不等**，以服务端为准并 `console.warn`——这是发现口径漂移的探针。
- [ ] **Step 5: 4225x 处理**
  `createOrder` 的 `.catch`：`code ∈ {42250,42251,42252}` → toast 服务端 message → `this.selectComponent('#benefits').refresh()`；其他错误走原逻辑。
- [ ] **Step 6: 开发者工具走一遍**：无券无赠品的提交请求体与改前一致（多出的键为 `undefined` 不会被序列化）。

**Acceptance:** 用券单支付金额 = 服务端 `actualAmount`；包邮线用例在开发者工具里目测（小计刚够包邮 + 用券 → 仍免运费）；`metaFailed` 与 `belowMinOrder` 两条既有拦截行为不变。

---

### Task 8: 接入同城结算页 `pages/local/confirm`（谨慎区）

**Files:**
- Modify: `apps/miniapp/pages/local/confirm.{js,json,wxml}`

**先读**：`local/confirm.js` 的 `refreshQuote` / `onSubmit` / `onRetryQuote` 与 `quoteToken`、`quoteError`、`blockReason`、`payAmount` 四个字段的联动（同城 M4 计划 Task 1 的 m1/m3/m4/m5 修法都在这个文件）。**规则**：`quoteError` 或 `blockReason` 生效时 `payAmount` 不写新值、底部合计降级——这条不变；优惠只在 `quoteToken` 有效时叠加。

- [ ] **Step 1: 注册组件**，`wxml` 插在配送信息块之后、金额区之前：`channel="LOCAL" subtotal="{{subtotal}}" disabled="{{submitting || quoting}}"`。
- [ ] **Step 2: `payAmount` 的唯一写入点改为** `subtotal − discount + (quote.fee || 0)`（只在 `refreshQuote` 成功分支与 `onBenefitsChange` 两处，且后者仅当 `quoteToken` 存在且无 `blockReason`）；其余 `payAmount = null` 的降级分支**一行不改**。
- [ ] **Step 3: `/local/quote` 的 `subtotal` 参数继续传券前小计**（服务端 `q.fee > quoted.fee` 那条防线依赖两边口径一致；M2 Task 5 已核）。
- [ ] **Step 4: 提交带 `couponId/gifts`**；4225x → toast + `refresh()`，**不清 `quoteToken`、不改 `blockReason`**；42227/42239 走既有处理。
- [ ] **Step 5: 底部按钮文案** `提交订单 ¥{{payAmount}}` 自动反映优惠。
- [ ] **Step 6: 开发者工具回归**：报价失败 → 优惠组件 `disabled`；限流重试（m1）→ 优惠不丢；`blockReason`（超范围 / 非营业）→ 合计仍隐藏。

**Acceptance:** 同城用券单 `payAmount = subtotal − discount + fee`；`quoteToken` 相关的六个分支行为与改前一致（逐条目测并在 PR 描述里打勾）。

---

### Task 9: 订单详情与列表显示优惠、赠品、得分

**Files:**
- Modify: `apps/miniapp/pages/order/detail.{js,wxml,wxss}`、`apps/miniapp/pages/order/list.{js,wxml}`

- [ ] **Step 1: 详情金额区**（`detail.wxml:105-125` 一带）
  「商品金额」之后插「优惠券 −¥X」（`discountAmount > 0`，`detail.js` 的 `buildOrderView` 加 `discountAmountText` 与 `couponName`）、「积分赠品 N 分」（`pointsUsed > 0`）；「已退款」行之后，若 `refundedAmount > 0 && (discountAmount > 0 || pointsUsed > 0)` 加一行灰字「退款不退回优惠券与积分」（spec §10「顾客投诉」对策）。
- [ ] **Step 2: 详情商品行**
  `isGift` 行：名称前「赠」标（新增 `.item-gift-tag` 样式，配色按 `design-system.md` 的辅助色），价格文案 `积分 {{pointsCost}} × {{quantity}}` 代替 `¥0.00 × N`，小计列显示「—」。
- [ ] **Step 3: 「本单获得 N 积分」**
  `status === 'COMPLETED' && pointsEarned > 0` 时在时间线/状态卡下方一行；`pointsEarned === 0` 不显示（小额单不必解释）。
- [ ] **Step 4: 列表卡**
  `list.js` 的 `firstItem` 优先取**非赠品行**（避免卡片封面是赠品）；底部合计不变（实付）；`discountAmount > 0` 时合计左侧一个小标「已用券」。
- [ ] **Step 5: 与 e2e §34 的字段名逐一对照**。

**Acceptance:** 用券 + 赠品 + 完成 + 部分退款的一单，详情页能看到优惠行、赠标、得分、退款不退券提示四样。

---

### Task 10: 「我的」页头积分/券条 + 封面三入口接线（收口 TODO）

**Files:**
- Modify: `apps/miniapp/pages/user/index.{js,wxml,wxss}`
- Modify: `apps/miniapp/pages/cover/index.js`

- [ ] **Step 1: 「我的」页头**
  `user/index.wxml` 页头（`.user-header`）下方插一条两格条：「积分 N ›」→ 会员中心、「优惠券 M ›」→ 我的券；已登录时 `onShow` 拉 `getSummary()`（silent，失败显示「— ›」不 toast）；未登录显示「登录后查看积分与优惠券」整条可点登录。菜单区在「同城配送」之后加「我的券」。
- [ ] **Step 2: 封面接线**
  `cover/index.js` 的 `goMember` 改为按 `e.currentTarget.dataset.key` 分发：`member → /pages/member/index`、`coupon → /pages/member/coupons`、`points → /pages/member/mall`（与 `:79` TODO 及 spec §11.4 完全一致）；**删除 TODO 注释与 toast**。三个页面自己处理登录门（Task 2/3/4），封面不做登录判断（封面 `pages[0]` 冷启动时 `app._tryLogin` 可能还没回来，页面内再判更稳）。
- [ ] **Step 3: `grep -rn "即将开通" apps/miniapp/pages/cover`** 必须为空（`pages/index/index.js:75` 的同城「即将开通」是另一回事，不动）。
- [ ] **Step 4: 开发者工具点三个热区各进各页**；`debug: true` 临时开一次核对热区没被改动。

**Acceptance:** 封面三个热区都进真页面；`cover/index.js` 无 TODO、无 toast；「我的」页头条在登录/未登录/失败三态正常。

---

### Task 11: 预览台镜像

**Files:**
- Create: `tools/miniapp-preview/pages/member-index.html`、`member-mall.html`、`member-coupons.html`、`member-claim.html`、`member-points-log.html`
- Modify: `tools/miniapp-preview/pages/order-confirm.html`、`local-confirm.html`（补优惠区三态之一：有券有赠品）
- Modify: `tools/miniapp-preview/serve.mjs`（`PAGE_WXSS` 五项 + `PAGE_COMPONENTS`：`'order-confirm': ['checkout-benefits']`、`'local-confirm': ['checkout-benefits', …原有]`）
- Modify: `tools/miniapp-preview/index.html`（gallery 数组五项）
- Modify: `tools/miniapp-preview/README.md`（「13 个页面」改成实际数字——写稿时镜像已有 17 个，README 早就不准，顺手改对）

- [ ] **Step 1: 五个镜像页**，保持真实 class 名，mock 数据 baked（README 的边界）。
- [ ] **Step 2: 两个结算页镜像补优惠区**。
- [ ] **Step 3: `serve.mjs` 三处登记 + gallery**；`npm run preview:miniapp` 画廊能看到 22 个页面。
- [ ] **Step 4: 截图五页 + 两结算页**，放进 PR 描述（spec §9「预览台五页截图 + 结算页优惠区」）。

**Acceptance:** 画廊 22 页；改任一新页 wxss 预览即时刷新（`fs.watch` 生效）。

---

### Task 12: 用户协议补节 + 开发者工具走查清单

**Files:**
- Modify: `apps/miniapp/config/legal.js`
- Modify（可选）: `scripts/e2e.sh` §34

- [ ] **Step 1: `legal.js` 的用户协议 `sections` 在「五、取消与退款」之后插「五点五、积分与优惠券」**（草稿，PO 确认后替换，见 D1）：积分获取与有效期、不可提现转赠、优惠券使用规则、**退款不退券不退积分**、未支付取消自动退回、店家保留解释权的合规表述。`updatedAt` 同步改。隐私政策**不动**（不新增个人信息收集，spec §2）。
- [ ] **Step 2: 开发者工具走查清单**（写进 PR 描述逐项打勾，每项截图）
  封面三热区 → 三页；五页的登录/未登录/失败/空四态；换券成功 + 三种错误码；领券成功 + 42253；邮寄结算：选券/取消券/加赠品/减赠品/包邮线用例/4225x 刷新；同城结算：同上 + 报价失败/限流重试/超范围三种降级；订单详情四样；「我的」页头三态；`legal` 页新章节可读。
- [ ] **Step 3: §34 若 M2 漏锁字段，在此补**（否则跳过）。
- [ ] **Step 4: 全部新旧 js `node --check`**；`bash scripts/e2e.sh` 全绿（本计划不改服务端，跑它是为了确认 P2/P3 仍成立）。

**Acceptance:** 走查清单全勾；`legal` 新章节文案已标「待 PO 确认」或已确认。

---

## 完成标准（M4 整体）

1. `apps/miniapp/pages/cover/index.js` **无 TODO、无「即将开通」toast**，三个热区进真页面（提审硬门槛）。
2. 五个会员页 + 组件 + 两个结算页 + 订单两页 + 「我的」页的开发者工具走查清单（Task 12 Step 2）全勾并有截图。
3. `bash scripts/e2e.sh` 全绿（含 §34 契约锁的会员字段）；本计划不新增服务端用例，但**若执行中发现字段名对不上，先改 e2e §34 锁名字再改小程序**，不要在小程序里做兼容映射。
4. 预览台画廊 22 页，五个新页 + 两个结算页优惠区截图。
5. `app.json` 无新增 `requiredPrivateInfos`/`permission`；`grep -rn "getPhoneNumber\|requestSubscribeMessage" apps/miniapp/pages/member apps/miniapp/components/checkout-benefits` 为空（spec §2：不新增权限、不发会员类订阅消息）。
6. 会员中心规则说明与用户协议新章节的文案状态明确（终稿 / 待 PO 确认），列在 PR 描述里。
7. 所有新 js `node --check` 通过；无 ES6 语法（`grep -n "=>\|const \|let \|\`" apps/miniapp/pages/member apps/miniapp/components/checkout-benefits apps/miniapp/api/member.js` 为空）。

---

## 明确不做（本计划范围外）

1. 不改服务端与后台（M2/M3 已完；发现缺口回对应计划补，不在小程序里绕）。
2. 不新增小程序权限、不取手机号、不发订阅消息、不做券到期/积分到账提醒（spec §2、§12）。
3. 不做多券叠加 UI、折扣券 UI。
4. 不做积分兑换实物的独立下单流程（P3：赠品只随付费订单）。
5. 不改 `docs/design/` 画稿与封面图（「会员储值 → 优惠券」改词由封面所在分支执行；本分支封面图若仍写「会员储值」，列入 M5 提审前检查项）。
6. 不做「同城立即购买」；不动 `pages/local/index`。
7. 不做真机真钱联调与体验版上传（M5）。
8. 不做预览台的交互模拟（README 边界：视觉近似）。

---

## 需 PO 决定（本计划已给默认，PO 不反对即按默认执行）

| # | 问题 | spec 现状 | 本计划默认 | 为什么要问 |
|---|---|---|---|---|
| D1 | 会员中心「规则说明」固定条款与用户协议「积分与优惠券」章节的**正式文案** | spec §2 要求公示，§6 要求协议补节，未给文案 | Task 2 Step 4 与 Task 12 Step 1 的草稿 | 这是对外公示的规则条款，措辞由店主确认；提审前必须终稿 |
| D2 | 结算页是否**自动选中**最优可用券 | 未提 | **自动选 `discount` 最大的可用券**，顾客可改为「不使用」 | 自动选会让「想留着券下次用」的顾客多一步；不自动选会让不注意的顾客白白不用券。两种都常见 |
| D3 | 「我的」页头积分/券条的位置：页头卡内（头像下方）还是页头卡与「我的订单」之间独立一条 | spec §6 写「页头下方加积分/券条（wxml:18-21 位置）」 | 页头卡内，头像信息下方一条 | 纯视觉，但会影响封面之外顾客最常看到的入口的观感 |
| D4 | 封面第二个热区「优惠券」进「我的券」（`member/coupons`）还是「领券中心」（`member/claim`） | spec §11.4 与 `cover/index.js:79` 都写 `member/coupons` | **按 spec：我的券**，页内有「去领券」入口 | 对新顾客而言「优惠券」按钮进一个空的「我的券」体验一般；若 PO 想改为领券中心，只改一行，但要与画稿文案一致 |
| D5 | 订单详情「本单获得 N 积分」在 `pointsEarned === 0` 时是否显示「本单未满 1 元不计积分」 | 未提 | 不显示 | 显示能减少「为什么没积分」的咨询，但小额单本来就少 |
| D6 | 赠品 Tab 的「去下单」对 LOCAL 赠品是否直接进同城页（需位置许可） | 未提 | 进同城页，前置隐私许可（与封面 `goLocal` 同契约） | 顾客可能只是想看看赠品，被要位置许可会反感 |
