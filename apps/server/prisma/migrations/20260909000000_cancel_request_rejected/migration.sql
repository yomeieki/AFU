-- 取消申请被驳回的痕迹（2026-09-07）。
--
-- 驳回这个动作本身是把 cancel_requested_at / cancel_request_note /
-- cancel_request_delivery_status 三列清空——清完之后**这单看起来就像从没有人申请过**。
-- 于是工作台没法显示「已驳回 · 继续完成此订单」，顾客端也没法显示「商家未同意取消」。
-- 这两列就是把那个痕迹留下来。
--
-- rejected_by 取值：
--   MANUAL  店员在工作台点的「驳回」
--   AUTO    接单满 5 分钟仍无人处理，定时任务自动驳回（PO 2026-09-07 定的「甲」口径：
--           计时从**接单**起算，与顾客端那个 5 分钟可申请窗口是同一条线）
--
-- 两列都可空、旧代码不读，代码回滚不需要回滚数据库。
ALTER TABLE `orders`
  ADD COLUMN `cancel_request_rejected_at` DATETIME(3) NULL,
  ADD COLUMN `cancel_request_rejected_by` VARCHAR(8) NULL;
