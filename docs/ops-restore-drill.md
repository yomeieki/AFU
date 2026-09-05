# 备份恢复演练记录

> 上线前审查（B5-01/A13）指出：备份每天在跑，但**恢复从未演练过**，仓库里没有 restore 脚本，
> `deploy.sh` 只打印一行恢复命令。这是当时唯一没被验证过的安全网。
> 本文档记录第一次实测，以及之后每次演练该怎么做。

## 2026-09-05 首次演练 · 通过

**结论：备份可恢复。** 18 张表逐项对齐，金额合计完全一致，全程未触碰生产库。

| 项 | 结果 |
|---|---|
| 备份文件 | `/www/backups/daily/food_shop_20260905_020001.sql.gz`（18819 bytes，当日 02:00 定时产出） |
| gzip 完整性 | ✔ `gunzip -t` 通过 |
| dump 完整性 | ✔ 结尾有 `-- Dump completed on 2026-09-05 2:00:01`（不是被截断的半份） |
| 恢复耗时 | **1 秒** |
| 恢复目标 | 临时库 `food_shop_restore_test`，演练后已 DROP |

### 逐项校对（生产 vs 恢复库）

```
表数        18  vs  18
orders      14  vs  14      order_items 14  vs  14
products     8  vs   8      users        6  vs   6
payments    11  vs  11      refunds      6  vs   6
after_sales  3  vs   3      迁移记录    10  vs  10
```

**金额校验**：订单实付合计 `138.40 元`，两边一致。抽查三笔真实订单（含 CANCELLED / COMPLETED / REFUNDED 三种终态），订单号、状态、金额均可正常读出——恢复出来的是有数据的库，不是空壳表结构。

### 演练前必须先做的安全检查

这一步不能省。`mysqldump` 若带 `--databases` 参数，dump 里会含 `USE <库名>;`，那样**导入目标就不由命令行决定了，会直接写进生产库**。

```bash
B=/www/backups/daily/food_shop_YYYYMMDD_HHMMSS.sql.gz
gunzip -c "$B" | grep -ciE '^\s*USE\s'              # 必须是 0
gunzip -c "$B" | grep -ciE '^\s*CREATE\s+DATABASE'  # 必须是 0
```

本项目的 `backup.sh` 产出的是单库 dump，两项都是 0，安全。**若哪天改了备份命令，这个检查必须重做。**

---

## 演练步骤（可照抄）

生产机 `ubuntu` 用户有免密 sudo，MySQL 走 socket 认证的 root，**不需要密码，数据也不用离开服务器**。

```bash
ssh ubuntu@162.14.114.95
B=$(ls -t /www/backups/daily/food_shop_*.sql.gz | head -1)
T=food_shop_restore_test

# 0. 安全检查（见上）+ 完整性
gunzip -t "$B" && gunzip -c "$B" | tail -1 | grep -q "Dump completed"

# 1. 建临时库
sudo mysql -e "DROP DATABASE IF EXISTS \`$T\`; CREATE DATABASE \`$T\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

# 2. 恢复
gunzip -c "$B" | sudo mysql "$T"

# 3. 校对：表数、各表行数、金额合计
sudo mysql -N -e "
SELECT CONCAT('表数 ', (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='food_shop'),
              ' vs ', (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$T'));
SELECT CONCAT('orders ', (SELECT COUNT(*) FROM food_shop.orders), ' vs ', (SELECT COUNT(*) FROM $T.orders));
SELECT CONCAT('金额 ', (SELECT SUM(actual_amount) FROM food_shop.orders), ' vs ', (SELECT SUM(actual_amount) FROM $T.orders));"

# 4. 清理（务必执行）
sudo mysql -e "DROP DATABASE \`$T\`"
```

用 `trap cleanup EXIT` 包住，确保中途失败也不会把临时库留在生产机上。

---

## 真出事时的完整恢复流程

演练验证的只是「dump 能还原成一个内容一致的库」。**真正的故障恢复比这多两步**，两步都容易漏：

1. **先停写**：`pm2 stop food-shop-server`。边恢复边写会造成新旧数据交错。
2. 恢复：`gunzip -c <备份> | mysql -h <host> -P <port> -u <user> -p <生产库名>`
3. **如果这次故障发生在同城迁移之后**，恢复出来的 dump 里没有 `deliveries` / `delivery_events` / `print_jobs` 三张表，但它们已经真实存在于库里，且 `_prisma_migrations` 里留着成功记录。此时必须：
   ```sql
   DROP TABLE IF EXISTS delivery_events, deliveries, print_jobs;
   DELETE FROM _prisma_migrations WHERE migration_name LIKE '20260904%' OR migration_name LIKE '20260905%';
   ```
   不做这一步，下次 `prisma migrate deploy` 会在 `CREATE TABLE deliveries` 上报 already exists，被标记为 failed migration，**此后每次部署都直接 P3009 退出，部署管线彻底卡死**（这正是审查项 B5-05）。
4. 重启：`pm2 start food-shop-server`
5. 验证：`curl -sf http://127.0.0.1:3000/health`

**代价要事先知道**：恢复 dump = 丢掉备份时间点之后的全部订单与支付记录。当日 02:00 的备份，下午三点恢复就丢掉一整个白天的生意。所以「只回代码不动库」永远优先（迁移全是 additive，旧代码对新 schema 兼容），只有库被写坏、代码回滚救不回来时才走这条路。

---

## 下次该什么时候再演练

- **每次新增迁移之后**（表结构变了，恢复流程的第 3 步也跟着变）
- 换备份工具、改 `backup.sh` 的 dump 参数之后（安全检查必须重做）
- 至少每季度一次

演练结果追加到本文档，保留历史。
