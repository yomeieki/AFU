-- AlterTable
ALTER TABLE `orders` ADD COLUMN `points_base` INTEGER NULL;

-- AlterTable
ALTER TABLE `print_jobs` ADD COLUMN `copies` INTEGER NOT NULL DEFAULT 1;
