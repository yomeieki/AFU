-- P1（2026-09-23）：ABNORMAL 退款行的窄口径人工核实出口。纯加列，回滚只需回退代码。
ALTER TABLE `refunds`
  ADD COLUMN `manual_resolved_by` VARCHAR(64) NULL,
  ADD COLUMN `manual_resolved_at` DATETIME(3) NULL,
  ADD COLUMN `manual_resolve_note` VARCHAR(120) NULL;
