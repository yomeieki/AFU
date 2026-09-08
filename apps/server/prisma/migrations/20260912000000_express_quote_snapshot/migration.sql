-- 邮寄报价快照三列。全部可空、additive：旧代码不读它们，代码回滚不需要回滚数据库。
ALTER TABLE `orders` ADD COLUMN `express_quote_snapshot` JSON NULL;
ALTER TABLE `orders` ADD COLUMN `express_region_group` VARCHAR(32) NULL;
ALTER TABLE `orders` ADD COLUMN `express_weight_g` INT NULL;
