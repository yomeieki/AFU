# 预约送达批次一后半（后台前端）复核记录 · Sonnet 新会话

【工序】复核 【模型】Sonnet 【等级】M

结论：存在阻断项

## 问题

### R1 [阻断/需改]
位置：`apps/admin/src/pages/Workbench.tsx:1634-1654`（换列/离开看板检测 effect），触发入口 `apps/admin/src/pages/Workbench.tsx:2489-2499`（预约单折叠组/散卡的 `renderCard`），根因 `apps/server/src/routes/admin/workbench.ts:182-191`。

触发条件：店员点开「待接单」列顶部「预约单」折叠组（或未折叠、带取消申请的那张）里任意一张 **WAITING 阶段**的预约单卡片，抽屉打开后经过一次快照轮询（前台标签页激活时默认 10 秒一次，见 `Workbench.tsx:1478` `document.hidden ? 60_000 : 10_000`）。

依据：
- `apps/server/src/routes/admin/workbench.ts:191`：`if (sc?.phase === 'WAITING' && (o.status === 'PAID' || o.status === 'PREPARING') && !d) { cols.scheduled.push(...); continue }` —— WAITING 阶段的预约单只落进 `cols.scheduled`，`continue` 跳过了 pending/preparing/waitingCourier/delivering/done 五列，不会同时出现在任何一列里。
- `apps/admin/src/pages/Workbench.tsx:44`：`type ColKey = Exclude<keyof WorkbenchSnapshot['columns'], 'scheduled'>`；`:46-50` `COLUMNS` 数组只有 pending/preparing/waitingCourier/delivering/done 五项，不含 `scheduled`。
- `apps/admin/src/pages/Workbench.tsx:2492`：`onOpen={() => openCard(c, col.key)}`，这段 `renderCard` 定义在 `col.key === 'pending'` 的渲染分支里（`:2486-2487` `scheduledFold`/`scheduledLoose` 就是从 `col.key === 'pending'` 时取的 `snap.columns.scheduled`），所以打开一张 WAITING 卡片会把 `drawer.colKey` 设成 `'pending'`。
- `apps/admin/src/pages/Workbench.tsx:1634-1654` 完整 effect：`for (const col of COLUMNS) { const found = snap.columns[col.key].find(...) ; if (found) {...; return} }`，五列都找不到时落到 `setGone(true)`（`:1653`）。由于 `COLUMNS` 不含 `'scheduled'`，WAITING 阶段卡片必然在每一轮快照后都触发这一支。
- `apps/admin/src/pages/Workbench.tsx:1723`：`if (gone) return <span className="wb__muted">该单已离开看板，请关闭重开</span>`——命中后 `renderActions()` 直接返回占位文案，接单/已备好/立即呼叫/驳回/拒单等**全部操作按钮消失**。
- 更严重的是 `gone` 只有 `openCard`（`:1583`）/`closeDrawer`（`:1591`）会重置为 `false`；这个 effect 在 `if (found)` 分支（`:1638-1648`）从未调用 `setGone(false)`。也就是说这张单之后真的出票、进入 `cols.pending`（`apps/server/.../workbench.ts` 里 `o.status === 'PAID'` 分支），`found` 虽然能命中，但 `gone` 不会被撤销——抽屉会一直卡在「已离开看板」，必须店员手动关闭重开才能恢复操作。

影响：预约单出票前是工作台上停留时间最长的阶段（从 WAITING 到 ticketAt 可能有数十分钟），店员点进去看一眼地址/电话/送达时段（这是 Task 5/6 明确要暴露的信息）超过一个轮询周期就会撞上这个问题；而且一旦触发，即便后续该单正常出票、进入正常列，抽屉也不会恢复，只能关闭重开。这是这批改动引入 `columns.scheduled` 这个"第六个桶"之后，遗留下来的既有逻辑（换列检测）没有同步更新导致的，不是执行者对方案的偏离，方案本身（Task 3）也没提到要改这段代码——同时也是一处规划缺口。

### R2 [规划缺口]
位置：`apps/admin/src/pages/ScheduleSettings.tsx:27-40`（`example()` 函数）对照 `apps/server/src/services/delivery/schedule.ts:28-40`（`schedulePrepMinutes`/`scheduleTimeline`）与 `apps/server/src/services/local-settings.ts:197-201`、`:335-341`、`:848-850`。

触发条件：示例锚点固定取「今天 12:00」（`ScheduleSettings.tsx:28` `` `${todayKey(new Date())}T12:00:00+08:00` ``），服务端默认高峰窗口第一段恰好是 12:00–13:00（`local-settings.ts:339` `windows: [{ start: '12:00', end: '13:00' }, ...]`），`minutesInPeak` 用 `minutes >= toMin(start) && minutes < toMin(end)`（`local-settings.ts:849`），720 分钟（12:00）落在区间内判定为真。默认 `schedule.prepMinutes = 20`（`local-settings.ts:316`）< `peak.prepMaxMinutes = 30`（`local-settings.ts:341`），所以**默认设置、从未改过任何参数**的情况下，示例页展示的「出备餐票 / 接单截止 / 开始备餐」三个钟点都会比服务端真实算出来的早 10 分钟。

依据：
- `ScheduleSettings.tsx:32`：`const prepStartAt = callAt - sc.prepMinutes * 60_000` —— 直接用输入框的 `prepMinutes`，没有叠加高峰取大逻辑。
- `schedule.ts:28-29`：`schedulePrepMinutes(s, at)` = `minutesInPeak(...) ? Math.max(s.schedule.prepMinutes, s.peak.prepMaxMinutes) : s.schedule.prepMinutes`；`:34` `scheduleTimeline` 用它算 `prep`，进而算 `prepStartAt`（`:36`）/`ticketAt`（`:38`）/`acceptDueAt`（`:37`）。
- `call`（呼叫时刻）与 `selfCancel`（自助取消截止）两项不受影响，因为它们的公式里不含 `prep`。

这是方案本身给出的 `example()` 代码（`docs/superpowers/plans/2026-09-22-scheduled-delivery-batch1b-admin.md` 第 563-577 行）就没考虑高峰覆盖，执行者按方案原样落地（Task 4「偏离方案」只记录了 `setHours→todayKey` 时区改写与 `navigation.test.ts` 注释两处，未涉及这里），文件顶部注释还特意写了"与服务端…同一套公式，改这里必须同时改那边"（`ScheduleSettings.tsx:20`），但实际两边在高峰这一分支上不一致——店主打开这页看到的示例时刻会系统性偏早，可能据此误判备餐窗口。

### R3 [规划缺口]
位置：`apps/admin/src/pages/Workbench.tsx:2459-2464`（`wb__schedbar` 倒计时条点击处理）对照 `:2466-2467`（手机模式下 `(isPhone ? COLUMNS.filter((c) => c.key === phoneCol) : COLUMNS)`）与 `:1438`（`phoneCol` 初始为 `'pending'`，但可被切换到其它列）。

触发条件：手机模式（`isPhone`）下，店员已经切到「备餐中」等其它标签页（`phoneCol !== 'pending'`）时点击顶部常驻的「下一张预约单…点击查看」倒计时条。

依据：
- `Workbench.tsx:2460`：`onClick={() => { setScheduledOpen(true); boardRef.current?.scrollTo({ left: 0, behavior: 'smooth' }) }}`，只设置折叠组展开状态和滚动看板容器，没有 `setPhoneCol('pending')`。
- `Workbench.tsx:2476`：手机模式下 `.map()` 遍历的是 `COLUMNS.filter((c) => c.key === phoneCol)`，只渲染当前 `phoneCol` 那一列——预约单折叠组只在 `col.key === 'pending'` 的渲染分支里存在（`:2486-2487`），若此刻 `phoneCol` 不是 `'pending'`，折叠组根本不在 DOM 里，点击「点击查看」没有任何可见效果。

严重度不高：店员仍可手动点「待接单」标签看到同样的折叠组，这个快捷入口只是在手机上失效，不影响数据正确性，也不在验收标准 5 的人工检查项之内。方案 Task 3 Step 4 给出的代码片段是桌面/手机共用同一份 JSX（`docs/superpowers/plans/.../batch1b-admin.md` 第 449-457 行），规划没有意识到手机模式下"点击查看"这个交互还需要联动切换 `phoneCol`。

## 已核实
- `cd apps/admin && npx tsc --noEmit` → 本次亲自运行，零错误（无输出）。
- `cd apps/admin && npm test` → 本次亲自运行，`tests 106 / pass 106 / fail 0`，含 `schedule.test.ts` 5 条与 `order-list.test.ts` 新增的 2 条预约单断言全部通过。
- `cd apps/server && npx tsc --noEmit` → 本次亲自运行，零错误（无输出）。
- `node scripts/check-admin-timezone.mjs` → 本次亲自运行，通过（"管理端时间渲染全部走 Asia/Shanghai"）；额外检查 `ScheduleSettings.tsx`/`schedule.ts`/`Workbench.tsx` 本次新增代码均未出现在 BANNED 属性名单（`toLocaleString` 系列、`getHours/getMinutes/…`、`setDate/setHours/…`）中，只经 `new Date(...)`/`.getTime()`/`utils/time` 的 `fmtHHmm`。
- 通读 `diff.patch`（21 个文件、1108 行）逐 hunk 核对，与执行者 excerpt 中六个 Task 的「验证」「偏离方案」原文对照，未发现执行者虚报验证结果。
- `apps/server/src/routes/admin/workbench.ts:182-210`：确认 WAITING 阶段预约单只进 `cols.scheduled`、不进五列（`continue`）；确认 `columns.scheduled` 排序也走 `sortColumn`（服务端数组顺序，前端未二次排序，符合"列内顺序不再排序"的既有约束）。
- `apps/server/src/routes/admin/stats/local.ts:19-53`：`scheduledCount` 用独立 `prisma.order.count` 并入同一组 `Promise.all`，`freeShipCount`/`avgDistanceM` 等老字段未改动；`localBlock` 对本期/上期各跑一次、外层 `kpi: { ...c.kpi, prev: p.kpi }`（`:144`）自动带出 `prev.scheduledCount`，无需专门处理。
- `apps/server/src/services/delivery/schedule.ts:28-41`、`apps/server/src/services/local-settings.ts:187-201、315-341、848-850`：核对 `schedulePrepMinutes` 高峰取大逻辑与默认高峰窗口、默认 `prepMinutes`，得出 R2 的结论。
- `apps/admin/src/pages/Workbench.tsx` 里 `ColKey` 收窄为排除 `'scheduled'` 后，grep 全文件 `columns[` 的四处用法（`:73`、`:80`、`:1105`、`:1637`、`:2478`）均通过 `COLUMNS` 数组或显式 `ColKey[]` 字面量取值，没有任何地方试图用 `col.key` 去访问 `'scheduled'`，类型收窄是安全的。
- `urgencyOf`（`:232-`）里 `if (colKey === 'done') return ''` 在预约单分支之前，预约单的 `scheduleUrgency` 分支只在 `card.local?.schedule` 非空时触发，对立即单（`sc` 为 `undefined`）逐字节不变；`scheduleCapsule` 对 `colKey==='done'` 显式返回 `null`，与"已完成列永不参与"的既有约束一致。
- `pending` 列计数（列头 `:2522`、`ColumnTabs` `:1105`）与顶栏 `scheduleOnBoard`（`:78-84`）：`columns.scheduled`（WAITING）与四列里 `local.schedule` 非空的卡片（TICKETED 及之后）互斥、不重叠，未发现重复计入。
- `ScheduleSettings.tsx` 的 `save()`（`:60-71`）：保存前重新 `getLocalSettings()` 取最新整包，只覆盖 `schedule`/`selfCancelLeadMin` 两个字段回写，不会覆盖并发修改的 `paused`/`holiday` 等字段，与 `PickupSettings.tsx` 同一模式。
- `DetailCustomer.tsx:33-35`：`order.schedule` 那一行是独立同级渲染（不嵌在 `isPickup` 分支内），会正常显示；`OrderDetail.tsx` 两处 `<DetailDelivery order={order} .../>` 均已补传 `order`，`DetailDelivery` 组件本身没有其它调用点。
- `docs/api.md` 附录 M 新增一行落在既有"接口"表格内，格式与相邻行一致。

## 无法核实
- 未运行 `npm run build`（协议要求本次复核不跑，避免写 dist）；执行者六个 Task 各自报告的 build 输出（含 vite 构建、chunk 体积警告）未独立复验，只复验了其中的 tsc 与时区检查两步。
- 未运行 e2e（协议要求本次复核不跑）；Task 6 执行者报告的干净库 e2e「通过 1986 / 失败 1」（唯一失败 `62-pickup.sh` 自取取消申请未自动驳回）未独立复现，也未确认该失败与本批改动无关——按材料所述该脚本本身不在本批 diff 范围内（`git diff` 未触及 `scripts/e2e.d/62-pickup.sh`），且编排者已说明正在隔离库复跑，此处不重复验证。
- 未做 Task 7 人工验收走查（造 WAITING/TICKETED/CALL_DUE/READY_WAITING/LATE 各阶段卡片、九项设置、订单列表筛选、经营概览 KPI 的真机截图）。检索 `docs/superpowers/notes/` 未发现本批（batch1b）对应的验收截图目录（`docs/superpowers/notes/2026-09-2x-scheduled-delivery-batch1b-acceptance/` 不存在），说明验收标准 5（人工检查）目前还没有留痕证据，只是静态审阅了代码逻辑是否与人工检查项描述的行为一致（胶囊文案、按钮矩阵、颜色语义），不能替代真实点击验证——尤其 R1 这类只在真实轮询节奏下才会复现的问题。
- Workbench.tsx 里"呼叫策略/CallQuoteBlock"报价块等既有逻辑与预约单按钮矩阵的交互（如 `hasQuote` 报价块在 `立即呼叫` 弹窗里的实际渲染效果）只做了静态代码核对，未在浏览器里实际点开确认。

---

## 第二轮

【工序】复核 【模型】Sonnet 【等级】M

结论：无阻断项

### R1：已解决
`apps/admin/src/utils/schedule.ts:20-28`（新增 `findCardColumn`，把原来只查五列的检测扩成五列 + `columns.scheduled` 六桶一起找，命中 `scheduled` 时 `colKey` 记为 `'pending'`）；调用点 `apps/admin/src/pages/Workbench.tsx:1636-1657`。
- 独立验证：`cd apps/admin && npx tsc --noEmit` 零错误；`npm test` 107/107 通过，含新增 `findCardColumn` 单测（覆盖 pending/preparing 命中、`scheduled`→`colKey:'pending'`、六处都未命中→`null` 四种情形）。
- 读代码核实：`SCHEDULE_COL_KEYS` 恰好是原 `COLUMNS` 的五个 key，查找顺序不变；未命中时再查 `columns.scheduled`，与 `renderCard`（`Workbench.tsx:2492` 一带）把 scheduled 卡片的 `onOpen` 传 `col.key==='pending'` 保持一致，`colChanged`/`statusChanged`/`setGone` 三处判定逻辑没有改变语义，只是把"从哪六个桶里找"这一步抽成了纯函数。
- 复核 `gone` 一旦置真不会自动复位这一点（第一轮报告曾提到）：核实这是 BASE（`d5a3a91`）之前就存在的既有设计（`git show d5a3a91:apps/admin/src/pages/Workbench.tsx` 同样的 `for` 循环、同样不重置 `gone`），不是本批引入、也不属于 R1 报的问题——R1 报的是"WAITING 预约单被误判为 gone"这一**假阳性**，六桶查找后 WAITING 卡片不会再落入 `setGone(true)` 分支，问题本身已经不会发生，不需要靠"重置 gone"来兜底。判定解决。

### R2：已解决
`apps/admin/src/pages/ScheduleSettings.tsx:24-27`（注释）、`:34-38`（高峰取大逻辑）、`:122`（命中提示行）。
- 读代码核实：`inPeak = !!noonHHmm && s.peak.windows.some((w) => noonHHmm >= w.start && noonHHmm < w.end)`、`prepMinutes = inPeak ? Math.max(sc.prepMinutes, s.peak.prepMaxMinutes) : sc.prepMinutes`——与服务端 `apps/server/src/services/delivery/schedule.ts:28-29` 的 `schedulePrepMinutes`（`minutesInPeak(...) ? Math.max(s.schedule.prepMinutes, s.peak.prepMaxMinutes) : s.schedule.prepMinutes`）公式、边界（`>= start && < end`）逐字对应；`noonHHmm` 取自锚点本身（恒为 `'12:00'`），字符串比较写法与既有 `Workbench.tsx:224-228` 的 `prepMinutesNow` 同一手法，不是新写法。
- 用默认设置（高峰第一段 12:00–13:00、`prepMinutes=20`、`peak.prepMaxMinutes=30`）手算：`inPeak=true`，`prepMinutes=max(20,30)=30`，与服务端一致，不再偏早 10 分钟。判定解决。
- 新引入的次要不一致（不影响本条判定，见下方 R4）：`ex.inPeak` 为真时提示文案固定写"备餐按高峰上界 {peakPrepMinutes} 分算"，但 `Math.max` 在 `sc.prepMinutes > s.peak.prepMaxMinutes` 时实际取的是 `sc.prepMinutes` 而非高峰上界——这种配置下提示文案的措辞会与实际取值不符，核心时刻数字（`ex.prepStart`/`ex.ticket`/`ex.acceptDue`）仍然正确。

### R3：已解决
`apps/admin/src/pages/Workbench.tsx:2460-2475`（`wb__schedbar` 的 `onClick` 里加 `if (isPhone) setPhoneCol('pending')`，在 `setScheduledOpen(true)` 之前执行）。
- 读代码核实：`isPhone`/`setPhoneCol` 均已在组件更早处声明（`:1436`/`:1438`），手机模式下点击倒计时条会先把 `phoneCol` 切回 `'pending'`，使 `(isPhone ? COLUMNS.filter((c) => c.key === phoneCol) : COLUMNS)`（`:2490`）渲染出待接单列，折叠组与滚动才有实际效果。桌面模式 `isPhone` 为假，分支不执行，行为不变。判定解决。

## 新问题

### R4 [建议]
位置：`apps/admin/src/pages/ScheduleSettings.tsx:38`（`prepMinutes = inPeak ? Math.max(sc.prepMinutes, s.peak.prepMaxMinutes) : sc.prepMinutes`）与 `:122`（`{ex.inPeak && <li>...备餐按高峰上界 {ex.peakPrepMinutes} 分算</li>}`，`ex.peakPrepMinutes` 在 `:47` 固定赋值为 `s.peak.prepMaxMinutes`）。

触发条件：店主把「预约单备餐时长」（`sc.prepMinutes`）设得比「高峰催备好上限」（`s.peak.prepMaxMinutes`）还大（两个输入框范围都是 0–180，允许这么配），且示例锚点 12:00 落在高峰窗口内时，`Math.max` 实际取的是 `sc.prepMinutes`（更大的那个），但提示文案仍写死"备餐按**高峰上界** {peakPrepMinutes} 分算"，数字和措辞都对不上实际生效的取值——核心时刻（`ex.prepStart`/`ex.ticket`/`ex.acceptDue`）本身仍按正确的 `Math.max` 结果算，只有这行解释性文案在这种配置下会读错。

严重度低：默认配置（`prepMinutes=20 < prepMaxMinutes=30`）不会触发，只在店主主动把预约单备餐时长调得比高峰上限还大时出现，且不影响任何实际下单/呼叫流程，纯属示例区一行说明文字的措辞不准确，不影响本批验收标准。

## 已核实（第二轮）
- `cd apps/admin && npx tsc --noEmit` → 本次亲自运行，零错误。
- `cd apps/admin && npm test` → 本次亲自运行，`tests 107 / pass 107 / fail 0`。
- `node scripts/check-admin-timezone.mjs` → 本次亲自运行，通过；本轮新增代码（`fmtHHmm(t, '')` 字符串比较、`isPhone`/`setPhoneCol`、`findCardColumn`）未触及 BANNED 属性名单。
- 通读 `diff-fix1.patch`（4 个文件、185 行）逐 hunk 核对，并与 `apps/server/src/services/delivery/schedule.ts`、`apps/server/src/services/local-settings.ts`、`apps/server/src/routes/admin/workbench.ts` 的相应片段逐字对照。
- `git show d5a3a91:apps/admin/src/pages/Workbench.tsx` 核实"gone 不自动复位"是 BASE 之前已有的既有设计，非本批/本轮引入。

## 无法核实（第二轮）
- 未运行 `npm run build`（协议要求不跑）；执行者本轮报告的 build 输出未独立复验，只复验了 tsc/test/时区脚本三项。
- 未运行 e2e（协议要求不跑）。
- Task 7 人工验收：编排者本条消息里转述"已在浏览器里用独立库（`food_shop_smoke`）实测工作台折叠组/倒计时条/七态胶囊/抽屉按钮/『已备好』到点即呼/设置页示例钟点/订单『预约』筛选/概览 KPI/375px 手机宽度均按预期"，但截图未落盘、我本次也没有浏览器访问权限，这条只是转述事实、未被我独立核实，据实记录不代表我已验证。
