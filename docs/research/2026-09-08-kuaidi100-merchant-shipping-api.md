# 快递100「上门取件 API（线上支付）」接入调研 —— 全国邮寄预约寄件（2026-09-08）

用途：评估邮寄渠道能否像同城配送一样接快递100，由系统预约快递员上门取件，替代后台手填快递单号。
可信度：【官方】= api.kuaidi100.com 文档/FAQ 原文；【推断】= 基于文档与本仓库代码的判断；【待确认】= 需要店主/客服核实。
本文只调研，不动代码。同城调研见 `2026-09-03-kuaidi100-same-city-api.md`。

---

## 0. 结论速览

1. **可以接，而且比同城更顺手。** 快递100 面向这个场景的产品叫 **「上门取件 API（线上支付）」**（文档里也叫「商家寄件」）。同一个企业账号的 `key`/`secret`、同一套 `MD5(param+t+key+secret)` 签名、同样的 form 回调 + `salt` 验签、同样的预充值扣费——`services/delivery/kd100.ts` 的协议层几乎可以照搬，只是换接口地址和字段。
2. **接口地址** `https://poll.kuaidi100.com/order/borderapi.do`，`method=bOrder` 下单、`cancel` 取消、`detail` 查单、`batchPrice` 比价、`modifyOrder` 改预约时间。**有主动查单接口**（同城没有）。
3. **预约取件就是下单参数**：`dayType`（今天/明天/后天）+ `pickupStartTime`/`pickupEndTime`（`HH:mm`）。顺丰必填，间隔 ≥ 1 小时，**时段结束前 2 小时不能再约**（例如 19:00 结束的时段 17:00 后约不了）。
4. **支持 9 家**：顺丰（标快/特快）、京东（特惠送）、德邦、极兔、圆通、申通、中通、韵达、EMS。**没有顺丰冷运**——凉菜只能走常温快递 + 自己的保温包装。
5. **有测试环境**（`http://e-test.kuaidilab.com/api/order/borderapi.do`，测试平台 `testapi.kuaidilab.com`，**邀请制，找商务开**），能模拟全流程回调、不派真快递员、不扣钱。同城当时只能真钱联调，这次不用。
6. **费用**：接口免费，只收折扣运费 + 增值服务费（保价等）。下单预扣、揽收后按实际重量实扣多退少补；未揽收可接口取消并退回预扣，揽收后要找快递公司。
7. **单号什么时候有**：顺丰/京东/中通等同步返回 `kuaidinum`；**韵达是异步**，要等回调状态 0 才给单号（下单失败推 610，可重下）。
8. **物流轨迹**：下单时 `op=1` + `pollCallBackUrl` 可免费收轨迹推送（不用买查询套餐）；主动查要带返回的 `pollToken`，否则另计费。

---

## 1. 产品定位与选型【官方】

快递100 寄件类产品有四种，官方 FAQ「对接寄件接口，如何选型和免费测试」给的对照：

| 场景 | 产品 | 结算 | 适合我们吗 |
|---|---|---|---|
| 企业统一发货 | **上门取件 API（线上支付）** | 预充值，与快递100 结算 | **是**。「无需快递公司面单账号；费用预付并通过快递100 结算」「适合零售店铺和个体商家」 |
| 平台不垫资 | 上门取件 API（线下支付） | 寄件人当面付快递员 | 否。运费是官方标准价没折扣，且我们已向顾客收了运费，需要店铺统一付 |
| 有快递月结账号 | 电子面单 API | 与快递公司直接结算 | 否。「需要与快递公司合作并拥有其面单账号」，单量大、固定网点才划算 |
| 同城 | 同城急送 API | 预充值 | 已接入 |

上门取件 vs 电子面单的官方区别：电子面单「需要与快递公司合作并拥有其面单账号，费用直接与物流方结算」；上门取件「无需快递公司面单账号；费用预付并通过快递100 结算」「提供上门取件」。

## 2. 开通与账号【官方 + 待确认】

- 步骤：注册企业版 → 企业认证 → 在企业管理后台「账户概览」充值（**最低 100 元**）→「我的信息 → 企业信息」取 `key`/`secret`。
- 我们已经有企业账号和 `KD100_KEY`/`KD100_SECRET`（生产 `.env` 里都在，同城在用）。
- 【待确认】「上门取件（线上支付）」是不是要**单独开通产品**、余额是否与同城急送**共用同一个预充值账户**。文档说「接口调用免费」「预充值模式」，没有写按产品分账。开通前跑第 8 节的免费探测命令：返回 `returnCode=200` 且有价格就是已开通；返回 600「非法用户」或提示未开通就找客服/客户经理。
- 「如已签订合作合同，商务团队会配置专属折扣价格」；没签合同就是后台默认折扣价。
- 客服 0755-86719032；企业后台能看到专属客户经理。

## 3. 接口清单【官方】

正式：`POST https://poll.kuaidi100.com/order/borderapi.do`，`Content-Type: application/x-www-form-urlencoded`
测试：`POST http://e-test.kuaidilab.com/api/order/borderapi.do`（测试 key/secret 另发）

公共参数：`method` / `key` / `sign`（`MD5(param+t+key+secret)` 32 位大写）/ `t`（毫秒时间戳）/ `param`（JSON 字符串）。**与同城完全一致**。

### 3.1 `bOrder` 下单（预约寄件）

必填：`kuaidicom`、`recManName`、`recManMobile`、`recManPrintAddr`（≤300 字节）、`sendManName`、`sendManMobile`、`sendManPrintAddr`（≤300 字节）、`callBackUrl`（≤200 字节；同城是 50）。

可选（与我们相关的）：

| 参数 | 说明 |
|---|---|
| `cargo` | 物品名称，**京东 / 圆通 / EMS 必填**。建议一律传「凉菜（食品）」之类 |
| `serviceType` | 业务类型：顺丰「顺丰标快」「顺丰特快」；京东「特惠送」；德邦「标准快递」「德邦大件360」…；其余「标准快递」 |
| `weight` | kg，默认 1。快递员揽收后按实际重量重算（状态 15 / 155） |
| `dayType` / `pickupStartTime` / `pickupEndTime` | 预约取件：今天/明天/后天 + `HH:mm`。**顺丰必填**；间隔 ≥ 1h；时段结束前 2h 内约不了。各家可用时段：圆通 9-12/12-16/16-19；顺丰 9:00–22:00 每小时；京东 9-19 每 2 小时；申通/中通不回时间确认，17 点前默认当天、之后默认次日 |
| `valinsPay` | 保价额度（元），按家收费，可选 |
| `payment` | `SHIPPER` 寄付（默认）即可 |
| `remark` | 备注，可写「凉菜请轻放、勿压」 |
| `thirdOrderId` | 我们的订单号（≤32 位）——同城没有这个字段，这里**可以传自己的单号** |
| `salt` | 回调验签盐（≤100 字节），与同城同款 |
| `op=1` + `pollCallBackUrl` | 免费订阅物流轨迹推送 |
| `returnType`/`siid`/`tempid` | 云打印电子面单，需要面单打印机。**飞鹅小票机不是面单机**，首期不做，让快递员自己出单 |
| `sendIdCardType`/`sendIdCard` | 极兔/圆通支持寄件人实名，非必填 |

响应：`result` / `returnCode`（200 成功）/ `message` / `data.taskId` / `data.orderId` / `data.kuaidinum`（韵达为空，等回调）/ `data.pollToken`。

### 3.2 `callBackUrl` 回调（订单状态 + 费用）

POST form：`param`（JSON）+ `sign=MD5(param+salt)`。我们要回 `{"result":true,"returnCode":"200","message":"成功"}`，否则重推 2 次（最多 3 次）。

状态码（`data.status`）与我们该做的事【官方状态 + 推断的处理】：

| 状态 | 含义 | 官方备注 | 我们的处理（推断） |
|---|---|---|---|
| 0 | 下单成功 | 韵达异步下单在此推单号，触发预扣 | 记单号，订单显示「已预约取件」 |
| 1 | 已接单 | 推快递员姓名、手机 | 显示「快递员 xxx 将于 时段 上门」 |
| 2 | 收件中 | | 同上 |
| 10 | 已取件 | 不涉及结算 | **这一刻才转 `SHIPPED`、发发货通知**（单号确定、货已离店） |
| 11 | 揽货失败 | | 提醒店员：改约或换家 |
| 101 / 400 | 运输中 / 派送中 | | 更新轨迹 |
| 13 | 已签收 | | 可直接 `COMPLETED`（现在是发货 7 天自动完成） |
| 14 | 异常签收 | | 提醒店员 |
| 15 | 已结算 | 推实扣重量、折后运费、增值费；**触发实扣，可能推多次费用叠加** | 记运费成本；官方要求收到 15 后调 `synPay` |
| 155 | 修改重量 | 客服确认异常后推新费用 | 更新成本 |
| 166 | 订单复活 | | 少见，记日志 |
| 9 / 99 | 用户取消 / 订单取消 | 9 触发预扣退回 | 回到「待发货」，允许重新预约或手填单号 |
| 200 / 201 | 已出单 / 出单失败 | 云打印面单相关 | 首期不用 |
| 610 | 下单失败 | 韵达异步失败 | 允许重新下单 |

费用字段：`data.weight`（计费重）、`data.defPrice`（标准运费）、`data.freight`（折后运费）、`data.feeDetails[]`（`feeType/feeDesc/amount/payStatus`）。

### 3.3 其它

- `cancel`：`taskId` + `orderId` + `cancelMsg`（≤30 字）。未揽收可取消、预扣退回；已揽收要联系快递公司，可能产生逆向物流费。
- `detail`：按 `taskId` 查单，返回状态、`kuaidiNum`、`courierName`/`courierMobile`、`pickupStartTime/EndTime`、`feeDetails`、`payStatus`（-1 失败 / 0 未付 / 1 已付 / 2 无需 / 3 已退）。**同城没有的兜底手段**，超时/UNKNOWN 场景可以主动对账。
- `modifyOrder`：改 `dayType`/取件时段/收寄件人。
- `batchPrice`：一次最多 15 家，`kuaidiComList` + `sendManPrintAddr` + `recManPrintAddr` + `weight`，返回每家 `defPrice/price`（标准/折后总价）、`firstPrice/overPrice`（首重/续重）、`serviceType`。**免费**，可用来当探测和成本预估。
- `pollCallBackUrl` 轨迹推送：`status`（polling/shutdown/abort/updateall）+ `lastResult.data[]`（`context/time/ftime/status`），`sign=MD5(param+salt)`，失败重推 2 次、间隔 30 分钟。
- 错误码：200 成功 / 400 参数 / 500 服务器 / 501 重复提交 / 503 签名 / 600 非法用户 / 601 key 过期 / 700 回调地址错误。
- 下单常见业务失败（FAQ 里的原话）：「承运快递在当前订单的寄收地因风控暂不支持下单，请更换其他快递」「收件人详细地址中含有的中文字符个数较少」「目的网点停派」「该区域暂时不开放」「大于 2.49 公斤,请用德邦大件360」。**都要在后台给店员看得懂的提示并允许换家**。

## 4. 与现有代码的契合度【推断】

| 现状 | 契合 | 缺口 |
|---|---|---|
| `services/delivery/kd100.ts` 签名/超时/错误映射 | 签名、`post()`、超时按 UNKNOWN 处理全部可复用 | 接口地址不同；错误码体系不同（600/503 vs 30001…）；**这里有 `detail` 可主动对账，UNKNOWN 不必只等回调** |
| `routes/kd-callback.ts` 验签 `MD5(param+salt)` | 同款 | 新路由前缀（如 `/api/kd-send/:no`），nginx 需加 location（`/api/kd/` 那段的限流/gzip 分析同样适用） |
| `Order` 收货地址快照 `receiverFullAddress`（500 字符） | 直接作 `recManPrintAddr` | 限 300 字节 ≈ 100 汉字，要校验/截断；地址中文太少会被拒 |
| `local-settings.ts` 的 `store`（名称/电话/省市区/地址） | 直接作寄件人 | 只是复用读取，不改同城 |
| `Product.netWeightG` | 可算 `weight` | 需要「包装附加重量」（泡沫箱+冰袋很重）设置，否则预扣偏低、实扣多补 |
| `Shipment`（`expressCompany/expressNo/shippedAt`） | 保留，取件后回填 | 需新增 `taskId/orderId/kuaidicom/status/预约时段/courier/预扣与实扣运费/pollToken`——建议独立表 `express_bookings`，一单可多次预约（取消再约） |
| 后台 `/ship` 手填单号 | **保留作兜底**（快递员当面开单、或用别家） | 新增「预约寄件」动作：选快递公司 + 时段，展示 `batchPrice` 折后价 |
| 顾客端 `pages/order/detail` 只显示公司+单号 | 不变即可 | 后续可选：轨迹展示（靠 `pollCallBackUrl` 落库） |
| 发货通知 `WECHAT_TMPL_SHIP` | 复用 | 触发点从「店员点发货」改到「回调状态 10 已取件」 |
| 定时任务 `scheduler.ts` | 可加：预约后 X 小时未接单/未取件提醒店员 | |

## 5. 凉菜寄件的产品限制【推断，需店主判断】

1. **没有冷链**。API 里顺丰只有标快/特快，京东只有特惠送。要冷运只能线下和顺丰冷运签约走电子面单，或干脆常温快递 + 泡沫箱冰袋。这决定了能寄多远、哪些菜能寄。
2. **运费与成本脱钩**。顾客付的是后台固定运费/满额包邮，快递100 实扣按实重 + 轻抛系数（有单独 FAQ）。远单、重单会倒贴——和同城一样的问题，至少要把每单折后运费在后台显示出来。
3. **预约时段与营业时间要配**。顺丰上门最早 9:00，时段结束前 2 小时截单；下午 3 点后下的单基本只能约次日。现做凉菜要考虑「今天几点前的单今天走」的规则。
4. **保价**。`valinsPay` 可选；理赔走快递公司，快递100 不担责（服务协议原文：「托运物的安全由快递公司承担」「快递100 不承担托运物损毁、丢失等责任」）。
5. **风控/覆盖**。自贡揽收是否覆盖、哪几家能约、价格多少，**只能实测**（第 8 节命令）。

## 6. 店主侧要准备的事（按顺序）

1. **登录快递100 企业后台确认**：「上门取件 API（线上支付）」是否已开通；余额是否与同城共用；如未开通，联系客户经理或 0755-86719032 开通。
2. **向商务申请测试账号**（`testapi.kuaidilab.com`，邀请制），拿到测试 `key`/`secret`，给到开发用（会新增两个 env）。
3. **跑一次免费探测**（第 8 节），把返回原样发给开发：能确认开通状态、自贡可用的快递公司与折后价。
4. **定业务规则**：默认走哪家（建议顺丰特快优先）、备选顺序、默认预约时段、几点之后自动约次日、是否保价及金额、每 SKU 的包装后重量。
5. **包装规范**：泡沫箱 + 冰袋的实际重量称一次，给「包装附加重量」设置用。
6. **充值**：确认余额覆盖日常单量（余额低于最后一笔运费系统直接停单）。
7. **对账习惯**：次月账单在企业后台核对；重量异常/虚假揽收走工单或小程序「寄件异常反馈」。
8. **顾客沟通口径**：预约后顾客端先显示「已预约快递员上门取件」，取件后才是「已发货」。

## 7. 实施安排（估算，不含本次）

| 阶段 | 内容 | 谁 | 估时 |
|---|---|---|---|
| 0 | 第 6 节 1–3 项，拿到测试 key 与探测结果 | 店主 | 1–2 天（取决于快递100 商务） |
| 1 | 服务端：寄件 provider（复用 kd100 协议层）+ 回调路由 + `express_bookings` 表 + 状态映射 + 定时提醒；后台：「预约寄件」弹窗（比价、选家、选时段）、取消、成本展示；保留手填单号 | 开发 | 2–3 天 + Opus 复核 |
| 2 | 测试环境联调全状态；nginx 加 location；伪回调演练（同 `deployment.md:383-395` 的套路） | 开发 | 0.5 天 |
| 3 | 生产真单 1–2 张（寄给自己，可取消退回预扣）；观察状态 10/15 回调与费用 | 店主 + 开发 | 1 天 |
| 4 | 可选：轨迹推送落库 + 顾客端展示；签收自动完成 | 开发 | 1 天 |

## 8. 免费探测命令（店主/开发在本机跑，读生产 key，不打印密钥）

```bash
cat > /tmp/kd_probe.sh <<'EOF'
#!/bin/bash
set -u
ENV=/www/food-shop/apps/server/.env
KEY=$(grep -E '^KD100_KEY=' "$ENV" | cut -d= -f2- | tr -d '"'"'"' \r')
SECRET=$(grep -E '^KD100_SECRET=' "$ENV" | cut -d= -f2- | tr -d '"'"'"' \r')
T=$(date +%s000)
PARAM='{"kuaidiComList":["shunfeng","jd","zhongtong","yuantong","debangkuaidi","ems"],"sendManPrintAddr":"四川省自贡市自流井区丹桂街道丹桂40栋底楼","recManPrintAddr":"四川省成都市武侯区天府大道北段1700号","weight":"1.5"}'
SIGN=$(printf '%s' "${PARAM}${T}${KEY}${SECRET}" | md5sum | cut -d' ' -f1 | tr a-z A-Z)
curl -s -m 15 -X POST 'https://poll.kuaidi100.com/order/borderapi.do' \
  --data-urlencode "method=batchPrice" --data-urlencode "key=$KEY" --data-urlencode "sign=$SIGN" \
  --data-urlencode "t=$T" --data-urlencode "param=$PARAM"; echo
EOF
scp -q /tmp/kd_probe.sh ubuntu@162.14.114.95:/tmp/kd_probe.sh && ssh ubuntu@162.14.114.95 'bash /tmp/kd_probe.sh; rm -f /tmp/kd_probe.sh'
```

读结果：`returnCode` 为 `200` 且 `data` 里有各家 `price` → 已开通且自贡可寄；`600`/「非法用户」或提示产品未开通 → 去后台开通；某家没出现 → 该家不覆盖自贡。`batchPrice` 官方免费，不会扣余额。

## 8.1 探测结果（2026-09-08 17:07，店主在本机用生产 key 跑 batchPrice）

**产品已开通**：`returnCode=200`，9 家里 8 家回价。自贡→成都 1.5 kg，折后价 = 首重 + 续重 × 1（0.5 kg 按 1 kg 向上取整）：

| 快递 | 业务类型 | 折后首重 | 折后续重/kg | 折后总价 | 标准总价 |
|---|---|---|---|---|---|
| 极兔 jtexpress | 标准快递 | 5.40 | 1.20 | **6.60** | 9.00 |
| 圆通 yuantong | 标准快递 | 5.60 | 1.30 | 6.90 | 14.00 |
| 申通 shentong | 标准快递 | 5.60 | 1.45 | 7.05 | 10.00 |
| 韵达 yunda | 标准快递 | 5.80 | 1.30 | 7.10 | 13.00 |
| 中通 zhongtong | 标准快递 | 6.50 | 1.80 | 8.30 | 10.00 |
| 德邦 debangkuaidi | 标准快递 | 9.40 | 1.70 | 11.10 | 13.00 |
| 京东 jd | 特惠送 | 9.80 | 1.50 | 11.30 | 15.00 |
| EMS ems | 标准快递 | 13.50 | 3.60 | 17.10 | 14.00（折后反而更贵） |
| 顺丰 shunfeng | — | null | null | **null** | null |

### 顺丰：账号层面没配价，不是自贡的问题（17:09 复测）

- 带 `serviceTypeList:["顺丰标快"]` / `["顺丰特快"]` 单独查（一对一写法才对，长度不等会报 400「kuaidiComList与serviceTypeList 参数不匹配」）：**`returnCode=500`「当前线路未设置价格」**，成都、北京目的地都一样。
- 把寄件地换成成都再查顺丰，仍是 null。→ 结论：**这个企业账号上顺丰上门取件没有开价**，要找快递100 商务/客户经理问「顺丰上门取件（线上支付）能否开通、什么条件」。在此之前顺丰不在可选项里。

### 省外折后价（1.5 kg，续重按 1 kg 向上取整）

| 快递 | 成都 | 北京 | 上海 | 广州 | 西安 |
|---|---|---|---|---|---|
| 极兔 | 6.60 | 8.30 | 8.30 | 8.00 | 7.60 |
| 圆通 | 6.90 | 8.70 | 8.70 | 8.30 | 7.90 |
| 申通 | 7.05 | 8.50 | 8.50 | 8.60 | 8.60 |
| 韵达 | 7.10 | 9.10 | 9.10 | 8.40 | 8.70 |
| 中通 | 8.30 | 11.90 | 11.30 | 11.90 | 9.30 |
| 德邦 | 11.10 | 16.20 | 16.20 | 15.30 | 15.30 |
| 京东特惠送 | 11.30 | 17.30 | 16.50 | 16.50 | 15.10 |
| EMS | 17.10 | 27.90 | 27.90 | 27.90 | 27.90 |
| 顺丰 | 无价 | 无价 | 无价 | 无价 | 无价 |

3 kg → 北京：极兔 10.90、中通 15.80、京东 21.80（续重 2 kg，京东每公斤 4.50）。

**成本口径**：通达系省外 8–9 元/1.5 kg，京东省外 15–17 元；凉菜含冰袋泡沫箱很容易到 2–3 kg，京东省外 3 kg 就 22 元上下。现在后台是一口价运费/满额包邮，要么按目的地省份 + 重量分档，要么先只放开近距离区域。

## 9. 官方文档索引

- 产品介绍：https://api.kuaidi100.com/document/5f0ff095bc8da837cbd8aef6
- 接口文档（bOrder/cancel/detail/batchPrice/modifyOrder/回调/编码表）：https://api.kuaidi100.com/document/603cb649a62a19500e19866b
- 选型与免费测试：https://api.kuaidi100.com/document/ji-jian-select-test
- 寄件测试平台教程：https://api.kuaidi100.com/document/jijianceshipingtai
- 调试指引：https://api.kuaidi100.com/document/shang-jia-ji-jian-ce-shi
- 回调状态说明：https://api.kuaidi100.com/document/shang-jia-ji-jian-zhuang-tai-shuo-ming
- 预约时间切片：https://api.kuaidi100.com/document/shang-jia-ji-jian-yu-yue
- 费用：https://api.kuaidi100.com/document/shang-jia-ji-jian-fei-yong
- 取消：https://api.kuaidi100.com/document/quxiaodingdanq
- 与电子面单的区别：https://api.kuaidi100.com/document/qubiedianzimiandan
- callBackUrl vs pollCallBackUrl：https://api.kuaidi100.com/document/shang-jia-ji-jian-hui-diao
- 售后：https://api.kuaidi100.com/document/shang-jia-ji-jian-shou-hou
- FAQ 总目录：https://api.kuaidi100.com/document/list/shangjiajijianwenti
- 商家寄件服务协议：https://api.kuaidi100.com/document/shangjiajijianxieyi
- 线下支付版（对比用）：https://api.kuaidi100.com/document/cduan-ji-jian-chan-pin-jie-shao

未能打开：保价 FAQ（shang-jia-ji-jian-bao-jia）被本机浏览策略拦下；各家保价费率以后台/客服为准。
