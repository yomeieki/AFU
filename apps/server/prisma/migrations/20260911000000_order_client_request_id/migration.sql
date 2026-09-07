-- 客户端下单幂等键。
--
-- 只加一个可空列 + 一个唯一索引，additive：旧代码不读这一列，所以**代码回滚不需要回滚数据库**。
-- 已有订单该列为 NULL；MySQL 的唯一索引把多个 NULL 视为互不相同，存量行不会撞索引。
--
-- 唯一键带 user_id 是安全边界：只用 client_request_id 的话，
-- A 用户拿 B 的 id 提交就会命中 B 的订单并拿到 B 的订单号与金额。
ALTER TABLE `orders` ADD COLUMN `client_request_id` VARCHAR(36) NULL;

CREATE UNIQUE INDEX `orders_user_id_client_request_id_key`
  ON `orders`(`user_id`, `client_request_id`);
