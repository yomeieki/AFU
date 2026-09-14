-- 餐具（结算页餐具选择，2026-09-14 设计）：订单加两列，纯加列、可空，回滚代码不需要回滚库。
ALTER TABLE `orders` ADD COLUMN `tableware_mode` VARCHAR(16) NULL;
ALTER TABLE `orders` ADD COLUMN `tableware_count` INT NULL;
