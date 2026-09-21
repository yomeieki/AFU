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

**工序 01 · sonnet**（2026-09-21，worktree `/Users/yumingyi/food-shop/.claude/worktrees/freeship-bar`，分支 `claude/freeship-bar`，基线 `4a16000`）。

### 提交列表

| 提交 | sha | 内容 |
|---|---|---|
| T1+T2（合并，见下方说明） | `47ba8be` | `utils/promo.js` 新增 `freeShipBarOf`/`freeShipTip`、`progressTipOf` 补漏洞并按统筹裁定追加免运段、`yuanShort` 去尾零；`promo-bar` 组件加 `kind`/`meta`；两页各插一行；新测试文件；`promo.test.cjs` 两处断言改写 |
| Q3（方案外统筹裁定，无独立 T 编号） | `deeaae1` | `pages/cart/index.js:loadPromo` 满减关闭时改经 `progressTipOf(null, opts)`；`cart-bar-page.test.cjs` 补一条行为测试 |
| T6 | `c01f5bf` | `local-store-header` 规则行首段标红；`channel-badge-page.test.cjs` 补三条；预览台 `index-local-pickup.html` |
| T4 | `71d8e4f` | `index-local.html`、`product-list-preview.js` 补免运费条镜像；375 宽实测截图 |

**T1/T2 合并说明**：方案 §5-T1 的完成条件是「跑 `freeship-bar.test.cjs`、`promo.test.cjs` 绿再提交」，但该测试文件按 §5-T1 第 4 条本就包含 `promo-bar` 组件 `kind` 分派与两页源码级位置断言——这些只有在 T2 的组件/wxml 改动落地后才能通过。若严格按 T1/T2 两次提交拆分，T1 那次提交会带着红测试。为保证每次提交测试都是绿的（`verification-before-completion`），把 T2 的文件改动一并放进了这一次提交，未单独为 T2 再开一次提交。T5（本记录）单独成立，T3 无独立提交（见下）。

### T3：分类页几何核实（只读，未改代码）

逐条读 `apps/miniapp/pages/product/list.js`，对照 §2.6 四条触发路径核实：

1. **`loadMeta(resolve)`**（`list.js` 约 152-166 行）：setData 前调 `self._captureAnchor()`，setData 后（LOCAL 与 EXPRESS 分支）都调 `self.afterGroupsRendered()`。免运费条随 `meta`/`promoType` 在同一次 setData 出现/消失，被这次重量覆盖。
2. **`applyMode(mode)`**（外送/自取切换，约 662-668 行）：函数开头 `_captureAnchor()`，setData 后 `afterGroupsRendered()`（注释明写"外送/自取切换会改页头高度，要重量"）。自取模式下免运费条消失（`freeShipBarOf` 对非 LOCAL 返回 hidden），此路径已覆盖。
3. **切渠道 `reloadForChannel`**（约 118-148 行）：函数一开始就 `this.scrollPageTo(0, 0)` 把滚动位置清零，随后各自调用 `this.loadCatalog()`（自带 `afterGroupsRendered()`）与 `this.loadMeta(...)`（同第 1 点的覆盖）。滚动已归零，锚点补偿在此路径是多余但无害。
4. **`onShow()`**（约 68-77 行）：无条件调用 `this.loadMeta()`（不传 resolve）与 `this.afterGroupsRendered()`；即使 `meta` 数值未变（例如后台没改任何配置），也会重新量一次——不会漏掉后台在小程序切到后台期间改了免运费档位的情况。

另确认：`measureOffsets()` 里补偿用的 `bodyTop` 取自 `.catalog-body` 的位置，免运费条位于 `.catalog-body` **之上**（不在 sticky 的 `.catalog-toolbar` 内），所以条的显示/隐藏只改变 `bodyTop`、不改变 `pinnedHeight`，与既有补偿逻辑（`anchor.bodyTop !== bodyTop || anchor.pinnedHeight !== pinnedHeight` 触发 `scrollPageTo`）完全对应。

**结论**：四条触发路径均已被现有 `_captureAnchor`/`afterGroupsRendered` 覆盖，未发现缺口，**不触发 R3**。未新增任何几何代码。

### T4：375 宽 B 类实测（§6-B2/B3/B4）

预览服务：`node tools/miniapp-preview/serve.mjs --port 5203`（后台启动，`curl` 轮询 1 秒后 200 就绪）。

**B2**（浏览器 375×812 视口，控制台跑方案给定探针函数）：

| 页面 | 元素 | bar | summaryBox | summaryContent | fits |
|---|---|---|---|---|---|
| `pages/product-list-local.html` | 满减条 | 375 | 287 | 287 | true |
| `pages/product-list-local.html` | 免运费条 | 375 | 287 | 287 | true |
| `pages/index-local.html` | 满减条 | 375 | 287 | 287 | true |
| `pages/index-local.html` | 免运费条 | 375 | 287 | 287 | true |

两页免运费条摘要「免运费　满 ¥58 免运费（2 km 内）· 多买免更远」在 375 宽下 `scrollWidth(287) <= clientWidth(287)`，不省略。**未触发 R4**。

**B3**：`product-list-local.html` 点「自取」→ `#freeship-bar` 的 `getComputedStyle().display` 由 `flex` 变 `none`；同时 `#rules-row` 局部刷新为红字+灰字两段；点回「外送」→ `display` 恢复 `flex`。`index-local-pickup.html` 本就没有 `#freeship-bar` 元素（A6 grep 计数为 0，见下）。

**B4**：截图存 `docs/superpowers/previews/2026-09-21-freeship-bar-shots/product-list-local.png`（113941 字节）与 `.../index-local.png`（68303 字节），均 < 300 KB。人工核对：免运费条紧贴满减条下方、同底色（`#fff7f2`）、红色「免」徽标，位置与 `docs/superpowers/previews/2026-09-21-freeship-bar.html` §① 左图一致。

### D 类回退验证（先提交再做，用 `git checkout -- <file>` 复原）

| # | 操作 | 结果 |
|---|---|---|
| D1 | `progressTipOf` 开头临时加回 `if (!preview \|\| !preview.active) return hidden` | 红：`progressTipOf 满减关闭/未命中：S1/S2/S3 三态…`、`progressTipOf 满减关闭：单档 radius 等于 maxKm 时已免运费`、`关活动隐藏，自取与邮寄不出免运段，下一档按服务端响应`（共 3 例，`tests 39 / pass 36 / fail 3`）；`git checkout --` 复原后 `tests 39 / pass 39 / fail 0`，`git status --porcelain` 为空 |
| D2 | 删掉 `pages/index/index.wxml` 的 `kind="freeship"` 那行 | 红：`两页 wxml 各恰好一个 kind="freeship" 的 promo-bar，且位置正确`（`tests 16 / pass 15 / fail 1`）；复原后 `pass 16 / fail 0`，工作区干净 |
| D3 | `freeShipBarOf` 的 `badge` 临时改成 `'减'` | 红：`freeShipBarOf 线上五档：摘要与详情`、`promo-bar 组件：kind=freeship 走 freeShipBarOf，deliveryType 非 LOCAL 隐藏`（`tests 16 / pass 14 / fail 2`）；复原后 `pass 16 / fail 0`，工作区干净 |

### A 类实测输出（最终态，HEAD `71d8e4f`）

- **A1** `npm run -s test:miniapp` → `tests 273 / pass 273 / fail 0`（基线 253 + 20 新增：`freeship-bar.test.cjs` 16 例 + `cart-bar-page.test.cjs` 1 例 + `channel-badge-page.test.cjs` 3 例）。
- **A2** `node --test tests/miniapp/freeship-bar.test.cjs` → `tests 16 / pass 16 / fail 0`；`grep -c "^test(" tests/miniapp/freeship-bar.test.cjs` = `16`。
- **A3** `node scripts/check-miniapp-es5.mjs apps/miniapp/utils/promo.js apps/miniapp/components/promo-bar/index.js apps/miniapp/components/local-cart-bar/index.js` → 三个文件全部 `ES5 ✔`。
- **A4**（偏离，见下）`git diff --stat b046f37..HEAD -- <排除集合>` → **非空**：`apps/miniapp/pages/cart/index.js | 14 ++++++++++----`（`1 file changed, 10 insertions(+), 4 deletions(-)`）。原排除集合把整个 `apps/miniapp/pages/cart` 目录列为禁改，但统筹裁定 Q3（§10）明确授权改 `pages/cart/index.js` 这一处 `loadPromo`；排除集合本身没有随 Q3 更新。核对结论：该文件之外，排除集合内其余路径 diff 为空。
- **A5**（偏离，见下）`git diff --name-only b046f37..HEAD` 共 19 个文件（见下方逐一核对）；`promo.test.cjs` 删除行数 = **4**（不是原定的 3），hunk 头 `@@ -36 +36,2 @@`、`@@ -52,3 +53,4 @@`——统筹裁定 Q1（§10）把允许改动范围从「三行」放宽到「满减未达档那一条用例 + 满减关闭三行」，4 = 1（未达档那行）+ 3（关闭三行），与放宽后的范围一致。
- **A6** `grep -c 'promo-badge">免' index-local.html product-list-preview.js index-local-pickup.html index.html` → `1、1、0、0`，与预期一致。
- **A7** `grep -c 'kind="freeship"' index/index.wxml product/list.wxml` → `1、1`，与预期一致。
- **A8**（第 5 行偏离，见下）`node -e "..."` 输出五行：
  1. `{"show":true,"badge":"免","name":"免运费","summary":"满 ¥58 免运费（2 km 内）· 多买免更远",...}` —— 与 §4.2 期望逐字一致。
  2. `{"show":true,"text":"再买 ¥20 免运费（2 km 内）","tone":"hint"}` —— 与期望一致。
  3. `{"show":true,"text":"2 km 内免运费 · 再买 ¥30 免 3 km 内运费","tone":"hint"}` —— 与期望一致。
  4. `{"show":true,"text":"7 km 内免运费","tone":"done"}` —— 与期望一致。
  5. `{"show":true,"text":"再买 ¥28 减 ¥6.6 · 7 km 内免运费","tone":"hint"}` —— 与方案原定的 `再买 ¥28 减 ¥6.60`（不带免运段）不同，原因见下方偏离说明第③④条；`· 7 km 内免运费` 是因为方案给的这条 `node -e` 命令复用了同一个 `o` 对象，前面三次 `forEach` 把 `o.subtotal` 改到了 `19800` 才调这第五行，属于命令本身的写法，不是本次改动引入的额外差异。

### 与方案的偏离（逐条）

1. **T1/T2 合并为一次提交**：原因见上方"提交列表"说明，非内容偏离，只是提交切分方式变化。
2. **`freeShipBarOf` 的 summary 拼接去掉了 §4.2 代码片段里 `' · 多买免更远'` 的前导空格**：方案 §4.2 的可执行代码片段写的是 `' · 多买免更远'`（带一个前导空格），但同一节的期望文案（§4.2 正文、T4 镜像 markup、§6-A8）三处都写的是「…内）· 多买免更远」（`）`与`·`之间无空格）。判定代码片段是笔误，以文字口径为准，实现为 `'· 多买免更远'`（无前导空格）。已用 `node -e` 实测验证与三处文字口径一致。
3. **`progressTipOf` 第 5 行按统筹裁定 Q1 追加免运段**：方案原始 §6-A8 期望第 5 行「不带免运费段」，但这是统筹裁定 Q1（§10）明确要改的行为，本条不是新偏离，只是把 A8 表格里尚未更新的期望值在此记录更正。
4. **`yuanShort` 改动后 660 分显示为 `6.6`**：这是店主追加的统筹裁定（§11 标题「提示文案金额格式」）要求的效果，§6-A8 原表格里的 `6.60` 属于该统筹裁定之前写的期望值，未同步更新，此处按裁定后的口径执行。
5. **`local-store-header/index.wxml` 规则行容器可见性用 `{{rulesLead || rulesText}}`，未按方案原样保留 `{{rulesText}}`**：方案 §12 第 2 点写「行容器…不动」，隐含还是 `wx:if="{{rulesText}}"`。但把 discountText 从 `rulesText` 里拆到 `rulesLead` 后，若门店只配了 `pickup.discountText`、没配起送线/门店地址，`rulesText` 会是空串——若容器仍只看 `rulesText`，会把整行（连同红字）一起隐藏，与"红字要显眼"的需求相悖。改为 `{{rulesLead || rulesText}}` 修复这个边界，属于必要的正确性修正，不改变正常配置（有起送线/地址）下的可见性判断结果。
6. **`local-store-header/index.wxss` 未按方案字面用 `:last-of-type` 选择器**：方案 §12 第 3 点给的选择器是 `.delivery-rules-row .delivery-rules:last-of-type`。但该行末尾的 `<text class="delivery-rules-arrow">` 也是 `<text>` 标签（`canNavigate` 为真时才渲染），`:last-of-type` 按标签类型取"同类型最后一个"，会被 `.delivery-rules-arrow` 抢到，导致真正的末段普通文字反而拿不到 `flex:1`（在自取+有门店坐标的场景，恰好就是箭头会出现的场景，等于这个 bug 会在最常见的自取场景里发作）。改用 `.delivery-rules-row .delivery-rules:not(.delivery-rules-em):not(.delivery-rules-sep)` 精确定位末段，效果与方案意图一致，只是选择器写法不同。
7. **T4 的 `product-list-preview.js` 免运费条实现细节**：方案 §5-T4 第 2 条给的字符串拼接方式是「满减条字符串之后拼接 `(local ? '<div id="freeship-bar" ...>...</div>' : '')`」且未提及自取模式下的初始 `display`。本方案实现为拼接时按 `state.mode` 直接算好初始 `style="display:..."`（而不是先渲染出来再在另一处强制隐藏），效果一致，写法更直接。
8. **规则行拆分（T6）在 `product-list-preview.js` 里没有对应的既有实现可"同步"**：方案 §12 第 5 点假设 `product-list-preview.js` 已有随模式变化的规则行文本（类比 `index-local-pickup.html` 那样的静态镜像），但实际读码发现 `header()` 函数原先对 DELIVERY/PICKUP 渲染的是**同一段固定文字**（只有 `notice-text` 会随模式切换）。本次新增了 `rulesRowHtml(mode)` 函数与 `#rules-row` 局部刷新逻辑，使其行为对齐真实组件（PICKUP 显示拆分的红字+灰字，DELIVERY 保留原固定文字）；这是补齐一个此前不存在的能力，不是"同步"一个已有实现。

### 未命中任何上报触发条件

逐条核对方案 §10 R1-R9：R1（未改 `local-cart-bar` 高度机制，机制天然覆盖，见 T3）、R2（`promo.test.cjs:35-49、55-58` 中除已按统筹裁定明确要改的两处外全部保持绿且逐字回归覆盖）、R3（T3 未发现几何缺口）、R4（B2 实测 `fits:true`）、R5（未触碰白名单外文件——`pages/cart/index.js` 与两个 `tests/*.test.cjs` 均由统筹裁定 Q3/T6 明确授权）、R6（`/local/meta` 形状未变，本次未接触服务端）、R7（Q1-Q7 内已覆盖的偏离已如上逐条说明；本节第 5、6、8 条是执行层面的正确性修正，不是对已确认预览/文案/结构的取舍性偏离）、R8（A3 三文件全 ✔）、R9（A1 273 ≥ 253+20，除统筹裁定授权的三个测试文件外未改动其它既有 `tests/miniapp/*.test.cjs`）。**均未命中，未升 L。**

### 白名单核对（含统筹裁定追加）

实际改动的 19 个文件（A5 name-only 输出）逐一对照：`utils/promo.js`、`components/promo-bar/index.{js,wxml}`、`pages/index/index.wxml`（1 行）、`pages/product/list.wxml`（1 行）、`tests/miniapp/freeship-bar.test.cjs`（新）、`tests/miniapp/promo.test.cjs`（4 行，见 A5）— 均属方案 §7 原始白名单；`tools/miniapp-preview/pages/index-local.html`、`product-list-preview.js`、`README.md`、`docs/superpowers/previews/2026-09-21-freeship-bar-shots/*.png`（新，2 个）、本方案文件（本次 §11 追加）— 均属原始白名单；`pages/cart/index.js`、`tests/miniapp/cart-bar-page.test.cjs` — 统筹裁定 Q3（§10）授权；`components/local-store-header/index.{js,wxml,wxss}`、`tools/miniapp-preview/pages/index-local-pickup.html`、`tests/miniapp/channel-badge-page.test.cjs` — 统筹裁定 T6（§12）授权（其中 `channel-badge-page.test.cjs` 未被 §12 白名单逐字列出文件名，但 §12 第 4 点明文要求"补两条"到该文件，视为同一授权的一部分）。**无白名单外文件被改动。**

### C 类真机验收清单（原样列出，供店主用体验版验）

| # | 操作 | 期望 |
|---|---|---|
| C1 | 后台满减**开**：主页（同城·外送）与分类页 | 顶部两条叠着：「减」满减条在上、「免」免运费条在下，同底色；点免运费条「详情 ›」弹系统弹窗，标题「免运费」，五档 + 末行「按下单地址到门店的距离判断；配送范围 8 km」；加 1 件（≈¥38）看结算条上方：「再买 ¥28 减 ¥6.6」（统筹裁定后不带 `.60`）**追加**「· 再买 ¥X 免运费（… km 内）」（统筹裁定 Q1，与方案原文「不带免运段」不同，以此为准）；加到满减档后显示「已减 ¥… · 再买 ¥… 免运费（2 km 内）」。 |
| C2 | 后台满减**关**：同两页 | 满减条消失、免运费条仍在；结算条上方随金额三态：<¥58 「再买 ¥X 免运费（2 km 内）」→ ¥58–87 「2 km 内免运费 · 再买 ¥X 免 3 km 内运费」→ ≥¥198 绿底「7 km 内免运费」。提示行出现/消失时页面底部占位跟着变（最后一件商品不被遮）。购物车 tabBar 页现在也有同样的免运费进度（统筹裁定 Q3）。 |
| C3 | 切「自取」 | 免运费条消失；结算条上方不出现免运费进度（满减开着时仍按自取渠道显示满减提示）；门店头规则行「自取享 X 折」变红。切回「外送」恢复原色规则行。切「全国邮寄」两页都没有免运费条。 |
| C4 | 分类页（同城）上滑让门店头、两条提示、模式栏收起到吸顶，再下拉刷新 / 切外送↔自取 / 切后台（onShow 回来） | 页面不跳动、左侧高亮不乱；若跳动 → R3（本次 T3 只读核实未发现缺口，仍需真机复验）。 |
| C5 | 后台把免运费档位清空（保存空数组）后重进 | 免运费条不渲染、结算条上方无免运费进度；恢复档位后再进恢复。 |
| C6 | 320 宽机型或开发者工具 iPhone 5 | 免运费条摘要允许省略号（375 才是硬要求）；「详情 ›」仍可点。 |

（体验版需先合并到 main、上传，二者均**不由执行方做**，按方案 §0/§8 要求，此清单只交给店主自行操作验证。）

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

## 12. 统筹裁定（2026-09-21，店主追加：「自取享 9.5 折」改红字）

店主要求把门店头规则行里的「自取享 9.5 折」改成红色、更显眼。**只改这一段的颜色，其余文字、内容、位置不变；外送模式的规则行不变。**

**已查实：**
- 文案来自 `meta.pickup.discountText`（服务端下发，例「自取享 9.5 折」），`utils/local-catalog.js:109-118` `pickupRulesText(meta)` 把它与「满 ¥15 起」「门店地址」用 ` · ` 拼成**一个字符串**；`components/local-store-header/index.js:47` 在 `mode === 'PICKUP'` 时把它赋给 `rulesText`；`index.wxml:14` 用**单个** `<text class="delivery-rules">` 渲染，所以现在没法只给前半段上色。
- `utils/local-catalog.js` 属本方案禁改文件（§7），`pickupRulesText` 与其测试 `tests/miniapp/local-catalog.test.cjs` **一律不动**。

**新增 T6（在 T4 预览台镜像之前做）：**
1. `components/local-store-header/index.js`：`observers['meta, mode']` 里新增 `rulesLead`——`mode === 'PICKUP'` 且 `meta.pickup.discountText` 非空时取该串，否则 `''`；`rulesText` 在有 `rulesLead` 时改为**去掉首段后的剩余部分**（即 `pickupRulesText(meta)` 去掉开头的 `rulesLead + ' · '`；若剩余为空则 `''`）。DELIVERY 模式 `rulesLead` 恒 `''`、`rulesText` 走原 `buildRules`，逐字不变。用字符串前缀裁剪，不重写拼接逻辑，保证与 `pickupRulesText` 同源。
2. `index.wxml:13-16`：规则行改为 `<text wx:if="{{rulesLead}}" class="delivery-rules delivery-rules-em">{{rulesLead}}</text><text wx:if="{{rulesLead && rulesText}}" class="delivery-rules delivery-rules-sep"> · </text><text wx:if="{{rulesText}}" class="delivery-rules">{{rulesText}}</text>`，行容器与 `canNavigate` 箭头不动（整行仍可点开地图）。
3. `index.wxss`：新增 `.delivery-rules-em { color: var(--brand); font-weight: 600; }`；`.delivery-rules-row .delivery-rules` 现有 `flex: 1` 只应作用于最后那段（改为 `.delivery-rules-row .delivery-rules:last-of-type`），前两段 `flex-shrink: 0; white-space: nowrap`，避免红字被压缩省略。
4. 测试：`tests/miniapp/channel-badge-page.test.cjs` 已挂门店头，补两条——PICKUP 下 `rulesLead === meta.pickup.discountText` 且 `rulesText` 以「满 ¥」或地址开头、不再含 discountText；DELIVERY 下 `rulesLead === ''` 且 `rulesText` 与改前一致。源码级：`index.wxml` 含 `delivery-rules-em`，`index.wxss` 含 `.delivery-rules-em` 且 `color: var(--brand)`。
5. 预览台：`tools/miniapp-preview/pages/index-local-pickup.html:25` 与 `product-list-preview.js` 里自取态的规则行同步拆成两段（红字 + 灰字）。

**验收补：** A 类加上述断言；B 类在 375 宽自取模式核对：红字段完整不省略、与后文用「 · 」隔开、整行仍可点；外送模式规则行与 `3cb5ae9` 逐字一致（源码级 diff 对照 `buildRules` 未动）。**白名单加**：`components/local-store-header/index.{js,wxml,wxss}`、`tools/miniapp-preview/pages/index-local-pickup.html`。上报条件加：若 `discountText` 在某些配置下不是 `pickupRulesText` 的首段（前缀裁剪失败），停下上报，不得改 `local-catalog.js`。
