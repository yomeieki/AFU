-- 批次三：对账任务打标列（时段过期/取件超期主动查单）。纯加列、可空/带默认，回滚代码不需要回滚库。
ALTER TABLE `express_bookings`
  ADD COLUMN `stale_checked_at` DATETIME(3) NULL,
  ADD COLUMN `stale_reminded_at` DATETIME(3) NULL,
  ADD COLUMN `stale_tries` INT NOT NULL DEFAULT 0;
