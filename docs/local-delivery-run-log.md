# 同城配送真机联调记录

> 边跑边填。**空着的格子就是还没跑到**，不要预填「应该是」的值——这份记录的全部价值
> 就在于它只写实际发生的事。操作步骤见 `docs/local-delivery-golive-manual.md`。
>
> 判据一律写「怎么查到的」，不写「我觉得」。

---

## 零、开跑之前的生产状态快照

| 项 | 值 | 怎么查到的 | 时间 |
|---|---|---|---|
| 生产 commit | `e91ea42` | `git -C /www/food-shop log -1 --oneline` | 2026-09-06 |
| `settings` 表行数 | 4 行：`member` / `member_cron_state` / `printer` / `shipping` | `SELECT * FROM settings` | 2026-09-06 |
| **同城设置来源** | **库里没有 `local_delivery` 行 → 全部走 `DEFAULT_LOCAL_SETTINGS`** | 同上 | 2026-09-06 |
| 同城总开关 | `false` | `getLocalSettings()` 直读 | 2026-09-06 |
| 分类 | 5 个，全 `EXPRESS` + `status=1`，**`LOCAL` 0 个** | `GROUP BY channel,status` | 2026-09-06 |
| 商品 | 8 个，全 `EXPRESS` + 全 `OFF_SHELF` | 同上 | 2026-09-06 |
| `deliveries` / `delivery_events` | **都是 0 行** | `SELECT COUNT(*)` | 2026-09-06 |
| 会员积分开关 | `false` | `settings.member` | 2026-09-06 |
| 打印机 | `enabled: true`，飞鹅云已上线 | `settings.printer` | 2026-09-06 |
| 订阅消息 | 发货 ✔ 退款 ✔ · **付款 ✘ 配送 ✘** | `/admin/system/status` | 2026-09-06 |
| nginx `/api/kd/` | **✅ 已补装并 reload** | 见下 §一.2 | 2026-09-06 19:13 |

---

## 一、花钱之前已经验通的（零成本，全部实测）

### 1. 快递100 链路是通的 —— 用免费查价证明

**方法**：生产上直接调 `_buildOrderParam` + `_sign` 复现 `batchPrice`（免费、不下单、不落库），
A/B 只变 `callbackUrl` 一个量，其余 param 完全相同。

| 组 | `callbackUrl` | 结果 |
|---|---|---|
| A | `""` | `HTTP 200` · `returnCode=30001` · `回调地址格式错误` |
| B | `https://api.yuegui-hotel.online/api/kd/D999999-99` | `HTTP 200` · `returnCode=200` · `success` |

**B 组拿到的自贡真实报价**（探测点：门店正北约 1.11 km 直线）：

| 运力 | 报价 | 道路距离 |
|---|---|---|
| `dadatongcheng` 达达 | **¥5.83** ← 最低 | 1422 m |
| `fengniaotongcheng` 蜂鸟 | ¥6.05 | 1427 m |
| `shunfengtongcheng` 顺丰同城 | ¥10.78 | 1422 m |
| `shansongtongcheng` 闪送 | ¥11.22 | 1500 m |

**这一发同时证明了 5 件事**：
1. `KD100_KEY` / `KD100_SECRET` 有效
2. 签名算法 `MD5(param + t + key + secret)` 与快递100 现行实现一致
3. **门店坐标被运力方正确解读**（1.11 km 直线 → 1422 m 道路，合理）
4. 自贡**有 4 家运力覆盖**——配置里挂了 7 家，`meituantongcheng`、`uupaotui`、`gxdtongcheng` **没返回报价**
5. 账户是活的：没欠费、没熔断

**衍生数据**：实测绕路系数 `1422 / 1110 = 1.28`。低于配置的兜底 `detourFactor = 1.7`，
也低于 2026-09-04 八方向实测的范围 `1.30–2.12`。**单方向单次，不足以改配置**，仅记录。

**最便宜与最贵差近一倍**（¥5.83 vs ¥11.22）——「只呼最低价」这个策略的收益是实的。

### 2. nginx `/api/kd/` 已补装

生产此前**缺**这一段（其余 8 个 location 都在），回调都落进通用 `location /api/`。

已补装 + `nginx -t` 通过 + `reload`。回滚点：
`/etc/nginx/conf.d/food-shop.conf.bak-before-kd-20260906_191030`

**验证（GET，路由只收 POST，不触发任何业务告警）**：

| 请求 | 结果 | 说明 |
|---|---|---|
| `/api/kd/D999999-99` + `Accept-Encoding: gzip` | `404` · `text/html` · 156 B · **无 `content-encoding`** | 正落在 http 级默认 `gzip_types text/html` 射程内却没被压 → `gzip off` 生效 |
| `/api/products` + `Accept-Encoding: gzip` | `200` · **有 `content-encoding: gzip`** | 对照组，证明补之前 ack **确实会被压** |

**所以那条 gzip 风险原本是真的**：快递100 若不解压 ack 就会判失败、重推 3 次后放弃，
**配送状态永久卡住，而店员看不出是回调丢了。**

---

## 二、已修但**还没上生产**的（跑真机之前必须部署）

⚠️ **生产跑的是 `e91ea42`，下面两条都不在里面。** 判据是在生产 dist 里 grep 特征串
（不能用 401/404 判——`/api/*` 整个前缀都在鉴权中间件后面）。

| commit | 修的什么 | 为什么这轮必须先上 | 生产 dist 特征串 |
|---|---|---|---|
| `26677a2` | `price()` 的 `callbackUrl` 写成空串 → **生产每一次查价都在静默失败** | 不修，顾客看到的配送费永远是「直线 × 1.7」估算，不是真实道路距离。实测这次高估 33% | 待部署后 grep `api/kd/quote` |
| `b6fd384` | 支付回调无守卫写会覆盖并发取消，把已释放的券与积分留在一张 PAID 单上 | 涉及钱与状态机 | `grep -rl "与取消并发" dist/` → **当前无命中** |

`34c1446`（小程序两个死按钮 + 隐私政策）与 `4f6a7ea`（nginx 模板与文档）不需要部署服务端，
但 `34c1446` 需要**重新上传体验版**才生效。

---

## 三、查价那个 bug 的连带影响（已修，记录用）

`kd100.ts:106` 的 `price()` 把 `callbackUrl` 写死成 `''`，导致：

| 受影响的东西 | 表现 | 有没有人会发现 |
|---|---|---|
| `/local/quote` 顾客查价 | `measureRoadDistanceM` 抛错 → catch 退回「直线 × 1.7」 → 只把 `distanceSource` 标成 `ESTIMATED` | ❌ 报价照样签发、订单照样能下，**完全静默** |
| `POST /admin/settings/local-delivery/probe` | 一直返回 42225 | 后台**没有按钮调它**，所以没人试过 |
| `selftest-kd100.ts --integration` | 一直报失败 | ❌ 它此前**只 `console.log` 不断言**，查价失败也 `exit 0`，等于没闸门 |

三条全部指向同一个根因，而三条都不会主动喊出来。已在 `26677a2` 里一起修掉，
并把 selftest 改成拿不到报价就 `exit 1`。

---

## 四、真机跑单记录（**待填**）

### 前置

| # | 事项 | 状态 | 备注 |
|---|---|---|---|
| P1 | 快递100 认证 + 余额 | ✅ | 店主确认；且 §一.1 的 B 组已间接证明账户可用 |
| P2 | 2–3 件商品的名称 / 售价 / 净重 / 实拍图 | ⬜ | **等店主** |
| P3 | 配送通知模板 ID + 字段编号 | ⬜ | **等店主**（⚠️ 别顺手加「付款成功通知」，会把配送挤掉） |
| P4 | 门店坐标复核 | ⬜ | 默认值已验证正确，建议仍在小程序确认一次图钉位置 |
| P5 | 测试收货地址（离店 ≤1 km、有人签收） | ⬜ | **等店主**。决定骑手费；实测 1.4 km 最低 ¥5.83 |
| P6 | `26677a2` + `b6fd384` 部署到生产 | ⬜ | 见 §二 |
| P7 | 体验版重传（含 `34c1446`） | ⬜ | 改了 `apps/miniapp/**` 必须先把 main 快进上去 |

### 建货

| # | 事项 | 结果 | 时间 |
|---|---|---|---|
| 1 | 建 `LOCAL` 分类 | | |
| 2 | 建同城商品 ×N | | |
| 3 | 删 8 个种子商品 | | |
| 4 | `GET /api/products?channel=LOCAL` 返回几件、是否都有图 | | |

### 配置与开关

| # | 事项 | 结果 | 时间 |
|---|---|---|---|
| 5 | `.env` 补 `WECHAT_TMPL_DELIVER` → `deliverTemplateSet` 转绿 | | |
| 6 | 起送金额 `40 → 0`、基础运费 `6.00 → 0.01` | | |
| 7 | 点「开启同城配送」→ `/api/local/meta` 的 `data.enabled` | | |

### 跑单

| 步 | 动作 | 期望 | 实际 | 时间 |
|---|---|---|---|---|
| 7.1 | 顾客下单 + 付款 | 订单 `PENDING_PAYMENT → PAID`；出票；播报 | | |
| 7.2 | 点「接单」（**不点「接单并呼叫」**） | 订单 `→ PREPARING`；**`Delivery` 表仍无行** | | |
| 7.3 | 备菜 | 菜真的做出来、打包好 | | |
| 7.4 | 点「呼叫骑手」 | `Delivery` 建行 `PENDING(0) → CALLING(10)`，写入 `providerTaskId` / `quotedFee` | | |
| 7.5 | 骑手接单 | 回调 `100 → ACCEPTED(20)`；卡片「未呼叫」变成真人姓名电话 | | |
| — | 骑手在路上 | `210 → ARRIVING(30)`；`230 → ARRIVED(40)` | | |
| 7.6 | 骑手取货 | 回调 `310 → DELIVERING(50)`，**同事务**订单 `→ SHIPPED`；发「配送中」通知 | | |
| 7.7 | 买家收货 | 回调 `520 → DELIVERED(100)` + 释放 `activeOrderId`，**同事务**订单 `→ COMPLETED` | | |

### 跑单时全程盯这两张表

```bash
ssh ubuntu@162.14.114.95 "sudo mysql -N food_shop -e \
  'SELECT id,delivery_no,status,status_rank,provider,provider_task_id,quoted_fee,tip_fee FROM deliveries ORDER BY id DESC LIMIT 5'"

ssh ubuntu@162.14.114.95 "sudo mysql -N food_shop -e \
  'SELECT id,delivery_id,status,status_desc,created_at FROM delivery_events ORDER BY id DESC LIMIT 30'"
```

### ⚠️ 最危险的一条：并呼 720 语义

配置里挂了 7 家运力，**并呼**出去；实测有 4 家会返报价，所以很可能是 4 家同时被呼。
**未中标的那几家会不会推 `720`（撤单）？代码里对此挂着「真实联调时请核实并呼语义」的告警。**

判错的后果是不对称的：把占位单终态化 → 中标骑手后续的 `100/310/520` 全部撞 `TERMINAL`
被静默丢弃 → 店员再呼一次 → **两个骑手两笔钱**。

**跑 7.5 时把 `delivery_events` 里每一条的 `status` 与 `provider_task_id` 都抄下来**：

| 收到时间 | `status` | `provider_task_id` | 与锁定的 taskId 是否一致 | 本地状态变成 |
|---|---|---|---|---|
| | | | | |

---

## 五、跑完之后（收尾清单）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 起送金额改回 `40.00`、基础运费改回 `6.00`，**刷新页面回读确认** | ⬜ |
| 2 | 测试单全额退款 | ⬜ |
| 3 | 测试单标 `isTest` | ⬜ |
| 4 | 把 §四 观察到的并呼 720 语义写进 `docs/order-flow.md` | ⬜ |
| 5 | 实际骑手费与 §一.1 的报价对不对得上（`Delivery.actualFee` 全仓从未写入，只能人工抄快递100 后台） | ⬜ |
| 6 | 手册里与实际不符的地方回改 `docs/local-delivery-golive-manual.md` | ⬜ |

---

## 六、实际花了多少钱（**待填**）

| 项 | 预估 | 实际 | 可退 |
|---|---|---|---|
| 商品钱 | 由商品定 | | ✅ |
| 运费 | ¥0.01 | | ✅ |
| 骑手配送费 | 约 ¥6（实测最低 ¥5.83 / 1.4 km） | | ❌ |
| 加小费（如果加了） | ¥0 | | ❌ |
| **净支出** | **约 ¥6** | | |
