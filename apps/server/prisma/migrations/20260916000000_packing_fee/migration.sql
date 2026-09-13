-- 打包费（批次一）：商品加可覆盖单价、订单加快照列。纯加列、可空/带默认，回滚代码不需要回滚库。
ALTER TABLE `products` ADD COLUMN `packing_fee_fen` INT NULL;
ALTER TABLE `orders` ADD COLUMN `packing_fee` INT NOT NULL DEFAULT 0;
