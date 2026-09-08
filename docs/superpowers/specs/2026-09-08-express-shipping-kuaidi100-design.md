# 全国邮寄接快递100「上门取件」：报价、预约取件、轨迹 —— 设计（2026-09-08）

调研依据：`docs/research/2026-09-08-kuaidi100-merchant-shipping-api.md`（接口、状态码、实测价格）。
同城参照：`docs/superpowers/specs/2026-09-03-local-delivery-design.md`、`services/local-settings.ts`、`services/delivery/*`。
本文只定方案，不含实施计划。

---

## 0. 一句话

邮寄渠道照同城的骨架平行再搭一套：顾客填地址那一刻服务端向快递100 查各家快递报价，按**中位数**收顾客运费并签成凭证；店员备货后在工作台**预约快递员上门取件**，取件回调把订单推到「已发货」，轨迹推送落库给顾客看时间线，签收自动完成。现有「填单号发货」保留做兜底。

## 1. 已拍板的产品决策（改动需重新确认）

| 编号 | 决策 |
|---|---|
| E1 | 顾客运费 = 参与定价名单内各家回价的**中位数** + 额外加价（默认 0）+ 向上取整（默认 0.5 元）。回价不足两家退回兜底表。 |
| E2 | 重量 = Σ 商品净重 × 数量 + **每单固定包装附加重量**（默认 800 g）。礼盒重量计入商品净重；商品未填净重用默认净重（300 g）。 |
| E3 | 店员预约时列出全部家的报价，**最便宜那家默认选中并标注**，店员可改；差价店铺承担。 |
| E4 | 预约时段**每次店员手选**（今天/明天/后天 + 起止时间），弹窗预填最近一个还能约的时段。多单各自预约。 |
| E5 | **省级「不寄送」名单**，顾客选到该地区提示不支持并禁止下单。 |
| E6 | **按地区分组的满额包邮门槛**，与不寄送名单共用同一张省份分组表。 |
| E7 | 顾客端一期就做：结算页运费、订单详情预约/接单/取件状态、**物流轨迹时间线**、签收自动完成。 |
| E8 | 邮寄也开「接单后 N 分钟内顾客可申请取消」窗口（默认 10 分钟），走现有取消申请流程。 |
| E9 | 退款政策沿用现状：接单前顾客自助秒退；接单后店员后台发起；取件后只走售后。新增：有活跃预约时全额退款/拒单先取消预约。 |
| E10 | 货物名固定填「食品」。不做保价、不做云打印面单（快递员自己出单）。 |
| E11 | 实现路子 A：独立设置、独立报价服务、独立预约表、独立回调路由；只把快递100 的签名/请求/超时判定抽成共用模块。不动同城的 Delivery 表与调度器。 |

## 2. 后台「邮寄设置」

设置表新 key `express_delivery`，60 秒进程缓存，保存即失效（与同城一致）。页面与「同城配送设置」并列。

```ts
interface ExpressSettings {
  version: number
  // 寄件人不在这里：读 getLocalSettings().store（名称/电话/省市区/地址）
  weight: { packagingG: number /* 800 */; defaultItemG: number /* 300 */ }
  pricingPool: string[]        // 参与定价的 kuaidicom，默认 jtexpress/yuantong/shentong/yunda/zhongtong/jd
  fee: {
    mode: 'QUOTE' | 'TABLE'    // 默认 QUOTE；TABLE = 只用分组兜底表
    markupFen: number          // 0
    roundToFen: number         // 50
    minQuoteCount: number      // 2
  }
  minOrderAmountFen: number    // 起送金额，迁移自旧 shipping.minOrderAmount
  regionGroups: {
    name: string
    provinces: string[]        // 省级行政区全名，一省只能属一组
    freeShipMinFen: number     // 0 = 该组不包邮
    tableFirstFen: number      // 兜底首重价（首重 1 kg）
    tableOverPerKgFen: number  // 兜底续重每公斤
    blocked: boolean           // 不寄送
  }[]
  // 没归组的省份落到 name === '其他' 那一组；该组必须存在且不可 blocked
  acceptGraceMin: number       // E8，默认 10
  pickup: {
    cargoName: '食品'
    defaultRemark: string      // '食品请勿重压'
    unacceptedRemindHours: number   // 预约后无人接单提醒，默认 4
    unpickedRemindMin: number       // 时段结束后未取件提醒，默认 60
  }
  costAlertRatio: number       // 实扣/预扣 超过 1.2 提醒一次
}
```

默认分组：四川（满 99）、周边（重庆/云南/贵州/陕西/甘肃，满 149）、其他（满 199，兜底价迁移自旧 `shipping.fee`）、不寄送（新疆/西藏/香港/澳门/台湾）。
旧 `shipping` key 保留只读一段时间，新 key 首次保存时从它迁移 `fee/freeThreshold/minOrderAmount`；迁移后 `settings.ts` 的 `calcShippingFee` 不再被下单路径调用。

校验（保存时）：`其他` 组存在且未 blocked；省份不重复；`pricingPool` 至少 2 家；`packagingG ≥ 0`；`acceptGraceMin 0–30`。

## 3. 报价（服务端纯函数 + 一个查价适配）

文件：`services/express-quote.ts`（纯计算）+ `services/delivery/kd100-express.ts`（协议）。

输入：收货地址（省/市/区/详细/全地址）、商品行（productId, qty, netWeightG?）、券前小计。

1. **重量** `weightKg = ceil10((Σ (netWeightG ?? defaultItemG) × qty + packagingG) / 1000)`，最小 0.1 kg。
2. **分组**：按 `receiverProvince` 全名匹配 `regionGroups`，无匹配落「其他」。`blocked` → `AppError(42240, '该地区暂不支持邮寄')`。
3. **查价**：`mode === 'QUOTE'` 时调 `batchPrice(pricingPool, senderAddr, receiverFullAddr, weightKg)`，超时 5 s（与同城顾客侧一致）。剔除 `price == null` 的家。
4. **中位数**：有效家数 `≥ minQuoteCount` → 排序取中位数（偶数取中间两家均值）→ `+ markupFen` → 向上取整到 `roundToFen`。否则 `feeSource = 'TABLE'`：`tableFirstFen + tableOverPerKgFen × max(0, ceil(weightKg) − 1)`。
5. **包邮**：券前小计 `≥ freeShipMinFen`（>0）→ 运费 0，但保留 `quotedFee` 供成本展示。
6. **起送**：小计 `< minOrderAmountFen` → 返回 `belowMin` 由结算页提示，下单时再拦。
7. **输出**：`{ feeFen, quotedFeeFen, feeSource, weightKg, groupName, freeShipMinFen, freeShip, belowMin, quotes: {kuaidicom, serviceType, priceFen, defPriceFen}[], quoteToken }`。

**凭证**：HMAC 签名，载荷 `{ addressId, itemsHash(productId+skuId+qty 排序后), weightKg, feeFen, quotedFeeFen, feeSource, groupName, quotes, iat }`，TTL 15 分钟，密钥复用同城 `verifyQuote` 的密钥来源。
**缓存**：`(addressId, weightKg)` → 快递100 回价，15 分钟；换券、改备注不触发查价。
**限流**：复用 `localQuoteLimiter` 的参数，单独实例。

实测口径（2026-09-08 数据）：成都 1.5 kg 约 ¥7.50，北京 ¥10.50，北京 3 kg ¥13.50。

## 4. 顾客端

### 4.1 结算页（EXPRESS 渠道）

- 选地址或购物车变动 → `POST /api/express/quote { addressId, items }`。删除 `pages/order/confirm.js` 里本地算一口价的那段；运费只显示服务端返回值。
- 展示：`运费 ¥X` / `已包邮` / `再买 ¥Y 包邮（四川满 ¥99）` / `该地区暂不支持邮寄`（禁用付款）/ `计算中…`。`feeSource === 'TABLE'` 不对顾客区分显示。
- 下单 `POST /api/orders` 邮寄单必带 `quoteToken`。服务端：验签、TTL、`addressId` 一致、`itemsHash` 一致；三项任一不符 → `42241 '运费已更新，请重新确认'`，小程序自动重报价。运费取凭证 `feeFen`；包邮、起送、不寄送按**当前设置**重判（凭证里的 `freeShip` 不信）。
- 订单落库：`shippingFee`、`expressQuoteSnapshot`（凭证载荷整体）、`expressRegionGroup`、`expressWeightKg`。

### 4.2 订单详情物流卡片

按订单 + 最新预约记录 + 轨迹 JSON 渲染，自上而下：

| 条件 | 文案 |
|---|---|
| PAID / PREPARING 无活跃预约 | 商家备货中 |
| 预约 BOOKED | 已预约快递员上门取件 · 9 月 9 日 14:00–16:00 |
| 预约 ACCEPTED | 快递员已接单 · 张师傅（不显示手机） |
| 预约 PICKED（订单 SHIPPED） | 已取件 · 京东物流 JD0012345 · 复制单号 |
| 轨迹 JSON 非空 | 时间线：每条 `context + ftime`，最新在上 |
| 订单 COMPLETED | 已签收 |

预约被取消/失败回到「商家备货中」，不向顾客解释原因。

### 4.3 顾客取消与退款

- 接单前：现有自助秒退，不变。
- 接单后 `acceptGraceMin` 内：`cancel-request` 放开 `deliveryType === 'EXPRESS'`（`cancelWindowOf` 读邮寄设置），快照当时预约状态。店员「同意」= 先取消预约（若有）再全额退款；「驳回」同现有。超时自动驳回沿用同城逻辑。
- 窗口外到取件前：电话联系，店员后台发起退款。
- 取件后：只走现有「申请售后」。

## 5. 店员端（工作台 + 订单页）

### 5.1 按钮矩阵（邮寄单）

| 订单状态 | 活跃预约 | 主按钮 | 次按钮 |
|---|---|---|---|
| PAID | — | 接单 | 直接发货（保留） |
| PREPARING | 无 | **预约取件** | 填单号发货 |
| PREPARING | BOOKED / ACCEPTED | — | 改约时间、取消预约 |
| PREPARING | UNKNOWN | — | 显示「核对中，请稍候」 |
| SHIPPED | PICKED | 标记完成（现有） | — |

有活跃预约时隐藏「填单号发货」，先取消预约。

### 5.2 预约弹窗

- **重量**：默认 `expressWeightKg`，可改；改后重查价（查价免费）。
- **报价列表**：来自订单 `expressQuoteSnapshot.quotes`；快照超过 2 小时或重量改过则重查 `batchPrice`（全部 9 家，不只定价名单）。按价排序，最低标「最低」默认选中；每行显示「比顾客付的 +¥2.30 / −¥0.50」；顶部「顾客付 ¥10.50」。无价的家灰显。
- **时段**：`dayType` 今天/明天/后天 + 起止时间下拉（整点，09:00–20:00）。预填：当前时间 + 2 小时向上取整到整点作为开始，结束 = 开始 + 2 小时；超出 20:00 则明天 09:00–11:00。校验：结束 − 开始 ≥ 1 h；今天的时段要求 `now < end − 2h`；顺丰必须有时段，其余家允许留空（留空则不传）。
- **货物/备注**：货物固定「食品」；备注默认 `pickup.defaultRemark`，可改，≤ 50 字。
- **确认文案**：「向快递100 下单，预扣 ¥8.30，快递员上门后按实际重量多退少补。快递员上门前取消不收费；取件后取消要联系快递公司。」

### 5.3 下单结果

- 成功 → 建 `ExpressBooking(status=BOOKED)`；`kuaidinum` 非空则同时 upsert `Shipment.expressNo/expressCompany`（不改 `shippedAt`、不改订单状态）。
- 超时/网络不确定 → `UNKNOWN`。此时没有 `taskId`（它由快递100 返回），只有我们下单时传的 `thirdOrderId = bookingNo`。定时任务每分钟用 `detail` 按 `thirdOrderId` 查：有单 → 认领为 `BOOKED` 并补 `taskId/kdOrderId/kuaidinum`；确认无单 → `VOID`；连续 10 分钟查不到结论 → 提醒店员到企业后台核对（同城同款人工路径）。`detail` 是否支持按 `thirdOrderId` 查，实施前在测试环境验证（§14）；不支持则 UNKNOWN 只走人工路径。
- 业务失败 → 不建记录，原话展示（风控/停派/地址中文少/大于 2.49 kg 请用德邦大件360/余额不足），店员换家或改走填单号。余额不足另触发横幅。

### 5.4 预约后的操作

- 改约：`modifyOrder`，成功后更新时段；失败原话展示。
- 取消预约：`cancel(taskId, orderId, cancelMsg)` → `CANCELLED`，订单回 PREPARING（本来就是），不退顾客款。快递100 返回已揽收不可取消 → 保持状态，提示联系快递公司。
- 同意顾客取消申请：`取消预约 → 成功 → initiateRefund(全额)`；第一步失败不进第二步，提示原因。
- 拒单/全额退款前置：`initiateRefund` 与拒单路径加校验：存在 `BOOKED/ACCEPTED/UNKNOWN` 预约 → `AppError(42242, '该订单有取件预约（待取件），请先取消预约')`，与同城 42221 同款。

### 5.5 成本展示

订单详情与工作台卡片：「顾客付 ¥10.50 · 预扣 ¥8.30 · 实扣 ¥8.30 · 计费 1.5 kg」。实扣未回前显示「实扣 —」。

## 6. 预约记录状态机

```
BOOKED ──(1 已接单/2 收件中)──► ACCEPTED ──(10 已取件)──► PICKED ──(轨迹签收/13)──► DELIVERED
  │                                │
  ├──(9/99 取消、店员取消)──► CANCELLED
  ├──(11 揽货失败、610 下单失败)──► FAILED
  └──(下单结果不明)◄── UNKNOWN ──(对账无单)──► VOID
```

- 白名单外的转移一律忽略并记事件（如 PICKED 后收到 1）。
- 每条回调写 `express_booking_events`（status, raw param, at）便于排查，保留 90 天。
- 订单侧联动：`PICKED` → 同一事务 `Order.status=SHIPPED`、`Shipment` 写公司/单号/`shippedAt`，事务外发发货订阅消息；`DELIVERED` → `Order.status=COMPLETED, completedAt`（仅当 SHIPPED）；`FAILED/CANCELLED(非店员)` → 推送店员。
- 一单可多条预约，「活跃」= `BOOKED/ACCEPTED/UNKNOWN`，同一时刻最多一条（建活跃唯一索引：`orderId + isActive`）。

快递100 状态码映射（回调 `data.status`）：0 下单成功（韵达补单号）、1/2 → ACCEPTED、10 → PICKED、11 → FAILED、9/99 → CANCELLED、15 → 记 `settledFeeFen/billedWeightKg`（多次推送累加 `feeDetails`）、155 → 更新实扣、101/400 → 仅事件、13/14 → 轨迹层处理、200/201 → 忽略、610 → FAILED、166 → 事件 + 提醒。收到 15 后调 `synPay(orderId)`。

## 7. 回调与轨迹

- 路由：`POST /api/kd-express/:bookingNo`（订单状态与费用）、`POST /api/kd-express/:bookingNo/track`（轨迹）。`callBackUrl ≤ 200 字节`、`pollCallBackUrl` 同限。下单参数 `op=1`、`salt` 每条预约随机 32 字节存库。
- 验签 `MD5(param + salt)`，失败 400 且不处理。ack 固定 `{"result":true,"returnCode":"200","message":"成功"}`。
- **限流**：单独的 `kdExpressCallbackLimiter`，触发时回 503（不是成功形状），让快递100 重推。
- nginx：`location /api/kd-express/` 与 `/api/kd/` 同配置（关 gzip、独立 burst）。
- 幂等：`(bookingNo, status, kuaidinum)` 重复推送直接 ack 不重处理。
- 轨迹：整体覆盖写 `ExpressBooking.trackJson = lastResult`、`trackStatus`、`trackUpdatedAt`；`ischeck === '1'` 或 `state` 表示签收 → `DELIVERED`。顾客端只读这个 JSON。
- 对账定时任务（每 30 分钟）：`BOOKED/ACCEPTED` 且 `pickupEnd + unpickedRemindMin` 已过 → `detail` 补状态；`PICKED` 超过 10 天未 DELIVERED → `detail`；仍无结论只提醒一次。UNKNOWN 对账每分钟（§5.3）。

## 8. 通知与提醒

店员（PushPlus，`services/notify.ts` 新增 4 个事件，每单每类只发一次）：揽货失败、快递100 侧取消、下单失败（异步 610）、余额不足。定时提醒：预约后 `unacceptedRemindHours` 无人接单；时段结束 `unpickedRemindMin` 未取件；`settledFee/prepaidFee > costAlertRatio`。
顾客：取件时发货订阅消息（现有 `WECHAT_TMPL_SHIP`，字段快递公司/单号）。签收不发。
工作台：邮寄侧栏卡片状态文案加「已预约 · 待取件」「快递员已接单」「揽货失败」；余额不足横幅同城已有，文案加「邮寄」。

## 9. 数据模型

新表 `express_bookings`：`id, bookingNo(唯一, E+订单序号+序)`, `orderId`, `orderNo`, `kuaidicom`, `serviceType`, `taskId`, `kdOrderId`, `kuaidinum`, `status`, `dayType`, `pickupDate`, `pickupStart`, `pickupEnd`, `weightKg`, `customerFeeFen`, `quotedFeeFen`(所选家报价), `prepaidFeeFen`, `settledFeeFen`, `billedWeightKg`, `feeDetailsJson`, `courierName`, `courierMobile`, `salt`, `pollToken`, `trackJson`, `trackStatus`, `trackUpdatedAt`, `failReason`, `cancelledBy(STAFF/KD100/CUSTOMER)`, `createdBy`, `createdAt/updatedAt`。索引：`orderId`、`status`、活跃唯一。
新表 `express_booking_events`：`bookingId, status, rawJson, createdAt`。
`Order` 新列：`expressQuoteSnapshot Json?`、`expressRegionGroup VarChar(32)?`、`expressWeightKg Decimal(6,1)?`。提醒类「每单只发一次」标记放在 `express_bookings` 上（`unacceptedRemindedAt`、`unpickedRemindedAt`、`costAlertedAt`），不动 `Order`。
`Shipment` 不变。设置表新 key。
迁移全部为加表/加可空列，无删改。

## 10. 协议层与配置

- 抽 `services/delivery/kd100-client.ts`：`sign()`、`post(url, method, param, timeout)`、超时/连接错误分类（照搬现 `kd100.ts` 的 TIMEOUT/UNKNOWN 判定）。`kd100.ts`（同城）改为调用它，行为不变，e2e 全绿为准。
- `services/delivery/kd100-express.ts`：`batchPrice`、`bOrder`、`cancel`、`modifyOrder`、`detail`、`synPay`、回调验签、错误码映射（400 参数 / 503 签名 / 600-601 授权 / 业务失败原话 / 余额不足关键字 → `BALANCE`）。
- env：复用 `KD100_KEY/KD100_SECRET`；新增可选 `KD100_EXPRESS_API_URL`（默认正式 `https://poll.kuaidi100.com/order/borderapi.do`，测试环境填 `http://e-test.kuaidilab.com/api/order/borderapi.do`）、`KD100_EXPRESS_TEST_KEY/SECRET`（填了就覆盖）。本地假运力：扩 `LOCAL_DELIVERY_PROVIDER_MOCK` 同款开关 `EXPRESS_PROVIDER_MOCK`，mock 回固定报价并可通过 `admin/kd100-mock` 路由推回调。
- `PUBLIC_BASE_URL` 已有；启动时校验最坏回调 URL ≤ 200。

## 11. 错误处理清单

| 场景 | 处理 |
|---|---|
| 查价超时/失败 | TABLE 兜底，`feeSource=TABLE`，写审计；顾客无感 |
| 回价 < minQuoteCount | 同上 |
| 省份名不在任何组 | 落「其他」 |
| 地址 > 300 字节 | 下单前截断校验，超长报 `42243 '收货地址过长，请精简'`（结算页提示） |
| 下单业务失败 | 原话展示，不建记录 |
| 下单超时 | UNKNOWN + 自动对账 |
| 余额不足 | `BALANCE` → 横幅 + 推送 |
| 回调验签失败 | 400，记日志 |
| 回调乱序/重复 | 白名单忽略 + 幂等 |
| 回调丢失 | 30 分钟对账 |
| 取消时已揽收 | 保持状态，提示联系快递公司 |
| 退款时有活跃预约 | 42242 拦截 |
| 实扣远高于预扣 | 提醒一次 |

## 12. 测试

1. 单元：`express-quote.ts`（中位数奇/偶/不足、分组/黑名单/其他、包邮、起送、取整、重量）、时段校验、状态白名单、凭证签验、地址长度。
2. e2e（`EXPRESS_PROVIDER_MOCK`）：主链路「下单 → 接单 → 预约 → 1 → 10（订单 SHIPPED + 通知）→ 轨迹 → 签收（COMPLETED）」；分支「预约后同意取消申请」「揽货失败重约」「UNKNOWN 自动认领/作废」「有预约时退款被拦」「填单号发货被隐藏」「不寄送地区下单被拒」「凭证过期重报价」；同城 e2e 全量回归（协议层抽取不改行为）。
3. 快递100 测试环境：切 env 后跑同一套预约流程，用其测试平台推各状态。
4. 生产：伪回调演练过 nginx（同 `docs/deployment.md:383-395`）；真单 1–2 张寄给自己，核对预扣/实扣/轨迹。

## 13. 上线分批

1. **批次一**：邮寄设置页 + 报价 + 结算页 + 下单校验 + 数据迁移。运费先按新规则收，店员流程不变。
2. **批次二**：预约表 + 协议层 + 预约弹窗 + 回调 + 状态联动 + 退款前置 + 顾客取消窗口 + 提醒。
3. **批次三**：轨迹订阅与展示 + 签收自动完成 + 对账任务。

每批独立迁移、独立回滚。

## 14. 待办与未决

- 顺丰在当前账号「当前线路未设置价格」，须找快递100 商务开通；开通后无需改代码，自动进入报价列表（不进定价名单除非后台勾选）。
- 向商务申请测试环境 key。
- `detail` 接口是否支持按 `thirdOrderId` 查询，实施前在测试环境验证；不支持则 UNKNOWN 走人工核对路径（同同城）。
- 冷链不可用：常温快递 + 自备保温包装，能寄什么、寄多远由店主按地区分组控制。
