# 同城配送 M3 顾客端 —— Final Engineering Review

- **审查范围**：`002ecf2^..HEAD`（Task 0–9，10 个 commit，47 文件 +2323/−139）
- **基准文档**：`plans/2026-09-04-local-delivery-m3-customer.md`、`specs/2026-09-03-local-delivery-design.md`、`notes/2026-09-04-map-probe.md`
- **性质**：只读审查。本轮未改任何业务代码，未提交、未 push。
- **审查环境限制**：本次沙箱禁止执行 `node --check` / `bash -n`（权限拦截），故**语法与 e2e 未在本轮复跑**；以下结论全部来自源码通读与服务端契约比对（`routes/local.ts`、`routes/orders.ts:205-248`、`services/local-settings.ts:465-483` 逐行核对）。

---

## Summary

| 维度 | 结论 | 一句话 |
|---|---|---|
| 1. Normal / Failure / Money | **FAIL**（1 Critical + 2 Major） | 报价凭证的**五条重报价触发点全部接好了**，失败码分流表逐条落地且文案铁律遵守；但「小计变化 → debounce 500ms」这一段留了一个**提交按钮仍可点、金额仍是旧值**的窗口，违反计划自己的 Done 判据 |
| 2. Channel isolation | **PASS** | 购物车物理隔离、角标只统计 EXPRESS、LOCAL 无「立即购买」、列表标签与状态分表，逐条对齐；`pages/order/confirm.js` 一行未动 |
| 3. Permissions / Privacy | **RISK**（1 Major） | `__usePrivacyCheck__`、`agreePrivacyAuthorization`、`requiredPrivateInfos` 只有 `chooseLocation` 均正确；但 `resolve()` **缺 `buttonId`**，与官方约定不符，且 Task 6 的开发者工具验收从未执行 |
| 4. State / Recovery | **RISK**（2 Major） | 确认页四条出路齐全、取消窗按服务端字段渲染、异常态中性文案正确；但**骑手轮询在配送进终态后不会自行停止**，地址列表在 `/local/meta` 失败时会**整页空白**且无任何提示 |
| 5. Data integrity | **PASS with RISK** | 无静默字段依赖错误（`store.phone`/`radiusStraightKm`/`acceptGraceMin` 均已核对存在）；重复提交风险与邮寄确认页同级（未新增，也未收敛） |
| 6. 偏差与未测项的诚实度 | **PASS** | 罕见地做得很好：`map-probe.md` 写明「待补测/暂定」，spec §10 明确标注 e2e §34「⬜ 待补测——本次在 §13 `AS1` 处中止，未执行到本段」，预览台与真机验收分开标注。没有把未验证的东西写成已验证 |
| 7. 「明确不做」是否被越界 | **PASS** | 9 条逐条核对，**零越界**（详见文末对照表） |

**总体判断**：这是一份完成度很高的实现——服务端契约核对到位、注释解释了「为什么」而不是「是什么」、失败路径覆盖率远高于同类前端代码。阻塞项只有 1 条（Critical #1），其余 5 条 Major 都是独立可修的小改动。**建议修完 Critical #1 + Major #1/#2/#3 再进 M4 真机联调**，Major #4/#5 可与真机验收合并处理。

---

## Critical

### C1. 数量步进的 500ms debounce 窗口内，提交按钮仍可点，且按钮上的金额是旧的

**文件**：`apps/miniapp/pages/local/confirm.js:203-217`、`apps/miniapp/pages/local/confirm.wxml:100-107`

```js
// confirm.js:203
scheduleQuote: function() {
  var self = this
  if (this._quoteTimer) clearTimeout(this._quoteTimer)
  this._quoteTimer = setTimeout(function() { self.refreshQuote('subtotal') }, 500)
},

// confirm.js:209 reloadCart —— 先把 items/subtotal 换成新的，再排 500ms 的队
reloadCart: function() {
  ...
  self.setData({ items: items, subtotal: subtotal })   // ← subtotal 已变
  self.scheduleQuote()                                  // ← 500ms 后才 refreshQuote
}
```

`refreshQuote()` 确实做了 `setData({ quoting: true, quoteToken: null })`（`confirm.js:144`），**但那要 500ms 之后才发生**。在这 500ms 里：

- `quoting === false`
- `quoteToken` 还是**上一次小计**签发的那张票
- `payAmount` 还是**上一次小计** + 上一次运费

而按钮的禁用条件是 `submitting || quoting || blockReason || (!quoteError && !quoteToken)`（`confirm.wxml:100`）——四个条件一个都不满足，按钮**可点**，文案是 `提交订单 ¥{{payAmount}}`（旧值）。

**失败场景（可复现）**：购物车 2 份凉菜 ¥58，运费 ¥5，按钮显示「提交订单 ¥63.00」。顾客点「+」加到 3 份（¥87），在 500ms 内点提交。服务端 `routes/orders.ts:226` 用**当前真实小计 ¥87** 重算运费：若 ¥87 跨过免运门槛，`q.fee (0) < quoted.fee (5)` → **不触发 42227**，`shippingFee = 0`，订单按 **¥87** 落库，随即 `redirectTo(detail?autopay=1)` 自动拉起支付。顾客刚点的按钮上写的是 ¥63.00。

**为什么是 Critical 而不是 Major**：这是「顾客看到的 ≠ 实际下单的」，正是计划 Task 5 Done 判据的原文——「`payAmount` 在任何时刻都等于「商品小计 + quote.fee」」——被直接违反。

**为什么它不是资金损失**：服务端永远按重算价收（`orders.ts:234-235` 的比较只用于拒单，凭证价从不参与「谁更低」），微信支付面板会显示真实金额，顾客有最后一次确认机会。所以这是**知情同意/展示**层面的金钱 bug，不是被多扣钱。

**最小修复**（2 行，见 Fix Task F1）：`scheduleQuote()` 里立刻 `setData({ quoting: true, quoteToken: null })`，把「金额待定」的状态提前到用户点「+」的那一瞬间。

---

## Major

### M1. `refreshQuote` 没有请求序号，晚到的旧响应会覆盖新报价

**文件**：`apps/miniapp/pages/local/confirm.js:125-201`

页面有 6 个入口能触发报价（`load` / `address` / `show` / `subtotal` / `stale` / `retry`），但 `refreshQuote` 只清 debounce 定时器（`confirm.js:128-131`），**不作废在途请求**，`.then` 里也没有「我还是最新一次吗」的判断。

**失败场景**：顾客在确认页点「+」（A：为小计 S1 的报价已发出）→ 500ms 内点地址卡进地址列表 → 选了一个更远的地址返回 → `onShow` 触发 B（新地址报价）。若 A 的响应晚于 B 到达，`setData` 会把 A 的 `quote`（旧地址的距离/运费）和 A 的 `quoteToken`（签的是旧 `addressId`）写回页面。顾客看到的是**旧地址的距离与运费**，配着**新地址的收货人姓名**。

**兜底存在但不够**：拿旧 addressId 的票下单会被 `orders.ts:219` 挡成 42239（钱安全），且 42239 会自动重报价。所以这是展示错误 + 一次无谓的失败往返，不是扣错钱。

对比：`pages/order/list.js:115,120` 里已经有现成的 `_seq` 范式（「快速切 Tab 时丢弃过期响应」），同一个仓库里抄一份即可。

### M2. `/local/meta` 失败时，同城模式的地址列表整页空白且无任何提示

**文件**：`apps/miniapp/pages/address/list.js:35-68`

```js
return getAddresses()
  .then(function(list) {
    if (self.data.channel !== 'LOCAL') { self.setData({ addresses: list, loading: false }); return }
    return getLocalMeta().then(function(meta) {   // ← 只为算一个装饰性标签
      ...
      self.setData({ addresses: addresses, loading: false })
    })
  })
  .catch(function() { self.setData({ loading: false }) })   // ← addresses 从未被 setData
```

`getLocalMeta()` 是 `silent: true`（`api/local.js:5`），失败**不弹 toast**。于是 `/local/meta` 一超时（10s `networkTimeout`），LOCAL 模式的地址列表就变成一张**空白页**：地址都在服务端好好的，顾客却一个都看不见，也不知道发生了什么，同城下单链路就此断掉。

一个只用来渲染「直线约 x.x km」标签的接口，不应该有权决定整个地址列表是否显示。

**附带**（同一处，`list.js:55`）：`meta.store.latE6` 为 `null` 时（店主启用了同城但没设门店坐标），`getStraightDistanceKm(null, null, ...)` 里 `null / 1e6 === 0` → 从赤道起算 → 每一行都会显示一个**看起来很正常的三四千公里**，全部标成「可能超范围」。宁可不显示标签，也不该显示一个假的数字。

### M3. 骑手轮询在配送进入终态后不会自行停止

**文件**：`apps/miniapp/pages/order/detail.js:383-399`

```js
var tick = function() {
  getCourierLocation(self._orderId)
    .then(function(r) { self.setData({ courierLoc: r.location || null }) })
    .catch(function() {})
}
tick()
this._courierTimer = setInterval(tick, 30 * 1000)
```

`startCourierPoll` 的**启动**条件判断得很对（`deliveryType === 'LOCAL'` 且 `delivery.status ∈ COURIER_LIVE_STATUSES`），`onHide/onUnload` 也都停了。问题在于 `tick` **只取骑手位置，从不刷新订单**——`this.data.order.delivery.status` 在页面打开期间是冻结的。

**失败场景**：顾客在配送中打开订单详情盯着看（这正是最常见的姿势）。骑手送达，`delivery.status` 变成 `DELIVERED`，但页面里那份 order 还停在 `DELIVERING`，`setInterval` 于是**每 30 秒继续打一次 `/orders/:id/courier`，直到顾客切走或关掉页面**。

计划 Task 7 Done 把这一条单独拎出来写过：「开发者工具 Network 面板确认终态订单不再轮询 `/courier`（这是最容易漏的一条，也是唯一会持续消耗运力方配额的）」。现在的实现只能通过「重新进页面」这个测法，通不过「停在页面里等它送达」这个测法。

**修法**：`tick` 里顺带判一次终态（或每 N 轮 `loadOrder(id, true)` 一次），拿到 `DELIVERED/CANCELLED` 就 `stopCourierPoll()` 并刷新一次详情——顺带解决「送达了但页面还写着配送中」的展示滞后。

### M4. 隐私弹窗 `resolve()` 缺 `buttonId`，与官方约定不符

**文件**：`apps/miniapp/components/privacy-popup/index.js:11-17`、`index.wxml:11`

```js
resolvePrivacy(event) {
  ...
  if (resolve) resolve({ event: event })     // ← 只有 event
}
```
```xml
<button class="privacy-agree" open-type="agreePrivacyAuthorization" bindagreeprivacyauthorization="onAgree">同意并继续</button>
<!-- ↑ 没有 id -->
```

微信官方 `wx.onNeedPrivacyAuthorization` 的约定是 `resolve({ event: 'agree', buttonId: '<那个 agreePrivacyAuthorization 按钮的 id>' })`——`buttonId` 用来向平台证明「这次同意确实来自一个合规的授权按钮」。当前按钮没有 `id`，`resolve` 也没传，官方文档要求的这一环是缺的。

**为什么不是 Critical，也不能就此判 FAIL**：这条只能在真机/开发者工具里证伪，而 Task 6 Step 6 的验收（「清缓存 → 进地址编辑页 → 点地图选点 → 弹窗出现 → 拒绝 → 再点 → 再弹 → 同意 → 地图打开」）**在本分支上从未执行过**。可能的表现是「同意后 `wx.chooseLocation` 仍然不放行 / 每次都重新弹」，也可能基础库宽容处理。**必须在 M4 真机联调时作为第一条验证项**，而不是等审核被拒才发现。

**修法**：给按钮加 `id="privacy-agree-btn"`，`onAgree` 走 `resolve({ event: 'agree', buttonId: 'privacy-agree-btn' })`，`onDisagree` 保持 `{ event: 'disagree' }`。

### M5. 「骑手位置」卡展示的是订单的门店→收货点距离，且 `courierLoc` 取到了却没被用来渲染任何东西

**文件**：`apps/miniapp/pages/order/detail.wxml:64-73`

```xml
<view class="card courier-route-card" wx:if="{{order.isLocal && courierLoc && storeLoc}}">
  <view class="card-title">骑手位置</view>
  <cover-view class="courier-route"> ... 三个位置固定的 CSS 点 ... </cover-view>
  <text class="courier-route-distance">距门店 {{order.distanceText}} km</text>
</view>
```

两个问题叠在一起：

1. **数字会被误读**。`order.distanceText` 是 `order.distanceM`——门店到收货地址的**计费距离**，一单之内是常数。把它放在标题为「骑手位置」的卡里、写成「距门店 x.x km」，顾客会理解成「骑手现在离门店 x.x km」。骑手越走越近，这个数字纹丝不动。计划 Task 7 Step 3 要的是「骑手距您约 x.x km」。
2. **30 秒一次的轮询产出为零**。`courierLoc` 唯一的作用是**决定这张卡显不显示**；示意图里的门店点、收货点、骑手点全是 wxss 里写死的位置（`detail.wxss` 的 `.route-store/.route-receiver/.route-rider`）。也就是说，这个每 30 秒外呼一次运力方的轮询，除了「卡出现了」之外没有给顾客任何随时间变化的信息。

**附带风险**：`<cover-view>` 是**用于覆盖在原生组件（map/video/canvas/live-player）之上**的元素，这里没有任何原生组件，属于超出官方定义的用法——模拟器上通常能渲染，真机与低版本基础库上行为未定义（且 `cover-view` 的 CSS 支持是受限子集）。Task 0 的结论是「退化成 `cover-view` 静态两点图」，但那句话的本意是「不用 `<map>`，画个静态示意图」，不是「必须用 `<cover-view>` 这个标签」。**改成普通 `<view>` 没有任何损失**。

考虑到 Task 0 的地图探针在模拟器和真机上**都还没测过**（`map-probe.md` 四行里两行是「待补测」），这块整体处在「按最保守假设先写了个占位」的状态，这一点文档里说清楚了，不算隐瞒。

---

## Minor

| # | 文件:行 | 问题 |
|---|---|---|
| m1 | `pages/local/confirm.js:196-199` | `_retriedRateLimit` **只置真不置假**：整个页面生命周期里 42901 的自动重试只会发生一次，之后再限流就只剩手动按钮。计划原文「3 秒后自动重试一次」按每次触发理解更合理；至少应在报价成功后复位 |
| m2 | `pages/local/confirm.js:340-350` + `confirm.wxml:30` | **`feeFlash` 大概率闪不出来**。`.fee-flash` 挂在 `.delivery-info` 上，而该块的渲染条件是 `wx:elif="{{quote}}"`（前置 `quoting`/`quoteError` 分支优先）。42227 处理里先 `feeFlash: true` 再 `refreshQuote()` → `quoting: true` → 该块立刻被「正在计算配送费…」替换 → 1.2s 后定时器把 `feeFlash` 关掉。能否看见完全取决于报价往返是否快于 1.2s。计划把它定位成「42227 的本质是钱变了，不给视觉锚点顾客根本不会注意到」——现在这个锚点是概率性的。建议把 flash 状态绑到「本次报价回来之后」而不是定时器 |
| m3 | `pages/local/confirm.wxml:26-29` | 「重新获取运费」的 `bindtap` 指向 **`onSubmit`**（靠 `onSubmit` 第一行的 `quoteError` 分支转发）。能工作，但把「重试报价」和「提交订单」绑在同一个入口上，任何人调整 `onSubmit` 的守卫顺序都会静默改掉重试行为。直接 `bindtap="onRetryQuote"` 更安全 |
| m4 | `pages/local/confirm.wxml:93-98` | 报价失败（`quoteError`）时，配送信息块换成了错误提示，但底部「合计」仍在显示**上一次的 `payAmount`**。要么两处一起保留旧值，要么两处一起改成「待重新计算」，现在是一半一半 |
| m5 | `pages/local/confirm.js:149-156` | `blockReason` 生效（超范围/未达起送）时仍然写入 `payAmount`，底部照常显示一个合计金额——一个顾客根本不可能被收到的钱 |
| m6 | `pages/local/confirm.js:31-37` + `wxml:31` | `quote.distanceSource` 拿到了但没用。服务端注释明确写着「`distanceSource` 让调用方分得清这次是实测还是估算（小程序据此决定文案）」（`routes/local.ts:57-63`）。查价失败退回直线估算时，顾客端把估算值当实测值展示成「距门店 x.x km」 |
| m7 | `pages/local/index.js:186-208` | 加购的渠道校验是**事后**的：`addToCart` 已经成功（商品按自身 channel 落进了邮寄车），才发现 `result.channel !== 'LOCAL'` 并 toast。此时既没有回滚，也没有 `app.updateCartCount()` → tabBar 角标与真实邮寄车不一致，直到下次进购物车页。属于「不该发生但发生了」的兜底路径，成本很低：补一次 `updateCartCount()` |
| m8 | `pages/order/detail.js:513-534` | `onRequestCancel` 无在途守卫（双击可发两次 POST），且 `requestCancelOrder` 是 `silent: true` —— **非 42229 的失败（断网、500）顾客看不到任何反馈**，只有一次静默刷新。「我到底申请上了没有」是这一步最不该含糊的事 |
| m9 | `pages/order/detail.wxml:79` | `graceMin` 来自 `/local/meta`；该请求失败时（`loadStoreLoc` 的 catch 是空的）文案会变成「接单后&nbsp;&nbsp;分钟内可申请取消」。截止时间 `localCancelDeadlineText` 是服务端下发的，本身够用，`graceMin` 为空时应整句降级 |
| m10 | `pages/order/detail.wxml:37` | `order.distanceM` 为 null 时渲染成「距门店&nbsp;&nbsp;km」（`decorateOrder` 已把 null 转成 `''`，但没有整行隐藏） |
| m11 | `pages/local/index.wxml:28` | `meta.fee` 缺失时 `pricefmt.fen(undefined)` 的输出未验证（可能是 `NaN`），门店条会显示「满 ¥NaN 起送」。服务端契约上 `fee` 必有，属防御性问题 |
| m12 | `scripts/e2e.sh:1192-1218` | 新增的第 34 段**一次都没跑过**（spec §10 已诚实标注：本次 e2e 在 §13 `AS1` 处中止）。因此这段断言本身也未验证——例如 `jq .data.delivery` 在 `delivery` 为 null 时 `has()` 会报错而不是返回 false。它现在是「写好了但状态未知」的代码，不是绿灯 |
| m13 | `api/cart.js:4-6` | `getCart('EXPRESS')` 与 `getCart()` 等价（函数只认 `'LOCAL'`）。`app.js:78` 传 `'EXPRESS'` 是为了自我文档化，意图很好，但如果哪天服务端默认渠道改了，这个「显式」是假的显式。建议 `channel === 'LOCAL' ? '?channel=LOCAL' : '?channel=EXPRESS'`，或在 `getCart` 里注释说明默认值就是契约 |

---

## Open Questions

1. **Task 0 地图探针从未执行**，模拟器与真机两行都是「待补测」，`<map>` 到底能不能用仍然未知。当前走的是保守分支，但**保守分支自己也没在真机上验证过**（M5 的 `cover-view` 用法）。M4 是否把「花 10 分钟把探针跑掉」排进去？跑掉之后 M5 可能整块重做成真 `<map>`，现在花在静态示意图上的打磨会作废。
2. **「骑手距您约 x.x km」需要在顾客端做一次 haversine**（骑手坐标 → 收货坐标），这与 Global Constraints 里「唯一允许的距离计算是地址列表那一处」字面冲突。是放宽约束（骑手实时距离不参与任何计费，风险确实低），还是接受「骑手卡只显示状态文案、不显示距离」？M5 的修法取决于这个决定。
3. **e2e §13 的 `AS1` 中止是本轮引入的还是既有的？** spec §10 写的是「既有 §13」。若是既有问题，第 34 段会一直是死代码——需要一个独立的小任务先修 §13，否则「顾客端字段契约锁」这道防线名存实亡。
4. **重复提交**：`createOrder` 超时（10s）但服务端已落库时，顾客再点一次会产生第二张订单。这与邮寄确认页同级（M3 没有引入，也没有改善），服务端也没有幂等键。同城场景的下单频率与金额都更高，是否值得在 M4 之前给 `POST /orders` 加一个客户端生成的幂等键？
5. **工作目录里有未跟踪的 `docs/design/miniapp-cover/`**，而计划 §明确不做 第 1 条是「不做封面页」。这些文件不在本次 commit 范围内（`git status` 显示 `??`），推测来自另一个 worktree 的并行工作——确认一下它不会在合并时被顺手带进来。计划本身的临时入口实现是干净的（`index.js:69-93` 有整块删除注释，入口契约逐字符合 spec §6）。

---

## Suggested Codex fix tasks

每条独立可修、互不依赖，按建议顺序排列。

### F1 —— 关闭 debounce 窗口的可提交状态（对应 C1，**合并前必修**）

`apps/miniapp/pages/local/confirm.js`：`scheduleQuote()` 里在排队之前先把页面打进「金额待定」：

```js
scheduleQuote: function() {
  var self = this
  if (this._quoteTimer) clearTimeout(this._quoteTimer)
  // 小计一变，旧凭证与旧金额立刻作废：debounce 的 500ms 里按钮必须已经是禁用态，
  // 否则顾客能拿着旧金额的按钮提交一个新小计的订单（服务端按新小计实收）。
  this.setData({ quoting: true, quoteToken: null })
  this._quoteTimer = setTimeout(function() { self.refreshQuote('subtotal') }, 500)
},
```

**验收**：连点「+」若干次，按钮从第一下起就变成「计算运费中…」且不可点，直到最后一次报价返回；期间底部合计显示「运费计算中」而不是旧数字。

### F2 —— 给 `refreshQuote` 加请求序号（对应 M1）

抄 `pages/order/list.js:115,120` 的 `_seq` 范式：`refreshQuote` 入口 `var seq = (this._quoteSeq = (this._quoteSeq || 0) + 1)`，`.then`/`.catch` 第一行 `if (seq !== self._quoteSeq) return`。

**验收**：地址切换与数量变更交叉触发时，页面最终显示的距离/运费/token 永远属于最后一次发出的报价。

### F3 —— 地址列表：`/local/meta` 失败不得吞掉地址（对应 M2）

`apps/miniapp/pages/address/list.js:44-63`：把 `getLocalMeta()` 的失败降级为「不显示距离标签」，而不是让整个列表消失。

```js
return getLocalMeta()
  .then(function(meta) { self.setData({ addresses: decorate(list, meta), loading: false }) })
  .catch(function() {
    // 距离标签只是辅助信息，拿不到就不显示；地址本身必须照常渲染，
    // 否则顾客会看到一张空白的地址列表，而同城下单链路就断在这里。
    self.setData({ addresses: list, loading: false })
  })
```

同时在 `decorate` 里对 `meta.store.latE6 == null` 显式返回「无标签」，避免从赤道起算出几千公里的假数字。

**验收**：断网/让 `/local/meta` 返回 500 → 地址列表照常列出全部地址，只是没有「直线约 x.x km」标签，且可正常选中返回。

### F4 —— 骑手轮询在终态自停（对应 M3）

`apps/miniapp/pages/order/detail.js` 的 `tick`：拿到骑手位置的同时判一次终态。最省事的做法是每轮顺带刷一次订单（30s 一次的详情请求成本可接受），拿到 `DELIVERED/CANCELLED` 就 `stopCourierPoll()` 并 `setData` 新订单——一并修掉「已送达但页面还写配送中」。

**验收**：页面开着不动，用 `POST /admin/system/delivery-mock` 推 `520` → 30 秒内页面变成「已送达」，Network 面板不再出现新的 `/courier` 请求。

### F5 —— 隐私弹窗补 `buttonId`（对应 M4）

`components/privacy-popup/index.wxml` 的同意按钮加 `id="privacy-agree-btn"`；`index.js` 的 `onAgree` 改为 `resolve({ event: 'agree', buttonId: 'privacy-agree-btn' })`，`onDisagree` 保持不变。顺带处理两个边界：弹层可见时页面被 `onUnload`，以及第二个授权请求到来时覆盖了未决的 `privacyResolve`——两种情况都会让调用方的 Promise 永远悬着，最简单的收口是在覆盖/卸载前先 `resolve({ event: 'disagree' })`。

**验收**（必须在开发者工具里跑，这条不能靠读代码收）：清缓存 → 地址编辑页 → 点地图选点 → 弹窗 → 拒绝 → 地图不打开且无报错 → 再点 → 再弹 → 同意 → **地图打开**（关键是这一步，`buttonId` 缺失最可能的表现就是这里不放行）。

### F6 —— 骑手卡的距离文案与 `cover-view` 标签（对应 M5）

两件事可以一起做：

1. `detail.wxml:66-71` 的 `<cover-view>` 全部换成 `<view>`（没有原生组件可覆盖，这个标签在真机上属未定义用法）。
2. 「距门店 {{order.distanceText}} km」在骑手卡里会被读成骑手的实时距离——按 Open Question 2 的结论二选一：要么算 `courierLoc → receiver` 的直线距离显示成「骑手距您约 x.x km」，要么整行删掉、骑手卡只留状态文案。**不要保留现状**。

**验收**：`210`（骑手到店）与 `310`（配送中）两个 mock 状态下，卡里的数字随骑手位置变化；或者卡里没有数字。

### F7 —— Minor 打包修复

m1（`_retriedRateLimit` 报价成功后复位）、m3（重试按钮独立方法）、m4/m5（`quoteError`/`blockReason` 时合计一致降级）、m7（渠道不符时补 `updateCartCount()`）、m8（`onRequestCancel` 加在途守卫 + 非 42229 失败也给提示）、m9/m10（`graceMin`/`distanceM` 为空时整句/整行降级）。互不相关，可一次提交。

### F8 —— 让 e2e §34 真的跑起来（对应 m12）

✅ **已关（2026-09-04）**：`e96ef3b` + `1714889`（AS1 / 全角括号）+ `695fd5f`（稳定 `mk_local_paid`）；之后连续两轮全绿（`/tmp/e2e-mkfix-run.log`、`/tmp/e2e-mkfix-run2.log`，约 20:10–20:11 JST）均为 **通过 528 / 失败 0**。spec §10 §34 行已回填 ✅。

---

## 附：「明确不做」逐条核对（维度 7）

| # | 约束 | 结论 | 证据 |
|---|---|---|---|
| 1 | 不做封面页 | **PASS** | 只有首页临时入口，`pages/index/index.js:69` 有「封面落地后整块删除」注释；`goLocal` 的 `navigateTo('/pages/local/index')` 与 spec §6 契约逐字一致 |
| 2 | 不做同城「立即购买」 | **PASS** | `product/detail.js:119` `isBuy = mode==='buy' && !isLocal`；`detail.wxml:102-103` LOCAL 时按钮换成「去同城结算」→ `navigateTo('/pages/local/index')`；`local/index.wxml:137` 的 `sku-popup` 写死 `mode="cart"` |
| 3 | 不做同城搜索 | **PASS** | `local/index.wxml` 全文无搜索框 |
| 4 | 不做预约/餐具明细/多骑手/会员 | **PASS** | 只有一个 `needTableware` 开关，按计划拼进 `remark` 前缀并 `slice(0,255)`（`confirm.js:320,326`） |
| 5 | 不动 admin / 不接飞鹅 | **PASS** | diff 中无 `apps/admin`、无打印机相关文件 |
| 6 | 不做「已送达」订阅消息 | **PASS** | 只沿用 `getOrderMeta().subscribeTemplateIds`，未新增模板 |
| 7 | 不动生产 / 不 push / 不碰密钥 | **PASS** | 10 个 commit 全在本地分支；无 `.env` 类改动 |
| 8 | 地址列表不显示道路距离 | **PASS** | `address/list.js:45-50` 保留了完整的「为什么」注释，文案是「直线约 x.x km」，`far` 态**不禁用**选择（`list.js:95-101` 只拦 `missing`） |
| 9 | 不改 `order/confirm.js` 的 `deliveryType:'EXPRESS'` | **PASS** | 该文件不在 diff 中 |

**额外核对**：`app.json:54` `requiredPrivateInfos` 仍然只有 `chooseLocation`（没有偷偷加 `getLocation`），与 `docs/miniapp-release-checklist.md` 2.4 一致；spec §6 里写的 `["chooseLocation","getLocation"]` 是**旧文本**，实现比 spec 更严格，方向正确——但两处不一致，M4 顺手把 spec 那行也改掉。
