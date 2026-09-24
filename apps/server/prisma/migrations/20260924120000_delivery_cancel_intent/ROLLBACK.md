# 回滚

代码回滚到 `7d900e2`/`9993cb7`（本次改动之前）时，新列可以留着不用管——旧代码不读它们，兼容。

如需彻底撤销这次迁移（删列）：

```sql
DROP INDEX `deliveries_cancel_intent_at_idx` ON `deliveries`;
ALTER TABLE `deliveries`
  DROP COLUMN `cancel_intent_at`,
  DROP COLUMN `cancel_intent_by`,
  DROP COLUMN `cancel_intent_reason`,
  DROP COLUMN `cancel_intent_attempts`,
  DROP COLUMN `cancel_intent_last_error`,
  DROP COLUMN `cancel_intent_alerted_at`,
  DROP COLUMN `ghost_cancel_at`;
DELETE FROM `_prisma_migrations` WHERE `migration_name` = '20260924120000_delivery_cancel_intent';
```
