-- AlterTable
ALTER TABLE `deliveries` ADD COLUMN `unknown_reminded_at` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `orders` ADD COLUMN `cancel_request_reminded_at` DATETIME(3) NULL,
    ADD COLUMN `local_uncalled_reminded_at` DATETIME(3) NULL;
