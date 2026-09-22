# 同城「预约送达」批次二（小程序）—— 实施计划

> **工序 00 规划 · 模型 Fable。** 按「多 agent 开发协议」§2.2 定级 **M**（第 3 条：顾客端新功能；不含迁移、认证、支付流程改动——支付仍走现有 createOrder → detail?autopay 链路，只多传一个 `scheduledAt`），链路 `规划（Fable）→ 执行（Sonnet）→ 复核（Sonnet，新会话）→ 交付`。店主可只升不降。
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**原始需求**：`docs/superpowers/specs/2026-09-21-scheduled-delivery-design.md` §5（小程序）与 §5.4 三态显示总表；店主拍板 S1、S8。服务端（批次一，main `987461d`）与后台前端（批次一后半，main `8f4a13c`）已就绪，契约见 `docs/api.md` 附录 M。

**Goal:** 顾客在同城外送结算页能在「尽快送达 / 预约时段」之间选择；打烊时能预约明天；订单详情与列表处处能看出「这是预约单」；自取页的时段弹层与外送共用一个组件。立即单、自取、邮寄链路逐字节不变。

**Architecture:** 结算页仍围绕「地址 → 报价凭证」这一条状态机，预约只是在它之上多一层「送达时间」选择：报价成功拿到 `distanceM` 后才能拉时段（`GET /local/delivery-slots?distanceM=`）；服务端 `quote.isOpen=false` 时若 `meta.delivery.scheduleEnabled` 则**不再阻塞**，改为强制预约模式。按钮判定仍只在 `utils/local-checkout-state.checkoutAction` 一处，新增三种文案与一个 `slot` 动作。时段弹层从 `pages/local/pickup.wxml` 抽成组件 `components/slot-picker`，自取页改用同一组件。详情页的预约文案由新纯函数 `utils/schedule-order.js` 产出，便于单测。

**Tech Stack:** 原生小程序（ES5，`var`/`function`，不用 ES6 语法——`pages/local/pickup.js` 顶注「保持 ES5」是全仓约定）；单测 `node --test tests/miniapp/*.test.cjs`（根目录 `npm run test:miniapp`）；页面级行为锁照 `tests/miniapp/pickup-page.test.cjs` 的 `loadPage/makeCtx` 夹具写；`tools/miniapp-preview`（`npm run preview:miniapp`，5180 端口）可在浏览器里看页面版式，真机走微信开发者工具。

---

## 协议 §3.1 规划输出

【工序】规划 【模型】Fable 【等级】M

### 验收标准
1. `npm run test:miniapp` → 全部通过，含新增：
   - `tests/miniapp/local-catalog.test.cjs`：打烊 + 预约开 → 胶囊「已打烊 · 可预约」`tone:'schedule'`、通知不阻塞且含 `earliestScheduleText`、`deliveryModeHint` 为「（可预约）」；打烊 + 预约关 → 与改前逐字节一致；营业中 → 与改前一致
   - `tests/miniapp/local-checkout-state.test.cjs`：`scheduleMode:'SCHEDULED'` 未选格 → 禁用「请选择送达时段」action `slot`；格失效 → 可点「时段已过，请重选」action `slot`；选好格 → 「预约下单」action `submit`；`closedNow && !scheduleAvailable` → 仍走 `blockReason` 阻塞；`closedNow && scheduleAvailable && scheduleMode:'ASAP'` → 禁用「请选择送达时段」（打烊只能预约）；不传新字段时八种旧结果逐字节一致
   - `tests/miniapp/schedule-order.test.cjs`：横幅文案、时间线 extra（接单前「商家将在 HH:mm 前确认」/ 接单后「商家已确认，HH:mm 开始备餐」）、状态标签 PAID→「已预约」、取消卡文案三段（两小时外 / 两小时内 / 已备好后）
   - `tests/miniapp/confirm-page.test.cjs`（新，页面级行为锁）：报价成功 + `isOpen:false` + `scheduleEnabled:true` → `scheduleMode==='SCHEDULED'`、`blockReason===''`、自动选中最早格、按钮「预约下单」；报价成功 + `isOpen:true` → `scheduleMode==='ASAP'`、不拉时段；换地址 → `slotSelected===null`；服务端 42291 → `slotStale===true` 且重拉时段
   - `tests/miniapp/pickup-page.test.cjs` 现有全部用例不改、仍绿（弹层抽组件后自取行为不变）
2. `git diff --stat main -- apps/miniapp/pages/order/confirm* apps/miniapp/pages/local/index* apps/miniapp/utils/channel.js` → 为空（邮寄结算页、同城主页脚本、模式归一化不动；主页只通过 `local-store-header/local-mode-bar/local-cart-bar` 组件的属性变化）
3. `node tools/miniapp-preview/serve.mjs --port 5180` 后人工检查（截图附报告）：
   - 营业中：结算页「送达时间」卡默认「尽快送达」，可切「预约时段」并弹层选格，按钮变「预约下单」；配送信息里的「约 N 分钟送达」只在尽快时显示，预约时显示「预计 明天 12:00–12:30 送达」
   - 打烊（用后台把营业时间改成不含现在）：主页胶囊「已打烊 · 可预约」、通知条软提示、切换栏「外送」下「（可预约）」、购物车条「去结算 · 预约外送」、结算页「尽快送达」置灰带「已打烊」、默认预约并选中最早格、提交按钮「预约下单」
   - 打烊 + 预约关：与改前一致（阻塞、「改用全国邮寄」）
   - 下单后详情：顶部横幅「预约配送 · 明天 12:00–12:30 送达」，时间线第一步 extra，列表卡标签「同城 · 预约」，状态「已预约」；取消按钮按服务端 `canSelfCancel/canRequestCancel`
   - 自取页时段弹层外观与操作与改前一致
4. 真机（微信开发者工具真机预览）走一遍打烊时段下单到支付；店主验收。
5. `bash scripts/e2e.sh`（干净库，`TZ=Asia/Shanghai`）→ 末行「失败 0」（本批不改服务端；只为确认没误改 e2e 分片）

### 实现方向
1. `api/local.js` 加 `getDeliverySlots(distanceM)`；`utils/local-catalog.js` 加打烊可预约三态与 `deliveryModeHint`（预计涉及：`apps/miniapp/api/local.js`、`apps/miniapp/utils/local-catalog.js`、`tests/miniapp/local-catalog.test.cjs`）
2. `utils/local-checkout-state.js` 按钮状态机加预约分支（预计涉及：该文件与 `tests/miniapp/local-checkout-state.test.cjs`）
3. `components/slot-picker` 从自取页抽出；自取页改用（预计涉及：`apps/miniapp/components/slot-picker/*`、`apps/miniapp/pages/local/pickup.{wxml,wxss,json}`）
4. 结算页：送达时间卡、时段拉取与失效、打烊强制预约、提交带 `scheduledAt`、42290/42291 处理（预计涉及：`apps/miniapp/pages/local/confirm.{js,wxml,wxss,json}`、`tests/miniapp/confirm-page.test.cjs`）
5. 主页/分类页的三处组件与购物车条文案（预计涉及：`apps/miniapp/components/local-store-header/*`、`local-mode-bar/*`、`local-cart-bar/index.js`）
6. 订单详情与列表（预计涉及：`apps/miniapp/utils/schedule-order.js`、`tests/miniapp/schedule-order.test.cjs`、`apps/miniapp/pages/order/detail.{js,wxml,wxss}`、`pages/order/list.{js,wxml}`、`components/order-status-tag/index.js`）
7. 人工验收（预览工具 + 真机）

### 授权范围
```
apps/miniapp/api/local.js
apps/miniapp/utils/local-catalog.js
apps/miniapp/utils/local-checkout-state.js
apps/miniapp/utils/schedule-order.js
apps/miniapp/components/slot-picker/**
apps/miniapp/components/local-store-header/**
apps/miniapp/components/local-mode-bar/**
apps/miniapp/components/local-cart-bar/index.js
apps/miniapp/components/order-status-tag/index.js
apps/miniapp/pages/local/confirm.*
apps/miniapp/pages/local/pickup.wxml
apps/miniapp/pages/local/pickup.wxss
apps/miniapp/pages/local/pickup.json
apps/miniapp/pages/local/pickup.js        （只允许改 selectDay/selectSlot 两处读 idx 的表达式：e.detail.idx 优先、缺则读 e.currentTarget.dataset.idx；其它改动须上报）
apps/miniapp/pages/local/index.wxml
apps/miniapp/pages/product/list.wxml
apps/miniapp/pages/order/detail.*
apps/miniapp/pages/order/list.*
tests/miniapp/local-catalog.test.cjs
tests/miniapp/local-checkout-state.test.cjs
tests/miniapp/schedule-order.test.cjs
tests/miniapp/confirm-page.test.cjs
tests/miniapp/pickup-page.test.cjs
tools/miniapp-preview/**
docs/api.md
```

### 禁止修改
```
apps/server/**
apps/admin/**
apps/miniapp/utils/channel.js
apps/miniapp/utils/pickup-checkout-state.js
apps/miniapp/pages/local/index.js
apps/miniapp/pages/order/confirm.*
apps/miniapp/utils/checkout-pay.js
apps/miniapp/utils/request.js
apps/miniapp/config/**
scripts/e2e.sh
scripts/e2e.d/**
```
（`pickup.js` 只开放两处读 `idx` 的表达式：组件事件的 `idx` 在 `e.detail` 里，而页面原来读 `e.currentTarget.dataset.idx`；改成「`e.detail.idx` 优先、缺则读旧位置」两行即可，语义不变，行为锁 `pickup-page.test.cjs` 必须不改仍绿。）

### 上报条件
- 需要改授权范围外的文件（尤其 `channel.js`、`pickup-checkout-state.js`、任何服务端文件），或 `pickup.js` 里除那两处 idx 读取之外的任何改动
- 发现服务端契约与附录 M 不符（例如 `quote` 不带 `isOpen`、`delivery-slots` 结构与 `pickup-slots` 不同、详情没有 `schedule` 节）
- `tests/miniapp/pickup-page.test.cjs` 任一用例由绿转红
- 结算页出现「按钮可点但 `quoteToken` 为空」或「`scheduledAt` 与所选格不一致」的路径

### 待用户决定
- 无。（两处规划者按 spec 定的：① 打烊时**自动选中最早一格**（S8 原文），与自取 2026-09-17「不自动预选」不同——外送打烊时顾客没有别的选择，预选省一步；② 预约单不请求新的订阅模板，仍用 `subscribeTemplates.local`。）

---

## Global Constraints

- ES5，不用 `const/let/箭头函数/模板字符串`（与 `pages/local/pickup.js` 顶注一致）。
- 立即单、自取、邮寄逐字节不变：`checkoutAction` 不传新字段时八种旧结果不变（用例钉住）；`storeStatusOf/headNoticeOf` 在预约关时与改前一致。
- 结算页按钮判定只在 `checkoutAction` 一处；页面按 `action.action` 分派（`submit / retry / tableware / slot / none`），绝不「按钮没禁用就提交」。
- 报价凭证规则不变：任何让 `quoteToken` 失效的操作（换地址、改数量、改券）同时清空已选时段；时段只在报价成功后按 `quote.distanceM` 拉。
- 「预约」两个字跟着订单走完全程：胶囊、通知、切换栏副标、购物车条、结算页卡、提交按钮、详情横幅、列表标签、状态标签（spec §5.4 总表）。
- 时刻文案一律用服务端下发的 `slotLabel / earliestScheduleText / schedule.*`；小程序不倒推、不算时区（只格式化 `HH:mm` 走 `utils/time`）。
- 每个 Task 结束前 `npm run test:miniapp` 全绿；提交信息中文说明为什么，末尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## 服务端契约速查（执行者不必读服务端代码）

```
GET /api/local/meta → delivery: { enabled, isOpen, paused, closedKind, nextOpenText,
                                 scheduleEnabled, slotMinutes, selfCancelLeadMin, earliestScheduleText }
POST /api/local/quote → { enabled, isOpen, paused, nextOpenText, closedKind, inRange, distanceM, fee, quoteToken, quoteExpiresAt, estimatedMinRange/MaxRange, isPeakNow, … }
GET /api/local/delivery-slots?distanceM=N → { days:[{date,label,slots:[{startAt,endAt,label}]}], earliestAt, slotMinutes, blocked:null|{kind:'DISABLED'|'HOLIDAY'|'PAUSED',text} }   // 与 pickup-slots 同构
POST /api/orders { …, deliveryType:'LOCAL', quoteToken, scheduledAt? }  → 42290 未开通 / 42291 时段不可选 / 42222 非营业时间（只对未传 scheduledAt 的立即单）
orderCreatedView.scheduledAt；GET /api/orders/:id → schedule: { scheduledAt, slotLabel, ticketAt, prepStartAt, callAt, acceptDueAt, selfCancelUntil, readyAt, phase, etaIfCallNow } | null
GET /api/orders/:id 的 canSelfCancel / canRequestCancel 已按「约定前 selfCancelLeadMin」判好；列表项有 scheduledAt
```

---

### Task 1: API 与店头三态

**Files:**
- Modify: `apps/miniapp/api/local.js`
- Modify: `apps/miniapp/utils/local-catalog.js`
- Modify: `tests/miniapp/local-catalog.test.cjs`

**Interfaces:**
- Produces：`getDeliverySlots(distanceM)`；`deliveryScheduleOnly(meta)`（打烊且预约开且外送可用）；`deliveryModeHint(meta)`；`storeStatusOf(meta,'DELIVERY')` 新增返回 `{ tone:'schedule', label:'已打烊 · 可预约' }`；`headNoticeOf(meta,'DELIVERY')` 新增软提示。

- [ ] **Step 1: `api/local.js`**

```js
// 预约外送时段（公开）。distanceM 必传：时段的提前量取决于路上时间，结算页报价成功后才拉。
// silent：结算页要按 blocked 自己分流。
function getDeliverySlots(distanceM) {
  return request({ url: '/local/delivery-slots?distanceM=' + (distanceM || 0), silent: true })
}
```
并导出。

- [ ] **Step 2: `utils/local-catalog.js`**

在 `storeStatusOf` 的 DELIVERY 分支、`if (meta.paused)` 之后插入：
```js
  // 打烊但预约开着（2026-09-21 预约送达 §5.1）：不是灰胶囊，是「可预约」——顾客现在下单是预约配送
  if (deliveryScheduleOnly(meta)) return { tone: 'schedule', label: '已打烊 · 可预约' }
```
`headNoticeOf` 的 DELIVERY 分支、`if (!meta.isOpen)` 之前插入：
```js
  if (deliveryScheduleOnly(meta)) {
    var earliest = meta.delivery && meta.delivery.earliestScheduleText
    return { text: '现在下单为预约配送' + (earliest ? '，' + earliest : ''), blocking: false }
  }
```
新增两个函数（放在 `pickupModeHint` 旁）：
```js
/** 外送此刻只能预约：开着、没暂停、没休业、不在营业时段、预约开着。营业中或预约关着都返回 false */
function deliveryScheduleOnly(meta) {
  if (!meta || meta.holiday || !meta.enabled || meta.paused) return false
  var d = meta.delivery
  return !!(d && d.scheduleEnabled && !meta.isOpen)
}
// 切换栏「外送」下的小字：只在打烊而预约可用时补「（可预约）」，与自取的 pickupModeHint 同一取向
function deliveryModeHint(meta) {
  return deliveryScheduleOnly(meta) ? '（可预约）' : ''
}
```
`checkoutStateOf` 不改（阻塞与否由页面传 `blocking`，主页在 `deliveryScheduleOnly` 时传 `false`——见 Task 5）。导出两个新函数。

- [ ] **Step 3: 测试**（追加到 `tests/miniapp/local-catalog.test.cjs`，沿用文件里的写法）

```js
const openMeta = { enabled: true, isOpen: true, paused: null, holiday: null, closedKind: 'OPEN', nextOpenText: '', fee: { minOrderAmount: 4000 }, delivery: { scheduleEnabled: true, earliestScheduleText: '' } }
const closedSched = Object.assign({}, openMeta, { isOpen: false, closedKind: 'CLOSED', nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: true, earliestScheduleText: '最早明天 09:30–10:00送达' } })
const closedNoSched = Object.assign({}, closedSched, { delivery: { scheduleEnabled: false, earliestScheduleText: '' } })

test('打烊 + 预约开：胶囊「已打烊 · 可预约」、通知软提示带最早送达、外送副标「（可预约）」', () => {
  assert.deepEqual(storeStatusOf(closedSched, 'DELIVERY'), { tone: 'schedule', label: '已打烊 · 可预约' })
  assert.deepEqual(headNoticeOf(closedSched, 'DELIVERY'), { text: '现在下单为预约配送，最早明天 09:30–10:00送达', blocking: false })
  assert.equal(deliveryModeHint(closedSched), '（可预约）')
  assert.equal(deliveryScheduleOnly(closedSched), true)
})
test('打烊 + 预约关：与改前逐字节一致（阻塞）', () => {
  assert.deepEqual(storeStatusOf(closedNoSched, 'DELIVERY'), { tone: 'closed', label: '已打烊' })
  assert.deepEqual(headNoticeOf(closedNoSched, 'DELIVERY'), { text: '明天 09:00 营业', blocking: true })
  assert.equal(deliveryModeHint(closedNoSched), '')
})
test('营业中 / 暂停 / 休业：预约开关不影响原判定', () => {
  assert.deepEqual(storeStatusOf(openMeta, 'DELIVERY'), { tone: 'open', label: '营业中' })
  assert.equal(deliveryScheduleOnly(Object.assign({}, closedSched, { paused: { reason: '忙' } })), false)
  assert.equal(deliveryScheduleOnly(Object.assign({}, closedSched, { holiday: { until: null } })), false)
})
```

- [ ] **Step 4: 跑测试；提交**

Run: `npm run test:miniapp`　Expected: 全绿。
```bash
git commit -m "feat(miniapp/local-catalog): 打烊可预约三态（胶囊/通知/外送副标）+ delivery-slots 接口"
```

---

### Task 2: 结算按钮状态机加预约分支

**Files:**
- Modify: `apps/miniapp/utils/local-checkout-state.js`
- Modify: `tests/miniapp/local-checkout-state.test.cjs`

**Interfaces:**
- Produces：`checkoutAction(s)` 新增入参 `scheduleMode:'ASAP'|'SCHEDULED'`、`scheduleAvailable`、`closedNow`、`hasSlot`、`slotStale`；新文案 `TEXT.NO_SLOT='请选择送达时段'`、`TEXT.SLOT_STALE='时段已过，请重选'`、`TEXT.SUBMIT_SCHEDULED='预约下单'`；新 action `'slot'`。

- [ ] **Step 1: 改 `checkoutAction`**

`TEXT` 加三项。在 `if (st.blockReason) return …` 之前插入：
```js
  // ── 预约送达（2026-09-21 §5.2）。closedNow = 报价说此刻非营业时间：
  //    预约关着 → 交给 blockReason 走老路（页面已把 nextOpenText 写进 blockReason）；
  //    预约开着 → 不阻塞，但只能预约：尽快模式下按钮就是「请选择送达时段」
  var sched = st.scheduleMode === 'SCHEDULED'
  if (st.closedNow && st.scheduleAvailable && !sched) return result(true, TEXT.NO_SLOT, 'pending', 'slot')
```
在 `if (!st.hasTableware)` 之前（报价有效之后）插入：
```js
  if (sched) {
    if (st.slotStale) return result(false, TEXT.SLOT_STALE, 'ready', 'slot')
    if (!st.hasSlot) return result(true, TEXT.NO_SLOT, 'ready', 'slot')
  }
```
把最后三处 `TEXT.SUBMIT` 改成 `(sched ? TEXT.SUBMIT_SCHEDULED : TEXT.SUBMIT)`（`benefitsLoading`、`submitting` 保持原文案「提交中」不变，仅 `SUBMIT` 那一处按模式切换；`benefitsLoading` 分支也切换）。

- [ ] **Step 2: 测试**（追加）

```js
test('预约：未选格禁用「请选择送达时段」/ 格失效可点「时段已过，请重选」/ 选好格「预约下单」', () => {
  assert.deepEqual(checkoutAction(on({ scheduleMode: 'SCHEDULED', hasSlot: false })), { disabled: true, text: '请选择送达时段', amountState: 'ready', action: 'slot' })
  assert.deepEqual(checkoutAction(on({ scheduleMode: 'SCHEDULED', hasSlot: true, slotStale: true })), { disabled: false, text: '时段已过，请重选', amountState: 'ready', action: 'slot' })
  assert.deepEqual(checkoutAction(on({ scheduleMode: 'SCHEDULED', hasSlot: true })), { disabled: false, text: '预约下单', amountState: 'ready', action: 'submit' })
})
test('打烊：预约关 → 走 blockReason 阻塞；预约开且尽快模式 → 「请选择送达时段」', () => {
  assert.deepEqual(checkoutAction(on({ closedNow: true, scheduleAvailable: false, blockReason: '明天 09:00 营业' })), { disabled: true, text: '暂不可配送', amountState: 'blocked', action: 'none' })
  assert.deepEqual(checkoutAction(on({ closedNow: true, scheduleAvailable: true, scheduleMode: 'ASAP' })), { disabled: true, text: '请选择送达时段', amountState: 'pending', action: 'slot' })
})
test('不传新字段：八种旧结果逐字节一致', () => {
  assert.deepEqual(checkoutAction(on({})), { disabled: false, text: '提交订单', amountState: 'ready', action: 'submit' })
  assert.deepEqual(checkoutAction(on({ hasTableware: false })), { disabled: false, text: '请选择餐具', amountState: 'ready', action: 'tableware' })
})
```

- [ ] **Step 3: 跑测试；提交**
```bash
git commit -m "feat(miniapp/checkout-state): 结算按钮加预约分支（选格/失效/预约下单/打烊只能预约）"
```

---

### Task 3: `slot-picker` 组件（从自取页抽出）

**Files:**
- Create: `apps/miniapp/components/slot-picker/index.{js,wxml,wxss,json}`
- Modify: `apps/miniapp/pages/local/pickup.wxml`（第 141–166 行的弹层整块换成组件）、`pickup.wxss`（`.sheet-*`、`.day-*`、`.slot-grid*`、`.slot-cell*` 样式挪进组件）、`pickup.json`（`usingComponents` 加 `slot-picker`）
- Test: `tests/miniapp/pickup-page.test.cjs`（不改，必须仍绿）

**Interfaces:**
- 组件属性：`show:Boolean`、`title:String`（默认「选择取餐时间」）、`days:Array`、`activeDay:Number`、`selectedStartAt:String`（空串 = 未选）。事件：`daychange {idx}`、`select {idx}`（当天格的下标）、`close`。
- 组件**不持有选择状态**，只画：谁选中由 `selectedStartAt` 决定，点格子抛 `select`，页面自己 `decorateSlot` 并 `setData`——这样 `pickup.js` 的 `selectDay/selectSlot/closePicker` 一行不改，只是从 `bindtap` 变成 `bind:daychange/bind:select/bind:close` 的事件入口。

- [ ] **Step 1: 组件**

`index.js`：
```js
// 时段弹层（今天/明天页签 + 格子）。自取与预约外送共用；无状态，选择权在页面。
Component({
  options: { addGlobalClass: true },
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '选择取餐时间' },
    days: { type: Array, value: [] },
    activeDay: { type: Number, value: 0 },
    selectedStartAt: { type: String, value: '' },
  },
  methods: {
    noop: function() {},
    onClose: function() { this.triggerEvent('close') },
    onDay: function(e) { this.triggerEvent('daychange', { idx: Number(e.currentTarget.dataset.idx) || 0 }) },
    onSlot: function(e) { this.triggerEvent('select', { idx: Number(e.currentTarget.dataset.idx) }) },
  },
})
```
`index.wxml`：照抄 pickup.wxml 第 141–166 行的结构，`bindtap` 改成 `onClose/onDay/onSlot`，`selected && selected.startAt === item.startAt` 改成 `selectedStartAt === item.startAt`，标题用 `{{title}}`。`index.json`：`{ "component": true }`。样式原样搬。

- [ ] **Step 2: 自取页改用**

`pickup.wxml` 弹层换成：
```xml
<slot-picker show="{{pickerOpen}}" title="选择取餐时间" days="{{days}}" active-day="{{activeDay}}" selected-start-at="{{selected ? selected.startAt : ''}}"
  bind:daychange="selectDay" bind:select="selectSlot" bind:close="closePicker" />
```
`pickup.js` 只改两处（授权范围已限定）：`selectDay` 与 `selectSlot` 里读下标的表达式改为
```js
var idx = Number((e.detail && e.detail.idx != null) ? e.detail.idx : (e.currentTarget && e.currentTarget.dataset.idx))
```
（`selectDay` 原来 `|| 0` 兜底保留）。其余函数、`data`、`loadSlots`、`recompute` 一字不动。

- [ ] **Step 3: 跑 `npm run test:miniapp`（`pickup-page.test.cjs` 必须仍绿）；预览工具打开自取页看弹层；提交**
```bash
git commit -m "refactor(miniapp): 时段弹层抽成 slot-picker 组件，自取页改用（行为不变）"
```

---

### Task 4: 同城结算页

**Files:**
- Modify: `apps/miniapp/pages/local/confirm.js` / `.wxml` / `.wxss` / `.json`
- Create: `tests/miniapp/confirm-page.test.cjs`

**Interfaces:**
- Consumes：Task 1–3。
- 页面新 data：`scheduleMode:'ASAP'`、`scheduleAvailable:false`、`closedNow:false`、`slotDays:[]`、`slotActiveDay:0`、`slotSelected:null`（`{startAt,endAt,label,dayLabel,text}`）、`slotStale:false`、`slotsLoading:false`、`slotsError:''`、`hasAnySlot:false`、`pickerOpen:false`。

- [ ] **Step 1: 报价成功分支**（`refreshQuote` 的 `.then`）

把 `else if (!quote.isOpen) { … blockReason … }` 改成：
```js
        } else if (!quote.isOpen && !scheduleAvailable) {
          patch.blockReason = quote.nextOpenText || '当前非营业时间'
          patch.quoteToken = null
          patch.payAmount = null
        } else if (!quote.inRange) {
```
其中 `var scheduleAvailable = !!(self.data.meta && self.data.meta.delivery && self.data.meta.delivery.scheduleEnabled)` 在 `.then` 开头算；并在成功（非阻塞）分支末尾加：
```js
          patch.closedNow = !quote.isOpen
          patch.scheduleAvailable = scheduleAvailable
          // 打烊只能预约：自动切到预约并预选最早格（S8）；营业中保持顾客当前选择
          if (!quote.isOpen) patch.scheduleMode = 'SCHEDULED'
```
`setData(patch)` 之后：`if (patch.scheduleMode === 'SCHEDULED' || self.data.scheduleMode === 'SCHEDULED') self.loadSlots(quote.distanceM, !quote.isOpen)`（第二参 = 是否自动预选最早格）。

`getHeadNotice(quote)` 改为：`if (!quote.isOpen) return scheduleAvailable ? { text: '本单为预约配送' + (nextOpen ? '，' + nextOpen : ''), blocking: false } : { text: quote.nextOpenText || '当前非营业时间', blocking: true }`——把 `scheduleAvailable` 作为第二参传入，`loadMeta` 里调用处同样传。

- [ ] **Step 2: 时段拉取与失效**

```js
  // 时段依赖报价距离：只在报价成功后拉；换地址/改数量会先 invalidateCheckout 把已选格清掉
  loadSlots: function(distanceM, autoPick) {
    var self = this
    var seq = (this._slotSeq = (this._slotSeq || 0) + 1)
    this.setData({ slotsLoading: true, slotsError: '' })
    getDeliverySlots(distanceM).then(function(view) {
      if (seq !== self._slotSeq) return
      var days = (view.days || []).map(function(d) {
        var dt = st.pickupDateText(d.date)
        return { date: d.date, label: d.label, monthDay: dt.monthDay, dateText: dt.monthDay + ' ' + dt.weekday, slots: d.slots || [], empty: !(d.slots && d.slots.length) }
      })
      var hasAny = days.some(function(d) { return !d.empty })
      var patch = { slotDays: days, slotsLoading: false, hasAnySlot: hasAny }
      if (view.blocked) {
        patch.slotSelected = null; patch.slotStale = false
        patch.scheduleAvailable = false
        // 预约这一刻不可用（关了/休业/暂停）：打烊时退回老的阻塞文案
        if (self.data.closedNow) patch.blockReason = view.blocked.text || (self.data.quote && self.data.quote.nextOpenText) || '当前非营业时间'
      } else if (self.data.slotSelected) {
        patch.slotStale = !st.slotOffered(view, self.data.slotSelected.startAt)
      } else if (autoPick) {
        var first = st.firstSlot(view)
        if (first) { patch.slotSelected = decorateSlot(first.slot, days[first.dayIndex]); patch.slotActiveDay = first.dayIndex }
      } else {
        var f = st.firstSlot(view); patch.slotActiveDay = f ? f.dayIndex : 0
      }
      self.setData(patch); self.syncAction()
    }).catch(function(err) {
      if (seq !== self._slotSeq) return
      self.setData({ slotsLoading: false, slotsError: (err && err.message) || '时段获取失败', hasAnySlot: false }); self.syncAction()
    })
  },
```
（`st = require('../../utils/pickup-checkout-state')` 复用 `firstSlot/slotOffered/pickupDateText`；`decorateSlot` 照抄自取页那 5 行。）`invalidateCheckout` 里加 `slotSelected: null, slotStale: false`。`onShow` 里若 `scheduleMode==='SCHEDULED'` 且有 `quote` → `loadSlots(quote.distanceM, false)`（回来时重拉，已选格不在就标 stale）。

- [ ] **Step 3: 模式切换与弹层**

```js
  pickMode: function(e) {
    var mode = e.currentTarget.dataset.mode
    if (mode === 'ASAP' && this.data.closedNow) return      // 打烊置灰
    if (mode === this.data.scheduleMode) return
    this.setData({ scheduleMode: mode })
    if (mode === 'SCHEDULED' && this.data.quote && this.data.quote.distanceM != null) this.loadSlots(this.data.quote.distanceM, false)
    if (mode === 'SCHEDULED') this.openPicker()
    this.syncAction()
  },
  openPicker: function() { if (this.data.hasAnySlot) this.setData({ pickerOpen: true }) },
  closePicker: function() { this.setData({ pickerOpen: false }) },
  onSlotDay: function(e) { this.setData({ slotActiveDay: e.detail.idx }) },
  onSlotPick: function(e) {
    var day = this.data.slotDays[this.data.slotActiveDay]; var slot = day && day.slots[e.detail.idx]
    if (!slot) return
    this.setData({ slotSelected: decorateSlot(slot, day), slotStale: false, pickerOpen: false })
    this._clientRequestId = newClientRequestId()   // 换了时段就是另一张单
    this.syncAction()
  },
```
`syncAction` 传入：`scheduleMode, scheduleAvailable, closedNow, hasSlot: !!d.slotSelected, slotStale: d.slotStale`。`onSubmit` 加：`if (act.action === 'slot') { this.openPicker(); return }`。

- [ ] **Step 4: 提交与错误**

`doSubmit` 的 `createOrder({...})` 加 `scheduledAt: this.data.scheduleMode === 'SCHEDULED' && this.data.slotSelected ? this.data.slotSelected.startAt : undefined`；前置守卫加 `if (this.data.scheduleMode === 'SCHEDULED' && (!this.data.slotSelected || this.data.slotStale)) return`。
`handleSubmitError` 加：
```js
    if (code === 42291) {   // 时段刚过期/被关：标失效、重拉，按钮变「时段已过，请重选」
      wx.showToast({ title: err.message || '该时段已不可选，请重新选择', icon: 'none', duration: 2500 })
      this.setData({ slotStale: true }); this.syncAction()
      if (this.data.quote) this.loadSlots(this.data.quote.distanceM, false)
      return
    }
    if (code === 42290) {   // 店主刚关了预约：退回尽快；打烊则变成老的阻塞
      this.setData({ scheduleAvailable: false, scheduleMode: 'ASAP', slotSelected: null })
      wx.showToast({ title: err.message || '预约配送暂未开通', icon: 'none', duration: 2500 })
      this.refreshQuote('retry'); return
    }
```
`42222`（立即单打烊）已在现有分支里。

- [ ] **Step 5: wxml / wxss / json**

`confirm.json` 的 `usingComponents` 加 `"slot-picker": "/components/slot-picker/index"`。
在「配送信息」卡之后插入：
```xml
  <view class="section card schedule-section" wx:if="{{quote && !quoting && !quoteError && !blockReason}}">
    <view class="section-title">送达时间</view>
    <view class="mode-row">
      <view class="mode-opt {{scheduleMode === 'ASAP' ? 'active' : ''}} {{closedNow ? 'disabled' : ''}}" bindtap="pickMode" data-mode="ASAP">
        <text class="mode-name">尽快送达</text>
        <text class="mode-sub">{{closedNow ? '已打烊' : quote.etaText}}</text>
      </view>
      <view class="mode-opt {{scheduleMode === 'SCHEDULED' ? 'active' : ''}} {{!scheduleAvailable ? 'disabled' : ''}}" bindtap="pickMode" data-mode="SCHEDULED">
        <text class="mode-name">预约时段</text>
        <text class="mode-sub">{{!scheduleAvailable ? '暂未开通' : (slotSelected ? slotSelected.text : '选择送达时段')}}</text>
      </view>
    </view>
    <view wx:if="{{scheduleMode === 'SCHEDULED'}}" class="slot-row" bindtap="openPicker">
      <text wx:if="{{slotsLoading && !slotSelected}}" class="slot-muted">正在获取可选时段…</text>
      <text wx:elif="{{slotsError}}" class="slot-error">{{slotsError}}</text>
      <text wx:elif="{{slotSelected}}" class="slot-text {{slotStale ? 'slot-stale' : ''}}">预计 {{slotSelected.text}} 送达<text wx:if="{{slotStale}}" class="slot-stale-tip"> 该时段已过，请重选</text></text>
      <text wx:elif="{{hasAnySlot}}" class="slot-muted">请选择送达时段 ›</text>
      <text wx:else class="slot-muted">暂无可选时段</text>
    </view>
  </view>
```
配送信息卡里两行 `arrival-time`（「约 N 分钟送达」与「备餐从商家接单开始计时…」）加 `wx:if="{{scheduleMode !== 'SCHEDULED'}}"`。文件末尾加 `<slot-picker show="{{pickerOpen}}" title="选择送达时间" days="{{slotDays}}" active-day="{{slotActiveDay}}" selected-start-at="{{slotSelected ? slotSelected.startAt : ''}}" bind:daychange="onSlotDay" bind:select="onSlotPick" bind:close="closePicker" />`。
头条：`headNotice` 非阻塞时用 `head-notice-soft` 样式（组件里已有同名 class，页面 wxss 加一份）。wxss：`.mode-row{display:flex;gap:16rpx} .mode-opt{flex:1;border:2rpx solid var(--line);border-radius:12rpx;padding:18rpx;text-align:center} .mode-opt.active{border-color:var(--brand);background:var(--brand-soft)} .mode-opt.disabled{opacity:.45} .mode-name{display:block;font-weight:600} .mode-sub{display:block;font-size:22rpx;color:var(--text-3);margin-top:6rpx}` + `.slot-*` 沿用自取页那几条。

- [ ] **Step 6: 页面级行为锁 `tests/miniapp/confirm-page.test.cjs`**（夹具照抄 `pickup-page.test.cjs` 的 `loadPage/makeCtx`；mock `api/local` 的 `quoteLocal/getLocalMeta/getDeliverySlots` 与 `api/cart`、`api/address`、`api/order`）

用例：① `isOpen:false` + `meta.delivery.scheduleEnabled:true` → 报价后 `data.scheduleMode==='SCHEDULED'`、`data.blockReason===''`、`data.slotSelected.startAt` 等于 mock 时段第一格、`data.action.text==='预约下单'`；② `isOpen:true` → `scheduleMode==='ASAP'`、`getDeliverySlots` 未被调用；③ `isOpen:false` + `scheduleEnabled:false` → `blockReason` 为 `nextOpenText`、`action.amountState==='blocked'`；④ 选好格后调用 `invalidateCheckout('address')` → `slotSelected===null`；⑤ `createOrder` 返回 `{code:42291}` → `slotStale===true` 且 `getDeliverySlots` 再次被调用；⑥ 提交时 `createOrder` 收到的 `scheduledAt` 等于所选格 `startAt`。

- [ ] **Step 7: 跑测试；预览工具看营业中/打烊两种结算页；提交**
```bash
git commit -m "feat(miniapp/confirm): 同城结算页送达时间卡（尽快/预约）、打烊强制预约、时段拉取与失效、提交带 scheduledAt"
```

---

### Task 5: 主页/分类页组件与购物车条

**Files:**
- Modify: `apps/miniapp/components/local-store-header/index.js`（胶囊 `tone:'schedule'` 的 class `status-pill-schedule`，wxss 加蓝色调；通知非阻塞时不渲染出路按钮——现有 `noticeBlocking` 已控制）与 `index.wxss`
- Modify: `apps/miniapp/components/local-mode-bar/index.js` / `index.wxml`（`deliveryHint: localCatalog.deliveryModeHint(meta)`，「外送」标签下同自取的 `mode-sub` 渲染）
- Modify: `apps/miniapp/components/local-cart-bar/index.js`（`recompute` 里 `text` 的外送文案：`deliveryScheduleOnly(meta) ? '去结算 · 预约外送' : '去结算 · 外送'`；`blocking` 属性由页面传，主页在 `deliveryScheduleOnly` 时 `headNoticeOf` 已返回 `blocking:false`，不需改页面脚本）
- Modify: `apps/miniapp/pages/local/index.wxml`、`pages/product/list.wxml`（若两页把 `notice.blocking` 之外的东西传给了购物车条，核对一遍；预期零改动）

- [ ] 改动、`npm run test:miniapp`、预览工具看主页三态、提交
```bash
git commit -m "feat(miniapp/local-home): 打烊可预约的胶囊/通知/切换栏副标/购物车条文案"
```

---

### Task 6: 订单详情与列表

**Files:**
- Create: `apps/miniapp/utils/schedule-order.js`
- Create: `tests/miniapp/schedule-order.test.cjs`
- Modify: `apps/miniapp/pages/order/detail.js` / `.wxml` / `.wxss`、`pages/order/list.js` / `.wxml`、`components/order-status-tag/index.js`

**Interfaces（`utils/schedule-order.js`，ES5，纯函数）：**
```js
/** 详情顶部横幅：「预约配送 · 明天 12:00–12:30 送达」；非预约单返回 '' */
function scheduleBannerText(order)            // 读 order.schedule.slotLabel
/** 时间线「已付款」步的 extra：接单前「商家将在 HH:mm 前确认」；接单后「商家已确认，HH:mm 开始备餐」；非预约单 '' */
function schedulePaidExtra(order, fmtHHmm)    // 读 schedule.acceptDueAt / prepStartAt，fmtHHmm 由调用方传 utils/time 的
/** 状态标签：预约单 PAID → 「已预约」；其余 null（沿用原表） */
function scheduleStatusLabel(order)
/** 取消卡文案：两小时外「HH:mm 前可直接取消」；两小时内且未备好「可申请取消，商家确认后全额退款」；已备好「餐品已在准备…」；非预约单 '' */
function scheduleCancelCopy(order, fmtHHmm)   // 读 canSelfCancel / canRequestCancel / schedule.selfCancelUntil / schedule.readyAt
/** 列表卡标签：预约单 '同城 · 预约'，否则 null */
function scheduleTypeLabel(order)             // 读 order.scheduledAt
```

- [ ] **Step 1: 写纯函数 + 测试**（每个函数至少两条：预约单 / 非预约单；`schedulePaidExtra` 接单前后各一条；`scheduleCancelCopy` 三段各一条）

- [ ] **Step 2: 详情页**

`detail.js` 的 `decorateOrder`：`statusLabel` 先问 `scheduleStatusLabel`；新增 `scheduleBanner: scheduleBannerText(order)`、`scheduleCancelCopy: scheduleCancelCopy(order, timeUtil.fmtHHmm)`；`buildLocalTimeline` 里「支付成功」与「商家接单」两步的 `extra` 用 `schedulePaidExtra`；`estimatedDeliveryText` 对预约单改为 `order.schedule.slotLabel + ' 送达'`，`estimatedDeliveryHint` 为 `''`。`detail.wxml`：状态横幅下加 `<view class="schedule-banner" wx:if="{{order.scheduleBanner}}">{{order.scheduleBanner}}</view>`；取消卡的 `local-cancel-copy` 对预约单显示 `scheduleCancelCopy`（优先于 `graceMin` 那两行）。按钮不改（`canSelfCancel/canRequestCancel` 来自服务端）。

- [ ] **Step 3: 列表与状态标签**

`list.js` 的 `typeLabel`：`scheduleTypeLabel(order) || TYPE_META[...].label`；`order-status-tag` 加属性 `scheduled:Boolean`，PAID 且 scheduled → 「已预约」；列表与详情传 `scheduled="{{!!order.scheduledAt}}"`。

- [ ] **Step 4: 跑测试；预览工具看详情；提交**
```bash
git commit -m "feat(miniapp/order): 预约单详情横幅/时间线/取消文案/状态与列表标签"
```

---

### Task 7: 人工验收

- [ ] 预览工具（`npm run preview:miniapp`）+ 本地 API（`SCHEDULER_DISABLED=true` + mock）走验收标准 3 的每一条，截图存 `docs/superpowers/notes/2026-09-2x-scheduled-delivery-batch2-acceptance/`。
- [ ] 微信开发者工具真机预览：打烊时段完整走一遍到支付（mock 支付）。店主验收。
- [ ] `bash scripts/e2e.sh`（干净库，`TZ=Asia/Shanghai`）确认「失败 0」（本批不改服务端，只是护栏）。

---

## 执行后交接

- 复核（M 级 Sonnet，新会话）只给：spec §5、本计划 §3.1 六栏、Global Constraints、BASE、`git diff BASE`、未跟踪文件清单、执行者「验证」栏原文、「偏离方案」的「改了什么」。
- 交付报告须写：范围检查是否可运行；**发布顺序**：小程序须过微信审核后发布，服务端与后台已在 main，店主在后台打开 `schedule.enabled` 即对顾客可见；未过审前顾客端仍只有「尽快送达」。
- 小程序发布记忆：改小程序必须合 main（开发者工具读主仓磁盘）。
