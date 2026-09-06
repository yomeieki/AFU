-- 删掉 scan_logs 两列：openid 与 user_agent。两列**从建表起就没有任何写入点**，
-- 2026-09-06 实测本地库 140 行中非空各 0 行，user_id 非空 140 行。
--
-- openid：删而不是补写。User.openid 是 @unique 且非空，而每次登录态扫码都写了 user_id，
--   所以每行的 openid 都能由 user_id 唯一确定——补写等于存一份 100% 冗余的副本，
--   两者的 COUNT(DISTINCT) 恒等，却多一个失步风险。
--   后台「独立访客」读的正是 COUNT(DISTINCT openid)，因此自 20260509073712_init 起一直显示 0；
--   已改数 user_id。
--
-- user_agent：删的理由与 openid 不同（它不冗余，没有别处记录）。理由是「不值」：
--   ① 唯一客户端是微信小程序，UA 近乎常量，只能支撑一个没人提过的「设备占比」；
--   ② POST /api/scan-logs 是全仓唯一匿名可写且零校验的接口（见 middlewares/rate-limit.ts），
--      把客户端完全可控的请求头原样存进 VarChar(255)，是为零个消费者存不可信自由文本，
--      而该接口担心的刷库场景已由 ip + scanLogLimiter 覆盖；
--   ③ 「留着加个 TODO 将来再写」正是 openid 在线上装死几个月的方式。真要做设备占比，
--      重新加一列只是一条迁移。
--
-- 无需回填：两列全表 NULL，不会丢任何信息。
-- 不给 user_id 另建索引：外键 scan_logs_user_id_fkey 已自带一条。
--
-- ⚠️ 目录时间戳必须晚于已应用的 20260907000000_review_fixes。
--    不能用 20260906000000_*——那会与已上线的 20260906000000_member_points_coupon 前缀相同，
--    字典序 drop < member，排到已应用的那条前面。

DROP INDEX `scan_logs_openid_idx` ON `scan_logs`;
ALTER TABLE `scan_logs` DROP COLUMN `openid`;
ALTER TABLE `scan_logs` DROP COLUMN `user_agent`;
