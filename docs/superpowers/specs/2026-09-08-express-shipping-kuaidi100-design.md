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
2. **分组**：按 `receiverProvince` 全名匹配 `regionGroups`，无匹配落「其他」。`blocked` → `AppError(42260, '该地区暂不支持邮寄')`。
3. **查价**：`mode === 'QUOTE'` 时调 `batchPrice(pricingPool, senderAddr, receiverFullAddr, weightKg)`，超时 5 s（与同城顾客侧一致）。剔除 `price == null` 的家。
4. **中位数**：有效家数 `≥ minQuoteCount` → 排序取中位数（偶数取中间两家均值）→ `+ markupFen` → 向上取整到 `roundToFen`。否则 `feeSource = 'TABLE'`：`tableFirstFen + tableOverPerKgFen × max(0, ceil(weightKg) − 1)`。
5. **包邮**：券前小计 `≥ freeShipMinFen`（>0）→ 运费 0，但保留 `quotedFee` 供成本展示。
6. **起送**：小计 `< minOrderAmountFen` → 返回 `belowMin` 由结算页提示，下单时再拦。
7. **输出**：`{ feeFen, quotedFeeFen, feeSource, weightKg, groupName, freeShipMinFen, freeShip, belowMin, quotes: {kuaidicom, serviceType, priceFen, defPriceFen}[], quoteToken }`。

**凭证**：HMAC 签名，载荷 `{ addressId, addressHash(收货地址 fullAddress 摘要), itemsHash(productId+skuId+qty 排序后), weightKg, feeFen, quotedFeeFen, feeSource, groupName, quotes, iat }`，TTL 15 分钟，密钥复用同城 `verifyQuote` 的密钥来源。凭证同时绑定收货地址内容摘要：`PUT /api/addresses/:id` 原地改地址（同 id 换省市区/详细地址）会让 `addressHash` 不再匹配，旧凭证随即失效，下单走 42261 重报价。
**缓存**：`(addressId, addressHash, weightKg)` → 快递100 回价，15 分钟；换券、改备注不触发查价。
**限流**：复用 `localQuoteLimiter` 的参数，单独实例。

实测口径（2026-09-08 数据）：成都 1.5 kg 约 ¥7.50，北京 ¥10.50，北京 3 kg ¥13.50。

## 4. 顾客端

### 4.1 结算页（EXPRESS 渠道）

- 选地址或购物车变动 → `POST /api/express/quote { addressId, items }`。删除 `pages/order/confirm.js` 里本地算一口价的那段；运费只显示服务端返回值。
- 展示：`运费 ¥X` / `已包邮` / `再买 ¥Y 包邮（四川满 ¥99）` / `该地区暂不支持邮寄`（禁用付款）/ `计算中…`。`feeSource === 'TABLE'` 不对顾客区分显示。
- 下单 `POST /api/orders` 邮寄单**带则校验，不带（老客户端）服务端现算**：带了 `quoteToken` 时服务端验签、TTL、`addressId` 一致、`addressHash` 一致、`itemsHash` 一致，任一不符 → `42261 '运费已更新，请重新确认'`，小程序自动重报价；运费取凭证 `feeFen`。不带时服务端现查现算，不报 42261。包邮、起送、不寄送一律按**当前设置**重判（凭证里的 `freeShip` 不信）。
- 订单落库：`shippingFee`、`expressQuoteSnapshot`（凭证载荷整体）、`expressRegionGroup`、`expressWeightG`。

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

- **重量**：默认 `expressWeightG`，可改；改后重查价（查价免费）。
- **报价列表**：来自订单 `expressQuoteSnapshot.quotes`；快照超过 2 小时或重量改过则重查 `batchPrice`（全部 9 家，不只定价名单）。按价排序，最低标「最低」默认选中；每行显示「比顾客付的 +¥2.30 / −¥0.50」；顶部「顾客付 ¥10.50」。无价的家灰显。
- **时段**：`dayType` 今天/明天/后天 + 起止时间下拉（整点，09:00–20:00）。预填：当前时间 + 2 小时向上取整到整点作为开始，结束 = 开始 + 2 小时；超出 20:00 则明天 09:00–11:00。校验：结束 − 开始 ≥ 1 h；今天的时段要求 `now < end − 2h`；顺丰必须有时段，其余家允许留空（留空则不传）。
- **货物/备注**：货物固定「食品」；备注默认 `pickup.defaultRemark`，可改，≤ 50 字。
- **确认文案**：「向快递100 下单，预扣 ¥8.30，快递员上门后按实际重量多退少补。快递员上门前取消不收费；取件后取消要联系快递公司。」

### 5.3 下单结果

- 成功 → 建 `ExpressBooking(status=BOOKED)`；`kuaidinum` 非空则同时 upsert `Shipment.expressNo/expressCompany`（不改 `shippedAt`、不改订单状态）。
- 超时/网络不确定 → `UNKNOWN`。此时没有 `taskId`（它由快递100 返回），只有我们下单时传的 `thirdOrderId = bookingNo`。定时任务按阈值（默认每分钟）用 `detail` 按 `thirdOrderId` 查：有单 → 认领为 `BOOKED` 并补 `taskId/kdOrderId/kuaidinum`；**查不到只记一次查单事件、计数加一，不自动作废**——连续 10 次查不到提醒店员一次；累计 **30 次或预约超过 24 小时**后停止自动查询（再提醒一次）。之后**只能由店员在快递100 后台核实清楚后手动作废**（`POST /api/admin/express/orders/:id/booking/void`；`PENDING` 占位卡住超过 2 分钟同样可作废）。（实现回改，批次二：原设计「确认无单 → `VOID`」改为不自动作废——`detail` 按 `thirdOrderId` 查询在测试环境未验证过，自动作废一旦判错就是同一单在快递100 那头真实存在、店内却又重新建了一单的双单事故；`detail` 是否支持按 `thirdOrderId` 查，仍待测试环境验证，见 §14）。
- 业务失败 → 不建记录，原话展示（风控/停派/地址中文少/大于 2.49 kg 请用德邦大件360/余额不足），店员换家或改走填单号。余额不足另触发横幅。

### 5.4 预约后的操作

- 改约：`modifyOrder`，成功后更新时段；失败原话展示。
- 取消预约：`cancel(taskId, orderId, cancelMsg)` → `CANCELLED`，订单回 PREPARING（本来就是），不退顾客款。快递100 返回已揽收不可取消 → 保持状态，提示联系快递公司。
- 同意顾客取消申请：`取消预约 → 成功 → initiateRefund(全额)`；第一步失败不进第二步，提示原因。
- 拒单/全额退款前置：`initiateRefund` 与拒单路径加校验：存在 `BOOKED/ACCEPTED/UNKNOWN` 预约 → `AppError(42263, '该订单有取件预约，请先取消预约再退款')`，与同城 42221 同款；手填发货同理受 `42264` 拦截。（实现回改，批次二：原设计草稿写的 42242 是占位码，实现落地为 4226x 段的 42263/42264，见 §11）

### 5.5 成本展示

订单详情与工作台卡片：「顾客付 ¥10.50 · 预扣 ¥8.30 · 实扣 ¥8.30 · 计费 1.5 kg」。实扣未回前显示「实扣 —」。

## 6. 预约记录状态机

```
PENDING(占位，外呼进行中) ──(外呼成功)──► BOOKED ──(1 已接单/2 收件中)──► ACCEPTED ──(10 已取件)──► PICKED ──(轨迹签收/13)──► DELIVERED
    │                                              │
    ├──(9/99 取消、店员取消)──────────────────────► CANCELLED
    ├──(11 揽货失败、610 下单失败)────────────────► FAILED
    └──(外呼超时/落库失败等不确定情形)──► UNKNOWN ──(任意一条验签通过的回调即视为认领)──► BOOKED
          │
          └──(店员在快递100 后台核实无单后手动作废；或 PENDING 卡住超 2 分钟)──► VOID
```

（实现回改，批次二：补上 `PENDING` 与 `VOID` 两个原图缺失的节点。`PENDING` 是 `createBooking` 先落库占位、还没等到外呼结果时的中间态，正常几秒内会推进到 `BOOKED/UNKNOWN/FAILED` 之一；只有进程在这几秒窗口崩溃重启才会留下卡死的 `PENDING`，超过 2 分钟允许人工作废。`VOID` **只能由店员手动触发**，系统不会自动把 `UNKNOWN` 转成 `VOID`，理由见 §5.3。「活跃」= `BOOKED/ACCEPTED/UNKNOWN`，`PENDING` 虽占着 `activeOrderId` 但不算活跃三态之一。）

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
`Order` 新列：`expressQuoteSnapshot Json?`、`expressRegionGroup VarChar(32)?`、`expressWeightG Int?`。提醒类「每单只发一次」标记放在 `express_bookings` 上（`unacceptedRemindedAt`、`unpickedRemindedAt`、`costAlertedAt`），不动 `Order`。
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
| 地址 > 300 字节 | 下单前截断校验，超长报 `42262 '收货地址过长，请精简'`（结算页提示） |
| 下单业务失败 | 原话展示，不建记录，`42270` |
| 下单超时 | UNKNOWN + 自动对账（不自动作废，见 §5.3） |
| 余额不足 | `BALANCE` → 横幅 + 推送 |
| 回调验签失败 | 仍 ack 200（避免对方判失败无限重推）；不处理状态，记一条留痕事件并告警店员核对 |
| 回调乱序/重复 | 白名单忽略 + 幂等 |
| 回调丢失 | 定时对账兜底 |
| 取消时已揽收 | 保持状态，提示联系快递公司 |
| 退款/拒单时有活跃预约 | `42263` 拦截（与同城 42221 同款） |
| 有活跃预约点「填单号发货」 | `42264` 拦截 |
| 重复预约（已有活跃预约） | `42265` 拦截 |
| 有顾客待处理的取消申请 | `42266` 拦截，须先处理 |
| 预约状态不允许该操作（含 UNKNOWN 待核对时取消/改约） | `42267` |
| 快递100 请求超时、状态未变化 | `42268` |
| 取件时段不合规 | `42269` |
| 实扣远高于预扣 | 提醒一次 |

（实现回改，批次二：错误码替换为落地的 `42263`–`42270` 八个码，替换原设计草稿里的占位码；`42270` 已在上面「下单业务失败」行标注。）

## 12. 测试

分八层。前两层是自动化，跑不过不合并；三到五层是人眼看界面，每批上线前照清单点一遍并截图留档；六到八层是外部环境与回归。

### 12.1 服务端单元

`express-quote.ts`：中位数奇数家 / 偶数家取中间两家均值 / 只有一家回价退兜底 / 全部无价退兜底；`markupFen` 与 `roundToFen`（0 不取整、50 取五毛、¥8.33 → ¥8.50 只往上）；省份精确匹配 / 未归组落「其他」/ blocked 报 42260；包邮按券前小计判且保留 `quotedFeeFen`；起送 `belowMin`；重量（净重缺省、礼盒计入净重、包装附加、0.1 kg 向上取整、最小值）；兜底表首重 1 kg 与续重向上取整。
时段校验：间隔 < 1 h 拒；今天且 `now ≥ end − 2h` 拒；顺丰缺时段拒；其他家允许留空；预填规则（含 20:00 后翻到明天）。
状态白名单：全部合法转移通过，`PICKED` 后收 1/2、`CANCELLED` 后收 10、`VOID` 后任何回调都忽略并记事件。
凭证：签名篡改 / 过期 / `addressId` 不符 / `itemsHash` 不符（改数量、加商品、换规格）四种都拒；正常通过。
地址长度：299 / 300 / 301 字节边界；含 emoji 的地址按字节算。
协议层：签名向量与同城现有 `_sign` 一致；`batchPrice` `serviceTypeList` 与 `kuaidiComList` 一一对应；错误码 400/503/600/601 映射；「余额」「大于2.49公斤」「风控」「停派」四类原话映射；超时 → TIMEOUT，ECONNREFUSED → 硬失败，其他 → UNKNOWN。

### 12.2 服务端 e2e（`scripts/e2e.d/` 新增，`EXPRESS_PROVIDER_MOCK=true`）

主链路：邮寄下单（带凭证）→ 接单 → 预约 → 回调 1（记快递员）→ 回调 10（订单 SHIPPED、`Shipment` 写入、发货订阅消息调用一次）→ 轨迹推送 ×2（JSON 覆盖、最新在上）→ 签收（COMPLETED、`completedAt` 有值）。
分支：
- 凭证：无凭证 / 过期 / 换地址 / 换购物车后用旧凭证 → 42261；重报价后成功。
- 分组：四川地址包邮门槛 99、其他省 199、新疆下单 42260、地址超长 42262。
- 换券不改运费；起送不足拒单；`TABLE` 兜底（mock 查价超时）能下单且 `feeSource=TABLE`。
- 预约：最便宜默认；手选贵的那家 `quotedFeeFen` 记所选家；重量改动后重查价；有活跃预约时再预约被拒；有活跃预约时 `/ship` 填单号被拒。
- 取消/退款：预约后店员取消 → CANCELLED、订单仍 PREPARING、可再约；预约后同意顾客取消申请 → 先取消再退款；mock 取消失败 → 不退款、订单不变；有活跃预约点全额退款 → 42263；有活跃预约点拒单 → 42263；取件后全额退款不再碰预约。
- 顾客取消窗口：接单后 10 分钟内可申请，超时拒，`acceptGraceMin=0` 关闭窗口；超时自动驳回。
- 失败路径：回调 11 → FAILED、订单 PREPARING、推送一次、可重约；异步 610 同上；回调 9/99（快递100 侧）→ CANCELLED + 推送，店员取消不推送。
- UNKNOWN：mock 下单超时 → UNKNOWN；对账 mock 返回有单 → BOOKED 并补单号；返回无单 → VOID；连续查不到 → 提醒一次。
- 回调健壮性：验签失败 400 且状态不变；同一状态重推两次只处理一次；乱序推送忽略；限流触发返回 503 不是 200；回调 15 两次推送费用累加、`synPay` 调用一次；155 更新实扣；实扣/预扣 > 1.2 → 提醒一次，再推不重复提醒。
- 并发：两个店员同时点预约只成功一个；取件回调与店员取消同时到达以先落库者为准且最终状态自洽；退款与取件回调并发不出现「已退款又已发货」。
- 定时任务：无人接单提醒到点只发一次；时段结束未取件提醒只发一次；对账任务对 PICKED 超 10 天的单调 `detail`。
- 打印：邮寄单来单小票照出、预约/取件不再出票、`print_jobs` 条数精确。
- 数据迁移：旧 `shipping` 有值时首次读新 key 得到「其他」组的兜底价与门槛、起送金额一致；无旧值用默认。
- 订单契约：`GET /orders/:id` 新增字段形状固定（`expressBooking`、`track`），旧邮寄单（无预约、手填单号）字段为 null 且现有断言不变（`53-order-contract.sh` 扩）。
- 同城全量回归：协议层抽取后 `40–53` 全绿，断言数不减。

### 12.3 管理后台（浏览器预览逐页点 + 截图）

邮寄设置页：每个字段的非法值提示（负数、空、省份重复、「其他」组删除被拒、blocked 组不能填包邮）；保存后刷新回显一致；`QUOTE/TABLE` 切换时字段显隐；`pricingPool` 少于 2 家不能保存；分组表增行/删行/改省份；从旧设置迁移后的默认值正确；页面在手机宽度（店员用手机看后台）不溢出。
工作台邮寄侧栏与订单页：§5.1 按钮矩阵六种状态各截一张；30 秒自动刷新后状态不跳；卡片文案「已预约 · 待取件 · 京东 · 9/9 14:00–16:00」「快递员已接单 · 张师傅」「揽货失败」三种；成本行四个数与空值「—」。
预约弹窗：报价按价排序、最低标注与默认选中、差价正负号与颜色、无价家灰显不可选、改重量触发重查价且有加载态、时段预填值、四种校验错误提示文案、顺丰选中时时段变必填、确认文案里的预扣金额随所选家变、提交中按钮禁用、失败原话完整展示不截断、余额不足横幅出现。
其他动作：改约 / 取消预约 / 同意取消申请（成功、第一步失败、第二步失败三种提示）/ 退款被拦提示 / 拒单被拦提示 / 填单号发货在有预约时不可见。
系统状态页：新增邮寄回调最近一次时间与失败计数；订单详情抽屉里的预约事件列表。

### 12.4 小程序顾客端（微信开发者工具 + 真机 iOS/Android 各一台）

结算页：运费五种显示（数字 / 已包邮 / 再买 ¥X 包邮含组名 / 该地区暂不支持邮寄且付款按钮禁用 / 计算中）；查价失败走兜底时页面无异常提示；换地址重报价且有加载态；换券运费不变、合计 = 小计 − 券 + 运费；起送不足提示；地址超长提示；同城↔邮寄切渠道后运费行与合计不串；凭证过期后点付款自动重报价并二次确认不闪退；弱网下报价超时的表现；下单成功页金额与服务端一致。
订单列表：邮寄单状态文案（待发货 / 已发货 / 已完成）不受预约影响；有预约的待发货单不出现「同城」字样。
订单详情：§4.2 六种物流卡片各截一张；单号复制按钮；时间线长文本换行、空轨迹、轨迹 JSON 缺字段或字段类型异常时不白屏；签收后「确认收货」按钮消失；取消申请入口只在窗口内出现并显示剩余分钟；被驳回时显示「商家未同意取消」；售后入口在已发货后出现；旧邮寄单（手填单号）显示与改动前一致；同城单页面零变化。
通知落点：发货订阅消息点开落到该订单详情。
适配：iPhone SE 小屏、安卓大屏、系统字体放大一档；小程序深色模式若开启则检查对比度。

### 12.5 通知与打印

PushPlus 四类事件各触发一次并核对文案与订单号；发货订阅消息字段（快递公司、单号、时间、备注）齐全；邮寄来单小票内容与现在逐字一致，预约、取件、签收都不出票。

### 12.6 快递100 测试环境

切 `KD100_EXPRESS_API_URL` 与测试 key 后，用真实协议跑 §12.2 主链路与「取消」「改约」「UNKNOWN 对账」三条分支；在其测试平台依次推 0/1/10/11/15/155/610/轨迹/签收，核对我们每一步状态；验证 `detail` 按 `thirdOrderId` 查询是否可用；验证回调 `Accept-Encoding: gzip` 情况下 ack 被正确接受。

### 12.7 生产验证

伪回调演练过 nginx（新 location、限流返回码、gzip 关闭）；真单 1–2 张寄给自己：核对预扣金额与后台余额变化、快递员接单信息、取件回调时间、发货通知到达、轨迹推送、实扣与计费重、签收自动完成；跑完把测试单标 `isTest`。
写一份店主操作手册 `docs/express-shipping-golive-manual.md`（仿同城手册），按步骤点、每步花多少钱、出错找谁。

### 12.8 回归与门禁

每批合并前：`tsc` 全仓无错；`apps/admin` 的 `npm test`；`scripts/e2e.sh` 全绿且断言总数只增不减（现 803）；同城 e2e 组全绿；`selftest-kd100.ts` 通过；Opus 代码复核过一遍（按 `workflow-model-tiering` 分工）。

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
