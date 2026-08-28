-- AlterTable
ALTER TABLE `orders` ADD COLUMN `accepted_at` DATETIME(3) NULL,
    ADD COLUMN `completed_at` DATETIME(3) NULL;

