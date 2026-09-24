-- P15-P20（2026-09-24）：配送单取消意图 + 幽灵活单自动撤销。纯加列（全部可空/带默认值），
-- 旧代码不读新列，可安全回滚；回滚 SQL 见同目录 ROLLBACK.md。
ALTER TABLE `deliveries`
  ADD COLUMN `cancel_intent_at` DATETIME(3) NULL,
  ADD COLUMN `cancel_intent_by` VARCHAR(64) NULL,
  ADD COLUMN `cancel_intent_reason` VARCHAR(255) NULL,
  ADD COLUMN `cancel_intent_attempts` INT NOT NULL DEFAULT 0,
  ADD COLUMN `cancel_intent_last_error` VARCHAR(255) NULL,
  ADD COLUMN `cancel_intent_alerted_at` DATETIME(3) NULL,
  ADD COLUMN `ghost_cancel_at` DATETIME(3) NULL,
  ADD COLUMN `cancel_intent_locked_at` DATETIME(3) NULL;

CREATE INDEX `deliveries_cancel_intent_at_idx` ON `deliveries`(`cancel_intent_at`);
