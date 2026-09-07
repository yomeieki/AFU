# 小程序双渠道导航与同城结算整改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全国邮寄和同城配送共用“主页、分类、购物车、我的”四栏导航，并把同城地址、优惠、报价、结算和订单后链路补齐为可安全提交的完整体验。

**Architecture:** 保留四个现有原生 tabBar 页面，用全局 `shoppingChannel` 决定每个页面加载 EXPRESS 或 LOCAL 内容；非 tab 流程页继续独立存在。新增纯函数状态层约束渠道和结算状态，必要的服务端改动只包含报价过期时间、订单渠道过滤和幂等下单三个契约。

**Tech Stack:** 微信原生小程序 WXML/WXSS/CommonJS、Node.js 18 `node:test`、Express、TypeScript、Prisma、MySQL、现有 shell e2e。

**Spec:** `docs/superpowers/specs/2026-09-07-miniapp-dual-channel-navigation-checkout-design.md`

## Global Constraints

- 店主确认独立预览前，不修改 `apps/miniapp/**`、`apps/server/**` 或数据库迁移。
- 不部署、不上传体验版、不调用真实配送下单接口。
- tabBar 保持四项和现有图标顺序；不增加第五项，不复制一套页面内假 tabBar。
- 同城页顶部“我的订单”必须删除，营业状态紧跟门店名靠左且不可溢出。
- 金额、配送距离、券资格、库存和最终应付金额以服务端为准。
- 全国邮寄与同城购物车、角标、查询参数、结算路由严格隔离。
- 新增小程序文件使用 ES5 语法，并通过 `scripts/check-miniapp-es5.mjs`。
  **闸门只跑新增文件，以及三个碰巧本来就是 ES5 的既有文件**（`pages/cover/index.js`、
  `pages/local/confirm.js`、`components/checkout-benefits/index.js`），当回归护栏用。
  其余既有文件（`app.js`、四个 tab 页、`api/*.js`、`pages/address/*.js`、`pages/order/*.js`、
  `pages/local/index.js`）**本来就不是 ES5**，闸门自己的文件头 `scripts/check-miniapp-es5.mjs:9-12`
  写明「只对新增文件生效」。把它们回改 ES5 是另一件事，不混进本计划。
- 每个行为修改先写失败测试并观察预期失败，再写最小实现。
- 发布必须等待“独立预览确认”和“开发者工具预览确认”两次人工门禁；本计划不执行发布。

---

## 执行期修正（2026-09-07，Task 1 交付时）

方案落地前逐条对着代码核了一遍，五处照原文做会失败或做错。下面是修正后的口径，
正文已按修正写好，**这一节只解释为什么改**。

| # | 原文 | 实际情况 | 修正 |
|---|---|---|---|
| 1 | Task 3 Step 5：`clientRequestId: z.string().uuid()` | `POST /api/orders` 是**两个渠道共用一个 schema**（`routes/orders.ts:100-124`）；邮寄结算页 `pages/order/confirm.js` 不在本计划范围、`scripts/e2e.sh` 几十处下单也不传。写成必填 = 邮寄下单与整套 e2e 当场全红 | 改 `.optional()`，不传时行为与改前逐字节一致 |
| 2 | Task 5/6/9/10：对 `pages/index/index.js`、`product/list.js`、`cart/index.js`、`user/index.js`、`order/*.js`、`address/*.js`、`api/*.js`、`app.js`、`local/index.js` 跑 ES5 闸门 | **实跑 14 个文件红 11 个**，全是 `const is reserved (1:0)`。闸门自己的文件头 `scripts/check-miniapp-es5.mjs:9-12` 就写着「既有小程序代码本身并不是纯 ES5……这道闸门只对新增文件生效」 | 闸门只跑新增文件 + 三个本来就是 ES5 的既有文件（`cover/index.js`、`local/confirm.js`、`checkout-benefits/index.js`）当回归护栏 |
| 3 | Task 5 Step 6：购物车条「使用固定 `bottom` 等于已验证的 tabBar 内容高度」 | 微信 tabBar 是画在 WebView **之外**的原生组件，tabBar 页可视区本来就不含它。留偏移会在栏与 tabBar 之间画出一条空隙。仓库里 `pages/cart/index.wxss:133-143` 这个 tabBar 页已经是 `bottom:0` | 用 `bottom: 0`，不留偏移 |
| 4 | Task 1 Step 5：`npm run preview:miniapp` | 那个服务器 `ROOT = tools/miniapp-preview`（`serve.mjs:17`），服务不了 `docs/` 下的文件 | 改用 `node docs/design/miniapp-local-v2/serve.mjs`（5195） |
| 5 | Task 2 Step 4：报价失败 `{ disabled: true, text: '重新获取运费' }` | 灰按钮写着一个动词，顾客会去点、点了没反应 | **店主选方案 B**：按钮可点，点击即重新报价。返回值增加 `action: submit\|retry\|none`，页面按 `action` 分派 |

前四条是核实出来的事实错误，第五条是店主的产品决定。

---

### Task 1: 制作独立视觉预览并取得第一道确认

**Files:**
- Create: `docs/design/miniapp-local-v2/preview.html`
- Create: `docs/design/miniapp-local-v2/preview.css`
- Create: `docs/design/miniapp-local-v2/preview.js`
- Create: `docs/design/miniapp-local-v2/README.md`

**Interfaces:**
- Consumes: 本计划 Spec §4–§10 的页面与状态定义。
- Produces: 不接真实接口的可点击预览，供店主确认布局、空间和文案。

- [x] **Step 1: 建立 375×812 与 320×568 两种手机画布**

预览入口必须提供“全国邮寄/同城配送”切换，以及以下页面按钮：主页、分类、购物车、我的、结算、地址列表、地址编辑、优惠券弹层。

- [x] **Step 2: 绘制同城页头和统一四栏导航**

同城页头只保留：

```text
[店铺图标] 阿福凉菜 [营业中]
配送范围 10 km · 满 ¥40 起送 · 基础运费 ¥6 起
```

预览中不得出现顶部“我的订单”。四栏导航使用当前 tabBar 的图标、文字和顺序。

- [x] **Step 3: 绘制完整结算页与弹层**

结算页必须同时展示地址、配送信息、两件商品、优惠券、积分赠品、餐具、备注、金额明细、协议和固定提交栏。优惠券弹层覆盖不超过 70vh，并留出安全区。

- [x] **Step 4: 加入状态切换面板**

状态面板提供这些确定值：

```js
['正常', '无地址', '缺定位', '超范围', '未达起送', '报价中', '报价失败', '暂停接单', '提交中']
```

每个状态必须同时改变页面提示、金额展示和按钮可用性，不能只换一行文案。

- [x] **Step 5: 进行预览自检**

Run: `node docs/design/miniapp-local-v2/serve.mjs`

Expected: <http://localhost:5195> 打开独立预览，两种画布无横向滚动，长门店名、长地址、
优惠券名称均省略或换行而不越界。

> ⚠️ **不能用 `npm run preview:miniapp`**：那个服务器的 `ROOT` 是 `tools/miniapp-preview`
> （`tools/miniapp-preview/serve.mjs:17`），服务不了 `docs/` 下的文件。也不能直接双击
> `preview.html`——`file://` 下相对路径的 CSS/JS 加载不出来。

- [x] **Step 6: 停止并等待店主确认**

把独立预览链接交给店主。未收到明确确认前，不执行 Task 2。

---

### Task 2: 建立小程序状态测试与渠道上下文

**Files:**
- Create: `apps/miniapp/utils/channel.js`
- Create: `apps/miniapp/utils/local-checkout-state.js`
- Create: `tests/miniapp/channel.test.cjs`
- Create: `tests/miniapp/local-checkout-state.test.cjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `wx.getStorageSync`、`wx.setStorageSync`。
- Produces: `normalizeChannel(value)`, `getShoppingChannel()`, `setShoppingChannel(channel)`, `channelQuery(channel)`, `checkoutAction(state)`。

- [x] **Step 1: 写渠道隔离失败测试**

```js
const test = require('node:test')
const assert = require('node:assert/strict')

test('LOCAL remains LOCAL across tab changes and query is explicit', function () {
  global.wx = {
    getStorageSync: function () { return 'LOCAL' },
    setStorageSync: function () {},
  }
  const channel = require('../../apps/miniapp/utils/channel')
  assert.equal(channel.getShoppingChannel(), 'LOCAL')
  assert.equal(channel.channelQuery('LOCAL'), 'channel=LOCAL')
  assert.equal(channel.channelQuery('EXPRESS'), 'channel=EXPRESS')
})

test('invalid persisted values fall back to EXPRESS', function () {
  global.wx = { getStorageSync: function () { return 'OTHER' } }
  const channel = require('../../apps/miniapp/utils/channel')
  assert.equal(channel.getShoppingChannel(), 'EXPRESS')
})
```

- [x] **Step 2: 运行测试并确认失败原因**

Run: `node --test tests/miniapp/channel.test.cjs`

Expected: FAIL with `Cannot find module '../../apps/miniapp/utils/channel'`。

- [x] **Step 3: 实现最小渠道工具**

```js
var STORAGE_KEY = 'shoppingChannel'

function normalizeChannel(value) {
  return value === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
}

function getShoppingChannel() {
  return normalizeChannel(wx.getStorageSync(STORAGE_KEY))
}

function setShoppingChannel(value) {
  var channel = normalizeChannel(value)
  wx.setStorageSync(STORAGE_KEY, channel)
  return channel
}

function channelQuery(value) {
  return 'channel=' + normalizeChannel(value)
}

module.exports = {
  normalizeChannel: normalizeChannel,
  getShoppingChannel: getShoppingChannel,
  setShoppingChannel: setShoppingChannel,
  channelQuery: channelQuery,
}
```

- [x] **Step 4: 写结算按钮状态失败测试**

```js
test('address and quote changes never leave an old payable submit button', function () {
  assert.deepEqual(checkoutAction({ hasAddress: false }), { disabled: true, text: '请选择地址', amountState: 'pending' })
  assert.deepEqual(checkoutAction({ hasAddress: true, quoting: true }), { disabled: true, text: '正在计算运费', amountState: 'pending' })
  // 报价失败：按钮**可点**，点了是重新报价，不是提交（店主 2026-09-07 选的方案 B）
  assert.deepEqual(checkoutAction({ hasAddress: true, quoteError: true }), { disabled: false, text: '重新获取运费', amountState: 'error', action: 'retry' })
})

test('only a fresh quote and payable amount enables submit', function () {
  assert.deepEqual(checkoutAction({
    hasAddress: true,
    quoteToken: 'signed',
    quoteExpiresAt: 1893456000000,
    now: 1893455000000,
    payAmount: 4900,
  }), { disabled: false, text: '提交订单', amountState: 'ready' })
})
```

- [x] **Step 5: 运行测试并确认缺少实现**

Run: `node --test tests/miniapp/local-checkout-state.test.cjs`

Expected: FAIL because `checkoutAction` is not defined。

- [x] **Step 6: 按地址→报价→业务阻塞→提交中的优先级实现 `checkoutAction`**

按钮文案只允许：`请选择地址`、`请补充定位`、`正在计算运费`、`重新获取运费`、`暂不可配送`、`提交订单`、`提交中`。长业务原因由页面提示区展示。

返回值除 `disabled/text/amountState` 外**必须带 `action`**，取值 `submit | retry | none`：

| 场景 | disabled | text | amountState | action |
|---|---|---|---|---|
| 无地址 | true | 请选择地址 | pending | none |
| 缺定位 | true | 请补充定位 | pending | none |
| 报价中 | true | 正在计算运费 | pending | none |
| **报价失败** | **false** | 重新获取运费 | error | **retry** |
| 暂停/打烊/超范围/未达起送 | true | 暂不可配送 | blocked | none |
| 可提交 | false | 提交订单 | ready | submit |
| 提交中 | true | 提交中 | ready | submit |

⚠️ **`action` 是方案 B 引入的硬约束**：报价失败时按钮是**可点的**，所以页面的点击处理
必须按 `action` 分派（`retry` → `refreshQuote()`，`submit` → `doSubmit()`），
**绝不允许写成「按钮没禁用就去提交」**——那会在没有有效 `quoteToken` 的状态下打 `POST /orders`，
被服务端 `42239` 拒掉，顾客看到的是一句莫名其妙的报错。

- [x] **Step 7: 运行单测和 ES5 闸门**

Run: `node --test tests/miniapp/*.test.cjs`

Expected: PASS。

Run: `node scripts/check-miniapp-es5.mjs apps/miniapp/utils/channel.js apps/miniapp/utils/local-checkout-state.js`

Expected: PASS，无 `const/let`、箭头函数、模板字符串或展开语法。

- [x] **Step 8: Commit**

```bash
git add package.json apps/miniapp/utils/channel.js apps/miniapp/utils/local-checkout-state.js tests/miniapp
git commit -m "test(miniapp): lock dual-channel and checkout states"
```

---

### Task 3: 补强报价、订单过滤与幂等下单契约

**Files:**
- Modify: `apps/server/src/services/local-settings.ts`
- Modify: `apps/server/src/routes/local.ts`
- Modify: `apps/server/src/routes/orders.ts`
- Modify: `apps/server/prisma/schema.prisma`
- Create: `apps/server/prisma/migrations/20260911000000_order_client_request_id/migration.sql`（改日期：main 已有 20260909 / 20260910 两条迁移，20260907 会排到它们前面）
- Modify: `apps/server/scripts/selftest-local-settings.ts`
- Create: `scripts/e2e.d/53-order-contract.sh`（不是改 `scripts/e2e.sh`——Global Constraints 要求新用例放 e2e.d/NN-*.sh）
- Modify: `apps/miniapp/api/order.js`

**Interfaces:**
- Produces: `/local/quote.quoteExpiresAt: string | null`。
- Produces: `GET /orders?deliveryType=LOCAL|EXPRESS`。
- Produces: `POST /orders.clientRequestId: UUID`，同一用户重复提交同一个 ID 返回同一订单。

- [x] **Step 1: 给报价过期时间写失败测试**

在 `selftest-local-settings.ts` 使用固定时间：

```ts
const issuedAt = new Date('2026-09-07T00:00:00.000Z')
assert.equal(quoteExpiresAt(issuedAt).toISOString(), '2026-09-07T00:15:00.000Z')
```

Run: `npm exec --workspace=apps/server -- ts-node --transpile-only scripts/selftest-local-settings.ts`

Expected: FAIL because `quoteExpiresAt` is not exported。

- [x] **Step 2: 导出与 token 共用的过期时间函数**

```ts
export function quoteExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + QUOTE_TTL_MS)
}
```

`signQuote` 内的 `e` 改为 `quoteExpiresAt(now).getTime()`；`POST /local/quote` 用同一个 `issuedAt` 生成 token 和 ISO 时间。匿名报价没有 token 时 `quoteExpiresAt` 返回 `null`。

- [x] **Step 3: 给订单渠道过滤和幂等写 e2e 失败断言**

新增用例必须实际发请求并断言：

```bash
# 同一个 clientRequestId 连续 POST 两次：两次 data.orderId 相同，库存只减一次
# GET /orders?deliveryType=LOCAL：每行 deliveryType 都是 LOCAL
# GET /orders?deliveryType=EXPRESS：每行 deliveryType 都是 EXPRESS
# deliveryType=OTHER：HTTP 400，不能静默回退
```

Run: `bash scripts/e2e.sh`

Expected: 新增断言失败；既有断言结果不变。

- [x] **Step 4: 增加幂等列和唯一约束**

```prisma
clientRequestId String? @map("client_request_id") @db.VarChar(36)
@@unique([userId, clientRequestId])
```

迁移只增加可空列和唯一索引：

```sql
ALTER TABLE `orders` ADD COLUMN `client_request_id` VARCHAR(36) NULL;
CREATE UNIQUE INDEX `orders_user_id_client_request_id_key`
  ON `orders`(`user_id`, `client_request_id`);
```

- [x] **Step 5: 实现订单接口校验和幂等返回**

`createOrderSchema` 增加 `clientRequestId: z.string().uuid().optional()`——**必须可选**。
`POST /api/orders` 是两个渠道共用的同一个 schema（`routes/orders.ts:100-124`），
而邮寄结算页 `pages/order/confirm.js` 不在本计划改动范围内、`scripts/e2e.sh` 里几十处下单
也不会传这个字段；写成必填会让邮寄下单与整套 e2e 当场全红。
不传时行为与改前逐字节一致（不写该列、不做幂等查询）。事务创建订单时写入该值；事务前先查已存在订单，并在并发唯一键冲突时再次查询返回。复用一个 `orderCreatedView(order)` 生成首次和重试完全相同的返回字段。

- [x] **Step 6: 实现订单渠道过滤**

```ts
const deliveryType = z.enum(['EXPRESS', 'LOCAL']).optional().parse(req.query.deliveryType)
const where = {
  userId,
  ...(deliveryType ? { deliveryType } : {}),
  ...(statuses.length === 1 ? { status: statuses[0] } : statuses.length > 1 ? { status: { in: statuses } } : {}),
}
```

- [x] **Step 7: 小程序订单 API 显式透传渠道与 request id**

`getOrders(params)` 追加编码后的 `deliveryType`；`createOrder` 保持请求体透传，不在 API 层生成 ID，确保页面重试仍使用同一个值。

- [x] **Step 8: 验证**

Run: `npm run build --workspace=apps/server`

Expected: TypeScript PASS。

Run: `npm exec --workspace=apps/server -- ts-node --transpile-only scripts/selftest-local-settings.ts`

Expected: PASS。

Run: `bash scripts/e2e.sh`

Expected: 新增和既有断言全部 PASS，真实配送 provider 未被调用。

- [x] **Step 9: Commit**

```bash
git add apps/server/src apps/server/prisma apps/server/scripts scripts/e2e.sh apps/miniapp/api/order.js
git commit -m "feat(order): expose quote expiry and idempotent channel orders"
```

---

### Task 4: 接通双渠道入口与四栏导航

**Files:**
- Modify: `apps/miniapp/app.js`
- Modify: `apps/miniapp/pages/cover/index.js`
- Modify: `apps/miniapp/pages/local/index.js`
- Modify: `apps/miniapp/pages/local/index.wxml`
- Modify: `apps/miniapp/pages/user/index.js`
- Modify: `apps/miniapp/pages/cart/index.js`
- Modify: `apps/miniapp/pages/product/detail.js`
- Modify: `apps/miniapp/pages/member/mall.js`

**Interfaces:**
- Consumes: Task 2 `channel.js`。
- Produces: `app.setShoppingChannel(channel)`, `app.getShoppingChannel()`, `app.updateCartCount(channel)`。

- [x] **Step 1: 写页面导航行为失败测试**

用轻量 Page/wx harness 加载封面页：点击 LOCAL 后断言顺序为“隐私授权成功 → 设置 LOCAL → `wx.switchTab('/pages/index/index')`”；点击 EXPRESS 断言设置 EXPRESS 后进入同一路径。

Run: `node --test tests/miniapp/navigation.test.cjs`

Expected: FAIL because cover still uses `navigateTo('/pages/local/index')`。

- [x] **Step 2: 初始化并暴露渠道上下文**

`app.globalData.shoppingChannel` 从 storage 恢复；setter 清理待处理分类意图并刷新当前渠道角标。`updateCartCount` 改为 `getCart(this.getShoppingChannel())`。

- [x] **Step 3: 改封面入口**

LOCAL 仍先经过隐私授权；成功后设置 LOCAL 并 `switchTab` 到主页。EXPRESS 显式设置 EXPRESS。跳转失败沿用现有可见反馈。

- [x] **Step 4: 保留旧同城路由兼容**

`pages/local/index` 不再承载新主页面；它在 `onLoad` 设置 LOCAL 后 `switchTab` 到共享主页。保留 loading 文字和失败提示，避免旧分享链接白屏。

- [x] **Step 5: 改所有旧同城入口**

购物车跨渠道提示、商品详情、会员商城、“我的”页均调用同一个 `enterLocalChannel()` 行为，不再 `navigateTo('/pages/local/index')`。

- [x] **Step 6: 验证**

Run: `node --test tests/miniapp/navigation.test.cjs tests/miniapp/channel.test.cjs`

Expected: PASS。

Run: `node scripts/check-miniapp-es5.mjs apps/miniapp/utils/channel.js apps/miniapp/pages/cover/index.js`

Expected: PASS。

- [x] **Step 7: Commit**

```bash
git add apps/miniapp/app.js apps/miniapp/pages/cover apps/miniapp/pages/local apps/miniapp/pages/user/index.js apps/miniapp/pages/cart/index.js apps/miniapp/pages/product/detail.js apps/miniapp/pages/member/mall.js tests/miniapp/navigation.test.cjs
git commit -m "feat(miniapp): share four-tab navigation across channels"
```

---

### Task 5: 整改同城主页、营业标志和分类选购

**Files:**（执行期多拆了两个组件，理由见下方 Step 3 附注）
- Create: `apps/miniapp/utils/local-catalog.js` + `tests/miniapp/local-catalog.test.cjs`
- Create: `apps/miniapp/components/local-cart-bar/*`（主页与分类页共用的购物车条）
- Create: `apps/miniapp/components/local-sku-picker/*`（主页与分类页共用的加购流程）
- Create: `tests/miniapp/channel-pages.test.cjs`
- Create: `apps/miniapp/components/local-store-header/index.js`
- Create: `apps/miniapp/components/local-store-header/index.json`
- Create: `apps/miniapp/components/local-store-header/index.wxml`
- Create: `apps/miniapp/components/local-store-header/index.wxss`
- Create: `apps/miniapp/api/catalog.js`
- Modify: `apps/miniapp/pages/index/index.js`
- Modify: `apps/miniapp/pages/index/index.wxml`
- Modify: `apps/miniapp/pages/index/index.wxss`
- Modify: `apps/miniapp/pages/index/index.json`
- Modify: `apps/miniapp/pages/product/list.js`
- Modify: `apps/miniapp/pages/product/list.wxml`
- Modify: `apps/miniapp/pages/product/list.wxss`
- Modify: `apps/miniapp/pages/product/list.json`

**Interfaces:**
- Consumes: `getShoppingChannel()`, `/categories?channel=…`, `/products?channel=…`, `/local/meta`, `addToCart`。
- Produces: `<local-store-header meta head-notice>`；分类页 LOCAL 加购事件。

- [x] **Step 1: 写 catalog 查询失败测试**

```js
assert.equal(buildProductsUrl({ channel: 'LOCAL', page: 2, pageSize: 20, categoryId: 7 }), '/products?channel=LOCAL&page=2&pageSize=20&categoryId=7')
assert.equal(buildCategoriesUrl('EXPRESS'), '/categories?channel=EXPRESS')
```

Run: `node --test tests/miniapp/catalog.test.cjs`

Expected: FAIL because `api/catalog.js` does not exist。

- [x] **Step 2: 实现显式渠道 catalog API 并通过测试**

URL 参数用 `encodeURIComponent`，固定顺序为 `channel,page,pageSize,categoryId,keyword`，便于测试和日志比对。

- [x] **Step 3: 创建门店头组件并移除“我的订单”**

组件第一行结构固定为：

```xml
<view class="store-title-row">
  <view class="store-name-wrap">…</view>
  <text class="status-pill status-pill-{{tone}}">{{statusText}}</text>
</view>
```

样式使用 `justify-content:flex-start`；店名 `flex:0 1 auto; min-width:0`；胶囊 `display:inline-flex; flex-shrink:0; white-space:nowrap; box-sizing:border-box`。组件中不存在 `head-orders-link`。

- [x] **Step 4: 主页按渠道加载**

EXPRESS 保留现有 Banner/推荐。LOCAL 请求 meta、LOCAL 分类和 LOCAL 推荐；暂停或打烊时仍显示商品，但加购和结算入口按业务状态禁用并提供“改用全国邮寄”。

- [x] **Step 5: 分类页按渠道加载与交互**

两种渠道共用左分类/右商品骨架。EXPRESS 保留搜索和进入详情；LOCAL 使用 LOCAL 查询、显示圆形加购按钮，多规格先拉详情再弹 `sku-popup`，成功后刷新 LOCAL 购物车条和当前渠道角标。

- [x] **Step 6: LOCAL 购物车条避让 tabBar**

有货时显示在 tabBar 上方。**用 `position: fixed; bottom: 0`，不要为 tabBar 留任何偏移**——
微信 tabBar 是画在 WebView 之外的原生组件，tabBar 页的可视区本来就不含它，`bottom:0`
已经落在 tabBar 之上；加偏移只会在栏与 tabBar 之间留出一条空隙。
`padding-bottom: calc(14rpx + env(safe-area-inset-bottom))` 照抄仓库既有写法
（`pages/cart/index.wxss:133-143`，那已经是一个 tabBar 页的固定栏）。无货时完全不占位。

- [x] **Step 7: 视觉验收**

在开发者工具切换 iPhone SE、iPhone 15 Pro Max：长门店名不挤掉“营业中”；绿色胶囊没有横向溢出；四个 tab 均可点击；购物车条不遮 tabBar。

- [x] **Step 8: 自动检查**

Run: `node --test tests/miniapp/catalog.test.cjs tests/miniapp/navigation.test.cjs`

Expected: PASS。

Run: `node scripts/check-miniapp-es5.mjs apps/miniapp/api/catalog.js apps/miniapp/components/local-store-header/index.js`

Expected: PASS。

- [x] **Step 9: Commit**

```bash
git add apps/miniapp/api/catalog.js apps/miniapp/components/local-store-header apps/miniapp/pages/index apps/miniapp/pages/product/list tests/miniapp/catalog.test.cjs
git commit -m "feat(miniapp): add channel-aware home and category tabs"
```

---

### Task 6: 把购物车改成同骨架、双渠道行为

**Files:**
- Modify: `apps/miniapp/pages/cart/index.js`
- Modify: `apps/miniapp/pages/cart/index.wxml`
- Modify: `apps/miniapp/pages/cart/index.wxss`
- Modify: `apps/miniapp/api/cart.js`
- Create: `tests/miniapp/cart-channel.test.cjs`
- Modify: `tests/miniapp/navigation.test.cjs`（购物车的跨渠道入口改成双向，旧断言随之更新）

**Interfaces:**
- Consumes: 当前渠道、`getCart(channel)`、`updateCartItem`、`deleteCartItem`、`getLocalMeta`。
- Produces: EXPRESS → `/pages/order/confirm`；LOCAL → `/pages/local/confirm`。

- [x] **Step 1: 写路由与角标失败测试**

测试 LOCAL 购物车结算 URL 必须是 `/pages/local/confirm?cartItemIds=1,2`；EXPRESS 必须是 `/pages/order/confirm?cartItemIds=1,2`；空态“去逛逛”切到当前渠道分类。

Run: `node --test tests/miniapp/cart-channel.test.cjs`

Expected: FAIL because current cart always loads EXPRESS and enters postal checkout。

- [x] **Step 2: `onShow` 检测渠道变化并重载**

记录 `_loadedChannel`；与 app 当前渠道不同时清空旧 items、金额和选择，避免 LOCAL 页面先闪出 EXPRESS 购物车。

- [x] **Step 3: LOCAL 购物车展示业务差异**

LOCAL 显示“同城购物车”、券前小计、当前起送差额和营业提示；不在购物车页计算道路距离与配送费。EXPRESS 现有金额与选择行为不变。

- [x] **Step 4: 结算路由按渠道分流**

LOCAL 传选中 cart ids 到同城结算；EXPRESS 进入原确认页。更新数量或删除后只刷新当前渠道角标。

- [x] **Step 5: 验证**

Run: `node --test tests/miniapp/cart-channel.test.cjs tests/miniapp/channel.test.cjs`

Expected: PASS。

（本任务只改既有非 ES5 文件，无新增 js，跳过 ES5 闸门。）

- [x] **Step 6: Commit**

```bash
git add apps/miniapp/pages/cart apps/miniapp/api/cart.js tests/miniapp/cart-channel.test.cjs
git commit -m "feat(miniapp): isolate cart tab by shopping channel"
```

---

### Task 7: 重构同城结算页的完整信息与状态

**Files:**
- Modify: `apps/miniapp/pages/local/confirm.js`
- Modify: `apps/miniapp/pages/local/confirm.wxml`
- Modify: `apps/miniapp/pages/local/confirm.wxss`
- Modify: `apps/miniapp/api/local.js`
- Modify: `apps/miniapp/components/checkout-benefits/index.js`
- Modify: `apps/miniapp/components/checkout-benefits/index.wxml`
- Modify: `apps/miniapp/components/checkout-benefits/index.wxss`
- Modify: `tests/miniapp/local-checkout-state.test.cjs`

**Interfaces:**
- Consumes: `checkoutAction`, `/local/quote.quoteExpiresAt`, checkout benefits change event。
- Produces: `checkout-benefits` change detail `{ couponId, gifts, discount, pointsUsed, loading }`。

- [x] **Step 1: 扩充失败测试覆盖状态矩阵**

用表驱动字面量覆盖：无地址、缺定位、报价中、报价失败、报价过期、暂停、打烊、超范围、未达起送、优惠加载中、可提交、提交中。每行断言 `disabled/text/amountState`。

Run: `node --test tests/miniapp/local-checkout-state.test.cjs`

Expected: 新增“报价过期”和“优惠加载中”用例 FAIL。

- [x] **Step 2: 把过期判断改为服务端时间**

保存 `quoteExpiresAtMs = Date.parse(rawQuote.quoteExpiresAt)`；无法解析时按不可提交处理并重新报价。删除 `Date.now() - quotedAt > 10 * 60 * 1000`。

- [x] **Step 3: 地址/数量变化立即作废全部旧提交数据**

统一 `invalidateCheckout(reason)`：递增请求序号、清 timer、置 `quoteToken:null`、`quoteExpiresAtMs:0`、`payAmount:null`、`quoting:true`。数量 API 发出前调用，地址切换后调用，不能等待网络返回。

- [x] **Step 4: 按设计顺序重排 WXML**

地址 → 配送 → 商品 → 优惠 → 餐具备注 → 金额明细 → 协议。新增金额卡显示商品金额、优惠券、配送费、积分赠品和应付金额；任何 pending/error/block 状态都不得显示旧应付金额。

- [x] **Step 5: 缩短固定按钮文案**

页面从 `checkoutAction` 取短文案；完整 `blockReason` 放在按钮上方提示条。移除把“超出配送范围（约…）”直接塞进主按钮的行为。

- [x] **Step 6: 给优惠组件增加 loading 契约**

组件进入/离开 loading 时向父页 emit；父页在优惠重新计算期间禁用提交。保留当前规则：优惠加载失败清空旧券并允许原价下单。

- [x] **Step 7: 调整优惠券弹层空间**

`.sheet` 使用 `max-height:70vh`，body 计算可滚动高度并增加 `padding-bottom:calc(40rpx + env(safe-area-inset-bottom))`。长名称单行省略，不可用原因允许两行。

- [x] **Step 8: 生成并保持 client request id**

进入结算页生成 UUID；提交失败时保留，成功或确认服务端未创建且顾客修改地址/商品后生成新 ID。请求体显式传 `clientRequestId`。

- [x] **Step 9: 错误码逐类刷新正确区域**

```text
42227/42239 → 作废金额并重新报价
42201/42202/42224 → 刷新购物车商品
42250/42251/42252/42253/42254 → 刷新优惠组件
42210/42220/42222/42223/42226/42230 → 显示业务阻塞和对应出口
网络超时 → 用相同 clientRequestId 重试，不能创建第二单
```

- [x] **Step 10: 验证**

Run: `node --test tests/miniapp/local-checkout-state.test.cjs`

Expected: PASS。

Run: `node scripts/check-miniapp-es5.mjs apps/miniapp/pages/local/confirm.js apps/miniapp/components/checkout-benefits/index.js`

Expected: PASS。

开发者工具逐个切换 Task 1 的九种状态，确认固定栏不遮内容、金额不残留、按钮不溢出。

- [x] **Step 11: Commit**

```bash
git add apps/miniapp/pages/local/confirm.* apps/miniapp/api/local.js apps/miniapp/components/checkout-benefits tests/miniapp/local-checkout-state.test.cjs
git commit -m "feat(miniapp): complete local checkout states and amount breakdown"
```

---

### Task 8: 收口地址新增、选择、定位和匿名报价

**Files:**
- Modify: `apps/miniapp/pages/address/list.js`
- Modify: `apps/miniapp/pages/address/list.wxml`
- Modify: `apps/miniapp/pages/address/list.wxss`
- Modify: `apps/miniapp/pages/address/edit.js`
- Modify: `apps/miniapp/pages/address/edit.wxml`
- Modify: `apps/miniapp/pages/address/edit.wxss`
- Modify: `apps/miniapp/api/local.js`
- Create: `tests/miniapp/address-flow.test.cjs`

**Interfaces:**
- Consumes: `quoteLocalByLocation(latE6, lngE6)`、地址创建/更新返回值。
- Produces: 保存成功时 `app.globalData.selectedAddress = savedAddress`（仅 select 模式来源）。

- [ ] **Step 1: 写地址回传与取消无副作用失败测试**

覆盖三条行为：从结算页新增后自动选中新地址；地图选择取消保持旧坐标；导入微信地址后旧定位变 stale 且不能直接提交同城订单。

Run: `node --test tests/miniapp/address-flow.test.cjs`

Expected: 新增地址自动回传用例 FAIL。

- [ ] **Step 2: 显式传来源参数**

结算页进入地址列表时带 `mode=select&channel=LOCAL&returnTo=checkout`；地址列表进入新增/编辑时继续透传 `mode=select&returnTo=checkout`。

- [ ] **Step 3: 保存成功自动回传地址**

`createAddress/updateAddress` 成功值就是完整地址。来自结算选择流程时写入 `selectedAddress` 并连续返回到结算页；普通地址管理仍只返回列表页。

- [ ] **Step 4: 匿名报价改走统一 API 包装层**

`api/local.js` 新增：

```js
function quoteLocalByLocation(latE6, lngE6) {
  return request({
    url: '/local/quote',
    method: 'POST',
    silent: true,
    data: { latE6: latE6, lngE6: lngE6, subtotal: 0 },
  })
}
```

地址编辑页删除 `baseURL` 和直连 `wx.request`；失败只清报价条，不弹全局 toast。

- [ ] **Step 5: 地址卡空间与状态验收**

姓名、电话、默认标、长地址、距离标同时出现时不横向溢出；缺定位卡保持可读，不使用整卡 0.55 opacity 降低姓名电话可读性，改为局部警示。

- [ ] **Step 6: 验证**

Run: `node --test tests/miniapp/address-flow.test.cjs`

Expected: PASS。

（`pages/address/*.js` 与 `api/local.js` 本来就不是 ES5，跳过 ES5 闸门。）

- [ ] **Step 7: Commit**

```bash
git add apps/miniapp/pages/address apps/miniapp/api/local.js tests/miniapp/address-flow.test.cjs
git commit -m "feat(miniapp): close local address selection and quote flow"
```

---

### Task 9: “我的”与订单后链路按渠道收口

**Files:**
- Modify: `apps/miniapp/pages/user/index.js`
- Modify: `apps/miniapp/pages/user/index.wxml`
- Modify: `apps/miniapp/pages/order/list.js`
- Modify: `apps/miniapp/pages/order/list.wxml`
- Modify: `apps/miniapp/pages/order/detail.js`
- Modify: `apps/miniapp/api/order.js`
- Create: `tests/miniapp/order-channel.test.cjs`

**Interfaces:**
- Consumes: `GET /orders?deliveryType=…`、当前渠道。
- Produces: 订单列表参数 `{ scope: 'channel'|'all', deliveryType, status, page, pageSize }`。

- [ ] **Step 1: 写订单列表渠道失败测试**

LOCAL 模式从“我的”进入订单列表时 URL 带 `deliveryType=LOCAL`；切到“全部订单”后不带 `deliveryType`；状态和分页参数继续保留。

Run: `node --test tests/miniapp/order-channel.test.cjs`

Expected: FAIL because current order API ignores deliveryType。

- [ ] **Step 2: 删除同城页头订单入口的所有残留**

全仓 `rg 'head-orders-link|我的订单 ›' apps/miniapp` 应无结果；封面是否保留独立“我的订单”由封面现有设计决定，不属于同城页头。

- [ ] **Step 3: “我的”页按当前渠道进入订单列表**

个人资料、积分、券、地址和协议继续共用；订单入口传当前渠道，并在标题或小标签显示“同城配送/全国邮寄”，避免顾客不知道当前所处模式。

- [ ] **Step 4: 订单列表增加“当前渠道/全部”切换**

切换时递增请求序号、清空旧列表、回到 page 1；晚到响应不得覆盖新筛选结果。订单卡继续显示渠道标签。

- [ ] **Step 5: 回归同城订单详情**

确认 LOCAL 不显示“确认收货”；骑手轮询只在在途状态启动，订单终态、页面 hide/unload 都停止；取消申请在途防双击；退款与售后字段完整显示。

- [ ] **Step 6: 验证**

Run: `node --test tests/miniapp/order-channel.test.cjs`

Expected: PASS。

（本任务只改既有非 ES5 文件，无新增 js，跳过 ES5 闸门。）

- [ ] **Step 7: Commit**

```bash
git add apps/miniapp/pages/user apps/miniapp/pages/order apps/miniapp/api/order.js tests/miniapp/order-channel.test.cjs
git commit -m "feat(miniapp): scope account orders to active channel"
```

---

### Task 10: 全链路验证与第二道预览确认

**Files:**
- Modify: `docs/miniapp-release-checklist.md`
- Modify: `docs/local-delivery-run-log.md`
- Create: `docs/superpowers/reviews/2026-09-07-miniapp-local-v2-verification.md`

**Interfaces:**
- Consumes: Tasks 2–9 全部实现与测试。
- Produces: 可复查的自动化结果、开发者工具结果、真机待验列表；不产生部署。

- [ ] **Step 1: 跑小程序单测**

Run: `node --test tests/miniapp/*.test.cjs`

Expected: 0 failures；输出中每个测试名对应一个用户可见行为。

- [ ] **Step 2: 跑 ES5 闸门**

Run: `node scripts/check-miniapp-es5.mjs apps/miniapp/utils/channel.js apps/miniapp/utils/local-checkout-state.js apps/miniapp/api/catalog.js apps/miniapp/components/local-store-header/index.js apps/miniapp/pages/cover/index.js apps/miniapp/pages/local/confirm.js apps/miniapp/components/checkout-benefits/index.js`

Expected: PASS。

- [ ] **Step 3: 跑服务端构建、自测与 e2e**

Run: `npm run build --workspace=apps/server`

Expected: PASS。

Run: `npm exec --workspace=apps/server -- ts-node --transpile-only scripts/selftest-local-settings.ts`

Expected: PASS。

Run: `bash scripts/e2e.sh`

Expected: 0 failures；mock provider，不产生真实配送费用。

- [ ] **Step 4: 开发者工具完整操作矩阵**

逐条执行：

```text
封面→全国邮寄→四个 tab→购物车→邮寄结算
封面→同城配送→四个 tab→LOCAL 加购→LOCAL 购物车→同城结算
无地址→新增→地图选点→保存→自动回结算→报价
更换地址→旧金额立即消失→新报价→选券→选赠品→改数量→重新报价
报价失败→重试；暂停/打烊/超范围/未达起送→按钮禁用且出口正确
双击提交→一张订单；模拟超时后同 ID 重试→仍是一张订单
支付取消→可重试支付；支付成功→订单详情→骑手状态→终态停止轮询
返回全国邮寄→EXPRESS 商品与购物车未被 LOCAL 数据污染
```

- [ ] **Step 5: 视觉回归**

在 320×568、375×812、430×932 三个视口和系统最大字号检查：营业胶囊、长地址、优惠券名称、固定结算栏、键盘、安全区、优惠券弹层均无横向溢出或遮挡。

- [ ] **Step 6: 写验证报告**

报告记录每条命令、退出码、开发者工具基础库版本、三种视口截图路径，以及只能真机完成的隐私授权、地图、支付和骑手定位条目。不得把未执行项目写成通过。

- [ ] **Step 7: 交付第二道预览并停止**

打开开发者工具预览供店主检查。未得到店主明确授权前，不上传体验版、不部署服务端、不执行数据库迁移。

- [ ] **Step 8: Commit**

```bash
git add docs/miniapp-release-checklist.md docs/local-delivery-run-log.md docs/superpowers/reviews/2026-09-07-miniapp-local-v2-verification.md
git commit -m "docs(miniapp): record dual-channel checkout verification"
```

---

## Execution Handoff

计划执行必须从 Task 1 的独立预览开始，并在店主确认处停止。预览确认后可选择：

1. **Subagent-Driven（推荐）**：每个任务独立实现并经过规格与质量两轮复核。
2. **Inline Execution**：在当前会话按任务顺序执行，每完成一批让店主检查。

无论选择哪一种，Task 10 之后都只交付开发者工具预览；部署需要新的明确授权。
