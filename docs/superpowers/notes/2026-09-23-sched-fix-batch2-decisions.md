# 店主决定（2026-09-23）
- 定级：规划者建议升 L（S1 触及 orchestrator 取消配送的资金路径与 callRider 原子复核），编排者按 §2.2 升为 L：执行 Sonnet，复核 Opus 新会话。
- D1：A 店员取消配送 = 撤回「已备好」（readyAt 清空，零迁移）
- D2：A 保留 remindScheduledNotReady 对取消后悬置单的催促
- D3：B 自取票「取餐」放大行一起修（日期普通字号 + 时段放大，pickupTicketLabel 同法加 date/time，content.ts:341 拆两行）；apps/server/src/services/pickup.ts 已从 deny 移入 allow，仅限该修复所需改动
- D4：A 预约单接单时那一次 kickOffQuote 不改
- D5：A 付款已过出票时刻不再补打 PREP 备餐票（只打标 + 企微）
- D3 补充授权（2026-09-23 编排者）：店主已明确要求自取票一起修（D3=B）；执行者因 scripts/e2e.d/62-pickup.sh:204 字面断言不在授权内而撤回。该断言是 D3 的必要配套，编排者据店主 D3 决定把 scripts/e2e.d/62-pickup.sh 加入 allow.txt，**仅限第 204 行附近「印取餐时间」断言按新格式（普通日期行 + 放大时段行）微调，不改验证意图、不放宽**。
- R5 追认（2026-09-23 编排者）：执行者对 scripts/e2e.d/69-scheduled-delivery.sh:140-143 的字面匹配调整，经核对与 62-pickup.sh:204 同类（跟随 S7 新票面格式，仍断言印出送达时段且要求放大时段行存在，未放宽），属店主已批 S7/D3 的必要配套，编排者追认，限该处。
- R4 处理口径：人工走查需登录后台（代理不能输入管理员密码），执行者在验证栏写「未运行 + 原因」，并用纯函数实际输出替代展示 S3 迟到弹窗文案与 S4 CALL_DUE 胶囊文案；真机/后台走查由店主上线后进行。
