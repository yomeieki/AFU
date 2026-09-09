# 店内认单一律只用手机尾号、不再显示「#订单号」（M 级）— 00 规划 · fable

## 原始需求与店主决定（2026-09-09）
> 全国邮寄的单号就都不显示订单号，全部显示尾号 → 追问后定：**所有位置**（工作台卡片/抽屉标题、小票票尾「单号：#xxxx」、催单/取消/顾客申请取消小票的「#xxxx」）**两个渠道一起改**，只保留手机尾号。

## 现状
- 工作台卡片（`Workbench.tsx` ≈1031）与抽屉标题（≈1788）显示「#2713 尾号0000」。
- 取消并退款弹窗 `CancelAndRefundModal.tsx` 两处显示「订单 #2713」。
- 全票票头两个渠道已只印「尾号XXXX」（09-08 定）；票尾仍有「单号：#2713」一行。
- 催接单 / 订单取消 / 顾客申请取消三张小票票头印 `<CB>#2713</CB>`，输入只有 orderNo 没有手机。
- 完整订单号仍在后台订单页可查，本次不动。

## 已向店主说明的代价
同一位顾客一天下两单，尾号相同，票面与卡片只能靠时间和菜品区分。店主已确认接受。

## 分步改动清单
1. `apps/server/src/services/ticket/content.ts`
   - 全票 footer 删掉 `单号：#${o.orderNo.slice(-4)}` 这一行，并把上方「PO 2026-09-07 只印后四位」注释改为「PO 2026-09-09 定：票面不印单号，认单只用尾号；完整单号在后台订单页」。
   - `renderReminderTicket` / `renderCancelTicket` / `renderCancelRequestTicket` 入参加 `receiverPhone: string`，票头第二行改为 `<CB>尾号${receiverPhone.slice(-4)}</CB>`；三个入参里的 `orderNo` 若不再使用就删掉（不留死字段）。
2. `apps/server/src/services/ticket/index.ts`：`renderForKind` 三处调用改传 `receiverPhone: order.receiverPhone`（`OrderForTicket` 已有该字段，`toTicketInput` 在用）。
3. `apps/admin/src/pages/Workbench.tsx`
   - 卡片与抽屉标题：只显示「尾号XXXX」，沿用 `.wb__shortno` 的粗体样式（它现在是主识别键）；`card.receiver.phone` 为空时兜底显示 `shortNo(card.orderNo)`（不该发生，但不能显示空白）。`.wb__tail` 类若不再使用则删除其 JSX 引用（CSS 不动）。
   - `shortNo` 保留（兜底与其它地方仍用）。
   - 给 `<CancelAndRefundModal>` 传 `receiverPhone={card.receiver.phone}`（≈2137 处）。
4. `apps/admin/src/components/CancelAndRefundModal.tsx`：新增 prop `receiverPhone: string`，两处「订单 #xxxx」改为「尾号XXXX」；`orderNo` prop 若不再使用就删掉并同步调用处。
5. `scripts/e2e.d/44-ticket-core.sh`：在现有「配送联票头是尾号」断言旁加一条：配送联**不含** `单号：#`。
6. `scripts/e2e.d/52-cancel-request-flow.sh`：顾客申请取消票断言处（≈71–74）加一条：票面含 `<CB>尾号` + 收件人手机后四位（用该段已有的订单/手机变量；若段内没有手机变量，用创建订单时的固定手机号常量）。
7. 本方案文件随改动一起提交。

## 验收标准（只在此定义，执行方不得新增或放宽）
- `cd apps/server && npx tsc --noEmit`：零错误。
- `cd apps/admin && npm test && npx tsc --noEmit`：16 条全过、零错误。
- `grep -rn 'orderNo.slice(-4)' apps/server/src/services/ticket apps/admin/src/pages/Workbench.tsx apps/admin/src/components/CancelAndRefundModal.tsx` 只剩 `Workbench.tsx` 里 `shortNo` 的定义一处。
- 规划方（fable）按 [[e2e-fresh-db-recipe]] 在干净库跑整套 e2e：全绿（已知偶发项除外），其中 §44、§52 新增断言通过。
- 04 haiku 机械核对：diff 文件集合 ⊆ 白名单；上述 grep 结果；两条 tsc 与 admin test 输出。

## 允许修改的文件白名单
- `apps/server/src/services/ticket/content.ts`
- `apps/server/src/services/ticket/index.ts`
- `apps/admin/src/pages/Workbench.tsx`
- `apps/admin/src/components/CancelAndRefundModal.tsx`
- `scripts/e2e.d/44-ticket-core.sh`
- `scripts/e2e.d/52-cancel-request-flow.sh`

## 上报触发条件（命中即停止并回报）
- `OrderForTicket` 或打印任务查询里拿不到 `receiverPhone`，需要改 Prisma 查询/数据结构。
- 需要改白名单以外的文件（含 `Workbench.css`、`selftest-member.ts`、小程序）。
- tsc / admin test 出现与本次无关的既有错误。
- 发现 `CancelAndRefundModal` 的 `orderNo` 还有别的用途（如提交接口要它）——此时保留该 prop，不要硬删。
