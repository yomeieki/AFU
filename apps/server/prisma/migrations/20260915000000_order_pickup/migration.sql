-- 到店自取（批次一）：订单加 4 列。纯加列、可空/带默认，回滚代码不需要回滚库。
ALTER TABLE `orders`
  ADD COLUMN `pickup_at` DATETIME(3) NULL,
  ADD COLUMN `pickup_discount_amount` INT NOT NULL DEFAULT 0,
  ADD COLUMN `pickup_ready_at` DATETIME(3) NULL,
  ADD COLUMN `pickup_reminded_at` DATETIME(3) NULL;
