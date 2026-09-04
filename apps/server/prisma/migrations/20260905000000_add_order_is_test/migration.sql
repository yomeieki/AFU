-- 测试单隔离：联调/回归在正式库里留下的订单标 is_test=1，所有经营统计排除它。
-- 默认 0，存量行全部视为真实经营数据。
-- AlterTable
ALTER TABLE `orders` ADD COLUMN `is_test` BOOLEAN NOT NULL DEFAULT false;
