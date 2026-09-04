# 封面页落地 brief（PO 已定方案一水墨最终稿）

## 目标
在同城 worktree 落地 `pages/cover`，作为小程序启动页；视觉对齐 `docs/design/miniapp-cover/cover-style1-ink-paper-final.svg`。

## 路由
- `app.json` `pages` 数组**第一项**改为 `pages/cover/index`
- 保留现有 `pages/index/index`（全国邮寄首页）
- 同城：`/pages/local/index`（若不存在可先 navigateTo，Task 2 补页）

## 可点区域（按 SVG 图层）
1. `按钮-同城配送` → `wx.navigateTo({ url: '/pages/local/index' })`
2. `按钮-全国邮寄` → 若 index 是 tabBar 页用 `wx.switchTab`，否则 `navigateTo` 到邮寄首页
3. `按钮-会员中心` / `会员储值` / `积分商城` → `wx.showToast({ title: '即将开通', icon: 'none' })`
4. `横幅按钮-冷链配送` → 同全国邮寄入口

## 实现策略
- 把 final SVG 导出为静图放入 `apps/miniapp/images/cover/`，cover 页用 image + 透明热区；不要在小程序里重绘复杂水墨路径。
- 不改服务端；不 push；不碰生产。

## 与 M3
- Task 1 首页临时双入口可暂时并存；封面启动后临时入口另 commit 再删。
- 本任务不做 Task 2–9。

## 验收
冷启动进封面；同城/邮寄跳转正确；会员 toast；相关 js `node --check` 通过。
