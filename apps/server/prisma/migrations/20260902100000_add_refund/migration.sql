-- CreateTable
CREATE TABLE `refunds` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NOT NULL,
    `order_no` VARCHAR(32) NOT NULL,
    `out_trade_no` VARCHAR(64) NULL,
    `out_refund_no` VARCHAR(64) NOT NULL,
    `wx_refund_id` VARCHAR(64) NULL,
    `amount` INTEGER NOT NULL,
    `total_amount` INTEGER NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `mode` VARCHAR(16) NOT NULL,
    `reason` VARCHAR(80) NULL,
    `operator` VARCHAR(64) NULL,
    `active_order_id` INTEGER NULL,
    `channel` VARCHAR(32) NULL,
    `error_code` VARCHAR(64) NULL,
    `error_message` VARCHAR(255) NULL,
    `wx_response_data` TEXT NULL,
    `wx_notify_data` TEXT NULL,
    `success_time` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `refunds_out_refund_no_key`(`out_refund_no`),
    UNIQUE INDEX `refunds_wx_refund_id_key`(`wx_refund_id`),
    UNIQUE INDEX `refunds_active_order_id_key`(`active_order_id`),
    INDEX `refunds_order_id_idx`(`order_id`),
    INDEX `refunds_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
