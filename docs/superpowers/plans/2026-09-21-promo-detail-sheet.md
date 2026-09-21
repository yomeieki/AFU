# 活动详情弹层（替换系统弹窗）实施计划

## 0. 给执行方的说明（先读）

- 本文件是「模型分工协议」的 **00 规划 · fable** 产物，等级 **M**（单组件 + 测试 + 预览台镜像 + 文档；无接口变更、不碰金额、不碰服务端）。工序链：**01 执行 · sonnet → 04 机械核对 · haiku（只跑 §6 命令）**。若执行中发现需要改 `utils/promo.js` 的文案产出、两页的 `.js`、或任何白名单外文件 → **停下上报**，由统筹决定是否升 L。
- 各工序只做本职；每次交接第一行声明「当前工序 0X · 模型」。**验收标准只在本文件 §6 定义，不得新增或放宽。** 合并到 main 由统筹方执行；上传体验版由店主决定。
- 仓库：worktree `/Users/yumingyi/food-shop/.claude/worktrees/promo-sheet`，分支 `claude/promo-detail-sheet`，基线 main `a3b76c2`。**只在此目录工作，不 cd 到主检出，不裸 `git stash`，不 `npm install`**（依赖向上解析到主仓；`npm run -s test:miniapp`、`node scripts/check-miniapp-es5.mjs` 直接可跑）。
- 防卡死：每条命令给 timeout（常规 ≤120000ms，测试 ≤300000ms）；预览台 `node tools/miniapp-preview/serve.mjs --port 5205` 用后台方式起，等就绪最多轮询 30 次×1s；某步失败换方法，不反复重试。不在任何表单输入密码。
- **先提交再做回退验证**；每个 T 一个提交，中文信息写明 T 编号，结尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。收尾停掉自己起的服务，`git status --porcelain` 为空。

## 1. 需求（店主 2026-09-21 拍板）

真机截图显示：活动条「详情 ›」用 `wx.showModal` 弹出，`content` 里的 `\n` 被系统弹窗吞成空格，五档免运费挤成一段。店主原话：「把这个显示一排一排的整理清楚，这样看起来有点乱。包括满减也是。」店主看过预览 `docs/superpowers/previews/2026-09-21-promo-detail-sheet.html` 后回复「可以，开始做」。

**定稿：** 把 `promo-bar` 组件的详情从系统弹窗改为**组件内自绘的底部弹层**：
- 从底部弹出，遮罩 + 圆角面板；标题居中（`bar.name`）、右上角「✕」；
- **一档一行**：左列门槛（`满 ¥58`，加粗），右列优惠（免运费：`免运费 2 km 内`，其中距离用品牌色加粗；`maxKm ≥ radiusKm` 的档写 `免运费` 不带距离；满减：`减 ¥6.6`，金额品牌色加粗）；行间分隔线；
- 末行灰字说明（免运费：`按下单地址到门店的距离判断 · 配送范围 8 km`，无 `radiusKm` 时只保留前半句；满减：`与优惠券可叠加 · 运费、打包费不参与`）；
- 底部「知道了」品牌渐变按钮；点遮罩、✕、按钮均关闭；
- 满减和免运费**共用同一套弹层**，两边只差数据；
- 金额与距离文案沿用 `utils/promo.js` 现有 `yuanShort`（去末尾零）与既有档位口径，**不改 `promo.js`**。

## 2. 已查实的事实（执行前自行复核，行号以代码为准）

- 组件 `apps/miniapp/components/promo-bar/index.js`：`properties: kind('promo'|'freeship') / promotion / meta / deliveryType`；observer 按 `kind` 调 `promoBarOf(promotion, deliveryType)` 或 `freeShipBarOf(meta, deliveryType)`，得到 `bar = { show, badge, name, summary, detailLines }`；`onTapDetail` 调 `wx.showModal({ title: bar.name, content: bar.detailLines.join('\n'), showCancel: false, confirmText: '知道了' })`。
- `index.wxml` 只有一行 `<view wx:if="{{bar.show}}" class="promo-bar" bindtap="onTapDetail">…</view>`；`index.wxss` 有 `.promo-bar/.promo-badge/.promo-summary/.promo-detail`；`options.addGlobalClass: true`。
- `utils/promo.js`：`promoBarOf` 的 `detailLines` 是字符串数组 `['满 ¥66 减 ¥6.6', …, '与优惠券可叠加；运费、打包费不参与']`（~86 行）；`freeShipBarOf` 的 `detailLines` 是 `['满 ¥58 免运费（2 km 内）', …, '按下单地址到门店的距离判断；配送范围 8 km']`（~100 行）。**结构化数据（档位数组）组件此刻拿不到，只有字符串**——本批不改 `promo.js`，改为组件内从 `properties`（`promotion.tiers` / `meta.fee.freeShipTiers` + `meta.radiusKm`）自行组装行数据，口径必须与 `promo.js` 的 `detailLines` 逐档一致（用测试钉住：对同一输入，组件行数据拼回的文本 == `detailLines` 去掉末行）。
- 既有自绘弹层可参考：`components/tableware-sheet`（底部弹层、遮罩、关闭）、`components/sku-popup`；**沿用其遮罩/面板/安全区（`env(safe-area-inset-bottom)`）写法与 z-index 层级**，不要另创一套。
- 两页挂载：`pages/index/index.wxml`（`<promo-bar>` 两处：满减、`kind="freeship"`）、`pages/product/list.wxml`（同）；页面 `.js` 不需要动（弹层状态在组件内）。分类页是原生整页滚动 + 吸顶，弹层用 `position: fixed` 覆盖全屏，不受页面滚动影响；打开弹层时**不必**锁页面滚动（与 `tableware-sheet` 一致即可）。
- 预览台镜像：`tools/miniapp-preview/pages/index-local.html`、`product-list-preview.js` 里有活动条镜像，`serve.mjs` 的 `PAGE_COMPONENTS` 已登记 `promo-bar`（其 wxss 会内联）。
- 测试：`tests/miniapp/freeship-bar.test.cjs`（16 例，含组件 `kind` 分派）、`tests/miniapp/promo.test.cjs`、`tests/miniapp/cart-bar-page.test.cjs`（源码级断言先例）。当前基线 `npm run -s test:miniapp` = 273/273。
- 金额格式：`yuanShort`（`utils/promo.js` 第 2 行）已是去末尾零；组件内**直接 require 它**，不复制实现。

## 3. 目标与范围

做：组件内弹层（wxml/wxss/js）、行数据组装、测试、预览台镜像、README 一句。
不做：不改 `utils/promo.js`、不改两页 `.js`、不改 `app.wxss`、不改其它组件、不加新组件文件（弹层就放在 `promo-bar` 里）。

## 4. 设计细节

### 4.1 组件数据
```
data: {
  bar: {...},                 // 不变
  sheetOpen: false,
  sheet: { title: '', rows: [ { left: '满 ¥58', right: '免运费', em: '2 km', tail: ' 内' } ], note: '' }
}
```
- 免运费行：`left = '满 ¥' + yuanShort(minAmountFen)`；若 `maxKm < radiusKm`（`radiusKm > 0` 时）→ `right='免运费 '`, `em = maxKm + ' km'`, `tail=' 内'`；否则 `right='免运费'`, `em=''`, `tail=''`。档位按 `minAmountFen` 升序。`note = radius > 0 ? '按下单地址到门店的距离判断 · 配送范围 ' + radius + ' km' : '按下单地址到门店的距离判断'`。
- 满减行：`left = '满 ¥' + yuanShort(minFen)`，`right='减 '`, `em='¥' + yuanShort(cutFen)`, `tail=''`；按 `minFen` 升序；`note = '与优惠券可叠加 · 运费、打包费不参与'`。
- 行数据组装写成组件文件内的纯函数 `sheetRowsOf(kind, promotion, meta)` 并 `module.exports` 导出（Component 文件可同时导出，见 `local-cart-bar` 是否有先例；若小程序运行时不允许在 Component 文件导出，改为放在 `components/promo-bar/sheet.js`（白名单内）由 index.js require）。
- `onTapDetail`：`bar.show` 才开；`setData({ sheetOpen: true, sheet })`。`onCloseSheet`：`setData({ sheetOpen: false })`。遮罩 `catchtap` 关闭，面板 `catchtap` 吞掉冒泡（防止点面板关闭）。

### 4.2 WXML
在现有 `.promo-bar` 之后追加：
```
<view wx:if="{{sheetOpen}}" class="promo-sheet-mask" catchtap="onCloseSheet">
  <view class="promo-sheet" catchtap="noop">
    <view class="promo-sheet-head"><text class="promo-sheet-title">{{sheet.title}}</text><view class="promo-sheet-close" catchtap="onCloseSheet">✕</view></view>
    <view class="promo-sheet-row" wx:for="{{sheet.rows}}" wx:key="left">
      <text class="promo-sheet-k">{{item.left}}</text>
      <text class="promo-sheet-v">{{item.right}}<text wx:if="{{item.em}}" class="promo-sheet-em">{{item.em}}</text>{{item.tail}}</text>
    </view>
    <text wx:if="{{sheet.note}}" class="promo-sheet-note">{{sheet.note}}</text>
    <view class="promo-sheet-ok btn-primary" catchtap="onCloseSheet">知道了</view>
  </view>
</view>
```
### 4.3 WXSS（rpx；数值对照预览 375 宽：行高 44px=88rpx、标题 52px=104rpx、门槛列宽 92px=184rpx、字号 15px=30rpx、说明 12px=24rpx）
遮罩 `position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index` 取 `tableware-sheet` 同级；面板 `position: absolute; left:0; right:0; bottom:0; background:#fff; border-radius: 32rpx 32rpx 0 0; padding-bottom: calc(44rpx + env(safe-area-inset-bottom))`；行 `display:flex; align-items:center; height:88rpx; padding:0 40rpx; border-bottom:1rpx solid var(--divider)`；`.promo-sheet-em { color: var(--brand); font-weight: 600 }`；按钮复用全局 `.btn-primary`（`app.wxss`，`height: 80rpx`）并 `margin: 24rpx 40rpx 0`。

## 5. 分步改动清单

- [ ] **T1 行数据纯函数 + 测试先红后绿**：`components/promo-bar/sheet.js`（新，ES5，`module.exports = { sheetRowsOf }`，内部 `require('../../utils/promo').yuanShort`）；`tests/miniapp/promo-sheet.test.cjs`（新）：免运费五档（线上配置 58/2,88/3,128/4,168/5,198/7，radius 8）→ 5 行 + note 含「8 km」；`maxKm >= radius` 档 `em=''`；`radiusKm` 缺失 → note 无「配送范围」；满减两档 → `right='减 '`,`em='¥6.6'`/`'¥10.8'`；乱序输入按门槛升序；tiers 空 → rows 为空数组；**一致性**：对同一输入，`rows.map(r => r.left + ' ' + r.right + r.em + r.tail).map(去空格)` 与 `promo.js` 对应 `detailLines.slice(0,-1)`（去空格与括号后）逐档等价——写法自定，目的是钉住两处口径不漂移。
- [ ] **T2 组件弹层**：`index.js` 加 `sheetOpen/sheet` 与三个方法，`onTapDetail` 不再调 `wx.showModal`；`index.wxml` 追加 §4.2；`index.wxss` 追加 §4.3。源码级断言（追加到 `tests/miniapp/promo-sheet.test.cjs`）：`index.js` 不含 `showModal`；`index.wxml` 含 `promo-sheet-mask`、`wx:for="{{sheet.rows}}"`、两处 `onCloseSheet`；`index.wxss` 含 `.promo-sheet-em` 且 `var(--brand)`、`env(safe-area-inset-bottom)`。
- [ ] **T3 预览台镜像**：`tools/miniapp-preview/pages/index-local.html` 与 `product-list-preview.js` 的活动条加可点开的弹层镜像（结构同 §4.2，类名同名，样式来自内联的真实 wxss）；375 宽实测：五档每行只占一行、门槛列对齐、按钮高 40px、面板不超出视口；截图存 `docs/superpowers/previews/2026-09-21-promo-detail-sheet-shots/`（各 <300KB）。
- [ ] **T4 文档**：`tools/miniapp-preview/README.md` 加一句「活动条详情为组件内弹层，点镜像可展开」；本文件末尾追加「执行记录」（每 T 的 sha、A 类真实输出、B 类实测数字、回退验证红绿、偏离逐条）。

## 6. 验收

### A（脚本化，04 机械核对逐条跑）
| # | 命令 | 期望 |
|---|---|---|
| A1 | `npm run -s test:miniapp 2>&1 \| grep -E "^ℹ (tests\|pass\|fail)"` | `fail 0`，`tests` ≥ 281（273 + 本批 ≥8） |
| A2 | `node --test tests/miniapp/promo-sheet.test.cjs 2>&1 \| grep -E "^ℹ (pass\|fail)"` | `fail 0` |
| A3 | `node scripts/check-miniapp-es5.mjs apps/miniapp/components/promo-bar/index.js apps/miniapp/components/promo-bar/sheet.js; echo EXIT=$?` | `EXIT=0` |
| A4 | `grep -c "showModal" apps/miniapp/components/promo-bar/index.js` | `0` |
| A5 | `git diff --name-only a3b76c2..HEAD -- apps/miniapp/utils apps/miniapp/pages apps/miniapp/app.wxss apps/miniapp/app.json apps/miniapp/app.js apps/server apps/admin package.json package-lock.json scripts` | 空 |
| A6 | `git diff --name-only a3b76c2..HEAD \| grep -v -E '^(apps/miniapp/components/promo-bar/\|tests/miniapp/promo-sheet.test.cjs\|tools/miniapp-preview/\|docs/)'` | 空 |
| A7 | `git diff a3b76c2..HEAD --stat -- tests/miniapp/freeship-bar.test.cjs tests/miniapp/promo.test.cjs tests/miniapp/cart-bar-page.test.cjs` | 空（既有测试不动） |
| A8 | `node -e "var s=require('./apps/miniapp/components/promo-bar/sheet.js');console.log(JSON.stringify(s.sheetRowsOf('freeship',null,{radiusKm:8,fee:{freeShipTiers:[{minAmountFen:5800,maxKm:2},{minAmountFen:19800,maxKm:7},{minAmountFen:8800,maxKm:3}]}})))"` | 3 行按 58/88/198 升序，`em` 为 `2 km`/`3 km`/`7 km`，note 含 `8 km` |
| A9 | `git status --porcelain` | 空 |

### B（预览台实测，执行方做、贴数字）
375 宽两页分别点满减「详情」与免运费「详情」：弹层出现、行数 = 档数、每行高 44px、无横向溢出、点遮罩/✕/按钮各能关闭；满减关闭时页面无弹层残留节点（`sheetOpen=false` 时不渲染）。

### C（真机，店主）
iOS + Android 各：分类页点满减「详情」和免运费「详情」→ 一档一行、距离/金额红色、说明一行、「知道了」和点空白都能关；关掉后页面滚动位置不变；分类页收起吸顶状态下打开再关，页面不跳。

### D（回退验证，先提交再做）
- D1 `sheet.js` 把升序排序去掉 → A8/乱序用例红；还原绿。
- D2 `index.wxml` 删掉遮罩上的 `catchtap="onCloseSheet"` → 源码级断言红；还原绿。

## 7. 白名单
`apps/miniapp/components/promo-bar/index.{js,wxml,wxss}`、`apps/miniapp/components/promo-bar/sheet.js`（新）、`tests/miniapp/promo-sheet.test.cjs`（新）、`tools/miniapp-preview/pages/index-local.html`、`tools/miniapp-preview/pages/product-list-preview.js`、`tools/miniapp-preview/README.md`、`docs/superpowers/previews/2026-09-21-promo-detail-sheet-shots/**`、本文件。
**禁止**：`apps/miniapp/utils/**`、`apps/miniapp/pages/**`、`app.*`、其它组件、`apps/server/**`、`apps/admin/**`、`package*.json`、`scripts/**`、既有 `tests/miniapp/*.test.cjs`。

## 8. 上报触发条件（命中即停）
1. 需要改 `utils/promo.js` 才能拿到行数据（本方案要求组件内组装；若发现 `promotion.tiers`/`meta.fee.freeShipTiers` 在某页传不到组件）。
2. Component 文件无法导出纯函数且 `sheet.js` 方案也不可行。
3. 弹层在分类页（整页滚动 + sticky）下无法覆盖吸顶栏或被购物车条压住（z-index 冲突需改别的组件）。
4. `btn-primary` 全局类在组件内不生效（`addGlobalClass` 已开，理论可用）。
5. 白名单外任何改动。

## 9. 待店主确认
无（版式已按预览确认）。

## 10. 统筹裁定（2026-09-21，01 上报后）

01 上报：`tests/miniapp/freeship-bar.test.cjs:153-169`（用例「promo-bar 组件：kind=freeship 走 freeShipBarOf，deliveryType 非 LOCAL 隐藏」）硬断言 `onTapDetail()` 调 `wx.showModal` 及其 title/content/showCancel/confirmText；与 T2「不再调 showModal」和 A4 互斥；而 §7 禁改既有测试。**成立，责任在 00 规划**（写方案时没检查既有测试对被替换行为的断言）。

裁定（按 01 给的选项 1）：
- **白名单放开**：允许修改 `tests/miniapp/freeship-bar.test.cjs` **仅该一条用例内**关于 `showModal` 的断言（约 160–164 行），改为断言新行为：`c.onTapDetail()` 后 `c.data.sheetOpen === true`、`c.data.sheet.title === '免运费'`、`c.data.sheet.rows.length === 5`（与 `liveMeta` 五档一致）、`c.data.sheet.note` 含「8 km」；`showModalCalls.length === 0`。该用例其余断言（`kind` 分派、非 LOCAL 隐藏）与文件内其余 15 例**逐字不动**。
- 验收 A7 改为：`git diff a3b76c2..HEAD -- tests/miniapp/freeship-bar.test.cjs | grep -c '^-[^-]'` ≤ 6，且 `promo.test.cjs`、`cart-bar-page.test.cjs` diff 为空；执行记录里逐行列出该用例改前/改后。
- 组件桩：该测试里 `promoBarComponent()` 构造的 `c` 若没有 `setData` 合并语义，按文件内既有桩写法补（只在测试桩内改，不改组件）。
- 其余 T1–T4、A/B/D、§8 不变。
