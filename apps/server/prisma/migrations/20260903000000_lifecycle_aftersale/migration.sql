-- AlterTable
ALTER TABLE `orders` ADD COLUMN `accept_reminded_at` DATETIME(3) NULL,
    ADD COLUMN `refunded_amount` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `refunds` ADD COLUMN `after_sale_id` INTEGER NULL;

-- CreateTable
CREATE TABLE `after_sales` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NOT NULL,
    `order_no` VARCHAR(32) NOT NULL,
    `user_id` INTEGER NOT NULL,
    `reason` VARCHAR(32) NOT NULL,
    `description` TEXT NULL,
    `images` JSON NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `reply` VARCHAR(255) NULL,
    `refund_id` INTEGER NULL,
    `handled_by` VARCHAR(64) NULL,
    `handled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `after_sales_order_id_idx`(`order_id`),
    INDEX `after_sales_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `after_sales` ADD CONSTRAINT `after_sales_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 存量数据修正：
-- 1) 已成功的退款不再占用 active_order_id（新语义：仅在途退款占位，成功后可再发起部分退款）
UPDATE `refunds` SET `active_order_id` = NULL WHERE `status` = 'SUCCESS';
-- 2) 回填订单已退金额 = 该订单所有成功退款之和
UPDATE `orders` o
SET o.`refunded_amount` = (
  SELECT COALESCE(SUM(r.`amount`), 0) FROM `refunds` r WHERE r.`order_id` = o.`id` AND r.`status` = 'SUCCESS'
);
