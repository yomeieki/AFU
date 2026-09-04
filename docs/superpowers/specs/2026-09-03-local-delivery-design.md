# 同城配送（Local Delivery）+ 来单出票播报 + 运营工作台 顶层方案 v3

分支：`claude/same-city-delivery-plan-2ffa20`（独立 worktree，不影响上架中的功能）。
v2 = v1 + Opus 架构审阅（13 条阻断 / 12 条建议）+ Sonnet 产品运营审阅 + Opus 复核（N1–N15）+ 用户两轮决策。
v3 = v2 + 用户追加需求：云打印机出票与语音播报（D7）、同城运营工作台（D8），含飞鹅/芯烨/易联云调研结论。
实施计划：`docs/superpowers/plans/2026-09-03-local-delivery-m1-channel-foundation.md`（M1）；M2/M2b/M3/M4 计划在前序里程碑落地后再写。每个里程碑由不同模型审阅。

## Context

- 店铺：丹桂阿福凉菜（四川省自贡市汇东新区丹桂 40 栋底楼，电话 15309003232），单店，凉菜/熟食。
- 现状：原生微信小程序 + Express/Prisma(MySQL) + React 后台，只做「全国邮寄」。订单状态机 `PENDING_PAYMENT → PAID(待接单) → PREPARING(备餐) → SHIPPED → COMPLETED`（+ `CANCELLED / REFUNDING / REFUNDED`），一键退款、部分退款、售后、定时任务、订阅消息、PushPlus/企微推送均已闭环并在生产。
- 封面（另一分支）信息架构已定：主入口「同城配送」+「全国邮寄」。本方案不做封面，只约定入口契约。
- 目标：新增与全国邮寄**完全独立**的同城配送通道：独立分类与菜单、独立下单/履约流程、后台独立看板与设置、接入快递100「同城急送 API」，并保留「店员自送」兜底，使通道在运力未开通/无覆盖时也能运营。

### 已确认的产品决策
| # | 决策 | 结论 |
|---|---|---|
| D1 | 菜单隔离 | `Category.channel`（EXPRESS/LOCAL），商品随分类唯一归属；库存/价格/上下架互不影响 |
| D2 | 配送费 | 后台阶梯运费（基础费 + 基础公里 + 每公里加价 + 满额减免 + 起送）；快递100 实际费用只作成本记录 |
| D3 | 时效 | 首期只做「立即送」；营业时段外禁止下单 |
| D4 | 无人接单 | 只通知店员，人工选择：加小费 / 重新呼叫 / 店内自送 / 联系顾客后退款 |
| D4b | 运力主次 | **默认走快递100 第三方骑手**；店内自送是**常规备选**（每周可能用到几次），看板上与「呼叫骑手」并排常驻、一键可切，不收进二级菜单。快递100 开通因此成为同城上线的必要条件 |
| D5 | 呼叫时机 | **接单与呼叫分开，默认手动**；提供「接单并呼叫」一键按钮；可选「接单后 N 分钟自动呼叫」（默认关） |
| D6 | 退款窗口 | ① 接单前：顾客自助秒退（现有）；② 接单后 `acceptGraceMin`（默认 5）分钟内：顾客可「申请取消」，店员确认后**全额**退（含配送费，取消费店铺承担）；③ 之后：顾客端关闭退款入口，保留售后/申诉窗口（配送超时、未送达、餐品问题），店员按现有部分退款处理 |
| D7 | 来单播报 | 推送易漏单 → **云打印机自动出票 + 机器语音播报**为主通道（首期接飞鹅云打印，接口可插拔）；同城 + 全国邮寄付款成功都出票；未接单每 2 分钟重复播报/重打直到接单；打印机离线/缺纸/打印失败告警老板并回退推送；后台网页与小程序商家端新单响铃 |
| D8 | 运营工作台 | 在现有后台上增加「工作台」页作为店员默认落地页：同城单按时效分列看板 + 邮寄待处理侧栏 + 声音 + 打印机状态；手机端单列滚动；替代「同城订单」纯列表页成为主操作面（列表页保留为查询/历史） |

### 快递100 同城急送关键事实（官方文档已核）
- 接口：`POST https://api.kuaidi100.com/bsamecity/order`，form 参数 `method / key / sign / t / param`，`sign = MD5(param + t + key + secret)` 32 位大写。`method`：`price`、`batchPrice`、`order`、`batchOrder`（并呼多家，抢单后自动撤其余）、`cancel`（返回 `cancelFee`）、`precancel`（SDK 有）、`addfee`、`queryCourier`。
- 下单/询价响应：`taskId`（32 位生命周期 ID）、`orderId`（快递100 同城单号）、`deliveryDistance`（米）、`discountFee`（元，折扣后运费）；`batchOrder` 返回 `fee[]{kuaidiCom, deliveryDistance, discountFee}`。
- 下单参数含 `remark`（≤255，**传给运力/骑手的备注**）、`goods[{name,type:'食品',count}]`、`weight`(kg 必填)、`price`(元 必填)、`insurance`、`salt`(≤20)、`callbackUrl`(**≤50 字符**)、`lbsType=2`(GCJ-02)。
- 运力编码：`shunfengtongcheng / fengniaotongcheng / meituantongcheng / shansongtongcheng / dadatongcheng / uupaotui / gxdtongcheng`。覆盖「以询价/下单响应为准」。
- 开通：企业版 + 企业认证 + 预充值 ≥100 元；无接口费；下单预扣、取消退回、次月账单。
- **2026-09-03 企微答复已确认（以下为定论，不再是待核实项）**：
  - 自贡市覆盖蜂鸟、顺丰同城、闪送、达达、UU跑腿、裹小递**共 6 家**，开户后即可下单，**均无需我方绑定自有商户号**。`kd100.providers` 默认全选、并呼抢单可行。
  - **预充值可退**，最低 100 元 —— M0 的开户资金风险已排除。
  - **key/secret 在企业认证通过后即可在「我的信息 → 企业信息」看到，不必先充值**（店主已确认存在）。
    店主决定：充值与填服务器等 M2 做完再做；`.env.example` 里预留的两个空槽保持现状。
  - 费用只有预估价，**实际以接口回传扣费为准**；下单前可调预下单/批量查询价格接口。这正是 `Delivery.quotedFee`（报价）与 `actualFee`（实扣）分成两列的理由，保留。
  - **`bsamecity/order` 不支持传商户自有单号。** 官方给的替代办法是**把商户单号拼在 `callbackUrl` 后面**——本方案据此把回调路由定为 `POST /api/kd/:deliveryNo`（见 §5.5），幽灵单的认领因此从「试签猜」变成「URL 直取」。
- 回调：POST form `taskId / sign / param(JSON: orderId, kuaidicom, status, statusDesc, courierName, courierMobile, updateTime)`，`sign = MD5(param + salt)`；须回 `{"result":true,"returnCode":"200","message":"提交成功"}`；失败再回调 2 次（间隔 1 分钟）。
- 状态：`0 待抢单 → 100 已接单 → 210 待取件 → 230 已到店 → 310 配送中 → 520 已完成`；`515 改派中`、`510 异常(非终态)`、`720 已取消`。
- **无沙箱、无主动查单接口**；`queryCourier` 仅接单后可用。错误码 `30001 参数 / 30002 签名 / 30003 账号 / 30004 余额不足 / 30005 运力异常 / 30006 参数转换`。

---

## 1. 现状盘点（代码级，已核实）

**可直接复用**：`Setting` KV + `services/settings.ts` 缓存范式；`updateMany({where:{id,status:'旧态'}})` 条件流转；`services/refund.ts`（`activeOrderId @unique` 并发防线、`finalizeRefundSuccess` 幂等）；`services/notify.ts` 限频告警；`services/subscribe-message.ts`；`services/scheduler.ts` 结构；admin `Layout navItems + api/admin.ts + types.ts`、`Orders.tsx` 双渲染、`RefundDialog`、`ShopSettings.tsx` 元↔分换算；miniapp `utils/request.js`、`sku-popup`、`order-status-tag`、`address/edit.js` 的授权失败分支范式、`order/detail.js` 的 `startTicker/stopTicker`；外呼范式 `services/wechat-pay.ts`。

**硬缺口**：`Address` 无坐标；miniapp 无任何定位/地图代码，`app.json` 无 `requiredPrivateInfos`，未启用隐私弹窗（`release-checklist.md:71` 明写不启用）；门店无坐标/营业状态；运费只有固定模型且前后端各写一遍；`Product.deliveryType` 存在但后台是**单选** `<select>`（`Products.tsx:721`），列表接口不返回不过滤；`Category` 无渠道；`Shipment` 仅快递字段；快递100 零接入；无测试框架（仅 `scripts/e2e.sh`）；后台无 RBAC；隐私政策第三方共享只列了微信支付（`config/legal.js:106-112`）。

**代码事实（影响设计）**
- `orders.ts:132-140` 的全局运费/起送校验是无条件执行的 → LOCAL 分支必须整体绕开。
- `orders.ts:370-382`、`wechat-notify.ts:185-201` 都是**先置 REFUNDING 再调 `initiateRefund`** → 配送单前置校验不能放在 `initiateRefund` 内部抛错。
- `scheduler.ts:102` 自动收货靠 `shipment.shippedAt` 过滤 → LOCAL 只要不写 `Shipment` 行就天然排除。
- `subscribe-message.ts:75` 对 43101 等只 log 不告警；每个模板一次授权一次发送。
- 微信支付回调挂在 `express.json()` 之前是为了拿原始 body；快递100 回调是普通 form 验签，**应挂在全局解析中间件之后**。

---

## 2. 总体架构

```
小程序                          服务端 (Express)                         外部
封面 ─┬─ 全国邮寄 → 现有页面      routes/products,categories (+channel)
      └─ 同城配送 → pages/local/*  routes/local.ts   (meta/quote)          ┌ 快递100 同城急送
             │                    routes/orders.ts  (LOCAL 分支)           │  batchPrice/batchOrder/order
             │ 地图选点(GCJ-02)    routes/kd-callback.ts  ◄────────────────┤  precancel/cancel/addfee/queryCourier
             │                    services/delivery/                      │  callback(POST form)
后台 admin   │                      ├ provider.ts  (接口)                  └ 微信支付/订阅消息(现有)
 同城订单看板 ─┤                      ├ kuaidi100.ts (实现)
 同城设置     ─┤                      ├ self.ts      (店员自送)
 分类/商品渠道Tab                     ├ mock.ts      (本地/e2e，可注入异常)
                                     └ index.ts     (编排: 呼叫/回调/取消/加费/自送/送达/认领)
                                  services/local-settings.ts (门店/范围/运费/营业/暂停)
 工作台 /workbench ────────────── routes/admin/workbench.ts (snapshot)
 打印机设置 ───────────────────── services/ticket/ (printer.ts 接口 / feie.ts / mock.ts) ──► 飞鹅云打印(出票+语音)
                                  services/scheduler.ts (+7 个同城任务 +3 个出票任务)
```

设计原则
1. **渠道是一等维度，订单状态机只允许一个例外。** 同城订单复用 `Order.status`，退款/售后/迟到支付/订阅消息原样可用；即时配送细粒度状态放 `Delivery`。唯一例外：运力取消（720）时 `SHIPPED → PREPARING` 回退，条件见 §5.3。
2. **运力可插拔，但快递100 是上线必要条件。** `DeliveryProvider` 下 `KD100 / SELF / MOCK`。
   日常主力是第三方骑手（快递100 并呼），**默认运力 `KD100`**；`SELF`（店内自送）是**常规备选**
   而非降级兜底——对小城市单店每周都可能用到：高峰期无人接单、近距离单（骑手费 ¥5–8 而自己走两步就到）、
   余额用尽未及时充值、骑手取消或改派失败。
   **连带后果：M1 完成后不能单独上线同城通道，必须等 M2 + 快递100 联调通过。**
3. **金额全部服务端算，且 LOCAL 与 EXPRESS 两套计费互不叠加。** 距离 = Haversine 直线 × `detourFactor`（默认 1.35）。
4. **回调驱动 + 主动兜底 + 可对账。** 每张配送单在外呼前先落库（含商户单号 `deliveryNo` 与 `salt`），回调按 `taskId` 或 `deliveryNo` 双路查找；事件先落库再推进状态机；状态单调；无回调靠定时任务提醒，不自动改状态。
5. **花钱的操作有上限、有审计、有二次确认。**

### 2.1 地图能力与费用（2026-09-03 核实）

本方案**不申请腾讯位置服务 key，不产生任何地图费用**。对照如下：

| 需要的能力 | 用什么 | 需要腾讯 key | 费用 |
|---|---|---|---|
| 顾客选收货位置 | `wx.chooseLocation`（**微信原生 API**，非腾讯 LBS 插件） | 否 | 0 |
| 地址文字 + 坐标 | chooseLocation 直接返回 `name/address/latitude/longitude` | 否 | 0 |
| 计费距离 | 服务端 Haversine × `detourFactor` | 否 | 0 |
| 配送费 | 服务端阶梯公式 | 否 | 0 |
| 骑手位置数据 | 快递100 `queryCourier` 返回经纬度 | 否 | 含在配送费内 |
| 商家设门店坐标 | `wx.chooseLocation`（店主在地图上点自家店） | 否 | 0 |

刻意避开的付费能力：**路网距离/距离矩阵 API**（改用直线 × 绕路系数）、**逆地理编码**（chooseLocation 已给坐标）、**后台网页嵌地图 JS API**（改为手填坐标 + 外链腾讯地图核对）、**腾讯位置服务地图选点插件**（改用微信原生 API）、**个性化地图样式**（2023-06-29 起需购买）。

`<map>` 组件的商业授权条款原文有前置条件：「**若开发者使用通过 LBS 开放平台自行申请的服务账号**，在小程序连接并调用位置服务产品用于商业行为…腾讯位置服务有权收取商业授权费」。我们不申请该服务账号、不调用 LBS 产品，不触发该条件。另：即便日后要用 WebService API，认证企业免费额度为 **10000 次/日**，单店日均几十单永远用不满——"高额年费"针对的是日调用百万级应用。

**D9（2026-09-03 用户决策）**：骑手实时位置地图**保留在首期**（曾建议移入二期，用户否决）。§3.1.7 / §5.9 `GET /orders/:id/courier` / §6 `<map>` + 30s 轮询全部按原方案实施。

配套的 M3 前置检查项（必须在写地图页面前做掉，10 分钟）：
1. 微信开发者工具新建一个只含 `<map latitude longitude markers>` 的空白页，**不配置任何腾讯位置服务 key**，看能否正常渲染、Console 有无 key 相关报错或水印提示。
2. 真机预览同一页面确认一致（模拟器与真机的地图实现不同）。
3. 若出现 key 相关限制：改用 `cover-view` 静态方案（门店/顾客两点 + 文字距离），或由用户去 lbs.qq.com 申请个人开发者 key（免费额度足够单店，`<map>` 组件本身不消耗 WebService 配额）。**不要因为这一项阻塞 M3 其余部分。**

结论依据见上表：`<map>` 的商业授权条款前提是"使用自行申请的 LBS 服务账号"，我们不申请；组件文档中明确标注收费的只有**个性化地图样式**（2023-06-29 起需购买），我们不用。

---

## 3. 业务流程（端到端）

### 3.1 顾客侧
1. **进入**：封面「同城配送」→ `pages/local/index`。页头：门店名、营业状态（营业中 / 已打烊·HH:mm 营业 / 暂停接单·原因）、配送范围、起送、运费规则摘要。地址条：默认同城地址 → 「配送至 xx · 约 x.x km · 运费 ¥y」，无地址 → 「选择收货地址」。`enabled=false` 时页面显示「同城配送即将开通」并给「去全国邮寄」按钮。
2. **选品**：左分类（`channel=LOCAL`）右商品；`sku-popup` 加购，toast 文案「已加入同城购物车」；底部同城购物车条（件数/小计/差额起送/去结算，可展开改数量）。tabBar 购物车页空态时若检测到 LOCAL 购物车有货，显示「你在同城配送还有 N 件未结算 →」。
3. **地址**：`pages/local/confirm` 地址卡 → `address/list?mode=select&channel=LOCAL`（显示距离标签；无坐标地址置灰「补充定位」）→ `address/edit?channel=LOCAL`：**必须地图选点**（`wx.chooseLocation`）；省/市固定为门店所在省市（来自设置），区从 POI 地址粗解析并允许修改，POI 名 + 门牌楼层 + 姓名电话。授权处理复用 `edit.js:78-84` 范式：用户取消 = 静默；拒绝权限 = 引导 `wx.openSetting`。首次调用位置接口前触发官方隐私弹窗（见 §6）。
4. **报价**：选中地址即调 `POST /local/quote` → 距离、运费、起送差额、是否超范围、预计送达时间、`quoteToken`。超范围/打烊/暂停时提交按钮禁用并给出路：「换个地址」「改选全国邮寄」按钮。
5. **附加项**：备注（占位「如需餐具、放门口等请注明；备注会同步给骑手」）、「需要餐具」勾选（拼进备注前缀，满足限塑合规最低要求）。
6. **下单**：`POST /orders { deliveryType:'LOCAL', cartItemIds, addressId, remark, quoteToken }`。服务端：渠道双向一致性、`enabled && !paused && isOpenNow`、地址坐标、范围、起送、最大件数/重量、阶梯运费（`quoteToken` 防漂移，见 §5.2）、坐标/POI/距离/预计送达快照。支付流程不变。
7. **等待**：订单详情同城分支：时间线「已付款 → 商家接单 → 骑手已接单(姓名/运力) → 骑手到店 → 配送中 → 已送达」；异常态（515/510/720/UNKNOWN）显示中性文案「配送正在协调中，如超过预计时间请联系商家」；骑手接单后显示 `<map>`（门店/顾客/骑手），每 30s 轮询 `GET /orders/:id/courier`，`onHide/onUnload` 或配送单终态即停止。「联系骑手」「联系商家」拨号。
8. **取消/退款（D6）**：`PAID` 未接单 → 「申请退款」秒退（现有）；`PREPARING` 且 `now < acceptedAt + acceptGraceMin` → 「申请取消」（写 `cancelRequestedAt` + 推送店员，订单状态不变，店员确认全额退）；超过窗口 → 按钮消失，显示「订单已开始制作，如有问题请联系商家」；`SHIPPED/COMPLETED` → 「申请售后」（现有，原因新增「配送超时 / 未收到餐」）。详情页在接单时明确提示「接单后 5 分钟内可申请取消」。
9. **收货**：520 → `COMPLETED`。

### 3.2 商家侧（后台 `/local/orders` 看板，手机 web-view 同样可用）
1. **来单**：推送「🛵 同城新订单」（距离、地址、商品、备注、预计送达）；看板「待接单」+ 铃铛徽标 `localPendingCount`。
2. **接单（D5）**：「接单」= `PAID → PREPARING`，只标记开始备餐（与邮寄语义一致）；旁边「接单并呼叫」一键完成两步；设置 `autoCallDelayMin > 0` 时接单后倒计时自动呼叫，卡片显示「N 分钟后自动呼叫 · 立即呼叫 / 取消自动」。
3. **呼叫**：「呼叫骑手」→ 先落 `Delivery(PENDING→CALLING)` 再外呼 `batchOrder`；失败按错误码分流（§5.4）：可重试自动退避 2 次；余额不足熔断 + 红条；超时 → `UNKNOWN` + 「认领 / 作废」按钮。
4. **骑手接单**（100）：显示骑手姓名/电话/运力；「联系骑手」「加小费」（单次 ≤ ¥20、单笔订单累计 ≤ ¥50，二次确认，记录操作人）。
5. **到店**（210/230）：卡片提示「骑手已到店，请交餐」。
6. **配送中**（310）：`Order → SHIPPED`，发一条订阅消息「配送中」。
7. **送达**（520）：`Order → COMPLETED`，记录 `actualFee`。
8. **异常处理（D4，看板「异常」Tab + 推送店员）**，主按钮 = 推荐路径：
   - 待抢单超 `callTimeoutMin`（默认 10）：**主按钮「加小费重呼」**；次按钮依次为「重新呼叫」（cancel 后同一运力列表再 `batchOrder`）、「店内自送」、「联系顾客后退款」。这个优先级顺序维持不变；「店内自送」在此处也须直接可见，不进二级菜单。
   - 720 运力取消：配送单置 CANCELLED，订单按 §5.3 规则回到 PREPARING 待呼叫或告警人工。
   - 515 改派中：提示等待，无需操作。510 异常：推送店员 + 老板告警，人工处理。
   - 配送中超 `deliveringTimeoutMin`（默认 120）：告警一次；店员可「标记已送达」。
   - UNKNOWN（下单响应超时）：推送「请到快递100 后台核对是否已产生真实单」；收到回调自动认领；店员可手动「作废」。
9. **取消并退款（引导式单弹窗）**：第 1 步显示预计取消费（`precancel`）→ 确认取消配送 → 第 2 步进入 `RefundDialog`（预填全额，显示 顾客运费 / 运力报价 / 小费 / 取消费 参考行）→ 两次确认。骑手已取餐（SHIPPED）后只允许店员手输金额（协商/部分）。
10. **自送模式（常规备选，UI 必须一眼可见）**：「店内自送」一步弹窗填自送人姓名+电话 → 直接 `SHIPPED`
    （Delivery provider=SELF）→ 「已送达」→ `COMPLETED`。
    **位置要求**：在「备餐中 / 待呼叫」卡片上，「呼叫骑手」为主按钮，**旁边并排一个「自己送」次按钮**；
    异常标签页里同样保持一眼可见。**不要把它收进「更多」菜单**——这是每周要用几次的操作，
    收进二级菜单等于每次多点两下。默认运力设为 `SELF` 时，主按钮直接变成「自己送」。
11. **临时暂停**：设置页/看板顶部「暂停接单」开关（原因文案 + 恢复时间可选），顾客端同步显示；与总开关、营业时段独立。

### 3.3 与全国邮寄的隔离
- 现有 `/admin/orders` 默认 `deliveryType=EXPRESS`，页面标题改「邮寄订单」；同城单只在 `/local/orders`。`pending-count` 增加 `localPendingCount`。
- 顾客「我的订单」混排 + 渠道标签；详情页按 `deliveryType` 分支。
- tabBar 不变；同城菜单页独立入口，自带购物车条。
- 商品详情、Banner 跳转、扫码落地页带渠道上下文：LOCAL 商品详情页只提供「去同城下单」，禁止加入邮寄购物车；反之亦然。

---

## 4. 数据模型（迁移 `20260904000000_local_delivery`，结构定稿后一次落库）

坐标统一用 **Int 微度**（`latE6 = round(lat × 1e6)`），与全项目「金额用分」风格一致，避免 Prisma Decimal 序列化成字符串。

```prisma
model Category {
  channel   String @default("EXPRESS") @db.VarChar(16)   // EXPRESS | LOCAL
  @@index([channel, status, sortOrder])
}

model Product {
  channel    String @default("EXPRESS") @db.VarChar(16)  // 冗余自分类，仅 services/product-channel.ts 一个函数写入
  netWeightG Int?   @map("net_weight_g")                  // 净重(克)，同城换算 kg；空用设置默认值
  // deliveryType 保留列、标 @deprecated；后台移除单选
  @@index([channel, status])
}

model Address {
  latE6   Int?    @map("lat_e6")      // GCJ-02 微度；LOCAL 下单必填
  lngE6   Int?    @map("lng_e6")
  poiName String? @map("poi_name") @db.VarChar(128)
}

model Order {
  receiverLatE6       Int?      @map("receiver_lat_e6")
  receiverLngE6       Int?      @map("receiver_lng_e6")
  receiverPoiName     String?   @map("receiver_poi_name") @db.VarChar(128)
  distanceM           Int?      @map("distance_m")            // 直线×detourFactor 后的计费距离
  estimatedDeliveryAt DateTime? @map("estimated_delivery_at")
  cancelRequestedAt   DateTime? @map("cancel_requested_at")   // D6 ② 顾客申请取消
  cancelRequestNote   String?   @map("cancel_request_note") @db.VarChar(255)
  cancelRequestDeliveryStatus String? @map("cancel_request_delivery_status") @db.VarChar(16)  // 申请时有效配送单状态快照，NONE=无单；决定全额/手输
  deliveries          Delivery[]
}

// 同城配送单。同一订单可有多张（重呼/换运力），但同一时刻只一张有效：activeOrderId 与 Refund 同款做法
model Delivery {
  id              Int       @id @default(autoincrement())
  orderId         Int       @map("order_id")
  orderNo         String    @map("order_no") @db.VarChar(32)
  deliveryNo      String    @unique @map("delivery_no") @db.VarChar(32)   // 商户单号 D<orderId>-<seq>，传给快递100，回调回退查找键
  activeOrderId   Int?      @unique @map("active_order_id")              // 有效时 = orderId，终态置 NULL；普通 Int 列，不是关系字段
  provider        String    @db.VarChar(16)   // KD100 | SELF | MOCK
  // PENDING CALLING(0) ACCEPTED(100) ARRIVING(210) ARRIVED(230) DELIVERING(310) REASSIGNING(515)
  // ABNORMAL(510) DELIVERED(520) CANCELLED(720/商家取消) FAILED(下单明确失败) UNKNOWN(下单响应超时,待认领)
  status          String    @db.VarChar(16)
  statusRank      Int       @default(0) @map("status_rank")   // 单调更新用：updateMany where statusRank < new
  providerStatus  Int?      @map("provider_status")
  statusDesc      String?   @map("status_desc") @db.VarChar(255)
  providerTaskId  String?   @unique @map("provider_task_id") @db.VarChar(64)
  providerOrderId String?   @map("provider_order_id") @db.VarChar(64)
  courierCompany  String?   @map("courier_company") @db.VarChar(32)   // kuaidicom；SELF 时为空
  courierName     String?   @map("courier_name") @db.VarChar(64)
  courierMobile   String?   @map("courier_mobile") @db.VarChar(20)
  callbackSalt    String    @map("callback_salt") @db.VarChar(20)     // 外呼前生成
  quotedFee       Int?      @map("quoted_fee")      // 分，下单返回 discountFee
  actualFee       Int?      @map("actual_fee")
  tipFee          Int       @default(0) @map("tip_fee")
  cancelFee       Int       @default(0) @map("cancel_fee")
  providerDistanceM Int?    @map("provider_distance_m")
  errorCode       String?   @map("error_code") @db.VarChar(16)
  failReason      String?   @map("fail_reason") @db.VarChar(255)
  calledAt / acceptedAt / pickedUpAt / deliveredAt / cancelledAt  DateTime?
  cancelReason    String?   @map("cancel_reason") @db.VarChar(255)
  lastCallbackAt  DateTime? @map("last_callback_at")
  callTimeoutRemindedAt DateTime? @map("call_timeout_reminded_at")
  acceptedStuckRemindedAt DateTime? @map("accepted_stuck_reminded_at")
  deliveringRemindedAt  DateTime? @map("delivering_reminded_at")
  operator        String?   @db.VarChar(64)         // 发起呼叫/自送的管理员
  createdAt / updatedAt
  order  Order @relation(fields: [orderId], references: [id])
  events DeliveryEvent[]
  @@index([orderId])
  @@index([status, calledAt])
}

model DeliveryEvent {
  id                 Int      @id @default(autoincrement())
  deliveryId         Int      @map("delivery_id")
  dedupeKey          String   @unique @map("dedupe_key") @db.VarChar(64)  // sha1(deliveryId|providerStatus|updateTime ?? sha1(rawBody))；ADMIN/SCHEDULER 用 uuid
  source             String   @db.VarChar(16)   // CALLBACK | API | ADMIN | SCHEDULER
  providerStatus     Int?     @map("provider_status")
  statusDesc         String?  @map("status_desc") @db.VarChar(255)
  courierName        String?  @db.VarChar(64)
  courierMobile      String?  @db.VarChar(20)
  providerUpdateTime String?  @map("provider_update_time") @db.VarChar(32)
  operator           String?  @db.VarChar(64)
  latencyMs          Int?     @map("latency_ms")
  rawPayload         Json?    @map("raw_payload")   // 验签失败不落；保留 90 天
  createdAt          DateTime @default(now())
  delivery Delivery @relation(fields: [deliveryId], references: [id])
  @@index([deliveryId, createdAt])
}
```
所有回调字符串入库前 `slice()` 到列宽。`Shipment` 表 LOCAL 订单**不写行**。

**设置**（`Setting` key `local_delivery`，`services/local-settings.ts`，含 `version` 递增用于缓存失效与 quoteToken）：
```ts
interface LocalDeliverySettings {
  version: number
  enabled: boolean                     // 默认 false；开启前完整性校验（坐标/半径/运费/≥1 营业时段）
  paused: { until: string | null; reason: string } | null   // 临时暂停
  store: { name, phone, province, city, district, address, latE6, lngE6 }
  radiusKm: number                     // 配送半径，按计费距离（直线 × detourFactor）判定；设置页实时显示换算后的直线值，顾客端页头展示直线口径 radiusKm/detourFactor
  detourFactor: number                 // 默认 1.35
  fee: { baseFee, baseKm, perKmFee, freeThreshold, minOrderAmount }   // 分 / 公里
  businessHours: Array<{ start: 'HH:mm'; end: 'HH:mm' }>   // 首期禁止跨零点、禁止重叠；Asia/Shanghai
  prepMinutes: number; riderSpeedKmh: number                // 预计送达估算，默认 15 / 15
  acceptGraceMin: number               // D6 ②，默认 5
  autoCallDelayMin: number             // 0=手动（默认）
  // 默认 'KD100'（日常主力）；'SELF' 是常规备选，看板上可逐单切换
  defaultProvider: 'KD100' | 'SELF'
  kd100: { providers: string[]; goodsType: '食品'; defaultItemWeightG: number /*默认 300*/; insurance: boolean; autoDowngradeToSelfOnNoBalance: boolean }
  limits: { maxItems: number /*默认 30*/; maxWeightKg: number /*默认 10*/ }   // 超出提示拆单/电话
  callTimeoutMin: number; acceptedStuckMin: number; deliveringTimeoutMin: number   // 10 / 30 / 120
  tip: { maxPerCall: number; maxPerOrder: number }         // 2000 / 5000 分
}
```
密钥走 env：`KD100_KEY`、`KD100_SECRET`、`LOCAL_DELIVERY_PROVIDER_MOCK=true`（生产开启拒绝启动）。
回调地址**不再是一个 env 常量**——它按单拼成 `PUBLIC_BASE_URL + '/api/kd/' + deliveryNo`（见 §5.5）；启动时用最坏值 `D999999-99` 断言总长 ≤ 50，生产超长 `process.exit(1)`。

---

## 5. 服务端：核心规则（写死，不留给实施临场决定）

### 5.1 渠道一致性
- 双向规则：下单所有行 `product.channel === (deliveryType==='LOCAL' ? 'LOCAL' : 'EXPRESS')`，否则 42224。`POST /cart` 同样校验并返回 `channel`。
- `GET /products`、`GET /categories`、`GET /cart` 增加 `channel` 参数，**默认 `EXPRESS`**（现有小程序零改动）；`GET /products/:id` 返回 `channel`。
- `product.channel` 只在 `services/product-channel.ts` 的一个函数里写，与 `categoryId` 同事务读取 `category.channel`。分类改渠道：同事务级联更新旗下商品 channel + 删除相关购物车行；存在该分类商品的未支付订单则拒绝。批量开档/收档按渠道。
- `scripts/check-channel-consistency.mjs` 只读校验（product.channel = category.channel），接进 e2e。

### 5.2 LOCAL 下单计费
- `createOrder` 按 `deliveryType` 分派两套实现：EXPRESS 走 `settings.ts`（不变）；LOCAL 走 `local-settings.ts`，**不调用** `getShippingSettings/calcShippingFee`。
- `distanceM = haversine(store, receiver) × detourFactor`；`> radiusKm` → 42220；`subtotal < minOrderAmount` → 42210；`fee = baseFee + max(0, ceil(km − baseKm)) × perKmFee`；`freeThreshold>0 && subtotal>=freeThreshold → 0`。
- `POST /local/quote` 返回 `quoteToken = HMAC(fee|distanceM|settings.version|addressId|exp)`（TTL 5 分钟）。下单实收 `fee = min(token.fee, 重算 fee)`；仅当 `重算 fee > token.fee` 时返回 42227「配送费已更新，请刷新」。`settings.version` 只用于审计排障，**不作废在途 token**（设置页提示「运费改动后 5 分钟内下单的订单仍按旧价执行」）。
- 预计送达：下单时 `estimatedDeliveryAt = now + prepMinutes + 骑行时间`；呼叫成功时按 `now + 骑行时间` 重算一次；顾客端显示 15 分钟区间文案「预计 18:40–18:55 送达」。
- 快递100 参数：`weight = max(0.5, Σ(netWeightG ?? default) × qty / 1000)`；`price = 商品小计(元)`；`goods = [{name:'凉菜', type:'食品', count: 总件数}]`；`remark = 顾客备注 + 餐具标记`；`insurance` 按设置。

### 5.3 状态机（Order × Delivery）
Delivery 状态 rank：`PENDING 0 < CALLING 10 < ACCEPTED 20 < ARRIVING 30 < ARRIVED 40 < DELIVERING 50 < DELIVERED 100`；`REASSIGNING / ABNORMAL / CANCELLED / FAILED / UNKNOWN` 为旁路态。终态集合 `TERMINAL = {DELIVERED, CANCELLED, FAILED}`。
- 正向推进一律 `updateMany({ where: { id, statusRank: { lt: newRank }, status: { notIn: TERMINAL } }, data: { status, statusRank: newRank, ... } })`，终态粘住，迟到的 310 不能复活已取消/已完成的单。
- 旁路态写入只更新 `status / providerStatus / statusDesc / 时间戳`，**不写 `statusRank`**；因此 UNKNOWN 被认领后 rank 仍停在 CALLING(10)，后续 100 回调可正常推进。
- **N8 特例（REASSIGNING 回拨 ACCEPTED）**：`515`（改派中）是旁路态，不写 rank；改派成功后运力方会再推一条 `100`（新骑手接单）。这条 `100` 按 rank 单调规则的常规匹配（`statusRank:{lt:20}`）会落空——Delivery 早已离开 rank 序列，停在旁路态。因此专开一条二次匹配兜底：常规更新 `moved===0` 且 `providerStatus==='100'` 时，再尝试 `updateMany({ where: { id, status: 'REASSIGNING' }, data: { status: 'ACCEPTED', statusRank: 20, acceptedAt: now, ... } })`，把 rank 从旁路态显式「拨回」20（实现见 `callback.ts` rank 分支）。
- **唯二回拨**：全系统只有两处允许状态往回走——① 上一条 N8（Delivery.status 从 REASSIGNING 回拨 ACCEPTED，rank 数值本身唯一的回落路径）；② 下表 720 行（Order.status 从 SHIPPED 回退 PREPARING）。除此之外一律单调推进；其余「想回退」的诉求（例如骑手已到店后要求退回呼叫中）一律走「取消旧单 + 重新呼叫」而不是状态倒转。
- **总则**：Delivery 进入 TERMINAL 的任何路径（520、720、商家取消、作废、标记送达），同一条 update 内一并 `activeOrderId = null`。

Order 侧写入一律 `updateMany({where:{id, deliveryType:'LOCAL', status:{in: 白名单}}})` 判 count，命中 0 只记事件 + 告警：
| 触发 | Order 前置白名单 | 结果 |
|---|---|---|
| 310 配送中 | `PREPARING` | `SHIPPED`（不写 Shipment；订阅消息用内存伪 shipment） |
| 520 已完成 | `SHIPPED`, `PREPARING`(漏 310) | `COMPLETED` + `completedAt`；释放 `activeOrderId` |
| 720 运力取消 | `SHIPPED` 且 无在途 Refund、无 PENDING/APPROVED AfterSale、`completedAt` 为空 | Delivery=CANCELLED 并释放 `activeOrderId`；Order → `PREPARING`（**唯二回拨之二**，另一处见上文 N8）+ 推送店员；清空该订单 uncalled 提醒标记；**不再自动呼叫，转人工** |
| 720 其他情况（PREPARING 阶段被取消、或 SHIPPED 但有在途退款/售后/已完成） | — | Delivery=CANCELLED 并释放 `activeOrderId`；PREPARING 阶段推送店员待人工重呼；其余告警人工 |
| 店内自送 | `PREPARING` | `SHIPPED` |
| 标记已送达 | `SHIPPED` | `COMPLETED`；释放 `activeOrderId` |
| 作废配送单 | 任意 | Delivery=CANCELLED/FAILED，释放 `activeOrderId` |

- 共享的邮寄端点 `POST /admin/orders/:id/ship | complete | accept` 一律加 `deliveryType:'EXPRESS'` 前置，命中 LOCAL 返回 42204「同城订单请在同城看板操作」（否则会写出 `Shipment` 行破坏「LOCAL 无 Shipment」不变式）。
- `autoCompleteShippedOrders` 不受影响（LOCAL 无 Shipment）；`remindUnacceptedOrders` 对 LOCAL 用独立阈值（5 分钟）与文案。
- M1 迁移前核对历史数据：`select delivery_type, count(*) from orders group by 1` 必须只有 EXPRESS（zod 早已接受 LOCAL/PICKUP，需确认为零）。

### 5.4 呼叫、下单超时认领与错误分流
1. 事务内创建 `Delivery(status=PENDING→CALLING, deliveryNo, callbackSalt, activeOrderId=orderId)`；P2002 = 已有有效单 → 42228。
2. 事务外外呼 `batchOrder`（8s 超时）。成功 → 写 `providerTaskId/providerOrderId/quotedFee/providerDistanceM`。
3. 明确失败：`30001/30002/30003/30006` → `FAILED` + 老板告警（配置问题）；`30005` → 自动退避重试 2 次（1s/3s）后 `FAILED` + 店员推送；`30004` → `FAILED` + 熔断标志（运行期，看板红条，后续呼叫直接拒绝直至店员点「已充值，恢复」）+ 老板告警；设置 `autoDowngradeToSelfOnNoBalance` 开启时看板提示改自送。
4. 超时/网络错误 → `UNKNOWN` + 告警；店员可「作废」；定时任务 3 分钟未认领再提醒一次。
   **幽灵单在本设计下基本不成立**：`deliveryNo` 在**发出下单请求之前**就已经写进 `callbackUrl`（`/api/kd/{deliveryNo}`），所以即使 `order` 请求超时、拿不到 `taskId`，运力方的回调仍会带着这个 URL 打回来，按 path 里的 `deliveryNo` 就能直接命中本地记录并回填 `taskId/providerOrderId`。`UNKNOWN` 状态保留（下单响应超时先落它），但认领路径是确定性的，不再依赖猜测。
5. 「重新呼叫」= 旧单 `cancel`（记 cancelFee）→ 旧单终态释放 → 新建单再 `batchOrder`。

### 5.5 回调 `POST /api/kd/:deliveryNo`

**回调 URL 形态（定稿）**：`{PUBLIC_BASE_URL}/api/kd/{deliveryNo}`
- 生产示例：`https://api.yuegui-hotel.online/api/kd/D123456-1` = **48 字符**
- 最坏情况：`https://api.yuegui-hotel.online/api/kd/D999999-99` = **49 字符**（上限 50，安全）
- `deliveryNo` 维持 `D<orderId>-<seq>`，`orderId` 按六位预算。
- 走 `/api/` 前缀，**nginx 现有反代即可，不需要新增 location**。
- **启动校验**：断言 `PUBLIC_BASE_URL + '/api/kd/' + 'D999999-99'` 长度 ≤ 50；生产环境超长直接 `process.exit(1)`（与 COS 缺配置的处理方式一致）。域名一旦换长就会在部署时立刻暴露，而不是等到某笔订单的回调被运力方静默丢弃。
- **余量只有 1 个字符，这不是宽松预算**（控制器已验算）：
  | URL | 长度 |
  |---|---|
  | `…/api/kd/D123456-1` | 48 |
  | `…/api/kd/D999999-99`（最坏） | 49 |
  | `…/api/kd/D9999999-999` | 51 ✗ |
  推论与约束：当前域名 `api.yuegui-hotel.online` 占 23 字符，**域名上限是 24 字符**——换任何更长的 API 域名都会顶破，启动断言会拦住但也会拦住整个服务，所以换域名时必须同步缩短路径前缀（例如 `/api/k/`）。同理，`orderId` 到七位（百万单）或 `seq` 到三位（同一单重呼 100 次）也会溢出；前者对单店是几十年后的事，后者不可能发生，但都由那条启动断言与 `deliveryNo` 生成处的长度校验兜住。

**应答语义（N5，终版；与微信支付回调相反）**
微信支付回调失败可以返非 200 促使微信重推，因为商户随时能反查订单状态——重推不重推，`GET /api/orders/:id` 永远能对齐真相。快递100 **没有等价的查单接口**（`queryCourier` 只查骑手坐标，不查配送单状态），回调是唯一事实来源；对它返回非 200 会让快递100 停止重推，一旦这次回调被我方吞掉，这个状态转移就**永久丢失**，没有第二次机会补救。所以应答规则反过来：
- **仅「数据库入库异常」返 `500`**（`prisma.$transaction` 内部抛出，捕获到 `handleKdCallback` 顶层 catch）——这是让快递100 重推的唯一诉求，出现的场景只可能是 `UNKNOWN` 认领时 `providerTaskId` 撞了另一条配送单的唯一索引之类的真实数据异常（事件表自身的 `dedupeKey` 重复早被 `recordDeliveryEvent` 内部的 P2002 吞掉，不会抛到这层）。
- **其余一切情形一律 `200`**（`{result:true/false, returnCode, message}`，`result` 字段仅供人工核对，不影响快递100 是否重推）：查不到配送单（可能是占位落库失败的孤儿单，告警走人工核对而非等重推）、验签失败（重推同一份坏签名毫无意义）、并呼假撤单（未中标运力的 720）、事件已存在的重复回调、状态回退的乱序迟到包、`PROVIDER_STATUS_MAP` 未收录的未知状态码——统统落痕/告警后原地 200，绝不让快递100 因为我方一次可重试的失误而对同一次状态转移无限重推。
- 三级查找、验签、状态推进的具体顺序见下方「实现要点」；任何一步的失败结果都汇入上面两条规则之一，不单独定义第三种应答。

**实现要点**
- 路由自带 `express.urlencoded({ extended:false, limit:'64kb' })`（全局中间件不动），放在公开区；IP 限流（复用 `rate-limit.ts` 写法）。
- 三级查找：① **URL path 里的 `deliveryNo`**（最可靠，下单前就已确定，白名单 `^D\d{1,10}-\d{1,3}$`）→ ② `taskId`（白名单 `^[A-Za-z0-9_-]{1,64}$`）→ ③ `param.orderId == providerOrderId`。三者皆未命中 → 200 + 限频告警，不落 rawPayload。
  （原设计里「按 salt 逐个试签认领最近 2 小时的 CALLING/UNKNOWN 记录」这一兜底**已删除**：`deliveryNo` 进 URL 后不再需要靠猜。）
- 验签 `MD5(param + salt)` 大小写归一 + `timingSafeEqual`；失败 200，不落状态、只留一条验签失败事件 + 限频告警。
- 顺序：先 `findUnique(deliveryNo)` 查单 → 验签 → 并呼假撤单过滤（未中标运力的 720）→ 单事务 [insert event（`dedupeKey` 冲突 = 重复，P2002 吞掉直接短路返 200）→ 推进 Delivery/Order 状态机] → 事务后才发通知（放事务里发，遇回滚会误报）。事务整体失败（入库异常）→ 唯一的 500；事务内部「推进」这一步命中 0 行（乱序/迟到/未知状态）不算失败，只是不动状态，仍是 200。
- 字符串截断到列宽；`latencyMs = now − updateTime`。

### 5.6 退款与配送单（D6）
- 42221「请先取消配送单」的校验放在**入口**：`POST /admin/orders/:id/refund`、售后 approve、`PUT /orders/:id/cancel`，在任何状态流转**之前**；条件 = 存在有效 Delivery（`activeOrderId` 非空）且 `order.status ∉ {COMPLETED, REFUNDED}`。`initiateRefund` 内部仅当 `order.status !== 'REFUNDING'` 时再拦一层。错误文案指向「标记已送达 / 作废配送单」出口。
- 顾客「申请取消」（D6 ②）：`PREPARING && now < acceptedAt + acceptGraceMin` → 写 `cancelRequestedAt/Note` 并**快照 `cancelRequestDeliveryStatus`**（当时有效 Delivery 状态，无单则 `NONE`），订单状态不变，推送店员；看板卡片显示「顾客申请取消」徽标；店员走「取消并退款」引导。窗口外接口返回 42229。`cancelRequestedAt` 超 3 分钟未处理由 scheduler 再推店员一次。
- 金额规则的判定基准是**申请时的快照**而非店员点击时刻：快照 ∈ {NONE, PENDING, CALLING, ACCEPTED, ARRIVING, ARRIVED} → `RefundDialog` 预填全额（含配送费）且不可下调，理由「顾客在可取消窗口内申请」；快照 ∈ {DELIVERING, DELIVERED} 或非窗口内申请 → 店员手输金额。取消费/小费一律店铺承担，入 `Delivery` 对账；`RefundDialog` 显示参考行。
- 42221 文案同时指向三个出口：「取消配送单（骑手未取餐）」「标记已送达」「作废配送单」。

### 5.7 花钱与越权
- `POST /admin/local/orders/:id/tip`：`amount ≤ tip.maxPerCall` 且 `tipFee + amount ≤ tip.maxPerOrder`；admin 侧限流；记 `DeliveryEvent(source='ADMIN', operator)`；前端二次确认。取消配送、重呼、自送同样记 operator。
- `GET /orders/:id/courier`：`findFirst({id, userId})` 归属校验；Delivery 不在 `ACCEPTED..DELIVERING` 直接返回 null 不外呼；服务端按 orderId 缓存 20s；每用户限流。
- 顾客端 `GET /orders/:id` 的 `delivery` 用显式 `select` 白名单：`status, statusDesc(我方文案), courierName, courierMobile, courierCompanyLabel, acceptedAt, pickedUpAt, deliveredAt, estimatedDeliveryAt, events[{providerStatus, label, createdAt}]`。绝不返回 `callbackSalt/quotedFee/actualFee/cancelFee/providerTaskId/rawPayload`。

### 5.8 定时任务（新增 7 项，各自兜错，提醒均「每单一次」）
`localCallTimeout`（CALLING 超 callTimeoutMin）、`localUncalled`（PREPARING 无有效单超 20 分钟，计时基准 `max(acceptedAt, 最近一条 Delivery.cancelledAt)`）、`localAcceptedStuck`（ACCEPTED/ARRIVING/ARRIVED 超 acceptedStuckMin）、`localDeliveringStuck`（DELIVERING 超 deliveringTimeoutMin，老板告警）、`localGhost`（CALLING/UNKNOWN 且无 taskId 超 3 分钟）、`localCancelRequestPending`（顾客申请取消超 3 分钟未处理）、`localHousekeeping`（终态但 activeOrderId 未释放 → 释放 + 告警；`rawPayload` 超 90 天用 `Prisma.DbNull` 置空）。
自动呼叫（`autoCallDelayMin > 0`）由 scheduler 执行，前置条件全部满足才呼叫：`PREPARING`、无有效单、`acceptedAt + delay` 已到、未被店员「取消自动」、`cancelRequestedAt IS NULL`、**该订单历史 Delivery 记录数 = 0**（每单最多自动呼叫一次；720 回退后一律转人工，避免「呼叫→取消→自动重呼」循环产生取消费）。
设置保存校验：`autoCallDelayMin === 0 || acceptGraceMin <= autoCallDelayMin <= 15`（自动呼叫不得早于顾客免费取消窗口结束，否则窗口承诺自带取消费成本）。

### 5.9 接口清单
- 公开：`GET /local/meta`（设置公开子集 + `isOpen/nextOpenText/paused` + 门店坐标；独立于需登录的 `/orders/meta`，因菜单页需未登录可浏览）、`POST /local/quote`、`POST /api/kd/:deliveryNo`（回调，挂在 `/api/kd` 前缀下，路径见 §5.5；不是 `/api/local/*` 家族）。
- 用户态：`POST /orders`（LOCAL 分支）、`GET /orders/:id`（含 delivery 白名单）、`GET /orders/:id/courier`、`POST /orders/:id/cancel-request`（D6 ②）、`PUT /orders/:id/cancel`（加 42221 前置）。
- 管理：`GET /admin/local/orders?tab=&keyword=`（单层 Tab：待接单 / 待呼叫 / 呼叫中 / 骑手已接 / 已到店 / 配送中 / 异常 / 已完成 / 已取消退款）、`POST /:id/accept`、`POST /:id/accept-and-call`、`POST /:id/call`、`POST /:id/cancel-auto-call`、`POST /:id/tip`、`POST /:id/delivery/precancel`、`POST /:id/delivery/cancel`、`POST /:id/delivery/claim|void`、`POST /:id/self-deliver {name, phone}`、`POST /:id/delivered`、`GET /:id/delivery/events`、`POST /admin/local/circuit/reset`；`GET/PUT /admin/settings/local-delivery`、`PATCH .../store-location`（商家端一键定位）、`POST .../probe`（batchPrice 探测）、`POST .../pause`；`GET /admin/orders?deliveryType=`（默认 EXPRESS）；`pending-count` 加 `localPendingCount`。
- 非生产：`POST /admin/system/delivery-mock {orderId, scenario}`，场景由服务端用真实 salt 构造：`advance:<status>`、`out_of_order`、`replay_last_callback`、`callback_without_update_time`、`callback_bad_sign`、`oversized_status_desc`、`create_timeout_then_callback`（下单响应超时后回调仍按 deliveryNo 命中）、`error:30004`、`error:30005`、`cancel_after_delivering`（720 在 310 后）。

### 5.10 错误码
`42220` 超出配送范围 · `42221` 请先取消配送单 · `42222` 非营业时间 · `42223` 地址缺少定位 · `42224` 商品渠道不符 · `42225` 呼叫/取消配送单失败(附运力方原文) · `42226` 同城暂未开通/暂停 · `42227` 配送费已更新 · `42228` 已有进行中的配送单 · `42229` 已超过可取消时间 · `42230` 超出单次配送上限 · `42232` 快递100 余额不足已熔断（充值后系统状态页点「恢复」）· `42233` 无在途配送单 · `42234` 配送单状态不允许该操作（未成单/状态未确认/仅「状态未确认」可作废）· `42235` 小费超上限或非待抢单状态 · `42236` 加小费被运力拒绝/请求超时 · `42237` 配送单状态已变化请刷新（并发保护）· `42238` 取消请求超时、状态未变化。`42232`-`42238` 均在 `services/delivery/orchestrator.ts` 抛出，详见 `docs/api.md` 附录错误码表。

### 5.11 拒单（`POST /admin/orders/:id/reject`，实现于 M2，本节为原设计遗漏的补记）

原设计未单列拒单流程；实现落地时确认了两条与直觉不同的决策，此处补全，序号沿用整份计划的 Global Constraints 编号：

- **N3：两渠道通用**。拒单不是同城专属功能——`POST /admin/orders/:id/reject` 同时接受 EXPRESS 与 LOCAL 订单（唯一网关是订单状态，见下），挂在共享的 `routes/admin/orders.ts` 而非 `admin/local/orders.ts`。理由：店家在邮寄场景下同样会遇到「这道菜临时没了」「超出实际配送能力」等需要拒单的情况，没有必要为同一个业务动作维护两套端点。
- **N4：终态改为 `REFUNDED`，不是 `CANCELLED`**。已付款订单拒单时，走**全额** `initiateRefund`（而非直接把订单打成 `CANCELLED`），退款成功后订单终态是 `REFUNDED`。这样做是为了不破坏退款子系统的不变式——`initiateRefund` 自带幂等（同一订单不会有两条并行退款记录）、对账（`Refund` 表记录 `outRefundNo`/金额/操作人）、以及与微信退款回调的状态联动，都是围绕「退款」这个语义建的；如果拒单绕开它直接改 `status='CANCELLED'`，退了钱却没有 `Refund` 记录，对账和「一键退款」按钮的可见性判断都会对不上。`initiateRefund` 内部命中 §5.6 的 42221 前置（有在途配送单先拦），拒单因此天然复用了「先处理配送单再退款」这条护栏。
  待付款（`PENDING_PAYMENT`）订单没有钱可退，走原有的直接置 `CANCELLED` + 库存回滚路径，不牵扯退款子系统。
- **接口契约**：
  - 允许状态：`PENDING_PAYMENT` / `PAID` / `PREPARING`；`SHIPPED` 及以后（已出餐/在途）一律拒绝（42204），改走退款或售后。
  - Body：`{ reason: 'SOLD_OUT'|'OUT_OF_RANGE'|'PAST_ACCEPT_TIME'|'CUSTOMER_CANCEL'|'OTHER', note?, soldOutProductIds?: number[] }`；`reason='OTHER'` 时 `note` 必填；`reason='SOLD_OUT'` 时 `soldOutProductIds` 必须非空且都属于本订单商品。
  - 拒单原因原样拼进 `Order.cancelReason`（顾客可见）：`商家拒单：<原因中文><（note）>`。
  - **售罄联动下架**：勾选的商品在同一次请求里 `status: ON_SHELF → OFF_SHELF`；这是独立小事务，退款已是既成事实，下架失败只告警不回滚（不下架的话下一位顾客照样点得到，同样的拒单流程会再走一遍）。
  - 响应：`{ orderId, refund: <退款记录或 null>, offShelfCount, cancelReason }`。

---

## 6. 小程序（apps/miniapp）

- `app.json`：`pages/local/index`、`pages/local/confirm`；`requiredPrivateInfos: ["chooseLocation","getLocation"]`；`permission.scope.userLocation.desc`；启用 `__usePrivacyCheck__`，新增 `components/privacy-popup` + `wx.onNeedPrivacyAuthorization` 监听（`app.js`）。
- `pages/local/index` / `pages/local/confirm`：见 §3.1；运费/距离只展示 `quote` 结果，不本地计算。
- `pages/address/edit|list`：§3.1.3。
- `pages/order/detail`：同城分支时间线/骑手卡/`<map>`/轮询生命周期/异常中性文案/「申请取消」窗口按钮/「联系商家」/「申请售后」；隐藏快递卡。
- `pages/order/list`：渠道标签。`pages/cart/index`：空态同城提示。`app.js updateCartCount` 只统计 EXPRESS。
- `pages/merchant/index`：「用当前位置设为门店坐标」（`wx.getLocation gcj02` → `PATCH store-location`），标注为**推荐方式**。
- `config/legal.js`：隐私政策新增「位置信息（地图选点）」与「向第三方即时配送服务商（快递100 及其接入运力）提供收货人姓名、电话、地址、坐标」条款。
- 订阅消息：只在 310 发一条「配送中」；文案避免「单号:」，运力名进公司字段、骑手联系方式进备注类字段；M0 尝试申请专门「配送通知」模板，若沿用发货模板则字段映射由 env 控制；「骑手已接单」不推送；「已送达」若要做，须新增模板 ID 加入下单页 `requestSubscribe` 列表。
- 封面入口契约：同城 → `wx.navigateTo('/pages/local/index')`；全国邮寄 → `wx.switchTab('/pages/index/index')`。
- 预览台镜像：`local-index.html`、`local-confirm.html`、order-detail 同城态。

## 7. 后台（apps/admin）

- `Layout.tsx`：首项「工作台」（D8，见 §7b）、「同城订单」（徽标）、「同城设置」、「打印机」（§8b）。
- `pages/LocalOrders.tsx`：单层 Tab（§5.9）+ 数字徽标；卡片：等待时长分级色、地址+距离、商品、备注、配送单状态、骑手、费用参考（顾客运费/报价/小费/取消费）、「顾客申请取消」徽标、自动呼叫倒计时；按钮矩阵按 `order.status × delivery.status`；异常 Tab 主按钮「加小费重呼」；「取消并退款」引导式弹窗；**「自己送」与「呼叫骑手」并排常驻**（不进「更多」菜单）、一步弹窗；配送事件抽屉；余额熔断红条 +「已充值，恢复」；「暂停接单」快捷开关；15s 自动刷新。
- `pages/LocalSettings.tsx`：总开关（开启前完整性校验清单）；临时暂停；门店信息：推荐路径「在小程序商家端一键定位」三步图解，网页手填经纬度为高级选项，附「在地图中核对」外链（腾讯地图 URI，无需 key）+ 门店城市 bbox 粗校验（提示可能填反）；半径与 `detourFactor`；阶梯运费 + **按距离档（1/3/5 km/超范围）试算**；营业时段（禁跨零点/重叠校验）；备餐时长/骑行速度；`acceptGraceMin`；`autoCallDelayMin`；默认运力；快递100 运力勾选/默认重量/保价/余额不足降级；件数重量上限；小费上限；「运力覆盖探测」。
- `Categories.tsx` / `Products.tsx`：渠道 Tab；分类表单渠道；商品表单**移除单选配送方式**改只读渠道，同城商品加「净重(g)」；批量开档/收档按渠道。
- `Orders.tsx`：默认 EXPRESS，标题「邮寄订单」。`Dashboard.tsx`：按渠道拆行。
- `RefundDialog`：LOCAL 订单显示配送费用参考行；有有效配送单时引导先取消。

## 7b. 运营工作台（D8，`/workbench`，店员登录/web-view 默认落地页）

目标：店员不用翻 Tab 就知道「此刻该做什么」，同城单按时效驱动，邮寄单不打扰。

> **界面细则以 `docs/design/workbench-ui-spec.md`（v1，店主 2026-09-03 定稿）为准**，本节以下内容是早期架构草案，与 v1 定稿在列数/归类上有出入（例如 v1 是五列「待接单/备餐中/等待配送员/配送中/已完成」、同城邮寄混排同一套列而非「四列同城 + 侧栏邮寄」）——冲突时以 UI 规格文档为准，此处仅保留仍然成立的架构性决策（`snapshot` 接口、轮询节奏、与现有页面的关系）。
> **决策 N2**：「等待配送员」列 v1 **只放同城单**——同城 = `PREPARING` 且存在在途配送单（`Delivery.status ∈ {CALLING,ACCEPTED,ARRIVING,ARRIVED,REASSIGNING,ABNORMAL,UNKNOWN}`，异常留在本列变红而不单开列）；邮寄没有等价的「已打包待揽收」状态字段可区分于「备餐中」（`Order.status` 只有 `PREPARING` 一档，不像同城有 `Delivery` 子状态可用），因此邮寄单从「备餐中」录入运单号后直接跳「配送中」，不经过这一列。

**桌面布局（≥ md，早期草案，细节以 workbench-ui-spec.md 为准）**：
- 顶栏：营业状态/暂停开关、打印机状态灯（在线/离线/缺纸）、余额熔断红条、声音开关（首次需点击授权 AudioContext）、「新单 N」脉冲徽标。
- 主区四列（同城）：**新订单(待接单)** → **备餐中**（子状态胶囊：待呼叫 / 呼叫中 / 骑手已接 / 已到店，各带计时）→ **配送中** → **异常/待处理**（无人接单、720、UNKNOWN、顾客申请取消、余额不足、打印失败）。每张卡：等待时长大字倒计时（>5 分钟黄、>10 分钟红）、地址 + 距离、商品摘要、备注高亮、骑手信息、**一个主按钮**（该状态下的推荐动作：接单 / 呼叫骑手 / 联系骑手 / 加小费重呼 / 处理取消）+ 「更多」菜单（其余动作、重打小票、详情）。
- 右侧栏（邮寄）：待接单 / 待发货 / 售后待处理 三段计数 + 最近 5 单，点击跳 `/orders`。
- 底部：今日同城/邮寄单数与销售额、平均接单/送达时长。

**手机布局（< md，web-view）**：单列，顶部横向状态胶囊切换列（默认停在「新订单」，有异常时角标闪烁），卡片主按钮全宽；下拉刷新；新单到达时震动（`navigator.vibrate`）+ 响铃 + 顶部横幅。

**实时性**：`GET /admin/workbench/snapshot`（一次返回四列 + 侧栏计数 + 打印机状态 + 熔断标志，服务端 3s 缓存）每 10s 轮询；`visibilityState` 不可见时降到 60s；新单/异常数增加即播放提示音（新单与异常两种音效）；`document.title` 闪烁；桌面 `Notification`（复用 `usePendingOrders` 的三层退化）。二期可升级 SSE。

**与现有页面关系**：`Layout navItems` 首项改为「工作台」，登录与 `/m` 免登都落 `/workbench`；`Dashboard` 保留为统计页；`/local/orders` 保留为同城全量列表/搜索/历史；`/orders` 不变（邮寄）。工作台与列表页共用同一套 `LocalOrderCard` 与动作 hooks，避免两处按钮矩阵漂移。

## 8b. 出票与播报（D7）

**架构**：`services/ticket/printer.ts` 接口 `{ print(job), queryStatus(), queryJob(id) }`；首期实现 `feie.ts`（飞鹅云打印开放平台），预留 `xpyun.ts`；`mock.ts` 供本地/e2e。编排 `services/ticket/index.ts`：`enqueueOrderTicket(orderId, kind)`、`processQueue()`、`repeatAnnounce()`、`healthCheck()`。

**数据模型**（同一迁移）：
```prisma
model PrintJob {
  id            Int      @id @default(autoincrement())
  orderId       Int      @map("order_id")
  orderNo       String   @map("order_no") @db.VarChar(32)
  // NEW_ORDER 新单 | REPEAT 未接单重打 | CANCEL 取消/退款提醒 | REPRINT 手动重打 | TEST 测试页
  kind          String   @db.VarChar(16)
  provider      String   @db.VarChar(16)     // FEIE | MOCK
  printerSn     String   @map("printer_sn") @db.VarChar(32)
  // PENDING 待发送 | SENT 已提交(有平台单号) | PRINTED 已打印(回调/查询确认) | FAILED 失败(重试耗尽) | SKIPPED 打印机未配置
  status        String   @db.VarChar(16)
  providerJobId String?  @map("provider_job_id") @db.VarChar(64)
  attempts      Int      @default(0)
  lastError     String?  @map("last_error") @db.VarChar(255)
  content       String   @db.Text            // 最终票面（可重打、可审计）
  dedupeKey     String   @unique @map("dedupe_key") @db.VarChar(64)   // orderId|kind|seq
  sentAt / printedAt / createdAt / updatedAt
  @@index([status, createdAt])
  @@index([orderId])
}
```
**设置**（`Setting` key `printer`）：`{ enabled, provider:'FEIE', printers:[{sn, name, channels:['LOCAL','EXPRESS'], copies}], voice:{ enabled, localText:'您有新的同城订单', expressText:'您有新的邮寄订单' }, repeat:{ localAfterMin:2, expressAfterMin:5, everyMin:2, maxTimes:5, reprint:false }, offlineAlertMin:5, printCancel:true }`。密钥走 env：`FEIE_USER`、`FEIE_UKEY`、`FEIE_API_BASE`、`PRINTER_PROVIDER_MOCK=true`（生产开启拒绝启动）；打印机 SN/KEY 在后台绑定页录入（KEY 只用于绑定调用，不存明文，绑定后只留 SN）。

**触发点**：
- 付款成功（`orders.ts` mock 支付、`wechat-notify.ts` 真实回调）→ `enqueueOrderTicket(orderId,'NEW_ORDER')`（fire-and-forget，与 `notifyOrderPaid` 并列；打印不阻塞回调应答）。
- 全额退款成功 / 顾客申请取消 / 订单被取消 → `CANCEL` 提醒票（可关）。
- 店员「重打」→ `REPRINT`。后台「打印测试页」→ `TEST`。

**票面（58mm，32 列）**：首行超大号「同城配送」或「全国邮寄」+ 序号（当日流水 #017）；订单号、下单/付款时间；同城：收货人、电话（可点不适用，打印完整号）、POI + 门牌、距离、预计送达、**备注加粗放大**、餐具标记；商品行（名称/规格 × 数量 小计）；合计/运费/实付；邮寄：收件人完整地址、备注；底部：小程序码（订单详情，可选）、「接单请在工作台操作」。同城票默认 2 联（厨房/骑手），邮寄 1 联，后台可调。

**可靠性**：
- 队列在进程内 + 数据库：`PrintJob(PENDING)` 落库后立即尝试发送；失败按 5s/30s/2min 重试 3 次后 `FAILED` + 老板告警 +「打印失败，已改为推送」回退 `notifyOrderPaid` 强化文案；scheduler `printQueueSweep` 每分钟兜扫 PENDING/SENT（SENT 超 3 分钟未确认 → 查询平台状态）。
- 幂等：`dedupeKey` + 飞鹅侧用订单号作去重参考（以调研为准）；进程重启不丢单。
- **未接单重复播报**（D7）：scheduler `repeatAnnounce`：`PAID` 且 `paidAt + repeat.*AfterMin` 已到、距上次播报 ≥ `everyMin`、次数 < `maxTimes` → 入队 `REPEAT` 作业（飞鹅无独立语音接口：打印精简「催接单」小票触发硬件播报；`reprint=true` 则重打全票）；接单即停；次数耗尽 → 老板告警。`Order` 增加 `announceCount Int @default(0)`、`lastAnnouncedAt DateTime?`。
- **离线/缺纸告警**：scheduler `printerHealth` 每分钟查打印机状态；连续 `offlineAlertMin` 分钟离线或缺纸 → 老板告警一次 + 工作台状态灯红；恢复后再告知。离线期间新单打印记 `PENDING`，恢复后自动补打（超过 30 分钟的旧单不再补打，避免一次吐一堆）。
- **网页/商家端响铃**：工作台轮询到新单/异常即响铃（两种音效），`Notification` + 标题闪烁；小程序 `pages/merchant/index` 保留 30s 轮询 pending-count，新增 `wx.vibrateLong` + `InnerAudioContext` 铃声，前台时有效（小程序无后台常驻能力，这一层只是补充，主通道仍是打印机）。

**后台**：`pages/PrinterSettings.tsx`（绑定打印机 SN/KEY、名称、渠道、联数、语音文案、重复播报参数、离线阈值、「打印测试页」、状态与最近 20 条打印记录、失败重试/重打按钮）；工作台顶栏状态灯；订单卡「重打小票」。

**接口**：`GET/PUT /admin/settings/printer`、`POST /admin/printers/bind {sn,key,name}`、`DELETE /admin/printers/:sn`、`POST /admin/printers/:sn/test`、`GET /admin/printers/status`、`GET /admin/print-jobs?orderId=`、`POST /admin/print-jobs/:id/retry`、`POST /admin/orders/:id/reprint`；`GET /admin/workbench/snapshot`。飞鹅回调（若启用 backurl）：`POST /api/feie/cb` 公开路由（校验来源与签名规则以调研为准），更新 `PrintJob.PRINTED`。

**错误码**：`42240` 打印机未配置 · `42241` 打印机离线 · `42242` 打印提交失败(附平台原文)。

**飞鹅接入细节（官方文档 http://www.feieyun.com/open/apidoc-cn.html 已核；标 ※ 者 M0 联调时二次确认）**
- 端点：`POST {FEIE_API_BASE}/Api/Open/`，`application/x-www-form-urlencoded`；国内节点 `http://api.feieyun.cn`（※ 调研抓到的是 `https://api.de.feieyun.com`，以开发者后台显示为准，做成 env `FEIE_API_BASE`）。
- 公共参数：`user`(USER)、`stime`(秒级时间戳)、`sig = sha1(USER + UKEY + stime)` 40 位小写、`apiname`。
- 接口：`Open_printerAddlist`（`printerContent = "SN#KEY#备注#流量卡"`，多台换行）、`Open_printerDelList`、`Open_queryPrinterStatus`（返回中文状态串：「在线，工作状态正常。」/「在线，工作状态不正常。」= 缺纸或开盖 /「离线。」，按前缀解析为 ONLINE / ABNORMAL / OFFLINE）、`Open_printMsg`（`sn`、`content` ≤ 5000 字节、`times` 联数 1–65535；返回 `data` = 平台订单号）、`Open_queryOrderState`（按平台订单号查是否已打印）、`Open_delPrinterSqs`（清队列，离线恢复前用于丢弃 30 分钟前的旧单）。
- 票面标签：`<CB>`居中加倍、`<B>`加倍、`<C>`居中、`<L>`倍宽、`<W>`倍高、`<BOLD>`加粗、`<RIGHT>`、`<BR>`换行、`<CUT>`切纸、`<QR>`（每单限 1 个）、`<BC128_A>`。58mm 每行 32 字节（16 汉字）。渲染器按此宽度对齐商品行（名称截断 + 数量/小计右对齐）。
- 语音：真人语音款出票时**硬件自动播报**「您有新的订单」，无独立语音接口 ※（`<AUDIO-*>` 标签拼写未核实）。因此：新单播报 = 出票本身；**重复播报 = 打印一张 8 行的精简「催接单」小票**（订单号 + 等待分钟 + 「请到工作台接单」），`repeat.reprint=true` 时改为重打全票。设置里 `voice.localText/expressText` 仅在机型支持自定义标签时生效，否则忽略。
- 回调 backurl：在飞鹅开发者后台配置（非请求参数）※，POST `orderId / status(1=已打印) / stime / sign`，5 秒内返回字符串 `SUCCESS`；签名算法 ※ 待核实，未核实前**不依赖回调**，`PrintJob` 由 `printQueueSweep` 用 `Open_queryOrderState` 确认 `PRINTED`。回调路由 `POST /api/feie/cb` 作为加速，核实签名后再启用。
- 无原生去重字段、无沙箱、无官方限流数字：去重靠 `PrintJob.dedupeKey`；进程内对同一 SN 串行发送、间隔 ≥ 300ms；联调用真机 + 测试页。
- 错误约定：HTTP 非 200 或返回 `ret != 0` → 记 `lastError = ret:msg`，按重试策略处理；`ret` 对应「打印机不存在/未绑定」类错误不重试直接 FAILED + 告警配置问题。
- 备选：芯烨云（`sha1(user+UserKEY+timestamp)`，JSON，有 `/playVoice` 独立播报但为收款模板 ※、原生幂等 token）作为 `xpyun.ts` 二期实现；易联云 OAuth 复杂且语音能力未证实，不选。
- 采购建议（用户）：飞鹅 58mm **真人语音款**，WiFi+4G 双模；电商参考价 ※ 约 300–620 元随型号浮动。

## 8. 通知与告警

| 事件 | 接收 | 通道 |
|---|---|---|
| 同城新订单 / 顾客申请取消（超 3 分钟未处理再推一次）/ 待抢单超时 / 运力取消 / 改派 / 备餐 20 分钟未呼叫 / 骑手接单后卡住 | 店员 | PushPlus topic + 企微 |
| 呼叫失败(30005 重试后) | 店员 | 同上 |
| 余额不足 30004 / 配置类错误 / 510 异常 / 配送中超时 / 下单响应超时未认领 / 回调验签失败(限频) / 定时任务失败 | 老板 | 系统告警 |
| 配送中（回调 `310`，骑手取货出发） | 顾客 | 订阅消息「配送通知」单模板（**定稿**：只在 `310` 发一条；`100` 骑手接单、`520` 已送达**均不发**——省下有限的顾客授权配额，「骑手已接单」「已送达」的进度顾客走订单详情页时间线自行查看，不占用一次性订阅消息的珍贵额度） |
| 付款成功（两渠道）/ 未接单重复播报 / 取消退款提醒 | 店内 | **云打印机出票 + 语音播报（主通道）** + 工作台响铃 + 商家端铃声 |
| 打印失败(重试耗尽) / 打印机离线或缺纸 ≥5 分钟 / 重复播报耗尽仍未接单 | 老板 | 系统告警；打印失败时新单回退强化推送 |

## 9. 里程碑

- **M0 开户与核实（用户侧，与开发并行）**：快递100 企业版注册/认证/充值 100 元、取 key/secret（`scripts/set-env.sh`）；（自贡 6 家运力覆盖、无需绑商户号、预充值可退，均已于 2026-09-03 经企微答复确认，不必再问）；公众平台核实位置接口是否需类目审批及周期、申请之；隐私保护指引勾选「位置信息」+ 第三方共享；尝试申请「配送通知」订阅模板；提供门店坐标/营业时段/半径/运费阶梯/起送；开户后 `apps/server/scripts/kd100-probe.mjs`（`batchPrice` 只读）验证覆盖与报价，记录 `discountFee` 实际含义与各运力重量限制。
- **M1 渠道与数据基础**（注意：M1 完成**不等于**同城可上线，见 §2 原则 2）：迁移（§4 全部表结构一次落库）、`channel` 贯通、`product-channel.ts`、`local-settings.ts`（含 `isOpenNow/paused/haversine/calcLocalFee/quoteToken`）、`/local/meta|quote`、`createOrder` LOCAL 分支（绕开全局运费）、`cancel-request`、后台分类/商品渠道 Tab、`LocalSettings.tsx`、商家端一键定位、`.env.example`、一致性脚本、e2e（渠道双向校验、范围内外、打烊/暂停、起送、阶梯三档、quoteToken 过期、LOCAL 运费与全局运费无关）。
- **M2 配送服务与看板**：`provider.ts`、`kuaidi100.ts`、`self.ts`、`mock.ts`（可注入异常）、回调路由、编排（呼叫/下单超时认领/错误分流/熔断/重呼/自送/送达/认领作废）、状态机白名单、退款联动（入口前置 42221）、scheduler 6 任务、通知、`admin/local-orders.ts`、`LocalOrders.tsx`、`RefundDialog` 参考行、`pending-count`、e2e（§10 全部场景）、`selftest-kd100.ts`。
- **M2b 出票与工作台**：`PrintJob` 表（并入同一迁移）、`services/ticket/*`（printer 接口 + feie + mock）、票面渲染器（单测比对 32 列排版）、触发点接入两处支付成功与退款/取消、重复播报与打印机健康两项 scheduler、`PrinterSettings.tsx`、`/workbench` 页 + `snapshot` 接口 + 声音/通知层、`Layout` 首项与登录落地改工作台、小程序商家端铃声震动；e2e：付款→PrintJob PENDING→mock PRINTED；打印失败三次→FAILED+回退推送；离线→告警一次→恢复补打且 30 分钟前旧单不补；未接单 2 分钟播报、接单后停止、5 次耗尽告警；重打幂等；snapshot 四列归类断言。
- **M3 小程序**：`pages/local/*`、隐私弹窗、地址地图选点、订单详情同城分支/地图/轮询/取消窗口、渠道标签、购物车提示、`legal.js`、`app.json`、预览台、封面入口契约。
- **M4 联调与文档**：真机真钱联调（`batchPrice` 探测 → 1 单全流程 → 1 单立即取消看取消费 → 记录 `statusDesc` 文案与回调时延）；`docs/order-flow.md`（同城状态表 + Order×Delivery 非法组合矩阵）、`docs/staff-guide.md` 新章节（术语大白话：呼叫骑手/预扣/改派/取消费 vs 小费；「接单」在同城的含义；无人接单处理顺序；门店坐标设置；暂停接单；常见问题）、`docs/api.md`、`docs/deployment.md`（env、callbackUrl 长度预算、nginx 无需新 location 但需 curl 演练）、`docs/miniapp-release-checklist.md`（隐私一致性检查章节）。

实施方式：`writing-plans` 拆任务 → `subagent-driven-development` 执行；每个里程碑完成后由 Opus 审架构/并发/资金、Sonnet 审文案/边界/文档，意见回流后再合并。

## 10. 验证

- e2e（mock provider，`LOCAL_DELIVERY_PROVIDER_MOCK=true`）场景。本里程碑（M2 引擎，T0-T9）已落地为 `scripts/e2e.sh` 第 **25-30 段**，**369/0** 全绿、可零间隔连跑两轮验证幂等；下表逐条勾掉已覆盖项，未覆盖项保留给后续里程碑或标注原因（复合场景一律拆成两行分别标注，不用一个 ✅ 盖住两件事）：

  | 场景 | 状态 | e2e 段 |
  |---|---|---|
  | happy path 0→100→230→310→520 | ✅ | §27 |
  | 终态后迟到 310 不复活（rank 单调，迟到 210 不回退） | ✅ | §27 |
  | 720 后 activeOrderId 已释放且可重呼 | ✅ | §27/§28 |
  | 自动呼叫每单只触发一次（已有在途配送单时不重呼） | ✅ | §30（「已有在途单不重呼」断言） |
  | 自动呼叫：候选订单有 cancelRequest 时跳过、不触发呼叫 | ✅（新增） | §30（造一笔已 `cancelRequestedAt` 的候选订单，断言调度器跑后仍无配送单） |
  | cancel-request 快照为 CALLING 而店员处理时已 DELIVERING 仍预填全额 | ⬜ 未覆盖 | — 属 `RefundDialog` 前端预填逻辑，非服务端可断言范围，留给后台浏览器验证（见下） |
  | quoteToken 下单实收取 min | ✅（M1 起已覆盖） | §22 |
  | 邮寄端点 ship 对 LOCAL 单返回 42204 | ✅（M1 起已覆盖） | §22 |
  | 邮寄端点 complete 对 LOCAL 单返回 42204 | ✅（新增） | §27（对一笔真正已 `SHIPPED`（经 310 回调）的 LOCAL 单调用 complete，验证不会被误置 COMPLETED） |
  | 乱序（310 先于 210 不回退） | ✅ | §27 |
  | 重复回调：同 updateTime 去重 | ✅ | §27 |
  | 重复回调：缺 updateTime 时退化 rawBody 摘要去重（同内容两次只留一条事件、换内容不误合并） | ✅（新增） | §27 |
  | 超长 statusDesc 仍 200（入库前截断） | ✅ | `selftest-kd100.ts` |
  | 缺字段（statusDesc/courierName/courierMobile/kuaidicom 均缺失，仅传 taskId/status/updateTime）回调仍 200 且状态机照常推进 | ✅（新增） | §27 |
  | 验签失败 200 不改状态 | ✅ | §27 |
  | 下单响应超时后回调按 URL 里的 deliveryNo 认领并回填 taskId | ✅ | §27 |
  | 回调 URL 长度上限的启动断言 | ⬜ 未覆盖 | — 是 `config.ts` 启动期 `process.exit(1)` 断言，不在 e2e（e2e 跑在服务已启动之后）覆盖范围内；靠部署时换域名会立刻炸的方式兜底，§5.5 已写明 |
  | 30004 熔断 → 后续呼叫被拒 → reset 恢复 | ✅ | §26 |
  | 30005 重试后失败（ADMIN 来源不重试，直接 42225） | ✅ | §26 |
  | 720 在 310 之后：无退款/售后 → 回 PREPARING，有在途退款 → 仅告警 | ✅（回 PREPARING 分支） | §27 |
  | 有有效配送单时 admin 退款 / 拒单均 42221 | ✅（admin 退款、拒单两条路径） | §28/§29 |
  | 有有效配送单时用户自助 cancel / 售后 approve 是否拦 42221 | ⬜ 未覆盖 | — 顾客侧取消走「申请取消」而非直接 `cancel`，售后 approve 路径未在本次 e2e 新增断言，留待后续补充或确认是否仍适用 |
  | 取消配送后退款成功且 cancelFee 入账 | ✅ | §28 |
  | 顾客 5 分钟窗口内 cancel-request 成功、窗口外 42229 | ✅（M1 起已覆盖） | §22 |
  | 自送全流程（selfDeliver → SHIPPED → delivered → COMPLETED） | ✅ | §28 |
  | 标记送达释放 activeOrderId | ✅ | §28 |
  | 小费超上限被拒、运力拒绝加小费 42236 | ✅ | §28 |
  | courier 接口非活跃态返回 `location:null` | ✅ | §28 |
  | courier 接口越权（查他人订单）403/404 | ⬜ 未覆盖 | — 现有断言只测了本人订单的正常路径，越权路径未新增用例 |
  | `autoComplete` 不碰 LOCAL | ✅（沿用 M1 起既有断言，LOCAL 无 Shipment 天然不受影响） | §16 |
  | 顾客端响应不含敏感字段（`callbackSalt`/`quotedFee` 等 key 集合断言） | ✅ | §28 |
  | 拒单：售罄联动下架 + REFUNDED 终态 | ✅（新增，原设计未列） | §29 |
  | 拒单：两渠道通用（EXPRESS 单也能拒） | ✅（新增，原设计未列） | §29 |
  | 拒单：待付款单走取消不走退款，库存回滚 | ✅（新增，原设计未列） | §29 |
  | 同城 9 项兜底定时任务（呼叫超时/接单卡住/配送中超时/幽灵单/未呼叫/取消申请超时/自动呼叫/housekeeping） | ✅（新增，原设计未列） | §30 |
  | 探测接口 `POST .../probe` | ✅（新增，原设计未列） | §28 |

- `selftest-kd100.ts`：签名向量、form 编码、回调验签、错误码映射；`--integration` 只读 `batchPrice`。
- 后台浏览器（桌面 + 375px）：工作台四列归类/主按钮/响铃（一次点击授权后触发）/打印机状态灯/手机单列；同城列表页全部按钮路径、取消并退款引导、设置页校验/试算/探测/暂停、打印机绑定/测试页/重打、分类商品渠道 Tab、邮寄订单页行为不变。
- 打印实物联调（用户）：绑定真机 → 测试页 → 一分钱下单出票 + 语音播报 → 拔网线 5 分钟收到离线告警 → 恢复自动补打 → 不接单 2 分钟重复播报。
- 小程序预览台截图 + 真机（用户）：隐私弹窗、地图选点授权拒绝/取消分支、下单支付、详情地图、取消窗口、商家端定位。
- 生产联调：M0 探测 → 部署 → `curl` 演练回调路径 → 2 笔真单 → 核对快递100 账单与 `Delivery.actualFee/cancelFee`。

## 11. 用户侧待办
0. 购买飞鹅 58mm 带语音播报云打印机（WiFi 或 4G 版，店内 WiFi 不稳建议 4G），注册飞鹅开放平台取 USER/UKEY（走 `scripts/set-env.sh`），打印机 SN/KEY 在后台绑定页录入；准备 58mm 热敏纸。
1. 快递100 开户/认证/充值（最低 100 元，可退），拿到 key/secret。
   **密钥由店主自己在服务器上填**，仓库里不出现任何真实值。`.env.example` 已把 `KD100_KEY`、
   `KD100_SECRET` 两个位置留空备好；服务器上二选一：
   `bash scripts/set-env.sh KD100_KEY`（逐个填、输入不回显）或
   `bash scripts/import-secrets.sh <清单文件>`（批量导入后安全抹除清单）。
   两条路径都已实测：键在服务器 `.env` 里尚不存在时会自动追加，不会静默失败。
   填完 `pm2 restart food-shop-server` 生效。不要截图或在聊天里发送密钥。
2. 公众平台：位置接口权限（核实流程）、隐私保护指引更新（位置 + 第三方共享）、服务类目确认。
3. 门店坐标（部署后用商家端按钮）、营业时段、半径、运费阶梯、起送、5 分钟取消窗口是否调整。
4. 订阅模板：优先申请「配送通知」类模板；否则确认发货模板字段映射。
5. 联调预算：约 2 单运费 + 可能 2 元取消费。

## 12. 二期（明确不做）
芯烨云等第二打印品牌；飞鹅回调加速（签名核实后）；工作台 SSE 推送；预约配送；节假日日历；独立打包费字段（首期摊入商品价或基础费，文档写明）；精细餐具选项；多骑手拆单；后台 RBAC（本期以金额上限 + 操作审计替代）；微信同城配送作为第二运力。

## 13. 风险与对策
- ~~自贡运力覆盖不确定~~ **该风险已消除**：2026-09-03 企微答复确认蜂鸟/顺丰同城/闪送/达达/UU跑腿/裹小递 6 家全支持。
- **快递100 开通（充值 + 密钥配置）是上线阻塞项**，须在 M2 联调前完成——同城通道不再能靠 SELF 先上线。
- 无沙箱 → mock 覆盖 §10 全部异常场景；真钱联调 2 单。
- 无查单 → 事件先落库、状态单调、6 个定时提醒、店员「标记送达/作废」出口。
- 下单响应超时 → `deliveryNo` 已在回调 URL 里，按 path 直取即可认领，不依赖 taskId（原「幽灵单」风险基本消除）。
- 资金一致性 → 退款入口前置取消配送单；取消费/小费入账；小费上限 + 审计；30004 熔断。
- 直线距离偏差 → `detourFactor`，M4 用快递100 `deliveryDistance` 回归校准。
- 坐标系与填反 → 全链路 GCJ-02 微度 Int；商家端一键定位为主，手填 bbox 校验。
- 打印机成为单点 → 离线 5 分钟告警 + 新单打印失败自动回退强化推送 + 工作台/商家端响铃三层兜底；飞鹅无去重与沙箱 → `PrintJob.dedupeKey` + 真机测试页联调。
- 两套购物车 → 服务端双向渠道校验 + toast/空态提示。
- 合规 → 隐私弹窗、指引、第三方共享条款列为 M3 交付项与发版前置检查。
