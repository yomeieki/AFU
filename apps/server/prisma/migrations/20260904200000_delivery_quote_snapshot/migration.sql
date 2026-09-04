-- AlterTable
ALTER TABLE `deliveries` ADD COLUMN `called_providers` JSON NULL,
    ADD COLUMN `quote_snapshot` JSON NULL,
    ADD COLUMN `quoted_at` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `orders` ADD COLUMN `quote_snapshot` JSON NULL,
    ADD COLUMN `quoted_at` DATETIME(3) NULL;
