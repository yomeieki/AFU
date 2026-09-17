-- 分类内商品排序（2026-09-17 设计 §3.1）：两处加列，都有默认值、不回填；存量全为 0 / MANUAL，
-- 顾客端顺序靠 created_at 兜底 = 上线前顺序（S5）。纯加列，回滚代码不需要回滚库。
ALTER TABLE `products` ADD COLUMN `sort_order` INT NOT NULL DEFAULT 0;
ALTER TABLE `categories` ADD COLUMN `product_sort_mode` VARCHAR(16) NOT NULL DEFAULT 'MANUAL';
