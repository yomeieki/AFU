# 同城「到店自取」批次二：小程序顾客端 —— 实施计划

> **工序 00 规划 · 模型 fable。** 按「模型分工协议」：改动等级 **L**（跨页面/组件/工具层，接入下单与支付流程），链路 `fable → sonnet → opus → fable → haiku`。
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**原始需求**：`docs/superpowers/specs/2026-09-11-local-pickup-design.md` §5（小程序）与 §4.10 里「关于」页改读服务端营业时间。批次一（服务端，已在本分支落地、e2e 1610/0）提供的接口见批次一计划末尾「交给批次二/三的接口清单」与 `docs/api.md` 附录 H。

**Goal:** 顾客在同城渠道里能切到「自取」、看到自取规则、选时段、填手机号、享自取优惠下单付款，并在订单列表/详情里看到自取单的正确状态与取餐信息；外送与邮寄两条链路逐字节不变。

**Architecture:** 同城渠道下新增子状态 `localMode: 'DELIVERY'|'PICKUP'`（内存权威值在 `app.globalData`，storage 只做恢复，与 `shoppingChannel` 同款）。`utils/local-catalog.js` 的三段判断加 `mode` 参数成为唯一的模式判定处；新增 `components/local-mode-bar`（切换栏）与 `pages/local/pickup`（自取结算页），后者的按钮状态机抽成纯函数 `utils/pickup-checkout-state.js`。订单列表/详情按 `deliveryType==='PICKUP'` 加分支。

**Tech Stack:** 微信原生小程序（WXML/WXSS/JS）。**新增的 js 文件必须是 ES5**（`node scripts/check-miniapp-es5.mjs <file>` 把关：无 const/let、无箭头函数、无模板字符串、无简写属性）；既有文件沿用其原有写法。单测用 `node --test tests/miniapp/*.test.cjs`（`npm run test:miniapp`），页面模块用 `Page/Component/getApp/wx` 桩加载，桩的写法照抄 `tests/miniapp/cart-channel.test.cjs` 的 `loadPage/makeCtx`。

## 未决歧义（执行方按「默认」做，店主不同意再改）

1. 切换栏上每个标签下要不要带一行小字状态（「可预约」「暂停接单」）。**默认**：带，与页头胶囊同一套 `storeStatusOf` 判定，休业时两侧都灰。
2. 自取结算页的「一键取微信手机号」。**默认**：不做（spec §10 二期），手填 + 记住上次。
3. 顾客端预览小计算的自取优惠与服务端可能因四舍五入差 1 分。**默认**：客户端公式与服务端 `pickupDiscountOf` 逐字相同（`subtotal − round(subtotal × value / 100)`），以服务端返回为准，页面不做差额校验。

## Global Constraints

- 模式值只有 `'DELIVERY' | 'PICKUP'`；归一化只在 `utils/channel.js` 一处。渠道值仍只有 `'EXPRESS' | 'LOCAL'`，自取单请求商品/购物车/券一律 `channel=LOCAL`。
- 自取结算页提交的请求体：`{ cartItemIds, deliveryType:'PICKUP', pickupAt, pickupContact:{ name?, phone }, remark?, couponId?, gifts?, clientRequestId }`——**不传 `addressId`、不传 `quoteToken`**。
- 自取金额口径与服务端一致：`小计 → 自取优惠 → 券（封顶到 小计−自取优惠）→ 实付`，运费恒 0；显示顺序「商品金额 / 自取优惠 / 优惠券 / 积分赠品 / 应付金额」。
- 手机号校验 `^1\d{10}$`；`pickupAt` 必须是时段接口返回的某格 `startAt` 原串。
- 订阅授权：自取页只请求 `subscribeTemplates.pickup`（老字段 `subscribeTemplateIds` 作兜底）。
- 外送/邮寄链路零改动原则：`pages/local/confirm`、`pages/order/confirm` 一行不动；`storeStatusOf/headNoticeOf/checkoutStateOf` 不传 `mode` 时行为逐字节一致。
- 每个 Task 结束前 `npm run test:miniapp` 全绿；新增 js 文件过 ES5 检查。
- 不改服务端（`apps/server`）、不改后台（`apps/admin`）。

## 允许修改的文件白名单

```
apps/miniapp/app.js
apps/miniapp/app.json                                       （注册新页面）
apps/miniapp/utils/channel.js
apps/miniapp/utils/local-catalog.js
apps/miniapp/utils/pickup-checkout-state.js                （新建）
apps/miniapp/api/local.js
apps/miniapp/api/order.js
apps/miniapp/components/local-mode-bar/{index.js,index.wxml,index.wxss,index.json}（新建）
apps/miniapp/components/local-store-header/{index.js,index.wxml,index.wxss}
apps/miniapp/components/local-cart-bar/index.js
apps/miniapp/components/order-status-tag/index.js
apps/miniapp/pages/index/{index.js,index.wxml,index.json}
apps/miniapp/pages/product/{list.js,list.wxml,list.json}
apps/miniapp/pages/cart/{index.js,index.wxml}
apps/miniapp/pages/local/pickup.{js,wxml,wxss,json}          （新建）
apps/miniapp/pages/order/{list.js,list.wxml,list.wxss,detail.js,detail.wxml,detail.wxss}
apps/miniapp/pages/about/{index.js,index.wxml}
tests/miniapp/channel.test.cjs
tests/miniapp/local-catalog.test.cjs
tests/miniapp/cart-channel.test.cjs
tests/miniapp/channel-pages.test.cjs
tests/miniapp/navigation.test.cjs
tests/miniapp/order-channel.test.cjs
tests/miniapp/pickup-checkout-state.test.cjs                （新建）
tests/miniapp/local-mode.test.cjs                           （新建）
docs/miniapp-release-checklist.md
```

## 上报触发条件（执行方必须停下）

- 需要改白名单外的任何文件，尤其 `pages/local/confirm.*`、`pages/order/confirm.*`、`utils/request.js`、`apps/server/**`。
- 服务端某个字段与 `docs/api.md` 附录 H 不符（例如 `/local/meta` 没有 `pickup` 节）——那是批次一的缺口，要回规划方。
- 既有单测由绿转红且原因不是「断言按新契约更新」。
- 页面需要一个组件而该组件不在白名单里。

## 验收标准（只在这里定义，后续工序不得增删）

| # | 跑什么 | 期望 |
|---|---|---|
| B1 | `npm run test:miniapp` | 全部通过，含新增 `pickup-checkout-state`、`local-mode` 两个文件 |
| B2 | `node scripts/check-miniapp-es5.mjs apps/miniapp/utils/pickup-checkout-state.js apps/miniapp/components/local-mode-bar/index.js apps/miniapp/pages/local/pickup.js` | 全部 ES5 ✔ |
| B3 | `git diff main...HEAD --stat -- apps/miniapp/pages/local/confirm.js apps/miniapp/pages/local/confirm.wxml apps/miniapp/pages/order/confirm.js` | 无改动 |
| B4 | `grep -n "deliveryType: 'PICKUP'" apps/miniapp/pages/local/pickup.js` 与 `grep -n "addressId\|quoteToken" apps/miniapp/pages/local/pickup.js` | 前者 ≥1 处；后者 0 处 |
| B5 | `grep -c "pages/local/pickup" apps/miniapp/app.json` | 1 |
| B6 | 微信开发者工具（店主/控制方手工）：同城主页与分类页出现「外送 / 自取」栏；切自取 → 购物车条「去结算 · 自取」→ 结算页能选时段、填手机号、看到自取优惠行、提交并拉起（mock）支付；订单详情显示「尾号 · 时段」与门店卡；「关于」页营业时间来自后台 | 清单逐项 ✔（见 §手工验收） |
| B7 | `grep -rn "getLocalMode\|setLocalMode" apps/miniapp/pages apps/miniapp/components` | 每处读模式都经 `app.getLocalMode()`，不直接读 storage |

---

### Task 1: 模式上下文与三段判断加 `mode`

**Files:**
- Modify: `apps/miniapp/utils/channel.js`
- Modify: `apps/miniapp/app.js`
- Modify: `apps/miniapp/utils/local-catalog.js`（整文件替换）
- Test: `tests/miniapp/channel.test.cjs`、`tests/miniapp/local-catalog.test.cjs`

**Interfaces:**
- Produces（`utils/channel.js`）：`MODE_STORAGE_KEY`、`normalizeLocalMode(v)`、`getLocalMode()`、`setLocalMode(v)`。
- Produces（`app.js`）：`globalData.localMode`、`getLocalMode()`、`setLocalMode(v)`。
- Produces（`utils/local-catalog.js`）：`storeStatusOf(meta, mode?)`、`headNoticeOf(meta, mode?)`、`checkoutStateOf(meta, count, amount, blocking, mode?)`、`minOrderOf(meta, mode?)`、`pickupRulesText(meta)`、`modeAvailable(meta, mode)`、`altModeOf(meta, mode)`、`resolveLocalMode(meta, current)`、`holidayText(meta)`；`summarizeCart` 不变。

- [ ] **Step 1: 先写失败的测试**。`tests/miniapp/channel.test.cjs` 末尾追加：

```js
test('同城子模式：只认 PICKUP，其余一律 DELIVERY；落盘失败不抛', function () {
  const channel = load({
    getStorageSync: function () { return 'PICKUP' },
    setStorageSync: function () { throw new Error('quota') },
  })
  assert.equal(channel.getLocalMode(), 'PICKUP')
  assert.equal(channel.normalizeLocalMode('WHATEVER'), 'DELIVERY')
  assert.equal(channel.setLocalMode('PICKUP'), 'PICKUP')
  assert.equal(channel.MODE_STORAGE_KEY, 'localMode')
})
test('storage 读模式抛错时回落 DELIVERY', function () {
  const channel = load({ getStorageSync: function () { throw new Error('boom') } })
  assert.equal(channel.getLocalMode(), 'DELIVERY')
})
```

`tests/miniapp/local-catalog.test.cjs` 末尾追加：

```js
const { minOrderOf, pickupRulesText, resolveLocalMode, altModeOf, modeAvailable, holidayText } =
  require('../../apps/miniapp/utils/local-catalog')
const PK = Object.assign({}, OPEN, {
  closedKind: 'OPEN',
  pickup: { enabled: true, paused: null, minOrderAmountFen: 1500, discountText: '自取享 9.5 折', slotMinutes: 30 },
  store: { name: '阿福凉菜', district: '自流井区', address: '丹桂40栋底楼', latE6: 1, lngE6: 2 },
})

test('不传 mode 时三段判断与改前逐字节一致', function () {
  assert.deepEqual(storeStatusOf(OPEN), { tone: 'open', label: '营业中' })
  assert.deepEqual(headNoticeOf({ enabled: false }), { text: '同城配送即将开通', blocking: true })
  assert.deepEqual(checkoutStateOf(OPEN, 1, 3000, false), { gap: 1000, disabled: true, text: '还差 ¥10.00 起送' })
})

test('自取模式的店头状态与通知：未开通 / 暂停 / 可预约；营业时间外不阻塞', function () {
  assert.deepEqual(storeStatusOf(PK, 'PICKUP'), { tone: 'open', label: '可预约' })
  assert.deepEqual(headNoticeOf(PK, 'PICKUP'), { text: '', blocking: false })
  assert.deepEqual(headNoticeOf(Object.assign({}, PK, { closedKind: 'CLOSED' }), 'PICKUP'),
    { text: '当前非营业时间，可预约后续时段', blocking: false })
  const off = Object.assign({}, PK, { pickup: Object.assign({}, PK.pickup, { enabled: false }) })
  assert.deepEqual(storeStatusOf(off, 'PICKUP'), { tone: 'closed', label: '暂未开通' })
  assert.deepEqual(headNoticeOf(off, 'PICKUP'), { text: '到店自取暂未开通', blocking: true })
  const paused = Object.assign({}, PK, { pickup: Object.assign({}, PK.pickup, { paused: { reason: '后厨忙' } }) })
  assert.deepEqual(storeStatusOf(paused, 'PICKUP'), { tone: 'paused', label: '暂停接单' })
  assert.deepEqual(headNoticeOf(paused, 'PICKUP'), { text: '自取暂停接单：后厨忙', blocking: true })
})

test('休业：两种模式都灰、都阻塞、文案带恢复日期', function () {
  const h = Object.assign({}, PK, { holiday: { until: '2026-10-08', reason: '国庆' } })
  assert.equal(holidayText(h), '休息中，10月08日恢复')
  assert.deepEqual(storeStatusOf(h, 'DELIVERY'), { tone: 'closed', label: '休息中' })
  assert.deepEqual(storeStatusOf(h, 'PICKUP'), { tone: 'closed', label: '休息中' })
  assert.deepEqual(headNoticeOf(h, 'PICKUP'), { text: '休息中，10月08日恢复', blocking: true })
  assert.deepEqual(headNoticeOf(h, 'DELIVERY'), { text: '休息中，10月08日恢复', blocking: true })
  assert.equal(holidayText(Object.assign({}, PK, { holiday: { until: null, reason: '' } })), '休息中')
})

test('起送线按模式取：自取看 pickup.minOrderAmountFen，外送看 fee.minOrderAmount', function () {
  assert.equal(minOrderOf(PK, 'PICKUP'), 1500)
  assert.equal(minOrderOf(PK, 'DELIVERY'), 4000)
  assert.deepEqual(checkoutStateOf(PK, 1, 1000, false, 'PICKUP'), { gap: 500, disabled: true, text: '还差 ¥5.00 起送' })
  assert.deepEqual(checkoutStateOf(PK, 1, 1500, false, 'PICKUP'), { gap: 0, disabled: false, text: '去结算' })
})

test('自取规则行：折扣 · 起送 · 门店地址；缺 pickup 节为空串', function () {
  assert.equal(pickupRulesText(PK), '自取享 9.5 折 · 满 ¥15 起 · 自流井区丹桂40栋底楼')
  assert.equal(pickupRulesText(OPEN), '')
})

test('模式回落：外送关自取开 → PICKUP；自取关外送开 → DELIVERY；都开尊重当前值', function () {
  assert.equal(resolveLocalMode(Object.assign({}, PK, { enabled: false }), 'DELIVERY'), 'PICKUP')
  assert.equal(resolveLocalMode(Object.assign({}, PK, { pickup: Object.assign({}, PK.pickup, { enabled: false }) }), 'PICKUP'), 'DELIVERY')
  assert.equal(resolveLocalMode(PK, 'PICKUP'), 'PICKUP')
  assert.equal(resolveLocalMode(null, 'PICKUP'), 'PICKUP')
})

test('替代出路：本侧阻塞时给另一侧，另一侧也不可用时给 null', function () {
  assert.equal(modeAvailable(PK, 'PICKUP'), true)
  assert.equal(altModeOf(Object.assign({}, PK, { paused: { reason: '骑手不够' } }), 'DELIVERY'), 'PICKUP')
  assert.equal(altModeOf(Object.assign({}, PK, { holiday: { until: null, reason: '' } }), 'DELIVERY'), null)
  assert.equal(altModeOf(Object.assign({}, PK, { pickup: Object.assign({}, PK.pickup, { enabled: false }) }), 'PICKUP'), 'DELIVERY')
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `cd /Users/yumingyi/food-shop/.claude/worktrees/local-pickup && node --test tests/miniapp/channel.test.cjs tests/miniapp/local-catalog.test.cjs 2>&1 | tail -15`
Expected: 新用例失败（`getLocalMode is not a function` / `minOrderOf is not a function`）。

- [ ] **Step 3: `utils/channel.js`**。在 `module.exports` 之前加：

```js
// ── 同城子模式：外送 / 自取 ─────────────────────────────────
// 与 shoppingChannel 同一套约定：内存里 app.globalData.localMode 是权威值，
// storage 只在冷启动/热重载时补回来；读写失败都不抛（隐私模式、清缓存）。
var MODE_STORAGE_KEY = 'localMode'

function normalizeLocalMode(value) {
  return value === 'PICKUP' ? 'PICKUP' : 'DELIVERY'
}

function getLocalMode() {
  var raw = ''
  try {
    raw = wx.getStorageSync(MODE_STORAGE_KEY)
  } catch (err) {
    raw = ''
  }
  return normalizeLocalMode(raw)
}

function setLocalMode(value) {
  var mode = normalizeLocalMode(value)
  try {
    wx.setStorageSync(MODE_STORAGE_KEY, mode)
  } catch (err) {
    // 落盘失败不影响本次会话
  }
  return mode
}
```

`module.exports` 加四项：`MODE_STORAGE_KEY, normalizeLocalMode, getLocalMode, setLocalMode`。

- [ ] **Step 4: `app.js`**。`globalData` 加：

```js
    // 同城子模式 'DELIVERY' | 'PICKUP'。只对 LOCAL 渠道有意义；切到邮寄不清它，切回来还在。
    localMode: 'DELIVERY',
```

`onLaunch` 里 `this.globalData.shoppingChannel = channelUtil.getShoppingChannel()` 之后加 `this.globalData.localMode = channelUtil.getLocalMode()`。`getShoppingChannel()` 之后加两个方法：

```js
  getLocalMode() {
    return channelUtil.normalizeLocalMode(this.globalData.localMode)
  },
  // 定子模式：写内存 + 落盘。不动渠道、不清分类意图、不刷角标——两种模式共用同一个购物车。
  setLocalMode(value) {
    var mode = channelUtil.setLocalMode(value)
    this.globalData.localMode = mode
    return mode
  },
```

- [ ] **Step 5: `utils/local-catalog.js` 整文件替换**

```js
// 同城菜单的三段判断，抽成纯函数供主页、分类页、购物车页、购物车条共用。
//
// 为什么不各写一遍：这几处都要判「店头显示什么」「车里多少钱」「能不能去结算」。
// 各写一遍迟早有一边漏掉「暂停接单时也要挡住结算」——而那一边看上去完全正常，
// 只有顾客真按下「去结算」、走到服务端 42226 那一刻才炸。
//
// 2026-09-11 起同城有两种履约方式：外送（DELIVERY）与到店自取（PICKUP）。
// mode 参数缺省 DELIVERY，**不传时行为与改前逐字节一致**（tests/miniapp/local-catalog.test.cjs 钉住）。
// 自取读的是 /local/meta 的 pickup 节与 holiday 节；营业时间外自取**不阻塞**（可预约后续时段）。

var formatPrice = require('./format').formatPrice

function normMode(mode) {
  return mode === 'PICKUP' ? 'PICKUP' : 'DELIVERY'
}

function pickupMeta(meta) {
  return meta && meta.pickup ? meta.pickup : null
}

/** 「休息中，10月08日恢复」；until 为空只说「休息中」；无休业返回 '' */
function holidayText(meta) {
  var h = meta && meta.holiday
  if (!h) return ''
  return '休息中' + (h.until ? '，' + String(h.until).slice(5).replace('-', '月') + '日恢复' : '')
}

/**
 * 店头那颗状态胶囊。
 * 休业压过一切；自取看 pickup 节；外送沿用原判定（暂停优先于打烊，两段之间是午间休息）。
 * meta 还没回来时给「暂未营业」而不是空字符串——空胶囊是个视觉噪点，且会让人以为在营业。
 */
function storeStatusOf(meta, mode) {
  if (!meta) return { tone: 'closed', label: '暂未营业' }
  if (meta.holiday) return { tone: 'closed', label: '休息中' }
  if (normMode(mode) === 'PICKUP') {
    var pk = pickupMeta(meta)
    if (!pk || !pk.enabled) return { tone: 'closed', label: '暂未开通' }
    if (pk.paused) return { tone: 'paused', label: '暂停接单' }
    return { tone: 'open', label: '可预约' }
  }
  if (meta.paused) return { tone: 'paused', label: '暂停接单' }
  // 两段营业时间中间那段是「午间休息」，不是打烊（PO 2026-09-08）
  if (meta.enabled && !meta.isOpen && meta.closedKind === 'BREAK') return { tone: 'closed', label: '午间休息' }
  if (!meta.enabled || !meta.isOpen) return { tone: 'closed', label: '已打烊' }
  return { tone: 'open', label: '营业中' }
}

/**
 * 页头那条通知。只在**真的挡住下单**时 blocking，blocking 同时给结算态用。
 * 商品在暂停/打烊时仍可浏览、仍可加购（顾客常常先挑好等开门），挡的只是结算。
 * 自取在营业时间外给一条**不阻塞**的提示：顾客可以预约后续时段。
 */
function headNoticeOf(meta, mode) {
  if (!meta) return { text: '', blocking: false }
  if (meta.holiday) return { text: holidayText(meta), blocking: true }
  if (normMode(mode) === 'PICKUP') {
    var pk = pickupMeta(meta)
    if (!pk || !pk.enabled) return { text: '到店自取暂未开通', blocking: true }
    if (pk.paused) {
      return { text: '自取暂停接单' + (pk.paused.reason ? '：' + pk.paused.reason : ''), blocking: true }
    }
    if (meta.closedKind && meta.closedKind !== 'OPEN') return { text: '当前非营业时间，可预约后续时段', blocking: false }
    return { text: '', blocking: false }
  }
  if (!meta.enabled) return { text: '同城配送即将开通', blocking: true }
  if (meta.paused) {
    return {
      text: '暂停接单' + (meta.paused.reason ? '：' + meta.paused.reason : ''),
      blocking: true,
    }
  }
  if (!meta.isOpen) return { text: meta.nextOpenText || '当前非营业时间', blocking: true }
  return { text: '', blocking: false }
}

function summarizeCart(items) {
  return (items || []).reduce(function(summary, item) {
    summary.count += item.quantity || 0
    summary.amount += item.subtotal || 0
    return summary
  }, { count: 0, amount: 0 })
}

/** 起送线（分）：自取看 pickup.minOrderAmountFen，外送看 fee.minOrderAmount；缺则 0 */
function minOrderOf(meta, mode) {
  if (!meta) return 0
  if (normMode(mode) === 'PICKUP') {
    var pk = pickupMeta(meta)
    return pk ? (pk.minOrderAmountFen || 0) : 0
  }
  return meta.fee ? (meta.fee.minOrderAmount || 0) : 0
}

/**
 * 能不能去结算，以及按钮上写什么。
 * 差额一定要说出**具体数字**：顾客看到「还差 ¥15.00 起送」会回去加菜，
 * 看到一句「未达起送」只会直接退出去。
 * 业务阻塞（未开通/暂停/打烊/休业）优先于起送线——加满也不能结，措辞不能误导成「再加点就行」。
 */
function checkoutStateOf(meta, count, amount, blocking, mode) {
  var minimum = minOrderOf(meta, mode)
  var gap = Math.max(0, minimum - amount)
  var disabled = !meta || !!blocking || count <= 0 || gap > 0
  var text = gap > 0 ? '还差 ¥' + formatPrice(gap) + ' 起送' : '去结算'
  if (blocking) text = '暂不可结算'
  return { gap: blocking ? 0 : gap, disabled: disabled, text: text }
}

/** 自取模式的规则行：「自取享 9.5 折 · 满 ¥15 起 · 自流井区丹桂40栋底楼」。缺 pickup 节返回 '' */
function pickupRulesText(meta) {
  var pk = pickupMeta(meta)
  if (!pk) return ''
  var parts = []
  if (pk.discountText) parts.push(pk.discountText)
  if (pk.minOrderAmountFen) parts.push('满 ¥' + (pk.minOrderAmountFen / 100).toFixed(2).replace(/\.00$/, '') + ' 起')
  var store = meta.store
  if (store && store.address) parts.push((store.district || '') + store.address)
  return parts.join(' · ')
}

/** 某个模式此刻能不能下单（不看营业时段：外送打烊只是「现在不行」，自取本来就能约后面的时段） */
function modeAvailable(meta, mode) {
  if (!meta || meta.holiday) return false
  if (normMode(mode) === 'PICKUP') {
    var pk = pickupMeta(meta)
    return !!(pk && pk.enabled && !pk.paused)
  }
  return !!(meta.enabled && !meta.paused)
}

/** 本侧走不通时的另一侧；另一侧也走不通返回 null（此时页面给「去全国邮寄」） */
function altModeOf(meta, mode) {
  var other = normMode(mode) === 'PICKUP' ? 'DELIVERY' : 'PICKUP'
  return modeAvailable(meta, other) ? other : null
}

/**
 * 进同城时定模式：外送关了而自取开着 → 自取；自取关了而外送开着 → 外送；其余尊重当前值。
 * meta 还没回来时不改（拿不到事实就别猜）。
 */
function resolveLocalMode(meta, current) {
  var mode = normMode(current)
  if (!meta) return mode
  var deliveryOn = !!meta.enabled
  var pk = pickupMeta(meta)
  var pickupOn = !!(pk && pk.enabled)
  if (mode === 'DELIVERY' && !deliveryOn && pickupOn) return 'PICKUP'
  if (mode === 'PICKUP' && !pickupOn && deliveryOn) return 'DELIVERY'
  return mode
}

module.exports = {
  storeStatusOf: storeStatusOf,
  headNoticeOf: headNoticeOf,
  summarizeCart: summarizeCart,
  checkoutStateOf: checkoutStateOf,
  minOrderOf: minOrderOf,
  pickupRulesText: pickupRulesText,
  modeAvailable: modeAvailable,
  altModeOf: altModeOf,
  resolveLocalMode: resolveLocalMode,
  holidayText: holidayText,
}
```

- [ ] **Step 6: 跑全部单测**

Run: `npm run test:miniapp 2>&1 | tail -12`
Expected: 全部通过（含两文件新增用例）。

- [ ] **Step 7: Commit**

```bash
git add apps/miniapp/utils/channel.js apps/miniapp/app.js apps/miniapp/utils/local-catalog.js tests/miniapp/channel.test.cjs tests/miniapp/local-catalog.test.cjs
git commit -m "小程序：同城子模式 localMode（外送/自取）上下文；三段判断加 mode 与休业，不传时行为不变"
```

---

### Task 2: 切换栏组件、页头按模式、主页/分类页/购物车接线

**Files:**
- Create: `apps/miniapp/components/local-mode-bar/index.js`、`index.wxml`、`index.wxss`、`index.json`
- Modify: `apps/miniapp/components/local-store-header/index.js`、`index.wxml`、`index.wxss`
- Modify: `apps/miniapp/components/local-cart-bar/index.js`
- Modify: `apps/miniapp/pages/index/index.js`、`index.wxml`、`index.json`
- Modify: `apps/miniapp/pages/product/list.js`、`list.wxml`、`list.json`
- Modify: `apps/miniapp/pages/cart/index.js`、`index.wxml`
- Test: `tests/miniapp/local-mode.test.cjs`（新建）；`tests/miniapp/channel-pages.test.cjs`、`cart-channel.test.cjs`、`navigation.test.cjs` 的 `makeCtx` 补 `getLocalMode/setLocalMode` 桩

**Interfaces:**
- Consumes：Task 1 的 `app.getLocalMode/setLocalMode`、`local-catalog` 的 `resolveLocalMode/headNoticeOf/storeStatusOf/checkoutStateOf/altModeOf/pickupRulesText`。
- Produces：组件 `local-mode-bar`（属性 `meta`、`mode`；事件 `change` → `{ mode }`）；`local-store-header` 新增属性 `mode`、事件 `switchmode` → `{ mode }`；`local-cart-bar` 新增属性 `mode`；自取结算路由 `/pages/local/pickup?cartItemIds=`（Task 3 实现页面）。

- [ ] **Step 1: 先写失败的测试** `tests/miniapp/local-mode.test.cjs`

```js
// 同城「外送 / 自取」子模式在页面上的接线锁。
//
// 三件事错了都是静默的：① 外送关了自取开着，主页却仍按外送画（顾客看到「即将开通」）；
// ② 切到自取后购物车条仍把顾客送进外送结算页（要地址、要报价）；③ 起送线按错的那一侧判。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

function loadPage(relPath, ctx) {
  Object.keys(require.cache)
    .filter((k) => k.includes(path.join('apps', 'miniapp')))
    .forEach((k) => delete require.cache[k])
  let registered = null
  global.Page = (o) => { registered = o }
  global.Component = (o) => { registered = o }
  global.getApp = () => ctx.app
  global.wx = ctx.wx
  require(relPath)
  registered.data = Object.assign({}, registered.data)
  registered.setData = function (patch) { Object.assign(registered.data, patch) }
  registered.selectComponent = () => null
  return registered
}

const META_PICKUP_ONLY = {
  enabled: false, isOpen: false, paused: null, closedKind: 'OPEN', fee: { minOrderAmount: 4000 },
  pickup: { enabled: true, paused: null, minOrderAmountFen: 1500, discountText: '自取享 9.5 折', slotMinutes: 30 },
  store: { name: '阿福凉菜', district: '自流井区', address: '丹桂40栋底楼', latE6: 1, lngE6: 2 },
}
const META_BOTH = Object.assign({}, META_PICKUP_ONLY, { enabled: true, isOpen: true })

function makeCtx(channel, mode, meta, cart) {
  const urls = []
  const nav = []
  const app = {
    globalData: { shoppingChannel: channel, localMode: mode || 'DELIVERY', pendingCategoryId: null, pendingCategoryName: null, pendingCategoryAll: false },
    getShoppingChannel: () => app.globalData.shoppingChannel,
    setShoppingChannel: (v) => { app.globalData.shoppingChannel = v; return v },
    getLocalMode: () => app.globalData.localMode,
    setLocalMode: (v) => { nav.push('setLocalMode:' + v); app.globalData.localMode = v; return v },
    applyCartBadge() {}, updateCartCount() {},
    enterLocalChannel() { nav.push('enterLocal'); return Promise.resolve() },
  }
  const wx = {
    getStorageSync: () => '', setStorageSync: () => {},
    request: (o) => {
      const u = o.url.replace(/^https?:\/\/[^/]+(\/api)?/, '')
      urls.push(u)
      const body = /\/categories/.test(u) ? [] : /\/products/.test(u) ? { list: [], total: 0 }
        : /\/local\/meta/.test(u) ? meta
        : /\/cart/.test(u) ? (cart || { items: [], totalAmount: 0, selectedCount: 0 })
        : {}
      o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: body } })
    },
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
    getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, height: 32 }),
    navigateTo: (o) => { nav.push('navigateTo:' + o.url) },
    switchTab: (o) => { nav.push('switchTab:' + o.url) },
    stopPullDownRefresh() {}, showToast() {}, showModal() {}, reLaunch() {},
  }
  return { app, wx, urls, nav }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

test('主页：外送关、自取开 → 自动落到 PICKUP，并写回 app', async function () {
  const ctx = makeCtx('LOCAL', 'DELIVERY', META_PICKUP_ONLY)
  const page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  assert.equal(page.data.mode, 'PICKUP')
  assert.ok(ctx.nav.indexOf('setLocalMode:PICKUP') !== -1, '要写回 app：' + ctx.nav.join(' '))
  assert.equal(page.data.headBlocking, false, '自取可用时不该阻塞')
})

test('主页：切换栏 change → 模式写回 app，阻塞态按新模式重算', async function () {
  const ctx = makeCtx('LOCAL', 'DELIVERY', Object.assign({}, META_BOTH, { paused: { reason: '骑手不够' } }))
  const page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  assert.equal(page.data.headBlocking, true, '外送暂停应阻塞')
  page.onModeChange.call(page, { detail: { mode: 'PICKUP' } })
  assert.equal(ctx.app.globalData.localMode, 'PICKUP')
  assert.equal(page.data.mode, 'PICKUP')
  assert.equal(page.data.headBlocking, false, '切到自取后不再阻塞')
})

test('分类页：onShow 时 app 里的模式变了要跟上', async function () {
  const ctx = makeCtx('LOCAL', 'DELIVERY', META_BOTH)
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  assert.equal(page.data.mode, 'DELIVERY')
  ctx.app.globalData.localMode = 'PICKUP'
  page.onShow.call(page)
  await settle()
  assert.equal(page.data.mode, 'PICKUP')
})

const twoLocal = { items: [{ id: 1, productName: 'A', price: 1200, subtotal: 2400, quantity: 2, isSelected: 1, status: 'ON_SHELF' }], totalAmount: 2400, selectedCount: 2 }

test('购物车页：自取模式走自取结算页，外送模式走同城结算页；起送线按各自的', async function () {
  const pk = makeCtx('LOCAL', 'PICKUP', META_BOTH, twoLocal)
  const pkPage = loadPage('../../apps/miniapp/pages/cart/index.js', pk)
  pkPage.onShow.call(pkPage)
  await settle(); await settle()
  assert.equal(pkPage.data.checkoutText, '去结算 · 自取')
  pkPage.onCheckout.call(pkPage)
  assert.ok(pk.nav.some((n) => n.indexOf('navigateTo:/pages/local/pickup?cartItemIds=1') === 0), pk.nav.join(' '))

  const dl = makeCtx('LOCAL', 'DELIVERY', META_BOTH, twoLocal)
  const dlPage = loadPage('../../apps/miniapp/pages/cart/index.js', dl)
  dlPage.onShow.call(dlPage)
  await settle(); await settle()
  // 外送起送 ¥40，车里 ¥24：按外送判，不放行
  assert.equal(dlPage.data.checkoutDisabled, true)
  assert.equal(dlPage.data.checkoutText, '还差 ¥16.00 起送')
})

test('购物车条组件：自取模式 goCheckout 去自取结算页', async function () {
  const ctx = makeCtx('LOCAL', 'PICKUP', META_BOTH, twoLocal)
  const bar = loadPage('../../apps/miniapp/components/local-cart-bar/index.js', ctx)
  bar.properties = { meta: META_BOTH, blocking: false, mode: 'PICKUP' }
  bar.triggerEvent = () => {}
  // Component 运行时会把 methods 挂到 this 上（refresh 里调 this.recompute()）；桩要自己挂
  Object.keys(bar.methods).forEach((k) => { bar[k] = bar.methods[k] })
  await bar.refresh()
  assert.equal(bar.data.actionText, '去结算 · 自取')
  bar.goCheckout()
  assert.ok(ctx.nav.some((n) => n.indexOf('navigateTo:/pages/local/pickup?cartItemIds=1') === 0), ctx.nav.join(' '))
})
```

- [ ] **Step 2: 三个既有测试文件的 `makeCtx` 补桩**。在 `channel-pages.test.cjs`、`cart-channel.test.cjs`、`navigation.test.cjs` 的 `app` 对象里各加两行：

```js
    getLocalMode: () => app.globalData.localMode || 'DELIVERY',
    setLocalMode: (v) => { app.globalData.localMode = v; return v },
```

- [ ] **Step 3: 跑，确认失败**

Run: `node --test tests/miniapp/local-mode.test.cjs 2>&1 | tail -20`
Expected: `Cannot find module` 或 `page.onModeChange is not a function`。

- [ ] **Step 4: 组件 `local-mode-bar`**

`index.json`：`{ "component": true, "usingComponents": {} }`

`index.js`：

```js
// 同城「外送 / 自取」切换栏。主页与分类页共用，位置在页头之下、分类区之上（spec P2）。
//
// 只做两件事：画两个标签（各带一行状态小字），点了就把想去的模式抛给页面。
// 模式的写回、阻塞态重算、购物车条刷新都是页面的事——组件不碰 app.globalData。
var localCatalog = require('../../utils/local-catalog')

Component({
  options: { addGlobalClass: true },
  properties: {
    meta: { type: null, value: null },
    mode: { type: String, value: 'DELIVERY' },
  },
  data: {
    holiday: false,
    delivery: { tone: 'closed', label: '' },
    pickup: { tone: 'closed', label: '' },
  },
  observers: {
    meta: function(meta) {
      this.setData({
        holiday: !!(meta && meta.holiday),
        delivery: localCatalog.storeStatusOf(meta, 'DELIVERY'),
        pickup: localCatalog.storeStatusOf(meta, 'PICKUP'),
      })
    },
  },
  methods: {
    onTap: function(e) {
      var mode = e.currentTarget.dataset.mode
      if (mode === this.properties.mode) return
      this.triggerEvent('change', { mode: mode })
    },
  },
})
```

`index.wxml`：

```xml
<view class="mode-bar {{holiday ? 'mode-bar-holiday' : ''}}">
  <view class="mode-tab {{mode === 'DELIVERY' ? 'active' : ''}}" hover-class="mode-tab-hover" bindtap="onTap" data-mode="DELIVERY">
    <text class="mode-name">外送</text>
    <text class="mode-sub mode-sub-{{delivery.tone}}">{{delivery.label}}</text>
  </view>
  <view class="mode-tab {{mode === 'PICKUP' ? 'active' : ''}}" hover-class="mode-tab-hover" bindtap="onTap" data-mode="PICKUP">
    <text class="mode-name">自取</text>
    <text class="mode-sub mode-sub-{{pickup.tone}}">{{pickup.label}}</text>
  </view>
</view>
```

`index.wxss`：

```css
/* 通栏独立一栏：上下各留间距，两格等宽，选中格用品牌色下划线。休业时两格都灰。 */
.mode-bar {
  display: flex;
  margin: 12rpx 24rpx 16rpx;
  padding: 6rpx;
  background: var(--card, #fff);
  border-radius: var(--radius-md, 12rpx);
  box-shadow: var(--shadow-card, 0 2rpx 12rpx rgba(0, 0, 0, 0.04));
}
.mode-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4rpx;
  padding: 14rpx 0 12rpx;
  border-radius: 10rpx;
}
.mode-tab-hover { background: var(--bg, #f5f6f7); }
.mode-tab.active { background: var(--brand-bg, #fef4f0); }
.mode-name { font-size: 30rpx; font-weight: 600; color: var(--text-2, #666); }
.mode-tab.active .mode-name { color: var(--brand, #e5441e); }
.mode-sub { font-size: 21rpx; line-height: 1; }
.mode-sub-open { color: var(--success, #16a34a); }
.mode-sub-paused { color: var(--warning, #ff9500); }
.mode-sub-closed { color: var(--text-3, #999); }
.mode-bar-holiday .mode-name, .mode-bar-holiday .mode-sub { color: var(--text-disabled, #c8c9cc); }
.mode-bar-holiday .mode-tab.active { background: var(--gray-bg, #f3f4f6); }
```

- [ ] **Step 5: 页头组件按模式**。`local-store-header/index.js` 整文件替换：

```js
// 同城门店头。主页用完整版（店名 + 状态 + 规则行 + 通知），分类页用紧凑版（compact，只留第一行），
// 两页共用同一份状态判定与同一套排版规则。
//
// 存在的理由是排版而不只是复用：原来这一行是 `justify-content: space-between`，
// 中间还挂着一个「我的订单 ›」。店名一长，space-between 会把状态胶囊推到远处、
// 并把它压扁——绿色底色跟着文字一起被截断，看起来像渲染坏了。
// 规格 §4.1 因此钉死了三条：整行左对齐、店名可收缩可省略、胶囊不可收缩不换行。
//
// 2026-09-11 起按同城子模式（外送 / 自取）切换胶囊、规则行与通知；切换控件本身不在这里，
// 在独立的 local-mode-bar 组件（页头之下、分类区之上）。

var localCatalog = require('../../utils/local-catalog')

Component({
  options: {
    // 让外部传进来的 class 能作用到组件根节点，两个页面各自微调间距
    addGlobalClass: true,
  },
  properties: {
    meta: { type: null, value: null },
    // 紧凑版：只画第一行（图标 + 店名 + 状态），不画规则行与通知
    compact: { type: Boolean, value: false },
    // 同城子模式 'DELIVERY' | 'PICKUP'
    mode: { type: String, value: 'DELIVERY' },
  },
  data: {
    tone: 'closed',
    label: '暂未营业',
    notice: '',
    noticeBlocking: false,
    rulesText: '',
    // 通知里的出路：另一侧可用就「改用自取/改用外送」，否则「去全国邮寄」
    altMode: '',
    altLabel: '去全国邮寄',
    // 自取模式且门店有坐标：规则行可点，打开地图导航
    canNavigate: false,
  },
  observers: {
    'meta, mode': function(meta, mode) {
      var status = localCatalog.storeStatusOf(meta, mode)
      var notice = localCatalog.headNoticeOf(meta, mode)
      var alt = notice.blocking ? localCatalog.altModeOf(meta, mode) : null
      var store = meta && meta.store
      this.setData({
        tone: status.tone,
        label: status.label,
        notice: notice.text,
        noticeBlocking: notice.blocking,
        rulesText: mode === 'PICKUP' ? localCatalog.pickupRulesText(meta) : this.buildRules(meta),
        altMode: alt || '',
        altLabel: alt === 'PICKUP' ? '改用自取' : alt === 'DELIVERY' ? '改用外送' : '去全国邮寄',
        canNavigate: mode === 'PICKUP' && !!(store && store.latE6 != null && store.lngE6 != null),
      })
    },
  },
  methods: {
    // 「配送范围 10 km · 满 ¥40 起送 · 基础运费 ¥6 起」。
    // 三段都缺时返回空串——宁可不画这一行，也不要画出「配送范围 undefined km」。
    buildRules: function(meta) {
      if (!meta || !meta.fee) return ''
      var parts = []
      if (meta.radiusKm) parts.push('配送范围 ' + meta.radiusKm + ' km')
      if (meta.fee.minOrderAmount) parts.push('满 ¥' + (meta.fee.minOrderAmount / 100).toFixed(2).replace(/\.00$/, '') + ' 起送')
      if (meta.fee.baseFee) parts.push('基础运费 ¥' + (meta.fee.baseFee / 100).toFixed(2).replace(/\.00$/, '') + ' 起')
      return parts.join(' · ')
    },
    // 通知里的出路按钮：另一侧可用 → 页面切模式；都不可用 → 页面切去邮寄
    onAction: function() {
      if (this.data.altMode) this.triggerEvent('switchmode', { mode: this.data.altMode })
      else this.triggerEvent('goexpress')
    },
    onGoExpress: function() {
      this.triggerEvent('goexpress')
    },
    // 自取规则行的「›」：打开地图导航到门店。没坐标就不可点（canNavigate=false，wxml 不渲染箭头）
    onOpenStore: function() {
      var store = this.properties.meta && this.properties.meta.store
      if (!this.data.canNavigate || !store) return
      wx.openLocation({
        latitude: store.latE6 / 1e6,
        longitude: store.lngE6 / 1e6,
        name: store.name || '门店',
        address: (store.district || '') + (store.address || ''),
      })
    },
  },
})
```

`index.wxml` 的 `<block wx:if="{{!compact}}">` 内容替换为：

```xml
  <block wx:if="{{!compact}}">
    <view wx:if="{{rulesText}}" class="delivery-rules-row" bindtap="onOpenStore">
      <text class="delivery-rules">{{rulesText}}</text>
      <text wx:if="{{canNavigate}}" class="delivery-rules-arrow">›</text>
    </view>
    <view wx:if="{{notice}}" class="head-notice {{noticeBlocking ? '' : 'head-notice-soft'}}">
      <text class="head-notice-text">{{notice}}</text>
      <view wx:if="{{noticeBlocking}}" class="head-notice-action" bindtap="onAction">{{altLabel}}</view>
    </view>
  </block>
```

`index.wxss` 追加：

```css
.delivery-rules-row { display: flex; align-items: center; gap: 8rpx; margin-top: 12rpx; }
.delivery-rules-row .delivery-rules { margin-top: 0; flex: 1; min-width: 0; }
.delivery-rules-arrow { flex-shrink: 0; color: var(--text-3, #999); font-size: 28rpx; }
/* 非阻塞的软提示（自取在营业时间外仍可预约）：灰底，不用橙色告警底 */
.head-notice-soft { background: var(--gray-bg, #f3f4f6); }
.head-notice-soft .head-notice-text { color: var(--text-2, #666); }
```

- [ ] **Step 6: 购物车条按模式**。`local-cart-bar/index.js`：`properties` 加 `mode: { type: String, value: 'DELIVERY' }`；`observers` 键改为 `'meta, blocking, mode'`；`recompute` 与 `goCheckout` 替换为：

```js
    recompute: function() {
      var mode = this.properties.mode
      var s = localCatalog.checkoutStateOf(this.properties.meta, this.data.count, this.data.amount, this.properties.blocking, mode)
      // 可结算时把去向写在按钮上：两种模式共用一个车，顾客要知道按下去是外送还是自取
      var text = (!s.disabled && !this.properties.blocking && s.gap === 0) ? ('去结算 · ' + (mode === 'PICKUP' ? '自取' : '外送')) : s.text
      this.setData({ disabled: s.disabled, actionText: text })
    },
```

```js
    goCheckout: function() {
      if (this.data.disabled) return
      var ids = this.data.items.map(function(item) { return item.id })
      if (!ids.length) return
      // 结算页不是 tabBar 页，用 navigateTo：顾客从结算返回时应当回到这份菜单。
      // 自取与外送各自一个结算页——两套状态机（时段/手机号 vs 地址/报价）硬塞进一个页面只会互相绊。
      var page = this.properties.mode === 'PICKUP' ? '/pages/local/pickup' : '/pages/local/confirm'
      wx.navigateTo({ url: page + '?cartItemIds=' + ids.join(',') })
    },
```

- [ ] **Step 7: 主页接线**。`pages/index/index.json` 的 `usingComponents` 加 `"local-mode-bar": "/components/local-mode-bar/index"`。`index.js`：

- `require` 行改为 `const { headNoticeOf, resolveLocalMode } = require('../../utils/local-catalog')`。
- `data` 加 `mode: 'DELIVERY',`。
- `onShow` 的 `if (this.data.channel === 'LOCAL') {` 块内最前面加：`if (app.getLocalMode() !== this.data.mode) this.applyMode(app.getLocalMode())`。
- `loadData` 的 setData 加 `mode: channel === 'LOCAL' ? app.getLocalMode() : 'DELIVERY',`。
- `loadLocal` 的 `.then` 里，`headBlocking: headNoticeOf(meta).blocking` 改为先算模式：

```js
      .then(([categories, productData, meta]) => {
        // 外送关了、自取开着（或反过来）时自动落到开着的那一侧；两边都开尊重顾客上次的选择
        var mode = app.setLocalMode(resolveLocalMode(meta, app.getLocalMode()))
        this.setData({
          categories: categories || [],
          products: this.decorate(productData),
          meta: meta,
          mode: mode,
          headBlocking: headNoticeOf(meta, mode).blocking,
          loading: false,
        })
```

- `loadMeta` 的 `.then` 同样：`var mode = app.setLocalMode(resolveLocalMode(meta, app.getLocalMode())); self.setData({ meta: meta, mode: mode, headBlocking: headNoticeOf(meta, mode).blocking })`。
- `onGoExpress` 之前加三个方法：

```js
  // 子模式变了：阻塞态按新模式重算，购物车条的按钮跟着变（去向与起送线都不一样）
  applyMode(mode) {
    this.setData({ mode: mode, headBlocking: headNoticeOf(this.data.meta, mode).blocking })
    this.refreshCartBar()
  },
  onModeChange(e) {
    this.applyMode(app.setLocalMode(e.detail.mode))
  },
  // 页头通知里的「改用自取 / 改用外送」
  onSwitchMode(e) {
    this.applyMode(app.setLocalMode(e.detail.mode))
  },
```

`index.wxml`：`<local-store-header …/>` 改为 `<local-store-header wx:if="{{channel === 'LOCAL'}}" meta="{{meta}}" mode="{{mode}}" bind:goexpress="onGoExpress" bind:switchmode="onSwitchMode" />`，其后紧跟一行 `<local-mode-bar wx:if="{{channel === 'LOCAL'}}" meta="{{meta}}" mode="{{mode}}" bind:change="onModeChange" />`；底部 `<local-cart-bar …>` 加 `mode="{{mode}}"`。

- [ ] **Step 8: 分类页接线**。`pages/product/list.json` 加同一个组件。`list.js`：`require` 改为 `const { headNoticeOf, resolveLocalMode } = require('../../utils/local-catalog')`；`data` 加 `mode: 'DELIVERY'`；`onShow` 的 `if (this.data.channel === 'LOCAL') {` 块内最前面加 `if (app.getLocalMode() !== this.data.mode) this.applyMode(app.getLocalMode())`；`reloadForChannel` 的 setData 加 `mode: channel === 'LOCAL' ? app.getLocalMode() : 'DELIVERY'`；`loadMeta` 的 `.then` 改为与主页同款（`resolveLocalMode` → `setLocalMode` → setData `meta/mode/headBlocking`）；加 `applyMode/onModeChange/onSwitchMode` 三个方法（与主页逐字相同）。`list.wxml`：紧凑页头加 `mode="{{mode}}" bind:switchmode="onSwitchMode"`，其后加 `<local-mode-bar wx:if="{{channel === 'LOCAL'}}" meta="{{meta}}" mode="{{mode}}" bind:change="onModeChange" />`（放在 `<view class="body">` 之前）；`<local-cart-bar>` 加 `mode="{{mode}}"`。

- [ ] **Step 9: 购物车页接线**。`pages/cart/index.js`：`data` 加 `mode: 'DELIVERY'`；`onShow` 开头 `var channel = getApp().getShoppingChannel()` 之后加 `var mode = channel === 'LOCAL' ? getApp().getLocalMode() : 'DELIVERY'`，切渠道那个 setData 加 `mode: mode`，并在其后（不论渠道是否变）加 `if (mode !== this.data.mode) this.setData({ mode: mode })`；`loadMeta` 里 `headNoticeOf(meta)` 改为 `headNoticeOf(meta, self.data.mode)`；`refreshCheckout` 的同城分支改为：

```js
    var mode = this.data.mode
    var s = checkoutStateOf(this.data.meta, this.data.selectedCount, this.data.totalAmount, this.data.headBlocking, mode)
    var text = (!s.disabled && !this.data.headBlocking && s.gap === 0) ? ('去结算 · ' + (mode === 'PICKUP' ? '自取' : '外送')) : s.text
    this.setData({ checkoutDisabled: s.disabled, checkoutText: text })
```

`onCheckout` 的 `var page = …` 改为 `var page = this.data.channel !== 'LOCAL' ? '/pages/order/confirm' : this.data.mode === 'PICKUP' ? '/pages/local/pickup' : '/pages/local/confirm'`。`index.wxml` 在 `<view wx:if="{{channel === 'LOCAL' && headNotice}}" class="cart-notice">…` 之后加：

```xml
    <!-- 两种模式共用一个车：告诉顾客这一单按哪种方式结算，切换在主页顶部那一栏 -->
    <view wx:if="{{channel === 'LOCAL'}}" class="cart-notice cart-mode-note">结算方式：{{mode === 'PICKUP' ? '到店自取' : '同城外送'}}（可在主页顶部切换）</view>
```

- [ ] **Step 10: 跑全部单测**

Run: `npm run test:miniapp 2>&1 | tail -15`
Expected: 全部通过。

- [ ] **Step 11: Commit**

```bash
git add apps/miniapp/components/local-mode-bar apps/miniapp/components/local-store-header apps/miniapp/components/local-cart-bar/index.js apps/miniapp/pages/index apps/miniapp/pages/product apps/miniapp/pages/cart tests/miniapp/local-mode.test.cjs tests/miniapp/channel-pages.test.cjs tests/miniapp/cart-channel.test.cjs tests/miniapp/navigation.test.cjs
git commit -m "小程序：同城页「外送/自取」切换栏，页头胶囊/规则/通知按模式，购物车条与购物车页按模式分流结算"
```

---

### Task 3: 自取结算页 `pages/local/pickup` + 状态机 + 接口封装

**Files:**
- Modify: `apps/miniapp/api/local.js`（加 `getPickupSlots`）
- Modify: `apps/miniapp/api/order.js`（加 `getPickupContact`；`getOrders` 加 `channel` 参数）
- Create: `apps/miniapp/utils/pickup-checkout-state.js`
- Create: `apps/miniapp/pages/local/pickup.js`、`pickup.wxml`、`pickup.wxss`、`pickup.json`
- Modify: `apps/miniapp/app.json`（`pages` 数组在 `"pages/local/confirm"` 之后加 `"pages/local/pickup"`）
- Test: `tests/miniapp/pickup-checkout-state.test.cjs`（新建）

**Interfaces:**
- Consumes：服务端 `GET /local/pickup-slots`（`{ days:[{date,label,slots:[{startAt,endAt,label}]}], earliestAt, slotMinutes, blocked }`）、`GET /orders/pickup-contact`（`{name,phone}|null`）、`GET /local/meta` 的 `pickup` 节（`enabled/paused/minOrderAmountFen/discount:{type,value}/discountText/slotMinutes`）与 `store`、`GET /orders/meta` 的 `subscribeTemplates.pickup`；`POST /orders`（见 Global Constraints 的请求体）。
- Produces：`pickupCheckoutAction(s)`、`isValidPhone(p)`、`pickupDiscountOf(rule, subtotal)`、`computePickupPay(subtotal, rule, couponDiscount)`、`firstSlot(view)`、`slotOffered(view, startAt)`。

- [ ] **Step 1: 先写失败的测试** `tests/miniapp/pickup-checkout-state.test.cjs`

```js
// 自取结算页底部按钮的行为锁（与 local-checkout-state.test.cjs 同一思路）。
// 自取没有地址与报价，但有三个自己的坑：时段过期了还能提交、手机号没填还能提交、
// 券封顶算错让页面上的应付金额比服务端算的小。
const test = require('node:test')
const assert = require('node:assert/strict')

const st = require('../../apps/miniapp/utils/pickup-checkout-state')

const READY = { hasSlot: true, slotStale: false, phoneValid: true, belowMinGap: 0, payAmount: 4750 }
const on = function (over) { return Object.assign({}, READY, over) }

test('阻塞（休业/暂停/未开通）压过一切，按钮一句短文案', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ blockReason: '休息中，10月08日恢复' })),
    { disabled: true, text: '暂不可自取', amountState: 'blocked', action: 'none' })
})
test('没选时段 → 禁用；时段失效 → 可点但动作是重选，不是提交', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ hasSlot: false })),
    { disabled: true, text: '请选择取餐时间', amountState: 'pending', action: 'none' })
  assert.deepEqual(st.pickupCheckoutAction(on({ slotStale: true })),
    { disabled: false, text: '重新选择时间', amountState: 'pending', action: 'reslot' })
})
test('手机号无效 → 禁用，但金额照常显示（顾客要先看到要付多少）', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ phoneValid: false })),
    { disabled: true, text: '请填写手机号', amountState: 'ready', action: 'none' })
})
test('未达起送：说出具体差额', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ belowMinGap: 500 })),
    { disabled: true, text: '还差 ¥5.00 起', amountState: 'ready', action: 'none' })
})
test('优惠重算中锁提交但金额不闪；提交中锁死', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ benefitsLoading: true })),
    { disabled: true, text: '提交订单', amountState: 'ready', action: 'submit' })
  assert.deepEqual(st.pickupCheckoutAction(on({ submitting: true })),
    { disabled: true, text: '提交中', amountState: 'ready', action: 'submit' })
  assert.deepEqual(st.pickupCheckoutAction(READY),
    { disabled: false, text: '提交订单', amountState: 'ready', action: 'submit' })
})
test('应付金额算不出来（车还没回来）按待计算处理', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ payAmount: null })),
    { disabled: true, text: '提交订单', amountState: 'pending', action: 'none' })
})
test('手机号：11 位 1 开头才算', function () {
  assert.equal(st.isValidPhone('13800001234'), true)
  assert.equal(st.isValidPhone(' 13800001234 '), true)
  assert.equal(st.isValidPhone('1380000123'), false)
  assert.equal(st.isValidPhone('23800001234'), false)
  assert.equal(st.isValidPhone(''), false)
})
test('自取优惠与服务端同一公式：PERCENT 四舍五入、FIXED 封顶、NONE 为 0；券封顶到小计−自取优惠', function () {
  assert.equal(st.pickupDiscountOf({ type: 'PERCENT', value: 95 }, 5000), 250)
  assert.equal(st.pickupDiscountOf({ type: 'PERCENT', value: 95 }, 3333), 167)
  assert.equal(st.pickupDiscountOf({ type: 'FIXED', value: 300 }, 200), 200)
  assert.equal(st.pickupDiscountOf(null, 5000), 0)
  assert.deepEqual(st.computePickupPay(5000, { type: 'PERCENT', value: 95 }, 500),
    { pickupDiscount: 250, couponDiscount: 500, payAmount: 4250 })
  // 券面额超过「小计−自取优惠」时封顶，实付不会算成负数
  assert.deepEqual(st.computePickupPay(1000, { type: 'FIXED', value: 300 }, 1000),
    { pickupDiscount: 300, couponDiscount: 700, payAmount: 0 })
})
test('时段：默认选第一个可选格；今天为空时落到明天；已选格不在最新列表里即视为失效', function () {
  const view = { days: [
    { date: '2026-09-11', label: '今天', slots: [] },
    { date: '2026-09-12', label: '明天', slots: [{ startAt: 'A', endAt: 'B', label: '10:00–10:30' }] },
  ] }
  assert.deepEqual(st.firstSlot(view), { dayIndex: 1, slot: { startAt: 'A', endAt: 'B', label: '10:00–10:30' } })
  assert.equal(st.slotOffered(view, 'A'), true)
  assert.equal(st.slotOffered(view, 'Z'), false)
  assert.equal(st.firstSlot({ days: [] }), null)
  assert.equal(st.firstSlot(null), null)
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `node --test tests/miniapp/pickup-checkout-state.test.cjs 2>&1 | tail -5`
Expected: `Cannot find module`。

- [ ] **Step 3: `utils/pickup-checkout-state.js`**（ES5）

```js
// 自取结算页底部按钮的唯一判定 + 金额预览 + 时段选择的三个小函数。
//
// 与 local-checkout-state.js 同一套理由：结算页有七八种可见状态，每种都要同时决定
// 「能不能点 / 写什么 / 金额显示成什么 / 点了干什么」，散在页面里拼三元表达式
// 必然出现「文案改了但按钮还能点」。
//
// 优先级：阻塞 → 未选时段 → 时段失效 → 手机号 → 起送线 → 金额未知 → 优惠重算中 → 提交中。
// 「时段失效」那一格按钮**可点**，动作是 reslot（重新拉时段并打开选择器），不是提交——
// 页面必须按 action 分派，绝不能以「按钮没禁用」推断该提交。
//
// ⚠️ 本文件必须保持 ES5（scripts/check-miniapp-es5.mjs 把守）。

var formatPrice = require('./format').formatPrice

var TEXT = {
  BLOCKED: '暂不可自取',
  NO_SLOT: '请选择取餐时间',
  SLOT_STALE: '重新选择时间',
  NO_PHONE: '请填写手机号',
  SUBMIT: '提交订单',
  SUBMITTING: '提交中',
}

function result(disabled, text, amountState, action) {
  return { disabled: disabled, text: text, amountState: amountState, action: action }
}

/**
 * @param {Object} s
 *   blockReason     业务阻塞（休业/暂停/未开通），非空即阻塞
 *   hasSlot         已选中一个取餐时段
 *   slotStale       已选的那格已不在最新时段列表里（过期或店主改了设置）
 *   phoneValid      取餐人手机号合法
 *   belowMinGap     距自取起送线还差多少（分），0 = 达标
 *   payAmount       应付金额（分），null = 还算不出来
 *   benefitsLoading 优惠券/赠品正在重算
 *   submitting      正在提交
 */
function pickupCheckoutAction(s) {
  var st = s || {}
  if (st.blockReason) return result(true, TEXT.BLOCKED, 'blocked', 'none')
  if (!st.hasSlot) return result(true, TEXT.NO_SLOT, 'pending', 'none')
  if (st.slotStale) return result(false, TEXT.SLOT_STALE, 'pending', 'reslot')
  if (!st.phoneValid) return result(true, TEXT.NO_PHONE, 'ready', 'none')
  if (st.belowMinGap > 0) return result(true, '还差 ¥' + formatPrice(st.belowMinGap) + ' 起', 'ready', 'none')
  if (st.payAmount === null || st.payAmount === undefined) return result(true, TEXT.SUBMIT, 'pending', 'none')
  if (st.benefitsLoading) return result(true, TEXT.SUBMIT, 'ready', 'submit')
  if (st.submitting) return result(true, TEXT.SUBMITTING, 'ready', 'submit')
  return result(false, TEXT.SUBMIT, 'ready', 'submit')
}

/** 与服务端 zod 校验同一条正则 */
function isValidPhone(phone) {
  return /^1\d{10}$/.test(String(phone === undefined || phone === null ? '' : phone).trim())
}

/**
 * 自取优惠（分）。**公式与服务端 services/pickup.ts 的 pickupDiscountOf 逐字相同**：
 * PERCENT：小计 − round(小计 × value / 100)；FIXED：min(value, 小计)；其它 0。
 * 页面只用它做预览，实收以服务端为准。
 */
function pickupDiscountOf(rule, subtotal) {
  if (!rule || !subtotal) return 0
  if (rule.type === 'PERCENT') return Math.max(0, subtotal - Math.round((subtotal * rule.value) / 100))
  if (rule.type === 'FIXED') return Math.min(rule.value || 0, subtotal)
  return 0
}

/** 小计 → 自取优惠 → 券（封顶到 小计−自取优惠）→ 实付。运费恒 0，所以这里没有它 */
function computePickupPay(subtotal, rule, couponDiscount) {
  var pd = pickupDiscountOf(rule, subtotal)
  var cap = Math.max(0, subtotal - pd)
  var cd = Math.min(couponDiscount || 0, cap)
  return { pickupDiscount: pd, couponDiscount: cd, payAmount: subtotal - pd - cd }
}

/** 第一个可选格：{ dayIndex, slot }；一格都没有返回 null */
function firstSlot(view) {
  var days = (view && view.days) || []
  for (var i = 0; i < days.length; i++) {
    var slots = days[i].slots || []
    if (slots.length) return { dayIndex: i, slot: slots[0] }
  }
  return null
}

/** 某个 startAt 是否仍在最新的时段列表里 */
function slotOffered(view, startAt) {
  var days = (view && view.days) || []
  for (var i = 0; i < days.length; i++) {
    var slots = days[i].slots || []
    for (var j = 0; j < slots.length; j++) if (slots[j].startAt === startAt) return true
  }
  return false
}

module.exports = {
  pickupCheckoutAction: pickupCheckoutAction,
  isValidPhone: isValidPhone,
  pickupDiscountOf: pickupDiscountOf,
  computePickupPay: computePickupPay,
  firstSlot: firstSlot,
  slotOffered: slotOffered,
}
```

- [ ] **Step 4: 接口封装**。`api/local.js` 加：

```js
// 自取时段（公开）。silent：结算页要按 blocked 自己分流，不走统一 toast。
function getPickupSlots() {
  return request({ url: '/local/pickup-slots', silent: true })
}
```

并导出 `getPickupSlots`。`api/order.js`：`getOrders` 里 `if (params.deliveryType) …` 之后加 `if (params.channel) parts.push('channel=' + encodeURIComponent(params.channel))`；新增并导出：

```js
// 自取：最近一张自取单的取餐人（结算页预填），没有则 null。silent：拉不到就留空让顾客填
function getPickupContact() {
  return request({ url: '/orders/pickup-contact', silent: true })
}
```

- [ ] **Step 5: 跑状态机测试**

Run: `node --test tests/miniapp/pickup-checkout-state.test.cjs 2>&1 | tail -5 && node scripts/check-miniapp-es5.mjs apps/miniapp/utils/pickup-checkout-state.js`
Expected: 全过；ES5 ✔。

- [ ] **Step 6: 页面 `pages/local/pickup.json`**

```json
{
  "navigationBarTitleText": "确认自取订单",
  "usingComponents": {
    "checkout-benefits": "/components/checkout-benefits/index"
  }
}
```

- [ ] **Step 7: 页面 `pages/local/pickup.js`**（ES5）

```js
// 自取结算页。与同城外送结算页（pages/local/confirm.js）是两套独立的状态机：
// 那边围绕「地址 → 报价凭证」，这边围绕「时段 → 手机号」，硬塞进一个页面只会互相绊。
//
// 顺序（spec §5.4）：通知 → 取餐门店 → 取餐时间 → 取餐人 → 商品 → 优惠 → 备注 → 金额 → 协议 → 底栏。
// 底部按钮只由 utils/pickup-checkout-state 的 pickupCheckoutAction 决定，页面按 action 分派。
//
// ⚠️ 新文件，保持 ES5。

var cartApi = require('../../api/cart')
var localApi = require('../../api/local')
var orderApi = require('../../api/order')
var requestSubscribe = require('../../utils/subscribe').requestSubscribe
var formatPrice = require('../../utils/format').formatPrice
var localCatalog = require('../../utils/local-catalog')
var st = require('../../utils/pickup-checkout-state')
var newClientRequestId = require('../../utils/local-checkout-state').newClientRequestId
var app = getApp()

function selectedItems(cart, cartItemIds) {
  return (cart.items || []).filter(function(item) { return cartItemIds.indexOf(item.id) !== -1 }).map(function(item) {
    return Object.assign({}, item, { priceText: formatPrice(item.price) })
  })
}

function decorateSlot(slot, dayLabel) {
  if (!slot) return null
  return { startAt: slot.startAt, endAt: slot.endAt, label: slot.label, dayLabel: dayLabel, text: dayLabel + ' ' + slot.label }
}

Page({
  data: {
    cartItemIds: [],
    items: [],
    subtotal: 0,
    meta: null,
    headNotice: '',
    blockReason: '',
    // 时段
    days: [],
    activeDay: 0,
    selected: null,       // { startAt, endAt, label, dayLabel, text }
    slotStale: false,
    slotsLoading: true,
    slotsError: '',
    pickerOpen: false,
    // 取餐人
    contactName: '',
    contactPhone: '',
    remark: '',
    // 优惠（来自 checkout-benefits）
    couponId: null,
    gifts: [],
    discount: 0,
    pointsUsed: 0,
    benefitsLoading: false,
    // 金额
    discountRule: null,
    pickupDiscount: 0,
    payAmount: null,
    belowMinGap: 0,
    submitting: false,
    action: { disabled: true, text: '请选择取餐时间', amountState: 'pending', action: 'none' },
    subscribeTemplateIds: [],
    payTimeoutMin: 15,
  },

  onLoad: function(options) {
    var ids = (options.cartItemIds || '').split(',').filter(Boolean).map(Number)
    // 幂等键随页面而生，整页只有这一个；只在确认下单成功后换新的（见 doSubmit）
    this._clientRequestId = newClientRequestId()
    this.setData({ cartItemIds: ids })
    this.loadAll()
    var self = this
    orderApi.getOrderMeta().then(function(meta) {
      var groups = (meta && meta.subscribeTemplates) || {}
      self.setData({
        // 自取页只请求「取餐提醒 + 退款」两个模板；老服务端没有分组时退回整份列表
        subscribeTemplateIds: (groups.pickup && groups.pickup.length ? groups.pickup : (meta && meta.subscribeTemplateIds)) || [],
        payTimeoutMin: (meta && meta.payTimeoutMin) || 15,
      })
    }).catch(function() {})
  },

  // 从别的页回来：时段可能过期、店主可能刚暂停自取——重拉时段与 meta，保留已选的格子（还在就留着）
  onShow: function() {
    if (!this._loadedOnce) return
    this.loadMeta()
    this.loadSlots(true)
  },

  loadAll: function() {
    var self = this
    Promise.all([
      cartApi.getCart('LOCAL'),
      localApi.getLocalMeta().catch(function() { return null }),
      orderApi.getPickupContact().catch(function() { return null }),
    ]).then(function(results) {
      var items = selectedItems(results[0] || {}, self.data.cartItemIds)
      var subtotal = items.reduce(function(sum, item) { return sum + item.subtotal }, 0)
      var contact = results[2] || {}
      self.setData({
        items: items,
        subtotal: subtotal,
        contactName: contact.name || '',
        contactPhone: contact.phone || '',
      })
      self.applyMeta(results[1])
      self._loadedOnce = true
      self.loadSlots(false)
    }).catch(function() {
      self.setData({ blockReason: '商品信息加载失败，请返回同城菜单重试', payAmount: null })
      self.recompute()
    })
  },

  loadMeta: function() {
    var self = this
    localApi.getLocalMeta().then(function(meta) { self.applyMeta(meta) }).catch(function() {})
  },

  applyMeta: function(meta) {
    var notice = localCatalog.headNoticeOf(meta, 'PICKUP')
    this.setData({
      meta: meta,
      headNotice: notice.text,
      blockReason: notice.blocking ? notice.text : '',
      discountRule: meta && meta.pickup ? meta.pickup.discount : null,
    })
    this.recompute()
  },

  loadSlots: function(keepSelection) {
    var self = this
    var seq = (this._slotSeq = (this._slotSeq || 0) + 1)
    this.setData({ slotsLoading: true, slotsError: '' })
    localApi.getPickupSlots()
      .then(function(view) {
        if (seq !== self._slotSeq) return
        var days = (view.days || []).map(function(d) {
          return { date: d.date, label: d.label, slots: d.slots || [], empty: !(d.slots && d.slots.length) }
        })
        var patch = { days: days, slotsLoading: false }
        if (view.blocked) {
          // 服务端说这会儿不能自取（休业/暂停/未开通）：清选择、阻塞提交，文案用它给的
          patch.selected = null
          patch.slotStale = false
          patch.blockReason = view.blocked.text || '暂不可自取'
          patch.headNotice = view.blocked.text || ''
        } else if (keepSelection && self.data.selected) {
          // 已选的格子还在就留着；不在了标 stale，按钮变成「重新选择时间」
          patch.slotStale = !st.slotOffered(view, self.data.selected.startAt)
        } else {
          var first = st.firstSlot(view)
          patch.selected = first ? decorateSlot(first.slot, days[first.dayIndex].label) : null
          patch.activeDay = first ? first.dayIndex : 0
          patch.slotStale = false
        }
        self.setData(patch)
        self.recompute()
      })
      .catch(function(err) {
        if (seq !== self._slotSeq) return
        self.setData({ slotsLoading: false, slotsError: (err && err.message) || '取餐时段获取失败' })
        self.recompute()
      })
  },

  /**
   * 金额与按钮的唯一重算点。每一处改变 blockReason / selected / slotStale / contactPhone /
   * discount / benefitsLoading / submitting 的地方都要跟着调一次。
   */
  recompute: function() {
    var d = this.data
    var amounts = st.computePickupPay(d.subtotal, d.discountRule, d.discount)
    var gap = Math.max(0, localCatalog.minOrderOf(d.meta, 'PICKUP') - d.subtotal)
    var payAmount = d.items.length ? amounts.payAmount : null
    this.setData({
      pickupDiscount: amounts.pickupDiscount,
      payAmount: payAmount,
      belowMinGap: gap,
      action: st.pickupCheckoutAction({
        blockReason: d.blockReason,
        hasSlot: !!d.selected,
        slotStale: d.slotStale,
        phoneValid: st.isValidPhone(d.contactPhone),
        belowMinGap: gap,
        payAmount: payAmount,
        benefitsLoading: d.benefitsLoading,
        submitting: d.submitting,
      }),
    })
  },

  // ── 时段选择器 ──────────────────────────────────────────────
  openPicker: function() {
    if (this.data.blockReason) return
    this.setData({ pickerOpen: true })
  },
  closePicker: function() {
    this.setData({ pickerOpen: false })
  },
  noop: function() {},
  onRetrySlots: function() {
    this.loadSlots(false)
  },
  selectDay: function(e) {
    this.setData({ activeDay: Number(e.currentTarget.dataset.idx) || 0 })
  },
  selectSlot: function(e) {
    var idx = Number(e.currentTarget.dataset.idx)
    var day = this.data.days[this.data.activeDay]
    var slot = day && day.slots[idx]
    if (!slot) return
    this.setData({ selected: decorateSlot(slot, day.label), slotStale: false, pickerOpen: false })
    this.recompute()
  },

  // ── 取餐人 / 备注 ──────────────────────────────────────────
  onNameInput: function(e) {
    this.setData({ contactName: e.detail.value })
  },
  onPhoneInput: function(e) {
    this.setData({ contactPhone: e.detail.value })
    this.recompute()
  },
  onRemarkInput: function(e) {
    this.setData({ remark: e.detail.value })
  },

  // ── 商品数量（与同城结算页同款） ─────────────────────────────
  reloadCart: function() {
    var self = this
    return cartApi.getCart('LOCAL').then(function(cart) {
      var items = selectedItems(cart || {}, self.data.cartItemIds)
      var subtotal = items.reduce(function(sum, item) { return sum + item.subtotal }, 0)
      self.setData({ items: items, subtotal: subtotal })
      self.recompute()
    })
  },
  onDecrease: function(e) {
    var id = e.currentTarget.dataset.id
    var item = this.data.items.find(function(row) { return row.id === id })
    if (!item || item.quantity <= 1 || this._cartMutating) return
    this.updateQuantity(id, item.quantity - 1)
  },
  onIncrease: function(e) {
    var id = e.currentTarget.dataset.id
    var item = this.data.items.find(function(row) { return row.id === id })
    if (!item || this._cartMutating) return
    this.updateQuantity(id, item.quantity + 1)
  },
  updateQuantity: function(id, quantity) {
    var self = this
    this._cartMutating = true
    cartApi.updateCartItem(id, { quantity: quantity })
      .then(function() { return self.reloadCart() })
      .then(function() { self._cartMutating = false })
      .catch(function() { self._cartMutating = false })
  },
  onDelete: function(e) {
    if (this._cartMutating) return
    var id = e.currentTarget.dataset.id
    var self = this
    wx.showModal({
      title: '提示',
      content: '确认删除该商品？',
      success: function(result) {
        if (!result.confirm) return
        self._cartMutating = true
        cartApi.deleteCartItem(id)
          .then(function() {
            self.setData({ cartItemIds: self.data.cartItemIds.filter(function(itemId) { return itemId !== id }) })
            return self.reloadCart()
          })
          .then(function() { self._cartMutating = false })
          .catch(function() { self._cartMutating = false })
      },
    })
  },

  // 优惠组件回传：discount 是服务端算好的券抵扣额；封顶到「小计−自取优惠」在 recompute 里做
  onBenefitsChange: function(e) {
    var d = e.detail || {}
    this.setData({
      couponId: d.couponId === undefined ? null : d.couponId,
      gifts: d.gifts || [],
      discount: d.discount || 0,
      pointsUsed: d.pointsUsed || 0,
      benefitsLoading: !!d.loading,
    })
    this.recompute()
  },

  // ── 出路 ───────────────────────────────────────────────────
  goDelivery: function() {
    app.setLocalMode('DELIVERY')
    wx.navigateBack()
  },
  goExpress: function() {
    app.setShoppingChannel('EXPRESS')
    wx.switchTab({ url: '/pages/index/index' })
  },
  contactShop: function() {
    var phone = this.data.meta && this.data.meta.store && this.data.meta.store.phone
    if (!phone) { wx.showToast({ title: '商家电话暂未设置', icon: 'none' }); return }
    wx.makePhoneCall({ phoneNumber: phone })
  },
  openStore: function() {
    var s = this.data.meta && this.data.meta.store
    if (!s || s.latE6 == null || s.lngE6 == null) return
    wx.openLocation({ latitude: s.latE6 / 1e6, longitude: s.lngE6 / 1e6, name: s.name || '门店', address: (s.district || '') + (s.address || '') })
  },
  goLegal: function(e) {
    wx.navigateTo({ url: '/pages/legal/index?type=' + e.currentTarget.dataset.type })
  },

  // ── 提交 ───────────────────────────────────────────────────
  onSubmit: function() {
    var act = this.data.action || {}
    var self = this
    if (act.action === 'reslot') {
      this.loadSlots(false)
      this.setData({ pickerOpen: true })
      return
    }
    if (act.disabled || act.action !== 'submit') return
    requestSubscribe(this.data.subscribeTemplateIds, function() { self.doSubmit() })
  },

  doSubmit: function() {
    if (this.data.submitting || !this.data.selected) return
    this.setData({ submitting: true })
    this.recompute()
    var self = this
    var name = (this.data.contactName || '').trim()
    orderApi.createOrder({
      cartItemIds: this.data.cartItemIds,
      deliveryType: 'PICKUP',
      pickupAt: this.data.selected.startAt,
      pickupContact: name ? { name: name.slice(0, 32), phone: this.data.contactPhone.trim() } : { phone: this.data.contactPhone.trim() },
      remark: this.data.remark ? this.data.remark.slice(0, 20) : undefined,
      couponId: this.data.couponId || undefined,
      gifts: this.data.gifts && this.data.gifts.length ? this.data.gifts : undefined,
      // 幂等键。失败时故意不换：超时那一类失败服务端可能已建单，再按一次带同一个 id 就拿回那张单
      clientRequestId: this._clientRequestId,
    }, true)
      .then(function(res) {
        self._clientRequestId = newClientRequestId()
        wx.showToast({ title: '下单成功，请在 ' + self.data.payTimeoutMin + ' 分钟内完成支付', icon: 'none', duration: 1500 })
        setTimeout(function() {
          wx.redirectTo({ url: '/pages/order/detail?id=' + res.orderId + '&autopay=1' })
        }, 800)
      })
      .catch(function(err) {
        self.setData({ submitting: false })
        self.recompute()
        self.handleSubmitError(err)
      })
  },

  handleSubmitError: function(err) {
    var code = err.code
    // 商品问题：刷车让顾客看到真实库存/在售状态
    if (code === 42201 || code === 42202 || code === 42224) {
      wx.showToast({ title: err.message || '商品信息已变化，请确认后重试', icon: 'none', duration: 2500 })
      this.reloadCart().catch(function() {})
      return
    }
    // 优惠项在别处变了：只刷组件
    if (code === 42250 || code === 42251 || code === 42252 || code === 42253 || code === 42254) {
      wx.showToast({ title: err.message || '优惠已变化，请重新选择', icon: 'none', duration: 2500 })
      var benefits = this.selectComponent('#benefits')
      if (benefits) benefits.refresh()
      return
    }
    // 42281 时段不可选：重拉时段、清选择、打开选择器让顾客重选
    if (code === 42281) {
      wx.showToast({ title: err.message || '该时段已不可选，请重新选择', icon: 'none', duration: 2500 })
      this.setData({ selected: null, slotStale: false })
      this.loadSlots(false)
      this.setData({ pickerOpen: true })
      return
    }
    // 42280 自取不可用 / 42282 门槛：刷 meta，按钮按最新状态变
    if (code === 42280 || code === 42282) {
      wx.showToast({ title: err.message, icon: 'none', duration: 3000 })
      this.loadMeta()
      return
    }
    wx.showToast({ title: err.message || '下单失败，请重试', icon: 'none', duration: 2500 })
  },
})
```

- [ ] **Step 8: 页面 `pages/local/pickup.wxml`**

```xml
<wxs src="../../utils/price.wxs" module="pricefmt" />
<view class="page">
  <view wx:if="{{headNotice}}" class="head-notice {{blockReason ? '' : 'head-notice-soft'}}">
    <text class="head-notice-text">{{headNotice}}</text>
    <view wx:if="{{blockReason}}" class="head-notice-action" bindtap="goDelivery">改用外送</view>
  </view>

  <!-- 取餐门店 -->
  <view class="section card store-section">
    <view class="section-title">取餐门店</view>
    <view class="store-row" bindtap="openStore">
      <view class="store-body">
        <text class="store-name">{{meta.store.name || '门店'}}</text>
        <text class="store-address">{{meta.store.district}}{{meta.store.address}}</text>
      </view>
      <view class="store-acts">
        <view wx:if="{{meta.store.latE6 != null}}" class="store-act">导航</view>
        <view class="store-act" catchtap="contactShop">电话</view>
      </view>
    </view>
  </view>

  <!-- 取餐时间 -->
  <view class="section card slot-section" bindtap="openPicker">
    <view class="section-title">取餐时间</view>
    <view wx:if="{{slotsLoading && !selected}}" class="slot-muted">正在获取可取时段…</view>
    <view wx:elif="{{slotsError}}" class="slot-error">
      <text>{{slotsError}}</text>
      <view class="retry-inline" catchtap="onRetrySlots">重试</view>
    </view>
    <view wx:elif="{{selected}}" class="slot-value {{slotStale ? 'slot-stale' : ''}}">
      <text class="slot-text">{{selected.text}}</text>
      <text wx:if="{{slotStale}}" class="slot-stale-tip">该时段已过，请重选</text>
      <text class="arrow icon icon-arrow"></text>
    </view>
    <view wx:elif="{{blockReason}}" class="slot-muted">{{blockReason}}</view>
    <view wx:else class="slot-muted">今日已无可取时段，请选择其它日期 ›</view>
    <text class="slot-hint">最早可取时间已含备餐时长；到店凭手机尾号取餐</text>
  </view>

  <!-- 取餐人 -->
  <view class="section card contact-section">
    <view class="section-title">取餐人</view>
    <view class="field-row">
      <text class="row-label">姓名</text>
      <input class="field-input" value="{{contactName}}" maxlength="32" placeholder="可不填" placeholder-class="field-placeholder" bindinput="onNameInput" />
    </view>
    <view class="field-row">
      <text class="row-label">手机号</text>
      <input class="field-input" type="number" value="{{contactPhone}}" maxlength="11" placeholder="到店报尾号取餐" placeholder-class="field-placeholder" bindinput="onPhoneInput" />
    </view>
  </view>

  <!-- 商品明细 -->
  <view class="section card">
    <view class="section-title">商品明细</view>
    <view wx:for="{{items}}" wx:key="id" class="item-row">
      <view class="item-img-wrap">
        <image wx:if="{{item.productImage}}" class="item-img" src="{{item.productImage}}" mode="aspectFill" />
        <view wx:else class="item-img img-placeholder"></view>
      </view>
      <view class="item-info">
        <text class="item-name">{{item.productName}}</text>
        <text wx:if="{{item.specText}}" class="item-spec">{{item.specText}}</text>
        <text class="item-price">¥{{pricefmt.fen(item.price)}}</text>
      </view>
      <view class="item-actions">
        <view class="stepper">
          <view class="stepper-btn {{item.quantity <= 1 ? 'disabled' : ''}}" bindtap="onDecrease" data-id="{{item.id}}">−</view>
          <text class="stepper-num">{{item.quantity}}</text>
          <view class="stepper-btn" bindtap="onIncrease" data-id="{{item.id}}">+</view>
        </view>
        <text class="item-delete" bindtap="onDelete" data-id="{{item.id}}">删除</text>
      </view>
    </view>
  </view>

  <!-- 优惠券与积分赠品。subtotal 传原小计：券门槛按原小计判（spec P6）；运费恒 0 -->
  <checkout-benefits
    id="benefits"
    channel="LOCAL"
    subtotal="{{subtotal}}"
    shipping-fee="{{0}}"
    disabled="{{submitting}}"
    bind:change="onBenefitsChange"
  />

  <view class="section card remark-section">
    <view class="remark-row">
      <text class="row-label">备注</text>
      <textarea class="remark-input" value="{{remark}}" maxlength="20" auto-height placeholder="20 字以内，如不要辣" placeholder-class="remark-placeholder" bindinput="onRemarkInput" />
    </view>
  </view>

  <!-- 金额明细：商品金额 / 自取优惠 / 优惠券 / 积分赠品 / 应付金额（spec §5.4） -->
  <view class="section card amount-section">
    <view class="section-title">金额明细</view>
    <view class="sum-row">
      <text class="sum-k">商品金额</text>
      <text class="sum-v">¥{{pricefmt.fen(subtotal)}}</text>
    </view>
    <view wx:if="{{pickupDiscount > 0}}" class="sum-row">
      <text class="sum-k">自取优惠</text>
      <text class="sum-v sum-cut">−¥{{pricefmt.fen(pickupDiscount)}}</text>
    </view>
    <view wx:if="{{discount > 0}}" class="sum-row">
      <text class="sum-k">优惠券</text>
      <text class="sum-v sum-cut">−¥{{pricefmt.fen(discount)}}</text>
    </view>
    <view wx:if="{{pointsUsed > 0}}" class="sum-row">
      <text class="sum-k">积分赠品</text>
      <text class="sum-v">{{pointsUsed}} 积分</text>
    </view>
    <view class="sum-row sum-total">
      <text class="sum-k">应付金额</text>
      <text wx:if="{{action.amountState === 'ready'}}" class="sum-v sum-pay">¥{{pricefmt.fen(payAmount)}}</text>
      <text wx:else class="sum-v sum-wait">待计算</text>
    </view>
  </view>

  <view class="spacer"></view>
</view>

<!-- 时段选择弹层：今天/明天切换 + 时段格子 -->
<view wx:if="{{pickerOpen}}" class="sheet-mask" bindtap="closePicker">
  <view class="sheet" catchtap="noop">
    <view class="sheet-head">
      <text class="sheet-title">选择取餐时间</text>
      <text class="sheet-close" bindtap="closePicker">关闭</text>
    </view>
    <view class="day-tabs">
      <view wx:for="{{days}}" wx:key="date" class="day-tab {{activeDay === index ? 'active' : ''}}" bindtap="selectDay" data-idx="{{index}}">
        <text>{{item.label}}</text>
        <text wx:if="{{item.empty}}" class="day-empty">无可取时段</text>
      </view>
    </view>
    <scroll-view scroll-y class="slot-grid-wrap">
      <view wx:if="{{days[activeDay] && days[activeDay].slots.length}}" class="slot-grid">
        <view wx:for="{{days[activeDay].slots}}" wx:key="startAt"
              class="slot-cell {{selected && selected.startAt === item.startAt ? 'active' : ''}}"
              bindtap="selectSlot" data-idx="{{index}}">{{item.label}}</view>
      </view>
      <view wx:else class="slot-grid-empty">这一天已无可取时段</view>
    </scroll-view>
  </view>
</view>

<view class="bottom-bar">
  <view wx:if="{{blockReason && action.amountState === 'blocked'}}" class="block-strip">
    <text class="block-strip-text">{{blockReason}}</text>
    <view class="block-strip-acts">
      <view class="escape-btn" bindtap="goDelivery">改用外送</view>
      <view class="escape-btn" bindtap="goExpress">改用全国邮寄</view>
    </view>
  </view>
  <view class="agree-row">
    <text>提交订单即表示同意</text>
    <text class="agree-link" bindtap="goLegal" data-type="agreement">《用户协议》</text>
    <text>和</text>
    <text class="agree-link" bindtap="goLegal" data-type="privacy">《隐私政策》</text>
  </view>
  <view class="bottom-main">
    <view class="bottom-total-wrap">
      <text class="bottom-total-label">合计</text>
      <block wx:if="{{action.amountState === 'ready'}}">
        <text class="price-symbol">¥</text>
        <text class="price-int bottom-total-int">{{pricefmt.int(pricefmt.fen(payAmount))}}</text>
        <text class="price-dec">{{pricefmt.dec(pricefmt.fen(payAmount))}}</text>
      </block>
      <text wx:else class="bottom-calculating">待计算</text>
    </view>
    <view class="submit-btn btn-primary {{action.disabled ? 'btn-disabled' : ''}}" bindtap="onSubmit">
      <text>{{action.text}}</text>
    </view>
  </view>
</view>
```

- [ ] **Step 9: 页面 `pages/local/pickup.wxss`**。先把 `pages/local/confirm.wxss` 里这些选择器**原样复制**过来（不要 import，两页各自独立）：`.page`、`.section`、`.section-title`、`.head-notice`、`.head-notice-text`、`.head-notice-action`、`.item-row`…`.item-delete`（商品明细整段）、`.stepper*`、`.remark-row`、`.row-label`、`.remark-input`、`.remark-placeholder`、`.spacer`、`.bottom-bar`、`.escape-btn`、`.agree-row`、`.agree-link`、`.bottom-main`、`.bottom-total-wrap`、`.bottom-total-label`、`.bottom-total-int`、`.bottom-calculating`、`.submit-btn`、`.sum-row`…`.sum-pay`（金额明细整段）、`.block-strip*`（阻塞条整段）、`.retry-inline`。然后追加本页专属：

```css
/* ── 自取专属 ─────────────────────────────────────────── */
.head-notice-soft { background: var(--gray-bg); color: var(--text-2); }
.store-row { display: flex; align-items: center; gap: 16rpx; }
.store-body { flex: 1; min-width: 0; }
.store-name { display: block; color: var(--text-1); font-size: 30rpx; font-weight: 600; }
.store-address { display: block; margin-top: 6rpx; color: var(--text-2); font-size: 24rpx; line-height: 1.5; }
.store-acts { display: flex; gap: 12rpx; flex-shrink: 0; }
.store-act { padding: 8rpx 18rpx; border: 1rpx solid var(--brand); border-radius: 999rpx; color: var(--brand); font-size: 23rpx; }
.slot-value { display: flex; align-items: center; gap: 12rpx; }
.slot-text { flex: 1; color: var(--text-1); font-size: 30rpx; font-weight: 600; }
.slot-stale .slot-text { color: var(--text-3); text-decoration: line-through; }
.slot-stale-tip { color: var(--brand); font-size: 23rpx; }
.slot-muted { color: var(--text-3); font-size: 26rpx; line-height: 1.5; }
.slot-error { display: flex; align-items: center; justify-content: space-between; color: var(--brand); font-size: 26rpx; }
.slot-hint { display: block; margin-top: 10rpx; color: var(--text-3); font-size: 23rpx; }
.arrow { width: 28rpx; height: 28rpx; }
.field-row { display: flex; align-items: center; gap: 20rpx; padding: 12rpx 0; border-bottom: 1rpx solid var(--divider); }
.field-row:last-child { border-bottom: none; }
.field-input { flex: 1; min-height: 64rpx; color: var(--text-1); font-size: 28rpx; }
.field-placeholder { color: var(--text-disabled); }

/* 时段弹层：最大高度约 70vh、含安全区（与券弹层同一套约定） */
.sheet-mask { position: fixed; z-index: 100; inset: 0; background: rgba(0, 0, 0, 0.45); }
.sheet { position: absolute; left: 0; right: 0; bottom: 0; max-height: 70vh; display: flex; flex-direction: column; padding: 24rpx 24rpx calc(24rpx + env(safe-area-inset-bottom)); background: var(--card); border-radius: 24rpx 24rpx 0 0; box-sizing: border-box; }
.sheet-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 16rpx; }
.sheet-title { font-size: 30rpx; font-weight: 600; color: var(--text-1); }
.sheet-close { font-size: 26rpx; color: var(--text-3); }
.day-tabs { display: flex; gap: 16rpx; padding: 8rpx 0 16rpx; }
.day-tab { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4rpx; padding: 14rpx 0; border-radius: 10rpx; background: var(--bg); color: var(--text-2); font-size: 27rpx; }
.day-tab.active { background: var(--brand-bg); color: var(--brand); font-weight: 600; }
.day-empty { font-size: 20rpx; color: var(--text-3); }
.slot-grid-wrap { flex: 1; min-height: 200rpx; max-height: 48vh; }
.slot-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14rpx; padding-bottom: 8rpx; }
.slot-cell { padding: 18rpx 0; border-radius: 10rpx; background: var(--bg); color: var(--text-1); font-size: 26rpx; text-align: center; }
.slot-cell.active { background: var(--brand); color: #fff; font-weight: 600; }
.slot-grid-empty { padding: 60rpx 0; color: var(--text-3); font-size: 26rpx; text-align: center; }
```

- [ ] **Step 10: 注册页面**。`app.json` 的 `"pages/local/confirm",` 之后加 `"pages/local/pickup",`。

- [ ] **Step 11: 验证**

Run: `npm run test:miniapp 2>&1 | tail -8 && node scripts/check-miniapp-es5.mjs apps/miniapp/utils/pickup-checkout-state.js apps/miniapp/pages/local/pickup.js && grep -c "pages/local/pickup" apps/miniapp/app.json && grep -n "addressId\|quoteToken" apps/miniapp/pages/local/pickup.js; echo "grep exit=$?"`
Expected: 单测全过；两文件 ES5 ✔；app.json 计数 1；最后一个 grep 无输出（exit=1）。

- [ ] **Step 12: Commit**

```bash
git add apps/miniapp/api/local.js apps/miniapp/api/order.js apps/miniapp/utils/pickup-checkout-state.js apps/miniapp/pages/local/pickup.js apps/miniapp/pages/local/pickup.wxml apps/miniapp/pages/local/pickup.wxss apps/miniapp/pages/local/pickup.json apps/miniapp/app.json tests/miniapp/pickup-checkout-state.test.cjs
git commit -m "小程序：自取结算页（门店/时段弹层/取餐人/优惠/金额明细）与纯函数状态机；时段与取餐人接口封装"
```

---

### Task 4: 订单列表、订单详情、状态标签、「关于」页

**Files:**
- Modify: `apps/miniapp/pages/order/list.js`、`list.wxml`、`list.wxss`
- Modify: `apps/miniapp/pages/order/detail.js`、`detail.wxml`、`detail.wxss`
- Modify: `apps/miniapp/components/order-status-tag/index.js`
- Modify: `apps/miniapp/pages/about/index.js`、`index.wxml`
- Test: `tests/miniapp/order-channel.test.cjs`

**Interfaces:**
- Consumes：Task 3 的 `getOrders({ channel })`；服务端 `GET /orders?channel=LOCAL`；详情的 `pickup` 节（`pickupAt/pickupReadyAt/prepStartAt/slotLabel/store{name,phone,address,latE6,lngE6}`）、`canSelfCancel`、`canRequestCancel`、`pickupDiscountAmount`、`pickupReadyAt`；`/local/meta.businessHours`。

- [ ] **Step 1: 先改测试**。`tests/miniapp/order-channel.test.cjs`：
  - 用例「订单列表默认只看当前渠道；请求里必须出现 deliveryType」改名为「…请求里必须出现 channel」，断言改为 `indexOf('channel=LOCAL') !== -1`；
  - 用例「切到「全部订单」：不再带 deliveryType…」断言改为 `indexOf('channel=') === -1`；
  - 文件末尾追加：

```js
test('自取单卡片：标签「自取」、待取餐/已取餐文案', async function () {
  const ctx = makeCtx('LOCAL', [
    { id: 11, deliveryType: 'PICKUP', status: 'SHIPPED', items: [], actualAmount: 1200 },
    { id: 12, deliveryType: 'PICKUP', status: 'COMPLETED', items: [], actualAmount: 1200 },
    { id: 13, deliveryType: 'LOCAL', status: 'SHIPPED', items: [], actualAmount: 1200 },
  ])
  const page = loadPage('../../apps/miniapp/pages/order/list.js', ctx)
  page.onLoad.call(page, { deliveryType: 'LOCAL' })
  page.onShow.call(page)
  await settle(); await settle()
  const byId = (id) => page.data.orders.find((o) => o.id === id)
  assert.equal(byId(11).typeLabel, '自取'); assert.equal(byId(11).typeClass, 'pickup')
  assert.equal(byId(11).statusLabel, '待取餐')
  assert.equal(byId(12).statusLabel, '已取餐')
  assert.equal(byId(13).statusLabel, '配送中', '外送文案不变')
  page.onUnload.call(page)
})

test('自取单详情：门店卡、尾号+时段、时间线、按钮按服务端 canSelfCancel', async function () {
  const order = {
    id: 21, orderNo: 'ORD21', deliveryType: 'PICKUP', status: 'SHIPPED',
    createdAt: '2026-09-11T02:00:00Z', paidAt: '2026-09-11T02:01:00Z', acceptedAt: '2026-09-11T02:05:00Z',
    pickupAt: '2026-09-11T04:00:00Z', pickupReadyAt: '2026-09-11T03:40:00Z', pickupDiscountAmount: 60,
    receiverName: '张三', receiverPhone: '13800001234', receiverFullAddress: '四川省自贡市自流井区丹桂40栋底楼',
    totalAmount: 1200, shippingFee: 0, actualAmount: 1140, refundedAmount: 0, discountAmount: 0, pointsUsed: 0,
    items: [{ id: 1, productName: '凉拌牛肉', productPrice: 1200, quantity: 1, subtotal: 1200 }], refunds: [], afterSale: null,
    canSelfCancel: false, canRequestCancel: false, subscribeTemplateIds: [],
    pickup: { pickupAt: '2026-09-11T04:00:00Z', pickupReadyAt: '2026-09-11T03:40:00Z', prepStartAt: '2026-09-11T03:35:00Z', slotLabel: '今天 12:00–12:30', store: { name: '阿福凉菜', phone: '15309003232', address: '自流井区丹桂40栋底楼', latE6: 29341126, lngE6: 104779018 } },
  }
  const ctx = makeCtx('LOCAL', [])
  ctx.wx.request = (r) => {
    ctx.urls.push(r.url)
    r.success({ statusCode: 200, data: { code: 0, message: 'ok', data: order } })
  }
  Object.assign(ctx.wx, { showLoading() {}, hideLoading() {}, openLocation() {}, makePhoneCall() {} })
  const page = loadPage('../../apps/miniapp/pages/order/detail.js', ctx)
  page.startCourierPoll = () => {}
  page.onLoad.call(page, { id: '21' })
  await settle(); await settle()
  const o = page.data.order
  assert.equal(o.isPickup, true)
  assert.equal(o.statusLabel, '待取餐')
  assert.equal(o.phoneTail, '1234')
  assert.equal(o.pickupSlotLabel, '今天 12:00–12:30')
  assert.equal(o.pickupStore.name, '阿福凉菜')
  assert.equal(o.canSelfCancel, false, '以服务端 canSelfCancel 为准')
  assert.equal(o.pickupDiscountAmountText, '0.60')
  assert.ok(o.timeline.some((s) => s.label === '已备好 · 请来取餐' && s.done), JSON.stringify(o.timeline))
  assert.ok(o.timeline.some((s) => s.label === '已取餐' && !s.done))
  page.onUnload.call(page)
})
```

（`loadPage` 里已经把 `startTicker` 换成空实现；详情页的 `startCourierPoll` 对非 LOCAL 单本就直接 return，上面再覆盖一次只是保险。）

- [ ] **Step 2: 跑，确认失败**

Run: `node --test tests/miniapp/order-channel.test.cjs 2>&1 | tail -12`
Expected: 「channel=LOCAL」两条与新增两条失败。

- [ ] **Step 3: 订单列表**。`list.js`：

```js
// 自取单：PAID 是「待接单」，SHIPPED 复用为「待取餐」，COMPLETED 为「已取餐」（spec P8）
var PICKUP_STATUS_LABEL = Object.assign({}, EXPRESS_STATUS_LABEL, {
  PAID: '待接单',
  SHIPPED: '待取餐',
  COMPLETED: '已取餐',
})
var TYPE_META = {
  LOCAL: { label: '同城', cls: 'local' },
  PICKUP: { label: '自取', cls: 'pickup' },
  EXPRESS: { label: '邮寄', cls: 'express' },
}
```

`decorate` 里 `var statusLabels = …` 改为三分支：`order.deliveryType === 'LOCAL' ? LOCAL_STATUS_LABEL : order.deliveryType === 'PICKUP' ? PICKUP_STATUS_LABEL : EXPRESS_STATUS_LABEL`；返回对象加 `typeLabel: (TYPE_META[order.deliveryType] || TYPE_META.EXPRESS).label, typeClass: (TYPE_META[order.deliveryType] || TYPE_META.EXPRESS).cls,`。

`loadOrders` 的 `deliveryType: this.data.scope === 'channel' ? this.data.channel : undefined,` 改为：

```js
      // 同城渠道下一次拿外送 + 自取两类（服务端 channel=LOCAL 展开为 LOCAL,PICKUP）；
      // scope='all' 时不传，两个渠道都回来
      channel: this.data.scope === 'channel' ? this.data.channel : undefined,
```

`list.wxml` 的标签那行改为 `<text class="delivery-type-tag {{item.typeClass}}">{{item.typeLabel}}</text>`。`list.wxss` 在 `.delivery-type-tag.express` 之后加：

```css
.delivery-type-tag.pickup {
  background: #eef8f0;
  color: #16a34a;
}
```

- [ ] **Step 4: 状态标签组件**。`order-status-tag/index.js` 整文件替换：

```js
// 订单状态 → 文案映射（配色在 wxss 按 class 区分，规范见 docs/design-system.md）
const STATUS_LABEL = {
  PENDING_PAYMENT: '待付款',
  PAID: '待发货',
  PREPARING: '备餐中',
  REFUNDING: '退款中',
  SHIPPED: '已发货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
}
// 自取（2026-09-11）：同一套状态、不同说法
const PICKUP_LABEL = { PAID: '待接单', SHIPPED: '待取餐', COMPLETED: '已取餐' }

Component({
  properties: {
    // 后端订单状态枚举
    status: { type: String, value: '' },
    // 'EXPRESS' | 'LOCAL' | 'PICKUP'，只有 PICKUP 会改文案
    deliveryType: { type: String, value: '' },
  },
  data: {
    label: '',
  },
  observers: {
    'status, deliveryType': function(status, deliveryType) {
      var label = deliveryType === 'PICKUP' && PICKUP_LABEL[status] ? PICKUP_LABEL[status] : (STATUS_LABEL[status] || status)
      this.setData({ label: label })
    },
  },
})
```

- [ ] **Step 5: 订单详情 JS**。`detail.js`：

在 `STATUS_LABEL` 之后加：

```js
var PICKUP_STATUS_LABEL = Object.assign({}, STATUS_LABEL, { PAID: '待接单', SHIPPED: '待取餐', COMPLETED: '已取餐' })
```

在 `buildLocalTimeline` 之后加：

```js
// 自取单时间线：提交 → 支付 → 商家接单·备餐中 → 已备好·请来取餐 → 已取餐。
// 取消/退款事实那两行与同城完全同款。
function buildPickupTimeline(order) {
  var steps = [{ label: '提交订单', time: t(order.createdAt), done: true }]

  if (order.status === 'CANCELLED') {
    if (order.paidAt) steps.push({ label: '支付成功', time: t(order.paidAt), done: true })
    var rejectReasonCancelled = rejectReasonText(order.cancelReason)
    steps.push({
      label: rejectReasonCancelled ? ('商家已拒单 · ' + rejectReasonCancelled) : '订单已取消',
      time: t(order.cancelledAt),
      done: true,
      extra: rejectReasonCancelled ? '' : (order.cancelReason || ''),
    })
    return steps
  }

  if (order.status === 'REFUNDING' || order.status === 'REFUNDED') {
    steps.push({ label: '支付成功', time: t(order.paidAt), done: !!order.paidAt })
    if (order.acceptedAt) steps.push({ label: '商家接单 · 备餐中', time: t(order.acceptedAt), done: true })
    if (order.pickupReadyAt) steps.push({ label: '已备好 · 请来取餐', time: t(order.pickupReadyAt), done: true })
    if (order.completedAt) steps.push({ label: '已取餐', time: t(order.completedAt), done: true })
    var rejectReason = rejectReasonText(order.cancelReason)
    var byCustomer = !rejectReason && !!order.cancelReason && order.cancelReason.indexOf('用户') === 0
    steps.push({
      label: rejectReason ? ('商家已拒单 · ' + rejectReason) : (byCustomer ? '申请退款' : '商家发起退款'),
      time: t(order.cancelledAt),
      done: true,
      extra: (rejectReason || byCustomer) ? '' : (order.cancelReason || ''),
    })
    var refundDone = order.status === 'REFUNDED' && order.refundedAmount > 0
    var refundFact = refundFactText(order)
    steps.push({ label: refundFact.label, time: refundDone ? t(order.refundedAt) : '', done: refundDone, extra: refundFact.extra })
    return steps
  }

  steps.push({ label: '支付成功', time: t(order.paidAt), done: !!order.paidAt })
  steps.push({ label: '商家接单 · 备餐中', time: t(order.acceptedAt), done: !!order.acceptedAt })
  steps.push({ label: '已备好 · 请来取餐', time: t(order.pickupReadyAt), done: !!order.pickupReadyAt })
  steps.push({ label: '已取餐', time: t(order.completedAt), done: !!order.completedAt })
  return steps
}

// 自取单顶部那句话：顾客此刻最想知道「我现在该干嘛」
function pickupHintOf(order, canSelfCancel) {
  if (order.status === 'PAID') return canSelfCancel ? '商家接单前可直接取消' : '商家即将接单'
  if (order.status === 'PREPARING') return '备餐中，备好后会通知您'
  if (order.status === 'SHIPPED') return '已备好，凭手机尾号到店取餐'
  if (order.status === 'COMPLETED') return '已取餐，感谢惠顾'
  return ''
}
```

`decorateOrder` 里：
- `var isExpress = …` 之后加 `var isPickup = order.deliveryType === 'PICKUP'`。
- `statusLabel: STATUS_LABEL[order.status] || order.status,` 改为 `statusLabel: (isPickup ? PICKUP_STATUS_LABEL : STATUS_LABEL)[order.status] || order.status,`。
- `isExpress: isExpress,` 之后加：

```js
    isPickup: isPickup,
    phoneTail: (order.receiverPhone || '').slice(-4),
    pickupSlotLabel: order.pickup ? (order.pickup.slotLabel || '') : '',
    pickupStore: order.pickup ? order.pickup.store : null,
    pickupDiscountAmountText: formatPrice(order.pickupDiscountAmount || 0),
```

- `canSelfCancel:` 那行改为：

```js
    // 服务端从 2026-09-11 起下发 canSelfCancel（自取按「开始备餐时刻」判）；老服务端没有就按旧规则算
    canSelfCancel: typeof order.canSelfCancel === 'boolean'
      ? order.canSelfCancel
      : (order.status === 'PENDING_PAYMENT' || (order.status === 'PAID' && !order.acceptedAt)),
```

- `showLocalCancelRejected` 的 `(isLocal || isExpress)` 改为 `(isLocal || isExpress || isPickup)`；`showLocalCancelUnavailable` 改为：

```js
    showLocalCancelUnavailable:
      ((isLocal || isExpress) && order.status === 'PREPARING' && !order.cancelRequestedAt && !order.cancelRequestRejectedAt && order.canRequestCancel !== true)
      || (isPickup && ['PAID', 'PREPARING'].indexOf(order.status) !== -1 && !order.cancelRequestedAt && !order.cancelRequestRejectedAt && order.canRequestCancel !== true && order.canSelfCancel !== true),
```

- `timeline:` 改为 `timeline: isPickup ? buildPickupTimeline(order) : isLocal ? buildLocalTimeline(order) : buildTimeline(order),`。
- 返回对象末尾（`items:` 之前）加 `pickupHint: isPickup ? pickupHintOf(order, typeof order.canSelfCancel === 'boolean' ? order.canSelfCancel : false) : '',`。

`onCancelOrder`：`content` 三元改为：

```js
      title: isPaid ? (isPickup ? '取消订单' : '申请退款') : '取消订单',
      content: !isPaid
        ? '确认取消该订单？取消后需重新下单。'
        : this.data.order.isPickup
          ? '取消后货款会立即原路退回微信，一般几分钟内到账。确认取消？'
          : '商家尚未接单，取消后货款会立即原路退回微信，一般几分钟内到账。确认退款？',
```

（在 `var isPaid = …` 之后加一行 `var isPickup = !!this.data.order.isPickup`。）`onRequestCancel` 的 `content` 改为 `this.data.order.isPickup ? '商家确认后将全额退款。确认提交取消申请？' : '商家确认后将全额退款，含配送费。确认提交取消申请？'`。加一个方法：

```js
  onOpenStore() {
    var s = this.data.order && this.data.order.pickupStore
    if (!s || s.latE6 == null || s.lngE6 == null) return
    wx.openLocation({ latitude: s.latE6 / 1e6, longitude: s.lngE6 / 1e6, name: s.name || '门店', address: s.address || '' })
  },
```

- [ ] **Step 6: 订单详情 WXML/WXSS**。`detail.wxml`：
  - 「Address」那张 `<view class="card">` 加 `wx:if="{{!order.isPickup}}"`，紧跟其后加自取卡：

```xml
  <!-- 自取：尾号 + 时段是店员认单的两样东西，放最大；门店卡替代收货地址卡 -->
  <view class="card pickup-card" wx:if="{{order.isPickup}}">
    <view class="pickup-head">
      <text class="pickup-tail">尾号 {{order.phoneTail}}</text>
      <text class="pickup-slot" wx:if="{{order.pickupSlotLabel}}">{{order.pickupSlotLabel}} 取</text>
    </view>
    <text class="pickup-hint" wx:if="{{order.pickupHint}}">{{order.pickupHint}}</text>
    <view class="info-row" wx:if="{{order.pickupStore}}">
      <text class="info-label">取餐门店</text>
      <view class="info-value"><text>{{order.pickupStore.name}}</text><text class="info-sub"> · {{order.pickupStore.address}}</text></view>
    </view>
    <view class="info-row">
      <text class="info-label">取餐人</text>
      <text class="info-value">{{order.receiverName}} {{order.receiverPhone}}</text>
    </view>
    <view class="pickup-acts">
      <view class="pickup-act" wx:if="{{order.pickupStore && order.pickupStore.latE6 != null}}" bindtap="onOpenStore">导航到店</view>
      <view class="pickup-act" bindtap="onContactShop">联系商家</view>
    </view>
  </view>
```

  - 取消申请卡的外层条件 `(order.isLocal || order.isExpress)` 改为 `(order.isLocal || order.isExpress || order.isPickup)`；卡内 `wx:elif="{{order.canRequestCancel}}"` 分支里加一行 `<text class="local-cancel-copy" wx:if="{{order.isPickup}}">可申请取消，商家确认后全额退款</text>`（放在 `graceMin` 那两行之前，并把那两行改为 `wx:if="{{!order.isPickup && graceMin}}"` / `wx:elif="{{!order.isPickup && order.cancelDeadlineText}}"`）；最后那句「订单已开始…」改为 `{{order.isPickup ? '餐品已在准备，如有问题请联系商家' : ('订单已开始' + (order.isExpress ? '备货' : '制作') + '，如有问题请联系商家')}}`。
  - Amount 卡：「优惠券」行之前加 `<view class="amount-row" wx:if="{{order.pickupDiscountAmount > 0}}"><text class="amount-label">自取优惠</text><text class="amount-value discount">−¥{{order.pickupDiscountAmountText}}</text></view>`；「运费」行加 `wx:if="{{!order.isPickup}}"`。
  - 底部按钮：自助取消按钮文案改为 `{{order.status === 'PENDING_PAYMENT' || order.isPickup ? '取消订单' : '申请退款'}}`；「申请取消」按钮条件改为 `(order.isLocal || order.isExpress || order.isPickup) && order.canRequestCancel`；「确认收货」按钮条件改为 `order.status === 'SHIPPED' && !order.isLocal && !order.isPickup`。

`detail.wxss` 追加：

```css
/* ── 自取卡 ───────────────────────────────────────────── */
.pickup-head { display: flex; align-items: baseline; gap: 20rpx; margin-bottom: 8rpx; }
.pickup-tail { font-size: 40rpx; font-weight: 700; color: var(--brand); }
.pickup-slot { font-size: 28rpx; font-weight: 600; color: var(--text-1); }
.pickup-hint { display: block; margin-bottom: 14rpx; font-size: 24rpx; color: var(--text-2); }
.pickup-acts { display: flex; gap: 16rpx; margin-top: 14rpx; }
.pickup-act { padding: 10rpx 22rpx; border: 1rpx solid var(--brand); border-radius: 999rpx; color: var(--brand); font-size: 24rpx; }
```

- [ ] **Step 7: 「关于」页营业时间改读服务端**。`about/index.js` 整文件替换：

```js
const shop = require('../../config/shop')
const { callShop } = require('../../utils/contact')
const { getLocalMeta } = require('../../api/local')

Page({
  data: {
    shop: shop,
    // 营业时间只有后台那一份（local_delivery.businessHours）。config/shop.js 的字符串只作接口失败兜底
    businessHoursText: shop.businessHours,
  },

  onLoad() {
    var self = this
    getLocalMeta()
      .then(function(meta) {
        var hours = (meta && meta.businessHours) || []
        var text = hours.map(function(h) { return h.start + '–' + h.end }).join('、')
        if (text) self.setData({ businessHoursText: text })
      })
      .catch(function() {})
  },

  onCall() {
    callShop()
  },

  onCopyAddress() {
    wx.setClipboardData({ data: shop.address })
  },

  goLegal(e) {
    var type = e.currentTarget.dataset.type
    wx.navigateTo({ url: '/pages/legal/index?type=' + type })
  },
})
```

`about/index.wxml` 的 `{{shop.businessHours}}` 改为 `{{businessHoursText}}`。

- [ ] **Step 8: 跑全部单测**

Run: `npm run test:miniapp 2>&1 | tail -10`
Expected: 全部通过。

- [ ] **Step 9: Commit**

```bash
git add apps/miniapp/pages/order apps/miniapp/components/order-status-tag/index.js apps/miniapp/pages/about tests/miniapp/order-channel.test.cjs
git commit -m "小程序：订单列表 channel=LOCAL 含自取、自取标签与待取餐/已取餐文案；详情自取卡/时间线/取消按钮按服务端；关于页营业时间读后台"
```

---

### Task 5: 提审清单、整体验证

**Files:**
- Modify: `docs/miniapp-release-checklist.md`

- [ ] **Step 1: 清单加自取一节**。在文件末尾追加：

```markdown
## 到店自取（2026-09-11 批次二）

- [ ] 生产 `.env` 已填 `WECHAT_TMPL_PICKUP` / `WECHAT_TMPL_PICKUP_FIELDS`（取餐提醒模板；留空只 warn 不阻塞）
- [ ] 后台「同城设置」已打开 `pickup.enabled`，配好折扣/门槛/时段粒度；`holiday` 为空
- [ ] 真机：同城主页「外送 / 自取」栏可切换；自取模式规则行显示折扣与门店地址，「›」能打开地图
- [ ] 真机：自取结算页选时段 → 填手机号 → 提交 → 微信支付 → 详情页显示「尾号 · 时段」
- [ ] 真机：店员点「已备好」后收到取餐提醒订阅消息（需先在结算页授权）
- [ ] 真机：休业 / 自取暂停时页头与结算页都被拦住，且外送不受自取暂停影响
- [ ] 「关于」页营业时间与后台一致
```

- [ ] **Step 2: 整体验证（B1–B5、B7）**

```bash
npm run test:miniapp 2>&1 | tail -6
node scripts/check-miniapp-es5.mjs apps/miniapp/utils/pickup-checkout-state.js apps/miniapp/components/local-mode-bar/index.js apps/miniapp/pages/local/pickup.js
git diff main...HEAD --stat -- apps/miniapp/pages/local/confirm.js apps/miniapp/pages/local/confirm.wxml apps/miniapp/pages/order/confirm.js
grep -c "deliveryType: 'PICKUP'" apps/miniapp/pages/local/pickup.js; grep -n "addressId\|quoteToken" apps/miniapp/pages/local/pickup.js; echo "exit=$?"
grep -c "pages/local/pickup" apps/miniapp/app.json
grep -rn "getStorageSync('localMode')\|getStorageSync(\"localMode\")" apps/miniapp/pages apps/miniapp/components; echo "exit=$?"
```

Expected：单测全过；三文件 ES5 ✔；diff --stat 无输出；计数 ≥1 且 grep exit=1；app.json 计数 1；最后一条 exit=1（页面/组件不直接读 storage）。

- [ ] **Step 3: Commit**

```bash
git add docs/miniapp-release-checklist.md
git commit -m "提审清单：到店自取一节"
```

## 手工验收（B6，开发者工具 + 真机，控制方/店主执行）

服务端起 3109（mock），后台把 `pickup.enabled=true`、折扣 PERCENT 95、门槛 1500、`businessHours` 覆盖当前时刻。开发者工具 `apps/miniapp`，`config/index.js` 的 `baseURL` 指到 `http://localhost:3109/api`（改完记得改回）。

1. 封面 → 同城：主页页头下出现「外送 / 自取」栏，两侧小字状态正确；切到自取，规则行变为「自取享 9.5 折 · 满 ¥15 起 · 地址 ›」。
2. 分类页同样有栏；加购两件；购物车条文案「去结算 · 自取」；点进自取结算页。
3. 结算页：门店卡有导航/电话；时段卡默认最早格；弹层可切今天/明天、选格；手机号空 → 按钮「请填写手机号」；填 11 位后按钮「提交订单」；金额明细有「自取优惠」行且应付 = 小计 − 优惠。
4. 提交 → 跳详情并拉起 mock 支付 → 详情顶部「待接单」，自取卡「尾号 · 时段」，无地址卡、无运费行。
5. 后台/curl `pickup-ready` → 详情刷新为「待取餐」，时间线「已备好 · 请来取餐」亮；`picked-up` → 「已取餐」。
6. 后台把自取 `paused` → 主页自取标签变「暂停接单」，页头通知「自取暂停接单」带「改用外送」；结算页按钮「暂不可自取」。
7. 后台设 `holiday` → 两侧标签灰、通知「休息中，X月X日恢复」；恢复后正常。
8. 切回外送：结算走原同城页，行为与改前一致；邮寄渠道四页无变化。
9. 「关于」页营业时间显示后台配置的时段。

## 复核与收尾（工序 02–04）

- **02 复核 · opus，新会话**：输入 = spec §5 + 本计划「验收标准」+ `git diff <批次一末尾提交>...HEAD -- apps/miniapp tests/miniapp`。重点：① 外送/邮寄链路是否真的零改动（`confirm.js` 两个文件、`local-catalog` 不传 mode 的分支）；② 自取结算页对 42281/42280 的处理是否会留下可点的旧金额按钮；③ 金额预览公式与服务端是否逐字一致；④ 模式回落（`resolveLocalMode`）与 `enterLocalChannel` 的许可提示在「只开自取」时是否合理（自取不需要定位却仍弹位置许可——本批默认保留，复核可判）；⑤ 单测桩是否遮蔽了真实行为。
- **03 回判 · fable**：逐条判定。
- **04 机械核对 · haiku**：B1–B5、B7 与白名单。

## 交给批次三（后台前端）的接口清单

本批不产出服务端接口。批次三消费的服务端字段见批次一计划末尾；批次三另需知道：小程序订单列表/详情已按 `PICKUP` 分支渲染，后台改 `pickup.slotMinutes`、折扣、门槛后小程序无需发版即生效（全部来自 `/local/meta` 与时段接口）。
