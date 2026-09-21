# 小程序：同城主页 / 分类页免运费提示条 + 满减关闭时免运费进度 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## 0. 给执行方的说明（先读）

- 本文件是「模型分工协议」的 **00 规划 · fable** 产物，等级 **M**（只动小程序展示层：一个纯函数模块、一个既有组件、两页各插一行、镜像与文档；不改任何金额计算、不改服务端）。
- 工序链：**00 规划 · fable（本文件）→ 01 执行 · sonnet → 04 机械核对 · haiku（只跑 §6-A 的命令、比对 §7 白名单与 `git diff --name-only` 的文件集合，不调模型判断）**。
- **升 L 的条件**（命中任一，执行方停下写进 §11 并上报；升 L 后追加 **02 独立复核 · opus（新会话，只给 §1 需求 + 最终 diff + §6 验收标准，不给执行过程）→ 03 回判 · fable**，修补轮 sonnet 修完必须再过一次 opus）：
  1. 需要改任何**钱的计算**（`utils/checkout-pay.js`、`utils/pickup-checkout-state.js`、结算页、订单页，或 `progressTipOf` 之外的任何金额口径）；
  2. 需要改 `apps/server/**` 或 `apps/admin/**`；
  3. 需要触及分类页滚动几何的重量逻辑（`pages/product/list.js` 的 `afterGroupsRendered` / `_captureAnchor` / `measureOffsets` / `_updateSidebarLayout` / `onCartHeight` 任一行）。
- 各工序只做本职：规划不写码、执行不改方案（偏离要逐条写进 §11）、核对不提交修复。**每次交接第一行声明「当前工序 0X · 模型」。**
- **验收标准只在本文件 §6 定义，后续工序不得新增或放宽。**
- 合并到 main 与上传体验版**由店主决定**，执行方不合并、不部署、不上传。
- 本文件自包含：需求、已查实的代码事实（带 文件:行）、分步改动、验收、白名单、上报条件、环境配方全部在此，不引用任何对话。
- 仓库与分支：worktree `/Users/yumingyi/food-shop/.claude/worktrees/freeship-bar`，分支 `claude/freeship-bar`，基线 main `3cb5ae9`（当前 HEAD `b046f37` 只多一份预览 HTML；本文件提交后 HEAD 再进一格）。**只在这个目录工作，不 cd 到主检出，不裸 `git stash`。**
- 本 worktree **不必也不许 `npm install`**：依赖向上解析到主仓 `node_modules`。2026-09-21 在本 worktree 根实测：`npm run -s test:miniapp` → `tests 253 / pass 253 / fail 0`；`node scripts/check-miniapp-es5.mjs apps/miniapp/utils/promo.js apps/miniapp/components/promo-bar/index.js apps/miniapp/components/local-cart-bar/index.js` → 三个 ✔。若某条命令真的报找不到模块，停下上报，不要自行安装。
- 本机没有 `timeout` 命令（zsh 下 `command not found`）；长命令用工具自带的超时参数，起预览服务用后台方式 + 有上限轮询（§8）。

---

## 1. 需求（店主拍板，不可更改）

视觉依据：`docs/superpowers/previews/2026-09-21-freeship-bar.html`（375 宽，示例数据，CSS 仅供模仿；实现用现有 wxss / 组件）。

1. 在同城**主页**与**分类页**的满减条（`components/promo-bar`）**正下方**加一条**免运费提示条**：与满减条**同色同样式**（红底 `#fff7f2`、品牌色角标），角标文字「**免**」；**满减关闭时它照样显示**。
2. 摘要只写**最低档带距离**：「免运费　满 ¥58 免运费（2 km 内）· 多买免更远」。点「详情 ›」用 `wx.showModal` 列五档全表，末行「按下单地址到门店的距离判断；配送范围 8 km」。档位与距离**全部读后台现有配置** `meta.fee.freeShipTiers[{minAmountFen,maxKm}]` 与 `meta.radiusKm`，不写死；`freeShipTiers` 为空数组（= 后台关闭免运费）时整条不渲染；`maxKm >= radiusKm` 的档写「免运费」不带距离。「多买免更远」是按 375 宽实测缩短过的文案，执行时须在 375 宽**复测不被省略**（§6-B2）。
3. **补漏洞**：`utils/promo.js` 的 `progressTipOf` 在 `!preview || !preview.active` 时整条 `hidden`，导致满减关闭时结算条上方的免运费进度也消失。改为：满减关闭 / 未命中时仍显示免运费进度，三态（预览 §③）：「再买 ¥20 免运费（2 km 内）」/「2 km 内免运费 · 再买 ¥30 免 3 km 内运费」/「7 km 内免运费」（tone `done`）。既有「满减开着」的三态文案**逐字不变**。免运费门槛按**减前商品小计**判（spec `docs/superpowers/specs/2026-09-17-store-promotion-design.md:19` P7）。
4. **邮寄不加**；**自取（PICKUP）下免运费条与免运费进度都不显示**。
5. 商品卡不打标；不改后台、服务端、`app.json`、`app.wxss`、`app.js`、`utils/local-catalog.js`、`utils/local-checkout-state.js`、`package*.json`、`scripts/**`；既有测试不得为「让它绿」而改（唯一例外见 §2.8 与 §9 Q4：三行断言钉的是本批**明确要改掉**的旧行为）。

---

## 2. 已查实的代码事实（2026-09-21 在本 worktree 逐一核过；与统筹方口述不符处见 §2.9）

### 2.1 数据源

- 小程序拉 meta：`apps/miniapp/api/local.js:4-6` `getLocalMeta()` → `GET /local/meta`。
- 服务端公开 meta 形状（`apps/server/src/services/local-settings.ts:1086-1088`）：`radiusKm: s.radiusKm`、`fee: s.fee`；`fee.freeShipTiers` 类型 `{ minAmountFen: number; maxKm: number }[]`（`local-settings.ts:125`）；后台入参校验接受任意数组（`:442-443`），所以**空数组是合法配置** = 关免运费。免运判定服务端取「已达标档里 `maxKm` 最大的一档」（`:875`，注释 `:118-122`），与小程序 `progressTipOf` 的 `reached` 取法一致。
- 主页：LOCAL 下 `loadLocal()` 把 `meta / promotion / mode / promoType` 一起 setData（`pages/index/index.js:182-191`）；`loadMeta()`（onShow 刷新，`:208-224`）同样；切到 EXPRESS 时 `meta` 置 `null`、`promotion` 置 `null`（`:134,138`），EXPRESS 下只取 `promotion`（`:149,157`）。
- 分类页：`loadMeta(resolve)`（`pages/product/list.js:151-170`）LOCAL 下 setData `meta / promotion / mode / promoType`（`:164`）；EXPRESS 只 setData `promotion`（`:159`）；切渠道时 `meta` 置 `null`（`:135`）。
- `promoType` 由 `promoTypeOf(channel, mode)`（`utils/promo.js:3-5`）给出 `'EXPRESS' | 'PICKUP' | 'LOCAL'`，两页都已有该字段（index.js:23/136/188/219/238；list.js:28/137/164/664）。**免运费条只需绑定页面已有的 `meta` 与 `promoType`，不需要改两页的 `.js`。**

### 2.2 纯逻辑 `apps/miniapp/utils/promo.js`（ES5 ✔，50 行）

- `yuanShort(fen)` `:2`；`promoTypeOf` `:3-5`。
- `progressTipOf(preview, opts)` `:6-38`：`:8` `if (!preview || !preview.active) return hidden` ← **要补的漏洞**；`:10-13` 满减开着、未达档：`再买 ¥X 减 ¥Y`（hint）；`:14-31` 满减开着、已减：`已减 ¥Z` + 第二段（`:18-31`：LOCAL 且有档时算 `reached`/`next`，文案 `N km 内免运费` / `已免运费` / `再买 ¥X 免运费（N km 内）`）；`:32-35` 非 LOCAL 或无档时第二段用服务端 `nextTierGapFen`：`再买 ¥X 可减 ¥Y`。**这三态的文案本批逐字不动。**
- `promoBarOf(promotion, deliveryType)` `:39-49`：返回 `{show, name, summary, detailLines}`；hidden 形状 `{ show: false, summary: '', name: '', detailLines: [] }`。
- 导出 `:50`。

### 2.3 满减条组件 `apps/miniapp/components/promo-bar/`（ES5 ✔）

- `index.wxml:1-5`：`<view wx:if="{{bar.show}}" class="promo-bar" bindtap="onTapDetail">` + `<text class="promo-badge">减</text>`（**角标写死**） + `<text class="promo-summary">{{bar.name}}　{{bar.summary}}</text>`（全角空格分隔） + `<text class="promo-detail">详情 ›</text>`。
- `index.wxss:1-4`：`.promo-bar { display:flex; gap:12rpx; background:#fff7f2; border-top:1rpx solid var(--brand-bg-deep); padding:12rpx 28rpx; font-size:24rpx; color:#c2410c }`、`.promo-badge { background:var(--brand); color:#fff; font-size:21rpx; border-radius:6rpx; padding:1rpx 6rpx }`、`.promo-summary { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }`、`.promo-detail { color:var(--text-3); font-size:23rpx }`。变量在 `app.wxss:7/11/17` 已定义。
- `index.js:4-7` properties `promotion`(null)、`deliveryType`(String,'LOCAL')；`:9-13` observer `'promotion, deliveryType'` → `setData({ bar: promoBarOf(...) })`；`:15-19` `onTapDetail` → `wx.showModal({ title: bar.name, content: bar.detailLines.join('\n'), showCancel: false, confirmText: '知道了' })`。
- `index.json`：`{ "component": true }`。两页 `.json` 已登记 `promo-bar`（`pages/index/index.json:13`、`pages/product/list.json:10`）。

### 2.4 页面挂载点

- 主页 `pages/index/index.wxml`：`:22` `<local-store-header wx:if="{{channel === 'LOCAL'}}" …>` 开启一条 `wx:if / wx:elif` 链（`:26` swiper `wx:elif`、`:45` banner `wx:elif`）；`:55` `<promo-bar promotion="{{promotion}}" delivery-type="{{promoType}}" />` 在链之外（`:57-58` 注释说明原因）；`:59` `<local-mode-bar wx:if="{{channel === 'LOCAL'}}" …>`。**新条插在 `:55` 之后、`:59` 之前。**
- 分类页 `pages/product/list.wxml`：`:53` `<local-store-header wx:if LOCAL>` / `:56` `wx:else` 邮寄搜索栏；`:75` `<promo-bar …/>`；`:78-83` 搜索 chip `wx:if="{{searchKeyword}}"`（只有邮寄有搜索）；`:85-87` `<view wx:if LOCAL class="catalog-toolbar"><local-mode-bar …/></view>`（`.catalog-toolbar` 是 sticky 吸顶，`list.wxss:7-12`）。**新条插在 `:75` 之后、`:78` 之前**（免运费条只在 LOCAL 出现、搜索 chip 只在 EXPRESS 出现，二者不共存，顺序无歧义）。
- 既有源码级测试 `tests/miniapp/cart-bar-page.test.cjs:34-41` 取两页**第一个** `<promo-bar` 标签断言不含 `wx:elif` 并检查 json 登记——新条放在它之后，该用例不受影响。

### 2.5 结算条进度提示 `apps/miniapp/components/local-cart-bar/index.js`（ES5 ✔）

- observer `:44` `'meta, blocking, mode, promotion'` → `recompute()` + `loadPromo()`。
- `loadPromo()` `:102-121`：`type = promoTypeOf(channel, mode)`（`:105`）；`apply(res)`（`:107-115`）把 `progressTipOf(res, { deliveryType: type, subtotal: this.data.amount, freeShipTiers: meta.fee.freeShipTiers, radiusKm: meta.radiusKm })` 放进 `tip`，然后 `recompute()` + `measureDock()`；**`:116-119`：车空、或 `promotion` 存在且（`!active` 或该渠道未勾）时不请求，直接 `apply(null)`** ← 满减关闭时正是走这里，`progressTipOf(null, …)` 目前返回 hidden。请求失败也 `apply(null)`（`:120`）。
- `subtotal` = `this.data.amount` = 车内全部行小计（`localCatalog.summarizeCart`，`:68`）——**减前商品小计**，与 P7 一致，本批不改。
- PICKUP：`type === 'PICKUP'`，`progressTipOf` 的免运段只在 `opts.deliveryType === 'LOCAL'` 时算（`promo.js:19`）→ 自取天然没有免运费进度；本批新分支沿用同一判断即可。
- 高度上报 `measureDock()` `:123-140`：`nextTick` 后量 `.cart-dock`（含 `cart-tip`，wxml `:33-34`）整体高度，变了才 `triggerEvent('height')`；主页 `onCartHeight`（`index.js:42-47`）与分类页 `onCartHeight`（`list.js:53-60`，还会 `_updateSidebarLayout` + `afterGroupsRendered`）更新 `cartSpacerPx`。`apply()` 每次都调 `measureDock()`（`:114`）→ **提示行从无到有时占位会跟着变，机制已有，本批不动**（既有测试 `tests/miniapp/promo.test.cjs:200-217` 钉住了这一行为）。
- `tip.tone` 只有 `'hint' | 'done'`，wxml `:34` 按 `done` 加 `cart-tip-done`（绿底，`index.wxss:115-119`）。

### 2.6 分类页几何（本批只核实、不改）

- `afterGroupsRendered()` `list.js:279-290`：`nextTick` 量一次 + 200 ms 后再量一次（`measureOffsets(true)` 清锚点）。
- `_captureAnchor()` `:292-297`：只在 `_layout` 已有且页面已滚过 `bodyTop - pinnedHeight`（即两栏已顶到吸顶栏下）时记快照 `{scrollTop, bodyTop, pinnedHeight, scrollRevision}`；在页顶时不记（头部变高只是把内容往下推，无需补偿）。
- `measureOffsets()` `:325-395`：`:367-378` 若快照存在且 `bodyTop` 或 `pinnedHeight` 变了，`scrollPageTo(anchor.scrollTop + Δ bodyTop − Δ pinnedHeight)` 补偿；期间用户滚动过（`scrollRevision` 变）则作废。
- **触发覆盖**：① `loadMeta` 在 setData 前 `_captureAnchor()`（`:157`）、后 `afterGroupsRendered()`（`:165`；EXPRESS 分支 `:160`）——免运费条与满减条同一次 setData 出现，**同一机制覆盖**；② 外送/自取切换 `applyMode`（`:662-667`）`_captureAnchor` + `afterGroupsRendered`——自取时免运费条消失，覆盖；③ 切渠道 `:135-139` 清 `meta` 后 `loadMeta`（`:146`）与 `loadCatalog`（`:189`）都重量；④ onShow 的 `loadMeta()`（`:76-77`）重设相同 `meta`，条高不变。
- 结论：**免运费条只要绑定同一次 setData 的 `meta`/`promoType`，不需要新增任何几何逻辑**。若真机出现跳动（§6-C4）→ R3 升 L，不在本批自行改几何。

### 2.7 购物车 tabBar 页（本批不动，只记录影响）

- `pages/cart/index.js:118-135` 也调 `progressTipOf`（渠道可为 LOCAL，`:23/:49`）：**满减关闭时它在 `:123-124` 直接 `promoTip: {show:false}`，根本不调 `progressTipOf`**；只有「满减开着但服务端返回 `active:false`」或「已开、未减且无下一档」这种边缘才会经新分支显示免运费进度。即：本批改完，**购物车 tabBar 页在满减关闭时仍不显示免运费进度**（店主拍板范围只有两页顶部条 + 结算条进度；见 §9 Q3）。

### 2.8 测试基线

- `npm run -s test:miniapp` = `node --test tests/miniapp/*.test.cjs`（`package.json:16`）：**253 / 253**。
- `tests/miniapp/promo.test.cjs`（23 例）：`:35-49` 与 `:55-58` 钉住满减开着的三态（本批回归依据，**一字不改**）；**`:50-54`「关活动隐藏」用例的三行断言 `:52-54`**（`{...preview, active:false}` / `null` / `{active:true, discountFen:0}` 各 `.show === false`，`local` 夹具是 LOCAL、有档、subtotal 7000 < 9900）钉的正是本批要改掉的旧行为——改完必然变红，须按 §4.3 改成新行为断言（这是需求变更，不是「让它绿」；§9 Q4）。`:83-94` `cartComponent()` 是在 `node:vm` 里跑真实组件 js 的先例，新组件测试照抄。
- `tests/miniapp/cart-bar-page.test.cjs` 是 WXML 源码级正则断言的先例（`:1-5` 的 `read()` 与 `assert.match`）。
- ES5：`utils/promo.js`、`components/promo-bar/index.js`、`components/local-cart-bar/index.js` 基线 ✔；`pages/index/index.js`、`pages/product/list.js` 基线 ✘（`const` at 11:0）——本批**不需要改这两个 js**。

### 2.9 预览台镜像 `tools/miniapp-preview/`

- `serve.mjs:28-46` `PAGE_COMPONENTS`：`index`、`product-list`、`product-list-local`、`index-local`、`index-local-pickup` 都已登记 `promo-bar`（`:30/32/33/39/40`）——**复用组件则 serve.mjs 不用改**。
- 手写镜像里的满减条：`pages/index-local.html:27`、`pages/index-local-pickup.html:27`（自取，**不加**免运费条）、`pages/index.html:34`（邮寄，不加）、`pages/product-list-preview.js:54`（`renderBase()`，分类页两份镜像共享；`:191-194` 是外送/自取切换的点击处理）。
- README `:31` 规定改 wxml 结构须同步镜像；`:60-63` 有「满减与结算条镜像（2026-09-19）」一节。

### 2.10 与统筹方口述不符 / 需补充之处（以代码为准）

1. `onTapDetail` 的 `wx.showModal` 除 `title/content` 外还有 `showCancel:false, confirmText:'知道了'`（`promo-bar/index.js:18`），复用时自然继承。
2. `progressTipOf` 除结算条组件外**还有 `pages/cart/index.js:130` 在用**（统筹方未提）；影响见 §2.7，不改它。
3. 预览 `docs/superpowers/previews/2026-09-21-freeship-bar.html:111`（§① 左侧手机的结算条提示）画的是「再买 ¥28 减 ¥6.6 · 再买 ¥20 免运费（2 km 内）」——这是**满减开着、未达档**的状态，按拍板 3「既有三态逐字不变」应仍是「再买 ¥28 减 ¥6.6」；预览 §③ 自己的说明（`:162`）也写「满减开着时的三态上一批已经定了，不变」。**以文字拍板为准**（§9 Q1）。
4. 主页 `<promo-bar>` 在 `index.wxml:55`、分类页在 `list.wxml:75`，与统筹方一致；分类页模式栏在 sticky 的 `.catalog-toolbar` 内（`:85-87`），新条在吸顶栏之前、随页面滚离。
5. 既有 `promo.test.cjs:52-54` 三行必须随需求改（§2.8）——统筹方「既有测试不得改」的规则在此处与拍板 3 冲突，本方案按拍板 3 处理并把改动范围钉死到这三行（§6-A5 用 diff 行数核对）。

---

## 3. 目标与范围

做：`utils/promo.js` 新增 `freeShipBarOf(meta, deliveryType)` + `progressTipOf` 补满减关闭分支；`components/promo-bar` 加 `kind` / `meta` 属性复用为免运费条；两页各挂一条；新测试文件；预览台镜像；README 与本文件执行记录。

不做：服务端、后台、`app.*`、金额计算、购物车 tabBar 页、门店头 `buildRules`、商品卡打标、邮寄渠道任何展示、分类页几何逻辑。

---

## 4. 固定口径（执行方逐字执行，不重新讨论）

### 4.1 复用 `promo-bar` 组件而不是新建 `freeship-bar`（已定）

理由：① 一套 wxss（拍板 1「同色同样式」，新建组件要复制或 `@import` 四条规则，将来改一处漏一处）；② 一套 `wx.showModal` 逻辑；③ 两页 `.json` 与 `serve.mjs` 的 `PAGE_COMPONENTS` 都不用改；④ 既有 `cart-bar-page.test.cjs:34-41` 用例照旧通过。代价：`kind="freeship"` 时 `promotion` 属性闲置——可接受。

组件改动：

- `index.js` properties 增加 `kind: { type: String, value: 'promo' }`、`meta: { type: null, value: null }`；observer 改为 `'kind, promotion, meta, deliveryType'`，体内：`kind === 'freeship' ? freeShipBarOf(meta, deliveryType) : promoBarOf(promotion, deliveryType)`。`onTapDetail` 不改。
- `index.wxml:2` 角标改为 `{{bar.badge}}`（`promoBarOf` 返回 `badge: '减'`，`freeShipBarOf` 返回 `badge: '免'`；两个 hidden 形状都加 `badge: ''`）。其余三行不动。
- `index.wxss` **不动**。

页面用法（两页相同，只多一行）：

```xml
<promo-bar promotion="{{promotion}}" delivery-type="{{promoType}}" />
<promo-bar kind="freeship" meta="{{meta}}" delivery-type="{{promoType}}" />
```

### 4.2 `freeShipBarOf(meta, deliveryType)`（`utils/promo.js` 新增，ES5）

```
hidden = { show:false, badge:'', name:'', summary:'', detailLines:[] }
deliveryType !== 'LOCAL'            → hidden      // PICKUP / EXPRESS 都不渲染
!meta || !meta.fee                  → hidden
tiers = (meta.fee.freeShipTiers || []).slice().sort(by minAmountFen asc)
tiers.length === 0                  → hidden      // 后台关免运费
radius = meta.radiusKm（缺失/非正 视为「无上限」：任何档都不带距离；与现有 progressTipOf `reached.maxKm < opts.radiusKm` 在 undefined 下为 false 的行为一致）
line(t) = '满 ¥' + yuanShort(t.minAmountFen) + ' 免运费' + (radius > 0 && t.maxKm < radius ? '（' + t.maxKm + ' km 内）' : '')
return {
  show: true, badge: '免', name: '免运费',
  summary: line(tiers[0]) + (tiers.length > 1 ? ' · 多买免更远' : ''),
  detailLines: tiers.map(line).concat([ radius > 0 ? '按下单地址到门店的距离判断；配送范围 ' + radius + ' km' : '按下单地址到门店的距离判断' ]),
}
```

线上配置（tiers 58/2、88/3、128/4、168/5、198/7，radius 8）的期望输出：
`summary` = `满 ¥58 免运费（2 km 内）· 多买免更远`；`detailLines` = `['满 ¥58 免运费（2 km 内）','满 ¥88 免运费（3 km 内）','满 ¥128 免运费（4 km 内）','满 ¥168 免运费（5 km 内）','满 ¥198 免运费（7 km 内）','按下单地址到门店的距离判断；配送范围 8 km']`。wxml 渲染成 `免运费　满 ¥58 免运费（2 km 内）· 多买免更远`（名字与摘要之间是组件里已有的全角空格）。

### 4.3 `progressTipOf(preview, opts)` 新口径

判定顺序：

| 条件 | 行为 |
|---|---|
| `preview && preview.active && !preview.discountFen && preview.nextTierGapFen != null` | **不变**：`再买 ¥X 减 ¥Y`（hint） |
| `preview && preview.active && preview.discountFen` | **不变**：`已减 ¥Z` + 既有第二段逻辑（`promo.js:14-37` 原样） |
| 其余（`!preview`、`!preview.active`、或 `active` 但 `discountFen` 为 0 且 `nextTierGapFen == null`）= 满减关闭 / 未命中 | **新增**：只提示免运费（下表）；非 LOCAL 或无档 → hidden |

免运费三态（`tiers` 按 `minAmountFen` 升序；`reached` = 已达标档中 `maxKm` 最大者；`next` = 未达标档中 `minAmountFen` 最小且 `maxKm` 大于 `reached.maxKm`（无 `reached` 时即金额最小的未达标档）；`radius = opts.radiusKm`）：

| 态 | 条件 | `text` | `tone` |
|---|---|---|---|
| S1 没到最低档 | `!reached && next` | `再买 ¥` + gap + ` 免运费` + (`next.maxKm < radius` ? `（N km 内）` : ``) | `hint` |
| S2 到了一档还有更远档 | `reached && reached.maxKm < radius && next` | `R km 内免运费 · 再买 ¥` + gap + (`next.maxKm < radius` ? ` 免 N km 内运费` : ` 免运费`) | `hint` |
| S3 到顶 | `reached && (reached.maxKm >= radius || !next)` | `reached.maxKm < radius` ? `R km 内免运费` : `已免运费` | `done` |
| 无档 / 非 LOCAL / `!reached && !next`（不可能：无 reached 必有 next） | | hidden | |

其中 gap = `yuanShort(next.minAmountFen − opts.subtotal)`。线上配置下的期望：subtotal 3800 → `再买 ¥20 免运费（2 km 内）`；5800 → `2 km 内免运费 · 再买 ¥30 免 3 km 内运费`；19800 → `7 km 内免运费`（done）；夹具 `[{9900,5}]`、radius 5、subtotal 9900 → `已免运费`（done）。S1 的拼法与既有第二段（`promo.js:27-29`）相同，可抽成内部函数复用，但**既有三态输出必须逐字不变**（§6-A1 回归用例）。

### 4.4 满减开着时**不**追加免运费段到「再买 ¥X 减 ¥Y」

见 §2.10-3、§9 Q1。

---

## 5. 分步改动清单

### T1 纯逻辑 + 测试先红后绿（`utils/promo.js`、新测试文件）

- [ ] 新建 `tests/miniapp/freeship-bar.test.cjs`（`node:test`，先写用例、跑一次确认红）：
  - `freeShipBarOf`：线上五档 → §4.2 期望全量 `deepEqual`；档位乱序输入 → 摘要仍取最低金额档；`tiers: []` / `meta: null` / `meta.fee` 缺失 → `show:false`；`deliveryType` 为 `PICKUP`、`EXPRESS` → `show:false`；`[{9900,5}]` radius 5 → `summary === '满 ¥99 免运费'`（不带距离、单档不带「多买免更远」）；`[{5800,2},{9900,8}]` radius 8 → `detailLines[1] === '满 ¥99 免运费'`；`badge === '免'`、`name === '免运费'`。
  - `progressTipOf` 满减关闭三态：用线上五档 + radius 8，`preview` 分别取 `null`、`{active:false}`、`{active:true, discountFen:0}`（无 `nextTierGapFen`）三种输入各覆盖一次 S1/S2/S3（含 `已免运费` 的 done 态）；`PICKUP`/`EXPRESS` + 满减关闭 → hidden；`freeShipTiers: []` + 满减关闭 → hidden。
  - 回归：把 `promo.test.cjs:35-49、55-58` 的满减开着输入原样再断言一遍（逐字），证明既有三态未变。
  - 组件：仿 `promo.test.cjs:83-94` 在 `node:vm` 里加载 `components/promo-bar/index.js`（`Component: c => config = c`，`wx.showModal` 用 spy 收参），`properties = { kind:'freeship', meta, deliveryType:'LOCAL' }` 调 observer → `data.bar.show === true`、`badge === '免'`；`onTapDetail()` → spy 收到 `{ title:'免运费', content: detailLines.join('\n') }`；`deliveryType:'PICKUP'` → `show === false`；`kind` 默认 + `promotion` → 走 `promoBarOf`、`badge === '减'`。
  - 源码级：两页 `.wxml` 各**恰好一个** `/<promo-bar\b[^>]*kind="freeship"[^>]*\/>/`；它含 `meta="{{meta}}"` 与 `delivery-type="{{promoType}}"`、不含 `wx:if` / `wx:elif`；其 `indexOf` 大于第一个普通 `<promo-bar` 的 `indexOf`、小于 `<local-mode-bar` 的 `indexOf`；`components/promo-bar/index.wxml` 含 `{{bar.badge}}` 且不再含 `>减<`。
- [ ] `utils/promo.js`：加 `freeShipBarOf`（§4.2），`promoBarOf` 的两个返回对象加 `badge`，`progressTipOf` 按 §4.3 改，导出 `freeShipBarOf`。保持 ES5。
- [ ] `tests/miniapp/promo.test.cjs:52-54` 三行改为新行为断言（**只准动这三行**）：`tip({...preview, active:false}, local).text === '再买 ¥29 免运费'`（夹具 radius 5 = maxKm 5 → 不带距离）、`tip(null, local).text === '再买 ¥29 免运费'`、`tip({active:true, discountFen:0}, local).text === '再买 ¥29 免运费'`；三者 `tone === 'hint'`、`show === true`。用例名可保留。
- [ ] 跑 `node --test tests/miniapp/freeship-bar.test.cjs tests/miniapp/promo.test.cjs` 绿；提交（`feat(miniapp): 免运费条纯逻辑与满减关闭时的免运费进度`）。

### T2 组件复用 + 两页挂载

- [ ] `components/promo-bar/index.js`：按 §4.1 加 `kind`、`meta` 属性，observer 改分派。
- [ ] `components/promo-bar/index.wxml:2`：`减` → `{{bar.badge}}`。
- [ ] `pages/index/index.wxml`：`:55` 之后插入 `<promo-bar kind="freeship" meta="{{meta}}" delivery-type="{{promoType}}" />`（仍在 `wx:if/elif` 链之外，`:59` 模式栏之前）。
- [ ] `pages/product/list.wxml`：`:75` 之后、`:78` 搜索 chip 之前插入同一行。
- [ ] 两页 `.js`、`.json`、`.wxss` **不动**。
- [ ] `npm run -s test:miniapp` 全绿；ES5 闸门（§6-A3）；提交（`feat(miniapp): 主页与分类页满减条下加免运费提示条`）。

### T3 分类页几何核实（只读，不改代码）

- [ ] 对照 §2.6 四条触发路径逐条读 `list.js`，把「免运费条出现 / 消失的每一种时机 → 哪一行 `_captureAnchor` / `afterGroupsRendered` 覆盖」写进 §11。
- [ ] 若发现任一时机没有被覆盖（例如某条 setData 改了 `meta` 或 `promoType` 却没有跟 `afterGroupsRendered`）→ **R3，升 L**，不自行加代码。

### T4 预览台镜像

- [ ] `tools/miniapp-preview/pages/index-local.html:27` 之后加一行：`<div class="promo-bar"><span class="promo-badge">免</span><span class="promo-summary">免运费　满 ¥58 免运费（2 km 内）· 多买免更远</span><span class="promo-detail">详情 ›</span></div>`。
- [ ] `tools/miniapp-preview/pages/product-list-preview.js:54` 的满减条字符串之后拼接 `(local ? '<div id="freeship-bar" class="promo-bar">…同上…</div>' : '')`；`:191-194` 模式切换处理里加 `var fs = document.getElementById('freeship-bar'); if (fs) fs.style.display = state.mode === 'PICKUP' ? 'none' : ''`（**不要用 `hidden` 属性**：`.promo-bar { display:flex }` 会压过 UA 的 `[hidden]{display:none}`）。
- [ ] `index-local-pickup.html`、`index.html`、`index-local-closed.html` **不加**（自取 / 邮寄不显示；closed 镜像本就没有满减条）。
- [ ] `serve.mjs` 不动（组件已登记）。
- [ ] 起预览服务做 §6-B2 量测与截图，数字与截图路径写进 §11；提交（`docs(preview): 同城主页与分类页镜像补免运费条`）。

### T5 文档

- [ ] `tools/miniapp-preview/README.md` 在「满减与结算条镜像（2026-09-19）」之后加一小节「免运费提示条镜像（2026-09-21）」：哪几份镜像有、自取/邮寄没有、真实数据来自 `fee.freeShipTiers` / `radiusKm`、满减关闭时结算条进度只提示免运费。
- [ ] 本文件 §11 追加执行记录：每个 T 的提交 sha、§6-A 逐条输出、§6-B 量测数字与截图路径、§6-D 回退验证结果、T3 核实结论。
- [ ] 提交（`docs: 免运费提示条执行记录`）。

---

## 6. 验收标准（命令 / 实测方法 / 期望）

### A. 可脚本化（工序 04 逐条跑，输出贴进核对记录）

| # | 命令（在 worktree 根） | 期望 |
|---|---|---|
| A1 | `npm run -s test:miniapp` | `fail 0`，`pass` ≥ 253 + 新用例数（基线 253，只能多不能少）；`tests/miniapp/freeship-bar.test.cjs` 至少含 T1 列出的每一类用例（五档摘要与详情、乱序、tiers 空、meta 空、PICKUP/EXPRESS、`maxKm>=radiusKm` 不带距离、单档无「多买免更远」、满减关闭三态 ×3 种输入、满减关闭 + 非 LOCAL / 无档 hidden、满减开着三态逐字回归、组件 observer 与 showModal、两页源码级位置）。 |
| A2 | `node --test tests/miniapp/freeship-bar.test.cjs` | 全绿；`grep -c "^test(" tests/miniapp/freeship-bar.test.cjs` ≥ 8。 |
| A3 | `node scripts/check-miniapp-es5.mjs apps/miniapp/utils/promo.js apps/miniapp/components/promo-bar/index.js apps/miniapp/components/local-cart-bar/index.js` | `全部通过（3 个文件）`。 |
| A4 | `git diff --stat b046f37..HEAD -- apps/server apps/admin apps/miniapp/app.json apps/miniapp/app.wxss apps/miniapp/app.js apps/miniapp/utils/local-catalog.js apps/miniapp/utils/local-checkout-state.js apps/miniapp/utils/checkout-pay.js apps/miniapp/utils/pickup-checkout-state.js apps/miniapp/pages/index/index.js apps/miniapp/pages/product/list.js apps/miniapp/pages/product/list.wxss apps/miniapp/pages/index/index.wxss apps/miniapp/pages/cart apps/miniapp/pages/local apps/miniapp/pages/order apps/miniapp/components/local-cart-bar apps/miniapp/components/promo-bar/index.wxss apps/miniapp/components/promo-bar/index.json package.json package-lock.json scripts tools/miniapp-preview/serve.mjs` | 输出为空。 |
| A5 | `git diff --name-only b046f37..HEAD` | 每个文件都在 §7 白名单内。`git diff b046f37..HEAD -- tests/miniapp/promo.test.cjs \| grep -E '^-[^-]' \| wc -l` = **3**，且这三行都来自原 52–54 行（`git diff -U0 b046f37..HEAD -- tests/miniapp/promo.test.cjs` 的 hunk 头是 `@@ -52,3 …`）；其余既有 `tests/miniapp/*.test.cjs` 不在 `--name-only` 输出里。 |
| A6 | `grep -c 'promo-badge">免' tools/miniapp-preview/pages/index-local.html tools/miniapp-preview/pages/product-list-preview.js tools/miniapp-preview/pages/index-local-pickup.html tools/miniapp-preview/pages/index.html` | 依次 `1`、`1`、`0`、`0`。 |
| A7 | `grep -c 'kind="freeship"' apps/miniapp/pages/index/index.wxml apps/miniapp/pages/product/list.wxml` | 各 `1`。 |
| A8 | `node -e "var p=require('./apps/miniapp/utils/promo');var m={radiusKm:8,fee:{freeShipTiers:[{minAmountFen:5800,maxKm:2},{minAmountFen:8800,maxKm:3},{minAmountFen:12800,maxKm:4},{minAmountFen:16800,maxKm:5},{minAmountFen:19800,maxKm:7}]}};console.log(JSON.stringify(p.freeShipBarOf(m,'LOCAL')));var o={deliveryType:'LOCAL',freeShipTiers:m.fee.freeShipTiers,radiusKm:8};[3800,5800,19800].forEach(function(s){o.subtotal=s;console.log(JSON.stringify(p.progressTipOf(null,o)))});console.log(JSON.stringify(p.progressTipOf({active:true,discountFen:0,nextTierGapFen:2800,nextTierCutFen:660},o)))"` | 第 1 行 `summary` = `满 ¥58 免运费（2 km 内）· 多买免更远`，`badge` = `免`，`detailLines` 六行同 §4.2；第 2–4 行 `text` 依次 `再买 ¥20 免运费（2 km 内）`(hint) / `2 km 内免运费 · 再买 ¥30 免 3 km 内运费`(hint) / `7 km 内免运费`(done)；第 5 行 `text` = `再买 ¥28 减 ¥6.60`（满减开着未达档，**不带**免运费段；`yuanShort` 只去掉 `.00`，660 分就是 `6.60`，与预览图上的 `6.6` 不同——那是预览示意，代码现状本批不动）。 |

### B. 预览台（执行方跑，数字与截图进 §11）

| # | 方法 | 期望 |
|---|---|---|
| B1 | `node tools/miniapp-preview/serve.mjs --port 5180`（后台起，`curl -s -o /dev/null -w '%{http_code}' http://localhost:5180/` 轮询 ≤ 30 s，被占则换 5181 并记录） | 首页画廊可开。 |
| B2 | **375 宽摘要不被省略（量法）**：浏览器视口设为 375 宽打开 `http://localhost:5180/pages/product-list-local.html` 与 `pages/index-local.html`，在控制台跑 `(function(){var bars=document.querySelectorAll('.promo-bar');var b=bars[bars.length-1];var s=b.querySelector('.promo-summary');return {bar:b.clientWidth,summaryBox:s.clientWidth,summaryContent:s.scrollWidth,fits:s.scrollWidth<=s.clientWidth}})()`（`.promo-summary` 是 `overflow:hidden; white-space:nowrap`，`scrollWidth` 即 max-content 宽；等价于「max-content 探针 − 扣掉内边距、角标、gap、『详情 ›』后的可用宽」）。若浏览器不便设视口，可在 iframe 外层用 DevTools 设备工具栏选 iPhone SE/6/7/8（375）。 | 两页 `fits === true`，并把四个数字写进 §11（估算：可用 ≈ 375 − 28 内边距 − 2×6 gap − ≈17 角标 − ≈29「详情 ›」≈ 289 px；文案 12 px 字号约 265 px）。若 `fits === false` → R4。 |
| B3 | 同一页点「自取」 | 免运费条消失（`display:none`），点回「外送」恢复。`index-local-pickup.html` 无免运费条。 |
| B4 | 截图 `product-list-local`（外送）、`index-local` 各一张，存 `docs/superpowers/previews/2026-09-21-freeship-bar-shots/`（PNG，≤ 300 KB/张） | 与预览 HTML §① 左图版式一致：满减条正下方、模式栏之上，同底色，角标「免」。 |

### C. 真机验收清单（只能真机验；店主在体验版做，执行方在 §11 写清操作步骤）

| # | 操作 | 期望 |
|---|---|---|
| C1 | 后台满减**开**：主页（同城·外送）与分类页 | 顶部两条叠着：「减」满减条在上、「免」免运费条在下，同底色；点免运费条「详情 ›」弹系统弹窗，标题「免运费」，五档 + 末行「按下单地址到门店的距离判断；配送范围 8 km」；加 1 件（≈¥38）看结算条上方：「再买 ¥28 减 ¥6.60」（**不带**免运段，与上一批一致；`6.60` 不是 `6.6`）；加到满减档后显示「已减 ¥… · 再买 ¥… 免运费（2 km 内）」。 |
| C2 | 后台满减**关**：同两页 | 满减条消失、免运费条仍在；结算条上方随金额三态：<¥58 「再买 ¥X 免运费（2 km 内）」→ ¥58–87 「2 km 内免运费 · 再买 ¥X 免 3 km 内运费」→ ≥¥198 绿底「7 km 内免运费」。提示行出现/消失时页面底部占位跟着变（最后一件商品不被遮）。 |
| C3 | 切「自取」 | 免运费条消失；结算条上方不出现免运费进度（满减开着时仍按自取渠道显示满减提示）。切回「外送」恢复。切「全国邮寄」两页都没有免运费条。 |
| C4 | 分类页（同城）上滑让门店头、两条提示、模式栏收起到吸顶，再下拉刷新 / 切外送↔自取 / 切后台（onShow 回来） | 页面不跳动、左侧高亮不乱；若跳动 → R3。 |
| C5 | 后台把免运费档位清空（保存空数组）后重进 | 免运费条不渲染、结算条上方无免运费进度；恢复档位后再进恢复。 |
| C6 | 320 宽机型或开发者工具 iPhone 5 | 免运费条摘要允许省略号（375 才是硬要求）；「详情 ›」仍可点。 |

### D. 回退验证（至少两处，执行方跑并记录；**先提交再做**，用 `git checkout -- <file>` 复原）

| # | 操作 | 期望 |
|---|---|---|
| D1 | 临时把 `utils/promo.js` 的 `progressTipOf` 开头改回 `if (!preview || !preview.active) return hidden`，跑 `node --test tests/miniapp/freeship-bar.test.cjs tests/miniapp/promo.test.cjs` | 满减关闭三态用例与 `promo.test.cjs` 「关活动」用例变红；复原后全绿。 |
| D2 | 临时删掉 `pages/index/index.wxml` 那行 `kind="freeship"`，跑 `node --test tests/miniapp/freeship-bar.test.cjs` | 源码级「两页各恰好一个」用例变红；复原后全绿。 |
| D3（可选） | 临时把 `freeShipBarOf` 的 `badge` 改成 `'减'` | 组件/纯函数用例变红；复原后全绿。 |

---

## 7. 允许修改的文件白名单

**允许（精确）：**

- `apps/miniapp/utils/promo.js`
- `apps/miniapp/components/promo-bar/index.js`、`apps/miniapp/components/promo-bar/index.wxml`
- `apps/miniapp/pages/index/index.wxml`（只加一行）、`apps/miniapp/pages/product/list.wxml`（只加一行）
- `tests/miniapp/freeship-bar.test.cjs`（新）
- `tests/miniapp/promo.test.cjs`（**仅第 52–54 行**，§5-T1）
- `tools/miniapp-preview/pages/index-local.html`、`tools/miniapp-preview/pages/product-list-preview.js`、`tools/miniapp-preview/README.md`
- `docs/superpowers/previews/2026-09-21-freeship-bar-shots/*.png`（新）
- 本文件（追加 §11 执行记录）

**禁止：** 上列之外一切文件。特别点名：`apps/server/**`、`apps/admin/**`、`apps/miniapp/app.json`、`app.wxss`、`app.js`、`utils/local-catalog.js`、`utils/local-checkout-state.js`、`utils/checkout-pay.js`、`utils/pickup-checkout-state.js`、`pages/index/index.js`、`pages/product/list.js`、两页 `.wxss` / `.json`、`components/promo-bar/index.wxss` / `index.json`、`components/local-cart-bar/**`、`components/local-store-header/**`、`pages/cart/**`、`package*.json`、`scripts/**`、`tools/miniapp-preview/serve.mjs`、`index-local-pickup.html`、`index.html`、其它既有 `tests/miniapp/*.test.cjs`。

---

## 8. 环境配方与执行注意事项

- 不需要本地服务端、数据库、Prisma：本批全部用纯函数夹具与源码级断言验收；真机项由店主做。
- 测试：`npm run -s test:miniapp`（约 3 s）。单文件：`node --test tests/miniapp/freeship-bar.test.cjs`。
- ES5：`node scripts/check-miniapp-es5.mjs <文件…>`（§6-A3 那三个）。`pages/*.js` 本批不动，若不得不动 → R5。
- 预览台：`node tools/miniapp-preview/serve.mjs --port 5180` 用后台方式起（Bash `run_in_background` 或等价），`curl` 轮询就绪 ≤ 30 s；验收完 kill。本机无 `timeout` 命令，每条工具调用自带超时（≤ 120 s）。
- 长时间等待会被系统判停：不要无上限等任何命令。
- **先提交再做回退验证**（§6-D）。
- 不在任何表单输入密码；不上传体验版、不合并 main、不部署。
- 小程序改动要在开发者工具里看必须合到 main（工具读主仓磁盘）——店主的事；执行方只保证 worktree 内验收、截图与 §11 记录。
- 提交信息中文，每个 T 一次提交；署名用执行方真实模型名：`Co-Authored-By: Claude <模型名> <noreply@anthropic.com>`。

---

## 9. 待店主确认（有默认值，不阻塞开工；执行按默认值做，店主改口再调）

| # | 问题 | 默认值 |
|---|---|---|
| Q1 | 预览 §① 左图结算条提示画了「再买 ¥28 减 ¥6.6 · 再买 ¥20 免运费（2 km 内）」，与拍板 3「满减开着三态逐字不变」冲突（旧文案是「再买 ¥28 减 ¥6.60」）。 | **按文字拍板**：满减开着、未达档时**不**追加免运段（§4.4）。要追加另开一批。 |
| Q2 | S2 中间态遇到「下一档 `maxKm >= radiusKm`」（线上目前没有：最高档 7 km < 8 km）文案写什么？ | 「R km 内免运费 · 再买 ¥X 免运费」（与「`maxKm>=radiusKm` 不带距离」规则一致）。 |
| Q3 | 购物车 tabBar 页（`pages/cart`）满减关闭时仍不显示免运费进度（§2.7）。 | **本批不动**（拍板范围只有两页顶部条 + 结算条进度）；记入后续待办。 |
| Q4 | `tests/miniapp/promo.test.cjs:52-54` 钉的是旧行为，本批必须改这三行断言。 | **改**（这是需求变更；范围钉死到三行，§6-A5 核对）。 |
| Q5 | `radiusKm` 缺失或非正时（线上不会）免运费条与进度的距离写法。 | 一律不带距离；弹窗末行只写「按下单地址到门店的距离判断」。 |
| Q6 | 后台只配一档时摘要要不要「· 多买免更远」？ | **不要**（单档没有「更远」）。 |
| Q7 | 免运费条的名字固定「免运费」（满减条用后台活动名）。 | **固定**。 |

---

## 10. 上报触发条件（命中任一，执行方停下、写进 §11 现象与位置，不自行绕过）

- R1 需要改 `components/local-cart-bar/**` 的高度上报机制（`measureDock` / `height` 事件）或两页的 `onCartHeight` 才能让提示行出现时占位跟上——方案假定现有机制已覆盖（§2.5）。
- R2 `progressTipOf` 改动波及满减开启时的任一文案：`promo.test.cjs:35-49、55-58` 任一变红，或 §6-A8 第 5 行输出不是 `再买 ¥28 减 ¥6.60`。
- R3 分类页头部高度变化导致页面跳动 / 侧栏错位，且 §2.6 列出的现有补偿不覆盖（T3 读码发现缺口，或真机 C4 跳动）→ **升 L**。
- R4 375 宽摘要放不下（§6-B2 `fits === false`）须改文案——文案是店主拍的，不自行缩。
- R5 需要改 §7 白名单外任何文件（含 `pages/index/index.js`、`pages/product/list.js`、`serve.mjs`、既有测试除 `promo.test.cjs:52-54`）。
- R6 `/local/meta` 的 `fee.freeShipTiers` 或 `radiusKm` 形状与 §2.1 不符（例如 `maxKm` 字段名不同）。
- R7 与已确认预览有需要取舍的偏离（位置、文案、三态、结构），Q1–Q7 之外。
- R8 §6-A3 三个文件任一 ES5 ✘（基线全 ✔）。
- R9 `npm run -s test:miniapp` 通过数少于 253，或除 `promo.test.cjs:52-54` 外任何既有用例需要改动。

---

## 11. 执行记录（01 执行方追加；每条注明「当前工序 0X · 模型」与提交 sha）

（空）

## 10. 统筹裁定（2026-09-21，开工前）

- **Q1 → 以店主确认的预览为准，不按「三态逐字不变」。** 那条约束是统筹方自己加的保守要求，不是店主拍板；店主看过并确认的预览 §① 左图明确画了「满减开着、未达档」时追加免运费段。裁定：`progressTipOf` 在 `preview.active && !preview.discountFen` 分支（`promo.js:10-13`）也追加免运费第二段，文案与 §4.3 满减关闭分支的同一函数产出（例：「再买 ¥28 减 ¥6.60 · 再买 ¥20 免运费（2 km 内）」）；已达满减的两态（`已减 …` 起头）本就含免运费段，**逐字不变**。
  - 连带：§6-A5 允许改动的 `promo.test.cjs` 旧断言范围从「三行」放宽到「满减未达档那一条用例 + 满减关闭三行」，仍用 diff 行数核对并在执行记录里逐行列出改前/改后。
  - 连带：375 宽下该文案可能折成两行——允许，结算条 dock 高度是实测上报的（`measureDock`），页面占位会跟着变；但 B 类验收须补一条：375 宽、满减开着未达档、有免运费差额时，提示行数 ≤2、dock 高度上报与实际一致、最后一件商品仍在条上方。
- **Q2、Q5–Q7 按默认值。**
- **Q3（购物车 tabBar 页满减关闭时不显示免运费进度）→ 本批一并做**，不留后续：`pages/cart/index.js:130` 前的直接置 hidden 改为同样经 `progressTipOf`；这与主线是同一个漏洞，分两批只会让顾客在两个页面看到不一致。白名单相应加入 `pages/cart/index.js`（只改这一处调用），`cart-bar-page.test.cjs` 已有「购物车页同一固定容器内展示活动进度提示」用例，补一条满减关闭时仍有免运费提示的断言。
- **Q4 → 改，按上面放宽后的范围。**

## 11. 统筹裁定（2026-09-21，店主追加：提示文案金额格式）

店主要求满减/免运费提示里的金额「小数点后一位为止」。经确认，**范围只限满减条、免运费条、进度提示、详情弹窗的文案**；商品价、结算应付、订单与小票金额仍为固定两位（与微信支付页一致），本批不动。规则：**去掉末尾的 0，有分就显两位**——660→`6.6`，3800→`38`，450→`4.5`，3705→`37.05`，1080→`10.8`。
- 落点：`utils/promo.js` 的 `yuanShort`（现只去 `.00`）改为去末尾零：`(fen/100).toFixed(2).replace(/\.?0+$/, '')`；它是提示文案的唯一格式化入口，`promoBarOf` / `progressTipOf` / 新增 `freeShipBarOf` 全部经它，改一处即全覆盖。
- 验收补：`freeship-bar.test.cjs` 加 `yuanShort` 五例（660/3800/450/3705/1080）；`promo.test.cjs` 里凡断言含 `6.60` 类文案的期望值随之改为 `6.6`（列入 §6-A5 的允许改动范围，逐行列出改前/改后）；§4.3 判定表与 C 类真机清单中的「6.60」一律按 `6.6` 读。
- 不得把 `yuanShort` 用到应付金额、商品价上；`price.wxs`/`formatPrice` 不动。
