【工序】交付 【模型】Fable 【等级】M
状态：BLOCKED（仅因范围检查脚本不存在，§2.5 第 4 条无法满足；代码与验收层面：Sonnet 新会话两轮复核后无阻断项，验收标准 1、2、3（预览部分）、5 已满足，4（真机）待店主）
定级依据：§2.2 第 3 条——顾客端新功能；不改支付流程（仍 createOrder → detail?autopay），只多传 scheduledAt；不含迁移/认证/并发一致性。
运行模式：正常。规划由本会话（Fable）担任；执行 Sonnet 子 agent 逐 Task 串行（独立 worktree `sched-2-miniapp`、分支 `claude/scheduled-delivery-2-miniapp`，基线 c81f15c）；复核 Sonnet 新会话。
完成内容：方案 docs/superpowers/plans/2026-09-22-scheduled-delivery-batch2-miniapp.md Task 1–6：
- api/local.js 加 delivery-slots；local-catalog 打烊可预约三态（胶囊「已打烊 · 可预约」/ 软通知 / 外送副标）
- 结算按钮状态机加预约分支（请选择送达时段 / 时段已过请重选 / 预约下单 / 打烊只能预约）
- slot-picker 组件从自取页抽出（pickup.js 只改两处 idx 读取，行为锁不改仍绿）
- 同城结算页：送达时间卡、打烊强制预约并预选最早格、按报价距离拉时段、换地址清格、提交带 scheduledAt、42290/42291 处理、报价先回 meta 后到竞态
- 主页组件与购物车条文案
- 订单详情横幅/时间线 extra/取消卡三段文案/状态「已预约」/列表标签「同城 · 预约」（utils/schedule-order.js 纯函数）
提交范围：c81f15c..93e61fc
验证结果：
- `npm run test:miniapp` → tests 307 / pass 307 / fail 0（基线 286 + 本批新增 21：local-catalog 3、checkout-state 3、confirm-page 8、schedule-order 5、修复轮 2）
- `bash scripts/e2e.sh`（干净库，TZ=Asia/Shanghai；本批不改服务端，护栏）→ 隔离库 food_shop_e2e_mini、端口 3105：`================ 通过 2010 / 失败 0 ================`（在 8d641e7 上跑；其后提交只改小程序文件，服务端与 e2e 分片本批禁改）
- 预览工具（tools/miniapp-preview）→ 编排者在浏览器核对五个镜像：主页打烊态（胶囊「已打烊 · 可预约」/ 软提示「现在下单为预约配送，最早明天 09:35 送达」/ 切换栏「外送（可预约）」/ 购物车条「去结算 · 预约外送」）、结算页营业中（默认尽快、可切预约、按钮「提交订单」）、结算页打烊（尽快置灰「已打烊」、预约预选「明天 9月23日 12:00–12:30」、配送信息「预计 … 送达」、按钮「预约下单」）、详情横幅「预约配送 · 明天 12:00–12:30 送达」、列表「同城 · 预约」标签与「已预约」状态。镜像是手抄静态标记 + 真实 wxss，不等于真机渲染。
- 真机 → 未做（需微信开发者工具，店主验收）
范围检查：未运行——`.agent/high-risk.txt` 与 `.agent/check-scope.sh` 不存在。手工核对：`git diff --name-only c81f15c..HEAD` 共 41 个文件（含预览镜像），全部命中 allow 清单（fnmatch 逐条核对），deny 零命中；pickup.js 只改了 selectDay/selectSlot 两处 idx 读取。
重要方案调整：
- Task 3：pickup.js 两处 idx 读取纳入授权并限定（规划自审）。
- Task 4：closedNow/scheduleAvailable 写入 patch 公共部分而非成功分支，否则「报价先回、meta 后到」的纠正逻辑不触发（执行者偏离并加了用例 ⑦）。
- Task 5：方案写的 pages/local/index.wxml 实为兼容跳转桩页，真正主页是 pages/index/index.*，零改动。
- Task 6：list.wxml 接线了此前从未实例化的 order-status-tag 组件并清理 list.wxss 死代码（颜色逐一核对不变，复核确认无渲染变化）。
- 复核 R1–R3 修复（93e61fc）：竞态纠正同步头条；详情页预约单「取消订单」文案与两小时外提示；预约未开通时选项不可点。
复核（Sonnet 新会话）两轮：第一轮 R1 阻断（打烊竞态纠正后头条未同步，仍显示旧阻塞文案）、R2/R3 规划缺口（预约单两小时外按钮文案应为「取消订单」并接入文案；预约未开通时「预约时段」选项置灰但可点）→ 93e61fc 一并修复并加两条页面级用例；第二轮无阻断项、无新问题。
建议（未实施）：无。
未解决问题及证据：① 范围检查未运行（脚本不存在）；② 真机未验（需微信开发者工具）。
需要用户授权的后续操作：
- 合并到 main（改小程序必须合 main，开发者工具读主仓磁盘）。
- 微信开发者工具真机预览走打烊下单到支付；提交审核；过审发布后店主在后台「预约送达」页打开开关。
- 提供 .agent/check-scope.sh 后补跑范围检查。
