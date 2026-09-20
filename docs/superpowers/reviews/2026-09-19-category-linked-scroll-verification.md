# 分类页整页联动滚动验收记录

日期：2026-09-20。分支：`codex/category-scroll`，Task 1 原生实现基线 `893fe80`。本记录检查浏览器镜像、自动测试和原生编译；微信真机验收仍待执行。

## 可审阅预览和证据

- 同城：运行 `node tools/miniapp-preview/serve.mjs --port 5182` 后打开 `http://localhost:5182/pages/product-list-local.html`。
- 邮寄：`http://localhost:5182/pages/product-list.html`。5182 是本次独立检查服务端口，已有 5180 服务未被停止。
- 机器可读记录：[browser-geometry.json](/Users/yumingyi/.codex/visualizations/2026/09/19/01a0b835-9aea-7e62-9e76-4801535b11af/category-scroll/browser-geometry.json)；临时实际点击/滚动脚本：[browser-qa.cjs](/Users/yumingyi/.codex/visualizations/2026/09/19/01a0b835-9aea-7e62-9e76-4801535b11af/category-scroll/browser-qa.cjs)。证据目录中的 PNG 文件名标明渠道、宽高和状态，例如 [同城 375×640 末分类](/Users/yumingyi/.codex/visualizations/2026/09/19/01a0b835-9aea-7e62-9e76-4801535b11af/category-scroll/local-375x640-last.png)、[同城 375×812 初始](/Users/yumingyi/.codex/visualizations/2026/09/19/01a0b835-9aea-7e62-9e76-4801535b11af/category-scroll/local-375x812-initial.png)、[邮寄 320×640 搜索](/Users/yumingyi/.codex/visualizations/2026/09/19/01a0b835-9aea-7e62-9e76-4801535b11af/category-scroll/express-320x640-search-first.png)。

两份镜像引用由服务生成的真实 `app.wxss`、分类页 WXSS、相应组件 WXSS；浏览器专用 CSS 仅设置视口、控件原生样式和独立侧栏溢出。共享脚本创建 15 个确定性分类，末尾“酒水/饮料”仅一件商品；样例购物车金额不执行计价或付款，也不请求 API。浏览器结果仅证明镜像布局与模拟交互，不能证明微信运行时。

## 六项用户行为逐条对照

| 规格目标 | 已取得的证据 | 真机状态 |
| --- | --- | --- |
| 1. 初始显示门店信息、营业提示、活动 | 同城 `initial` 截图含店名、长打烊可预约通知、满 66/108 活动；六个尺寸均渲染。 | 待验真实元数据与字体换行。 |
| 2. 商品上滑收起头部，模式栏吸顶 | 六个同城 `collapsed` 状态通过商品区鼠标滚轮触发；DOM 中工具栏 `top` 与视口 0 的误差不超过 2px。 | 待验 iOS/Android 手势惯性和 WebView sticky。 |
| 3. 回滚至商品前部后露出头部 | 六个 `restored` 状态通过反向滚轮返回 `scrollY ≤ 1`，头部重新完整显示；未模拟反向自动展开。 | 待验连续手势过程。 |
| 4. 左栏独立滚动、联动高亮、末分类/商品可见 | 实际点击末分类并等待平滑滚动完成后，六个 `last` 状态均高亮“酒水/饮料”；末分组顶部与吸顶栏底部相差不到 1px，末分类矩形在侧栏内，末件加购按钮距购物栏最少 367.44px。15 类在六尺寸下可手动滚动左栏。 | 待验分类触摸、加购命中和原生惯性。 |
| 5. 提示与购物栏固定，有车/空车动态避让 | 同城六尺寸实测 `initial/last/empty`；有车时侧栏底部最多超过购物栏顶部 1px（容器边框），空车时侧栏延至视口底部。浏览器桥接使用实测 dock 矩形高度设置侧栏、末组尾部和唯一页面占位。 | 待验真实组件高度事件、tabBar、安全区与提示增减。 |
| 6. 邮寄搜索/渠道、分页/清除、模式与计价 | 六尺寸邮寄 `search-first/search-more/search-clear` 验证输入、底部加载和分组恢复；同城切自取有独立截图。原生分类页相关自动测试覆盖首页定位、搜索分页/清除、渠道隔离、模式与既有业务计价。镜像金额只是示例。 | 待验真实接口、切渠道和实际购物车计价流程。 |

## 测量与检查

Playwright 使用已安装 Chrome，在 320、375、430px 宽 × 640、812px 高共六个视口中，以真实点击和滚轮采集同城 `initial/collapsed/last/restored/empty/pickup` 及邮寄 `initial/search-first/search-more/search-clear`，共 60 张状态截图和 60 条 DOM 测量，断言失败 0。所有状态水平溢出为 0px；有车时 `sidebar.bottom ≤ dock.top + 1`；末分组标题位于吸顶栏下，末加购按钮在购物栏上方。脚本等到实际分组与吸顶栏对齐后才截末分类，避免平滑动画中途截图。末组单商品后的空白是 `V − P − D − lastGroupHeight` 尾部补白，用于短分组定位。

仓库检查（本次 Task 2 完成后执行）:

```text
npm run -s test:miniapp                                      246 pass / 0 fail，exit 0
node scripts/check-miniapp-es5.mjs apps/miniapp/utils/category-scroll.js  1 file pass，exit 0
git diff --check                                              exit 0
```

原生编译在 Task 1 最终 WXML/WXSS 未变更后由统筹执行，Task 2 未改动原生输入，因此复用该次结果。已安装微信开发者工具的 `wcc -o <evidence>/wcc-output.js` 编译 38 个 WXML/WXS 输入，`wcsc -o <evidence>/wcsc-output.js` 编译 `app.wxss`、分类页和引用组件共 14 个 WXSS 输入，两者退出码均为 0。完整命令、输入列表和退出码在 [compile.json](/Users/yumingyi/.codex/visualizations/2026/09/19/01a0b835-9aea-7e62-9e76-4801535b11af/category-scroll/compile.json)，同目录有 `wcc.log`/`wcsc.log`。该编译证明语法可编译，不证明真机渲染。

## 审核与真机待验

方案预审 Agent 模型：`gpt-6-astra`；Task 1 执行 Agent：`gpt-5.6-sol`；Task 1 独立审核 Agent：`gpt-6-astra`，三项重要问题修复后在 `893fe80` 批准。Task 2 执行 Agent：`gpt-5.6-sol`。Task 2 独立审核及全分支终审由统筹另行记录，本文不预先宣称通过。持久证据目录保留 [方案预审](/Users/yumingyi/.codex/visualizations/2026/09/19/01a0b835-9aea-7e62-9e76-4801535b11af/category-scroll/design-review.md)、[Task 1 审核](/Users/yumingyi/.codex/visualizations/2026/09/19/01a0b835-9aea-7e62-9e76-4801535b11af/category-scroll/task-1-review.md)、[Task 1 实施报告](/Users/yumingyi/.codex/visualizations/2026/09/19/01a0b835-9aea-7e62-9e76-4801535b11af/category-scroll/task-1-report.md)与 [Task 2 实施报告](/Users/yumingyi/.codex/visualizations/2026/09/19/01a0b835-9aea-7e62-9e76-4801535b11af/category-scroll/task-2-report.md)，原生自动测试日志也已复制至同目录。

iOS 和 Android 微信开发者工具/真机各需依次：进入同城分类 → 加购 → 上滑收起头部 → 点/滑到末尾“酒水/饮料”并点击加购 → 反向滑至顶部 → 手动滑动左栏 → 切自取/外送 → 清空购物车 → 切邮寄搜索、加载下一页并清除。核对滚动连续性、吸顶与原生 tabBar/安全区衔接、底部分类及按钮不被遮挡、返回分类页的位置、真实购物栏高度和金额。未获得真机运行结果，以上项目均为待验，未上传体验版。
