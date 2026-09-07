# 同城全链路 + 券/积分 审查事实底稿（2026-09-07）

> 用途：代码审查 Workflow 里每个 agent 的**共同起点**。全部是从代码读出来的事实，不含判断。
> 生产版本 `d1ce6d1`（2026-09-07 00:12 部署）。审查范围与排除项见文末。
> 引用格式 `文件:行`，路径相对仓库根。行号是 2026-09-07 `main` 上的，偏几行属正常。

---

## 0. 全局约定

- 金额单位一律**分**（`actualAmount`、`shippingFee`、`discountAmount`、`quotedFee`、`actualFee`、`tipFee`、`cancelFee`、券 `amount`/`threshold`）。快递100 接口的 `discountFee` 是**元**，`kd100.ts` 用 `yuanToFen` 转换。
- 实付公式唯一实现：`computeCheckout({subtotal, discount, shippingFee})` `apps/server/src/services/member/pricing.ts:110-119`，调用点 `routes/orders.ts:340`。`actualAmount = 券前小计 − 券抵扣 + 运费`。运费/起送/免运按**券前小计**判定（`orders.ts:242,326-338`）。
- 时间列一律 UTC（`docs/database.md` §3.10）；后台与小程序按 Asia/Shanghai 渲染。
- scheduler 每 60 秒一跳（`services/scheduler.ts:85-115`），模块级 `running` 标志防重入，已在跑时新调用直接 `return {}`（`scheduler.ts:37,81-83,125-127`）。e2e 大量显式调 `POST /admin/system/run-scheduler`。
- `Delivery.activeOrderId` 唯一索引（`schema.prisma:524`）= 一张订单同时只能有一张在途配送单；店员双击呼叫撞索引返 `42228`（`orchestrator.ts:179-183`）。
- 熔断 `isCircuitTripped()` 是**进程内存态**，重启复位（`services/delivery/circuit.ts:2-3`）；被熔断时 `callRider` 直接抛 `42232`。
- 所有对快递100 的外呼**都在事务外**（`orchestrator.ts:2-3` 文件头铁律）；回调处理的通知放在 `after[]` 里事务提交后才执行（`callback.ts:83`）。

---

## 1. 顾客侧链路（S1 + S2）

| # | 步骤 | 小程序 | 服务端 |
|---|---|---|---|
| 1 | 进同城页，拉 meta | `apps/miniapp/pages/local/index.js:70-86` | `GET /local/meta` `routes/local.ts:20-26` → `publicLocalMeta()` `services/local-settings.ts:506-524` |
| 2 | 拉分类/商品 `channel=LOCAL` | `local/index.js:88-104,133-170` | `routes/categories.ts`、`routes/products.ts` |
| 3 | 加购物车（先取详情再弹 SKU 面板） | `local/index.js:176-238` | `POST /api/cart` `routes/cart.ts`（channel 由商品决定） |
| 4 | 去结算 | `local/index.js:324-329` → `/pages/local/confirm` | — |
| 5 | 结算页加载购物车 + 地址 | `local/confirm.js:139-154` | `GET /api/cart`、`GET /api/addresses` `routes/addresses.ts:38-49` |
| 6 | 地图选点 `wx.chooseLocation`（GCJ-02，×1e6 取整） | `pages/address/edit.js:113-155`（`:123-124`） | `POST/PUT /api/addresses` 坐标成对校验 `addresses.ts:24-32,80-87` |
| 6b | 导入微信收货地址 `wx.chooseAddress`（无坐标） | `address/edit.js:206-232` | 同上 |
| 7 | 地址编辑页内联报价条（**直连 `wx.request`**，不走 `utils/request`，只传坐标不传 addressId，不签 token） | `address/edit.js:164-198`（注释 `:161-163`） | `POST /api/local/quote` `local.ts:39-96`（匿名报价不签 token `local.ts:85`） |
| 8 | 结算页报价（500ms 防抖，`_quoteSeq` 序号防旧结果覆盖） | `local/confirm.js:156-247`（`refreshQuote`）、`:255-262` | 同上 |
| 9 | 服务端查价：真实道路距离优先（快递100 `batchPrice`），失败退回直线×1.7；签 `quoteToken`（HMAC，TTL `QUOTE_TTL_MS` 15 分钟 `local-settings.ts:19`） | — | `local.ts:57-91`；`services/delivery/quote.ts:59-94`（`measureRoadDistanceM`）；纯计算 `local-settings.ts:377-413`（`haversineM`/`billableDistanceM`/`calcLocalFee`）；签名 `local-settings.ts:460-503` |
| 10 | 结算页展示（起送/免运/营业时段/券/赠品） | `local/confirm.js:17-40`、`components/checkout-benefits/index.js` | 数据来自 `/local/quote` + `/local/meta` + `/member/checkout-options` |
| 11 | 提交订单（先 `requestSubscribe` 再 `doSubmit`） | `local/confirm.js:392-432`；**报价陈旧阈值前端硬编码 `10*60*1000`** `confirm.js:398` | `POST /api/orders` `routes/orders.ts:134-455`（LOCAL 分支 `:248-324`） |
| 12 | 跳订单详情并自动拉起支付 `autopay=1` | `confirm.js:422-427`、`pages/order/detail.js:331` | — |
| 13 | 发起支付 | `order/detail.js:476-526` | `POST /api/orders/:id/pay` `orders.ts:828-923` |
| 14 | 微信支付回调 | — | `routes/wechat-notify.ts:120-313` |
| 15 | 轮询支付结果（1.5s × 12 次，最长 18s） | `order/detail.js:528-` | `GET /api/orders/:id` `orders.ts:558-612` |
| 16 | 支付后：企微/PushPlus 推送、订阅消息、打印入队 | — | mock 路径 `orders.ts:868-880`；真实回调 `wechat-notify.ts:253-298`；`services/order-notify.ts:145`、`services/subscribe-message.ts`、`services/ticket/index.ts:239`（`enqueueOrderTicket`） |
| 17 | 顾客 5 分钟内申请取消（接单后） | `apps/miniapp/api/order.js:39` | `POST /api/orders/:id/cancel-request` `orders.ts:616-656`；窗口 `cancelWindowOf` `orders.ts:82-90`，`acceptGraceMin` 默认 5 `local-settings.ts:113` |
| 18 | 顾客自助取消 | — | `PUT /api/orders/:id/cancel` `orders.ts:693-770` |
| 19 | 顾客「确认收货」 | 仅 `!order.isLocal` 渲染 `order/detail.wxml:280` | `PUT /api/orders/:id/confirm` LOCAL 直接 `42204` `orders.ts:670` |
| 20 | 顾客看骑手位置 | `order/detail.js:436-465` | `GET /api/orders/:id/courier` `orders.ts:544` → `courier-location.ts:67-73` |

### 1.1 服务端校验（错误码）

`POST /local/quote`（`local.ts:39-96`）：未开通/门店无坐标 `42226`；带 addressId 未登录 `40101`；地址不存在/不属于本人 `40401`；地址无坐标 `42223`；zod `addressId` 或 `latE6+lngE6` 二选一 `:35-37`；限流 `localQuoteLimiter`。

`POST /api/orders` LOCAL（`orders.ts:134-455`）：购物车/立即购买二选一 `:119`；商品存在/上架/渠道匹配 `:170-180`（渠道不符 `42224`、下架 `42202`、库存不足 `42201`）；地址归属 `:183-186` `40401`；总开关/暂停 `42226`、非营业 `42222`、缺坐标 `42223` `:249-254`；**quoteToken 信任边界** `:255-296`：签名失效/过期/addressId 或坐标不符 `42239`，门店坐标变更 `42227`，超范围 `42220`，未达起送 `42210`，件数/重量超限 `42230`，重算运费比凭证贵 `42227`；券预检 `loadCouponForOrder` `member/checkout.ts:201-219`（统一 `42251`）；赠品 `loadGiftLines` `checkout.ts:230-301`（`42252/42202/42224/42201/42250`）；`actualAmount===0` 拒单 `42251` `:343`；事务 `prisma.$transaction(…, {timeout:15000})` `:366-437`；库存 `updateMany stock>=quantity` 判 count `:405-427`；券/积分/赠品名额条件更新 `applyOrderBenefits` `checkout.ts:310-357`。

`POST /orders/:id/pay`（`orders.ts:828-923`）：已支付 `42203`；非 `PENDING_PAYMENT` `42204`；已超时 `42209`；mock 支付 `updateMany` 条件写判 count `:862-866`；真实支付复用未过期 `prepay_id`；无 openid `40101`。

`POST /orders/:id/cancel-request`（`orders.ts:616-656`）：已申请/窗口外 `42229`；`updateMany where status=PREPARING, cancelRequestedAt=null` 判 count。

`PUT /orders/:id/cancel`（`orders.ts:693-770`）：`PENDING_PAYMENT` 条件写→回滚库存→`releaseOrderBenefits`；`PAID` 且 `acceptedAt=null` 条件写转 `REFUNDING`，count=0 → `42204`。

`wechatPayNotifyHandler`（`wechat-notify.ts:120-313`）：验签/解密失败各自 reply；非 `PENDING_PAYMENT/CANCELLED` 直接 return `:150`；金额不符 `AmountMismatchError` + 告警 `:152-157,300-305`；**条件写守卫（b6fd384）** `:205-234`：`wasCancelled` 与正常 `PENDING_PAYMENT→PAID` 都 `updateMany` 判 count，抢输方落 `lateCancelled` 自动全额退款。

### 1.2 Order.status 状态机

取值：`PENDING_PAYMENT / PAID(待接单) / PREPARING / SHIPPED / COMPLETED / CANCELLED / REFUNDING / REFUNDED`（`schema.prisma:225`）。

| 转换 | 位置 |
|---|---|
| `PENDING_PAYMENT → PAID` | mock `orders.ts:862-866`；微信回调 `wechat-notify.ts:217-220` |
| `PENDING_PAYMENT → CANCELLED` | 顾客 `orders.ts:705-709`；超时 `scheduler.ts:143-146`；商家 `admin/orders.ts:582-583` |
| `PAID → PREPARING` | 邮寄接单 `admin/orders.ts:212-214`（LOCAL 拒 `:211`）；同城接单 `admin/delivery.ts:36-43,50`（同时 `kickOffQuote` `:56`） |
| `PAID → REFUNDING` | 顾客取消已付未接单 `orders.ts:729-732` |
| `CANCELLED → REFUNDING` | 回调判「取消后仍付款」`wechat-notify.ts:207-210,227-231` |
| `PREPARING → SHIPPED`（LOCAL） | 回调 310 `callback.ts:184`；自送 `orchestrator.ts:472` |
| `SHIPPED → PREPARING`（LOCAL 回退） | `rollbackOrderAfterCancel` `orchestrator.ts:345-354`（三重护栏：`status='SHIPPED' && completedAt=null && 无在途退款 && 无 PENDING/APPROVED 售后`），720 回调与主动取消共用 |
| `PREPARING/SHIPPED → COMPLETED`（LOCAL） | 回调 520 `callback.ts:197`；标记送达 `orchestrator.ts:488`；兜底 `delivery/tasks.ts:296-326` |
| `SHIPPED → COMPLETED`（EXPRESS） | 顾客确认 `orders.ts:659-686`；商家 `admin/orders.ts:288-307`；自动 `scheduler.ts:165-182` |
| `REFUNDING → REFUNDED` | `admin/orders.ts:445-447` |

LOCAL 特有字段写入：`shippingFee` `orders.ts:380`；`receiverLatE6/LngE6/PoiName/distanceM/distanceSource/estimatedDeliveryAt` 来自已验证 token `orders.ts:244-247,312-324,391`；`quoteSnapshot/quotedAt` 接单后异步 `quote.ts:114-167`（`refreshOrderQuote`/`kickOffQuote`，两道写入守卫：`status:'PREPARING'` + `quotedAt` 单调 `quote.ts:158-166`），顾客侧接口剥离 `orders.ts:59-76`；`cancelRequestedAt/Note/DeliveryStatus` `orders.ts:634-638`；`couponId/discountAmount/pointsUsed` `orders.ts:392-394`；`pointsEarned/pointsSettledAt/pointsBase` `points.ts:227-306`。

### 1.3 客户端复刻的公式

- LOCAL 结算页**不**复刻距离/运费（`local-settings.ts:5-7`），`payAmount` 直接用 `quote.fee` `confirm.js:218,386`。
- EXPRESS 结算页 `pages/order/confirm.js:97-133` 复刻 `calcShippingFee`（注释 `:95-96` 承认必须同步）。**审查范围外**（邮寄独有页）。
- `checkout-benefits/index.js:254-262` 复刻 `calcEarn`（「预计得分」），b6fd384 曾因漏加运费出真 bug。`discount` 不复刻，取 `/member/checkout-options`。

### 1.4 超时关单与并发

- `cancelExpiredOrders` `scheduler.ts:132-162`：逐单事务内 `updateMany where status=PENDING_PAYMENT` 判 count → 回滚库存 → `releaseOrderBenefits`；`BATCH=100`。
- e2e §39 `scripts/e2e.sh:2216-2239` 真并发 pay+cancel，断言「赢家自洽」不断言谁赢。

---

## 2. 商家侧与配送链路（S3 + S4）

| # | 步骤 | 后台/小程序 | 服务端 |
|---|---|---|---|
| 1 | 支付成功 → 出票入队 + 推送 | — | `orders.ts:878` / `wechat-notify.ts:296` 各自 `enqueueOrderTicket(id,'NEW_ORDER')`；`notifyOrderPaid` `order-notify.ts:145` |
| 2 | 打印/催单/健康 | 工作台顶栏 `ticket/index.ts:1133` | `enqueueOrderTicket:239`、`attemptSend:356/362`、`processQueue:493`、`repeatAnnounce:611`、`printerHealthTask:1028` |
| 3 | 接单 | `apps/admin/src/pages/Workbench.tsx:1066-1074` | `POST /admin/local/orders/:id/accept` → `doAccept` `admin/delivery.ts:36-43`，`kickOffQuote` `:56` |
| 4 | 呼叫骑手 / 接单并呼叫 | `Workbench.tsx:1077-1094` | `POST …/call` `admin/delivery.ts:82-89` → `callRider` `orchestrator.ts:125-302`；策略 `resolveCallProviders:84-123`；外呼 `kd100.ts:141-174`（`batchOrder`，`kuaidiComList`=被呼列表） |
| 5 | 快递100 回调（公开路由） | — | `POST /api/kd/:deliveryNo` `routes/kd-callback.ts:7-17` → `handleKdCallback` `callback.ts:19-233` |
| 6 | 3 分钟无人接自动升级 | — | `escalateSoloCalls` `tasks.ts:185-254`，`scheduler.ts:94` 注册，排在 `localAutoCall` 之前 |
| 7 | 骑手位置 | `Workbench.tsx` 抽屉；小程序 `order/detail.js:436-465` | `GET /admin/local/orders/:id/courier` `admin/delivery.ts:190-213`；顾客 `orders.ts:544`；共用 `courier-location.ts:67-73` |
| 8 | 到店/取货/配送中 | 徽标 | 回调 210/230/310 `state.ts:12-14`；310 额外 Order→SHIPPED + 配送订阅消息 `callback.ts:183-195` |
| 9 | 520 送达 | — | `callback.ts:196-200`：Order→COMPLETED + `settlePoints` fire-and-forget |
| 10 | 店员取消呼叫 | `Workbench.tsx:1422` `CancelDeliveryModal` | `precancelDelivery`/`cancelDelivery` `orchestrator.ts:356-406` |
| 11 | 720 撤单 | — | `callback.ts:201-218` → `rollbackOrderAfterCancel` |
| 12 | 店员处理取消申请 | 同意：`components/CancelAndRefundModal.tsx`；**驳回：仅后端路由 + e2e，`apps/admin/src` 无调用** | 驳回 `POST …/cancel-request/reject` `admin/delivery.ts:95-117`；同意 = `cancelDelivery` + `initiateRefund` |
| 13 | 含配送费退款 | `RefundDialog.tsx` / `CancelAndRefundModal.tsx:72-82` | `initiateRefund` `services/refund.ts:80-284`；`finalizeRefundSuccess` `refund.ts:311-390` |
| 14 | 自送 / 标记送达 | 工作台 | `selfDeliver` `orchestrator.ts:461-476`；`markDelivered` `:483-493` |

### 2.1 Delivery 状态机（`state.ts:1-19`）

`PENDING(0) → CALLING(10) → ACCEPTED(20) → ARRIVING(30) → ARRIVED(40) → DELIVERING(50) → DELIVERED(100)`；旁路 `REASSIGNING`(515)、`ABNORMAL`(510) 不占 rank（`callback.ts:119-122`）；终态 `TERMINAL=[DELIVERED,CANCELLED,FAILED]`（`state.ts:5`）；`UNKNOWN` = 下单超时占位。
- rank 单调：`updateMany where statusRank<mapped.rank && status notIn TERMINAL` `callback.ts:106-110`；`moved===0` 静默丢弃迟到包 `:136`。
- 唯二回拨：`REASSIGNING` 收 100 → `ACCEPTED`（N8 `callback.ts:112-115`）；720 回退的是 **Order** 不是 Delivery。
- `Delivery.callStrategy` ∈ `SOLO | ALL | MANUAL | SOLO_HELD`（`orchestrator.ts:52`）；`SOLO_HELD` 只由升级任务写。
- 占位后原子复核 `Order.status/cancelRequestedAt` 不合法即回退 `orchestrator.ts:189-195`。

### 2.2 回调分支（`callback.ts`）

| providerStatus / 情况 | 处理 | 改状态 | 告警 key |
|---|---|---|---|
| 查不到 deliveryNo | 200 留痕 | 否 | `kd:unknown-delivery` `:37` |
| 验签失败 | 200 | 否 | `kd-cb-sign:${deliveryNo}` `:49` |
| 720 且无 `providerTaskId`（未认领） | 200 只留痕，不认领 | 否 | `kd-cb-720-unclaimed:${id}` `:59-67` |
| 720 且 taskId 不匹配（并呼未中标） | 200 留痕忽略 | 否 | `statusRank<20` 才告警 `kd-cb-720x` `:71-76` |
| 未知 status | 200 留痕 | 否 | `kd-cb-unknown:${status}` `:94` |
| 0/100/210/230/310/520 | rank 单调更新 | 是 | `moved===0 && 原 FAILED && rank>=20` → `kd-cb-ghost-active` `:130` |
| 310 | + Order→SHIPPED + 配送订阅消息 | 是 | — |
| 520 | + Order→COMPLETED + `settlePoints` | 是 | — |
| 720（匹配） | CANCELLED + `rollbackOrderAfterCancel` | 是 | `wasShipped&&rolled===0` → `dlv-cb-720-order-stuck` `:212`；恒发 `notifyLocalDeliveryAlert('配送单被取消')` `:217` |
| 515 / 510 | 旁路态 | 是 | `骑手改派中` `:220` / `配送异常` `:219` |
| rank≥20 附带 `actualFee` 认领 | `orderFees` 优先于 `quoteSnapshot` `:161-162` | 附带 | `dlv-fee-drift`（差>50 分 `:166`）、`dlv-actual-fee-miss` `:173` |
| 入库异常（如 UNKNOWN 认领撞唯一索引） | **返 500** 让快递100 重推 | — | `kd-cb-persist` `:228` |

去重：`dedupeKey = CB:${deliveryNo}:${status}:${updateTime ?? md5(rawBody)}`（`events.ts:14-17`），撞 `DeliveryEvent.dedupeKey` 唯一索引直接 return `callback.ts:87`。
nginx：`location /api/kd/` 已 `gzip off`；`kdCallbackLimiter` 被限流时返 200 且 body 成功形状（`middlewares/rate-limit.ts:146-153`）。

### 2.3 升级并呼 `escalateSoloCalls`（`tasks.ts:185-254`）

候选：`status:'CALLING', callStrategy:'SOLO', providerTaskId!=null, calledAt<now-threshold, order.cancelRequestedAt=null`（`:190-201`，**未核对 Order.status**）。三道闸：`threshold<=0` return；熔断中 return；`precancel` 预估取消费>0 → 标 `SOLO_HELD` + 告警「自动升级并呼已放弃」`:207-218`。之后 `getActiveDelivery` 复核仍是同一行 `:224-230` → `cancelDelivery` → `callRider({providers:全表, callStrategy:'ALL'})`；重呼失败告警 `dlv-escalate:${id}`。

### 2.4 scheduler 任务表（`scheduler.ts:85-115`）

| 名 | 函数 | 阈值 | 闸门 |
|---|---|---|---|
| cancelExpired | `cancelExpiredOrders` | `payTimeoutMin` | 无 |
| autoComplete | `autoCompleteShippedOrders`（EXPRESS） | `autoCompleteDays` | 无 |
| remindUnaccepted | 15 分钟 | 常量 | 每单一次 |
| lowStock | 12 小时 | — | 进程内时间 |
| localCallTimeout | `remindCallTimeout` | `callTimeoutMin` 默认 10 | 每单一次 |
| localEscalate | `escalateSoloCalls` | `escalateAfterMin` 默认 3 | `<=0`/熔断 return |
| localAcceptedStuck / localDelivering / localUnknown / localUncalled / localCancelReq | 提醒类 | 30 / 120 / 10 / 10 / 5 分钟 | 每单一次 |
| localQuoteRefresh | `refreshStaleQuotes` | 5 分钟 | `quotedAt` 节流 |
| localAutoCall | `autoCallRiders` | `autoCallDelayMin` 默认 0=手动 | `<=0`/未开通/非营业/熔断 return |
| localAutoComplete | `autoCompleteLocalDelivered` | `autoCompleteDays` 或取货超 `deliveringTimeoutMin×3` | 无 |
| localHousekeeping | 终态占位释放；PENDING 超 10 分钟→FAILED；90 天清 rawPayload | — | 无 |
| printQueueSweep / repeatAnnounce / printerHealth | ticket | `Setting(printer)` | `enabled` |
| settleMissedPoints | 窗口 `[now-7d, now-2min]`，`COMPLETED && pointsSettledAt=null && !isTest` | `scheduler.ts:228-244` | `points.enabled` |
| expirePoints / expireCoupons | 每日一次，200/批 × 50 轮 | `cron-state` | 日切；**无 `points.enabled` 闸门** |

### 2.5 金额字段

| 字段 | 写入 | 为 null 时 |
|---|---|---|
| `Delivery.quotedFee` | 呼叫落库 `orchestrator.ts:240`（并呼取最低预扣；单家取其本身 `kd100.ts:160-166`）= 本单**冻结**的钱 | 未成功落库 |
| `Delivery.actualFee` | 回调 rank≥20 认领 `callback.ts:161-162` | 中标方不在 orderFees/快照，或尚无 rank≥20 回调 |
| `Delivery.tipFee` | `addTip` 原子封顶 `orchestrator.ts:426-429` | 默认 0 |
| `Delivery.cancelFee` | `cancelDelivery` `orchestrator.ts:375`，店家承担，不进顾客退款 | 默认 0 |
| `Delivery.orderFees` | 外呼成功原样存 `fee[]` `orchestrator.ts:241-243`（空数组存 `[]`） | 旧版本历史行 |
| `Order.quoteSnapshot/quotedAt` | `refreshOrderQuote` `quote.ts:114-166` | 未接单/缺坐标 |

退款：`remainingRefundable = actualAmount − refundedAmount`（`refund.ts:43-45`），配送费已含在 `actualAmount`，无单独运费退款逻辑；`CancelAndRefundModal.tsx:75` 全额；`RefundDialog` 手输可部分；`Order.refundedAmount` 用 `LEAST(refunded+amount, actual)` 封顶 `refund.ts:355`。在途配送单挡退款 `42221`。

---

## 3. 优惠券（S5）

- 模板 `CouponTemplate` `schema.prisma:668-690`：`amount/threshold`（分）、`channel ALL|LOCAL|EXPRESS`、`validDays`、`source ADMIN|POINTS|CAMPAIGN|NEWCOMER`、`pointsCost`、`totalLimit`、`perUserLimit`、`issuedCount`、`status ON|OFF`。后台 `routes/admin/coupon-templates.ts:19-38`；无 DELETE 只有停用；`source` 不可改。
- 三条发放路径（`services/member/coupons.ts`）：积分兑换 `redeemByPoints:105-140`；领券中心 `claimCampaign:154-172`；新客券 `issueNewcomerCoupon:180-217`。并发：事务首句 `SELECT … FOR UPDATE` 锁模板行 `:110/:159`；`perUserLimit` 用 `count()`；`totalLimit` 用 `updateMany({issuedCount:{lt:totalLimit}})` 判 count `:122-129/:165-171`。`issueCoupon:52-81` code 冲突重试 3 次；模板 OFF `42254` `:57`。
- 可用筛选**服务端算**（`checkout.ts:49-51`）；门槛比**商品小计**（不含运费）`pricing.ts:44-45`；判定顺序 `NOT_OWNER→USED→EXPIRED→CHANNEL→THRESHOLD` `pricing.ts:55-95`；过期用 `<=` `:73`；`discount=min(amount, subtotal)` `:94`；不可用券带 reason 返回 `checkout.ts:53-55`；排序 `checkout.ts:124-130`。
- 下单：预检 `loadCouponForOrder` `checkout.ts:201-219`（只读）；**真正核销在下单事务内** `applyOrderBenefits` `checkout.ts:310-357`：`updateMany({id,userId,status:'UNUSED'} → USED)` 判 count，0 抛 `42251` `:317-322`。券在**下单那一刻**就 USED，支付回调不碰 `UserCoupon`。
- 释放 `releaseOrderBenefits` `checkout.ts:392-485`，**只服务 `PENDING_PAYMENT→CANCELLED`**（注释 `:369-391`），前提：调用方已条件写 CANCELLED 且 count=1（约定 `:372-376`）。4 个调用点：`orders.ts:713`、`admin/orders.ts:369`、`admin/orders.ts:589`、`scheduler.ts:151`。释放时券已过期 → `EXPIRED` 而非 `UNUSED` `:406-424`；赠品积分写 `GIFT_REVERT` `:428-453`，P2002 冲突把余额减回 `:454-465`；赠品名额 decrement `:469-484`；库存由调用方另调 `rollbackOrderStock`。
- **已支付后一律不释放**（`refund.ts:146-161`）：券不退、赠品积分不退、名额不回落；只按比例扣回积分。
- 过期 `expireCouponsBatch` `coupons.ts:238-249`，每日 `scheduler.ts:114`；只读查询一律按时间实时判定，不依赖任务 `coupons.ts:255,258-266`、`checkout.ts:67-68`。
- 新客券：`newcomer.templateId` `settings.ts:23-26`，保存时校验 `source==='NEWCOMER'` `:111-118`；登录新建 User 后 fire-and-forget（`routes/auth.ts`）；`templateId==null` 直接 return `coupons.ts:184`；死模板走 `notifySystemAlert` 5 分钟去重 `:192-207`；幂等靠两次 `findFirst`，**无 `(userId,templateId,source)` 唯一索引** `:209-216`；`usedAsNewcomer` 实时算 `coupon-templates.ts:73-77,91`，停用被引用模板不拒绝。

---

## 4. 积分（S6）

- `settlePoints` `points.ts:227-306`，4 个调用点（全 fire-and-forget，内部 try/catch 永不抛 `:301-305`）：邮寄顾客确认收货 `orders.ts:680`；同城 520 `callback.ts:196-200`；店员标记送达 `orchestrator.ts:483-493`；兜底 `settleMissedPoints` `scheduler.ts:230-244`。
- **不主动调**的 COMPLETED 路径（靠 2 分钟兜底）：`autoCompleteShippedOrders` `scheduler.ts:165-182`；邮寄 `/complete` `admin/orders.ts:288-307`；`autoCompleteLocalDelivered` `tasks.ts:296-326`。
- 事务：`SELECT … FOR UPDATE` 锁订单行 `:232`（与 `finalizeRefundSuccess` 互斥，注释 `:210-214`）；`enabled` 判在事务前 `:229-230`；`pointsSettledAt!==null` return `:244`；P2002 后仍补写订单标记 `:281-284`；`earn<=0` 仍续期不发分 `:261-269`。
- `calcEarn = floor(max(0, actualAmount−refundedAmount)/100) × ratePerYuan` `points.ts:46-48`，**含运费**；`pointsBase` `:250`。
- 账本类型 `EARN|REDEEM|GIFT|GIFT_REVERT|REFUND_DEDUCT|EXPIRE|ADMIN` `:17`；`remaining` 只入账行有意义；`@@unique([type,refType,refId])` `schema.prisma:661`；`ADMIN` 无写入入口 `schema.prisma:646`。
- 退款扣回 `deductPointsOnRefund` `points.ts:445-487`，调用点 `refund.ts:381-388`（同事务）与 `admin/orders.ts:481-488`（人工 refund-complete，R11）；公式 `calcRefundDeduct` `:61-78` 按累计目标−已扣；只从 `EARN` 行扣，先本单再 FIFO，扣到 0 不负 `:394-423`，`expiresAt>now` `:391-392`。
- 消费 `consumePoints` `points.ts:103-151` FIFO `expiresAt ASC, id ASC`，`updateMany remaining>=take` 判 count `:125-129`，两轮不足 `42250`；调用点 `checkout.ts:325-341`（GIFT）、`coupons.ts:139-144`（REDEEM）。
- 续期 `extendLivePoints` `:186-202` 目标 `max(本单完成+validDays, 现存最大到期)` 只增不减 `:252-259`；过期 `expirePointsBatch` `:322-366` CAS 复核 `expiresAt<now` `:338-345`。
- `points.enabled` 读取点：`settlePoints:229`、`settleMissedPoints scheduler.ts:232`、`loadCheckoutOptions` 只透传 `checkout.ts:160`；**`loadGiftLines`/`applyOrderBenefits`/`redeemByPoints`/`claimCampaign` 不读**；读失败保守 `enabled=false` `settings.ts:41-47`。

---

## 5. e2e 覆盖地图（`scripts/e2e.sh` 2360 行 + `scripts/e2e.d/`）

| 段 | 主题 | 位置 |
|---|---|---|
| §6–9 | 邮寄下单/退款/并发双击退款/人工 refund-complete | e2e.sh |
| §12–13 | 部分退款 / 售后 | e2e.sh |
| §16 | 超时取消回滚库存 / 催单 / 自动收货 | e2e.sh |
| §21 | 同城设置/报价（道路距离 vs 估算、降级、暂停、坐标校验、token） | `e2e.sh:326-416` |
| §22 | 同城下单（42224/42223/42239/42227/42220/42210/42230、取消申请 42229） | `e2e.sh:416-651` |
| §25–31 | 运力 mock / 呼叫三分支 / 回调状态机 / 配送单操作与资金 / 拒单 / 同城定时任务 / 工作台 | `e2e.sh:704-1113` |
| §32 | 报价快照与保鲜 | `e2e.sh:1113-1205` |
| §33 | isTest 隔离 | `e2e.sh:1205-1267` |
| §34 | 顾客端字段契约锁（敏感字段黑名单） | `e2e.sh:1267-1314` |
| §35 | 出票与打印机 | `e2e.sh:1366-1525` |
| §36 | 会员 M1：发分幂等/FIFO/过期/退款扣回/三条发券/限量并发/新客券 | `e2e.sh:1525-` |
| §39 | 下单用券与赠品、未支付取消释放、**pay+cancel 真并发** | `e2e.sh:1913-2269` |
| §48 | 管理端会员四端点、`usedAsNewcomer` | `e2e.sh:2256-2274` |
| §37 | 积分账本一致性 | e2e.sh 尾部 |
| 40 | 退款×积分（B7/B5/H1/M5/H7/B1） | `e2e.d/40-points-refund.sh` |
| 41 | 会员默认值 | `41-member-defaults.sh` |
| 42 | 领券并发 | `42-coupon-concurrency.sh` |
| 43 | 每日任务批量循环（**仅积分**） | `43-daily-task-loop.sh` |
| 44 | 出票核心（含 H6 取消申请→驳回→再申请 `RESUME` 票 `:174-192`） | `44-ticket-core.sh` |
| 45 / 47 | 打印机离线 / 出票复核 | — |
| 46 | 退款积分回归（R3/R6/R10/R11） | `46-group2-refund-points.sh` |
| 49 | 同城单用券六场景 | `49-local-coupon.sh` |
| 50 | 呼叫策略八段（SOLO/升级/不重复升级/SOLO_HELD/actualFee/切 ALL/熔断/已申请取消） | `50-call-strategy.sh` |
| 51 | 配送可见性（报价/中标/实扣/骑手位置/成本合计） | `51-delivery-visibility.sh` |

已知未覆盖：优惠券过期跨批循环；「驳回取消申请后再呼叫不受阻」；720 回退与在途退款/售后护栏同时命中。
已知 flaky：§45 打印机 4 条（与本次无关）；60 秒心跳与手工 tick 撞车会打乱精确条数断言。

---

## 6. 本轮已修的 bug 模式（举一反三的种子）

1. `price()` 的 `callbackUrl` 写成空串 → 每次 `30001` → catch 后静默退回估算（`26677a2`）。模式：外呼参数错但被 catch 吞成默认值。
2. `queryCourier` 传 `taskId` 而接口要 `orderId` → 从未成功过，`location:null`（`806c2a3`）。模式：接口字段名/拼写错误被吞。
3. 支付回调无守卫 `update` 覆盖并发取消（`b6fd384`）。模式：改状态列的无条件 `update({where:{id}})`。
4. 小程序按钮死掉：缺 `chooseAddress` 权限声明、售后传图失败全静默（`34c1446`）。模式：`wx.*` 权限未声明 / `fail` 回调为空。
5. `runSchedulerTick` 重入返回 `{}` 但 HTTP `code 0`，`null` 进算术把 e2e 掐死且退出码 0（`d1ce6d1` 合并）。模式：空对象当成功。
6. 复查修掉的：一个会让店员按错误金额退款的问题（`f24e22d`，读该 commit 看细节）。

---

## 7. 审查范围与排除项

范围：同城单会经过的所有函数（含其邮寄分支）；不看 `admin/orders.ts` 发货、`order/confirm.js` 邮寄结算页、邮寄独有页面。

排除（已知，不要再报）：单家 `batchOrder` 是否被接受、升级并呼是否收 720、precancel→cancel 1 秒竞态；`riderSpeedKmh`=15 是 PO 决定；无 CI/lint；`orders.ts` 臃肿；快递100 无查余额接口；清单 2.4b 隐私表漂移；UptimeRobot 未建；熔断为进程态。

严重度：高 = 资损 / 静默丢单 / 卡单无告警；中 = 金额或状态展示错误、需人工介入才发现；低 = 健壮性、文档漂移、覆盖缺口。

## 8. 探索阶段种子候选（直接进对抗复核）

| # | 候选 | 位置 |
|---|---|---|
| C1 | 后台无「驳回顾客取消申请」入口 | `admin/delivery.ts:95-117` vs `apps/admin/src/api/admin.ts` |
| C2 | 三条 COMPLETED 路径不调 `settlePoints`，靠 2 分钟兜底 | `admin/orders.ts:288-307`、`scheduler.ts:165-182`、`tasks.ts:296-326` |
| C3 | `points.enabled` 不挡积分兑换赠品/换券 | `checkout.ts:230-357`、`coupons.ts:105-172` |
| C4 | 报价陈旧阈值前端 10 分钟 vs 服务端 15 分钟 | `local/confirm.js:398` vs `local-settings.ts:19` |
| C5 | 地址编辑页内联报价直连 `wx.request` | `address/edit.js:164-198` |
| C6 | 客户端复刻 `calcEarn` | `checkout-benefits/index.js:254-262` vs `points.ts:46-48` |
| C7 | `releaseOrderBenefits` 前提靠约定 | `checkout.ts:372-391` |
| C8 | `escalateSoloCalls` 未核对 `Order.status` | `tasks.ts:190-201` |
| C9 | 新客券无唯一索引 | `coupons.ts:209-216` |
| C10 | 券过期无跨批循环 e2e | `e2e.d/43` |
| C11 | 720 回退与退款/售后护栏同时命中无 e2e | `orchestrator.ts:345-354` |
| C12 | 整批并呼若共用 taskId，720 过滤失效 | `callback.ts:59-76` |
