# 店主决定（2026-09-23，回复「可以開始」= 全部按规划建议）
- D1：A 允许人工「核实未退 → 转 CLOSED 释放可重试」
- D2：A 允许按微信实退金额落账（0<实退≤可退余额，留痕记原金额）
- D3：A 任一笔退款成功时把同单 APPROVED 售后置 DONE
- D4：A 微信查询 CLOSED 但金额不符 → 直接按 CLOSED 释放（记 reconcileLastError + 告警）
- D5：确认新口径（REFUNDING 且无在途 / 任何状态有 ABNORMAL / 售后 APPROVED 且无在途）；无售后单的部分退款异步 CLOSED 不进
- D6：本批不做（50202 后不当场再查）
- R5 授权（2026-09-23 店主回复「放开」）：允许为修复 R5（顾客自助取消自动退款遇 50202 时推送文案冲突）改动 apps/server/src/routes/orders.ts 与 apps/server/src/services/order-notify.ts，仅限该修复所需的最小改动；具体范围以规划者裁决为准。
