# 小程序 HTML 预览台

在浏览器里近似预览 `apps/miniapp` 的页面/展示状态，供 UI 改造时快速看效果、截图自检。

## 用途

小程序是微信原生 WXML/WXSS，浏览器不能直接渲染，本机也不一定能起微信开发者工具。本工具把每页镜像成浏览器可渲染的静态页，并**内联真实 wxss**——改小程序样式后这里即时反映，无需复制样式。

## 启动

```bash
npm run preview:miniapp        # 默认 http://localhost:5180
# 或指定端口
node tools/miniapp-preview/serve.mjs --port 5180
```

打开首页即为「画廊」：30 个页面/展示状态各嵌在手机边框里，顶部一条 tabBar 展示 8 张真实图标。

## 工作机制

- `serve.mjs` 读取 `apps/miniapp/app.wxss`、各页 `.wxss`、`components/**/*.wxss`，做两处转换后生成 `*.generated.css`：
  - `page { }` → `.mp-page { }`（CSS 变量作用域挂到根容器）
  - `123rpx` → `calc(123 * var(--rpx))`，在 375px 宽 iframe 内 `--rpx: 0.5px`（750rpx = 375px）
- 每页一个 iframe，各自只加载 `app.wxss + 该页 wxss + 所用组件 wxss` —— 天然复刻小程序页面间样式隔离，避免 `.card`/`.price-int` 等类名跨页冲突。
- `fs.watch` 监听源 wxss，变更即重生成；页面轮询 `/__version`，变化自动刷新。
- **协议/隐私政策两页是例外**：正文不是手抄的镜像 HTML，而是请求时现读 `apps/miniapp/config/legal.js`（`用户协议` = `agreement`、`隐私政策` = `privacy`）按 `pages/legal/index.wxml` 的结构渲染。改文案刷新即见，不用动本目录；`legal.js` / `shop.js` 变更也会触发画廊自动刷新。

## 维护

- **改样式（wxss）**：无需动本目录，刷新即见。
- **改页面结构（wxml）**：需同步更新 `pages/<page>.html` 镜像（保持真实 class 名）。协议/隐私政策没有镜像文件，改其 wxml 要改 `serve.mjs` 的 `renderLegalHtml()`。
- **改协议文案**：只改 `apps/miniapp/config/legal.js`，预览台跟着变——这是唯一能在浏览器里通读合规文案的地方，正文必须与小程序真机一致。
- 新增页面用到新组件：在 `serve.mjs` 的 `PAGE_COMPONENTS` 登记其组件 wxss。
- `*.generated.css` 由源码派生、已 gitignore，不入库。

## 分类页整页滚动预览

分类页另有两个可直接打开的交互镜像：

- [同城分类页](http://localhost:5180/pages/product-list-local.html)：门店长通知、满减、外送/自取切换和含提示的购物栏。
- [邮寄分类页](http://localhost:5180/pages/product-list.html)：吸顶搜索/渠道入口、搜索清除和示例分页。

先运行 `node tools/miniapp-preview/serve.mjs --port 5180`，再打开链接。若 5180 已在使用，可换端口并替换链接中的端口。镜像使用 `product-list.generated.css` / `product-list-local.generated.css`，两份都由真实 `app.wxss`、分类页 WXSS 和对应组件 WXSS 生成。视口宽度决定 rpx 比例，页面本身自然滚动，分类侧栏单独滚动。

可向上滑商品让门店头收起，点左侧末尾“酒水/饮料”检查一件商品及加购按钮，反向滚动到顶部；点优惠提示右侧的“预览：切换空车”观察购物栏从有到无的布局变化。邮寄页输入“冷吃兔”并点搜索或回车，可滚到底部加载下一批示例商品，再点搜索标签的 × 返回分组。渠道标识可在两份镜像间切换。15 个分类和重复商品由共享脚本确定性生成，计价、支付和后台请求都只是标明为样例的浏览器模拟。

本次几何与交互检查的截图和 JSON 位于 `/Users/yumingyi/.codex/visualizations/2026/09/19/01a0b835-9aea-7e62-9e76-4801535b11af/category-scroll/`。这些结果不能代替 iOS/Android 微信真机对惯性、原生 tabBar 和安全区的验收。

## 边界（重要）

这是**视觉近似与分类页模拟交互**，不是微信运行时功能验证：

- 除分类页共享浏览器桥接外，不跑交互、事件、`wx:for`/`wx:if` 运行时、`price.wxs`（mock 数据已 baked）
- 不连后端、无真实数据（协议/隐私政策例外：正文是 `config/legal.js` 的真文案）
- iframe 模拟样式隔离（非真机的 Shadow 机制），个别继承细节可能有差异
- rpx 用 `calc` 近似，字体渲染与真机略有出入

**最终交互与真机效果，仍以微信开发者工具打开 `apps/miniapp` 为准。**

## 满减与结算条镜像（2026-09-19）

`index`、`index-local`、`index-local-pickup`、`product-list` 均登记 `local-cart-bar` 与 `promo-bar`。
镜像中的活动与免运数据仅为示例；真实小程序读取 `/local/meta`，同城免运金额与范围按后台 `fee.freeShipTiers` / `radiusKm` 动态展示。

375px 宽下黑条 44px、按钮 34px；按钮另设 32px 最小高度，以免 320px 屏上 rpx 缩放后低于点击区下限。
预览占位为带提示条实测的 72px；小程序使用组件 `height` 事件的实际像素值。

结算示例：外送 `211 − 20 − 5 + 6 + 7 = 199` 元；自取另享 9.5 折，`211 − 10.55 − 20 − 5 + 7 = 182.45` 元；邮寄 `211 − 20 − 5 + 6 = 192` 元。
优惠券组件的预计积分目前未计入打包费，因此外送/自取镜像仍按不含打包费金额示例（1 元积 1 分）；实际积分以服务端结算为准。

## 免运费提示条镜像（2026-09-21）

`index-local`、`product-list-local`（渠道 LOCAL）在满减条正下方多一条免运费条（`免` 徽标，同色同样式，复用同一个 `promo-bar` 组件，`kind="freeship"`）。`index-local-pickup`、`index`、`product-list`（邮寄）没有——自取与邮寄不显示免运费条。

- 真实数据来自后台 `fee.freeShipTiers`（档位）与 `radiusKm`（配送半径）；镜像里写死的示例值仅供展示，不代表真实店铺配置。
- `product-list-preview.js` 的免运费条元素 `#freeship-bar` 在自取/外送切换时用 `style.display` 切换（不用 `hidden` 属性——`.promo-bar { display:flex }` 的优先级会压过 UA 自带的 `[hidden]{display:none}`）。
- 满减关闭时结算条上方（`.cart-tip`）只提示免运费进度，不再直接隐藏；三态：「再买 ¥X 免运费（N km 内）」/「N km 内免运费 · 再买 ¥X 免 M km 内运费」/「N km 内免运费」或「已免运费」（绿底 `done`）。购物车 tabBar 页（`pages/cart`）与主页/分类页结算条行为一致。
- 满减开着、未达最低档时，提示会追加免运费第二段，例如「再买 ¥28 减 ¥6.6 · 再买 ¥20 免运费（2 km 内）」；已达满减档位的两态（以「已减」开头）不受影响，文案逐字未变。
- 提示文案里的金额一律去掉末尾的 0（`6.60` → `6.6`，`38.00` → `38`，`37.05` 保留两位）；应付金额、商品价、订单与小票金额不受影响，仍是固定两位。

## 门店头「自取享 X 折」标红（2026-09-21）

自取模式下，`local-store-header` 规则行的第一段（后台 `pickup.discountText`，例「自取享 9.5 折」）单独标红显示，其余文字（起送线、门店地址）保持原色，用「 · 」隔开。外送模式的规则行不受影响。

`index-local-pickup.html` 与 `product-list-preview.js` 的自取态规则行已同步拆成红字 + 灰字两段（后者随外送/自取切换局部刷新 `#rules-row`）。
