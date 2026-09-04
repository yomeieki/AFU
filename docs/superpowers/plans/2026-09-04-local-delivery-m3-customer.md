# 同城配送 M3：小程序顾客端 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **前置**：M1（渠道与数据基础）、M2-A（配送引擎）、M2-B（接单工作台）已全部合入。本计划**只写小程序顾客端**，服务端除两处明确列出的小改动外不动。

**Goal:** 让顾客能在小程序里完整走完一单同城配送：从一个临时入口进入 → 浏览 LOCAL 菜单 → 加进与邮寄互不干扰的同城购物车 → 地图选点选地址 → 看到服务端给的距离/运费/预计送达 → 带 `quoteToken` 下单支付 → 在订单详情看到同城时间线、骑手与地图、以及接单后 5 分钟的「申请取消」入口。同时**保证全国邮寄一条路径都没变**。

**Architecture:** 顾客端两条通道共用同一套页面基建，只靠一个 `channel` 参数分叉。新增两张页面 `pages/local/index`（菜单）与 `pages/local/confirm`（确认），它们是 LOCAL 的**唯一**下单入口；既有 `pages/order/confirm` 保持写死 `EXPRESS` 不动——两条通道共用一个确认页是本计划**刻意避开**的设计（运费口径、起送口径、地址要求、失败码全都不同，合成一页只会让两边都脆）。金额与距离**全部**来自服务端 `/local/quote` 响应，顾客端一行计算都不写。`quoteToken` 的生命周期由确认页集中管理（见 §报价凭证生命周期），是本计划唯一的「金钱」风险点。

**Tech Stack:** 微信原生小程序（ES5 风格 `var`/`function`，与现有页面一致，不引入构建）+ 现有 `utils/request.js` 封装。验证：`tools/miniapp-preview`（静态视觉）+ 微信开发者工具（交互与真机）+ `scripts/e2e.sh` 第 34 段（顾客端字段契约锁）。

---

## 明确不做（本计划范围外）

写在最前面，避免执行时顺手扩散：

1. **不做封面页**。封面（主入口「同城配送 / 全国邮寄」）在另一分支，本计划只按 §临时入口决定 做一个可一行删除的临时入口，并保证入口契约与封面将来要用的一模一样。
2. **不做「同城立即购买」**。LOCAL 商品详情只提供「加入同城购物车 → 去同城结算」，不做 `mode=direct` 直达。第二条下单路径意味着第二套报价凭证管理，收益不抵风险。
3. **不做同城分类/商品的搜索**。`pages/local/index` 只做左分类右商品，搜索留给邮寄的 `pages/product/list`。
4. **不做预约配送、餐具明细、多骑手拆单、会员/积分**。规格 §12 二期项一条都不碰。
5. **不做飞鹅/打印机、不做工作台、不动后台**。M2-B 已交付，本计划不改 `apps/admin` 任何文件。
6. **不做「已送达」订阅消息**。规格 §6 明确：只在 310 发一条「配送中」，那是 M2 已落地的服务端行为；新增模板要走公众平台申请，属 M4。
7. **不动生产、不 push、不碰密钥、不做真机真钱联调**（属 M4）、**不接飞鹅**。
8. **地址列表不显示「道路距离」数字**。只显示直线粗估与可配送状态，理由与边界见 Task 4 Step 2。
9. **不改 `pages/order/confirm.js` 的 `deliveryType: 'EXPRESS'`**。它写死 EXPRESS 是正确行为，不是待修的遗留。

---

## Global Constraints

- **金额、距离、预计送达一律来自服务端**。顾客端禁止出现任何 `baseFee + perKm` 之类的运费计算，也禁止把 `straightDistanceM` 当成计费距离展示。唯一例外见 Task 4 Step 2（地址列表的直线粗估标签，措辞必须带「直线约」且不参与任何禁用/放行判断）。
- **LOCAL 下单必须带 `quoteToken`**，且只能来自**本次会话、本地址、本小计**的那一次 `/local/quote`。凭证失效的判定与重取时机见 §报价凭证生命周期，任何偷懒（例如缓存 token 跨地址复用）都会变成 42239/42227 的线上噪音。
- **两条通道的购物车物理隔离**：LOCAL 只读写 `GET /cart?channel=LOCAL`，EXPRESS 保持不带参数（服务端默认 EXPRESS）。tabBar 购物车角标 **只统计 EXPRESS**，语义不变。
- **邮寄零回归**：本计划改动的公共文件只有 `utils/request.js`、`api/*.js`、`app.js`、`pages/cart/index.*`、`pages/product/detail.*`、`pages/order/{list,detail}.*`、`pages/address/list.*`、`pages/index/index.*`、`app.json`。每一处改动都必须是**加分支**而不是改既有分支，且 Task 9 的邮寄回归清单必须逐条过。
- **坐标一律 GCJ-02 微度 Int**（`latE6 = round(lat × 1e6)`），字段名 `latE6/lngE6`，与服务端 `Address`/`quote` 一致。
- **位置接口只用 `wx.chooseLocation`（地图选点），不用 `wx.getLocation`**。顾客端自动定位没有申请、也不需要；`app.json` 的 `requiredPrivateInfos` 保持只有 `chooseLocation`（`docs/miniapp-release-checklist.md` 2.4 的勾选与之逐条对应，改代码就要改那张表）。
- **代码风格**：沿用现有小程序页面的 ES5 风格（`var`、`function`、`self = this`），不用箭头函数/解构/模板串（`pages/index/index.js` 里既有的少量 ES6 是历史，不作为新代码的样板）。不引入 npm 依赖、不引入构建步骤。
- **错误码分流写在页面里，不写在 `utils/request.js` 里**。`request` 只负责把 `code` 透出来；「这个码该弹什么、该跳哪」是页面的业务判断。
- 环境：后端 `:3100` / 库 `food_shop_sc` 已常驻，**不要另起也不要杀**；e2e 连跑间隔 60s。
- 提交信息用中文 `type(scope): 摘要`，结尾附 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。

---

## 临时入口决定：**方案 A —— 首页顶部双入口卡片**

规格 §6 约定的封面入口契约是：同城 → `wx.navigateTo('/pages/local/index')`；全国邮寄 → `wx.switchTab('/pages/index/index')`。封面未落地，M3 必须自己有个入口，**选定方案 A**：

在 `pages/index/index`（首页，tabBar 第一项）Banner 与「商品分类」之间插入一组双入口卡片：

| 卡片 | 文案 | 行为 |
|---|---|---|
| 同城配送 | 主标题「同城配送」+ 副标题按 `/local/meta` 动态：`enabled=false` → 「即将开通」（卡片置灰不可点）；`paused` → 「暂停接单」+ 原因；`isOpen=false` → `nextOpenText`；正常 → 「约 x.x km 内 · 满 ¥xx 起送」 | `wx.navigateTo({ url: '/pages/local/index' })` |
| 全国邮寄 | 「全国邮寄 · 顺丰冷链」 | 无跳转，卡片本身即「你正在看的就是邮寄」，点击滚动到分类区（`goToAllProducts`） |

**为什么是 A：**
- 入口契约与封面将来要用的**逐字相同**，封面落地时删掉这段 wxml + 一个方法即可，不留残渣。
- 首页是唯一「顾客一定会经过、且不属于任何一条既有下单路径」的位置——放在这里不需要改任何既有交互。
- `enabled/paused/isOpen` 的展示逻辑本来就要写（菜单页页头也要），在首页复用一次没有额外成本，还顺带让店主能在真机上直观验证「后台一关，顾客端立刻变灰」。

**为什么不是 B（分类 Tab 加一个「同城」）：** `pages/product/list` 是邮寄菜单页，也是 tabBar 页。在它左侧分类栏里塞一个 LOCAL Tab，会让同一个页面同时持有两个渠道的商品列表和两个购物车条，`switchTab` 又不能带参数（现有 `pendingCategoryId` 已经是绕这个限制的补丁）。风险集中在**唯一一条已上线的下单路径**上，不值得。

**为什么不是 C（「我的」页入口 / 胶囊菜单）：** 发现率太低，等于 M3 做完也没法让店主真机走通一遍完整链路，验收无从谈起。

**收口约束：** 方案 A 的所有代码集中在 `pages/index/index.wxml` 的一个 `<view class="channel-entry">` 块、`index.wxss` 的一段样式、`index.js` 的 `loadLocalEntry()` 一个方法。`index.js` 里用一行注释 `// 临时入口：封面落地后整块删除（见 M3 计划 §临时入口决定）` 标住。

---

## 报价凭证生命周期（本计划最关键的一节）

服务端事实（已核实 `apps/server/src/services/local-settings.ts` 与 `routes/orders.ts`）：

- `POST /local/quote {addressId, subtotal}` 返回 `{ inRange, distanceM, distanceSource, straightDistanceM, fee, minOrderAmount, belowMin, estimatedMinutes, isOpen, paused, nextOpenText, enabled, quoteToken }`。
- `quoteToken` **只在 `inRange && addressId > 0` 时签发**，否则为 `null`。匿名报价（只传坐标）签出来的票下单必然兑不了。
- token 里签了：`fee / distanceM / addressId / 收货 latE6,lngE6 / 门店 latE6,lngE6 / distanceSource / 过期时刻`，TTL **15 分钟**。
- 下单时服务端：`addressId` 或**收货坐标**对不上 → `42239`；**门店坐标**对不上 → `42227`；用 token 里的 `distanceM` 重算运费，`重算 fee > token.fee` → `42227`，否则**按重算 fee 实收**（该免的运费照免）。

由此得出顾客端的硬规则：

**必须重新报价的时机（五条，缺一条就是线上事故）**
1. 切换收货地址（`addressId` 变）。
2. 商品小计变化（改数量、删项、SKU 变）——`freeThreshold` / `minOrderAmount` 都按小计判断，小计变了运费就可能变。
3. 确认页 `onShow`（可能刚从地址编辑页回来，坐标被改过）。
4. 距上次成功报价 ≥ **10 分钟**（服务端 TTL 15 分钟，留 5 分钟余量给顾客点「提交」到服务端校验的这段时间）。
5. 提交后收到 `42227` / `42239`。

**报价期间提交按钮必须禁用**（`quoting: true` → `disabled`）。拿旧 token 提交是这类 bug 的标准现场。

**收到 42227 / 42239 时：自动重报一次价，但绝不自动重新提交。** 金额可能变了，必须让顾客看见新运费再点一次。文案见下表。

**报价失败（网络/限流/500）不清空已有的展示，只禁用提交并显示重试。** 服务端 `localQuoteLimiter` 是 **30 次/分钟/IP**：数量步进器必须 **debounce 500ms** 后再报价，且 `onLoad` 与 `onShow` 不得各报一次（用 `this._quotedOnce` 去重）。

---

## 失败与金钱路径速查表（Task 5 / Task 7 逐条实现，Task 9 逐条验收）

| 触发 | 服务端码 | 顾客端表现 | 恢复动作 |
|---|---|---|---|
| 未带 / 过期 / 伪造 `quoteToken` | `42239` | toast「配送费需要重新确认」 | 自动重报价 → 更新运费条 → 顾客手动再提交 |
| 改了收货坐标后拿旧票下单 | `42239` | 同上 | 同上 |
| 店主改了门店坐标 | `42227` | toast「配送费已更新，请确认后重新提交」 | 自动重报价，新运费用高亮闪一次 |
| 改数量导致重算运费变贵（掉出免运门槛） | `42227` | 同上 | 同上；正常路径下已被「小计变化即重报价」拦住，此码是兜底 |
| 超出配送范围 | `42220` | 运费条变红：「超出配送范围（约 x.x km，最远 N km）」，提交禁用 | 两个按钮：「换个地址」→ 地址列表；「改用全国邮寄」→ `switchTab` 首页 |
| 非营业时间 | `42222` | 页头黄条：「当前非营业时间，<nextOpenText>」，提交禁用 | 「改用全国邮寄」 |
| 同城未开通 / 暂停接单 | `42226` | 页头黄条：暂停原因原样展示；提交禁用 | 「改用全国邮寄」 |
| 地址缺少定位 | `42223` | 地址卡下红字「该地址缺少定位」+「去补充定位」 | 跳 `address/edit?id=&channel=LOCAL` |
| 未达起送 | `42210` | 底部条「还差 ¥x 起送」，提交禁用 | 就地加菜（返回菜单页） |
| 超单次件数/重量上限 | `42230` | modal 原样展示服务端文案（含「分单或电话联系商家」） | 「联系商家」拨号 |
| 商品渠道不符 | `42224` | modal 原样展示服务端文案 | 「返回同城菜单」 |
| 报价限流 | `42901` / 429 | toast「操作太频繁，请稍后再试」 | 3 秒后自动重试一次，仍失败则显示手动「重新获取运费」 |
| `wx.chooseLocation` 用户取消 | — | **静默**，什么都不弹 | — |
| `wx.chooseLocation` 权限被拒 | — | modal「需要位置权限」+「去设置」 | `wx.openSetting()` |
| 隐私协议未同意 | — | 官方隐私弹窗（Task 6），未同意则位置接口不可用 | 同意后重试 |
| 骑手位置查不到 | 接口返回 `location: null` | 地图整块不渲染（不显示空地图、不报错） | 30s 后下一轮轮询 |
| 配送异常态（`REASSIGNING`/`ABNORMAL`/`UNKNOWN`/`CANCELLED`） | — | 中性文案「配送正在协调中，如超过预计时间请联系商家」 | 「联系商家」 |

**文案铁律**：`42220/42222/42226/42230/42224/42210` 的 message 服务端已经写好且带具体数字（半径、营业时间、上限、差额），顾客端**原样透出**，不要自己拼一句更含糊的。只有 `42227/42239` 例外——它们的服务端文案是给开发看的，顾客端换成上表的说法。

---

## 文件结构（本计划涉及）

| 路径 | 职责 |
|---|---|
| `apps/miniapp/utils/request.js` | **改**：reject 的 Error 带上 `code`/`data`；新增 `silent` 选项 |
| `apps/miniapp/api/local.js` | **新**：`getLocalMeta()`、`quote()` |
| `apps/miniapp/api/cart.js` | **改**：`getCart(channel)`、`addToCart` 返回体透出 `channel` |
| `apps/miniapp/api/order.js` | **改**：`getOrders` 无需改；新增 `requestCancel(id, note)`、`getCourier(id)` |
| `apps/miniapp/app.js` | **改**：`updateCartCount` 显式 `channel=EXPRESS`（+ 注释）；`onNeedPrivacyAuthorization` 监听 |
| `apps/miniapp/app.json` | **改**：注册 `pages/local/index`、`pages/local/confirm`；`__usePrivacyCheck__: true` |
| `apps/miniapp/components/privacy-popup/*` | **新**：官方隐私授权弹窗组件 |
| `apps/miniapp/pages/local/index.{js,wxml,wxss,json}` | **新**：同城菜单页（页头 + 左分类右商品 + 同城购物车条） |
| `apps/miniapp/pages/local/confirm.{js,wxml,wxss,json}` | **新**：同城确认页（地址 + 报价 + 备注/餐具 + 下单） |
| `apps/miniapp/pages/index/index.{js,wxml,wxss}` | **改**：临时双入口卡片 |
| `apps/miniapp/pages/cart/index.{js,wxml}` | **改**：空态时提示「同城还有 N 件未结算」 |
| `apps/miniapp/pages/product/detail.{js,wxml}` | **改**：LOCAL 商品的渠道上下文与按钮文案 |
| `apps/miniapp/pages/address/list.{js,wxml,wxss}` | **改**：`channel=LOCAL` 选择模式（可配送状态 + 补充定位） |
| `apps/miniapp/pages/order/detail.{js,wxml,wxss}` | **改**：同城分支（时间线/骑手卡/地图/轮询/取消窗口/隐藏快递卡） |
| `apps/miniapp/pages/order/list.{js,wxml,wxss}` | **改**：渠道标签 |
| `tools/miniapp-preview/{serve.mjs,pages/*.html,index.html}` | **改**：新增 `local-index`、`local-confirm` 镜像，order-detail 镜像补同城态 |
| `scripts/e2e.sh` | **改**：新增第 34 段「顾客端字段契约锁」 |
| `docs/miniapp-release-checklist.md` | **改**：`__usePrivacyCheck__` 一节由「需重新评估」改为已落地；新增页面路径 |
| `docs/superpowers/specs/2026-09-03-local-delivery-design.md` | **改**：§2.1 前置检查结论、§3.1.3 地址列表距离标签的实际口径（spec 补丁） |

---

### Task 0: `<map>` 能力前置检查（10 分钟，先做，不阻塞其余）

规格 §2.1 的 D9 附带前置检查项。**先做掉**，因为结论决定 Task 7 是画 `<map>` 还是退化成 `cover-view` 静态两点图。

**Files:**
- Create: `docs/superpowers/notes/2026-09-04-map-probe.md`（结论记录，三行即可）
- Modify: `docs/superpowers/specs/2026-09-03-local-delivery-design.md`（§2.1 末尾追加实测结论）

- [ ] **Step 1: 空白页探针**

微信开发者工具里临时新建一页（**不要提交进仓库**），只放：
```xml
<map style="width:100%;height:400px" latitude="29.339" longitude="104.778"
     markers="{{[{id:1,latitude:29.339,longitude:104.778,width:24,height:24}]}}" />
```
不配置任何腾讯位置服务 key。看：能否渲染、Console 有无 key 相关报错、地图上有无水印或授权提示。

- [ ] **Step 2: 真机预览同一页**（模拟器与真机的地图实现不同，必须两边都看）

- [ ] **Step 3: 记录结论并决定 Task 7 的地图方案**

三种结论对应三条路：
- **可用（预期）** → Task 7 按 `<map>` 实施。
- **有 key 限制** → Task 7 改 `cover-view` 静态方案：门店/顾客两点 + 文字距离 + 「骑手距您约 x.x km」，其余（轮询、生命周期、异常文案）**全部照做**。
- **完全不可用** → 同上，并在笔记里写明，M4 由用户决定是否去 lbs.qq.com 申请个人开发者 key。

**Done:** `docs/superpowers/notes/2026-09-04-map-probe.md` 存在且写明「模拟器 / 真机 / 结论 / Task 7 走哪条路」四行；spec §2.1 末尾有一行实测结论。**不要因为这一项阻塞 Task 1–6。**

---

### Task 1: 请求层透出错误码 + API 层渠道化 + 首页临时双入口

**Files:**
- Modify: `apps/miniapp/utils/request.js`
- Create: `apps/miniapp/api/local.js`
- Modify: `apps/miniapp/api/cart.js`、`apps/miniapp/api/order.js`
- Modify: `apps/miniapp/app.js`、`apps/miniapp/app.json`
- Modify: `apps/miniapp/pages/index/index.{js,wxml,wxss}`

**Interfaces:**
- Consumes: `GET /local/meta`、`POST /local/quote`、`GET /cart?channel=`、`POST /orders/:id/cancel-request`、`GET /orders/:id/courier`（均已由 M1/M2 落地，本 Task 不改服务端）。
- Produces: `api/local.js` 的 `getLocalMeta/quote`；`request()` 的 `err.code`。

- [ ] **Step 1: `utils/request.js` 透出 `code`，新增 `silent`**

现状：`reject(new Error(msg))` 把 `code` 丢了，确认页无法按 42227/42239/42220 分流。改动只有两处，对既有调用方**完全兼容**（它们只用 message 和 toast）：

```js
function doRequest({ url, method = 'GET', data = {}, silent = false }, retried) {
```
在两处 `reject` 前把码挂上：
```js
        const msg = friendlyMessage(res.statusCode, body)
        if (!silent) wx.showToast({ title: msg, icon: 'none', duration: 2000 })
        const err = new Error(msg)
        // 业务码透出给调用方分流（42227/42239/42220…）；网络层失败没有业务码，置 null。
        // silent 只关掉 toast，不影响 code —— 「谁来提示」是页面的事，「出了什么事」是这里的事。
        err.code = body && typeof body.code === 'number' ? body.code : null
        err.data = body && body.data ? body.data : null
        reject(err)
```
`fail` 分支同样加 `if (!silent)` 与 `err.code = null`。自动重登录重试那一支要把 `silent` 一起透传：`doRequest({ url, method, data, silent }, true)`。

- [ ] **Step 2: `api/local.js`**

```js
const { request } = require('../utils/request')

// 同城店头：营业状态/范围/起送/运费规则/门店坐标。未登录也可调。
function getLocalMeta() {
  return request({ url: '/local/meta' })
}

// 报价：登录态传 addressId（才会签发 quoteToken），subtotal 决定免运/起送口径。
// silent=true：确认页要按 code 自己分流，不走统一 toast。
function quoteLocal(addressId, subtotal) {
  return request({ url: '/local/quote', method: 'POST', silent: true, data: { addressId: addressId, subtotal: subtotal } })
}

module.exports = { getLocalMeta: getLocalMeta, quoteLocal: quoteLocal }
```

- [ ] **Step 3: `api/cart.js` 加 channel；`api/order.js` 加两个端点**

```js
// channel 省略 = EXPRESS（服务端默认），保持既有调用零改动
function getCart(channel) {
  return request({ url: '/cart' + (channel === 'LOCAL' ? '?channel=LOCAL' : '') })
}
```
`api/order.js` 追加：
```js
// 同城：接单后宽限期内申请取消（订单状态不变，店员确认后全额退）
function requestCancelOrder(id, note) {
  return request({ url: '/orders/' + id + '/cancel-request', method: 'POST', silent: true, data: note ? { note: note } : {} })
}
// 同城：骑手位置（非在途或查不到时 data.location 为 null，不是错误）
function getCourierLocation(id) {
  return request({ url: '/orders/' + id + '/courier', silent: true })
}
```
两个都导出。

- [ ] **Step 4: `app.js` 的角标口径显式化**

`updateCartCount` 里 `getCart()` 改 `getCart('EXPRESS')`，并加注释：
```js
  // tabBar 角标只统计邮寄购物车——同城购物车的件数由 pages/local/index 底部条自己显示。
  // 两个渠道的件数加在一个角标上，顾客点进购物车会发现数字对不上。
```

- [ ] **Step 5: `app.json` 注册新页面**

`pages` 数组末尾加：
```json
    "pages/local/index",
    "pages/local/confirm",
```
（`__usePrivacyCheck__` 与 privacy-popup 在 Task 6 加；`requiredPrivateInfos` 保持只有 `chooseLocation`，不加 `getLocation`。）

- [ ] **Step 6: 首页临时双入口（方案 A）**

`index.js` `data` 加 `localEntry: null`；`loadData()` 的 `Promise.all` **不要**把 meta 塞进去（meta 失败不能拖垮首页），单独发一次：
```js
  // 临时入口：封面落地后整块删除（见 M3 计划 §临时入口决定）
  loadLocalEntry() {
    var self = this
    getLocalMeta()
      .then(function(m) {
        var sub = ''
        var clickable = true
        if (!m.enabled) { sub = '即将开通'; clickable = false }
        else if (m.paused) { sub = '暂停接单' + (m.paused.reason ? ' · ' + m.paused.reason : ''); clickable = false }
        else if (!m.isOpen) { sub = m.nextOpenText || '已打烊' }
        else { sub = m.radiusKm + ' km 内送达 · 满 ¥' + formatPrice(m.fee.minOrderAmount) + ' 起送' }
        self.setData({ localEntry: { sub: sub, clickable: clickable } })
      })
      .catch(function() {
        // 同城接口挂了不影响首页：入口不显示，顾客照常买邮寄
        self.setData({ localEntry: null })
      })
  },

  goLocal() {
    if (!this.data.localEntry || !this.data.localEntry.clickable) return
    wx.navigateTo({ url: '/pages/local/index' })   // ← 封面入口契约，逐字不变
  },
```
`onLoad` 与 `onPullDownRefresh` 各调一次 `loadLocalEntry()`。注意 `getLocalMeta` 走的是会 toast 的 `request`——首页不该因为同城接口挂了弹 toast，所以这里 `api/local.js` 的 `getLocalMeta` 也加 `silent: true`。

`index.wxml` 在 banner 块之后、`<!-- Categories -->` 之前插入：
```xml
  <!-- 临时入口：封面落地后整块删除（M3 计划 §临时入口决定） -->
  <view class="channel-entry" wx:if="{{localEntry}}">
    <view class="channel-card channel-card-local {{localEntry.clickable ? '' : 'channel-card-off'}}" bindtap="goLocal">
      <text class="channel-title">同城配送</text>
      <text class="channel-sub">{{localEntry.sub}}</text>
    </view>
    <view class="channel-card" bindtap="goToAllProducts">
      <text class="channel-title">全国邮寄</text>
      <text class="channel-sub">冷链发货 · 全国可达</text>
    </view>
  </view>
```

- [ ] **Step 7: 静态校验**

Run:
```bash
node --check apps/miniapp/utils/request.js && node --check apps/miniapp/api/local.js && node --check apps/miniapp/api/cart.js && node --check apps/miniapp/api/order.js && node --check apps/miniapp/app.js && node --check apps/miniapp/pages/index/index.js && node -e "JSON.parse(require('fs').readFileSync('apps/miniapp/app.json','utf8'))"
```
Expected：无输出。

**Done:** 上述命令零输出；微信开发者工具里首页顶部出现两张卡片，「同城配送」副标题随后台「同城设置」开关/暂停/营业时段实时变化；点它跳到（此刻还不存在的）`pages/local/index` 报「页面不存在」——**这是预期的，Task 2 补上**；邮寄首页其余部分与角标行为完全不变。

- [ ] **Step 8: 提交**

```bash
git add apps/miniapp/utils/request.js apps/miniapp/api apps/miniapp/app.js apps/miniapp/app.json apps/miniapp/pages/index
git commit -m "feat(miniapp): 请求层透出业务码 + 同城 API 层 + 首页同城临时入口

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `pages/local/index` —— 同城菜单页

**Files:**
- Create: `apps/miniapp/pages/local/index.{js,wxml,wxss,json}`

**Interfaces:**
- Consumes: `GET /local/meta`、`GET /categories?channel=LOCAL`、`GET /products?channel=LOCAL&categoryId=&page=&pageSize=`、`GET /cart?channel=LOCAL`、`POST /cart`。
- Produces: `wx.navigateTo('/pages/local/confirm?cartItemIds=1,2,3')`。

- [ ] **Step 1: 页面骨架与数据**

`index.json`：`{ "navigationBarTitleText": "同城配送", "usingComponents": { "sku-popup": "/components/sku-popup/index", "empty-state": "/components/empty-state/index" } }`

`data`：
```js
    meta: null,            // /local/meta
    headNotice: '',        // 页头黄条：未开通/暂停/打烊，空串=正常
    headBlocking: false,   // 黄条是否禁止下单（enabled=false / paused / !isOpen 都是 true）
    categories: [],        // LOCAL 分类（含首项「全部」）
    activeCategoryId: null,
    list: [], page: 1, hasMore: true, loading: false,
    cartItems: [],         // LOCAL 购物车明细
    cartCount: 0, cartAmount: 0,
    cartExpanded: false,
    skuShow: false, skuProduct: null,
```

- [ ] **Step 2: 页头（店头条）**

结构从上到下：门店名 + 营业状态胶囊 → 「配送范围 N km · 满 ¥x 起送 · 基础运费 ¥y 起」→（异常时）黄条。

黄条三态，取自 meta，与首页入口同一套判断（**抽成页面内的一个 `headNoticeOf(meta)` 函数，两处别各写一遍**）：
- `enabled=false` → 「同城配送即将开通」+ 按钮「去全国邮寄」（`wx.switchTab('/pages/index/index')`）。此时**整页不渲染商品**，只留这一屏。
- `paused` → 「暂停接单：<reason>」，商品照常展示、可加购，**结算按钮禁用**（顾客可以先挑好，恢复后直接下单）。
- `isOpen=false` → `nextOpenText`（如「明天 9:00 营业」），同上：可挑、不可结算。

- [ ] **Step 3: 左分类右商品**

复用 `pages/product/list` 的两栏布局与样式思路（**复制必要的 wxss，不要跨页 import**——预览台是按页隔离样式的，跨页引用会在预览台里裂开）。所有请求带 `channel=LOCAL`：
```js
    request({ url: '/categories?channel=LOCAL' })
    request({ url: '/products?channel=LOCAL&page=' + p + '&pageSize=20' + (id ? '&categoryId=' + id : '') })
```
分类为空（店主还没建 LOCAL 分类）→ `empty-state` 文案「同城菜单还在准备中」。

- [ ] **Step 4: 加购与同城购物车条**

`sku-popup` 的 `mode` 固定 `'cart'`（不做立即购买，见 §明确不做 2）。加购成功后：
```js
        wx.showToast({ title: '已加入同城购物车', icon: 'none' })
        self.loadCart()          // 不调 app.updateCartCount()——那是邮寄角标
```
底部固定条：`共 N 件 · ¥xx` + 「去结算」。未达起送时按钮变「还差 ¥x 起送」并禁用（`meta.fee.minOrderAmount` 与小计比，**这是唯一允许在顾客端做的金额比较**，因为它只影响按钮可用性、不产生任何金额）。点条本身展开明细（步进器 + 删除，走 `updateCartItem/deleteCartItem`）。

「去结算」：把 LOCAL 购物车里**全部**行的 id 拼进 query（同城场景没有「勾选部分结算」的需求，也就不引入选中态）：
```js
    wx.navigateTo({ url: '/pages/local/confirm?cartItemIds=' + ids.join(',') })
```

- [ ] **Step 5: 生命周期**

`onShow` 重新拉 `meta` 与 `cart`（从确认页返回、或店主刚暂停接单，都要即时反映）；商品列表只在 `onLoad` 与切分类时拉。

- [ ] **Step 6: 校验**

Run: `node --check apps/miniapp/pages/local/index.js`（Expected 无输出）。
微信开发者工具：首页 → 同城配送 → 菜单可浏览、可加购、底部条件数正确；把后台同城设置「暂停接单」打开，返回页面 → 黄条出现且结算禁用；关掉总开关 → 只剩「即将开通」一屏。

**Done:** 以上四个状态（正常 / 暂停 / 打烊 / 未开通）在开发者工具里各截一张图；tabBar 购物车角标在同城加购后**不变**（这是隔离生效的最直接证据）。

- [ ] **Step 7: 提交**

```bash
git add apps/miniapp/pages/local
git commit -m "feat(miniapp): 同城菜单页（店头状态 + 分类商品 + 独立购物车条）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: 购物车隔离的两处收口

**Files:**
- Modify: `apps/miniapp/pages/cart/index.{js,wxml}`
- Modify: `apps/miniapp/pages/product/detail.{js,wxml}`

- [ ] **Step 1: 邮寄购物车空态提示**

`pages/cart/index.js` 的 `loadCart()` 里，当 `items.length === 0` 时**额外**查一次 LOCAL：
```js
        if ((data.items || []).length === 0) {
          getCart('LOCAL')
            .then(function(local) {
              var n = (local.items || []).reduce(function(s, i) { return s + (i.quantity || 0) }, 0)
              self.setData({ localPendingCount: n })
            })
            .catch(function() { self.setData({ localPendingCount: 0 }) })
        } else {
          self.setData({ localPendingCount: 0 })
        }
```
`cart/index.wxml` 空态块内加一行可点提示：
```xml
      <view wx:if="{{localPendingCount > 0}}" class="cross-channel-tip" bindtap="goLocal">
        你在同城配送还有 {{localPendingCount}} 件未结算 <text class="icon icon-arrow"></text>
      </view>
```
`goLocal(){ wx.navigateTo({ url: '/pages/local/index' }) }`。

**只在空态查**：购物车页每次 onShow 都多打一次接口是浪费，而「邮寄车里有货」的顾客本来也不需要这个提示。

- [ ] **Step 2: 商品详情的渠道上下文**

`pages/product/detail` 是两个渠道共用的（扫码/Banner/分享都可能落到 LOCAL 商品）。按 `product.channel` 分叉：
- `LOCAL`：标题下加一枚「同城配送」标签；「立即购买」按钮**隐藏**（不做同城直购）；「加入购物车」文案改「加入同城购物车」，加购成功 toast 「已加入同城购物车」+ 第二按钮「去同城结算」→ `wx.navigateTo('/pages/local/index')`；**不调** `app.updateCartCount()`。
- `EXPRESS`：一行不变。

服务端已经在 `POST /orders` 做了双向渠道校验（`42224`），这里的隔离只是让顾客不撞上那个错误，不是安全边界——**不要**因为前端加了分支就以为可以放松服务端校验。

- [ ] **Step 3: 校验**

Run: `node --check apps/miniapp/pages/cart/index.js && node --check apps/miniapp/pages/product/detail.js`（Expected 无输出）。

**Done:** 同城加购后进 tabBar 购物车 → 空态 + 「你在同城配送还有 N 件未结算」；点它进同城菜单；邮寄商品详情页两个按钮与文案与改动前逐字相同。

- [ ] **Step 4: 提交**

```bash
git add apps/miniapp/pages/cart apps/miniapp/pages/product
git commit -m "feat(miniapp): 购物车跨渠道提示与商品详情渠道上下文

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: 地址列表的同城选择模式

**Files:**
- Modify: `apps/miniapp/pages/address/list.{js,wxml,wxss}`

**Interfaces:**
- Consumes: `GET /addresses`（整行返回，含 `latE6/lngE6/poiName`）、`GET /local/meta`（门店坐标与 `radiusStraightKm`）。
- Produces: 选中地址写 `app.globalData.selectedAddress` 后 `navigateBack`（沿用既有范式）。

`pages/address/edit` 的同城分支（地图选点、权限分流、报价条）**M1 已经落地，本 Task 不动它**。缺的只有列表侧。

- [ ] **Step 1: 接受 `channel` 参数**

`onLoad`：`this.setData({ mode: options.mode || 'normal', channel: options.channel === 'LOCAL' ? 'LOCAL' : 'EXPRESS' })`。
`onAddAddress` / `onEditAddress` 在 LOCAL 模式下把 `channel=LOCAL` 透传给 edit 页（edit 页据此强制地图选点）：
```js
    wx.navigateTo({ url: '/pages/address/edit' + (this.data.channel === 'LOCAL' ? '?channel=LOCAL' : '') })
```

- [ ] **Step 2: 可配送状态标签（不显示道路距离）**

LOCAL 模式下每行加一枚标签，三态：
- 无坐标 → 灰行 + 「需补充定位」，点击**不选中**而是跳 `address/edit?id=<id>&channel=LOCAL`。
- 有坐标、直线距离 ≤ `meta.radiusStraightKm` → 「直线约 x.x km」。
- 有坐标、直线距离 > `meta.radiusStraightKm` → 「直线约 x.x km · 可能超范围」（**橙色提示，不禁用**）。

**这里刻意偏离规格 §3.1.3 的「显示距离标签」，理由必须留在代码注释里：**
```js
// 列表上的 km 只是直线粗估，用来帮顾客一眼分辨「哪个地址大概在城这边」，
// 不是计费距离——计费用的是运力方实测道路距离，只有 /local/quote 给得出。
// 不给每行各调一次 quote 的原因有两个：一是 /local/quote 每次都会外呼运力方
// batchPrice（有连接占用），二是服务端限流 30 次/分钟，五六个地址就能把顾客
// 后面的正经报价挤掉。所以文案一律带「直线约」，且「可能超范围」不禁用选择：
// 真正的 42220 由确认页拿服务端结论来判，前端不替服务端下结论。
```
直线距离用 `meta.store.latE6/lngE6` 与地址坐标算 haversine —— 这是**唯一**允许在顾客端出现的距离计算，写成 `pages/address/list.js` 里一个 12 行的私有函数，不导出、不复用到别处。`radiusStraightKm` 是 `/local/meta` 已经下发的字段（服务端 `publicLocalMeta` 里 `radiusKm / detourFactor` 的换算结果），正是为这种粗判设计的。

- [ ] **Step 3: EXPRESS 模式一行不变**

`channel !== 'LOCAL'` 时不拉 meta、不渲染任何标签、不改点击行为。用 `wx:if="{{channel === 'LOCAL'}}"` 把新 UI 整块包住。

- [ ] **Step 4: 校验**

Run: `node --check apps/miniapp/pages/address/list.js`（Expected 无输出）。

**Done:** 从同城确认页点「选择收货地址」→ 列表带标签；一个没有坐标的老地址显示「需补充定位」且点击进编辑页；从邮寄确认页点同一入口 → 列表与改动前逐字相同（这条必须实际点一遍，不能只看代码）。

- [ ] **Step 5: 提交**

```bash
git add apps/miniapp/pages/address
git commit -m "feat(miniapp): 地址列表同城选择模式（可配送状态 + 补充定位入口）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `pages/local/confirm` —— 报价、下单与全部失败路径

本计划的核心任务。**动手前先把 §报价凭证生命周期 和 §失败与金钱路径速查表 读完**。

**Files:**
- Create: `apps/miniapp/pages/local/confirm.{js,wxml,wxss,json}`

**Interfaces:**
- Consumes: `GET /cart?channel=LOCAL`、`GET /addresses`、`GET /local/meta`、`POST /local/quote`、`GET /orders/meta`（订阅模板 + 支付超时）、`POST /orders`。
- Produces: `wx.redirectTo('/pages/order/detail?id=<id>&autopay=1')`（与邮寄确认页同一范式）。

- [ ] **Step 1: 数据结构**

```js
    cartItemIds: [], items: [], subtotal: 0,
    address: null,
    meta: null, headNotice: '', headBlocking: false,
    // ── 报价状态机：唯一的金额来源 ──
    quoting: false,          // 报价中 → 提交禁用
    quote: null,             // /local/quote 最近一次成功响应
    quoteToken: null,        // 提交时原样带上；null = 不可提交
    quotedAt: 0,             // 上次成功报价时刻，用于 10 分钟过期
    quoteError: '',          // 报价本身失败（网络/限流）的文案，非业务拒绝
    blockReason: '',         // 业务拒绝文案（超范围/打烊/暂停/缺定位），提交禁用
    // ── 附加项 ──
    needTableware: false, remark: '',
    payAmount: 0, submitting: false,
    subscribeTemplateIds: [], payTimeoutMin: 15,
```
**`payAmount` 只在 `quote` 成功后由 `subtotal + quote.fee` 写入；`quote` 为 null 时页面显示「运费计算中」而不是 ¥0.00。** 显示 ¥0.00 运费是这类页面最典型的错误——顾客会以为免运。

- [ ] **Step 2: 唯一的报价入口 `refreshQuote(reason)`**

所有重新报价都走它，不允许页面里出现第二处 `quoteLocal(` 调用：
```js
  // reason 只用于日志/排查：'load' | 'address' | 'subtotal' | 'show' | 'stale' | 'retry'
  refreshQuote(reason) {
    var self = this
    if (!this.data.address) { this.setData({ quoteToken: null, blockReason: '请选择收货地址' }); return }
    if (this.data.address.latE6 == null) {
      this.setData({ quoteToken: null, blockReason: '该地址缺少定位，请补充后再下单' })
      return
    }
    // 报价期间禁止提交：拿旧 token 提交是这个页面最容易犯的错
    this.setData({ quoting: true, quoteError: '' })
    quoteLocal(this.data.address.id, this.data.subtotal)
      .then(function(q) {
        var patch = { quoting: false, quote: q, quotedAt: Date.now() }
        // 服务端结论优先级：未开通/暂停 > 打烊 > 超范围 > 未达起送
        if (!q.enabled) { patch.blockReason = '同城配送暂未开通'; patch.quoteToken = null }
        else if (q.paused) { patch.blockReason = '暂停接单' + (q.paused.reason ? '：' + q.paused.reason : ''); patch.quoteToken = null }
        else if (!q.isOpen) { patch.blockReason = q.nextOpenText || '当前非营业时间'; patch.quoteToken = null }
        else if (!q.inRange) { patch.blockReason = '超出配送范围（约 ' + (q.distanceM / 1000).toFixed(1) + ' km）'; patch.quoteToken = null }
        else if (q.belowMin) { patch.blockReason = '还差 ¥' + formatPrice(q.minOrderAmount - self.data.subtotal) + ' 起送'; patch.quoteToken = null }
        else { patch.blockReason = ''; patch.quoteToken = q.quoteToken }
        patch.payAmount = self.data.subtotal + (q.fee || 0)
        self.setData(patch)
      })
      .catch(function(err) {
        // 报价失败 ≠ 业务拒绝：不清掉上一次的展示，只是不让提交
        self.setData({ quoting: false, quoteToken: null, quoteError: err.code === 42901 ? '请求过于频繁，稍后自动重试' : '运费获取失败' })
        if (err.code === 42901 && !self._retriedRateLimit) {
          self._retriedRateLimit = true
          setTimeout(function() { self.refreshQuote('retry') }, 3000)
        }
      })
  },
```
**`quoteToken` 为 `null` 时提交按钮一律禁用。** 不存在「先提交试试看」的分支——服务端会稳稳地回 42239，那只是把一次必然失败搬到网络上跑一趟。

- [ ] **Step 3: 五个重新报价的触发点接好**

1. `onLoad` 拿到购物车与默认地址后 → `refreshQuote('load')`，置 `this._quotedOnce = true`。
2. `onShow`：若 `app.globalData.selectedAddress` 有值 → 取走、`setData`、`refreshQuote('address')`；否则若 `this._quotedOnce` 已为真 → `refreshQuote('show')`（可能刚编辑过地址坐标）。**`onLoad` 之后 `onShow` 会立刻触发一次，用 `_quotedOnce` 挡掉这一次重复报价。**
3. 数量步进器/删除 → 更新 `subtotal` 后 **debounce 500ms** → `refreshQuote('subtotal')`：
   ```js
   if (this._quoteTimer) clearTimeout(this._quoteTimer)
   this._quoteTimer = setTimeout(function() { self.refreshQuote('subtotal') }, 500)
   ```
4. 提交前的过期检查：`if (Date.now() - this.data.quotedAt > 10 * 60 * 1000) { this.refreshQuote('stale'); toast('运费已重新计算，请确认后提交'); return }`（服务端 TTL 15 分钟，留 5 分钟余量）。
5. 提交拿到 42227/42239 → 见 Step 5。

`onUnload` 里 `clearTimeout(this._quoteTimer)`。

- [ ] **Step 4: 页面结构**

自上而下：
1. **黄条**（`headNotice`，与菜单页同一套三态，来源用 quote 响应里的 `enabled/paused/isOpen`，因为它比 meta 新）。
2. **地址卡**：有地址 → 收货人 + 电话 + `poiName` + 详细地址；无坐标时红字「该地址缺少定位」+「去补充定位」。无地址 → 「选择收货地址」。点击 → `wx.navigateTo('/pages/address/list?mode=select&channel=LOCAL')`。
3. **配送信息条**：`距门店 x.x km · 配送费 ¥y · 预计 HH:mm 送达`。
   - 距离用 `quote.distanceM`（服务端的计费距离），**不用** `straightDistanceM`。
   - 预计送达 = `now + quote.estimatedMinutes` 格式化成 `HH:mm`，同时写「约 N 分钟」。
   - `quoting` 时整条显示骨架/「计算中…」，不显示旧数字（旧数字配新地址是最坏的一种展示）。
   - `quoteError` 时显示错误 + 「重新获取运费」按钮。
4. **商品列表**（只读 + 步进器 + 删除）。
5. **备注 + 餐具**：
   - 「需要餐具」开关。提交时若勾选，`remark` 前缀 `[需要餐具] `（服务端 `remark` 上限 255，拼接后必须 `slice(0, 255)`）。
   - 备注 placeholder：`如需餐具、放门口等请注明；备注会同步给骑手`。
6. **协议行**（复用邮寄确认页的「提交订单即表示同意《用户协议》和《隐私政策》」，`goLegal` 原样搬）。
7. **底部结算条**：合计（商品 ¥x + 配送 ¥y）+ 提交按钮。按钮文案与禁用按下表：

| 条件 | 文案 | 可点 |
|---|---|---|
| `quoting` | 计算运费中… | 否 |
| `quoteError` | 重新获取运费 | 是（点它调 `refreshQuote('retry')`） |
| `blockReason` 非空 | 直接显示 `blockReason` | 否 |
| `quoteToken` 有值 | 提交订单 ¥{{payAmount}} | 是 |

超范围/打烊/暂停时，底部条**上方**额外给两个出路按钮：「换个地址」（→ 地址列表）、「改用全国邮寄」（→ `wx.switchTab('/pages/index/index')`）。

- [ ] **Step 5: 提交与错误分流**

```js
  onSubmit() {
    if (this.data.submitting || this.data.quoting || !this.data.quoteToken) return
    if (Date.now() - this.data.quotedAt > 10 * 60 * 1000) { this.refreshQuote('stale'); wx.showToast({ title: '运费已重新计算，请确认后提交', icon: 'none' }); return }
    var self = this
    // 订阅授权必须在点击手势内发起（与邮寄确认页同一范式）
    requestSubscribe(this.data.subscribeTemplateIds, function() { self.doSubmit() })
  },

  doSubmit() {
    this.setData({ submitting: true })
    var self = this
    var remark = (this.data.needTableware ? '[需要餐具] ' : '') + (this.data.remark || '')
    createOrder({
      cartItemIds: this.data.cartItemIds,
      addressId: this.data.address.id,
      deliveryType: 'LOCAL',
      quoteToken: this.data.quoteToken,
      remark: remark ? remark.slice(0, 255) : undefined,
    })
      .then(function(res) { /* 与邮寄一致：toast → redirectTo detail?autopay=1 */ })
      .catch(function(err) { self.setData({ submitting: false }); self.handleSubmitError(err) })
  },
```
`createOrder` 要走 `silent: true`（在 `api/order.js` 里给 `createOrder` 加可选 `silent` 参数，**只有同城确认页传 true**，邮寄确认页保持现状继续吃统一 toast）。

```js
  handleSubmitError(err) {
    var self = this
    var code = err.code
    // 凭证类：自动重报一次价，但绝不自动重新提交——金额可能变了，必须让顾客再点一次
    if (code === 42239 || code === 42227) {
      wx.showToast({ title: code === 42239 ? '配送费需要重新确认' : '配送费已更新，请确认后重新提交', icon: 'none', duration: 2500 })
      this.setData({ feeFlash: true })
      setTimeout(function() { self.setData({ feeFlash: false }) }, 1200)
      this.refreshQuote('retry')
      return
    }
    // 地址缺定位：给去补的入口
    if (code === 42223) {
      wx.showModal({ title: '地址缺少定位', content: err.message, confirmText: '去补充',
        success: function(r) { if (r.confirm) wx.navigateTo({ url: '/pages/address/edit?id=' + self.data.address.id + '&channel=LOCAL' }) } })
      return
    }
    // 超范围/打烊/暂停：服务端文案已带具体数字，原样展示 + 给两条出路
    if (code === 42220 || code === 42222 || code === 42226) {
      this.setData({ blockReason: err.message, quoteToken: null })
      wx.showToast({ title: err.message, icon: 'none', duration: 3000 })
      return
    }
    // 起送/上限/渠道不符：服务端文案自解释，弹 modal 让顾客看完
    if (code === 42210 || code === 42230 || code === 42224) {
      wx.showModal({ title: '无法下单', content: err.message, showCancel: false })
      return
    }
    // 其余（含网络失败、code=null）：统一兜底
    wx.showToast({ title: err.message || '下单失败，请重试', icon: 'none', duration: 2500 })
  },
```

`feeFlash` 让配送费那一行高亮闪一次——42227 的本质是「钱变了」，不给视觉锚点顾客根本不会注意到。

- [ ] **Step 6: 校验**

Run: `node --check apps/miniapp/pages/local/confirm.js`（Expected 无输出）。

手工验收（微信开发者工具 + 后台，逐条对照 §失败与金钱路径速查表）：
1. 正常下单 → 支付（mock）→ 详情页。
2. 报价后**在后台改门店坐标** → 回来点提交 → 42227 → 运费条闪 + 自动重报价 → 再提交成功。
3. 报价后**在别处编辑该地址的坐标** → 回来提交 → 42239 → 同上。
4. 在确认页**把数量从 2 改成 1 掉出免运门槛** → 500ms 后运费自动变 → 提交实收与展示一致。
5. 选一个超范围地址 → 运费条变红 + 两个出路按钮 + 提交禁用。
6. 后台把营业时段改到当前时间之外 → 黄条 + 提交禁用。
7. 后台「暂停接单」+ 原因 → 黄条原样展示原因 + 提交禁用。
8. 地址页把某地址坐标清掉 → 选它 → 「去补充定位」链路通。
9. 连点数量 20 次 → 只发少数几次报价请求（debounce 生效），不触发 42901。

**Done:** 上述 9 条逐条通过并各留一张截图；`payAmount` 在任何时刻都等于「商品小计 + quote.fee」，且**从不出现 ¥0.00 运费**；下单成功后订单详情页的 `shippingFee` 与提交前展示的一致（这是「顾客看到的 = 实际扣的」的最终验收）。

- [ ] **Step 7: 提交**

```bash
git add apps/miniapp/pages/local apps/miniapp/api/order.js
git commit -m "feat(miniapp): 同城确认页——报价凭证生命周期与失败路径分流

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: 官方隐私授权弹窗

**Files:**
- Create: `apps/miniapp/components/privacy-popup/index.{js,json,wxml,wxss}`
- Modify: `apps/miniapp/app.js`、`apps/miniapp/app.json`
- Modify: `docs/miniapp-release-checklist.md`

小程序已经在调 `wx.chooseLocation`（M1 的商家端定位、地址编辑页），属隐私接口。`docs/miniapp-release-checklist.md` 第 79-80 行已经把这件事挂着等 M3。

- [ ] **Step 1: `app.json` 启用**

顶层加 `"__usePrivacyCheck__": true`。

- [ ] **Step 2: 组件**

半屏弹层：标题「隐私保护指引」+ 正文「在使用本小程序前，请阅读并同意《<小程序名>隐私保护指引》。我们仅在您主动选择收货位置时获取位置信息，不会在后台获取。」+ 两个按钮「拒绝」/「同意并继续」。

- 「同意」必须是 `<button open-type="agreePrivacyAuthorization" bindagreeprivacyauthorization="onAgree">`——这是官方要求的形态，普通 `bindtap` 不生效。
- 正文里的《隐私保护指引》可点 → `wx.openPrivacyContract()`（失败时回退 `wx.navigateTo('/pages/legal/index?type=privacy')`）。
- 「拒绝」只关闭弹层，**不做任何降级提示**——顾客可能只是在逛菜单，不该被吓走；真正需要位置时（点「在地图上选择收货位置」）弹窗会再来一次。

- [ ] **Step 3: `app.js` 监听**

```js
  onLaunch() {
    // ... 既有逻辑
    if (wx.onNeedPrivacyAuthorization) {
      wx.onNeedPrivacyAuthorization(function(resolve) {
        // 把 resolve 交给当前页面挂载的 privacy-popup 组件；组件在用户点「同意并继续」后
        // 调 resolve({ event: 'agree' })，点「拒绝」调 resolve({ event: 'disagree' })。
        // 存在 globalData 上而不是用事件总线：小程序没有全局事件机制，而同一时刻
        // 只可能有一个待决的授权请求。
        getApp().globalData.privacyResolve = resolve
        var pages = getCurrentPages()
        var cur = pages[pages.length - 1]
        var popup = cur && cur.selectComponent && cur.selectComponent('#privacy-popup')
        if (popup) popup.show()
        else resolve({ event: 'disagree' })   // 该页没挂组件：拒绝，别把顾客卡死在无响应上
      })
    }
  },
```

- [ ] **Step 4: 挂载到会触发隐私接口的页面**

只有三页会调 `wx.chooseLocation`：`pages/address/edit`、`pages/merchant/index`、（间接）`pages/local/confirm` 的「去补充定位」跳转。前两页的 `json` 里注册 `"privacy-popup": "/components/privacy-popup/index"`，wxml 末尾加 `<privacy-popup id="privacy-popup" />`。

- [ ] **Step 5: 文档同步**

`docs/miniapp-release-checklist.md`：
- 第 79-80 行的 ⚠️ 段改为「✅ 已启用 `__usePrivacyCheck__`，弹窗组件 `components/privacy-popup`，监听在 `app.js onLaunch`（M3 落地 2026-09-04）」。
- 「上架前自查」章节加两条：「隐私弹窗在首次进入地址编辑页时出现」「拒绝后再次点地图选点会再次弹出」。
- 页面清单加 `pages/local/index`、`pages/local/confirm`。

- [ ] **Step 6: 校验**

Run: `node -e "JSON.parse(require('fs').readFileSync('apps/miniapp/app.json','utf8'))" && node --check apps/miniapp/app.js && node --check apps/miniapp/components/privacy-popup/index.js`（Expected 无输出）。
开发者工具：清缓存 → 进地址编辑页 → 点地图选点 → 弹窗出现 → 拒绝 → 地图不打开且无报错 → 再点 → 再弹 → 同意 → 地图打开。

**Done:** 上述四步链路在开发者工具里走通；`docs/miniapp-release-checklist.md` 里没有「需重新评估」字样残留。

- [ ] **Step 7: 提交**

```bash
git add apps/miniapp/components/privacy-popup apps/miniapp/app.js apps/miniapp/app.json apps/miniapp/pages/address apps/miniapp/pages/merchant docs/miniapp-release-checklist.md
git commit -m "feat(miniapp): 官方隐私授权弹窗（__usePrivacyCheck__ + onNeedPrivacyAuthorization）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: 订单详情同城分支

**Files:**
- Modify: `apps/miniapp/pages/order/detail.{js,wxml,wxss,json}`

**Interfaces:**
- Consumes: `GET /orders/:id`（LOCAL 时含 `delivery` 白名单字段、`canRequestCancel`、`cancelRequestDeadline`、`cancelRequestedAt`、`distanceM`、`estimatedDeliveryAt`、`receiverPoiName`）、`GET /orders/:id/courier`、`POST /orders/:id/cancel-request`、`GET /local/meta`（门店坐标，画地图用）。
- **服务端不需要任何改动**——上述字段 M1/M2 已全部下发（`routes/orders.ts` 的 `customerDeliveryView` 白名单 + `cancelWindowOf`）。

- [ ] **Step 1: 配送状态文案表**

服务端 `DELIVERY_STATUS_LABEL` 已给出中文，但顾客端要的措辞不完全一样（异常态要中性）。在 `detail.js` 里建一张顾客端表，**不要**直接用服务端下发的 `statusLabel` 渲染异常态：
```js
var DELIVERY_CUSTOMER_LABEL = {
  PENDING: '商家正在安排配送', CALLING: '正在为您呼叫骑手',
  ACCEPTED: '骑手已接单', ARRIVING: '骑手正在赶往门店', ARRIVED: '骑手已到店取餐',
  DELIVERING: '配送中', DELIVERED: '已送达',
  // 下面四个对顾客都是「还在处理」，不暴露改派/异常/未确认这些运营内部概念
  REASSIGNING: '配送正在协调中', ABNORMAL: '配送正在协调中',
  UNKNOWN: '配送正在协调中', FAILED: '配送正在协调中', CANCELLED: '配送正在协调中',
}
var DELIVERY_NEUTRAL = ['REASSIGNING', 'ABNORMAL', 'UNKNOWN', 'FAILED', 'CANCELLED']
```
异常态下额外一行副文案：「如超过预计时间请联系商家」。

- [ ] **Step 2: 同城时间线**

`buildTimeline` 加一个 `isLocal` 分支（**不要改邮寄那一支**，新建 `buildLocalTimeline(order)`，在 `decorateOrder` 里按 `order.deliveryType` 二选一）：

节点：`提交订单 → 支付成功 → 商家接单·备餐中 → 骑手已接单 → 骑手已到店 → 配送中 → 已送达`。
- 「骑手已接单」`done` 判据：`delivery && ['ACCEPTED','ARRIVING','ARRIVED','DELIVERING','DELIVERED'].indexOf(delivery.status) !== -1`；`extra` = 骑手姓名 + 运力名。
- 「骑手已到店」`done`：`delivery.pickedUpAt` 或状态已过 `ARRIVED`。
- 「配送中」`done`：`order.status === 'SHIPPED'`（服务端在 310 回调里联动）。
- 「已送达」`done`：`order.completedAt`。
- 取消/退款分支**复用邮寄那一支的逻辑**（拒单前缀、退款事实行都一样），只是把「已发货」文案换成「配送中」。

- [ ] **Step 3: 骑手卡与联系方式**

`delivery.status` 属 `ACCEPTED/ARRIVING/ARRIVED/DELIVERING` 时显示：骑手姓名 + `courierCompany` + 「联系骑手」（`wx.makePhoneCall({ phoneNumber: delivery.courierMobile })`，为空则不显示该按钮）。「联系商家」沿用既有 `callShop`。

- [ ] **Step 4: 地图与 30s 轮询**

按 Task 0 的结论决定 `<map>` 还是 `cover-view` 静态两点图。轮询逻辑两种方案完全一样：

```js
  startCourierPoll() {
    var self = this
    this.stopCourierPoll()
    if (!this.data.order || this.data.order.deliveryType !== 'LOCAL') return
    var d = this.data.order.delivery
    if (!d || COURIER_LIVE_STATUSES.indexOf(d.status) === -1) return
    var tick = function() {
      getCourierLocation(self._orderId)
        .then(function(r) {
          // location 为 null 是正常返回（骑手还没上路 / 运力方查不到），不是错误：
          // 整块地图不渲染，别显示一张空地图或弹错误——顾客只会以为出事了。
          self.setData({ courierLoc: r.location || null })
        })
        .catch(function() { /* 查不到就查不到，下一轮再说 */ })
    }
    tick()
    this._courierTimer = setInterval(tick, 30 * 1000)
  },
  stopCourierPoll() { if (this._courierTimer) { clearInterval(this._courierTimer); this._courierTimer = null } },
```
**生命周期铁律**：`onShow` 启动、`onHide` / `onUnload` 停止、配送单进终态（`DELIVERED`/`CANCELLED`）后不再启动。既有的 `startTicker/stopTicker`（付款倒计时）已经是这个范式，照抄挂在同样的位置——**别新增第二套生命周期钩子**。

地图 markers：门店（来自 `/local/meta` 的 `store.latE6/lngE6`，页面只拉一次并缓存在 `this._storeLoc`）、收货点（`order.receiverLatE6/receiverLngE6`）、骑手（`courierLoc`）。`<map>` 的 `latitude/longitude` 取骑手点，没有骑手点就取收货点。

- [ ] **Step 5: 取消窗口（D6 ②）**

服务端已下发 `canRequestCancel` 与 `cancelRequestDeadline`，**顾客端不要自己按 `acceptedAt + 5min` 算**。三态：
- `cancelRequestedAt` 有值 → 灰条「取消申请已提交，商家会尽快处理」，无按钮。
- `canRequestCancel === true` → 按钮「申请取消」+ 副文案「接单后 {{graceMin}} 分钟内可申请取消（截止 HH:mm）」。点击 → `wx.showModal` 二次确认（内容写明「商家确认后将全额退款，含配送费」）→ `requestCancelOrder(id)` → 成功后 `loadOrder(id, true)`。
- 其余 → 不显示，改显示「订单已开始制作，如有问题请联系商家」。

失败分流：`42229` → toast 原样展示服务端文案（它已经分了「已提交过」和「已超时」两种说法）→ 刷新详情。

`PAID` 且未接单时**仍走既有的 `canSelfCancel` 秒退按钮**，一行不改。

- [ ] **Step 6: 隐藏快递卡 + 配送信息卡**

LOCAL 订单没有 `Shipment`，快递卡整块 `wx:if="{{!isLocal}}"` 包住。换成同城配送信息卡：`收货地点（poiName + 详细地址）· 距门店 x.x km · 预计送达 HH:mm · 配送费 ¥y`。

- [ ] **Step 7: 校验**

Run: `node --check apps/miniapp/pages/order/detail.js`（Expected 无输出）。

手工验收（用 `POST /admin/system/delivery-mock` 推状态，M2 已提供）：
1. `PAID` → 「申请退款」秒退按钮在（既有行为）。
2. 后台接单 → 详情出现「申请取消」+ 倒计时截止时间；点它 → 二次确认 → 提交成功 → 变灰条。
3. 把 `acceptGraceMin` 调成 1 分钟等它过期 → 按钮消失 → 「订单已开始制作…」。
4. mock 推 `100`（骑手接单）→ 骑手卡 + 地图出现；`210/230` → 「骑手已到店」；`310` → 「配送中」；`520` → 「已送达 / 已完成」。
5. mock 推 `515`（改派）→ 中性文案「配送正在协调中」，**不出现「改派」二字**。
6. 切到后台再切回来（`onHide/onShow`）→ 轮询停了又起；进终态后不再有 `/courier` 请求（Network 面板确认）。
7. **打开一笔邮寄订单** → 快递卡在、时间线与改动前逐字相同、没有任何同城元素。

**Done:** 上述 7 条逐条通过；开发者工具 Network 面板确认终态订单不再轮询 `/courier`（这是最容易漏的一条，也是唯一会持续消耗运力方配额的）。

- [ ] **Step 8: 提交**

```bash
git add apps/miniapp/pages/order
git commit -m "feat(miniapp): 订单详情同城分支（时间线/骑手/地图轮询/取消窗口）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: 订单列表渠道标签

**Files:**
- Modify: `apps/miniapp/pages/order/list.{js,wxml,wxss}`

`GET /orders` 返回整行（含 `deliveryType`），无需服务端改动。

- [ ] **Step 1: 标签**

每张订单卡订单号左侧加一枚小标签：`deliveryType === 'LOCAL'` → 「同城」（同城色 `#e5441e` soft 底）；否则 → 「邮寄」（`#3b5bdb` soft 底）。与工作台的渠道色一致（M2-B `docs/design/workbench-ui-spec.md` §3），店主两端看到的是同一套颜色语义。

- [ ] **Step 2: 状态文案按渠道分叉**

`SHIPPED` 在邮寄是「已发货」，在同城是「配送中」。列表的 `STATUS_LABEL` 查表时按 `deliveryType` 选表（两张表只差这一个词，但顾客看到「已发货」会去找快递单号）。

**不做**：列表不加渠道筛选 Tab（订单量级不需要，混排 + 标签足够）。

- [ ] **Step 3: 校验**

Run: `node --check apps/miniapp/pages/order/list.js`（Expected 无输出）。

**Done:** 列表里同城单标「同城」且 `SHIPPED` 显示「配送中」；邮寄单标「邮寄」且显示「已发货」；点进去各自到对应的详情分支。

- [ ] **Step 4: 提交**

```bash
git add apps/miniapp/pages/order
git commit -m "feat(miniapp): 订单列表渠道标签与同城状态文案

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: 邮寄回归 + 预览台镜像 + e2e 契约锁 + 文档

**Files:**
- Modify: `tools/miniapp-preview/serve.mjs`、`tools/miniapp-preview/index.html`
- Create: `tools/miniapp-preview/pages/local-index.html`、`tools/miniapp-preview/pages/local-confirm.html`
- Modify: `tools/miniapp-preview/pages/order-detail.html`（补同城态）
- Modify: `scripts/e2e.sh`（新增第 34 段）
- Modify: `docs/superpowers/specs/2026-09-03-local-delivery-design.md`（spec 补丁）

- [ ] **Step 1: 邮寄回归清单（逐条点，不许只看代码）**

本计划碰了 9 个公共文件，每一个都要在开发者工具里实际走一遍邮寄路径：

| # | 路径 | 判据 |
|---|---|---|
| 1 | 首页 | 分类/推荐/Banner/下拉刷新与改动前一致；同城卡片不影响下方布局 |
| 2 | 分类页 → 加购 | toast「已加入购物车」（**不是**「同城购物车」）；tabBar 角标 +N |
| 3 | 购物车页（有货） | 勾选/步进/删除/结算全部正常；**无**跨渠道提示 |
| 4 | 购物车页（空） | 空态 + 跨渠道提示（同城有货时）或纯空态（同城也空时） |
| 5 | 邮寄确认页 | 运费/起送/地址选择/备注/提交与改动前一致；**`deliveryType` 仍是 `EXPRESS`** |
| 6 | 地址列表（邮寄模式） | 无任何标签、无 meta 请求（Network 面板确认） |
| 7 | 邮寄订单详情 | 快递卡在、时间线「已发货」、无 `/courier` 请求 |
| 8 | 订单列表 | 邮寄单标「邮寄」，状态文案不变 |
| 9 | 邮寄商品详情 | 两个按钮（加购 + 立即购买）都在，文案不变 |
| 10 | 商家端 | 「用当前位置设为门店坐标」仍可用（Task 6 给它加了 privacy-popup） |

- [ ] **Step 2: 预览台镜像**

`serve.mjs` 的 `PAGE_WXSS` 加两行、`PAGE_COMPONENTS` 加 `'local-index': ['sku-popup', 'empty-state']`；`index.html` 画廊加两个 iframe。镜像页用 baked mock 数据覆盖各一个「正常态」即可（预览台是视觉近似，不是功能验证，见其 README「边界」一节）。`order-detail.html` 复制一份同城态（时间线 + 骑手卡 + 地图占位）。

Run: `npm run preview:miniapp` 后浏览器打开画廊，确认新页面样式不与既有页冲突。

- [ ] **Step 3: e2e 第 34 段 —— 顾客端字段契约锁**

M3 是纯前端，但顾客端依赖的**服务端字段名**必须锁住：后端一次无心的重构改个字段名，小程序会静默变瞎（没有类型系统兜底）。第 34 段只断言 key 存在与命名，不重复 §22/§28 已覆盖的业务语义：

```bash
echo "== 34. 顾客端字段契约锁（M3 依赖的响应字段名）=="
# /local/meta 公开子集
R=$(req GET /api/local/meta)
for k in enabled isOpen nextOpenText businessHours store radiusKm radiusStraightKm fee prepMinutes acceptGraceMin limits; do
  assert_eq "meta.$k 存在" "$(jq -r "has(\"$k\")" <<<"$(jq .data <<<"$R")")" "true"
done
# /local/quote（复用 §22 已建的 $LADDR）
R=$(req POST /api/local/quote "$UT" "{\"addressId\":$LADDR,\"subtotal\":5000}")
for k in inRange distanceM distanceSource straightDistanceM fee minOrderAmount belowMin estimatedMinutes quoteToken; do
  assert_eq "quote.$k 存在" "$(jq -r "has(\"$k\")" <<<"$(jq .data <<<"$R")")" "true"
done
# 订单详情 LOCAL 分支：M3 页面读的每一个字段
R=$(req GET /api/orders/$LOCAL_ORDER_ID "$UT")
for k in deliveryType distanceM estimatedDeliveryAt receiverPoiName receiverLatE6 receiverLngE6 canRequestCancel cancelRequestDeadline cancelRequestedAt delivery; do
  assert_eq "orderDetail.$k 存在" "$(jq -r "has(\"$k\")" <<<"$(jq .data <<<"$R")")" "true"
done
# delivery 白名单：该有的有，敏感的一个都不能有
for k in status statusLabel courierName courierMobile courierCompany pickedUpAt deliveredAt; do
  assert_eq "delivery.$k 存在" "$(jq -r "has(\"$k\")" <<<"$(jq .data.delivery <<<"$R")")" "true"
done
for k in callbackSalt quotedFee actualFee providerTaskId cancelFee; do
  assert_eq "delivery 不含 $k" "$(jq -r "has(\"$k\")" <<<"$(jq .data.delivery <<<"$R")")" "false"
done
# 订单列表带 deliveryType（渠道标签靠它）
assert_eq "orderList[0].deliveryType 存在" "$(jq -r '.data.list[0] | has("deliveryType")' <<<"$(req GET /api/orders "$UT")")" "true"
```
段号 34 插在第 33 段之后、清理段之前。**不新建任何资源**（全部复用前面段落造好的 `$LADDR`、同城订单 id），因此清理段不需要改。

Run: `bash scripts/e2e.sh`（Expected：全绿，且总数 = 原有 + 本段新增条数；**连跑两轮**验证幂等，两轮之间隔 60s）。

- [ ] **Step 4: spec 补丁**

`docs/superpowers/specs/2026-09-03-local-delivery-design.md`：
1. §2.1 末尾追加 Task 0 的实测结论（`<map>` 是否可用、Task 7 走了哪条路）。
2. §3.1.3 「显示距离标签」改为「显示**直线**粗估标签与可配送状态；道路距离与运费只在确认页由 `/local/quote` 给出」，并注明理由（限流 + 外呼成本，见 M3 计划 Task 4 Step 2）。
3. §6 页面清单里 `pages/local/index|confirm` 后加「M3 已落地（2026-09-04）」，并补一句「临时入口：首页双入口卡片，封面落地后删除」。
4. §9 M3 条目末尾补「实施计划：`docs/superpowers/plans/2026-09-04-local-delivery-m3-customer.md`」。
5. §10 验证表里 M3 相关行按实际勾选状态更新。

- [ ] **Step 5: 提交**

```bash
git add tools/miniapp-preview scripts/e2e.sh docs/superpowers/specs/2026-09-03-local-delivery-design.md docs/miniapp-release-checklist.md
git commit -m "test(miniapp): 顾客端字段契约锁 + 预览台同城镜像 + spec 同步

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## 自检记录（写计划时已核）

- **规格覆盖（M3 范围）**：规格 §9 的 M3 条目逐项对应——`pages/local/*`（Task 2/5）、隐私弹窗（Task 6）、地址地图选点（M1 已落地，列表侧补在 Task 4）、订单详情同城分支/地图/轮询/取消窗口（Task 7）、渠道标签（Task 8）、购物车提示（Task 3）、`legal.js`（**M1 已落地**，见下）、`app.json`（Task 1/6）、预览台（Task 9）、封面入口契约（Task 1 Step 6，以临时入口形式实现同一契约）。
- **规格 §6 里已由 M1 提前落地、M3 无需重做的三项**（写计划时逐个 grep 确认）：
  - `config/legal.js` 的「位置信息」与「向第三方（快递100 及其运力）共享」条款 —— 已在第 96 / 112 行；M3 只在 Task 9 复核措辞是否与实际行为一致，不重写。
  - `pages/address/edit` 的 `channel=LOCAL` 地图选点、授权分流、报价条 —— 已完整落地（`edit.js:107-190`）。
  - `pages/merchant/index` 的门店坐标一键定位 —— 已落地（`index.js:102-130`）。
- **服务端改动为零**：Task 7 需要的 `canRequestCancel` / `cancelRequestDeadline` / `delivery` 白名单 / `distanceM` / `estimatedDeliveryAt`、Task 8 需要的 `deliveryType`、Task 5 需要的 `subtotal` 入参与 `quoteToken` 签发，全部已在 M1/M2 落地并核对过源码。唯一的「公共层」改动是 `utils/request.js` 透出 `code`（小程序侧）。
- **`quoteToken` 的服务端事实已逐行核对**（`local-settings.ts:14-19,419-460`、`orders.ts:215-248`）：TTL **15 分钟**（不是规格里写的 5 分钟，M2 复查时已放宽并写明理由）；签发条件 `inRange && addressId > 0`；收货坐标不符 → 42239，门店坐标不符 → 42227；实收取重算 fee，仅重算更贵才 42227。计划 §报价凭证生命周期 的五条重报价规则由此推出，不是拍脑袋。
- **限流已核**：`localQuoteLimiter` = 30 次/分钟/IP（`rate-limit.ts:45-51`），故 Task 4 不做逐地址报价、Task 5 数量步进 debounce 500ms。
- **`app.js updateCartCount` 已经是 EXPRESS 口径**（不带 channel → 服务端默认 EXPRESS），Task 1 Step 4 只是把它显式化并加注释，属零行为变更。
- **e2e 段号**：第 34 段插在 33 段之后、清理段（脚本里编号 11）之前；不新建资源，清理段无需改动。
- **未纳入本计划**：M4 的真机真钱联调、`docs/order-flow.md` / `docs/staff-guide.md` / `docs/api.md` 的同城章节、「已送达」订阅模板申请、封面页本身。

---

## 需 YO 拍板的点

1. **临时入口用方案 A（首页顶部双入口卡片）** —— 计划已按 A 写死。若你打算让封面在 M3 之前落地，说一声，Task 1 Step 6 直接删掉，改为封面调同一个 `navigateTo`。
2. **地址列表不显示道路距离**（只显示「直线约 x.x km」+「可能超范围」），偏离规格 §3.1.3 的字面。理由是限流与外呼成本（Task 4 Step 2 有完整注释）。若你坚持要每行的真实运费，得先给服务端加一个批量报价端点，那是新的服务端工作量。
3. **同城不做「立即购买」直达**（只走购物车）。少一条下单路径 = 少一套报价凭证管理。若你觉得凉菜场景「点一个菜就走」很常见，这条要改，且要在 Task 5 之前定，因为会改确认页的入参形态。
4. **本计划写在了 `claude/m3-design-plan-6ecc5b` 分支的 worktree 里，而 M1+M2 的代码在 `claude/same-city-delivery-plan-2ffa20`**。执行前需要把这份计划挪到那条分支上（cherry-pick 一个 commit 即可），否则实施者的工作目录里没有它要改的代码。
