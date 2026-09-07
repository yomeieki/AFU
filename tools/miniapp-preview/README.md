# 小程序 HTML 预览台

在浏览器里近似预览 `apps/miniapp` 的 23 个页面，供 UI 改造时快速看效果、截图自检。

## 用途

小程序是微信原生 WXML/WXSS，浏览器不能直接渲染，本机也不一定能起微信开发者工具。本工具把每页镜像成浏览器可渲染的静态页，并**内联真实 wxss**——改小程序样式后这里即时反映，无需复制样式。

## 启动

```bash
npm run preview:miniapp        # 默认 http://localhost:5180
# 或指定端口
node tools/miniapp-preview/serve.mjs --port 5180
```

打开首页即为「画廊」：23 个页面各嵌在手机边框里，顶部一条 tabBar 展示 8 张真实图标。

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

## 边界（重要）

这是**视觉近似**，不是功能验证：

- 不跑交互、事件、`wx:for`/`wx:if` 运行时、`price.wxs`（mock 数据已 baked）
- 不连后端、无真实数据（协议/隐私政策例外：正文是 `config/legal.js` 的真文案）
- iframe 模拟样式隔离（非真机的 Shadow 机制），个别继承细节可能有差异
- rpx 用 `calc` 近似，字体渲染与真机略有出入

**最终交互与真机效果，仍以微信开发者工具打开 `apps/miniapp` 为准。**
