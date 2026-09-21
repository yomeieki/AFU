-- 预约送达（批次一）：orders 加 4 个可空列 + 索引，deliveries 加 1 个可空列。纯加列，回滚代码不需回滚库。
ALTER TABLE `orders`
  ADD COLUMN `scheduled_at` DATETIME(3) NULL,
  ADD COLUMN `ready_at` DATETIME(3) NULL,
  ADD COLUMN `prep_ticket_at` DATETIME(3) NULL,
  ADD COLUMN `schedule_reminded_at` DATETIME(3) NULL;
CREATE INDEX `orders_delivery_type_scheduled_at_idx` ON `orders`(`delivery_type`, `scheduled_at`);
ALTER TABLE `deliveries` ADD COLUMN `call_origin` VARCHAR(16) NULL;
