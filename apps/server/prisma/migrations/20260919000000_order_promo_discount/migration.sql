-- 全店自动满减（2026-09-17 设计 §3.2）：订单加一列快照，本单实际减掉的满减金额（分）。
-- 只加列、有默认值、不回填：老订单为 0 = 没参加/未达标，详情与小票不显示满减行。纯加列，回滚代码不需要回滚库。
ALTER TABLE `orders` ADD COLUMN `promo_discount_amount` INT NOT NULL DEFAULT 0;
