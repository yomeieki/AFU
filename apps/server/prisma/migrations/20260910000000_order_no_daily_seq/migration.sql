-- 当日单号流水计数器。
--
-- 小票与工作台现在只显示单号后四位（2026-09-07 定的口径）。旧实现是「六位随机数」，
-- 后四位就是均匀随机的一万个数：生日问题下同一天 100 单出现重号的概率 39%，200 单 86%。
-- 改成按天自增后，后四位 = 当天第几单，当天内保证唯一。
--
-- 一行/天，用 INSERT ... ON DUPLICATE KEY UPDATE 原子自增；行锁只在取号那一瞬持有。
-- 不回填历史：新号是 15 位（ORD+8 位日期+4 位流水），旧号是 18 位，两者不可能重号，
-- 所以切换当天从 0001 重新开始既安全也更好读。
CREATE TABLE `order_no_seq` (
  `day_key` CHAR(8) NOT NULL,
  `seq` INT UNSIGNED NOT NULL DEFAULT 0,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`day_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
