-- 退款补查（2026-09-21）：三列全部可空/有默认，旧行 = 从未补查。纯加列，MySQL ≥ 8.0.12 走 INSTANT；回滚只回代码不回库。
ALTER TABLE `refunds`
  ADD COLUMN `reconcile_checked_at` DATETIME(3) NULL,
  ADD COLUMN `reconcile_count` INT NOT NULL DEFAULT 0,
  ADD COLUMN `reconcile_last_error` VARCHAR(255) NULL;
