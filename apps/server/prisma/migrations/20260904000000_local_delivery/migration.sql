-- AlterTable
ALTER TABLE `addresses` ADD COLUMN `lat_e6` INTEGER NULL,
    ADD COLUMN `lng_e6` INTEGER NULL,
    ADD COLUMN `poi_name` VARCHAR(128) NULL;

-- AlterTable
ALTER TABLE `categories` ADD COLUMN `channel` VARCHAR(16) NOT NULL DEFAULT 'EXPRESS';

-- AlterTable
ALTER TABLE `orders` ADD COLUMN `announce_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `cancel_request_delivery_status` VARCHAR(16) NULL,
    ADD COLUMN `cancel_request_note` VARCHAR(255) NULL,
    ADD COLUMN `cancel_requested_at` DATETIME(3) NULL,
    ADD COLUMN `distance_m` INTEGER NULL,
    ADD COLUMN `estimated_delivery_at` DATETIME(3) NULL,
    ADD COLUMN `last_announced_at` DATETIME(3) NULL,
    ADD COLUMN `receiver_lat_e6` INTEGER NULL,
    ADD COLUMN `receiver_lng_e6` INTEGER NULL,
    ADD COLUMN `receiver_poi_name` VARCHAR(128) NULL;

-- AlterTable
ALTER TABLE `products` ADD COLUMN `channel` VARCHAR(16) NOT NULL DEFAULT 'EXPRESS',
    ADD COLUMN `net_weight_g` INTEGER NULL;

-- CreateTable
CREATE TABLE `deliveries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NOT NULL,
    `order_no` VARCHAR(32) NOT NULL,
    `delivery_no` VARCHAR(32) NOT NULL,
    `active_order_id` INTEGER NULL,
    `provider` VARCHAR(16) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `status_rank` INTEGER NOT NULL DEFAULT 0,
    `provider_status` INTEGER NULL,
    `status_desc` VARCHAR(255) NULL,
    `provider_task_id` VARCHAR(64) NULL,
    `provider_order_id` VARCHAR(64) NULL,
    `courier_company` VARCHAR(32) NULL,
    `courier_name` VARCHAR(64) NULL,
    `courier_mobile` VARCHAR(20) NULL,
    `callback_salt` VARCHAR(20) NOT NULL,
    `quoted_fee` INTEGER NULL,
    `actual_fee` INTEGER NULL,
    `tip_fee` INTEGER NOT NULL DEFAULT 0,
    `cancel_fee` INTEGER NOT NULL DEFAULT 0,
    `provider_distance_m` INTEGER NULL,
    `error_code` VARCHAR(16) NULL,
    `fail_reason` VARCHAR(255) NULL,
    `called_at` DATETIME(3) NULL,
    `accepted_at` DATETIME(3) NULL,
    `picked_up_at` DATETIME(3) NULL,
    `delivered_at` DATETIME(3) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancel_reason` VARCHAR(255) NULL,
    `last_callback_at` DATETIME(3) NULL,
    `call_timeout_reminded_at` DATETIME(3) NULL,
    `accepted_stuck_reminded_at` DATETIME(3) NULL,
    `delivering_reminded_at` DATETIME(3) NULL,
    `operator` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `deliveries_delivery_no_key`(`delivery_no`),
    UNIQUE INDEX `deliveries_active_order_id_key`(`active_order_id`),
    UNIQUE INDEX `deliveries_provider_task_id_key`(`provider_task_id`),
    INDEX `deliveries_order_id_idx`(`order_id`),
    INDEX `deliveries_status_called_at_idx`(`status`, `called_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `delivery_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `delivery_id` INTEGER NOT NULL,
    `dedupe_key` VARCHAR(64) NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `provider_status` INTEGER NULL,
    `status_desc` VARCHAR(255) NULL,
    `courier_name` VARCHAR(64) NULL,
    `courier_mobile` VARCHAR(20) NULL,
    `provider_update_time` VARCHAR(32) NULL,
    `operator` VARCHAR(64) NULL,
    `latency_ms` INTEGER NULL,
    `raw_payload` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `delivery_events_dedupe_key_key`(`dedupe_key`),
    INDEX `delivery_events_delivery_id_created_at_idx`(`delivery_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `print_jobs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NOT NULL,
    `order_no` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `provider` VARCHAR(16) NOT NULL,
    `printer_sn` VARCHAR(32) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `provider_job_id` VARCHAR(64) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_error` VARCHAR(255) NULL,
    `content` TEXT NOT NULL,
    `dedupe_key` VARCHAR(64) NOT NULL,
    `sent_at` DATETIME(3) NULL,
    `printed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `print_jobs_dedupe_key_key`(`dedupe_key`),
    INDEX `print_jobs_status_created_at_idx`(`status`, `created_at`),
    INDEX `print_jobs_order_id_idx`(`order_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `categories_channel_status_sort_order_idx` ON `categories`(`channel`, `status`, `sort_order`);

-- CreateIndex
CREATE INDEX `products_channel_status_idx` ON `products`(`channel`, `status`);

-- AddForeignKey
ALTER TABLE `deliveries` ADD CONSTRAINT `deliveries_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `delivery_events` ADD CONSTRAINT `delivery_events_delivery_id_fkey` FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
