-- AlterTable
ALTER TABLE `order_items` ADD COLUMN `is_gift` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `points_cost` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `orders` ADD COLUMN `coupon_id` INTEGER NULL,
    ADD COLUMN `discount_amount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `points_earned` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `points_settled_at` DATETIME(3) NULL,
    ADD COLUMN `points_used` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `users` ADD COLUMN `points_balance` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `points_ledgers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `type` VARCHAR(16) NOT NULL,
    `delta` INTEGER NOT NULL,
    `balance_after` INTEGER NOT NULL,
    `remaining` INTEGER NOT NULL DEFAULT 0,
    `ref_type` VARCHAR(16) NOT NULL,
    `ref_id` VARCHAR(32) NOT NULL,
    `remark` VARCHAR(255) NULL,
    `expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `points_ledgers_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `points_ledgers_user_id_type_expires_at_idx`(`user_id`, `type`, `expires_at`),
    UNIQUE INDEX `points_ledgers_type_ref_type_ref_id_key`(`type`, `ref_type`, `ref_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `coupon_templates` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(64) NOT NULL,
    `description` VARCHAR(255) NULL,
    `amount` INTEGER NOT NULL,
    `threshold` INTEGER NOT NULL DEFAULT 0,
    `channel` VARCHAR(16) NOT NULL DEFAULT 'ALL',
    `valid_days` INTEGER NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `points_cost` INTEGER NULL,
    `total_limit` INTEGER NULL,
    `per_user_limit` INTEGER NULL,
    `issued_count` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(16) NOT NULL DEFAULT 'ON',
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `coupon_templates_source_status_sort_order_idx`(`source`, `status`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_coupons` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `template_id` INTEGER NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `amount` INTEGER NOT NULL,
    `threshold` INTEGER NOT NULL DEFAULT 0,
    `channel` VARCHAR(16) NOT NULL DEFAULT 'ALL',
    `status` VARCHAR(16) NOT NULL DEFAULT 'UNUSED',
    `source` VARCHAR(16) NOT NULL,
    `source_ref` VARCHAR(64) NULL,
    `issued_by` VARCHAR(64) NULL,
    `remark` VARCHAR(255) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `order_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `user_coupons_code_key`(`code`),
    INDEX `user_coupons_user_id_status_expires_at_idx`(`user_id`, `status`, `expires_at`),
    INDEX `user_coupons_order_id_idx`(`order_id`),
    INDEX `user_coupons_status_expires_at_idx`(`status`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `points_goods` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `product_id` INTEGER NOT NULL,
    `sku_id` INTEGER NULL,
    `points_cost` INTEGER NOT NULL,
    `per_order_limit` INTEGER NOT NULL DEFAULT 1,
    `stock_limit` INTEGER NULL,
    `issued_count` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(16) NOT NULL DEFAULT 'ON',
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `points_goods_status_sort_order_idx`(`status`, `sort_order`),
    UNIQUE INDEX `points_goods_product_id_sku_id_key`(`product_id`, `sku_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `orders_status_points_settled_at_completed_at_idx` ON `orders`(`status`, `points_settled_at`, `completed_at`);

-- AddForeignKey
ALTER TABLE `points_ledgers` ADD CONSTRAINT `points_ledgers_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_coupons` ADD CONSTRAINT `user_coupons_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_coupons` ADD CONSTRAINT `user_coupons_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `coupon_templates`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
