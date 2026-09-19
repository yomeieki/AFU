# 小程序：满减显示 + 结算条压薄/泛化到邮寄 + 分类页底部遮挡 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## 0. 给执行方的说明（先读）

- 本文件是「模型分工协议」的 **00 规划 · fable** 产物，等级 **L**（跨主页 / 分类页 / 三个结算页 / 订单详情 / 两个组件；改**顾客看到的应付金额**口径；一处新组件 + 一处组件泛化）。
- 工序链：**00 规划 · fable（本文件）→ 01 执行 · sonnet → 02 独立复核 · opus（新会话，只给「§1 需求 + 最终 diff + §6 验收标准」，不给执行过程、不给本文件的推理段）→ 03 回判 · fable（逐条判 成立 / 误判 / 需澄清）→ 修补轮（sonnet 修完**必须再过一次 opus**）→ 04 机械核对 · haiku（只跑 §6 里的命令、比对 §5 改动清单与 diff 的文件集合，不调模型判断）**。
- 各工序只做本职：规划不写码、执行不改方案（偏离要逐条写进回报）、复核不提交修复。**每次交接第一行声明「当前工序 0X · 模型」。**
- **验收标准只在本文件 §6 定义，后续工序不得新增或放宽。**
- 合并到 main 与上传体验版**由店主决定**，执行方不合并、不部署、不上传。
- 本文件自包含：需求、已查实的代码事实（带 文件:行）、分步改动、验收、白名单、上报条件、环境配方全部在此，不引用任何对话。
- 仓库与分支：worktree `/Users/yumingyi/food-shop/.claude/worktrees/miniapp-promo`，分支 `claude/miniapp-promo`，基线 main `7f3374d`（当前 HEAD `58201f1` 只多一份预览 HTML）。**只在这个目录工作，不 cd 到主检出，不裸 `git stash`。**
- 本 worktree **没有 `node_modules`**（2026-09-19 实测）。`npm run -s test:miniapp` 只用 `node:test`，不装依赖也能跑；但 ES5 闸门 `scripts/check-miniapp-es5.mjs` 需要 `acorn`——先在 worktree 根 `npm install`（主仓已有 `node_modules/acorn`，说明它是可装的传递依赖），**不要**改 `package.json` 去加依赖。

---

## 1. 需求（店主原话要点 + 已拍板）

店主在真机体验版上发现三个问题：

1. 「最下面的这个酒水饮料的最下面的一栏只能看到一半，点不了」——分类页右侧商品列表最后一件被底部黑色结算条压住，滚不上来。
2. 「这个结算的黑条太粗大，可以适当缩小，（为什么同城就有全国反而就没有了）」。
3. 「我已经设置好了减免和优惠券，这些推广该如何显示，现在并没有变化」。

店主看完预览（`docs/superpowers/previews/2026-09-19-miniapp-promo-cartbar.html`，375 宽，示例数据编造，CSS 仅供模仿）后的决定：

- 三件**合成一批**做；按预览执行。
- **全国邮寄也加上同样的底部结算条**（两边统一；原「购物车」tabBar 页保留，从那边结算也行）。
- 线上满减开关**由店主先关掉，等这批小程序过审再开**（本批测试要在本地库里自己开满减）。
- **活动条主页也放**（设计原文只放分类页）；**小程序订单详情页也加「满减」行**。
- 沿用 `docs/superpowers/specs/2026-09-17-store-promotion-design.md` 的决定：**商品卡不逐道菜打满减标签**（P9）；门槛一律按**减前商品小计**判（P7）；运费与打包费不参与满减（P10）；与优惠券可叠加、先满减再用券（P5）；与自取折扣可同时享受（P6）。
- **本批只动小程序**；服务端与后台早已就绪（契约见 `docs/api.md` 附录 K）。

---

## 2. 已查实的代码事实（2026-09-19 在本 worktree 逐一核过；与统筹方口述不符处见 §2.9）

### 2.1 问题 1 根因（底部遮挡）

- `apps/miniapp/pages/product/list.wxss:269-273`：
  ```css
  .page-local .prod-panel { padding-bottom: calc(132rpx + env(safe-area-inset-bottom)); }
  ```
  而 `.prod-panel` 就是右侧那个 `<scroll-view>` 本身（`list.wxml:109-120`）。真机微信（尤其 iOS WKWebView）**不把 scroll-view 自身的 padding-bottom 算进可滚动范围**——空白落在容器盒子上、不在滚动内容里；开发者工具与 H5 预览台会算，所以之前没发现。
- `list.js:225-249 measureOffsets`：最后一段补白 `tailHeight = max(0, 可视高 − 最后段高)`，最后一段够长时为 0，不会替结算条让位；且注释（`list.js:242-243`）明确依赖那条 padding，一起改。
- 搜索结果模式（`list.wxml:142-149`，仅邮寄）走同一个 scroll-view，本批给邮寄加结算条后同样要占位。
- 主页 `apps/miniapp/pages/index/index.wxss:303-307` 用 `.page-local { padding-bottom: calc(132rpx + …) }`——主页是**页面级滚动**（不是 scroll-view），padding 会计入滚动范围，**没有同类遮挡**；但 132rpx 是按旧条高度写死的，本批结算条变薄、上方还会多一条进度提示，改成动态占位（§5 T2）。

### 2.2 结算条组件（`apps/miniapp/components/local-cart-bar/`）

- `index.wxss:86-99`：`.local-cart-bar { position: fixed; bottom: 0; padding: 14rpx 24rpx; padding-bottom: calc(14rpx + env(safe-area-inset-bottom)); background: #2b2b2b; z-index: 90 }`。注释（`:83-85`、`index.wxml:32-34`）说明 tabBar 页的 WebView 本就落在原生 tabBar 之上，`bottom:0` 不留偏移。
- `index.wxss:120-129`：`.checkout-btn { min-width: 200rpx; padding: 16rpx 32rpx; font-size: 28rpx }`，与全局 `.btn-primary`（`app.wxss:80-91`，`height: 80rpx; padding: 0 48rpx`）叠用（`index.wxml:43`）。**两条规则特异性相同，谁的 padding 生效取决于样式注入顺序**：`.btn-primary` 胜 → 条高 108rpx≈54px（与统筹方「约 54px」一致）；`.checkout-btn` 胜 → 140rpx≈70px。本批不猜，用更高特异性的 `.local-cart-bar .checkout-btn` 钉死尺寸（§4.4）。
- `index.js:39-60 refresh()`：`cartApi.getCart('LOCAL')` → `localCatalog.summarizeCart(items)`（`utils/local-catalog.js:75-81`，按全部行累加 quantity/subtotal，**不看勾选态**）；`:62-68 recompute()` 用 `checkoutStateOf` 判起送线与阻塞；`:121-129 goCheckout()` 按 `mode` 跳 `/pages/local/pickup` 或 `/pages/local/confirm?cartItemIds=`。
- `index.wxss:6-18`：展开面板 `.cart-detail { bottom: calc(112rpx + env(safe-area-inset-bottom)) }`——写死的条高，条变薄后必须跟着变。
- 组件当前用于主页（`pages/index/index.wxml:160-167`，`wx:if="{{channel === 'LOCAL'}}"`）与分类页（`pages/product/list.wxml:175-182`，同条件）。

### 2.3 邮寄购物车数据源

- 同城与邮寄用**同一个接口** `GET /cart?channel=LOCAL|EXPRESS`（`apps/miniapp/api/cart.js:7-9`；服务端 `apps/server/src/routes/cart.ts:65-68`：`totalAmount` = **勾选行**小计之和，`selectedCount` = 勾选**行数**）。加购默认 `isSelected: 1`（`cart.ts:128`）。
- 邮寄购物车页 `pages/cart/index.js:75-99` 读同一接口，`:183-199 onCheckout()` 只把 `isSelected === 1` 的 id 传给 `/pages/order/confirm?cartItemIds=`；邮寄没有起送线判断（`:122-129`，起送在报价/下单时由服务端按 `minOrderAmountFen` 判）。
- 结论：**泛化现有组件即可**，不需要新组件、不需要改购物车（§5 T4）。

### 2.4 三个结算页的应付都是本地算的（不知道满减）

- 同城外送 `pages/local/confirm.js:427-433 syncPayAmount()`：`小计 − discount + quote.fee + packingFee`；报价 `quoteLocal(address.id, subtotal)`（`:240`），**响应已含** `promoDiscountFen` / `nextTierGapFen`（`apps/server/src/routes/local.ts:92,133-134`），页面没读。
- 自取 `pages/local/pickup.js:202-233 recompute()` → `st.computePickupPay(subtotal, discountRule, discount, packingFee)`（**在 `utils/pickup-checkout-state.js:100-106`**，不是「utils 某处」）：`小计 − 自取优惠 − min(券, 小计−自取优惠) + 打包费`。自取没有报价接口。
- 邮寄 `pages/order/confirm.js:148-152 recalcPay()`：`totalAmount − discount + shippingFee`；报价 `quoteExpress`（`api/express.js:5-7`），**响应已含** `promoDiscountFen` / `nextTierGapFen`（`apps/server/src/services/express-quote-service.ts:76,109`）。
- 服务端下单不比对客户端金额，按自己算的收钱（`routes/orders.ts:287-289` 满减、`:306` 券封顶、`:500` `computeCheckout`、`:1193/1207` 微信支付金额 = `order.actualAmount`）。所以现在满 200 的单，结算页比微信实扣多显示 20 元。

### 2.5 服务端已就绪的契约（`docs/api.md` 附录 K，代码核过）

| 接口 | 字段 | 代码位置 |
|---|---|---|
| `GET /api/local/meta`（公开） | `promotion: { active, name, startAt, endAt, channels: { LOCAL, PICKUP, EXPRESS }, tiers: [{ minFen, cutFen }] }`（不 active 也给结构，`tiers` 已按 `minFen` 升序） | `services/local-settings.ts:1113`，`services/promotion.ts:82-92` |
| 同上 | `fee: { minOrderAmount, baseFee, freeShipTiers: [{ minAmountFen, maxKm }], … }`、`radiusKm`、`pickup.discount: { type, value }` | `local-settings.ts:1086-1088,1100-1104` |
| `POST /api/local/quote` | `promoDiscountFen`、`nextTierGapFen`（按 LOCAL 渠道、请求体 `subtotal` 算） | `routes/local.ts:92,133-134` |
| `POST /api/express/quote` | `promoDiscountFen`、`nextTierGapFen`（按 EXPRESS 渠道、清单小计算） | `services/express-quote-service.ts:76,109` |
| `GET /api/local/promo-preview?deliveryType=LOCAL\|PICKUP\|EXPRESS&subtotal=N`（公开、无需登录） | `{ active, discountFen, nextTierMinFen, nextTierCutFen, nextTierGapFen }` | `routes/local.ts:141-153`，`promotion.ts:59-79` |
| 订单对象（下单响应 / 列表 / 详情） | `promoDiscountAmount`（分） | `routes/orders.ts:210,565` |

服务端计价公式（附录 K，`services/member/pricing.ts:150-165`，`routes/orders.ts:287-306`）：

```
promoDiscount  = min(promoDiscountOf(...), subtotal − pickupDiscount)
couponDiscount = 券 ? min(券面额, subtotal − pickupDiscount − promoDiscount) : 0
actualAmount   = subtotal − pickupDiscount − promoDiscount − couponDiscount + shippingFee + packingFee
```

起送门槛、免运费门槛、券门槛都按减前小计 `totalAmount` 判（P7，代码未动）。

### 2.6 优惠券组件 `apps/miniapp/components/checkout-benefits/`

- `index.js:10-13` 注释与 `:233-244 _emit()`：`discount` **一律取服务端 `coupons[].discount`**，组件自己不算封顶。那个 `min(面额, 小计)` 在服务端 `GET /member/checkout-options`（`routes/member.ts:141-155` → `services/member/pricing.ts:96`）。
- 而下单时的封顶是 `小计 − 自取优惠 − 满减`（`routes/orders.ts:306`）。所以有满减/自取优惠时，组件显示的 `−¥X` 与服务端实际抵扣可能不一致（只在 券面额 > 小计 − 自取优惠 − 满减 时出现）。
- `:257-267` 「预计得分」按 `subtotal − discount + shippingFee` 估，也不含自取优惠 / 满减 / 打包费（既有偏差）。
- 修法（§5 T8）：给组件加 `otherDiscount` 属性做二次封顶，父页传 `自取优惠 + 满减`。

### 2.7 同城免运费门槛不是一个数

`fee.freeShipTiers: [{ minAmountFen, maxKm }]`，且**还受距离限制**（`local-settings.ts:874-878`：达标档里取 `maxKm` 最大的一档，再看这单距离是否 ≤ `maxKm`）。购物车阶段没有地址、不知道距离，所以「再买 ¥Y 免运费」只能按金额说；档位不覆盖全配送范围（`maxKm < radiusKm`）时要带 km 说明（§4.3 规则 B）。自取运费恒 0、邮寄包邮按地区组，两者都**不**给免运费段。

### 2.8 其它环境事实

- 小程序页面表与 tabBar：`apps/miniapp/app.json`（主页 `pages/index/index`、分类 `pages/product/list`、购物车 `pages/cart/index`、我的 `pages/user/index`）。**不改 tabBar 配置。**
- `pages/local/index` 是兼容跳转页（`pages/local/index.js:1-8`），不再有购物车条，本批不动。
- 主页 EXPRESS 渠道目前**不拉** `/local/meta`（`pages/index/index.js:130-152`）；分类页 EXPRESS 也不拉（`list.js:113`）。活动条需要 `promotion`，两页在 EXPRESS 下要各补一次公开请求 `getLocalMeta()`，只取 `.promotion`。
- 测试：`npm run -s test:miniapp` = `node --test tests/miniapp/*.test.cjs`（`package.json:14`）；纯逻辑用例直接 `require` `apps/miniapp/utils/*.js`（例：`tests/miniapp/local-catalog.test.cjs:8-9`）；WXML 条件渲染用源码级正则断言（例：`tests/miniapp/navbar-index.test.cjs`）。
- ES5 闸门：`node scripts/check-miniapp-es5.mjs <file...>`（acorn `ecmaVersion:5` 真解析；**只对新增文件**，既有文件如 `pages/index/index.js`、`pages/order/confirm.js`、`pages/order/detail.js:1` 本身含 ES6，不去改它们，但新加的行一律写成 ES5 风格）。
- 预览台：`node tools/miniapp-preview/serve.mjs --port 5180`；镜像是手写 HTML（`tools/miniapp-preview/pages/*.html`），组件 wxss 按 `serve.mjs:28-45 PAGE_COMPONENTS` 登记；改结构必须同步镜像（`tools/miniapp-preview/README.md`）。
- 本地 MySQL：docker 容器 `food-shop-mysql`（root 密码 `foodshop_root_password`；应用账号 `foodshop_user` / `foodshop_password`；本机无 mysql 客户端，用 `docker exec`）。3000、3113 端口被占。服务端上海自然日按进程时区算，本机是 JST，跑服务端要 `TZ=Asia/Shanghai`。e2e 登录：`POST /api/auth/wechat-login {"code":"e2e_test_code"}`（`WECHAT_LOGIN_MOCK=true`）；管理员 `admin / admin123456`（`apps/server/prisma/seed.ts:23-29`）；mock 支付 `POST /api/orders/:id/pay`（`WECHAT_PAY_MOCK=true`，`routes/orders.ts:1111-1130`）。满减开法见 `scripts/e2e.d/66-promotion.sh:10-25`（整包 `PUT /api/admin/settings/local-delivery`）。

### 2.9 与统筹方口述不符之处（以代码为准）

1. **黑条现高**：按 CSS 推算是 54px 或 70px 二选一（§2.2），取决于 `.btn-primary` 与 `.checkout-btn` 谁的 padding 生效；wxss 注释里的「内容 112rpx」也对不上任何一种。本批用高特异性选择器钉死新尺寸，不再依赖注入顺序；执行方在开发者工具里量一次旧值写进回报即可，不影响方案。
2. **券封顶不在组件里**：`checkout-benefits/index.js:11-24` 是注释，组件不算 `min(面额, 小计)`，那是服务端 `checkout-options` 算的。修法是给组件加二次封顶（§5 T8），不是改组件的「算法」。
3. **`computePickupPay` 位置**：`utils/pickup-checkout-state.js:100-106`。
4. **同城免运费门槛**：不是单一数字，是 `freeShipTiers[{minAmountFen,maxKm}]` 且受距离限制（§2.7）。
5. **主页没有遮挡问题**（页面级滚动），只是占位高度要跟着新条变。
6. **邮寄购物车与同城同源**（§2.3），泛化组件即可，不需要新组件。
7. 主页与分类页在 EXPRESS 下不拉 `/local/meta`，活动条要补一次请求（§2.8）。

---

## 3. 目标与范围

**Goal：** ① 分类页（分组视图与搜索视图）滚到底时最后一件完整露在结算条之上、「+」可点；② 结算条压到 44px（375 宽、不含安全区），左侧合成一行、按钮 34px 高；③ 邮寄渠道的主页与分类页也有同一条结算条；④ 主页与分类页（两渠道）门店头 / 搜索栏下方有活动条；⑤ 结算条上方有进度提示三态；⑥ 三个结算页金额明细多一行「满减」，**页面应付 = 服务端 `actualAmount` = 微信支付金额**；⑦ 优惠券抵扣显示与服务端封顶一致；⑧ 订单详情多一行「满减」；⑨ 满减关闭时以上 ④⑤⑥⑧ 完全不出现、金额与现在逐分一致。

**不做：** 商品卡满减标签（P9）；服务端 / 后台任何改动；`app.json` tabBar；购物车页改版（只加一行进度提示，见 T9，可裁）；活动条自定义弹层（用系统 `wx.showModal`）。

---

## 4. 固定口径（执行方逐字执行，不重新讨论）

### 4.1 金额公式：小程序侧唯一实现 `apps/miniapp/utils/checkout-pay.js`

```js
// 与 docs/api.md 附录 K / apps/server/src/services/member/pricing.ts:150-165 逐字对应。
// 这是小程序里**唯一**允许出现的满减/券封顶加减法；满减取档（tiers 命中）永远在服务端。
function composePay(i) {
  var subtotal = i.subtotal || 0
  var pickup = Math.min(Math.max(0, i.pickupDiscount || 0), subtotal)
  var promo = Math.min(Math.max(0, i.promoFen || 0), subtotal - pickup)
  var coupon = Math.min(Math.max(0, i.couponDiscount || 0), subtotal - pickup - promo)
  return {
    pickupDiscount: pickup,
    promoDiscount: promo,
    couponDiscount: coupon,
    totalCut: pickup + promo + coupon,
    payAmount: subtotal - pickup - promo - coupon + (i.shippingFee || 0) + (i.packingFee || 0),
  }
}
module.exports = { composePay: composePay }
```

- **为什么必须本地算这一步**：服务端没有「下单前返回最终应付」的接口；三种结算页各自只能拿到分项（报价里的运费与满减、券组件里的券、meta 里的自取折扣、行上的打包费）。这里只做**组合加减与封顶**，不做取档；一致性由 §6 A3 用例钉住（与 `scripts/e2e.d/66-promotion.sh` 的服务端断言用同一组数字）。
- `promoFen` 的来源按页：同城外送 = `quote.promoDiscountFen`；邮寄 = `quote.promoDiscountFen`；自取 = `GET /local/promo-preview?deliveryType=PICKUP&subtotal=`.`discountFen`。**任何页面都不得从 `meta.promotion.tiers` 自己取档。**
- `promoFen` 为 0 / 未传时，三页结果必须与改前公式逐分一致（§6 A2 老逻辑用例）。

### 4.2 各页「满减未知」时的表现

- 同城外送：满减随报价来，报价未回 / 失败 / 阻塞时 `payAmount` 本就是 `null`（`local/confirm.js:427-433` 守卫），**不新增状态**。
- 邮寄：满减随报价来；`quoting` 期间按钮已禁用（`order/confirm.wxml:132`），`recalcPay` 用**上一次报价的** `promoFen`（初值 0），不新增状态。
- 自取：新增 `promoState: 'idle'|'loading'|'ready'|'error'`。`loading` 时 `payAmount = null`（走既有「待计算」）；`error` 时按钮文案「重新计算优惠」、可点、动作 `promo`（重新拉）；若 `meta.promotion` 已拿到且 `!active || channels.PICKUP === false` → 不请求、`promoFen = 0`、`ready`。

### 4.3 进度提示三态（`utils/promo.js` 的 `progressTipOf(preview, opts)`）

输入：`preview` = promo-preview 响应 `{ active, discountFen, nextTierMinFen, nextTierCutFen, nextTierGapFen }`；`opts = { deliveryType: 'LOCAL'|'PICKUP'|'EXPRESS', subtotal, freeShipTiers: [{minAmountFen,maxKm}], radiusKm }`（后两项只在 `LOCAL` 用）。输出 `{ show, text, tone: 'hint'|'done' }`。金额格式 `¥` + `(fen/100).toFixed(2).replace(/\.00$/, '')`（与 `components/local-store-header/index.js:61-62` 同款）。

- **规则 A**：`!preview || !preview.active` → `show: false`（满减关着、渠道未勾、过期：**整条不出现**）。
- **规则 B**（未达标，`discountFen === 0`）：`nextTierGapFen != null` → `再买 ¥{gap} 减 ¥{nextTierCutFen}`，`tone: 'hint'`；否则 `show: false`。
- **规则 C**（已达标，`discountFen > 0`）：首段 `已减 ¥{discountFen}`；第二段按下列优先级取**一个**：
  1. `deliveryType === 'LOCAL'` 且 `freeShipTiers.length > 0`：按 `minAmountFen` 升序；`reached` = 存在 `minAmountFen <= subtotal` 的档（取其中 `maxKm` 最大者），`next` = 第一条 `minAmountFen > subtotal` 的档。
     - `reached` → `已免运费`，若该档 `maxKm < radiusKm` 则写成 `{maxKm} km 内免运费`；`tone: 'done'`。
     - 否则 `next` 存在 → `再买 ¥{next.minAmountFen − subtotal} 免运费`，若 `next.maxKm < radiusKm` 追加 `（{maxKm} km 内）`；`tone: 'hint'`。
     - 否则无第二段，`tone: 'done'`。
  2. 其它渠道（或同城无免运档）：`nextTierGapFen != null` → `再买 ¥{gap} 可减 ¥{nextTierCutFen}`，`tone: 'hint'`；否则无第二段，`tone: 'done'`。
  段间用 ` · ` 连接。
- 三态与预览一致：「再买 ¥131 减 ¥20」→「已减 ¥20 · 再买 ¥29 免运费」→「已减 ¥20 · 已免运费」。

**防抖间隙不本地算**：结算条只在 promo-preview 响应回来后更新提示；在途期间保留上一条；请求失败 → `show: false`、金额不划线、副文案不写「已减」。这是展示层，结算页会重新取数，不影响一致性。

### 4.4 结算条尺寸（375 宽，`--rpx = 0.5px`）

- 外层改为 `.cart-dock { position: fixed; z-index: 90; left: 0; right: 0; bottom: 0 }`，内含 `.cart-tip`（可选）+ `.local-cart-bar`（不再自己 fixed）。
- `.local-cart-bar { display: flex; align-items: center; min-height: 88rpx; box-sizing: border-box; padding: 10rpx 12rpx 10rpx 24rpx; padding-bottom: calc(10rpx + env(safe-area-inset-bottom)); background: #2b2b2b; box-shadow 照旧 }` → 内容 88rpx = **44px**。
- `.local-cart-bar .checkout-btn { height: 68rpx; min-width: 200rpx; padding: 0 40rpx; font-size: 28rpx; margin-left: auto; box-sizing: border-box }`（特异性 0,2,0，压过 `.btn-primary` 的 `height: 80rpx; padding: 0 48rpx`）→ 按钮 **34px** 高，点击区 ≥ 32px。
- 左侧：`.cart-icon`（68rpx 圆、`#3c3c3c`，**用 CSS 画**一个白色描边购物车，参考预览 `.cart:before` 的写法；不新增图片资源）+ 右上角红色角标 `count`；文字区两行：`.cart-summary-amount`（34rpx 700 白）+ 达标时紧随其后的原价 `.cart-summary-orig`（23rpx `#8c8c8c` 删除线）；副行 `.cart-summary-sub`（21rpx `#a8a8a8`）。
- `.cart-tip { font-size: 24rpx; padding: 10rpx 20rpx; text-align: center; background: #fff7e6; color: #9a3412; border-top: 1rpx solid #fde7c7 }`，`.cart-tip-done { background: var(--success-bg); color: #166534; border-top-color: #dcfce7 }`，金额用 `<text class="cart-tip-em">`（`color: var(--brand); font-weight: 600`）。
- 展开面板 `.cart-detail` 的 `bottom` 改为行内 style `bottom: {{dockPx}}px`，`dockPx` 由组件量出（见 T3）。

### 4.5 结算条文案

| 渠道 / 状态 | 主金额 | 副行 | 按钮 |
|---|---|---|---|
| 同城，未达标 | `¥{amount}` | `共 N 件` | 既有逻辑（`去结算 · 外送/自取` / `还差 ¥X 起送` / `暂不可结算`，起送差额按**减前**小计，一字不改） |
| 同城，已达标 | `¥{amount − discountFen}` + 删除线 `¥{amount}` | `共 N 件 · 已减 ¥{d}` | 同上 |
| 邮寄，未达标 | `¥{amount}` | `共 N 件 · 运费结算时算` | `去结算 · 邮寄`；`count === 0` 时不渲染 |
| 邮寄，已达标 | 同同城已达标 | `共 N 件 · 已减 ¥{d} · 运费结算时算` | 同上 |

邮寄的 `amount` / `count` 只算 **`isSelected === 1`** 的行（与购物车页「合计」同口径，`routes/cart.ts:65-68`）；同城保持既有「全部行」口径不变。

### 4.6 活动条（新组件 `components/promo-bar/`，纯逻辑在 `utils/promo.js` 的 `promoBarOf(promotion, deliveryType)`）

- 显示条件：`promotion && promotion.active && promotion.channels[deliveryType] !== false && promotion.tiers.length > 0`；否则**整块不渲染、不占高度**。
- 外观：左 `减` 小标签（`var(--brand)` 底白字 21rpx，圆角 6rpx）+ `{name}　满 {min} 减 {cut} · 满 {min} 减 {cut}`（`tiers` 按 `minFen` 升序最多列 2 档，多于 2 档在末尾加 ` …`）+ 右端 `详情 ›`（`var(--text-3)` 23rpx）。整条 `background: #fff7f2; border-top: 1rpx solid var(--brand-bg-deep); padding: 12rpx 28rpx; font-size: 24rpx; color: #c2410c`。
- 点击整条 → `wx.showModal({ title: name, content: 每档一行「满 ¥X 减 ¥Y」+ 末行「与优惠券可叠加；运费、打包费不参与」, showCancel: false, confirmText: '知道了' })`。不显示起止时间（`endAt` 是 UTC ISO，本批不做本地化）。
- `deliveryType` 取值：主页 / 分类页 LOCAL 渠道按 `mode`（`DELIVERY → 'LOCAL'`，`PICKUP → 'PICKUP'`）；EXPRESS 渠道 `'EXPRESS'`。
- 位置：主页——同城在 `<local-store-header>` 之后、`<local-mode-bar>` 之前；邮寄在 banner 之后、分类区之前。分类页——同城在 `<local-store-header>` 之后；邮寄在 `.search-bar` 之后、搜索 chip 之前。**放在 `wx:if / wx:elif` 链之外**（`index.wxml:55-57` 注释的坑）。

---

## 5. 分步改动清单

每个任务可独立验证；顺序即建议执行顺序。每步完成后跑该步的验收再进下一步。

### T1 纯逻辑模块（新文件，ES5）

- [ ] 新建 `apps/miniapp/utils/checkout-pay.js`：`composePay`（§4.1 逐字）。
- [ ] 新建 `apps/miniapp/utils/promo.js`：`yuanShort(fen)`、`progressTipOf(preview, opts)`（§4.3）、`promoBarOf(promotion, deliveryType)` → `{ show, summary, name, detailLines }`（§4.6）、`promoTypeOf(channel, mode)` → `'LOCAL'|'PICKUP'|'EXPRESS'`。
- [ ] `apps/miniapp/utils/pickup-checkout-state.js`：
  - `computePickupPay(subtotal, rule, couponDiscount, packingFee, promoFen)` 改为内部调用 `composePay`，返回值**新增** `promoDiscount`，其余键与值不变；`promoFen` 不传 = 0，既有 `tests/miniapp/pickup-checkout-state.test.cjs` 必须原样全绿。
  - `pickupCheckoutAction(s)` 新增入参 `promoError`：放在 `belowMinGap` 判定之后、`payAmount == null` 判定之前：`if (st.promoError) return result(false, TEXT.PROMO_RETRY, 'pending', 'promo')`；`TEXT.PROMO_RETRY = '重新计算优惠'`。文件头注释的优先级列表同步加一格。
- [ ] `apps/miniapp/api/local.js`：新增 `getPromoPreview(deliveryType, subtotal)` → `request({ url: '/local/promo-preview?deliveryType=' + deliveryType + '&subtotal=' + (subtotal || 0), silent: true })`。
- [ ] 新建 `tests/miniapp/promo.test.cjs`（用例清单见 §6 A1）。
- 验收：§6 A1、A2、B1。

### T2 分类页与主页底部占位（修问题 1）

- [ ] `pages/product/list.wxss`：删除 `269-273` 那条 `.page-local .prod-panel { padding-bottom … }` 及其注释；新增 `.cart-spacer { width: 100%; }`。
- [ ] `pages/product/list.wxml`：在 scroll-view 内容末尾放真实占位——分组视图 `group-tail` 之后、搜索视图 `footer-tip` 之后各一处：`<view class="cart-spacer" style="height: {{cartSpacerPx}}px;"></view>`（必须在 `<scroll-view class="prod-panel">` 内部）。
- [ ] `pages/product/list.js`：`data.cartSpacerPx: 0`；新增 `onCartHeight(e)`：`var px = e.detail.px || 0; if (px !== this.data.cartSpacerPx) { this.setData({ cartSpacerPx: px }); this.afterGroupsRendered() }`；`measureOffsets` 的补白改为 `tail = max(0, round(visible − 最后段高 − this.data.cartSpacerPx))`，并把 `:242-243` 那段依赖 padding 的注释改成说明「占位块与补白分开算」。`reloadForChannel` 不清 `cartSpacerPx`（组件会重新上报）。
- [ ] `pages/index/index.wxss`：删除 `303-307` `.page-local { padding-bottom … }`，加 `.cart-spacer { width: 100%; }`；`pages/index/index.wxml`：`.page` 容器最后加同款占位 view；`index.js` 加 `data.cartSpacerPx: 0` 与 `onCartHeight(e)`（只 setData，主页不需要重量锚点）。
- 验收：§6 A4（源码级）、C1（真机）。

### T3 结算条组件压薄 + 进度提示 + 高度上报

- [ ] `components/local-cart-bar/index.wxml`：按 §4.4 重排为 `.cart-dock > [.cart-tip?] + .local-cart-bar`；左侧 `.cart-icon`+角标、金额行（达标时带删除线原价）、副行；右侧按钮。展开面板 `style="bottom: {{dockPx}}px"`。
- [ ] `components/local-cart-bar/index.wxss`：按 §4.4 尺寸重写条与按钮；删除 `.cart-detail` 里写死的 `bottom: calc(112rpx + …)`。
- [ ] `components/local-cart-bar/index.js`：
  - 新增 properties：`channel: { type: String, value: 'LOCAL' }`、`promotion: { type: null, value: null }`。
  - `refresh()`：请求 `getCart(this.properties.channel)`；`EXPRESS` 时只累加 `isSelected === 1` 的行（件数 = Σquantity，金额 = Σsubtotal），`LOCAL` 保持 `summarizeCart` 全部行。之后调 `loadPromo()`。
  - 新增 `loadPromo()`：`count === 0` → 清空提示与满减；`this.properties.promotion` 已知且 `!active || channels[type] === false` → 不请求、清空；否则 `getPromoPreview(type, amount)`（`type = promoTypeOf(channel, mode)`），序号守卫，成功后 `setData({ promoFen: discountFen, tip: progressTipOf(res, { deliveryType, subtotal: amount, freeShipTiers: meta.fee.freeShipTiers, radiusKm: meta.radiusKm }) })`，失败 → `tip.show=false, promoFen=0`。**不做 setTimeout 轮询**。
  - `recompute()`：同城逻辑不变；`EXPRESS` 时 `disabled = count === 0`、`actionText = '去结算 · 邮寄'`（不看 meta / blocking / 起送线）。
  - 副行与主金额按 §4.5 组装成 `subText / amountText / origText`（在 js 里拼，wxml 只显示）。
  - `goCheckout()`：`EXPRESS` → `wx.navigateTo({ url: '/pages/order/confirm?cartItemIds=' + 勾选行 id })`。
  - 新增 `measureDock()`：每次 `setData` 改变 `count / tip / expanded` 后在 `wx.nextTick` 里 `wx.createSelectorQuery().in(this).select('.cart-dock').boundingClientRect()`，得到高度 px（`count === 0` 时 dock 不渲染，上报 0）；`setData({ dockPx })` 并 `triggerEvent('height', { px })`（值不变不重复上报）。
  - observers 里 `'meta, blocking, mode, promotion'` 变化 → `recompute()` + `loadPromo()`（mode 变了要换 deliveryType）。
- 验收：§6 A5（源码级）、B2（预览台）、C2/C3（真机）。

### T4 邮寄接入结算条 + 主页/分类页接线

- [ ] `pages/product/list.wxml:175-182`：去掉 `wx:if="{{channel === 'LOCAL'}}"`，加 `channel="{{channel}}" promotion="{{promotion}}" bind:height="onCartHeight"`；`meta / blocking / mode` 照传（EXPRESS 下为 null/false/'DELIVERY'，组件不读）。
- [ ] `pages/index/index.wxml:160-167`：同上。
- [ ] `pages/product/list.js`：`data.promotion: null`；`reloadForChannel` 里 EXPRESS 也调 `loadMeta(false)` 但只取 `.promotion`——实现为 `loadMeta` 内按渠道分支：LOCAL 走既有 setData，EXPRESS 只 `setData({ promotion: meta.promotion })`；LOCAL 分支的 setData 里也带上 `promotion: meta.promotion`。`onShow` 的 `refreshCartBar()` 与 `loadMeta()` 对两个渠道都调（EXPRESS 下 `loadMeta` 只更新 `promotion`）。`onAdded` 不变（邮寄加购在商品详情页，回列表走 `onShow`）。
- [ ] `pages/index/index.js`：同样在 `loadExpress` 里并入 `getLocalMeta().catch(() => null)`，只取 `.promotion`；`loadLocal` 的 setData 加 `promotion: meta && meta.promotion`；`onShow` 对 EXPRESS 也 `refreshCartBar()`。
- 验收：§6 A5、B2、C3。

### T5 活动条

- [ ] 新建 `components/promo-bar/{index.js,index.wxml,index.wxss,index.json}`：properties `promotion`、`deliveryType`；observer 调 `promoBarOf` 得 `{ show, summary, name, detailLines }`；`onTapDetail` → `wx.showModal`（§4.6）。ES5。
- [ ] `pages/index/index.json`、`pages/product/list.json` 的 `usingComponents` 登记 `promo-bar`。
- [ ] 两页 wxml 按 §4.6 位置插入 `<promo-bar promotion="{{promotion}}" delivery-type="{{promoType}}" />`；`promoType` 由页面 js 用 `promoTypeOf(channel, mode)` 维护（`applyMode / reloadForChannel / loadData` 时更新）。分类页插入后门店头变高，`loadMeta` 里已有 `afterGroupsRendered()` 重量（`list.js:123`），确认它在 `promotion` 落地后仍被调用。
- 验收：§6 A6、B2、C4。

### T6 三个结算页：满减行 + 应付改服务端取数

- [ ] `pages/local/confirm.js`：`data` 加 `promoFen: 0, promoDiscount: 0, couponDiscount: 0, totalCut: 0`；报价成功分支（`:286` 前后）`patch.promoFen = quote.promoDiscountFen || 0`，失败/阻塞分支 `promoFen: 0`；`syncPayAmount` 改为 `var r = composePay({ subtotal, pickupDiscount: 0, promoFen: d.promoFen, couponDiscount: d.discount, shippingFee: fee, packingFee: d.packingFee }); setData({ payAmount: r.payAmount, promoDiscount: r.promoDiscount, couponDiscount: r.couponDiscount, totalCut: r.totalCut })`；守卫条件一字不改。
- [ ] `pages/local/confirm.wxml`：金额明细在「打包费」行之后、「优惠券」行之前插 `<view wx:if="{{promoDiscount > 0}}" class="sum-row"><text class="sum-k">满减</text><text class="sum-v sum-cut">−¥{{pricefmt.fen(promoDiscount)}}</text></view>`；「优惠券」行改显示 `couponDiscount`（`wx:if="{{couponDiscount > 0}}"`）；底栏合计下加 `<text wx:if="{{action.amountState === 'ready' && totalCut > 0}}" class="bottom-total-sub">已优惠 ¥{{pricefmt.fen(totalCut)}}</text>`（`.bottom-total-sub { display: block; font-size: 22rpx; color: var(--brand); }`，放在 `.bottom-total-wrap` 内，wrap 改 `flex-direction: column; align-items: flex-start`）。
- [ ] `pages/local/pickup.js`：`data` 加 `promoFen: 0, promoState: 'idle', promoDiscount: 0, totalCut: 0`；新增 `loadPromo()`（§4.2 自取规则；序号守卫；在 `loadAll` 拿到 subtotal 后、`reloadCart` 后、`applyMeta` 后各调一次——`applyMeta` 后调是为了「meta 说没活动」时立刻把状态置 ready）；`recompute` 改用 `st.computePickupPay(d.subtotal, d.discountRule, d.discount, packingFee, d.promoFen)`，`payAmount = (items.length && promoState === 'ready') ? amounts.payAmount : null`，向 `pickupCheckoutAction` 传 `promoError: promoState === 'error'`；`onSubmit` 的分派加 `action === 'promo' → loadPromo()`。
- [ ] `pages/local/pickup.wxml`：在「自取优惠」行之后、「优惠券」行之前插「满减」行（同上写法）；底栏加「已优惠」小字（同上）。
- [ ] `pages/order/confirm.js`：`data` 加 `promoFen: 0, promoDiscount: 0, couponDiscount: 0, totalCut: 0`；报价成功 `promoFen: q.promoDiscountFen || 0`，无地址 / 空清单 / 42260 等失败分支 `promoFen: 0`；`recalcPay` 改 `composePay({ subtotal: totalAmount, promoFen, couponDiscount: discount, shippingFee })`。
- [ ] `pages/order/confirm.wxml`：「商品金额」行之后、「优惠券」行之前插 `<view wx:if="{{promoDiscount > 0}}" class="row"><text class="row-label">满减</text><text class="row-value discount">−¥{{pricefmt.fen(promoDiscount)}}</text></view>`；「优惠券」行改显示 `couponDiscount`；底栏「已优惠」小字同上（`totalCut > 0` 且 `!quoting && !blockReason && !quoteError`）。
- [ ] 三页的 `console.warn('… payAmount 与服务端 actualAmount 不一致 …')` 探针保留（`order/confirm.js:285-289` 已有；同城两页若无则**加**同款：下单成功后比较 `res.actualAmount` 与 `this.data.payAmount`）。
- 验收：§6 A3、A7、B3。

### T7 优惠券封顶对齐（`components/checkout-benefits/`）

- [ ] `index.js` properties 加 `otherDiscount: { type: Number, value: 0 }`（= 自取优惠 + 满减，父页算好传入）；`_emit()` 里 `discount = Math.min(sel.discount || 0, Math.max(0, this.data.subtotal - (this.properties.otherDiscount || 0)))`；「预计得分」的 `payFen = subtotal − otherDiscount − discount + shippingFee`；observers 加 `otherDiscount: function () { if (state 是 ready/empty) this._emit() }`。`_emitLoading` 不变（它复用 `this.data.discount`）。
- [ ] 三个结算页 wxml 给组件传 `other-discount="{{otherDiscount}}"`；页面 js 在各自的重算点里 `setData({ otherDiscount: r.pickupDiscount + r.promoDiscount })`（同城外送为 `promoDiscount`；邮寄为 `promoDiscount`；自取为 `pickupDiscount + promoDiscount`）。
- 验收：§6 A3（券封顶用例）、A7。

### T8 订单详情满减行

- [ ] `pages/order/detail.js:335` 附近加 `promoDiscountAmountText: formatPrice(order.promoDiscountAmount || 0)`。
- [ ] `pages/order/detail.wxml:150-157`：在「自取优惠」行之后、「优惠券」行之前插 `<view class="amount-row" wx:if="{{order.promoDiscountAmount > 0}}"><text class="amount-label">满减</text><text class="amount-value discount">−¥{{order.promoDiscountAmountText}}</text></view>`。
- 验收：§6 A8。

### T9 购物车 tabBar 页进度提示（可裁；默认做，见 §9 Q2）

- [ ] `pages/cart/index.js`：`loadCart` 成功后按 `channel / mode / totalAmount` 调 `getPromoPreview`（LOCAL 用 `meta.fee.freeShipTiers / radiusKm`），`setData({ promoTip })`；EXPRESS 下也拉一次 `getLocalMeta()` 只取 `promotion` 来决定要不要请求。
- [ ] `pages/cart/index.wxml`：`.bottom-bar` 之上（同一个 fixed 容器内，仿 T3 的 `.cart-tip`）加一行提示；`.bottom-spacer` 高度相应加大（`index.wxss:130-132`，加 `56rpx`）。
- 验收：§6 A6（源码级）、B2。

### T10 预览台镜像同步

- [ ] `tools/miniapp-preview/serve.mjs` `PAGE_COMPONENTS`：`index`、`index-local`、`index-local-pickup`、`product-list` 加 `'local-cart-bar', 'promo-bar'`；`local-confirm`、`local-pickup`、`order-confirm` 不变（组件已登记）。
- [ ] 更新镜像：`pages/index.html`（邮寄主页：活动条 + 新结算条）、`pages/index-local.html`（活动条 + 新结算条 + 进度提示已达标态）、`pages/product-list.html`（活动条 + `cart-spacer` + 新结算条）、`pages/local-confirm.html`、`pages/local-pickup.html`、`pages/order-confirm.html`（满减行 + 已优惠小字）、`pages/order-detail.html`（满减行）。示例数字沿用预览 HTML（满 200 减 20、小计 211、券 5、配送费 6、打包费 7、应付 199）。
- 验收：§6 B2。

### T11 文档

- [ ] `docs/api.md` 附录 K 末尾加一小节「小程序接入（2026-09-19）」：三处 `promoFen` 来源、`composePay` 是小程序侧唯一组合点、`checkout-benefits.otherDiscount` 的含义、promo-preview 的失败表现（自取 `重新计算优惠`；结算条隐藏提示）。
- [ ] `tools/miniapp-preview/README.md` 页面数与组件登记表若有数字/列表，同步。
- [ ] 本文件末尾追加「执行记录」：每个 T 的提交 sha、量到的旧条高度、与方案的偏离。

---

## 6. 验收标准（命令 / 实测方法 / 期望）

### A. 可脚本化（工序 04 逐条跑）

| # | 命令 | 期望 |
|---|---|---|
| A1 | `npm run -s test:miniapp` | 全绿（2026-09-19 基线 `7f3374d`：193 tests / 193 pass / 0 fail，改完只能多不能少）；`tests/miniapp/promo.test.cjs` 至少含：进度三态各一条（§4.3 规则 B、C-1 未达免运、C-1 已免运）、`active:false` 隐藏、PICKUP/EXPRESS 不出免运段、`maxKm < radiusKm` 带 km 说明、已达标且有下一档的 `再买 ¥X 可减 ¥Y`、`promoBarOf` 的显隐（关 / 渠道未勾 / 无档 / 3 档截断为 2 档 + `…`）、`composePay` 的 §66 数字（见 A3）与 `promoFen=0` 时等于旧公式。 |
| A2 | 同上 | 既有 `tests/miniapp/pickup-checkout-state.test.cjs`、`local-checkout-state.test.cjs`、`local-catalog.test.cjs` **一字不改**仍全绿（老逻辑不回归：起送门槛、打包费、自取折扣、券门槛）。 |
| A3 | `node --test tests/miniapp/promo.test.cjs` | `composePay` 钉住以下数字（与 `scripts/e2e.d/66-promotion.sh` ②③④⑤ 服务端断言同源）：同城 `{subtotal:6000, promoFen:500, shippingFee:F}` → `payAmount = 5500+F`；自取 `{6000, pickupDiscount:300, promoFen:500}` → `5200`；邮寄 `{6000, promoFen:500, shippingFee:0}` → `5500`；券叠加 `{6000, promoFen:500, couponDiscount:6000}` → `couponDiscount=5500, payAmount=0+运费`；自取 + 满减把满减挤压：`{1000, pickupDiscount:800, promoFen:500}` → `promoDiscount=200`。 |
| A4 | `node --test tests/miniapp/cart-bar-page.test.cjs`（新建，源码级） | ① `pages/product/list.wxss` 不再含 `.page-local .prod-panel`；② `list.wxml` 里 `<scroll-view class="prod-panel"` … `</scroll-view>` 之间 `class="cart-spacer"` 出现 **2 次**（分组视图 + 搜索视图）；③ `pages/index/index.wxss` 不再含 `.page-local {`，`index.wxml` 含 `cart-spacer`；④ `list.js` 的 `measureOffsets` 含 `cartSpacerPx`。 |
| A5 | 同上 | ⑤ `list.wxml` 与 `index.wxml` 的 `<local-cart-bar` 标签**不含** `wx:if`，且含 `channel="{{channel}}"` 与 `bind:height`；⑥ `components/local-cart-bar/index.wxss` 含 `.local-cart-bar .checkout-btn` 且其块内 `height: 68rpx`，`.local-cart-bar` 块内 `min-height: 88rpx`，不再含 `112rpx`；⑦ 组件 wxml 含 `class="cart-dock"` 与 `cart-tip`。 |
| A6 | 同上 | ⑧ `index.wxml`、`list.wxml` 各含 `<promo-bar`，且它不在 `wx:elif` 链内（正则：`<promo-bar` 标签本身不含 `wx:elif`）；⑨ 两页 `.json` 的 `usingComponents` 含 `promo-bar`；⑩（若做 T9）`pages/cart/index.wxml` 含 `cart-tip`。 |
| A7 | 同上 | ⑪ `pages/local/confirm.wxml`、`pages/local/pickup.wxml`、`pages/order/confirm.wxml` 各含一行 `满减` 且其 `wx:if` 用 `promoDiscount > 0`，位置：外送在「打包费」与「优惠券」之间，自取在「自取优惠」与「优惠券」之间，邮寄在「商品金额」与「优惠券」之间（按字符串出现顺序断言）；⑫ 三页 `<checkout-benefits` 含 `other-discount=`；⑬ `pages/local/confirm.js`、`pages/local/pickup.js`（经 `computePickupPay`）、`pages/order/confirm.js` 都 `require` 了 `checkout-pay` 或经 `pickup-checkout-state` 间接使用（正则 `composePay\(` 在 `local/confirm.js`、`order/confirm.js`、`utils/pickup-checkout-state.js` 各至少 1 处），且三页**不再**含旧公式 `d.subtotal - d.discount + fee + d.packingFee` / `this.data.totalAmount - this.data.discount + (this.data.shippingFee || 0)`。 |
| A8 | 同上 | ⑭ `pages/order/detail.wxml` 含 `order.promoDiscountAmount > 0` 的行，且出现在 `pickupDiscountAmount` 行之后、`discountAmount` 行之前；`detail.js` 含 `promoDiscountAmountText`。 |
| A9 | `node scripts/check-miniapp-es5.mjs apps/miniapp/utils/checkout-pay.js apps/miniapp/utils/promo.js apps/miniapp/utils/pickup-checkout-state.js apps/miniapp/utils/local-checkout-state.js apps/miniapp/components/promo-bar/index.js apps/miniapp/components/local-cart-bar/index.js apps/miniapp/components/checkout-benefits/index.js apps/miniapp/pages/local/confirm.js apps/miniapp/pages/local/pickup.js`（worktree 装不上 acorn 时可用主仓脚本路径 `node /Users/yumingyi/food-shop/scripts/check-miniapp-es5.mjs <同一组文件>`，不 cd 过去） | `全部通过（9 个文件）`。2026-09-19 基线实测这 7 个既有文件本就 ✔。**以下 6 个既有文件本就含 `const`（基线实测 ✘），不入闸门**：`api/local.js`、`pages/product/list.js`、`pages/index/index.js`、`pages/order/confirm.js`、`pages/cart/index.js`、`pages/order/detail.js`；但它们 diff 里新增的行不得引入 `const/let/=>/模板串/解构`——工序 04 用 `git diff 7f3374d -- <这六个文件> | grep '^+' | grep -vE '^\+\+\+' | grep -E "(\bconst\b|\blet\b|=>|\`)"` 期望**空**。 |
| A10 | `git diff --stat 7f3374d..HEAD -- apps/server apps/admin apps/miniapp/app.json` | 输出为空（白名单外零改动）。 |
| A11 | 金额一致性（本地，mock 支付）——步骤见 §8.2 | 三种渠道各一单，`composePay(页面能拿到的输入)` 的 `payAmount` == 下单响应 `actualAmount` == `GET /api/orders/:id` 的 `actualAmount`（mock 支付把该值原样记为支付金额，`routes/orders.ts:1193/1207` 微信真实路径也用它）。组合：同城外送（满减 + 券）、自取（自取 9.5 折 + 满减 + 券）、邮寄（满减 + 券）。把三组输入与输出贴进执行记录。 |
| A12 | 满减关闭（§8.2 第 6 步把 `promotion.enabled=false` 后重复 A11 的三单） | `promoDiscountFen = 0`、`promo-preview.active=false`、`actualAmount` 与 `composePay(promoFen=0)` 一致，且与改前公式（`小计 − 券 + 运费 + 打包费` / 自取旧公式）逐分相等。 |

### B. 预览台 / 开发者工具（执行方跑，截图进执行记录）

| # | 方法 | 期望 |
|---|---|---|
| B1 | `node -e "console.log(require('./apps/miniapp/utils/promo.js').progressTipOf({active:true,discountFen:0,nextTierMinFen:20000,nextTierCutFen:2000,nextTierGapFen:13100},{deliveryType:'LOCAL',subtotal:6900,freeShipTiers:[{minAmountFen:9900,maxKm:5}],radiusKm:8}))"` | `{ show: true, text: '再买 ¥131 减 ¥20', tone: 'hint' }`。 |
| B2 | `node tools/miniapp-preview/serve.mjs --port 5180`，打开 `index-local`、`index`、`product-list`、`local-confirm`、`local-pickup`、`order-confirm`、`order-detail` | 与预览 HTML 对应版式一致：黑条 44px（浏览器 DevTools 量 `.local-cart-bar` 高度 = 44px，`.checkout-btn` = 34px）；活动条与进度提示出现在指定位置；金额明细「满减」行在指定位置；`product-list` 底部有 `cart-spacer`。 |
| B3 | 微信开发者工具（主仓合并后由店主做，或执行方用本 worktree 路径打开）：三个结算页在本地服务端（§8）下走一遍 | 页面「应付」与提交后订单详情「合计」一致；满减行显示；「已优惠」小字 = 自取优惠 + 满减 + 券。 |
| B4 | 开发者工具量旧条高度（在 `7f3374d` 检出下） | 写进执行记录（54 或 70），只为记录，不影响验收。 |

### C. 真机验收清单（只能真机验；店主在体验版做，执行方写清操作步骤）

| # | 操作 | 期望 |
|---|---|---|
| C1 | iOS 真机微信 → 分类页（同城）→ 点最后一个分类「酒水/饮料」→ 滚到底 | 最后一件商品**整卡**露在结算条上方，「+」能点开规格弹层；空车时（无结算条）底部没有多余空白。同样操作在邮寄渠道分组视图与**搜索结果**视图各做一次。切换外送/自取、加购让进度提示出现/消失后再滚到底，占位跟着变。 |
| C2 | 同城加 1 件后看结算条 | 条高约 44pt（与 tabBar 高度接近），按钮好按；**条与原生 tabBar 之间没有空白缝**（若有缝 = `env(safe-area-inset-bottom)` 在 tabBar 页非零 → 触发 §8 上报 R7，不擅自改）。安卓也看一次。 |
| C3 | 邮寄渠道：商品详情加购 → 返回分类页 / 主页 | 出现同款结算条，「去结算 · 邮寄」进 `pages/order/confirm` 且只带勾选行；展开面板能改数量 / 删除；「购物车」tabBar 页照旧可用。 |
| C4 | 本地开满减（店主线上先别开）：主页与分类页（同城外送 / 自取 / 邮寄三种） | 活动条只在该渠道勾选时出现；点「详情」弹系统弹窗列全档位；进度提示三态随金额变；达标后条上金额划线；自取渠道未勾时活动条与提示都不出现。 |
| C5 | 三个结算页下单到微信支付页 | 微信支付页金额 == 结算页「应付」（含满减 + 券 + 自取折扣 + 打包费 + 运费）。 |
| C6 | 关掉满减后重看 C4、C5 | 活动条 / 进度提示完全消失；结算条高度回到 44pt（没有提示行）；金额与现在线上一致。 |
| C7 | 320 宽机型（iPhone SE）或开发者工具选 iPhone 5 | 结算条左侧「¥191.00 ~~¥211.00~~」+ 副行不与按钮重叠；进度提示一行放得下（最长「已减 ¥20 · 再买 ¥29 免运费（5 km 内）」）。 |

### D. 回退验证（至少两处，执行方跑并记录）

| # | 操作 | 期望 |
|---|---|---|
| D1 | 临时把 `utils/checkout-pay.js` 的 `promo` 行改成 `var promo = 0`，跑 A3 | 同城 / 自取 / 邮寄三条与券叠加一条变红；改回后全绿。 |
| D2 | 临时恢复 `list.wxss` 的 `.page-local .prod-panel { padding-bottom … }` 并删掉分组视图那处 `cart-spacer`，跑 A4 | ①② 变红；改回后全绿。 |
| D3 | 临时给 `list.wxml` 的 `<local-cart-bar` 加回 `wx:if="{{channel === 'LOCAL'}}"`，跑 A5 | ⑤ 变红；改回后全绿。 |
| D4 | 临时把 `components/checkout-benefits/index.js` 的封顶那行去掉 `Math.min`，用 A11 的「券 6000」那单比对 | 页面券显示 6000、`composePay` 仍给 5500（页面明细与组件行不一致）——证明封顶是组件在做；改回后一致。 |

回退验证必须在**已提交**当前工作之后做（先 `git commit`，再改、跑、`git checkout -- <file>` 复原），避免用 `git checkout --` 冲掉未提交改动。

---

## 7. 允许修改的文件白名单

**允许（精确）：**

- `apps/miniapp/utils/checkout-pay.js`（新）、`apps/miniapp/utils/promo.js`（新）、`apps/miniapp/utils/pickup-checkout-state.js`
- `apps/miniapp/api/local.js`
- `apps/miniapp/components/local-cart-bar/index.{js,wxml,wxss,json}`
- `apps/miniapp/components/promo-bar/index.{js,wxml,wxss,json}`（新）
- `apps/miniapp/components/checkout-benefits/index.{js,wxml,wxss}`
- `apps/miniapp/pages/product/list.{js,wxml,wxss,json}`
- `apps/miniapp/pages/index/index.{js,wxml,wxss,json}`
- `apps/miniapp/pages/local/confirm.{js,wxml,wxss}`、`apps/miniapp/pages/local/pickup.{js,wxml,wxss}`
- `apps/miniapp/pages/order/confirm.{js,wxml,wxss}`、`apps/miniapp/pages/order/detail.{js,wxml}`
- `apps/miniapp/pages/cart/index.{js,wxml,wxss}`（仅 T9）
- `tests/miniapp/promo.test.cjs`（新）、`tests/miniapp/cart-bar-page.test.cjs`（新）
- `tools/miniapp-preview/serve.mjs`、`tools/miniapp-preview/pages/{index,index-local,index-local-pickup,product-list,local-confirm,local-pickup,order-confirm,order-detail}.html`、`tools/miniapp-preview/README.md`
- `docs/api.md`（仅附录 K 追加一节）、本文件（追加执行记录）

**禁止：** `apps/server/**`、`apps/admin/**`、`apps/miniapp/app.json`、`apps/miniapp/app.wxss`、`apps/miniapp/app.js`、`apps/miniapp/utils/local-catalog.js`、`apps/miniapp/utils/local-checkout-state.js`（`checkoutAction` 不需要动；若发现需要动 → 上报）、`package.json`、`scripts/**`、既有 `tests/miniapp/*.test.cjs`（不得改动以「让它绿」）。

---

## 8. 环境配方与执行注意事项

### 8.1 本地服务端（用于 A11/A12、B3）

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/miniapp-promo
npm install                                   # 首次；worktree 无 node_modules
(cd apps/server && npx prisma generate)       # 与其它 worktree 共用 client，同一时刻只能一个 agent 跑
docker exec -i food-shop-mysql mysql -uroot -pfoodshop_root_password -e "DROP DATABASE IF EXISTS food_shop_mp_promo; CREATE DATABASE food_shop_mp_promo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON food_shop_mp_promo.* TO 'foodshop_user'@'%'; FLUSH PRIVILEGES;"
export DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_mp_promo"
(cd apps/server && npx prisma migrate deploy && npx prisma db seed)
TZ=Asia/Shanghai PORT=3121 DATABASE_URL="$DATABASE_URL" JWT_SECRET=miniapp-promo-jwt-secret-16 ADMIN_JWT_SECRET=miniapp-promo-admin-secret-16 WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true WECHAT_QRCODE_MOCK=true LOCAL_DELIVERY_PROVIDER_MOCK=true PRINTER_PROVIDER_MOCK=true SCHEDULER_DISABLED=true npm --prefix apps/server run dev
```

- 端口 **3121**（3000、3113 被占；若 3121 也被占换 3122 并写进记录）。用 `run_in_background` 起服务，`curl -s localhost:3121/health` 轮询 ≤ 60 s 判就绪；每条命令给 `timeout`，不无限等待。
- 小程序开发者工具若要连本地：`apps/miniapp/config` 里的 baseURL 由店主自己临时改，执行方**不提交**该改动。

### 8.2 金额一致性复现步骤（A11 / A12）

用 `curl + jq`（与 `scripts/e2e.sh` 的 `req` 同款），`BASE=http://localhost:3121`：

1. 管理员登录 `POST /api/admin/login {"username":"admin","password":"admin123456"}` → `AT`。
2. 开满减 + 自取折扣 + 打包费：`GET /api/admin/settings/local-delivery` 取整包，用 jq 改 `.promotion={enabled:true,name:"本地测试满减",startAt:null,endAt:null,channels:{LOCAL:true,PICKUP:true,EXPRESS:true},tiers:[{minFen:5000,cutFen:500},{minFen:10000,cutFen:1200}]} | .pickup.enabled=true | .pickup.discount={type:"PERCENT",value:95} | .pickup.minOrderAmountFen=0 | .packing.enabled=true | .packing.perItemFen=100 | .fee.minOrderAmount=0 | .fee.freeShipTiers=[{minAmountFen:9900,maxKm:5}] | .enabled=true | .paused=null | .holiday=null | .businessHours=[{start:"00:00",end:"23:59"}] | .store.latE6=29339000 | .store.lngE6=104778000 | .radiusKm=5`，`PUT` 回去（参考 `scripts/e2e.d/66-promotion.sh:10-25`）。
3. 顾客登录 `POST /api/auth/wechat-login {"code":"mp_promo_user"}` → `UT`；建带坐标地址（同 `scripts/e2e.sh:519-521` 那条 body）→ `LADDR`；建普通地址 → `ADDR`。
4. 建两件 ¥30 商品（LOCAL 与 EXPRESS 各一，`POST /api/admin/products`，见 `66-promotion.sh:27-30`）；发一张面额 6000 门槛 6000 的 LOCAL 券并领取（`66-promotion.sh` ⑤）。
5. 三单：
   - 同城外送：`POST /api/local/quote {addressId:LADDR, subtotal:6000}` → 记 `fee`、`promoDiscountFen`、`quoteToken`；`GET /api/member/checkout-options?channel=LOCAL&subtotal=6000` → 记券 `discount`；`node -e` 调 `composePay({subtotal:6000, promoFen, couponDiscount, shippingFee:fee, packingFee:200})` 得 `pageAmount`；`POST /api/orders {directItem:{productId,quantity:2}, addressId:LADDR, deliveryType:'LOCAL', quoteToken, couponId}` → `actualAmount` 必须等于 `pageAmount`；`POST /api/orders/:id/pay`；`GET /api/orders/:id` 的 `actualAmount`、`promoDiscountAmount`、`discountAmount` 与页面分项一致。
   - 自取：`GET /api/local/promo-preview?deliveryType=PICKUP&subtotal=6000` → `discountFen`；`pickupDiscount = 6000 − round(6000×95/100) = 300`；`composePay({6000, pickupDiscount:300, promoFen, couponDiscount, packingFee:200})`；`POST /api/orders {directItem…, deliveryType:'PICKUP', pickupAt:<GET /api/local/pickup-slots 第一格 startAt>, pickupContact:{phone:'13800009901'}, couponId}`。
   - 邮寄：`POST /api/express/quote {addressId:ADDR, directItem:{productId:E,quantity:2}}` → `feeFen`、`promoDiscountFen`；`composePay({6000, promoFen, couponDiscount, shippingFee:feeFen})`；`POST /api/orders {…, deliveryType:'EXPRESS'}`。
6. `promotion.enabled=false` 后重复第 5 步（A12），对比与旧公式。

页面侧真正调用的是同一个 `composePay`，所以这一步等价于验证「页面能拿到的输入 → 页面显示的应付」与服务端一致。

### 8.3 执行注意事项（前几批踩过的坑）

- 长时间等待会被系统判停：起服务、跑测试都要有上限地轮询，每条命令给 `timeout`。
- **先提交再做回退验证**（§6 D），别用 `git checkout --` 冲掉未提交改动。
- 不在任何表单里输入密码；不上传体验版、不合并 main、不部署。
- 各 worktree 共用 Prisma client：`prisma generate` 只在 §8.1 那一次。
- 小程序改动要在开发者工具里看必须合到 main（工具读主仓磁盘）——这是店主的事，执行方只保证 worktree 内的验收与截图。
- 提交信息中文，署名用真实模型（`Co-Authored-By: Claude <模型名> <noreply@anthropic.com>`）。

---

## 9. 待店主确认（有默认值，不阻塞开工；执行按默认值做，店主改口再调）

| # | 问题 | 默认值 |
|---|---|---|
| Q1 | 同城免运费档位带公里限制（`maxKm < radiusKm`）时，进度提示是否要带「（5 km 内）」说明？ | **带**（不带会让远处顾客以为买够就免运费）。 |
| Q2 | 购物车 tabBar 页要不要也加一行进度提示（T9）？预览「做/不做」表里写在「不做」列括号内，语义有歧义。 | **做**（同一个纯函数，成本低；分类页有提示、购物车页没有会显得前后不一）。店主说不做就裁掉 T9。 |
| Q3 | 结算页底栏「已优惠 ¥X」小字（预览 ④ 有）做不做？ | **做**。 |
| Q4 | 活动条「详情」用系统弹窗（`wx.showModal`）而不是自定义底部弹层？ | **系统弹窗**（本批不新增弹层组件）。 |
| Q5 | 邮寄结算条只统计勾选行（与购物车页「合计」一致），未勾选的不计入件数与金额？ | **只统计勾选行**。 |
| Q6 | 已达一档且还有更高档、同城又已免运费时，第二段显示「已免运费」而不是「再买 ¥X 可减 ¥Y」？ | **显示已免运费**（一行只放一个第二段，免运费优先；预览三态就是这样）。 |
| Q7 | 活动条文字用后台配置的活动名（默认「全店满减」）还是固定「满减」？ | **用活动名**。 |

---

## 10. 上报触发条件（命中任一，执行方停下、写明现象与位置，不自行绕过）

- R1 需要改 `apps/server/**` 或 `apps/admin/**` 才能完成任一验收项。
- R2 某接口拿不到方案假定的字段：`/local/meta.promotion`、`/local/meta.fee.freeShipTiers`、`/local/quote.promoDiscountFen`、`/express/quote.promoDiscountFen`、`/local/promo-preview` 四项任一在本地服务端实测缺失或形状不同。
- R3 发现除 §4.1 `composePay` 之外还必须在小程序里本地算满减（例如需要从 `tiers` 取档）。
- R4 邮寄购物车数据源与同城不兼容、需要改购物车页结构（超出 T9 的一行提示）或改 `pages/cart` 的结算跳转。
- R5 按 §4.4 尺寸做出来的结算条：按钮点击区 < 32px，或 320 宽下文字放不下（C7）。
- R6 真机（店主反馈）上 `cart-spacer` 占位方案仍无效（滚不到最后一件）。
- R7 真机上结算条与原生 tabBar 之间出现空白（`env(safe-area-inset-bottom)` 在 tabBar 页非零）——这是设计取舍（去掉安全区还是保留），不擅自改。
- R8 与已确认预览有任何需要取舍的偏离（位置、文案、三态、颜色以外的结构差异）。
- R9 需要改白名单（§7）外任何文件，包括既有测试文件。
- R10 `npm install` 后 `acorn` 仍不可用，且主仓路径 `node /Users/yumingyi/food-shop/scripts/check-miniapp-es5.mjs` 也跑不了（两条路都断才上报）。
- R11 `utils/local-checkout-state.js` 的 `checkoutAction` 需要新增状态才能表达同城外送的满减未知态（方案假定不需要）。

---

## 11. 执行记录（01 执行方追加）

（留空：每个 T 的提交 sha、B4 量到的旧条高度、A11/A12 的三组输入输出、与方案的偏离逐条说明。）
