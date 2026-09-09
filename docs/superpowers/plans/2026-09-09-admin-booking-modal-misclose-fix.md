# 预约取件弹窗改重量后误触即关（S 级）— 00 规划 · fable

## 原始需求（店主 2026-09-09）
> 预约取件，改了重量误触分页上面（预约快递员上门取件）附近或者其他地方会秒退回工作台，你 check 一下 → 修

## 根因（已在本机预览复现并用事件记录证实）
按下标题时重量框先失焦 → `onBlur={requote}` 发起重报价 → `loading` 为 true 时报价列表整块换成一行「查价中…」→ 弹窗矮近 200px、居中重排后整体下跳约 96px → 抬手时同一坐标已是遮罩 → 遮罩 `onClick={onClose}` 关弹窗。
点弹窗外任意处秒退是同一个 `onClick`；工作台其它弹窗共用的 `WbModal` 遮罩不带关闭，只有这一个弹窗例外。

## 分步改动清单（只动一个文件：`apps/admin/src/components/ExpressBookingModal.tsx`）
1. 遮罩 `<div className="wb__modal-mask" onClick={onClose}>` 去掉 `onClick`，与 `WbModal` 一致；内层 `.wb__modal` 上的 `stopPropagation` 随之删掉（没有外层处理器就没意义）。退出路径只剩 ×、「再想想」、Esc（Esc 由 Workbench 统一处理，不动）。
2. 报价列表加载中不再整块替换：
   - 首轮（`q === null`）仍只显示「查价中…」（此时本来就没有行）。
   - 重报价期间（`loading && q`）继续渲染上一轮的 `rows`，行按钮 `disabled`，列表容器加内联样式 `opacity: 0.5, pointerEvents: 'none'`，并在列表上方保留一行 `wb__muted`「查价中…」。目的：弹窗高度在加载前后不变，标题不会从手指下面溜走。
   - 用 `aria-busy={loading}` 标在 `.wb__quote-list` 上。
3. 文件顶部注释补一句说明遮罩为何不关闭（防止以后有人「顺手」加回去）。

## 验收标准（只在此定义，执行方不得新增或放宽）
- `cd apps/admin && npm test`：16 条全过。
- `cd apps/admin && npx tsc --noEmit`：零错误。
- 规划方（fable）在本机预览按复现步骤走一遍：打开邮寄单 → 预约取件 → 改重量 → 立刻点标题：弹窗保持打开，报价按新重量刷新；点弹窗外灰色区域：弹窗保持打开；点 × / 「再想想」/ Esc：关闭。
- 首轮打开弹窗仍显示「查价中…」后出现报价并默认选中最便宜一家（不回归 316828c 的行为）。

## 允许修改的文件白名单
- `apps/admin/src/components/ExpressBookingModal.tsx`

## 上报触发条件（命中即停止并回报，不得自行处理）
- 需要改 `Workbench.tsx`、`Workbench.css` 或 `WbModal` 才能达成。
- 需要改 `load` / `inFlightKey` / `weightSynced` / `canSubmit` 的逻辑。
- `npm test` 或 `tsc` 出现与本次改动无关的既有错误。
