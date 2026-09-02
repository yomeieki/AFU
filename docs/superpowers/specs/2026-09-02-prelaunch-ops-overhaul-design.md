# 上线前整改方案：支付/退款/售后闭环 + 手机端商家后台 + 顾客端体验

## Context

真机一分钱支付跑通后，用户提出 8 个前端/流程问题；本轮做了全流程审计，又发现一批会直接影响运营的问题（未付款订单永不自动取消且锁库存、顾客取消后微信付款成功会被静默吞掉、已发货订单永不完成、手机后台看不到买家备注/不能拨号、首页断网骨架屏卡死、seed 会把生产后台密码重置回 admin123456 等）。

已与用户确认的决定：
- 商家管理手机端：**小程序 web-view 内嵌现有网页后台**（自动登录），不做原生精简版。
- 配送方式：**只有快递**，不做同城/自提（但快递公司要可选「其他」手填）。
- 售后：**顾客在小程序申请售后**（原因 + 说明 + 照片≤3 张，**不填期望金额**），店员后台审核并定金额，走部分退款。
- 分类页：**左侧分类栏 + 右侧商品**。
- 未付款 **15 分钟**自动取消；发货后 **7 天**自动确认收货，后台加「标记完成」。
- 顾客端 **订阅消息**（发货通知 / 退款通知）本轮做。
- 附加项全部纳入：地址省市区选择器 + 导入微信地址；后台按手机号/姓名搜订单 + 一键拨号 + 手机版显示备注；后台列表自动刷新 + 未接单 15 分钟企微催单 + 库存预警推送；多规格「¥xx 起」+ 规格库存。

工作分 5 个里程碑，每个可独立提交与验证，按上线阻塞度排序。

---

## M1 服务端：订单生命周期 + 退款/售后模型（阻塞项优先）

### 1.1 数据模型（新迁移 `20260903xxxxxx_lifecycle_aftersale`）
- `Order` 新增：`refundedAmount Int @default(0)`（已成功退款累计，分）、`acceptRemindedAt DateTime?`（催单已发）、`autoCompletedAt` 不必，复用 `completedAt`。
- `Refund` 新增：`afterSaleId Int?`；**语义调整**：`activeOrderId` 仅在 PENDING/PROCESSING/ABNORMAL 保持 = orderId，**SUCCESS 时置 NULL**（允许同一订单多次部分退款，仍保证同一时刻只有一笔在途）。`finalizeRefundSuccess` 同步 `order.refundedAmount += amount`；仅当本次退完剩余全款（`refundedAmount === actualAmount`）才把订单 REFUNDING→REFUNDED，部分退款订单状态不变。
- 新表 `AfterSale`（售后单）：`id, orderId, orderNo, userId, reason(VarChar32: SHORTAGE 少发/WRONG 错发/DAMAGED 变质破损/OTHER), description Text?, images Json, status(PENDING/APPROVED/REJECTED/DONE), reply VarChar255?, refundId Int?, handledBy, handledAt, createdAt, updatedAt`；`@@index([orderId])`, `@@index([status])`。同一订单同时只允许一条 PENDING。

### 1.2 退款服务抽取 `services/refund.ts`
- 把 `routes/admin/orders.ts` 的 `POST /:id/refund` 主体抽成 `initiateRefund({ orderId, amount, reason, operator, afterSaleId? })`，供 admin 路由、售后审核、迟到支付自动退款三处复用。
- 规则：`0 < amount <= actualAmount - refundedAmount`；`isFull = amount === 剩余`。全额：订单→REFUNDING、未发货回滚库存（现有逻辑）；**部分**：订单状态不变、不回滚库存。允许状态：PAID/PREPARING/SHIPPED/**COMPLETED**（新增）/REFUNDING（重试）。
- 保留 mock 分支与 `activeOrderId` P2002 并发防线。

### 1.3 定时任务 `services/scheduler.ts`（`app.ts` 启动后 `setInterval` 60s，PM2 单实例 fork 已确认）
- **超时取消**：`PENDING_PAYMENT && createdAt < now-15min` → 逐单事务 `updateMany(where status=PENDING_PAYMENT)` + `rollbackOrderStock` + `cancelReason='超时未支付自动取消'`；若 `payment.outTradeNo` 存在，best-effort 调新增 `closeOrder(outTradeNo)`（`POST /v3/pay/transactions/out-trade-no/{no}/close`，加入 `services/wechat-pay.ts`）。
- **自动收货**：`SHIPPED && shipment.shippedAt < now-7d` → COMPLETED + completedAt。
- **催单**：`PAID && paidAt < now-15min && acceptRemindedAt IS NULL` → `notifyAcceptReminder`（新增到 `order-notify.ts`）并写 `acceptRemindedAt`。
- **库存预警推送**：每 12h 一次（内存时间戳），上架且 stock≤5 的商品列表推企微群（复用 `pending-count` 的阈值常量，抽到 `utils/constants.ts`）。
- 常量 `PAY_TIMEOUT_MIN=15`、`AUTO_COMPLETE_DAYS=7` 放 `config.ts`（可 env 覆盖）。

### 1.4 支付边界
- `createJsapiOrder` 增加 `time_expire = order.createdAt + 15min`（`YYYY-MM-DDTHH:mm:ss+08:00`）。
- `POST /orders/:id/pay`：`createdAt` 超 15min 直接 42204「订单已超时，请重新下单」。
- 顾客取消待付款订单（`PUT /orders/:id/cancel`）也 best-effort `closeOrder`。
- `wechat-notify.ts`：订单已 **CANCELLED** 却收到支付成功 → 写 payment SUCCESS、订单置 REFUNDING（`cancelReason='超时取消后付款，自动退款'`）、调 `initiateRefund` 全额、`notifySystemAlert`。不再静默返回。
- 修 `payment.outTradeNo` 被重复点支付覆盖的问题：`/pay` 若已有 PENDING payment 且未超时，复用原 `outTradeNo/prepayId` 不再新建。

### 1.5 接口增改
- 用户端：
  - `GET /orders`、`GET /orders/:id` 返回 `payExpireAt`（PENDING_PAYMENT 时）、`refundedAmount`、`latestRefund{status,amount}`、`afterSale{status,reply}`；`/:id` 附 `refunds` 列表。
  - `POST /orders/:id/after-sale`（SHIPPED/COMPLETED，无 PENDING 售后单）、`GET /orders/:id/after-sale`。
  - `POST /upload`（用户态，复用 `admin/upload.ts` 的 multer+COS 逻辑抽成 `services/upload.ts`；限 3MB、每用户每分钟 10 次 `rate-limit`）。
  - `POST /orders` 支持 `directItem {productId, skuId?, quantity}` 与 `cartItemIds` 二选一（修「立即购买」与购物车合并的问题），下单校验/扣库存复用同一段代码（抽 `buildOrderLines()`）。
- 管理端：
  - `GET /admin/orders?keyword=` → `OR(orderNo contains, receiverName contains, receiverPhone contains)`；列表附 `remark`、`refundedAmount`、`afterSale`（PENDING 的）。
  - `POST /admin/orders/:id/complete`（SHIPPED→COMPLETED）。
  - `POST /admin/orders/:id/refund` 改走 `initiateRefund`，schema `amount` 任意正整数（服务端校验剩余）。
  - `GET /admin/after-sales?status=`、`POST /admin/after-sales/:id/approve {amount, reply?}`（→ initiateRefund，成功则 APPROVED，回调成功→DONE）、`POST /admin/after-sales/:id/reject {reply}`。
  - `pending-count` 增加 `afterSaleCount`。
  - `POST /admin/webview-code`（admin token → 60s 一次性码，内存 Map）、`POST /admin/login/webview {code}` → token（公开路由，走 `loginLimiter`）。
- 订阅消息：`services/wechat-access-token.ts`（`cgi-bin/token` 缓存，提前 5 分钟刷新）+ `services/subscribe-message.ts`（`subscribe/send`，43101/43104 等静默忽略并 warn）。模板字段映射放 `config/subscribe-templates.ts`（模板 ID 从 env `WECHAT_TMPL_SHIP` / `WECHAT_TMPL_REFUND` 读，字段 key 待用户选定模板后填）。触发点：发货成功（`/ship`）、退款成功（`finalizeRefundSuccess`）。
- `order-notify.ts` 新增：`notifyAfterSaleRequest`、`notifyAcceptReminder`、`notifyLowStock`。

### 1.6 Seed 修复
- `prisma/seed.ts`：admin upsert 的 `update` 不再覆盖 `passwordHash`；演示商品/分类仅在 `NODE_ENV !== 'production'` 且表为空时写入；不打印密码。

---

## M2 网页后台（apps/admin）

- **RefundDialog 重写**：第一步 = 原因单选胶囊「缺货 / 客户取消 / 协商退款 / 其他」（其他展开文本框）+ 金额输入框 + 「全额」按钮（填入剩余可退）+ 展示「实付 / 已退 / 本次退 / 退后订单：取消 或 继续」；第二步 = 红色确认，须重新输入与第一步一致的金额。文案不再写死「全额原路退回」。允许 COMPLETED 订单进入。
- **发货弹窗**：快递公司改 `<select>`（顺丰速运/京东物流/中通/圆通/韵达/申通/极兔/邮政EMS/德邦/**其他**），选「其他」显示文本框；提交合并为字符串，服务端不变。
- **Orders.tsx**：搜索框改「订单号/姓名/手机号」→ `keyword`；收货人手机显示为 `tel:` 链接 + 复制；手机卡片展开区显示 `买家备注`、`已退 ¥`、售后待处理标签；SHIPPED 加「标记完成」；30s 自动刷新（`document.visibilityState==='visible'` 且无弹窗打开时）；新增「售后」Tab（列表来自 `/admin/after-sales`，行内「同意退款」打开 RefundDialog 预填、「拒绝」弹回复框；图片可点大图）。侧栏/铃铛徽标加 afterSaleCount（`usePendingOrders.ts`）。
- **Banner 裁剪**：新增依赖 `react-easy-crop`；`ImageUploader` 加 `aspect?: number` 属性，设置时选图后先弹 `CropModal`（默认居中、可拖动缩放、固定比例）→ canvas 输出 1500×600 JPEG 0.85 再走现有 `compressImage`/上传。`Banners.tsx` 传 `aspect={2.5}`，提示文案改「建议 750×300，上传后可裁剪」。小程序 `banner-swiper` 300rpx/750rpx = 2.5 与之一致。
- **web-view 自动登录**：新路由 `/m`（`App.tsx`），读取 `?code=` → `POST /admin/login/webview` → 写 `useAuthStore` → `navigate('/orders', replace)`；失败跳 `/login`。`public/` 预留放微信业务域名校验文件（用户提供后放入）。
- 已知限制记入文档：web-view 内 `<a download>`（二维码下载）无效，提示「长按图片保存」。

---

## M3 小程序顾客端（apps/miniapp）

- **分类页** `pages/product/list`：改为左侧 `scroll-view` 分类栏（含「全部」，高亮当前）+ 右侧 `scroll-view` 商品列表（`bindscrolltolower` 翻页）；顶部保留搜索；搜索时右侧显示搜索结果并清除分类高亮。首页分类点击仍走 `globalData.pendingCategoryId`，本页 `onShow` 消费后选中对应分类。`list.json` 标题改「分类」。
- **待付款倒计时**：订单列表/详情根据 `payExpireAt` 显示「剩余 mm:ss 自动取消」，到 0 自动刷新；详情页 `enablePullDownRefresh` + `onPullDownRefresh`；支付轮询改 12 次、单次失败继续轮询；`wx.requestPayment` 成功后 toast 改「支付成功，正在确认…」。
- **下单前订阅消息**：`onPay` 点击处理器内先 `wx.requestSubscribeMessage({ tmplIds: config.subscribeTmplIds })`（完成回调里再发起支付；模板 ID 放 `config/index.js`，为空时跳过）。
- **订单列表**：加「退款/售后」Tab（`REFUNDING,REFUNDED`）；`onReachBottom` 翻页 + 下拉刷新；卡片显示「已退 ¥x」/「售后处理中」。
- **订单详情**：显示退款信息块（已退金额、状态、原因 = `cancelReason`）；时间线修正：商家发起退款显示「商家退款」而非「申请退款」；已发货订单退款保留「已发货」节点；取消显示原因；REFUNDING 且退款失败/异常显示「退款处理中，如有疑问请联系商家」；「联系商家」按钮所有状态可见；SHIPPED/COMPLETED 且无进行中售后时显示「申请售后」。
- **售后申请页** `pages/order/after-sale`：原因单选（少发/错发/变质破损/其他）+ 说明（≤200 字）+ `wx.chooseMedia` 最多 3 张 → `POST /upload` → `POST /orders/:id/after-sale`；详情页展示售后状态与店员回复。
- **地址编辑**：省市区改 `<picker mode="region">`；顶部加「导入微信地址」按钮（`wx.chooseAddress`，失败/拒绝静默）；占位符改四川示例；手机号前端正则校验。
- **立即购买**：`product/detail.js` 改为携带 `productId/skuId/quantity` 跳 `order/confirm?mode=direct`，确认页按 `mode` 调 `createOrder({ directItem })`。
- **多规格价格**：列表/首页/详情 `hasSkus` 时价格后加「起」；`sku-popup` 已有 stockLabel，确认选中规格时显示该规格库存（现有代码已按 sku 计算，补文案「该规格剩 N 份」）。
- **健壮性**：首页 `loadData` catch 置 `loading:false` 并 toast；确认页 `loadData` 加 catch + 失败禁用提交；`pages/merchant/index` 删除「开发环境 Wi-Fi」提示。
- 预览台 `tools/miniapp-preview/pages/*.html` 同步改动的页面镜像（product-list、order-list、order-detail、address-edit，新增 after-sale）。

---

## M4 小程序商家端：web-view 内嵌后台

- `pages/merchant/index`：登录后调 `POST /admin/webview-code` 拿一次性码，`redirectTo` 新页 `pages/merchant/webview`（`<web-view src="{{adminUrl}}/m?code=xxx">`）；失败回登录页。保留 `merchant/login` 原生登录页与「退出商家登录」（放在登录页/我的页）。
- `config/index.js` 保留 `adminUrl`（生产 `https://admin.yuegui-hotel.online`）；dev 提示删除。
- 用户待办：公众平台「开发管理 → 业务域名」添加 `admin.yuegui-hotel.online`，校验文件放 `apps/admin/public/` 随构建部署。

---

## M5 文档与部署

- `.env.example` 新增：`WECHAT_TMPL_SHIP`、`WECHAT_TMPL_REFUND`、`PAY_TIMEOUT_MIN`、`AUTO_COMPLETE_DAYS`。
- `docs/order-flow.md`（状态图加 COMPLETED→退款、部分退款、售后、自动取消/自动收货）、`docs/staff-guide.md`（退款/售后/发货新流程、手机后台入口）、`docs/miniapp-release-checklist.md`（业务域名、订阅消息模板、用户待办）、`docs/api.md`。
- `scripts/e2e.sh` 扩展：超时取消（临时把 `PAY_TIMEOUT_MIN=0` 启动或提供 `POST /admin/system/run-scheduler` 仅非生产）、部分退款两次 + 超额被拒、售后申请→同意→DONE、`keyword` 搜索、`complete`、`directItem` 下单、webview-code 换 token。

---

## 关键复用
- `utils/order-stock.ts rollbackOrderStock`（取消/全额退款回滚）
- `services/refund.ts finalizeRefundSuccess/mark*`（保留，扩展 refundedAmount）
- `services/notify.ts notifySystemAlert`、`services/order-notify.ts` 推送格式
- `middlewares/rate-limit.ts loginLimiter/payLimiter`
- admin `ui/Modal、Button、ConfirmDialog、Toast、Table mobileCards`、`hooks/usePendingOrders`
- miniapp `utils/request.js`、`utils/format.js formatPrice/formatStock`、`components/order-status-tag`、`utils/contact.js callShop`

## 用户侧待办（代码之外）
1. 公众平台配置业务域名 `admin.yuegui-hotel.online` 并把校验文件给我。
2. 公众平台「订阅消息」选 2 个公共模板（发货通知、退款通知），把模板 ID 与字段列表给我。
3. 生产 `.env` 填 `WECHAT_TMPL_*`；部署后 `prisma migrate deploy`。
4. 真机验证：一分钱下单不付等 15 分钟自动取消；一分钱支付→部分退款 0.01；售后申请传图。

## 验证
- `npm run typecheck/build`（server、admin）+ miniapp 静态校验脚本；`bash scripts/e2e.sh` 全绿（本机 PORT=3100、mock 登录/支付）。
- 后台浏览器实测（桌面 + 375px）：退款弹窗全额/部分/超额、发货「其他」快递、售后 Tab 同意/拒绝、keyword 搜索、tel 链接、Banner 裁剪上传、`/m?code=` 自动登录。
- 预览台截图：分类页左右布局、订单列表倒计时/售后 Tab、订单详情退款块、地址页 picker、售后页。
- 定时任务：本机把 `PAY_TIMEOUT_MIN=1` 起服务，下单不付 1 分钟后状态变 CANCELLED 且库存回滚。
- 微信开发者工具真机：web-view 打开后台、订阅消息授权弹窗、`wx.chooseAddress` 导入，由用户目验。
