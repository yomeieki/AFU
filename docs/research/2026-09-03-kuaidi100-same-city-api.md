# 快递100 同城急送 API 技术调研（2026-09-03）

调研日期：2026-09-03  
用途：为微信小程序凉菜店（丹桂阿福）设计同城配送接入方案  
可信度标注：【官方】= 直接来自 api.kuaidi100.com / developers.weixin.qq.com 官方文档；【SDK】= 来自快递100官方 GitHub demo 代码；【第三方】= 博客/社区/搜索摘要；【推断】= 本人基于以上材料的推断。

---

## 0. 结论速览（TL;DR）

1. 快递100 面向开发者的同城产品叫 **「同城急送 API」**（文档路径 `tong-cheng-ji-jian-*`，接口域名 `https://api.kuaidi100.com/bsamecity/order`），聚合 **顺丰同城、蜂鸟即配、美团配送、闪送、达达秒送、UU跑腿、裹小递** 7 家运力，支持「多品牌并呼」抢单。旧版「同城配送」文档（`order.kuaidi100.com/sameCity/order`，运力编码 `kfw` 快服务）仍可访问，但文档中心导航已只挂新版，应视为遗留版本。
2. 接入门槛低：注册企业版账号 → 预充值（**最低 100 元**）→ 拿 `key` + `secret` 即可调用。**无接口费，只收运费及其他服务费**。实时预扣、次月出账单。
3. 接口集合：`price`（单家查价）、`batchPrice`（多家比价）、`order`（下单）、`batchOrder`（并呼下单）、`cancel`（取消，返回 `cancelFee`）、`precancel`（预取消，仅 SDK 中出现，文档未写）、`addfee`（加小费）、`queryCourier`（骑手经纬度）、回调推送（POST form，`param` JSON + `sign`=MD5(param+salt)）。**没有主动「查询订单」接口**（新版），状态完全靠回调。
4. 状态机：`0 下单成功 → 100 已接单 → 210 待取件 → 230 已到店 → 310 配送中 → 520 已完成`，分支 `515 转单改派中`、`510 订单状态异常(非终态)`、`720 订单取消`。
5. 坐标：需要经纬度，`lbsType` 1=百度(BD-09) 2=高德(GCJ-02，默认)，精度需 6 位小数。微信小程序 `wx.getLocation({type:'gcj02'})` / 腾讯地图 均为 GCJ-02，直接传 `lbsType=2` 即可，**不需要额外买高德/腾讯 key**（除非要做地址→坐标解析）。
6. **没有沙箱/测试环境**（官方 FAQ 明示），只能真钱小额真单联调，取消会退回预扣（可能扣取消费）。
7. 回调重试：未正确响应则再回调 2 次（最多 3 次），间隔 1 分钟。
8. 对比：微信官方「微信物流服务-同城配送」只有顺丰同城+达达、有沙箱、按门店充值、起送 ¥4.32 起、充值 30 天未用自动退；快递100 运力更多、有并呼、有折扣价，但无沙箱。对单店凉菜铺推荐：**主用快递100 同城急送 + 并呼**，或先用微信同城配送做 MVP（有沙箱）。详见第 8 节。

---

## 1. 产品线与运力覆盖

### 1.1 快递100 的同城产品【官方】

| 产品名 | 文档入口 | 接口域名 | 状态 |
|---|---|---|---|
| **同城急送 API**（新版，本报告主体） | https://api.kuaidi100.com/document/tong-cheng-ji-jian-chan-pin-jie-shao （产品介绍）<br>https://api.kuaidi100.com/document/tong-cheng-ji-jian-jie-kou-wen-dang （接口文档）<br>https://api.kuaidi100.com/document/tong-cheng-ji-jian-can-shu-zi-dian （参数字典） | `https://api.kuaidi100.com/bsamecity/order` | 现行，文档中心导航唯一挂载的同城产品 |
| 同城配送（旧版） | https://api.kuaidi100.com/document/606436974344bf6fb00db217 （产品介绍）<br>https://api.kuaidi100.com/document/60643a49122cae053a5f6f53.html （下单）<br>https://api.kuaidi100.com/document/60643c894344bf6fb00db219.html （查询订单） | `https://order.kuaidi100.com/sameCity/order` | 遗留；调试工具 `/debug-tool/express-local-*` 仍指向它；示例运力 `kfw`(快服务)、`shansong`；状态码 0/1/10/13/9/99 |
| 产品营销页 | https://api.kuaidi100.com/product/local | — | 口号「一键聚合，全城速配」「多品牌并呼」 |

产品介绍原文【官方】：「同城急送API是专为拥有同城即时配送需求的企业、品牌商家、电商等组织提供的一套聚合运力与智能调度解决方案。」适用场景明确列出「餐饮外卖、生鲜配送」。

### 1.2 聚合运力编码表【官方，参数字典】

| 运力 | `kuaidicom` 编码 |
|---|---|
| 顺丰同城 | `shunfengtongcheng` |
| 蜂鸟即配 | `fengniaotongcheng` |
| 美团配送 | `meituantongcheng` |
| 闪送 | `shansongtongcheng` |
| 达达秒送 | `dadatongcheng` |
| UU跑腿 | `uupaotui` |
| 裹小递 | `gxdtongcheng` |

### 1.3 城市覆盖【官方 FAQ】

FAQ「同城配送覆盖哪些区域？」答复只有一句：**「以查价/下单接口响应为准。」**（https://api.kuaidi100.com/document/tongchengpeisonfugai ）。没有城市列表接口。实操上需要用门店坐标调 `batchPrice` 探测哪几家运力在本地可用。

### 1.4 骑手实时位置【官方】

有专门接口 `method=queryCourier`，返回 `courierLat` / `courierLng` / `lbsType`，「订单创建且骑手接单后，通过该接口获取骑手位置信息」。回调里附带 `courierName` / `courierMobile`。旧版查询接口还返回 `traiUrl`（地图链接）与 `predictDeliveryTime`，新版文档没有这两个字段。

### 1.5 订单分配机制【官方 FAQ】

「当前同城配送订单是抢单模式，由配送员抢单」，官方建议用并呼下单接口提高接单率（https://api.kuaidi100.com/document/tongchengfenpei ）。

---

## 2. 商户接入 / 认证 / 计费

### 2.1 开通流程【官方】

1. 注册企业版账号：https://api.kuaidi100.com/register/enterprise （「如何注册企业账号」https://api.kuaidi100.com/document/5eb9f5a886b0df41883139f3 ）
2. 「如何开通产品服务」（https://api.kuaidi100.com/document/5eb9f5b686b0df41883139f4 ）：需完成 **企业认证/实名认证**；进入企业管理后台 →「账户概览」→「立即充值」选套餐充值。
3. 授权参数：「请进入企业管理后台——我的信息——企业信息获取对应授权参数」。同城急送接口使用 **`key` + `secret`**（不是查询接口的 `customer`）。
4. 企业认证需要的材料清单官方文档未列出（【第三方】知乎/CSDN 提到营业执照 + 对公信息；具体以后台提示为准）。
5. 达达路由的额外一步【官方 FAQ】：若下单报「快递公司返回异常：没有绑定正式商户,请检查接口中source_id值」，「需要提供商户SourceID给快递100工作人员进行绑定」（https://api.kuaidi100.com/document/dadaxiadan ）。【推断】这意味着走达达运力时商家可能需要自己在达达开放平台有商户号并绑定给快递100；顺丰同城则用快递100的开发者 ID（FAQ「未找到店铺ID与开发者ID的映射关系」答复是「重新再调一次下单接口即可」，https://api.kuaidi100.com/document/shunfengtongchengzhanghaoyinshe ）。建议开通时直接问客服哪几家运力免绑定即用。

客服：0755-86719032 / 13828755241。

### 2.2 计费与结算【官方】

- 「接口调用免费，采用预充值方式」；FAQ：「同城配送接口无接口费，只收运费即及其他服务费（如有）。」（https://api.kuaidi100.com/document/jiekoufeiyong1 ）
- 「同城配送业务预充值额度最低100元起充，暂无充值优惠活动。」（https://api.kuaidi100.com/document/tongchengyuchongzhi ）
- 「每笔同城订单根据实际产生的配送费、加小费、取消费用实时扣费，快递100于次月生成月度账单」；下单预扣、取消退回预扣、揽收按预扣实扣（多退少补）。
- 骑手费由快递100从商家预充值余额扣除，商家不直接与运力方结算；营销页称「享专属底价，运力比价择优」，价格接口返回的是 `discountFee`（折扣价）。
- 余额低于最后一笔运费时系统自动停止下单（《商家寄件服务协议》https://api.kuaidi100.com/document/shangjiajijianxieyi ）。
- 预充值退款：「月结预充值款项在合同有效期内暂不提供退款服务」；套餐预充值仅在完全未使用时可申请退款（https://api.kuaidi100.com/document/chongzhituikuan ）。
- 发票：支持电子普票，1000 元以上可开增值税专票。
- 无合同、无保证金要求（预充值模式）。【推断】

### 2.3 H5/组件【官方 FAQ】

「同城不支持H5嵌入，目前只能API对接。」（https://api.kuaidi100.com/document/H5qianru ）—— 没有免开发组件，必须后端对接。

---

## 3. 接口清单（同城急送 API）【官方】

### 3.1 通用信封

- URL：`https://api.kuaidi100.com/bsamecity/order`
- 方法：HTTP POST 或 GET；`Content-Type=application/x-www-form-urlencoded;charset=UTF-8`
- 公共参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `method` | 是 | 业务类型：`price` / `batchPrice` / `order` / `batchOrder`(示例中写作 `batchorder`) / `cancel` / `addfee` / `queryCourier`；SDK 另有 `precancel` |
| `key` | 是 | 「授权码，请到快递100页面申请企业版接口获取」 |
| `sign` | 是 | 「32位大写，签名，用于验证身份，按MD5(param +t+key+ secret)的顺序进行MD5加密」，文档注：「不需要加上'+'号」，即 `MD5(paramJson + t + key + secret).toUpperCase()` |
| `t` | 是 | 毫秒时间戳，例 `1576123932000` |
| `param` | 是 | 业务参数 JSON 字符串 |

- 通用响应：

| 字段 | 类型 | 说明 |
|---|---|---|
| `success` | boolean | 提交结果 |
| `code` | int | 返回编码 |
| `message` | string | 描述 |
| `data` | object | 数据体 |
| `time` | int | 接口执行时间(ms) |

- 错误码表：

| code | 含义 | 处理建议 |
|---|---|---|
| 200 | 成功 | — |
| -1 | 服务器错误 | 间歇性异常或参数错误 |
| 30001 | 参数错误 | 检查参数类型及必填项 |
| 30002 | 验证签名失败 | 检查MD5加密顺序及大小写 |
| 30003 | 账号信息不正确 | 验证key是否正确 |
| 30004 | 账号余额不足 | 需要充值 |
| 30005 | 快递公司返回异常 | 检查参数完整性（运力方拒单原因会在 message 中） |
| 30006 | 参数转换异常 | 检查数据类型 |

- 限流：同城急送文档**未写任何 QPS/频率限制**。【第三方】快递100查询类接口有「访问频率过于频繁 504」及每日额度概念，同城下单类未见。

### 3.2 价格查询 `method=price`（单家运力询价）

`param` 字段（下单接口完全复用这一组）：

| 参数 | 必填 | 类型 | 官方说明 |
|---|---|---|---|
| `kuaidicom` | 是 | string | 「快递公司的编码，一律用小写字母」 |
| `lbsType` | 否 | int | 「坐标类型(1：百度坐标，2：高德坐标 ,默认2)」 |
| `recManName` | 是 | string | 收件人姓名，最大20 |
| `recManMobile` | 是 | string | 收件人手机号（手机/固话正则校验） |
| `recManProvince` / `recManCity` / `recManDistrict` | 是 | string | 省/市/区，各最大20 |
| `recManAddr` | 是 | string | 收件人完整地址，最大100 |
| `recManLat` / `recManLng` | 是 | string | 「收件人地址纬度/经度，默认高德坐标，长度最大10」 |
| `sendManName` / `sendManMobile` / `sendManProvince` / `sendManCity` / `sendManDistrict` / `sendManAddr` / `sendManLat` / `sendManLng` | 是 | string | 寄件人（门店）同上 |
| `weight` | 是 | string | 「物品总重量，例：1.5，单位kg」 |
| `remark` | 否 | string | 备注，最大255 |
| `orderType` | 否 | int | 「0：无需预约； 1：预约单送达时间； 2：预约单上门时间。 默认为0」 |
| `expectPickupTime` | 否 | string | 「期望取货时间，orderType=2时必填，例：2020-02-02 22:00:00」 |
| `expectFinishTime` | 否 | string | 「期望送达时间，orderType=1时必填」 |
| `insurance` | 否 | string | 「保价物品金额」 |
| `price` | 是 | string | 「物品总金额，例：100.23，单位：元」 |
| `goods` | 是 | List | 商品详情 |
| `goods[].name` | 否 | string | 商品名称 |
| `goods[].type` | 是 | string | 「物品类型，详见参数字典：三、物品类型对照表」；【SDK】demo 直接传中文 `"食品"` |
| `goods[].count` | 是 | int | 商品数量 |

响应示例（官方）：
```json
{"code":200,"data":{"orderId":"100025","deliveryDistance":"4702","discountFee":"0.10","taskId":"1221221122121"},"message":"success","time":0,"success":true}
```
（`deliveryDistance` 单位米；`discountFee` 单位元。查价也会返回 `taskId`/`orderId`。）

### 3.3 批量查价 `method=batchPrice`

- 额外参数：`kuaidiComList`（List）「快递公司编码列表，一律用小写字母，可同时传入多个公司编码」，其余同 `price`。
- 响应 `data.taskId` + `data.feeDetail[]`，每项：`kuaidiCom`、`distance`（「配送距离，单位：米」）、`discountFee`（「配送费（折扣价），单位：元」）。
- 用途：探测本地哪些运力可达并比价（覆盖城市唯一的判断手段）。

### 3.4 下单 `method=order`

- `param` = 3.2 全部字段 + 
  - `volume`（否，string，「体积，单位：cm3，长度最大20」）
  - `salt`（否，string，「签名用随机字符串，长度最多20」——回调验签用）
  - `callbackUrl`（否，string，「订单信息回调地址，长度最大50」⚠️ 只有 50 字符，域名要短）
- 响应 `data`：`taskId`（「32位随机字符串，用于记录订单整个生命周期」）、`orderId`（「同城寄件订单号」= 快递100订单号）、`deliveryDistance`、`discountFee`。**没有单独的 `fee` 字段，也没有运力方运单号字段**（旧版有 `kuaidiNum`）。
- 下单即预扣 `discountFee`。

### 3.5 并呼下单 `method=batchOrder`（示例中 `batchorder`）

- 参数：`kuaidiComList` + 下单全部字段（含 `callbackUrl`、`salt`）。
- 语义（官方）：「同时向多家同城快递公司发起下单请求，抢单成功后，自动取消其他同城快递公司订单」。
- 响应：`data.taskId`、`data.orderId`、`data.fee[]`（每项 `kuaidiCom`、`deliveryDistance`、`discountFee`，「每个元素对应一家快递公司的运力及报价」）。
- 最终中标运力通过回调 `param.kuaidicom` 得知（首单实测：`shansongtongcheng`）。
- **✅ 预扣规则已实测确认（2026-09-06，不必再问客服）**：**并呼的每一家各按自己的报价预扣一笔**，
  中标那家最终「已支付」，其余「未支付」（预扣后释放）。首单（`orderId 301077772`，8.94 km）
  快递100 后台四行与 `deliveries.quote_snapshot` 四家报价**一分不差**：

  | 金额 | 支付状态 | 运力 |
  |---|---|---|
  | ¥23.32 | **已支付** | 闪送 ← 中标，这就是实扣 |
  | ¥17.38 | 未支付 | 顺丰同城 |
  | ¥16.23 | 未支付 | 达达 |
  | ¥18.15 | 未支付 | 蜂鸟 |

  **推论一：「实扣费 = 中标运力报价」成立**（原先只是假设，`services/delivery/quote.ts`
  文件头据此把「只呼最低价」整套策略挂起未做——前提现已满足）。
  **推论二：并呼是余额放大器。** 一单占用 = Σ 各家报价（本单 ¥75.08）而实付只 ¥23.32。
  按最低充值 100 元算**并呼只能同时挂 1 单**，第二单即 `30004` → 熔断 → 店员按不动「呼叫骑手」。
  **推论三：`actualFee` 可以自动算出来**——`batchOrder` 响应 `fee[]` 每项带 `kuaidiCom`，
  就是这四行；拿回调里的中标 `kuaidicom` 去里面查即得。⚠️ 但 `kd100.ts` 的
  `createOrder` 目前在**类型标注层就没声明 `kuaidiCom`**（只有 `discountFee`/`deliveryDistance`），
  所以这个字段被丢掉了、只留了 `Math.min`。整改见
  `docs/superpowers/plans/2026-09-06-local-delivery-remediation.md` §4.2。

### 3.6 取消 `method=cancel`

| 参数 | 说明 |
|---|---|
| `taskId` | 下单返回 |
| `orderId` | 下单返回 |
| `cancelMsgType` | int，「取消原因类型，详见参数字典：四、取消原因类型对照表」 |
| `cancelMsg` | 取消原因文本（可选） |

响应：`{"code":200,"message":"success","data":{"cancelFee":"2"},"success":true}` —— `cancelFee` 为本次取消实际产生的费用（元），文档提示「注意可能产生费用」。取消费标准由各运力方决定，文档未列。

### 3.7 预取消 `method=precancel`【SDK，文档未列】

Java/Go/.NET 官方 demo 均有 `BSAMECITY_PRECANCEL` / `bsamecity_precancel.go`，参数与 `cancel` 相同（`orderId`、`cancelMsgType`、`cancelMsg`、`taskId`）。【推断】用于在真正取消前预览取消费；建议在小程序「取消配送」二次确认弹窗前调用。上线前用真实单验证一次。

### 3.8 加小费 `method=addfee`

- 参数：`taskId`、`orderId`、`tips`（「小费金额，单位：元」）、`remark`（可选）。
- 时机（官方）：「订单创建且骑手未接单的情况下通过该接口对订单进行加小费，截止订单完成前，都可以对订单加小费」。
- 应对超时无人接单的主要手段。

### 3.9 骑手位置 `method=queryCourier`

- 参数：`param.orderId`。
- 响应：`{"code":200,"data":{"lbsType":2,"courierLat":"31.26731662","courierLng":"120.63341715"},...}`
- 仅在骑手接单后有效；需轮询（文档未给频率限制，建议 ≥15–30s）。

### 3.10 订单状态回调（推送）

- 地址：下单时的 `callbackUrl`；「form method post」，`Content-Type=application/x-www-form-urlencoded;charset=UTF-8`。
- 表单字段：

| 字段 | 说明 |
|---|---|
| `taskId` | 任务ID |
| `sign` | 「加密字符串签名：MD5 (param +salt)」（下单传了 `salt` 才有；大小写文档未说明，建议不区分大小写比对） |
| `param` | JSON 字符串 |

- `param` 字段：`orderId`、`kuaidicom`、`status`(int)、`statusDesc`、`courierName`、`courierMobile`、`updateTime`（例 `2023-03-09 16:08:22`）。
- 商户必须响应：`{"result":true,"returnCode":"200","message":"提交成功"}`。
- 重试：「回调后如果没有得到合作方正确返回，会重复回调多2次，即最多回调3次，间隔1分钟」。→ 必须做幂等（按 `orderId+status+updateTime` 去重），且回调处理要快（先落库返回，再异步处理）。
- 由于没有主动查询接口，回调丢失后无法补偿 → 建议：① `callbackUrl` 高可用；② 保留 `queryCourier` 作为「骑手是否已接单」的兜底探测（返回位置即已接单）；③ 向客服确认是否有隐藏的 `query` 方法。

### 3.11 旧版「同城配送」接口（仅供识别，不建议新接）

- `https://order.kuaidi100.com/sameCity/order`，`method=order|query|cancel|auth`，签名 `MD5(param+t+key+secret)` 大写；需 `storeId`、`serviceType`、`com`（示例 `kfw`）、`partnerId/partnerKey`；无经纬度字段；回调状态 `0 下单成功 / 1 已接单 / 10 已取货 / 13 已签收 / 9 用户主动取消 / 99 订单已取消`；错误码 200/400/500/501/503/601(key已过期)。查询接口返回 `courierName/courierPhone/lat/lng/predictDeliveryTime/traiUrl`。

---

## 4. 订单状态机（同城急送）【官方】

| status | 名称 | 终态 | 备注 |
|---|---|---|---|
| 0 | 下单成功 | 否 | 已推给运力，待骑手抢单 |
| 100 | 已接单 | 否 | 有骑手；此后 `queryCourier` 可用 |
| 210 | 待取件 | 否 | 骑手前往门店 |
| 230 | 已到店 | 否 | 骑手到店，应触发店员出餐提示 |
| 310 | 配送中 | 否 | 已取货 |
| 515 | 转单改派中 | 否 | 骑手取消/改派，可能回到 100 |
| 510 | 订单状态异常 | 否（官方注「非终态」） | 运力方异常，statusDesc 说明；需人工介入 |
| 520 | 已完成 | 是 | 已送达 |
| 720 | 订单取消 | 是 | 商家取消 / 运力取消 / 超时无人接单等都归此 |

文档未定义「超时无人接单」「退回商家」「拒收」的独立状态码；【推断】无人接单最终以 720 + statusDesc 呈现，退回类会走 510 → 720/520，需在联调时用真实单观察 `statusDesc` 文案并按文案分类。

对比：微信即时配送状态码 101/102/103/201–205/301–305/401/501/502（见第 8 节），粒度更细，明确区分骑手原因取消、拒收、退回。

---

## 5. 地址与坐标要求

- 必须传经纬度（`sendManLat/Lng`、`recManLat/Lng`），并以省/市/区 + 详细地址配套。【官方】
- 坐标系由 `lbsType` 指定：`1` 百度 BD-09，`2` 高德 GCJ-02（默认）。不支持 WGS-84；**微信小程序 `wx.getLocation({type:'gcj02'})`、`wx.chooseLocation`、`wx.chooseAddress` 结合腾讯地图逆解析得到的均是 GCJ-02，直接用 `lbsType=2`。**【官方 + 推断】
- FAQ「接口返回距离与实际直线距离严重不符」：检查经纬度与 `lbsType` 是否一致，且「经纬度需精确到小数点后六位」（https://api.kuaidi100.com/document/tongchengjulibufu ）。
- 快递100 不提供地理编码；顾客地址若来自 `wx.chooseAddress`（无坐标）需自行调用腾讯位置服务 WebService 地址解析（需腾讯地图 key），推荐直接让顾客用 `wx.chooseLocation` 选点（自带坐标，无需额外 key）。【推断】
- 距离返回 `deliveryDistance`（米），是运力方路径距离而非直线。

---

## 6. 时效、预约、保价、物品类型、重量

| 项 | 官方规定 |
|---|---|
| 立即单 | `orderType=0`（默认） |
| 预约送达 | `orderType=1` + `expectFinishTime`（`yyyy-MM-dd HH:mm:ss`） |
| 预约取件 | `orderType=2` + `expectPickupTime` |
| 取件时间窗口 | 无窗口参数，只有单一时间点 |
| 保价 | `insurance`（保价物品金额，元）；保费由运力方计入 `discountFee`（文档未拆分字段）【推断】 |
| 物品类型 `goods[].type` | 参数字典枚举：文件、食品、药品、蛋糕、生鲜、鲜花、数码、服饰、汽配、珠宝、证照、其他（凉菜用 `食品` 或 `生鲜`）；【SDK】demo 传中文字符串 |
| 重量 | `weight` kg 必填；上限文档未写（各运力方一般 ≤ 5kg 起步价内，超重加价，超出上限由运力方拒单 → code 30005）【推断】 |
| 体积 | `volume` cm³ 可选 |
| 物品金额 | `price`（元）必填 |
| 时效 | 营销文案「平均 20 分钟取件、1 小时送达」【第三方/营销】；接口不返回预计送达时间（旧版有 `predictDeliveryTime`） |

---

## 7. 异常处理

| 场景 | 快递100 行为 / 建议 |
|---|---|
| 参数/签名/余额错误 | `code` 30001/30002/30004 同步返回，不产生订单 |
| 运力方拒单（超范围、超重、非营业时间、地区不支持） | `code=30005 快递公司返回异常`，`message` 带运力原文；建议按 `batchPrice` 结果只呼可达运力 |
| 超时无人接单 | 官方无专门说明。抢单模式；建议：下单 N 分钟（如 5 分钟）仍处于 `status=0` → `addfee` 加小费 1–3 元；再 N 分钟 → 对其他运力 `order`/`batchOrder`，或人工电话骑手/自配送；运力方自身超时会推 `720` |
| 骑手取消 | 推 `515 转单改派中`，运力方自动改派；若最终失败推 `720` |
| 商家取消 | `precancel` 预览 → `cancel`；`cancelFee` 从余额扣；接单后取消普遍会有 2 元左右违约金（微信同城配送文档给出顺丰接单 2 分钟后/达达 1 分钟后取消扣 ¥2，可作参考量级）【官方-微信侧】 |
| 配送异常/退回/拒收 | `510 订单状态异常`（非终态）+ `statusDesc`；无独立退回状态；需人工跟进 |
| 丢失/损坏/客诉/赔付 | 《商家寄件服务协议》：「自托运物交付快递公司收件快递员起至托运物签收止，托运物的安全由快递公司承担」「您应根据对应快递公司官网赔偿条款直接向快递公司索赔，快递100不承担托运物损毁、丢失等责任」「快递100不参与托寄物收件、派件、异常处理、理赔等环节工作」。即客诉走运力方；建议凉菜下单时填 `insurance` 保价 |
| 账单异议 | 收到账单后 5 个工作日内申诉，逾期视为认可 |
| 回调重复 | 最多 3 次、间隔 1 分钟 → 幂等 |

---

## 8. 微信小程序侧方案对比

### 8.1 微信官方的两套东西【官方，developers.weixin.qq.com】

**A. 微信即时配送（物流助手·即时配送，`/cgi-bin/express/local/business/...`）**
- 「微信官方免费接口，旨在解决餐饮、生鲜、超市等小程序的外卖配送需求」，接口免费，**配送费按商家与配送公司自有结算**（商家需先与顺丰同城/闪送/美团/达达/UU 各自签约、充值，再在 MP 后台「物流助手-即时配送」授权绑定账号）。
- 运力 `delivery_id`：`SFTC` 顺丰同城、`SS` 闪送、`MTPS` 美团配送、`DADA` 达达、`UU` UU跑腿；均要 `shop_no`。
- API：`delivery/getall`、`shop/get`(getBindAccount)、`order/pre_add`、`order/add`、`order/readd`、`order/precancel`、`order/cancel`、`order/get`、`order/addtips`、`test_update_order`(沙箱 mock)、回调消息 `update_waybill_status`/`add_express_path`。
- 状态码：101 待分配骑手 /102 分配成功 /103 商家取消 /201 骑手到店 /202 取货成功 /203–205 取货失败(商家取消/骑手原因/商家原因) /301 配送中 /302 配送成功 /303 商家取消开始返还 /304 无法联系收货人返还 /305 拒收返还 /401 返还成功 /501 运力系统原因取消 /502 不可抗力取消。
- 有沙箱；配送状态自动给用户发微信服务通知。
- 社区反馈：新商家在 MP 后台通常只看到「同城配送」而看不到「即时配送」——即时配送已被 B 方案取代/收口。【第三方社区】

**B. 微信物流服务·同城配送（intracity，`/cgi-bin/express/intracity/...`）**
- 「无特殊类目限制」，MP 后台开通并签协议即可；**运力只有顺丰同城 `SFTC` 和达达 `DADA`**，按门店「运力偏好」选运力，微信统一代结算，**不需要自己去运力方开户**。
- 计费：「1公里起送价¥4.32起」；充值到服务商/小程序/门店维度，「充值有效期30天，超期未使用自动原路退回」；取消违约金：顺丰接单后 2 分钟内取消扣 ¥2，达达接单后 1 分钟内取消扣 ¥2。社区商户反馈实际单价普遍 8–13 元且不能议价。【官方 + 第三方】
- API：`intracity/apply`、`createstore`、`querystore`、`updatestore`、`balancequery`、`preaddorder`、`addorder`、`queryorder`、`cancelorder`、`getcity`；`use_sandbox=1` 无需充值即可生成测试单（顺丰沙箱需固定收件人信息）；回调 MD5 验签。
- 状态：10000 创建成功 → 30000 接单 → 40000 到店 → 50000 配送中 → 70000 完成；20000 取消；90000 异常。
- 也有免代码路径：小程序管理后台「同城配送/到店自提」配置 + 「门店快送」频道（部分城市内测，免费，官方警告有假冒招商代理）。【官方社区公告】
- 注意「同城配送」名下还有一套面向服务商/配送商实现的 callback 文档（`immediate-delivery/deliver-by-provider`），与商家无关。

### 8.2 直连运力方（顺丰同城 / 达达）【第三方】
- 顺丰同城开放平台 https://openic.sf-express.com/ ：申请开发者 ID（`dev_id`）、`shop_id`、`appId/appSecret`，签名 `base64(md5(content&appId&appSecret))`，接口 `precreateorder/createorder/getorderstatus`；有测试开发者 ID；博客抱怨「没有对接接口的Demo，只有一个模板的示例代码」。
- 达达开放平台 https://newopen.imdada.cn/ （已更名京东秒送开放平台）：开发者账号 + 商户账号（`source_id`）+ 门店 `shop_no` + 商户后台充值 + 开发者绑定商户；有 QA 联调环境；商户可申请调整固定运费（社区反馈可谈到 3.5 元/单）。
- 每接一家运力就是一套账号、一套签名、一套状态机、一套结算。

### 8.3 三方案对单店凉菜铺的比较

| 维度 | 快递100 同城急送 | 微信物流服务·同城配送 | 直连顺丰同城/达达 |
|---|---|---|---|
| 运力 | 7 家，可并呼抢单 | 2 家（顺丰同城/达达），微信按偏好选 | 各 1 家 |
| 开户门槛 | 企业版认证 + 100 元预充值；达达可能需提供 SourceID 绑定 | MP 后台开通签协议 + 门店充值 | 各平台单独开户/充值/审核 |
| 价格 | 「专属底价/折扣价」，比价择优 | 起送 ¥4.32 起，实测偏高、不可议价 | 官方价，达达可谈固定价 |
| 沙箱 | **无** | 有（`use_sandbox`） | 顺丰有测试 dev_id；达达有 QA 环境 |
| 主动查单 | **无**（仅回调 + 骑手位置） | 有 `queryorder` | 有 |
| 骑手位置 | 有 `queryCourier` | 文档未明示 | 有 |
| 用户侧通知 | 需自建（订阅消息） | 微信自动服务通知 | 自建 |
| 状态粒度 | 9 个码，异常笼统 | 6 个码 | 细 |
| 与现有 Node 后端契合 | 一个 MD5 签名 HTTP 接口，最简单 | 需走 access_token + 小程序 API 加密 | 各不相同 |
| 余额沉淀 | 预充值不退（套餐未用完可退） | 30 天未用自动退回 | 各平台规则 |
| 客诉/赔付 | 找运力方（快递100不担责） | 微信客服中转 | 运力方 |

**建议**：
1. **首选快递100 同城急送**：一次对接覆盖 7 家运力、有并呼与加小费、签名简单、门槛 100 元；缺点是无沙箱、无主动查单——用「回调幂等 + queryCourier 兜底 + 后台人工核对」补。
2. **备选/并行：微信同城配送**用于快速 MVP 或做「快递100 全部不可达时」的第二通道（有沙箱，可先验证前端流程）。
3. 不建议单店直连顺丰/达达（多套账号与结算，且运力单一）。
4. 前端统一用 GCJ-02（`wx.chooseLocation`），后端把配送抽象为 `DeliveryProvider` 接口（`quote / create / cancel / addTip / courierLocation / onCallback`），先实现 kuaidi100 provider，保留 wechat provider 插槽。

---

## 9. 沙箱 / 测试 / 联调

- 官方 FAQ：「同城急送接口下单暂无测试环境、沙箱环境。」（https://api.kuaidi100.com/document/tongchengceshi ）
- 【第三方/搜索摘要引用官方文案】「下单调试需先充值运费，最低100元，下单预扣金额，取消订单返回预扣金额」；在线调试工具可测价格查询、下单、取消、下单回调。
- 在线调试工具（旧版路径）：https://api.kuaidi100.com/debug-tool/express-local-authorize / -order / -query / -cancel 。
- 官方 SDK/demo：Java `com.github.kuaidi100-api:sdk`（`BsamecityOrderReq/BsamecityCancelReq/BsamecityAddfeeReq/Goods`，常量 `PRICE/BSAMECITY_ORDER/BSAMECITY_PRECANCEL/BSAMECITY_CANCEL/BSAMECITY_ADDFEE`）；Go https://github.com/kuaidi100-api/go-demo `/bsamecity/*.go`；.NET https://github.com/kuaidi100-api/.net-demo 。无 Node 官方 SDK，需自写（签名 = md5 大写）。
- 联调策略建议：① 先只调 `batchPrice`（不扣费）跑通签名与坐标；② 用店内两点相距 1–2 km 的真实地址下 1 单立即单，观察回调全链路，收货后完成；③ 再下 1 单立刻 `precancel/cancel` 验证取消费与预扣退回；④ 记录各 `statusDesc` 文案用于前端映射。总成本 ≈ 2 单运费 + 可能的 2 元取消费。

---

## 10. 面向本项目的接入要点清单（供后续 plan）

1. 后台配置：`KD100_KEY`、`KD100_SECRET`、`callbackUrl`（≤50 字符，如 `https://api.xxx.cn/kd100/cb`）、门店坐标(GCJ-02, 6 位小数)、门店省市区、联系人电话。
2. 流程：用户下单选「同城配送」→ 后端 `batchPrice`（默认呼 `shunfengtongcheng,dadatongcheng,meituantongcheng,shansongtongcheng,uupaotui,fengniaotongcheng`）→ 展示运费（可加成/补贴）→ 支付成功后 `batchOrder`（或 `order` 指定最优）→ 存 `taskId/orderId/kuaidicom` → 回调更新状态 → 100 后每 30s `queryCourier` 供小程序地图 → 520 完结。
3. 回调：POST form；验签 `md5(param+salt)`；幂等；立即返回 `{"result":true,"returnCode":"200","message":"提交成功"}`。
4. 超时策略：`status=0` 超 5 分钟 → `addfee` 2 元；超 10 分钟 → 通知店员 + 允许切换自配送/退款。
5. 取消：先 `precancel` 看 `cancelFee` → 弹窗确认 → `cancel`；把 `cancelFee` 计入订单成本。
6. 余额监控：`code=30004` 告警；建议接现有 PushPlus 告警通道。
7. 物品：`goods=[{name:'凉菜',type:'食品',count:n}]`，`weight` 按 SKU 估重求和，`price` 订单金额，`insurance` 可选。

---

## 11. 引用 URL 全表

官方（快递100）
- https://api.kuaidi100.com/
- https://api.kuaidi100.com/product/local
- https://api.kuaidi100.com/document/
- https://api.kuaidi100.com/document/tong-cheng-ji-jian-chan-pin-jie-shao
- https://api.kuaidi100.com/document/tong-cheng-ji-jian-jie-kou-wen-dang
- https://api.kuaidi100.com/document/tong-cheng-ji-jian-can-shu-zi-dian
- https://api.kuaidi100.com/document/list/tongchengpeisongwenti
- https://api.kuaidi100.com/document/tongchengceshi
- https://api.kuaidi100.com/document/tongchengyuchongzhi
- https://api.kuaidi100.com/document/jiekoufeiyong1
- https://api.kuaidi100.com/document/tongchengpeisonfugai
- https://api.kuaidi100.com/document/tongchengfenpei
- https://api.kuaidi100.com/document/tongchengcvhaxun
- https://api.kuaidi100.com/document/shunfengtongchengzhanghaoyinshe
- https://api.kuaidi100.com/document/dadaxiadan
- https://api.kuaidi100.com/document/H5qianru
- https://api.kuaidi100.com/document/tongchengjulibufu
- https://api.kuaidi100.com/document/606436974344bf6fb00db217 （旧版产品介绍）
- https://api.kuaidi100.com/document/60643a49122cae053a5f6f53.html （旧版下单+回调）
- https://api.kuaidi100.com/document/60643c894344bf6fb00db219.html （旧版查询）
- https://api.kuaidi100.com/document/5eb9f5a886b0df41883139f3 （注册企业账号）
- https://api.kuaidi100.com/document/5eb9f5b686b0df41883139f4 （开通产品服务）
- https://api.kuaidi100.com/document/list/5eb9f77586b0df4188313a0a （账单与充值）
- https://api.kuaidi100.com/document/chongzhituikuan
- https://api.kuaidi100.com/document/shangjiajijianxieyi （商家寄件服务协议）
- https://api.kuaidi100.com/debug-tool/express-local-authorize / express-local-order / express-local-query / express-local-cancel
- https://api.kuaidi100.com/blogroll/instant-retail-with-api-solution
- https://api.kuaidi100.com/blogroll/regional-api
- https://api.kuaidi100.com/document/5f0ffb5ebc8da837cbd8aefc （起始 URL，实为实时查询接口文档）

官方 SDK/demo
- https://github.com/kuaidi100-api/java-demo （raw: src/test/java/BaseServiceTest.java）
- https://github.com/kuaidi100-api/go-demo
- https://github.com/kuaidi100-api/.net-demo

官方（微信）
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/immediate-delivery/overview.html
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/immediate-delivery/delivery_info.html
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/immediate-delivery/order_status.html
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/immediate-delivery/faq.html
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/express/business/intracity_service.html
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/express/delivery/local/interface.html
- https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/immediate-delivery/deliver-by-business/addOrder.html
- https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/immediate-delivery/deliver-by-business/addLocalOrder.html
- https://developers.weixin.qq.com/miniprogram/dev/server/API/weixin-express/same_city_distribution/api_intracity_addorder.html
- https://developers.weixin.qq.com/community/minihome/doc/000048df810058293210f819e6b401 （门店快送接入概引）

第三方
- https://cloud.tencent.com/developer/article/2185664 （顺丰同城直连经验）
- https://openic.sf-express.com/ 、 https://newopen.imdada.cn/ （仅首页可达）
- 微信开放社区多条商户反馈（运费 8–13 元、达达可谈固定价、充值 30 天自动退）——搜索摘要，未逐条打开
- 搜索引擎摘要：「下单调试需先充值运费，最低100元，下单预扣金额，取消订单返回预扣金额」「低至0.038元/单」（后者为快递100查询类产品宣传，与同城运费无关）

未能打开的页面：kuaidi100.gift.163.com 镜像（超时）、kuaidi100.apifox.cn（内容为商家寄件而非同城）、微信开放社区若干问答页（JS 渲染为空）、CSDN 达达教程（521）、知乎（403）。参数字典中「物品类型」是否另有数字编码未能 100% 确认，但官方 Java demo 传中文 `"食品"`。
