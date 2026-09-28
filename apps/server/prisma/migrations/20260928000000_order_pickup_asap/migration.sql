-- 到店自取「尽快取」（2026-09-28）：只加一列，存量数据全是 false（= 预约自取）。
-- 旧代码不读新列，回滚代码无需回滚库。
ALTER TABLE `orders` ADD COLUMN `pickup_asap` BOOLEAN NOT NULL DEFAULT false;
