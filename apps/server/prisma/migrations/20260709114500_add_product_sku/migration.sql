-- AlterTable
ALTER TABLE `carts` ADD COLUMN `sku_id` INTEGER NULL;

-- AlterTable
ALTER TABLE `order_items` ADD COLUMN `sku_id` INTEGER NULL,
    ADD COLUMN `spec_text` VARCHAR(128) NULL;

-- AlterTable
ALTER TABLE `products` ADD COLUMN `spec_dimensions` JSON NULL;

-- CreateTable
CREATE TABLE `product_skus` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `product_id` INTEGER NOT NULL,
    `spec_text` VARCHAR(128) NOT NULL,
    `spec_values` JSON NOT NULL,
    `price` INTEGER NOT NULL,
    `original_price` INTEGER NULL,
    `stock` INTEGER NOT NULL DEFAULT 0,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `product_skus_product_id_spec_text_key`(`product_id`, `spec_text`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex（先建新组合唯一索引——前缀 user_id 可继续支撑 carts_user_id_fkey——再删旧索引）
CREATE UNIQUE INDEX `carts_user_id_product_id_sku_id_key` ON `carts`(`user_id`, `product_id`, `sku_id`);

-- DropIndex
DROP INDEX `carts_user_id_product_id_key` ON `carts`;

-- AddForeignKey
ALTER TABLE `product_skus` ADD CONSTRAINT `product_skus_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `carts` ADD CONSTRAINT `carts_sku_id_fkey` FOREIGN KEY (`sku_id`) REFERENCES `product_skus`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
