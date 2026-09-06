# 同城配送整改规划执行方案（2026-09-06）

> **输入**：`docs/local-delivery-run-log.md`（首单 `ORD20260906918208` / `D19-1` 全部实测数据）、
> `docs/local-delivery-golive-manual.md`、生产版本 **`806c2a3`**。
> **本文档性质**：规划文档。排批次、定顺序、写验收、写回滚；**不改任何 `apps/` / `scripts/` 代码**。
> **读者**：店主（§0 用大白话）+ 开发（§1 起）。
> **凡是本方案核实后与 brief 描述不符的，都写在 §1，后文按核实后的事实展开。**
>
> 硬约束：禁止 `git push`；状态推进一律 `updateMany + 判 count`；迁移只允许 additive；
> 出站 fetch 必带超时；提交信息中文 `type(scope): 摘要`；e2e 新用例放 `scripts/e2e.d/NN-*.sh`。

---

## 0. 给店主看的结论

**正在赔钱的（3 条，批次 0 + 批次 1 解决）**

1. **每单叫骑手的方式在赔钱。** 现在是「7 家一起喊，谁快谁接」，结果是最贵的那家经常抢到。
   首单实测：最便宜的达达报 ¥16.23，抢到的闪送扣了 ¥23.32，**多付 ¥7.09**。
   离店近的单更糟——1.1 km 的单最贵的报 ¥11.22，而顾客只付 ¥6，被贵的抢到就**亏 ¥5.22**。
   改法：**默认只喊最便宜那家，3 分钟没人接再改成一起喊。** 这一条是软件改动（批次 1）。
2. **一起喊还会把快递100 的余额锁死。** 每喊一家就先冻结一笔钱（首单一次冻结 ¥75.08，实际只花 ¥23.32）。
   充 100 元的话，**同时只能挂 1 单**；第二单进来就会报「余额不足」，店员按不动「呼叫骑手」，而顾客已经付了钱。
   改成只喊一家之后，100 元可以同时挂 6 单。**这一条和上一条是同一个改动。**
3. **运费表近单收少了、满 99 免运费远单吃亏。** 基础运费 ¥6，而 3 km 内最便宜的骑手也要 ¥6–8；
   满 ¥99 免运费的单如果在 9 km 外，一单要贴 ¥16 骑手费。
   改法：后台「同城设置」改几个数字，**今天就能做，不用等开发**（批次 0）。具体数字见 §3.2，
   **这是你的定价决定，方案只给账**。

**只是看不见的（数据都在，后台没显示；批次 2 解决）**

- 哪家骑手公司接的单、各家报价是多少、实际扣了多少——库里都有，工作台没画出来。
- 骑手实时位置：顾客那边今天刚修好能看了，**工作台还看不到**。
- 「预计送达」是公式估的（骑手按 15 km/h 算），比实际晚 18 分钟。
  短期改一个数字（今天可做，批次 0），长期用骑手位置算（批次 2）。
- **后台所有时间都跟着看的人的电脑走**：你在东七区的电脑上看到的就是东七区时间；
  两个人用不同时区的电脑看同一张单会看到不同的时间。小票、语音、订阅消息是对的，只有后台网页错。

**改起来有风险、要慎重的（2 条）**

- **同城页加底部导航（tabBar）**：能做，但会改所有页面的跳转行为，是全方案回滚成本最高的一处。
  方案推荐**不改 tabBar**，改成「封面加『我的订单』按钮 + 同城页顶部加『我的订单』入口」（§6）。
- **改运费参数**：直接影响真实顾客付款；而且「同城设置」页的保存是整页覆盖，
  两个人同时改会互相冲掉。改的时候按 §3.2 的步骤来，一人操作、改完刷新回读。

**不再有「等一个数字才能定」的事**——实扣 ¥23.32 已确认等于中标报价，策略可以做了。

---

## 1. 核实结果：与 brief 不符的地方（必读）

逐条读了代码。以下是 brief 里**判断有误或需要修正**的点，后文一律按修正后的事实写。

| # | brief 原话 | 核实结果 | 影响 |
|---|---|---|---|
| C1 | 定时任务框架 `apps/server/src/services/delivery/scheduler.ts` | **文件在 `apps/server/src/services/scheduler.ts`**（`services/` 下，不在 `delivery/` 下）。`TICK_MS=60s` 在 `:33`，任务注册表 `:82-108`，`SchedulerOverrides` `:52-75`。`tasks.ts:160-188` 的 `autoCallRiders` 定位正确 | 改文件路径 |
| C2 | 「把 `meituantongcheng`/`uupaotui`/`gxdtongcheng` 从配置里摘掉，少 3 次无用询价」 | **收益不成立**：`batchPrice` 与 `batchOrder` 都是**一次 POST 带一个列表**（`kd100.ts:34` `kuaidiComList`，`:122` / `:145` 各 `post()` 一次），7 家和 4 家都是 1 次请求；没覆盖的 3 家不返报价也**不产生预扣**（快递100 后台只有 4 笔）。**也不是零代码**：`LocalSettings.tsx:232-247` 的「运力」区块没有运力勾选框，改只能直接改库里 `settings.local_delivery` 的 JSON。 | **推荐不摘**（§3.3）。策略代码从报价快照里选，天然只会选到有报价的那几家 |
| C3 | 「`quotedFee` 字段名与实际含义不符，会让对账算错」 | 成立，且**已经在两处用错**：`Workbench.tsx:1134` 把它标成「运力报价」显示；`LocalOrders.tsx:31` 用 `actualFee ?? quotedFee` 算「配送成本」，并传给 `RefundDialog.tsx:229-231` 的「该单配送成本」。首单在这两处都显示 ¥16.23，实际 ¥23.32 | 批次 1 改字段语义，批次 2 改显示 |
| C4 | 「`batchOrder` 返回里没有中标信息」（隐含） | `docs/research/2026-09-03-kuaidi100-same-city-api.md:180` 写明 `batchOrder` 响应 `data.fee[]` **每项带 `kuaidiCom` + `discountFee`**——这正是快递100 后台那 4 行预扣。`kd100.ts:147-153` 读了 `fee[]` 却把 `kuaidiCom` 丢了，只留 `Math.min` | `actualFee` 的最可靠来源是它，不是 5 分钟前的快照（§4.2） |
| C5 | 「后台 24 处日期渲染，8 个文件」 | grep 实数：**8 个文件 21 处渲染** + `ScanStats.tsx:10-20` **4 处**（`fmtDate`/`quickRange` 用浏览器本地日拼**查询区间**——服务端按 Asia/Shanghai 分桶（`utils/local-day.ts`），浏览器换时区后「今日」会查到昨天/明天的桶，**不只是显示错**）+ `Workbench.tsx:597` 顶栏日期。另 `Coupons.tsx:765/792`、`Products.tsx:850` 是 `toLocaleString()` **连 locale 都没给**。合计 9 文件约 26 处。以 §5.4 的闸门脚本输出为准，不要手数 | 闸门脚本是唯一真相 |
| C6 | 「小程序 4 处」 | 4 个文件 5 处：`pages/order/detail.js:49`（`t()`）、`:92`（`deadlineText`，同时用于 `:265` 的顾客端「预计送达」）、`pages/member/points-log.js:28`、`pages/local/confirm.js:26-27`（`formatArrival`）。顾客手机在自贡，实际暴露面小；**微信开发者工具跑在别的时区的电脑上会看到错的**——店主联调时会撞到 | 低优先级，§5.4 末尾 |
| C7 | 「熔断只能在『系统状态』页点恢复」 | `Workbench.tsx:881-886` + `:1262`：工作台顶栏横幅也有「恢复」键（手册 §7.4 写的就是横幅）。端点同一个 `system.ts:129` | 措辞 |
| C8 | 「`delivery_events.created_at` 默认值时区不一致」 | 成立，但**不是这张表特有**：迁移里 **23 张表**的 `created_at` 都是 `DEFAULT CURRENT_TIMESTAMP(3)`（`20260904000000_local_delivery/migration.sql:86` 只是其中一处）。全仓无 `TIMESTAMP` 类型列（全 `DATETIME(3)`），服务端原生 SQL 里**没有** `NOW()/CURDATE()/DATE()` 依赖时区的用法（`local-day.ts` 明确只做无时区提取） | 处置改为全库级（§7.1） |
| C9 | 「2.2+2.3 天然一体」 | 同意，且还有**第三个 ETA 来源** brief 没提：`subscribe-message.ts:195` 配送通知的「预计到达」= 取货时刻 + **固定 30 分钟**（首单 20:37 vs 实际 20:28）。三处口径要统一 | §5.3 |
| C10 | 「运费表要调的是 `baseFee`」 | 成立。补充：2026-09-04 实测骑手最低价（`local-settings.ts:89`）2 km ¥7.15 / 3 km ¥7.98 / 5 km ¥13.75，所以**即使只呼最低价，3 km 档 ¥6 也亏 ¥1.98** | §3.2 用这组数算账 |
| C11 | 「策略：超时后升级是取消重呼还是追加」 | **追加在结构上不可能**：`Delivery.activeOrderId` 唯一索引（`schema.prisma:524`，`orchestrator.ts:66-92`）一单只允许一张在途配送单。只能「取消 D-1 → 新建 D-2」，且 `cancelDelivery` + `callRider` 两条现成路径直接可用（今天店员手动「取消呼叫→重新呼叫」走的就是它） | §4.3 |
| C12 | UI 设计 | `docs/design/workbench-ui-spec.md` **§6b（:159-215）早已把「只呼最低价 + 3 分钟并呼 + 弹窗画法」写好**，只等实扣验证。本方案按它实现，偏离之处在 §4.3/§5.2 明说 | 少一轮设计 |

其余定位（`quote.ts:4-7` 文件头、`kd100.ts:144` providers 口子、`callback.ts:50-74` 720 论述、`Workbench.tsx:56-65` `hhmm/dateTime`、`:547/:1072` 预计送达、`orders.ts:457` 列表、`:536-574` courier 端点与 20 秒缓存、`LocalSettings.tsx:64-117` 整包覆盖、`settings.ts:85-97` PUT 无乐观锁、`app.json` tabBar、`cover/index.js:61-78`、`user/index.wxml:73-74`、`app.js:104-119` 角标只统计 EXPRESS 车、`local-settings.ts:375-390` 公式）**全部核实无误**。

---

## 2. 批次总览与依赖

| 批次 | 名称 | 谁做 | 改哪 | 能否独立部署/回滚 | 依赖 |
|---|---|---|---|---|---|
| **0** | 零代码：三个设置 | **店主，今天** | 后台「同城设置」页 | 改回数字即回滚 | 无 |
| **1** | 赔钱：只呼最低价 + 3 分钟并呼 + `actualFee` 补齐 | 开发 | `apps/server`（1 条 additive 迁移） | `DEPLOY_REF` 回退；**运行时开关** `callStrategy.mode=ALL` 可不部署即关掉 | 无（批次 0 不是前置） |
| **2** | 看不见：报价/中标/实扣/骑手位置/ETA/时区 | 开发 | `apps/admin` + 少量 `apps/server` | 重建 admin dist 即回滚 | 2.1–2.3 依赖批次 1 的字段；2.4 时区**不依赖任何批次** |
| **3** | 用不顺：订单入口 | 开发 + 店主重传体验版 | `apps/miniapp` | 回退提交 + 重传旧体验版 | 无；须把主仓 main 快进 |
| **4** | 数据可信：MySQL 时区 + 观察项 | 开发（运维） | 生产 MySQL 配置 + 文档 | 改回配置即回滚 | 无 |

**关键路径**：批次 1 → 批次 2（2.1–2.3）。批次 0 / 2.4 / 3 / 4 互不依赖，可并行或随时插队。
**推荐顺序**：0（今天）→ 1 → 2 → 4 → 3。批次 3 放最后是因为它要重传体验版、要店主配合验收，不是技术难度。

---

## 3. 批次 0 — 零代码，今天就能做（店主操作）

三件事都在后台 **「同城设置」** 页。**操作纪律**（因为 `LocalSettings.tsx:92-100` 的保存是整包覆盖，只从服务端合并了 `version/paused/门店坐标` 三项，其余全按页面当时的值写回）：

1. **一个人改**，改之前刷新页面（F5），不要用早先开着的标签页；
2. 只改本节点名的格子；
3. 点右下角「保存」→ **再刷新一次页面回读**确认（营业时段框保存后不重渲染，容易看着旧值以为改好了）；
4. 改的时间**避开 09:00–20:00 高峰没必要**——运费改动对正在结算页的顾客不踢人、按新值校验（`LocalSettings.tsx:101-111` 注释、`local-settings.ts:406-408`）。

### 3.1 骑行均速 `riderSpeedKmh`：15 → **22**

- 在哪：「营业与履约」→「骑行均速（km/h）」（`LocalSettings.tsx:223`；服务端允许 5–60，`local-settings.ts:170`）。
- 推导：首单取货→送达 21 分钟走 8.94 km ≈ 25.5 km/h（晚间、单样本）。公式 `estimateMinutes = prepMinutes + km/speed×60`（`local-settings.ts:388-390`），在**下单那一刻**算（`orders.ts:323`），`prepMinutes` 15 覆盖了接单等待+备餐（首单接单→取货实际 11 分钟）。

  | speed | 8.94 km 估算 | 估的送达 | 实际 20:28 |
  |---|---|---|---|
  | 15（现） | 15 + 36 = 51 min | 20:46 | 晚 18 min |
  | **22** | 15 + 24 = **39 min** | **20:34** | 晚 6 min（安全侧留缓冲） |
  | 25 | 15 + 21 = 36 min | 20:32 | 晚 3 min |
  | 30 | 15 + 18 = 33 min | 20:28 | 零缓冲，白天堵车会报早 |

  取 22：单样本不敢贴 25.5，宁可仍略偏晚。跑满 10 单后用 §附 的 SQL 重算再调。
- 同时生效的地方：顾客结算页「预计 HH:mm 送达」（`local.ts:77` 同一函数）、小票「预计送达」（`ticket/content.ts:305`）。
- 验收：改完在小程序同城结算页看一个 9 km 地址，预计时间应比改前**早约 12 分钟**。

### 3.2 运费参数：**店主的定价决定**，这里只给账

**成本数据**（全部实测最低价，即「只呼最低价」上线后的成本）：1.4 km ¥5.83（今日）/ 2 km ¥7.15 / 3 km ¥7.98 / 5 km ¥13.75（2026-09-04，`local-settings.ts:89`）/ 8.94 km ¥16.23（今日）。

公式 `fee = baseFee + ceil(km − baseKm) × perKmFee`（`local-settings.ts:383`），满 `freeThreshold` 归零（`:384`）。

| 方案 | baseFee / baseKm / perKmFee | 1.4 km | 2 km | 3 km | 5 km | 8.94 km |
|---|---|---|---|---|---|---|
| **现状** | 6 / 3 / 2.5 | 6.00（+0.17） | 6.00（**−1.15**） | 6.00（**−1.98**） | 11.00（**−2.75**） | 21.00（+4.77） |
| **A（只改一格）** | **8** / 3 / 2.5 | 8.00（+2.17） | 8.00（+0.85） | 8.00（+0.02） | 13.00（−0.75） | 23.00（+6.77） |
| B | 8 / 3 / **3** | 8.00（+2.17） | 8.00（+0.85） | 8.00（+0.02） | 14.00（+0.25） | 26.00（+9.77） |
| C | **7 / 2** / 2.5 | 7.00（+1.17） | 7.00（−0.15） | 9.50（+1.52） | 14.50（+0.75） | 24.50（+8.27） |

括号 = 顾客付 − 最低价成本。**方案 A 是最小改动**（只改「基础运费（元）」一格 `LocalSettings.tsx:199`）：3 km 内不亏、5 km 贴 ¥0.75、远单赚。方案 C 更平但要改 3 格。
店主 2026-09-04 定价时接受「每单补贴占订单 6–9%」（`local-settings.ts:94`），所以「5 km 贴 ¥0.75」可能是可接受的——**这是店主的决定**。

**`freeThreshold` ¥99 的账**：满 ¥99 免运费时店铺全额承担骑手费。半径已改 10 km（默认 5），一张 ¥99 的 9 km 单要贴 **¥16.23 = 营收的 16%**；3 km 单贴 ¥7.98 = 8%。原设计（`:93-95`）只按 5 km ¥14.5 算过。三个零代码选项：
- 保持 ¥99，接受远单贴 16%（前提是远单少）；
- 提到 **¥129**（9 km 贴 12.6%）或 ¥149（10.9%）；
- 填 0 = 取消免运费。

「免运费只免基础运费、超出公里数照收」需要改 `calcLocalFee`，**不是零代码**，列为可选项（批次 1 顺手做，见 §4.6）。

**半径 10 km**：只呼最低价后 8.94 km 单利润 +4.77，经济上可保留；原改成 5 km 的理由是「凉菜夏天食安」（`:77-79`），那是另一回事，店主自己定。

- 验收：小程序同城页顶部「基础运费 ¥X 起」（`local/index.wxml:27`）显示新值；结算页 3 km 地址运费 = 新 baseFee。

### 3.3 三家没覆盖的运力：**推荐不动**（见 §1 C2）

摘掉没有 API 调用或余额上的收益；风险是它们将来进自贡要记得加回来。批次 1 的策略只从**返回了报价**的运力里选最低价，升级并呼时用配置全表（没覆盖的那三家不返报价也不预扣，无害）。
若店主仍要摘：那是 `settings` 表 `key='local_delivery'` 的 JSON 编辑（`kd100.providers`），改完让所有开着「同城设置」页的人刷新，否则下一次保存会把 7 家写回去。

---

## 4. 赔钱（批次 1，服务端）

目标：把 `docs/design/workbench-ui-spec.md` §6b 的策略落地，并把 `quotedFee/actualFee` 的语义修对。**一条 additive 迁移，一次部署。**

### 4.1 数据结构

**迁移**（唯一一条，`apps/server/prisma/migrations/20260908000000_call_strategy/migration.sql`）：
```sql
ALTER TABLE `deliveries`
  ADD COLUMN `call_strategy` VARCHAR(16) NULL,
  ADD COLUMN `order_fees` JSON NULL;
```
`schema.prisma` Delivery 模型加 `callStrategy String? @map("call_strategy") @db.VarChar(16)`（值：`SOLO` 引擎选的单家 / `ALL` 并呼 / `MANUAL` 店员指定 / `SOLO_HELD` 升级被放弃，见 4.3）与 `orderFees Json? @map("order_fees")`（`batchOrder` 响应 `fee[]` 原样：`[{provider, feeFen, distanceM}]`，与 `ProviderQuote` 同结构）。历史行为 NULL，前端显示为「并呼（旧）」。

**设置**（`local-settings.ts`）：`LocalDeliverySettings` 加
```ts
callStrategy: { mode: 'SOLO_LOWEST' | 'ALL'; escalateAfterMin: number }   // 默认 { mode: 'SOLO_LOWEST', escalateAfterMin: 3 }
```
`sanitizeLocalSettings` 白名单 mode、`escalateAfterMin` 整数 0–30（0 = 不自动升级，只靠现有 `remindCallTimeout` 提醒）。`publicLocalMeta` **不下发**它。`apps/admin/src/types.ts` 同步；`LocalSettings.tsx` 「运力」区块加两格：「呼叫方式」下拉 + 「无人接单几分钟后改为并呼」。

⚠️ 生产已有 `local_delivery` 行（店主改过半径），缺 `callStrategy` 字段 → sanitize 回默认 → **部署即生效为只呼最低价**，不需要店主再点。方案有意如此，但要在部署说明里写明。

**类型**（`types.ts`）：`CreateDeliveryOrderResult` 加 `quotes: ProviderQuote[]`（来自 `fee[]`，读 `kuaidiCom ?? kuaidicom`，与 `price()` 同一套兜底）；`CallRiderInput` 加内部字段 `callStrategy?: 'SOLO' | 'ALL' | 'MANUAL'`。

### 4.2 `quotedFee` 语义修正 + `actualFee` 自动写入

**改哪**：
- `kd100.ts:141-156` `createOrder`：保留 `fee[]` 每项的 `kuaidiCom`，返回 `quotes`；`quotedFeeFen` 改为：`providers.length === 1 ? 那一家的 feeFen : Math.min(...)`。
- `orchestrator.ts:145-152` 落库：写 `orderFees: result.quotes`、`callStrategy`。
- `callback.ts`：在 `:102-107` rank 推进成功（`moved > 0`）且 `mapped.rank >= 20`（首个 `100`）且 `p.courierCompany` 非空时，同事务内：
  ```
  fee = orderFees.find(provider === courierCompany)?.feeFen ?? quoteSnapshot.quotes.find(...)?.feeFen
  if (fee != null) tx.delivery.updateMany({ where: { id, actualFee: null }, data: { actualFee: fee } })
  else after.push(notifySystemAlert('中标运力不在预扣/报价快照中', [...], { key: `dlv-actual-fee-miss:${id}` }))
  ```
  为什么在 `100` 而不是 `0`：并呼时 `0` 回调带的 `kuaidicom` 不一定是中标方（`callback.ts:94-95` 现在会把它写进 `courierCompany`，`100` 到了再覆盖）；`actualFee` 只能在「谁接了」确定后写。
  为什么 `orderFees` 优先于 `quoteSnapshot`：前者是下单那一刻运力方**真预扣**的数（快递100 后台四行就是它），后者是 ≤5 分钟前的免费查价；两者都有且差 > ¥0.50 时记一条事件「下单预扣与呼叫前报价不一致」（信息级，不告警）。
- `mock.ts:80` 默认报价的运力编码 `mocktongcheng` → **改成 `dadatongcheng`**：策略引擎选出的编码会过 `orchestrator.ts:62-63` 的 `KD100_PROVIDERS` 白名单，假编码会被 40001 拒掉。全仓只有 `mock.ts:80` 一处引用，e2e 没断言这个名字。`mock.createOrder` 也要按 `input.providers` 返回对应条数的 `quotes`。

**历史单**：`D19-1` 可由店主口头确认后一句 SQL 补：`UPDATE deliveries SET actual_fee=2332 WHERE delivery_no='D19-1' AND actual_fee IS NULL;`（可选，只为让首单账面完整）。

**写错了怎么发现**：`actualFee` 只写一次（`where actualFee: null`）；每月对账用 §附 SQL 把 `courier_company / actual_fee / tip_fee / cancel_fee` 与快递100 月账单逐行比，差异 = 假设失效的信号（快递100 计费规则「揽收按预扣实扣、多退少补」，`research:76`）。

### 4.3 只呼最低价：选谁、何时升级、怎么升级

**选谁**（`orchestrator.ts callRider`，在 `:54` 读设置之后、`:67` 占位之前——占位前做外呼，不占 `activeOrderId`）：
```
if (!input.providers && s.callStrategy.mode === 'SOLO_LOWEST') {
  snapshot = !isQuoteStale(order.quotedAt) ? order.quoteSnapshot : (await refreshOrderQuote(orderId)).snapshot   // catch → null
  lowest = snapshot?.lowest && s.kd100.providers.includes(lowest.provider) ? lowest : null
  providers = lowest ? [lowest.provider] : undefined
  callStrategy = lowest ? 'SOLO' : 'ALL'        // 查不到价：退回并呼，事件里写明「无可用报价，退回并呼」
} else callStrategy = input.providers ? 'MANUAL' : 'ALL'
```
- 「接单并呼叫」路径（`delivery.ts:59-76`）占位时快照几乎必空（`orchestrator.ts:76-85` 注释），所以 SOLO 模式下 `callRider` **同步**查一次价（约 1 秒，免费）。`kickOffQuote` 在该路径上变冗余但无害（`quotedAt` 单调守卫 `quote.ts:158-165` 挡掉旧结果）。
- 事件文案 `orchestrator.ts:160`「已向运力方下单（并呼抢单中）」改成策略感知：SOLO → 「只呼 达达 ¥16.23（3 分钟无人接自动并呼）」；ALL → 「并呼 N 家抢单中」。
- ⚠️ **首个真实 SOLO 单要盯的一件事**：`batchOrder` 带 1 家的 `kuaidiComList` 是否被接受、`fee[]` 是否只回 1 条、`0` 回调是否照常。文档没写单家 `batchOrder` 的行为。若被拒，回退实现 `method=order` + `kuaidiCom`（`research:161-176`），改动只在 `kd100.ts createOrder` 内。

**何时升级**：新任务 `escalateSoloCalls(min?)`（`tasks.ts`，照 `remindCallTimeout` `:19-35` 的形状），注册进 `scheduler.ts:82-108` 为 `localEscalate`，`SchedulerOverrides` 加 `escalateAfterMin`，`system.ts:98-120` 透传。`TICK_MS=60s` → 实际升级发生在 3–4 分钟之间，写进 UI 文案「约 3 分钟」。

**怎么升级**（取消重呼，理由见 §1 C11）：
```
if (threshold <= 0 || isCircuitTripped()) return 0            // 熔断时撤了旧单却呼不出新单，比不升级更糟：跳过
rows = delivery.findMany({ status:'CALLING', callStrategy:'SOLO', providerTaskId:{not:null}, calledAt:{lt: ago(threshold)} })
for d:
  { cancelFeeFen } = precancelDelivery(orderId)                  // 免费预览
  if (cancelFeeFen > 0) { updateMany(callStrategy:'SOLO_HELD'); recordDeliveryEvent('预估取消费 ¥x，放弃自动升级'); notifyLocalDeliveryAlert(...); continue }
  cancelDelivery({ orderId, operator:'scheduler', reason:`${threshold} 分钟无人接单，自动升级为并呼` })   // D-1 → CANCELLED
  callRider({ orderId, operator:'scheduler', source:'SCHEDULER', providers: s.kd100.providers, callStrategy:'ALL' })   // D-2
```
- `SOLO_HELD` 让该行离开扫描，避免每分钟重复 precancel + 重复告警。
- 升级只做一次到底（并呼全部），不做「换第二便宜」——与 UI spec §6b 一致（「再挑一轮就是 6 分钟，凉菜等不起」）。
- 我方 `cancel` 之后快递100 会推 `720`：`callback.ts:68` taskId 匹配 → `:114` `where status notIn TERMINAL` 命中 0 行 → 按乱序迟到包静默（`:120-133`），**不会**误告警（那条告警只对 `FAILED` 行）。
- D-1 的小费**不带过去**（加小费走运力方，是真钱；v1 不做，事件里写「原单小费 ¥x 已随取消退回预扣」）。
- 重呼失败（例如 30004）：D-1 已取消、订单停在 `PREPARING` 无在途单 → 现有 `remindLocalUncalled`（10 分钟）+ 熔断告警兜底；再加一条即时 `notifySystemAlert('自动升级并呼失败', key: dlv-escalate:${id})`。
- **残余竞态**：precancel 与 cancel 之间（≈1 秒）骑手恰好接单 → `cancel` 会真的取消已接单的骑手并扣 ¥2 左右取消费（`research:288`）。`cancelFee` 会落在 D-1 行、事件里可见；概率极低，接受并记录。

**与 `autoCallDelayMin` 的关系**：**不冲突**。`autoCallRiders`（`tasks.ts:160-188`）只决定**何时**呼（接单后 N 分钟且无在途单），呼的时候走同一个 `callRider` → 同一套「选谁」逻辑；升级任务只扫 `CALLING+SOLO` 行，升级后 D-2 在途，`autoCallRiders` 的 `deliveries: none activeOrderId` 条件不会再命中。`callTimeoutMin`（默认 10）的「待抢单超时」提醒按每张配送单各自计时，升级后总等待 = 3 + 10 分钟才到人工提醒；建议店主把它调到 7。

### 4.4 余额：没有查询接口时能做什么

快递100 无余额接口（实打 11 个方法名全 30001）。三条互补：
1. **降占用**（本批次主体）：并呼 ¥75 → 单家 ¥16。
2. **熔断时不撤单**：`escalateSoloCalls` 熔断即跳过（上）。
3. **可选，批次 2 顺手**：工作台顶栏显示「在途预扣 ¥X」= Σ 非终态配送单的 `quotedFee + tipFee`（`workbench.ts` snapshot 多一个聚合）。不做「估算剩余余额」——需要店主手填充值额，数据一旦不维护就会误导。

`kd100.autoDowngradeToSelfOnNoBalance` 与 `soloProvider` 两个设置槽**全仓无消费者**（grep 确认），本批次不实现，别让店主以为能用。

### 4.5 验收（批次 1）

- `npx tsc --noEmit`（server）通过；`prisma migrate deploy` 只加两列。
- 新增 `scripts/e2e.d/50-call-strategy.sh`（mock）：
  1. `PUT /admin/settings/local-delivery` mode=SOLO_LOWEST, escalateAfterMin=3；queue `price` 指令 4 家（最低 `dadatongcheng` 1623）；造单→accept→call；断言 `delivery.calledProviders == ["dadatongcheng"]`、`callStrategy == "SOLO"`、`quotedFee == 1623`、`orderFees` 长度 1；mock `calls` 最后一条 `createOrder.input.providers == ["dadatongcheng"]`。
  2. `POST /admin/system/run-scheduler {"escalateAfterMin":0}` → `localEscalate ≥ 1`；`GET /:id/delivery` 返回 `D-2`，`status CALLING`、`callStrategy ALL`、`calledProviders == 设置全表`；`D-1` 行 `CANCELLED` 且 `cancelReason` 含「自动升级」；mock calls 顺序 `precancelOrder → cancelOrder → createOrder`。
  3. 再跑一次 `run-scheduler` → `localEscalate == 0`。
  4. queue `precancelOrder` 返回 `cancelFeeFen 200` 的场景 → `callStrategy == "SOLO_HELD"`，无 cancel。
  5. 回调 `100` 带 `kuaidicom=shansongtongcheng` → `actualFee == orderFees[shansong].feeFen`；再推一次 `100` 不改。
  6. mode=ALL → 行为与今天一致（`calledProviders == 设置全表`）。
  7. 熔断态下 `run-scheduler` → `localEscalate == 0` 且 D-1 仍 `CALLING`。
- 既有 e2e 调整：`scripts/e2e.sh` §32 ③b（~`:1150`「不传 providers 时 calledProviders=设置里的默认列表」）在 SOLO 默认下会红——该段开头先 PUT mode=ALL，或把期望改为 `["dadatongcheng"]`。§26「quotedFee=500」不受影响（mock 单家 500）。
- 基线：`BASE=http://localhost:3105 DB_NAME=food_shop_audit bash scripts/e2e.sh` 通过数上升、失败 0。
- **生产首个 SOLO 单**（店主配合，一次真钱）：
  ```bash
  ssh ubuntu@162.14.114.95 "sudo mysql -N food_shop -e 'SELECT delivery_no,call_strategy,called_providers,quoted_fee,actual_fee,courier_company,order_fees FROM deliveries ORDER BY id DESC LIMIT 2'"
  ```
  期望：`call_strategy=SOLO`、`called_providers` 一家、`order_fees` 一条、骑手接单后 `actual_fee = quoted_fee`；快递100 后台**只有一笔**预扣。

### 4.6 可选（同批次顺手，不做也不影响上面）

- `calcLocalFee`：`freeThreshold` 只免 `baseFee` 部分（`fee = max(0, fee − baseFee)`）——给店主一个「远单不全免」的选项，加一个布尔设置 `fee.freeOnlyBase`。零代码方案见 §3.2。

---

## 5. 看不见（批次 2，管理端 + 少量服务端）

### 5.1 类型与接口补齐

- `apps/admin/src/types.ts:362-388` `DeliveryInfo` 加 `quoteSnapshot | null`、`quotedAt`、`calledProviders: string[] | null`、`providerOrderId`、`callStrategy`、`orderFees`。服务端 `ADMIN_DELIVERY_SELECT`（`delivery.ts:19-31`）已含前四项，只需加 `callStrategy/orderFees`。
- `apps/admin/src/api/admin.ts:250-251` `getOrderDelivery` 返回类型加 `quote: { snapshot, quotedAt, stale } | null`（服务端 `delivery.ts:152-154` 早就返回了，前端一直丢掉）；新增 `refreshOrderQuote(id) = POST /admin/local/orders/:id/quote`；`callRider(id, providers?)` 支持传 body（`callSchema` `delivery.ts:44` 已收）。
- `Workbench.tsx:800-806` `loadDetail`：把 `quote` 存进 `detail`。
- 新建 `apps/admin/src/utils/providers.ts`：`PROVIDER_LABEL = { dadatongcheng:'达达', fengniaotongcheng:'蜂鸟', shunfengtongcheng:'顺丰同城', shansongtongcheng:'闪送', meituantongcheng:'美团', uupaotui:'UU跑腿', gxdtongcheng:'裹小递' }` + `providerLabel(code)`。

### 5.2 工作台：中标运力 / 各家报价 / 呼叫方式 / 实扣（与 4.3 配套）

规则：**报价不上卡片**（`workbench-ui-spec.md:102`），只进抽屉与呼叫弹窗。

- 抽屉「配送员」块（`Workbench.tsx:1094-1117`）加三行：
  - 「运力」= `providerLabel(d.courierCompany)`（未接单时「—」）；
  - 「呼叫方式」= `SOLO → 只呼最低价（达达）` / `ALL → 并呼 N 家` / `MANUAL → 指定` / `null → 并呼（旧）`；
  - 「各家报价」= `d.orderFees ?? d.quoteSnapshot?.quotes` 按金额升序一行列出，最低价加「最低」标、`courierCompany` 加「中标」标，附 `providerDistanceM`。
- 「金额明细」（`:1134`）：「运力报价」→ **「下单预扣」**（`quotedFee`），新增 **「实扣（中标）」**（`actualFee`，NULL 显示「待接单」），保留小费/取消费行。
- 呼叫弹窗（`renderActions` `:906-912` `callSpec`）：`ConfirmSpec` 加 `extra?: ReactNode` 槽，按 UI spec §6b 的画法放报价块：最低价 + 运力名 + 「N 分钟前 ↻」（点 `refreshOrderQuote` 后重取 detail）、>5 分钟 `quote.stale` 转琥珀「已过期」；确认键文案 **「呼叫达达 ¥16.23」**；正文改「按最低价呼叫达达，预扣 ¥16.23。约 3 分钟无人接自动改为并呼」。「接单并呼叫」（pending 列，尚无报价）正文写「接单后先查价，按最低价呼叫」。mode=ALL 时保持今天的文案。`CALL_AMBER`（`:900`）「实际约 ¥5–8」这句已与实测不符，改为「实际以中标运力预扣为准」。
- `LocalOrders.tsx:184`「配送成本」保持 `actualFee ?? quotedFee` 口径（批次 1 后 `actualFee` 有值即正确）；服务端 `GET /:id/delivery` 加 `costFen` = 该订单**所有**配送单的 `actualFee ?? quotedFee` + `tipFee` + `cancelFee` 之和（升级后 D-1 的取消费才不会漏），前端与 `RefundDialog` 改用它。
- 顶栏可选：「在途预扣 ¥X」（§4.4 第 3 条）。

验收：本地 mock 跑一单 SOLO → 抽屉能看到「只呼最低价（达达）」「各家报价 4 行」「中标」标；回调 100 后「实扣」出现；呼叫弹窗确认键带运力名与金额；`npm run build`（admin）通过。

### 5.3 骑手实时位置（管理端）+ 三处 ETA 统一

- 服务端：把 `routes/orders.ts:536-538` 的 `courierCache / COURIER_LIVE_STATUSES` 与 `:544-574` 的取位逻辑抽到 `services/delivery/courier-location.ts`：`getCourierLocation(delivery) → { loc, at }`（20 秒进程内缓存，负缓存照旧）。顾客端路由改调它（行为不变）。新增 `GET /api/admin/local/orders/:id/courier`（`routes/admin/delivery.ts`）返回 `{ location, fetchedAt, toStoreM, toReceiverM, etaMinutes, phase }`：`toStoreM/toReceiverM = haversineM × s.detourFactor`（`local-settings.ts:354`、`:88`），`phase = status ≤ ARRIVED ? 'TO_STORE' : 'TO_RECEIVER'`，`etaMinutes = 对应距离 / riderSpeedKmh × 60`。坐标系 GCJ-02 已由首单验证（`lbsType=2`），无需转换。
- 工作台抽屉：配送单在 `ACCEPTED/ARRIVING/ARRIVED/DELIVERING` 时每 30 秒轮询（照 `pages/order/detail.js:430-462` 的 `startCourierPoll` 形状；抽屉关闭即停），显示「骑手距店约 1.2 km · **预计** 4 分钟到店」/「距顾客约 3.1 km · **预计** 8 分钟送达 · 位置更新于 20:14」。`location:null` 时整行隐藏，不报错。
- ETA 三处口径统一：
  1. 卡片/抽屉「预计送达」（`Workbench.tsx:547`、`:1072`）→ 文案「预计送达（估）」；取货后若有骑手位置，用 5.3 的 `etaMinutes` 覆盖显示；
  2. 配送通知 `subscribe-message.ts:195` 固定 +30 分钟 → 改为 `max(order.estimatedDeliveryAt, now + providerDistanceM/riderSpeedKmh)`（`callback.ts:137-140` 调用处把 `order.estimatedDeliveryAt`、`delivery.providerDistanceM` 传进去，`:23-26` 的 include 加这两列）；
  3. 顾客结算页 `local/confirm.js:25-29` 与订单页 `:265` 已用同一公式，随 §3.1 改速度自动修正；文案前加「预计」。
- 验收：mock 模式 queue `queryCourier` 返回坐标（mock 现返回 null，`mock.ts:104-107` 加 directive 支持）→ 抽屉出现距离与 ETA；生产用下一单实跑截图；`orders.ts` 顾客端路由 e2e §34 契约锁不变。

### 5.4 时区：一个共享格式化工具 + 一道防回归闸门

**做什么**：
- 新建 `apps/admin/src/utils/time.ts`，全部用 `Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, ... })` 的 `formatToParts` 拼（照 `services/ticket/content.ts:149-160` 的 `fmtDateTime`），格式化器实例模块级缓存：
  `fmtDateTime(iso) → 'YYYY-MM-DD HH:mm'`、`fmtDate(iso) → 'YYYY-MM-DD'`、`fmtHHmm(iso)`、`fmtMonthDay(iso) → 'M-DD'`、`fmtMonthDayCn(iso) → 'M 月 D 日'`、`todayKey() / shiftDayKey(n)`（给 `ScanStats` 的查询区间用，与服务端 `local-day.ts` 的自然日口径一致）。
- 替换 §1 C5 列出的全部调用点（9 文件），`Workbench.tsx:56-65` 的 `hhmm/dateTime` 改为对 `time.ts` 的薄包装或直接删掉。
- **闸门** `scripts/check-admin-timezone.mjs`（照 `check-miniapp-es5.mjs` 用真解析不用 grep）：用 `typescript` 编译器 API（admin 的 devDependency，`createRequire` 锚 `apps/admin/package.json`，照 `check-channel-consistency.mjs:19-31` 的写法）遍历 `apps/admin/src/**/*.{ts,tsx}`，排除 `utils/time.ts`，凡 `PropertyAccessExpression` 名为 `toLocaleString | toLocaleDateString | toLocaleTimeString | getHours | getMinutes | getSeconds | getDate | getDay | getMonth | getFullYear | setDate | setHours | setMonth | setFullYear` 即报错退出 1（`getTime / Date.parse / Date.now` 是瞬时值，放行）。挂进 `apps/admin/package.json`：`"build": "node ../../scripts/check-admin-timezone.mjs && tsc && vite build"`——`deploy.sh` 在生产机上 build admin，回归即部署失败。
- 小程序（低优先级，可与批次 3 一起）：`apps/miniapp/utils/time.js`（ES5；微信基础库对 `Intl.timeZone` 支持不齐，用 `new Date(ts + 8*3600*1000)` + `getUTCHours()` 手算 +08:00），替换 §1 C6 的 5 处；跑 `node scripts/check-miniapp-es5.mjs apps/miniapp/utils/time.js`。

**验收**：`node scripts/check-admin-timezone.mjs` 输出 0 违规；改系统时区到 UTC+7 后打开工作台，首单事件时间线显示 `19:59` 而非 `18:59`；`ScanStats` 「今日」在 UTC+7 的 00:00–01:00 之间仍查到上海今天的数据。

---

## 6. 用不顺（批次 3，小程序）

### 6.1 订单入口：**不改 tabBar**，两处加常驻入口

四种改法的权衡：

| 改法 | 效果 | 风险 | 结论 |
|---|---|---|---|
| A. tabBar 加「同城」第 5 项 | 同城页有底部栏 | `switchTab` 销毁非 tabBar 页栈；所有 `navigateTo('/pages/local/index')`（`cover/index.js:67`、`user/index.js:132`）要改成 `switchTab`；同城页 `onLoad` 参数传递方式变；「购物车」tab 对同城单是误导（角标只统计邮寄车 `app.js:104-119`，两车分开）；封面 `goExpress` 已经踩过一次 switchTab 销毁封面的坑（`cover/index.js:74-78`）。**回滚成本最高** | 不做 |
| B. 封面加「我的订单」 | 冷启动 1 步到订单 | 封面是整张图+透明热区（`cover/index.wxml`），要么改图要么叠一个真按钮 | **做**（叠真按钮，不动图） |
| C. 同城页顶部加「我的订单」 | 下单前后都能到订单 | 无 | **做** |
| D. 同城页自绘底部条 | 像 tabBar | 与 `local-cart-bar`（`local/index.wxml:125-134`）抢底部空间；自绘导航与原生风格不一致 | 不做 |

- B：`pages/cover/index.wxml` 在 `.cover-root` 下（`<privacy-popup>` 之前）加一个固定定位的底部按钮「我的订单」→ `wx.navigateTo({ url: '/pages/order/list' })`；`index.js` 加 `goOrders`；样式放 `.cover-root` 的兄弟层，避开舞台负偏移（同 `cover/index.wxml:18-22` 注释的理由）。
- C：`pages/local/index.wxml:18-33` `store-head` 的状态胶囊旁加文字链「我的订单 ›」→ 同上。
- 顺带：下单成功 `local/confirm.js:425` 用 `redirectTo` 到订单详情，详情页返回即回到同城菜单——这条已经通，不动。页栈深度 封面→同城→订单列表→详情 = 4 层，远低于 10 层上限。
- 订单列表不按渠道过滤（`orders.ts:457-470`）本就正确，不动。
- 部署：改完 `git -C /Users/yumingyi/food-shop merge --ff-only <分支>`（`docs/deployment.md:325-341`）再重传体验版；`node scripts/check-miniapp-es5.mjs` 过新增文件。
- 验收：冷启动封面底部有「我的订单」，点进能看到 `ORD20260906918208`；同城页顶部「我的订单」可点；返回键回到来路。

### 6.2 商品无图（店主待办，低优先级）

「商品管理」→「同城配送」→ 凉拌牛肉 / 凉拌三丝 各传一张实拍主图。验收：`https://api.yuegui-hotel.online/api/products?channel=LOCAL` 两件都有 `image`。

---

## 7. 数据不可信（批次 4）

### 7.1 MySQL 默认值时区：全库级处置

事实：Prisma 写 UTC 墙钟；所有 `created_at` 列默认 `CURRENT_TIMESTAMP(3)` 取会话时区（生产 `SYSTEM`=CST）；全仓无 `TIMESTAMP` 列、服务端原生 SQL 不依赖 `NOW()/CURDATE()`（§1 C8）。

**处置（两条都做）**：
1. 生产 MySQL 全局时区钉 UTC：`SET GLOBAL time_zone = '+00:00'`，并写入 `/etc/mysql/mysql.conf.d/mysqld.cnf` 的 `default-time-zone='+00:00'`（重启后仍生效）。之后 `NOW()` = `UTC_TIMESTAMP()`，裸 SQL 插入的默认值与 Prisma 一致。
   - 影响面：仅 `DATETIME` 列的默认值与手工 `mysql` 会话里 `NOW()` 的显示；Prisma 对 `DATETIME` 不做时区换算（与会话时区无关）；`local-day.ts` 假设「落库是 UTC」——正是这个前提被加固。
   - 验收：`sudo mysql -N -e "SELECT NOW(), UTC_TIMESTAMP()"` 两列相等；`docs/local-delivery-run-log.md` 的查单 SQL 结果不变。
   - 回滚：`SET GLOBAL time_zone = 'SYSTEM'` + 删配置行。
2. `docs/database.md` §三「关键设计说明」加 3.10「时间列一律 UTC」：裸 SQL 插入必须显式给 `created_at = UTC_TIMESTAMP(3)`，并注明「生产库时区已钉 +00:00」。

### 7.2 继续观察（不是待修 bug）

- **并呼未中标方不推 720**：首单 n=1 无 720。只呼最低价上线后并呼只在升级时发生，样本会更难攒——**每一张 `callStrategy=ALL` 的升级单都要在 run-log 记一行**（`delivery_events` 里有没有 `720@…` 前缀事件）。`callback.ts:72` 的「呼叫阶段收到 taskId 不匹配的 720」告警仍在，真出现会喊。
- 单家 `batchOrder` 行为（§4.3）。
- `riderSpeedKmh`、运费表：跑满 10 单后用 §附 SQL 复盘。

---

## 8. 风险与回滚

| 风险 | 说明 | 缓解 / 回滚 |
|---|---|---|
| **改 tabBar** | 影响全站导航语义；`switchTab` 销毁页栈；购物车 tab 对同城误导 | **本方案不改 tabBar**。若将来改：单独一批、先在体验版跑完 封面→同城→结算→订单→返回 全链路 |
| **改运费参数** | 直接改真实顾客付款；`LocalSettings.tsx` 整包 PUT、无乐观锁（`settings.ts:85-97`），两人同时改后保存者覆盖前者 | §3 的四条操作纪律；改前记下原值（`baseFee 6.00 / baseKm 3 / perKmFee 2.50 / freeThreshold 99.00 / minOrderAmount 40.00 / radiusKm 10 / riderSpeedKmh 15`）；回滚 = 改回并刷新回读 |
| 策略首单真钱 | 单家 `batchOrder` 未验证；升级竞态可能扣 ¥2 取消费 | 首单店主在场；`callStrategy.mode=ALL` 是**不部署即可关**的运行时开关；代码回滚 `DEPLOY_REF=<上一版> bash /home/ubuntu/deploy.sh`（迁移 additive，旧代码不读新列，安全） |
| 熔断态升级 | 撤单后呼不出 | 任务在熔断态直接跳过（§4.3） |
| e2e 默认变化 | §32 ③b 断言随 SOLO 默认变红 | 批次 1 内同步改（§4.5） |
| 时区闸门误报 | 例如合法的 `getTime()` | 白名单只放行瞬时值 API；误报 = 脚本 bug，改脚本不改业务 |
| MySQL 时区改动 | 手工查询看到的 `NOW()` 变 UTC，运维习惯要改 | 文档 + run-log 顶部已经写「库里存的是 UTC」；改动可一句回滚 |
| 小程序部署 | 主仓 main 不快进则开发者工具看不到 | `docs/deployment.md:325-341` 的判据命令 |

---

## 9. 部署顺序清单

1. **今天**：店主做批次 0（§3.1 速度 22；§3.2 由店主定；§3.3 不动）。
2. 批次 1：worktree 开发 → `tsc` → e2e（3105/food_shop_audit）→ `git bundle` 搬运（`docs/deployment.md:263-323`）→ `DEPLOY_REF=<sha> bash /home/ubuntu/deploy.sh`（含迁移）→ 生产 `SELECT call_strategy ...` 确认新列 → **首个真实 SOLO 单**（店主在场）→ run-log 记录。
3. 批次 2：可与批次 1 同一个 bundle，也可分开；admin dist 随 deploy.sh 重建；时区闸门随 build 生效。
4. 批次 4.1：任意时候，一条 SSH 改 MySQL 时区 + 文档。
5. 批次 3：小程序改动 → 主仓 `merge --ff-only` → 店主重传体验版 → 验收 → 发布。

---

## 附：对账与复盘 SQL（生产，只读）

```sql
-- 每单成本 vs 顾客付的运费（批次 1 上线后 actual_fee 才有值）
SELECT o.order_no, d.delivery_no, d.call_strategy, d.courier_company,
       o.distance_m, o.shipping_fee/100 AS paid, d.quoted_fee/100 AS quoted, d.actual_fee/100 AS actual,
       d.tip_fee/100 AS tip, d.cancel_fee/100 AS cancel,
       (o.shipping_fee - COALESCE(d.actual_fee, d.quoted_fee, 0) - d.tip_fee - d.cancel_fee)/100 AS margin
FROM deliveries d JOIN orders o ON o.id = d.order_id
WHERE o.is_test = 0 ORDER BY d.id DESC LIMIT 50;

-- 骑手均速复盘（取货→送达）
SELECT d.delivery_no, d.provider_distance_m, TIMESTAMPDIFF(SECOND, d.picked_up_at, d.delivered_at)/60 AS ride_min,
       d.provider_distance_m/1000 / (TIMESTAMPDIFF(SECOND, d.picked_up_at, d.delivered_at)/3600) AS kmh
FROM deliveries d WHERE d.status='DELIVERED' AND d.picked_up_at IS NOT NULL ORDER BY d.id DESC LIMIT 30;

-- 升级并呼是否出现 720（观察项）
SELECT e.delivery_id, e.status_desc, e.created_at FROM delivery_events e
WHERE e.status_desc LIKE '%720%' OR e.provider_status = 720 ORDER BY e.id DESC LIMIT 20;
```
