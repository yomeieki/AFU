-- 呼叫策略（批次 1）：只呼最低价 + 3 分钟无人接自动升级并呼。
-- 两列都是 additive + NULL：旧代码不读它们，代码回滚不需要回滚数据库。
--
-- call_strategy 取值（见 services/delivery/orchestrator.ts）：
--   SOLO      引擎按报价快照选出的单家
--   ALL       并呼设置里的全部运力
--   MANUAL    店员在弹窗里指定了运力
--   SOLO_HELD SOLO 单到点该升级，但预估取消费 > 0，放弃自动升级（留给人工决定）
--   NULL      本次改动之前的历史行，前端显示为「并呼（旧）」
--
-- order_fees = batchOrder 响应 data.fee[] 原样（[{provider, feeFen, distanceM}]，与
-- quote_snapshot.quotes 同结构）。它是运力方**下单那一刻真预扣**的金额，快递100 企业后台
-- 那几行扣费明细就是它；quote_snapshot 是呼叫前 ≤5 分钟的免费查价，两者可能有出入。
-- actual_fee 认领中标运力报价时优先查这一列，查不到才退回 quote_snapshot。
ALTER TABLE `deliveries`
  ADD COLUMN `call_strategy` VARCHAR(16) NULL,
  ADD COLUMN `order_fees` JSON NULL;
