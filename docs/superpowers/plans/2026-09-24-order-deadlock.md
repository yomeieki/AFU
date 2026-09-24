# 同商品并发下单死锁（50001）：固定锁序 + 整事务重试（2026-09-24）

【工序】规划 【模型】Fable 5.1 【等级】L

- BASE：`1dbe0102e9a1eee87a0bc5610742d282d6557769`（= main 最新）
- 等级 L：§2.2 第 2 条（下单扣库存的事务/锁/并发一致性）。零迁移、不动 schema。
- 本方案只允许规划者写这一份文件；执行者按「授权范围」改代码，**不部署**（部署前编排者必须问店主）。

## 0. 调查结论（执行者不必重查；行号按 BASE）

### 0.1 根因（已由两组证据钉死）

1. 编排者 `SHOW ENGINE INNODB STATUS`：两个下单事务都 `HOLDS … index PRIMARY of table products … lock mode S`，都 `WAITING … lock_mode X` 在 `UPDATE products SET stock = stock - 1, sales_count = sales_count + 1 WHERE id = 10`。
2. 我在 `food_shop_dl` 上用两条 mysql 会话复现（探针行已清理、库存/销量已原样还回）：
   - **BASE 形态**（`INSERT order_items` → SLEEP → `UPDATE product_skus` → `UPDATE products`），第二个会话 0.4 s 后进入：`ERROR 1213 (40001) Deadlock found when trying to get lock`。
   - **修复形态**（`UPDATE product_skus` → `UPDATE products` → `INSERT order_items`）：两个会话都 `A-done`/`B-done`，后到者只是排队等前者 COMMIT，没有死锁。
   - 对 `users` 行同一机制：`INSERT points_ledgers(user_id=U)` → SLEEP → `UPDATE users WHERE id=U`，两会话 → 第二个 `ERROR 1213`；把 `SELECT id FROM users WHERE id=U FOR UPDATE` 放到事务第一句 → 两会话都成功。

机制：`order_items.product_id` 有外键 `order_items_product_id_fkey`（`information_schema.KEY_COLUMN_USAGE` 实查存在；`order_items.sku_id` **没有**外键，schema 注释也写明「无外键」）。`routes/orders.ts:573-609` 的 `tx.order.create({ items: { create } })` 先插 `order_items`，InnoDB 为外键校验给 `products` 行加 **S 锁**；`:612-632` 随后 `product.update` 要 **X 锁**——两笔同商品事务各持 S、各等 X，必死锁。基线日志里 `:614`（sku）18 次 / `:621`（product）41 次都是同一个环的两个等待点：牺牲者卡在哪一句，栈就指向哪一句，与 sku 行本身无关。

`orders.user_id` → `users` 也是外键（`orders_user_id_fkey`）：`order.create` 给 `users` 行加 S 锁；随后只有 `pointsUsed > 0` 时 `consumePoints`（`services/member/points.ts:137`）会 `user.update` 要 X 锁。所以**同一用户两笔并发下单且都带赠品积分**时是同型死锁（上面第 3 组探针）。同一用户并发下单**不带积分**时只有 S+S，不成环。

### 0.2 现有代码里所有扣/加库存与插 `order_items` 的路径（全仓 grep）

| 路径 | 位置 | 现有锁序（只列会锁已有行的语句） |
|---|---|---|
| **下单** | `routes/orders.ts:570-661` | S(products, 外键) → X(product_skus 逐行, 按 lines 顺序) → X(products) → user_coupons → points_ledgers → X(users, 仅 pointsUsed>0) → points_goods → carts(删自己的行) |
| 后台改库存 | `routes/admin/products.ts:358-397` | X(product_skus, `FOR UPDATE`) → X(products)；P2034 重试 ≤5 |
| 后台整包编辑商品 | `routes/admin/products.ts:404-490` | product_images → product_skus（删/改/建，**按请求体顺序**）→ X(products) |
| 取消回滚（4 条 PENDING_PAYMENT→CANCELLED） | `routes/orders.ts:1030-1041`、`routes/admin/orders.ts:668-676`、`:783-794`、`services/scheduler.ts:206-217` | X(orders) → `rollbackOrderStock`（**按 items 顺序** sku→product 交替）→ `releaseOrderBenefits`（user_coupons → X(users) → points_ledgers 插 → points_goods） |
| 秒退（顾客） | `routes/orders.ts:1060-1090` | X(orders) → `rollbackOrderStock` |
| 退款发起 | `services/refund.ts:176-221` | `FOR UPDATE`(orders) → `rollbackOrderStock` → refunds 插 |
| 退款落账 | `services/refund.ts:440-442` + `deductPointsOnRefund`（`points.ts:445-470`） | X(refunds) → X(orders) → points_ledgers → X(users) |
| 积分结算 | `points.ts:227-300` | `FOR UPDATE`(orders) → points_ledgers 插（新行）→ X(users) → points_ledgers（只改自己刚插的 EARN 行） |
| 积分过期 | `points.ts:322-350` | points_ledgers → X(users) |
| 渠道/排序/二维码 | `services/product-channel.ts:68`、`routes/admin/categories.ts:105`、`routes/admin/products.ts:502,522` | 只 X(products)，不先锁 sku |

`rollbackOrderStock`（`utils/order-stock.ts:14-31`）**没有**外键插入，所以自身无 S→X 升级；但它按 `items` 顺序 sku₁→product→sku₂→product 交替锁，两笔多规格订单的回滚若顺序相反可成环（`products.ts:333-334` 注释已承认）。本批一并改成「先全部 sku 升序、再全部 product 升序（按商品聚合）」，与下面的全局锁序一致。

### 0.3 技术选择：**固定锁序为主、整事务 P2034 重试为兜底，两者都做**

- 只加重试不改锁序：每笔并发都先死锁再重试，晚高峰同一道热菜 30 人抢单会是「重试风暴」，且重试 5 次仍可能穿透（基线每次尝试死锁率很高：30 并发 3 轮只有 31/90 成功）。
- 只改锁序不加重试：本批分析覆盖了全部已知路径，但「后台整包编辑商品」的 sku 锁序按请求体、以及未来新增路径，都可能再成环；重试是这类残余的安全网，成本一个循环。
- **不用 `SELECT … FOR UPDATE` 预锁**：把扣减语句本身挪到 `order.create` 之前即可——`UPDATE` 直接拿 X 锁，之后外键校验要的 S 锁被自己的 X 覆盖，不需要多一条锁定读（0.1 第 2 组探针已证）。`users` 行例外：它没有「先 UPDATE」的自然位置（`consumePoints` 在 `order.create` 之后且要 orderId），所以 `pointsUsed > 0` 时在 `order.create` 之前补一句 `SELECT id FROM users WHERE id = ? FOR UPDATE`。

### 0.4 全局锁序（本批之后所有路径必须遵守；新增路径也按这个顺序）

```
L0  orders 行（只有操作已有订单的路径：取消/秒退/退款/结算；下单是插新行，不锁已有 orders 行）
L1  product_skus 行，按 id 升序
L2  products 行，按 id 升序
L3  users 行（X）
L4  user_coupons / points_ledgers / points_goods / refunds / carts（各路径只碰子集，彼此方向已核对同向）
```

逐路径核对（改完后）：
- 下单：L1 → L2 → L3(`FOR UPDATE`, 仅 pointsUsed>0) → 插 orders/order_items（外键 S 锁 ⊂ 已持 X）→ user_coupons → points_ledgers(改已有行) → users(X, 已持) → points_goods → carts。
- 取消 4 条 + 秒退 + 退款发起：L0 → L1(升序) → L2(升序) → [user_coupons → users(X) → points_ledgers 插 → points_goods]。与下单同向（下单不锁 L0）。
- 退款落账：refunds → orders → points_ledgers → users；积分结算：orders → points_ledgers(新行) → users → 自己的新行；积分过期：points_ledgers → users。三者都不碰 L1/L2，且 users 恒在 points_ledgers 之后，与下单同向。
- 后台改库存：L1(一行) → L2 ✓。后台整包编辑：L1(按请求体顺序) → L2 —— sku 之间的顺序不保证，**留后**（见 §留后），下单侧由重试兜住。
- points_goods：下单在 users 之后；`releaseOrderBenefits` 也在 users 之后 ✓。
- 多商品/多规格：把本单所有行先按 `skuId` 升序做 L1，再按 `productId` 升序做 L2（每个商品一条 UPDATE，数量按行聚合）。`MULTI=2`（两商品、一半用户反序）在排序后所有事务顺序相同。

### 0.5 重试的幂等性（逐项）

| 项 | 结论 |
|---|---|
| `orderNo` | 事务外 `allocateOrderNo()` 取号（`services/order-no.ts:117-127`），失败的尝试从未提交，同一个号可原样复用；`orders.order_no` 唯一索引是最后一道闸，撞上是 P2002 且 target 不含 `client_request_id` → 照旧上抛 |
| `clientRequestId` 的 P2002 分支 | 保留原语义：任一次尝试抛 (user_id, client_request_id) 的 P2002 → 查赢家原样返回，**不重试**。重试与它正交：P2034 重试后若另一笔同键请求已提交，下一次尝试会以 P2002 结束并走这个分支 |
| 库存扣减 / 券核销 / 积分 FIFO / 赠品名额 / 清购物车 | 全在同一事务内，P2034 时 MySQL 已整体回滚，重跑从零开始；`consumePoints` 每次重新 `findMany` 账本行，`applyOrderBenefits` 三步都是条件更新判 count |
| 事务外副作用 | 下单路径在事务后只有 `success(res, orderCreatedView(...))`；通知/打印/积分都在支付回调，`POST /api/orders` 不触发。重试不会重复任何外部动作 |
| 只重试什么 | `Prisma.PrismaClientKnownRequestError && code === 'P2034'`（MySQL 1213；1205 锁等待超时也映射到 P2034，但 `innodb_lock_wait_timeout=50s` > 事务 `timeout: 15000`，实际先出 P2028，不重试）。`AppError`（42201/42251/…）、P2002、P2028 一律不重试 |
| 上限与退避 | 5 次（与 `products.ts` 的 `STOCK_UPDATE_MAX_ATTEMPTS` 同值），间隔 `50ms × attempt + 0–30ms 随机抖动`；每次重试 `console.warn('[orders] 下单遇死锁，重试 n/5')`（验收要靠数这行） |
| 5 次后 | 见「待用户决定」#1；默认（不改）= 原样上抛 → `errorHandler` 50001 + 企微「接口 500」告警，小程序 `utils/request.js:10` 已把 50001 映成「系统开小差了，请稍后再试」 |

### 0.6 既有自动检查（全部收进验收）

- `apps/server`：`build: tsc`（`npx tsc --noEmit -p apps/server` 等价）；无 test 脚本。
- 根：`test:miniapp: node --test tests/miniapp/*.test.cjs`。
- `apps/admin`：`npm test --workspace=apps/admin`（vitest，上一批 143 pass）——本批不动前端，但它是仓库既有闸门，照跑。
- 无 `.husky`、无 `.github/workflows`、无 `.agent/high-risk.txt`、无 `.agent/check-scope.sh`（范围检查无法运行，编排者在交付报告注明）。
- 干净库全量 e2e：`scripts/e2e.sh` + `scripts/e2e.d/*.sh`（2008 行处 `source` 全部分片，**不能单跑分片**）；已知偶发：`e2e.d/42` B4-1 并发领券、`e2e.d/45` 打印机 4 条依赖顺序、74.11 耗时断言在 docker exec 慢时偶发（见低库存方案修订 3）。
- 本 worktree 的 `node_modules` 是私有目录（非软链，含 `.prisma/client`）；本批零迁移，**不要 `prisma generate`**，除非 tsc 报与本批无关的 Prisma 类型错（那是私有拷贝过期，确认是私有目录后本地 generate 一次即可）。

## 验收标准

所有命令在执行者 worktree 根目录跑；服务端命令加 `TZ=Asia/Shanghai`。执行者的端口/库名固定为 **3142 / `food_shop_dlk`**（避开 3128–3133、3140、3141 与 `food_shop_ad/ls/rv_*/dl/dl_plan`）；只杀自己记下 PID 的进程，禁止 `pkill`/`killall`。

1. 【类型】`npx tsc --noEmit -p apps/server` → exit 0、无输出；`npm run build:server` → exit 0。
2. 【既有测试】`npm run test:miniapp` → 全 pass；`npm test --workspace=apps/admin` → 与 BASE 同一 pass 数、0 fail。
3. 【零迁移】`git diff 1dbe010 --stat -- apps/server/prisma` → 空。
4. 【压测脚本固化】新文件 `scripts/stress-order-deadlock.sh`（从编排者的 `stress.sh` 移植，见实现方向 5）。在执行者自己的 3142/`food_shop_dlk` 上，对**修复后**代码逐一跑下面 7 个场景，每个都必须：末行 `RESULT 50001=0 invariant_bad=0`、退出码 0、`== orders result codes ==` 里只出现 `0` 与 `42201` 两种 code（出现 40001/50001/其它即红）、`orders_in_db == success_responses`、每个商品 `stock == SUM(sku)` 且 `sales_count == order_items_qty`、每个 sku `stock == STOCK − 已下单件数 ≥ 0`（脚本已内置这些判定）：
   - a `NORD=30 ROUNDS=3` → 90 success
   - b `NORD=2 ROUNDS=60` → 120 success
   - c `NORD=20 ROUNDS=2 MULTI=1`（同商品两规格一单）→ 40 success
   - d `NORD=20 ROUNDS=2 MULTI=2`（两商品一单、一半用户反序）→ 40 success
   - e `NORD=20 ROUNDS=2 NPUT=10`（并发后台改库存）→ 40 success，`== puts result codes ==` 全 0
   - f `NORD=30 ROUNDS=1 STOCK=5` → **恰好 15 success + 15 × 42201**（3 个规格各 5 件、各被 10 人抢：每规格 5 成 5 败），sku 终值全 0、不为负
   - g `NORD=20 ROUNDS=2 SAMEUSER=1`（同一用户 20 笔并发、不带积分）→ 40 success
   把 7 次的完整输出贴进回报。对比基线（BASE 代码，编排者实测）：a 31/59×50001、b 63/57、c 12/28、d 11/29、e 14/26、f 10+1×42201+19×50001。
5. 【服务端日志】跑完 4 的 7 个场景后 `grep -c '下单遇死锁' <服务端日志>` → **0**（固定锁序本身消灭了这些场景的死锁；重试只是兜底，不许在这里被消耗），`grep -c P2034 <日志>` → 0。
6. 【改坏验证矩阵】各改一次、跑场景 a 与 c（`NORD=30 ROUNDS=3` 与 `MULTI=1`）后**恢复**，四组结果都要贴进回报：
   - K1 只去掉锁序重排（把扣减循环放回 `order.create` 之后、恢复 BASE 逐行交替顺序），保留重试 → `RESULT 50001=0`（重试兜住），但 `grep -c '下单遇死锁' 日志` **> 0**。证明压测确实打出死锁、重试是真兜底。
   - K2 只去掉重试（`attempts=1`），保留锁序重排 → `RESULT 50001=0 invariant_bad=0`，日志 P2034 = 0。证明锁序单独就够，重试不是遮羞布。
   - K3 两者都去掉（= BASE 形态）→ `50001 > 0`（红）。
   - K4 `rollbackOrderStock` 不排序改坏（还原为按 items 顺序交替）→ 无法用本压测稳定打红（回滚 vs 回滚成环需两笔反序多规格取消毫秒级并发），**不要求红**；改回后靠第 8 条的 74.11-a/b/g（回滚形态）与代码复核。写明「未能改坏验证」即可，不得删断言。
7. 【新 e2e 分片】`scripts/e2e.d/75-order-deadlock.sh`：在 e2e 上下文里调用 `scripts/stress-order-deadlock.sh` 跑第 4 条的 a–g（可把 ROUNDS 保持原值；总耗时 ≤ 3 分钟），逐场景 `assert_eq "75.x RESULT" "$(tail -1 <<<"$OUT")" "RESULT 50001=0 invariant_bad=0"`、`assert_eq "75.x 退出码" "$RC" "0"`、f 场景额外断言 `success=15`、`42201=15`；结束前软删本段创建的全部商品（`DELETE /api/admin/products/:id`），本段变量一律 `S75_` 前缀。
8. 【干净库全量 e2e】先在 BASE 跑一次取本机基线红清单，再在修复后跑：`TZ=Asia/Shanghai DB_NAME=food_shop_dlk BASE=http://localhost:3142 bash scripts/e2e.sh > <日志> 2>&1` → 末行 `失败 0`（已知偶发清单之外的红即失败）；`grep '74.11' <日志>` 全 ✔（74.11 a–g 用的是 raw SQL 会话模拟旧形态，**一条断言都不改**）；`grep '75\.' <日志>` 全 ✔；e2e 期间服务端日志 `grep -c '下单遇死锁'` → 0（74.11 里 PUT 侧的「改库存遇死锁」照旧允许出现）。
9. 【文档】`grep -c '扣减之前先 `INSERT order_items`' docs/api.md` → 0（旧锁序描述已改）；`grep -n '并发语义' docs/api.md` 能在 `#### POST /api/orders` 段落下找到本批新增小节；`products.ts:314-337` 注释里不再说「下单事务先 INSERT order_items 取 S 锁」。
10. 【范围】`git diff 1dbe010 --name-only` 只落在「授权范围」内；`git status` 干净（除本方案文件由规划者写入外，执行者不得改 `docs/superpowers/plans/`）。

## 实现方向

1. **新工具 `apps/server/src/utils/deadlock-retry.ts`**：`isDeadlockError(e): boolean`（`PrismaClientKnownRequestError && code==='P2034'`）与 `withDeadlockRetry<T>(label: string, fn: () => Promise<T>, opts?: { attempts?: number; baseDelayMs?: number }): Promise<T>`（默认 5 / 50；重试前 `console.warn(\`[${label}] 下单遇死锁，重试 ${attempt}/${attempts}\`)`——日志文案固定为「下单遇死锁」，验收 5/6/8 靠它计数；间隔 `baseDelayMs × attempt + Math.random()*30`；最后一次仍 P2034 → 原样 rethrow）。**不改** `products.ts` 现有的 `isDeadlockRetry`/循环（本批不扩 blast radius，留后统一）。
2. **下单事务重排 `apps/server/src/routes/orders.ts:570-661`**（只动这一段）：
   - `allocateOrderNo()` 留在循环外（复用同一个号）。
   - 事务体顺序改为：
     1. 汇总 `stockLines`（付费行 + 赠品行，形状不变）→ 按 `skuId` 聚合数量（同 sku 出现两次求和，label 取第一条）→ **按 skuId 升序**逐条 `productSku.updateMany({ where: { id, stock: { gte: qty } }, data: { stock: { decrement: qty } } })`，count 0 → `AppError(42201, \`${label} 库存不足，请刷新重试\`)`（文案逐字不变）。
     2. 按 `productId` 聚合（数量求和；`conditional = 该商品任一行 skuId == null`）→ **按 productId 升序**每商品一条：无规格商品 `product.updateMany({ where: { id, stock: { gte: qty } }, data: { stock: { decrement: qty }, salesCount: { increment: qty } } })` count 0 → 42201；有规格商品 `product.update({ where: { id }, data: { stock: { decrement: qty }, salesCount: { increment: qty } } })`（与 BASE 一样不带条件，sku 判定是权威）。
     3. `if (pointsUsed > 0) await tx.$queryRaw\`SELECT id FROM users WHERE id = ${userId} FOR UPDATE\``。
     4. `tx.order.create({... items: { create: [...] } })`（原样）。
     5. `applyOrderBenefits(...)`、`cart.deleteMany`（原样）。
   - 把现有的 `.catch(P2002 → 赢家)` 改成循环内 try/catch：`for attempt in 1..5 { try { order = await prisma.$transaction(..., { timeout: 15000 }); break } catch (e) { if (P2002 且 target 含 client_request_id) { winner → break（找不到赢家则 throw e）} ; if (isDeadlockError(e) && attempt < 5) { warn; sleep; continue } ; throw e } }`。用第 1 步的 `withDeadlockRetry` 包 `$transaction` 也行，但 P2002 分支必须在重试判断**之前**且不重试。
   - 事务上方那段「⚠️ 显式 timeout / 单号在事务外先取」注释保留，追加一段锁序说明（引用本文件 §0.4）。
   - 行为差异（允许、写进回报）：多行都缺货时 42201 报的是 **skuId 最小**的那一行而不是 lines 里最靠前的那一行；文案模板不变。
3. **`apps/server/src/utils/order-stock.ts`**：`rollbackOrderStock` 改成两段——先把 `items` 中 `skuId != null` 的按 skuId 升序、按 sku 聚合数量后逐条 `productSku.updateMany({ where: { id }, data: { stock: { increment } } })`（sku 已删则 0 行，语义不变）；再按 productId 升序、按商品聚合后逐条 `product.update({ stock: { increment }, salesCount: { decrement } })`（`productId == null` 跳过，语义不变）。函数签名与 `RollbackItem` 不变，7 个调用点（orders.ts ×3、admin/orders.ts ×2、scheduler.ts、refund.ts）不用动。注释写明「锁序 L1→L2，见 plans/2026-09-24-order-deadlock.md §0.4」。
4. **注释/文档同步**（只改文字）：`apps/server/src/routes/admin/products.ts:314-337` 第 1/3/5/6 点改为新事实（下单事务已先扣 sku→product 再插 order_items，与本接口同序不成环；74.11-c/e 的 raw SQL 形态仍是本接口重试的有效测试）；`docs/api.md` `#### POST /api/orders`（:371 段落）新增「并发语义」小节（锁序、P2034 重试 ≤5、5 次后行为按用户决定填写、42201 语义不变）；`docs/api.md:791` 与 `:2314` 两处把「下单事务在扣减之前先 `INSERT order_items` …同一规格的单笔订单也会与这个接口互锁」改为「2026-09-24 起下单事务改为先扣减再插行，与本接口同序；本接口保留重试是为整包编辑商品/未来路径兜底」。
5. **`scripts/stress-order-deadlock.sh`（新，从编排者 `stress.sh` 移植）**：
   - 参数 `BASE DB_NAME NORD ROUNDS NPUT MULTI STOCK SAMEUSER OUT`；MySQL 用 `docker exec -i food-shop-mysql mysql --default-character-set=utf8mb4 -N -ufoodshop_user -pfoodshop_password "$DB_NAME"`（与 `e2e.sh:1723` 同账号，不用 root）；不再硬编码 root 密码。
   - `SAMEUSER=1`：只登录 1 个用户、建 1 个地址，NORD 个并发槽都用它（不传 clientRequestId，是 NORD 笔不同订单）。
   - MULTI 模式加购前先 `GET /api/cart` 并逐条 `DELETE /api/cart/:id` 清空该用户购物车（基线里第 2 轮出现的 `40001 购物车商品不存在` 是上一轮失败残留导致，修复后不该出现，但脚本要自洽）。
   - 末尾除 `RESULT 50001=… invariant_bad=…` 外，再输出 `SUMMARY success=<n> e42201=<n> other=<n>`；`other>0 || 50001>0 || invariant_bad=1 || orders_in_db!=success` → `exit 1`。
   - 头部注释写清用法与 7 个标准场景。
6. **`scripts/e2e.d/75-order-deadlock.sh`（新）**：复用 `req/ok/fail/assert_eq/sql/$AT/$BASE/$DB_NAME`；`OUT=$(BASE=$BASE DB_NAME=$DB_NAME NORD=… bash "$(dirname "${BASH_SOURCE[0]}")/../stress-order-deadlock.sh" 2>&1); RC=$?` 逐场景断言（验收 7）；收尾软删本段商品。分片开头注释说明为什么放在 74 之后（74 已复位 low-stock 设置）以及预计耗时。
7. **环境（执行者照抄）**：
   ```bash
   docker exec -i food-shop-mysql mysql -uroot -pfoodshop_root_password -e "DROP DATABASE IF EXISTS food_shop_dlk; CREATE DATABASE food_shop_dlk CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON food_shop_dlk.* TO 'foodshop_user'@'%'; FLUSH PRIVILEGES;"
   export DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_dlk"
   export JWT_SECRET=e2e_jwt_secret_0123456789 ADMIN_JWT_SECRET=e2e_admin_secret_0123456789
   (cd apps/server && npx prisma migrate deploy && npx prisma db seed)
   # 起服务（run_in_background，记下 PID 写到 scratchpad/server.pid；日志落 scratchpad/server-dlk.log）
   cd apps/server && TZ=Asia/Shanghai PORT=3142 WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true WECHAT_QRCODE_MOCK=true \
     LOCAL_DELIVERY_PROVIDER_MOCK=true EXPRESS_PROVIDER_MOCK=true PRINTER_PROVIDER_MOCK=true SCHEDULER_DISABLED=true \
     npx ts-node-dev --respawn --transpile-only src/app.ts
   ```
   压测/改坏矩阵可以复用同一个库（脚本每次自建商品与用户）；全量 e2e 前把库重建一次。基线红清单：先在 BASE 代码上跑一次全量 e2e（同库同配方）。

## 授权范围

```
apps/server/src/routes/orders.ts
apps/server/src/utils/order-stock.ts
apps/server/src/utils/deadlock-retry.ts
apps/server/src/routes/admin/products.ts        （只允许改 :314-337 注释文字，不得改任何语句）
docs/api.md
scripts/stress-order-deadlock.sh
scripts/e2e.d/75-order-deadlock.sh
```

## 禁止修改

```
apps/server/prisma/**
apps/server/src/services/**                      （含 member/checkout.ts、member/points.ts、refund.ts、scheduler.ts、order-no.ts）
apps/server/src/routes/admin/orders.ts
apps/server/src/routes/admin/system.ts
apps/server/src/middlewares/**
apps/server/src/routes/orders.ts 里 :570-661 之外的部分（取消/秒退/退款/详情等分支一行不动）
apps/server/src/routes/admin/products.ts 里 :314-337 之外的部分
scripts/e2e.sh
scripts/e2e.d/*（75 以外的全部分片，74.11 的断言一条不放宽）
apps/admin/**
apps/miniapp/**
docs/superpowers/**                              （本方案文件只有规划者/裁决者写）
.agent/**
package.json / apps/*/package.json / 任何 lock 文件
```

## 上报条件

- 修复后的 7 个压测场景任一出现 50001、非 {0,42201} 的 code、`invariant_bad=1`、或成功响应数 ≠ 落库订单数，且重跑一次仍如此。
- 验收 5/8 的「下单遇死锁」计数不为 0（说明还有本方案没覆盖的环，附 `SHOW ENGINE INNODB STATUS` 的 LATEST DETECTED DEADLOCK 段）。
- 改坏矩阵 K1 拿不到「日志 > 0」或 K3 拿不到红（压测形态失效，需重新规划改坏验证）。
- 74.11 任一条变红且重跑仍红。
- 干净库全量 e2e 出现已知偶发清单之外的红且重跑仍红。
- 完成第 2 步需要改动 :570-661 之外的 `orders.ts`、或需要改 `services/**`（如 `applyOrderBenefits` 签名不够用）。
- `npx tsc` 报与本批无关的 Prisma 类型错，且 `node_modules` 不是私有目录（是软链）——停下等，不要 generate。
- 端口 3142 或库 `food_shop_dlk` 被占用。
- 单条命令超过 10 分钟无输出；全量 e2e 超过 25 分钟。
- 白名单外改动需求。

## 待用户决定

1. **重试 5 次仍死锁时给顾客什么**（涉及顾客文案与错误码语义；修复后此路径预期不可达，验收 5 要求日志计数为 0）：
   - A（默认，代码不改）：维持原样上抛 → HTTP 500 / `50001 服务器内部错误` + 企微「接口 500」告警；小程序已映射为「系统开小差了，请稍后再试」。好处：真发生时店主立刻知道有结构性问题。
   - B：抛 `AppError(4220x, '下单的人太多，请稍后再试')`（HTTP 400，无告警）。文案更友好，但没人会收到通知。
   - C：B 的文案 + 仍推企微告警（需要在 `errorHandler` 之外单独调 `notifySystemAlert`，`services/**` 在禁改名单内，要扩授权范围）。
   执行者在用户未答复前按 A（不写额外代码），并在回报里注明；编排者合并前确认。

## 留后（不在本批，交编排者登记）

- `routes/admin/products.ts:404-490` 整包编辑商品的 sku 锁序按请求体顺序、无重试：与多规格并发下单反序时可成环，下单侧有重试兜住、后台侧会得到 50001；改法是 sku 按 id 升序处理 + 复用 `deadlock-retry.ts`。
- `products.ts` 的 `isDeadlockRetry`/循环与新 `deadlock-retry.ts` 重复，下一批统一。
- 同一用户并发下单**带积分**的 S→X 形态（§0.1 第 3 组探针）本批用 `FOR UPDATE users` 结构性堵住，但没有 e2e 用例（需造积分与赠品数据，成本高于收益）；若将来加，形态是「同用户、两笔各带 1 份赠品、并发提交」。

---

## 修订 1（2026-09-24，L 级复核第 1 轮 R1–R6 裁决；HEAD ac2f800）

【工序】裁决 【模型】Fable 5.1 【等级】L

### R0 亲自核实（§3.2；全部在 `food_shop_dl` 用两条 mysql 会话 / node 探针复现，探针行已删、行值已核对回原值）

| 探针 | 形态 | 结果 |
|---|---|---|
| R1-a | A：`UPDATE product_skus`→SLEEP 2s→`UPDATE products`；B（0.5s 后）：`INSERT carts(user_id,product_id,sku_id)` | **A `ERROR 1213`**，B done |
| R1-b | A 反过来 `UPDATE products`→SLEEP→`UPDATE product_skus`；B 同上 | A done，B done（不成环） |
| R1-c | B 改成事务 `FOR SHARE sku → FOR SHARE products → INSERT carts → COMMIT`；A 同 R1-a | A done，B done（**对齐后不成环**） |
| R2 | node/Prisma：`productSku.updateMany`→sleep 1s→`$queryRaw SELECT … users FOR UPDATE`；mysql 会话先真改 users 行 3 次再等 sku | 两次都 `class= PrismaClientKnownRequestError code= P2010 meta= {"code":"1213",…} isP2034= false` |
| scan_logs | A：`X(products)`→SLEEP→`X(users)`，B：`INSERT scan_logs` → 都 done；A：`X(users)`→SLEEP→`X(products)` → **A 1213** | `scan_logs` 外键校验顺序 = products S → users S（与 L2→L3 同向，安全） |
| carts DDL | `SHOW CREATE TABLE carts`：二级索引顺序 `(user_id,product_id,sku_id)` 唯一键 → `product_id` fkey → `sku_id` fkey | 外键校验按二级索引插入顺序：users S → products S → product_skus S，与 L1→L2→L3 **两处反向**（sku/products 反、users 早于 products） |
| R4 | `git show 1dbe010:…/categories.ts:103-106`：`for i … tx.product.update({ where:{ id: ids[i] } })` 按请求体顺序 | 属实 |
| R5 | `git diff 1dbe010`：`orders.ts:13` 新 import、`:563` 注释；BASE `products.ts:338` 是第 6 点 | 属实 |
| R6 | `stress-order-deadlock.sh:47` `PUT /settings/shipping`，无还原；`GET /api/admin/settings/shipping` 存在（`settings.ts:35`，返回 `{fee,freeThreshold,minOrderAmount}`，与 PUT 的 schema 同形） | 属实 |
| 执行者 e2e 的 1 次「下单遇死锁」 | `exec/server-dlk-fixed.log:289-291`：紧跟 74.11 的两条「改库存遇死锁」之后、`categories.delete`（e2e.sh §11 清理）之前，区间覆盖 74.11→75 全部 | 来源**未决**（无 INNODB STATUS），但与 R1 机制一致：75.c/d 里 20 个用户并发 `POST /api/cart` 与他人下单同一 sku |

### R1：成立（规划缺口）
依据：R1-a/R1-c 探针 + carts DDL；复核者 HTTP 复现（`cart-vs-order.sh`：修复后 NORD=1 NCART=40 ROUNDS=30 → 订单 30/30、加购 1200/1200 成功、`下单遇死锁` +34；BASE 同参数 → 加购 196×50001）。
处理：加购是**每个顾客的常规路径**，不是后台低频操作，让它每次都靠死锁重试兜住，晚高峰热菜会出现「每单先死锁一次再成功」，重试 5 次穿透率不可忽略；正确做法是把加购的锁序对齐到 L1→L2→L3。这需要改 `routes/cart.ts`（现授权外）→ **待用户决定 #2**，两个选项的实现与验收都写在下面，执行者按用户选定的选项做；选项 A 为推荐。

- **选项 A（推荐）：对齐加购锁序**（授权范围 + `apps/server/src/routes/cart.ts`，只允许改 `POST /` 的新建分支 `:126-129` 及其注释）。把 `prisma.cart.create` 换成一个交互式事务，事务内**先**按全局锁序拿共享锁再插行：
  ```ts
  cart = await prisma.$transaction(async (tx) => {
    if (skuId) await tx.$queryRaw`SELECT id FROM product_skus WHERE id = ${skuId} FOR SHARE`
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId} FOR SHARE`
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR SHARE`
    return tx.cart.create({ data: { userId, productId, skuId: skuId ?? null, quantity, isSelected: 1 } })
  })
  ```
  三把都是 S 锁：加购之间互不阻塞；与下单/回滚/改库存的 X 锁只会**排队**不会成环（R1-c 探针）。合并分支 `cart.update`（`:125`）只改 quantity、不碰外键列，不锁父行，**不动**。不包 `withDeadlockRetry`（它的日志文案固定是「下单遇死锁」，会污染计数；对齐后加购也没有已知的环）。
- **选项 B：不改 cart.ts，承认「加购 vs 下单」是重试常规路径**。代码不动；验收把 c/d/h 的「下单遇死锁 == 0」换成「50001 == 0 且 `grep -c '下单遇死锁，重试 [3-5]/5'` == 0」（任何一单都不需要第 3 次尝试），a/b/e/f/g 维持 == 0；`docs/api.md` 并发语义小节写明「与加购并发时下单事务会作为牺牲者重试一次，属正常路径」。这不是更强的判据——它是在 BASE 的 carts 外键校验顺序下**唯一为真的不变量**；原方案的 c/d「== 0」在这个顺序下本来就不成立，是规划缺口。

两个选项共同的验收增补（写进 `stress-order-deadlock.sh` 与 e2e 75）：
- 新参数 `NCART`（默认 0）：另起 NCART 个用户，每轮与 NORD 个下单并发地对**同一 sku** `POST /api/cart` 后立刻 `DELETE /api/cart/:id`（复核者 `cart-vs-order.sh` 的形态）；输出 `== carts result codes ==`，非 0 即红。
- 场景 **h** `NORD=10 NCART=10 ROUNDS=10` → 100 订单 success、100 加购 success、`RESULT 50001=0 invariant_bad=0`；e2e 75 加 75.h。
- 选项 A 下 h 的服务端日志 `grep -c '下单遇死锁'` **== 0**（a–h 全部 == 0，比原方案多覆盖一个场景，**严格更强**）；**改坏 K5**：去掉 cart.ts 的三句 `FOR SHARE`，跑 `NORD=2 NCART=40 ROUNDS=30` → `下单遇死锁` **> 0**（复核者同形态实测 +34），订单/加购仍全成功（重试兜住）。
- 选项 B 下 h：`50001 == 0`、`grep -c '下单遇死锁，重试 [3-5]/5' == 0`，并把 `grep -c '下单遇死锁'` 的实际值贴进回报。

### R2：成立（需改）
依据：R2 探针两次都 `P2010 / meta.code "1213"`，`isDeadlockError` 恒 false → 不重试 → 50001。`products.ts:375` 的 `FOR UPDATE` 是那个事务的**第一把锁**，持锁为零时不可能被选为牺牲者，所以本缺陷只影响 `orders.ts` 的 `FOR UPDATE users`（它前面已持 sku/products 的 X 锁）。
处理（授权内，`apps/server/src/utils/deadlock-retry.ts`）：`isDeadlockError` 改为
```ts
if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false
if (e.code === 'P2034') return true
return e.code === 'P2010' && String((e.meta as { code?: unknown } | undefined)?.code ?? '') === '1213'
```
注释写明 P2010 是 `$queryRaw/$executeRaw` 的错误包装、`meta.code` 是 MySQL 错误号字符串。不换掉 raw `FOR UPDATE`（Prisma 没有等价的锁定读；用 `user.update` 伪写会多写一行 `updated_at`）。
验收增补（执行者在 scratchpad 写一个 node 探针，形态照复核者 `raw-victim.js`：`withDeadlockRetry('orders', () => prisma.$transaction(tx => { productSku.updateMany(增量 0) → sleep 1s → $queryRaw FOR UPDATE users → throw 'ROLLBACK-ON-PURPOSE' }))`，并发一条 mysql 会话 `BEGIN; UPDATE users 真改 3 次; SLEEP(0.3); UPDATE product_skus 同一行; COMMIT`，脚本用 `NODE_PATH=<worktree>/node_modules`、`DATABASE_URL` 指向本批库）：
- 修复后 → 探针输出 `attempts=2`、最终错误是 `ROLLBACK-ON-PURPOSE`（第 2 次尝试走到了 throw），服务端无关；日志（stdout）出现一次「下单遇死锁，重试 1/5」。
- 改坏 K6（把 P2010 分支去掉）→ `attempts=1`、`code=P2010`。
把两次输出贴进回报。若探针两次都没打出死锁（牺牲者选到了 mysql 会话），按上面「mysql 会话多改几行」的做法加大对方 undo 再跑，不得改成断言宽松。

### R3：成立（随 R1 改文字）
依据：`docs/api.md:391` 「预期在本接口自身的并发场景下不会触发」被 R1 否定；`:794` 「本接口自身与另一次本接口调用之间…触发普通锁等待/死锁」——两次 PUT 都是 X(sku_i)→X(P)，同向只排队，「/死锁」三个字不成立。
处理：`:391` 按用户选的选项改写（A：「与加购、取消/退款回滚、改库存并发时只排队不成环，重试兜的是整包编辑商品等未对齐路径」；B：「与加购并发时本事务会作为牺牲者重试，属正常路径，重试不超过 2 次」）；`:794` 「普通锁等待/死锁」→「普通锁等待（同向，不成环）」；附录 N `:2317` 同步一句。

### R4：成立（规划缺口）
依据：`categories.ts:103-106` 按请求体顺序逐个 `product.update`，与多商品订单的 products 升序反向；§0.2 把它记成「只 X(products)」漏了多行。
处理：**待用户决定 #3**。选项 A：扩授权 `apps/server/src/routes/admin/categories.ts`（只允许改 `:103-106`），改成按商品 id 升序更新：`[...ids.entries()].sort((a, b) => a[1] - b[1])` 后逐个 `update({ where: { id }, data: { sortOrder: i } })`（`sortOrder` 仍取该 id 在请求体里的下标，语义不变）；验收：`scripts/e2e.d/65-product-sort.sh`（4 处 `product-order` 断言）全绿即可，不另做并发验收（店员拖拽排序是低频操作）。选项 B：登记留后，订单侧由重试兜住、店员侧维持 BASE 既有的 50001 风险。推荐 A（三行改动、有既有 e2e 覆盖）。

### R5：成立（追认）
依据：见 R0。`orders.ts:13` 的 import 与 `:563` 那行步骤注释是完成第 2 步的必要改动，原方案「只动 :570-661」写得过窄；`products.ts` 第 6 点在 BASE `:338`，原方案「:314-337」少数了一行。
处理：授权范围改为 `orders.ts` 的 `:13`（import 行）与 `:560-707`（改后行号；即「// 5. 事务」注释起到 `.catch` 结束、`success(...)` 之前）、`products.ts:314-338`（注释）。已提交的改动**不需要回退或重做**。

### R6：成立（建议级，采纳）
处理：`stress-order-deadlock.sh` 开头 `S_ORIG=$(req GET /api/admin/settings/shipping "$AT" | jq -c .data)`，结束（含 `exit 1` 的路径，用 `trap`）`req PUT /api/admin/settings/shipping "$AT" "$S_ORIG"`；e2e 内前后值相同，无影响。

### 全仓核查：对 products / product_skus / users 有外键的子表插入，与多行 products 更新（复核者要求的第 3 项）

`information_schema.KEY_COLUMN_USAGE`（`food_shop_dlr`）里引用这三张表的外键只有 9 条；外键校验顺序 = 该表二级索引的插入顺序（carts/scan_logs 两组探针印证）。

| 子表 / 路径 | 校验/加锁顺序 | 与 L1→L2→L3 关系 | 处理 |
|---|---|---|---|
| `carts` 插入（`routes/cart.ts:127`） | users S → products S → product_skus S | **反向两处** | **本批**（R1 选项 A）或承认重试（选项 B） |
| `order_items` 插入（下单） | orders S（自己的新行）→ products S | 已持 X，覆盖 | 已修 |
| `orders` 插入（下单） | users S | pointsUsed>0 时已持 X；否则只 S | 已修 |
| `scan_logs` 插入（`routes/scan-logs.ts:32`，单条语句、不在事务里） | products S → users S | 同向（L2→L3）；单条插入持锁为零时才等，不会成环 | 无需处理（探针已证） |
| `addresses` 插入（`routes/addresses.ts:62`） | users S | 单父表、单条语句 | 无需处理 |
| `points_ledgers` 插入 | users S | 全部在已持 X(users) 之后（`consumePoints`/`releaseOrderBenefits`/`deductPointsOnRefund`）；**例外** `settlePoints`（`points.ts:274`）先插账本行（users S）再 `user.update`（`:286`，S→X 自升级）——两笔同用户的结算并发会互锁；对方（下单/取消）等待中的 X 请求不挡它（74.11-f 印证的规则），所以只在「结算 vs 结算」成环 | **留后**：`services/**` 禁改；`pointsSettledAt=null` 会被兜底扫描重扫，自愈 |
| `user_coupons` 插入（`coupons.ts:60`） | coupon_templates S → users S | 事务首句 `FOR UPDATE templates`；无人持 X(users) 再要 templates | 无需处理 |
| `product_images` / `product_skus` 插入（`admin/products.ts:428,458`，整包编辑） | products S（先于本事务后面的 sku X、products X） | **本事务自身 S→X 升级** + sku 按请求体顺序 | **留后**（已登记；BASE 同样存在；正确改法：事务首句按 sku id 升序 `FOR UPDATE` 全部 sku 再 `FOR UPDATE` 商品行，然后才动图片/规格） |
| `categories.ts:103-106` 多行 `product.update` | 请求体顺序 | 与多商品订单可反向 | **本批**（R4 选项 A）或留后 |
| `product-channel.ts:68`、`admin/products.ts:261`、`admin/orders.ts:703` 的 `updateMany({ id: { in } })` | 单条 UPDATE，InnoDB 按主键升序扫描加锁 | 同向 | 无需处理 |
| `auth.ts:56,64` `user.update(lastLoginAt)` | 单条语句 X(users) | 持锁为零、只会短暂阻塞别人 | 无需处理 |
| `assertNoUnpaidAndPurgeCarts` / `cart.deleteMany` / `tx.cart.deleteMany`（下单末尾） | 子表删除不锁父行 | — | 无需处理 |

结论：本批需要处理的只有 carts（R1）与分类排序（R4）；其余要么同向、要么是单条语句、要么已登记留后且有自愈/兜底。

### 验收修订（在原「验收标准」之上；不放宽任何既有判据）
- 第 4 条：场景表增 **h**（见 R1）；`SUMMARY` 增 `carts=<n>`。
- 第 5 条：选项 A → a–h **全部** `下单遇死锁 == 0`、`P2034 == 0`、`P2010 == 0`；选项 B → a/b/e/f/g == 0，c/d/h 按 R1 选项 B 的判据。
- 第 6 条：增 K5（R1 选项 A 时）、K6（R2）。
- 第 7 条：e2e 75 增 75.h；选项 A 下 e2e 全程服务端日志 `grep -c '下单遇死锁' == 0`（第 8 条同步）。
- 新增第 11 条【R2 探针】：见 R2 的两次输出。
- 新增第 12 条【R4 选项 A 时】：`grep '65\.' <e2e 日志>` 全 ✔。
- 第 9 条追加：`grep -c '普通锁等待/死锁' docs/api.md` → 0。

### 授权范围增减
- 增：`apps/server/src/routes/cart.ts`（仅 `POST /` 新建分支 `:126-129` 及注释；**用户选 R1-A 才生效**）；`apps/server/src/routes/admin/categories.ts`（仅 `:103-106`；**用户选 R4-A 才生效**）。
- 改：`apps/server/src/routes/orders.ts` 允许 `:13` 与 `:560-707`；`apps/server/src/routes/admin/products.ts` 允许 `:314-338` 注释。
- 禁止修改清单相应放开上述行；其余不变。`scripts/e2e.d/74-low-stock.sh` 仍一条不改。

### 上报条件增补
- 选项 A 实施后场景 h 或 K5 的 `下单遇死锁` 计数不符合预期（h ≠ 0 或 K5 = 0）。
- R2 探针无法在 3 次内让 node 侧成为牺牲者。
- 选项 A 让 e2e 里任何加购断言（`api/cart` 相关，含 §5/§6/§62/§63 等既有段）变红。

### 待用户决定（本修订新增；#1 维持原样）
2. **R1 加购锁序**：A 扩授权改 `routes/cart.ts` 新建分支（推荐；加购多 3 条共享锁定读、一层事务，顾客无感；下单不再与加购互锁，「下单遇死锁 == 0」对全部场景成立）／ B 不改，承认加购与下单互锁靠重试消化（验收按 R1-B 判据；晚高峰热菜每单可能先死锁一次）。
3. **R4 分类排序锁序**：A 扩授权改 `admin/categories.ts:103-106` 按 id 升序（推荐；三行，e2e 65 覆盖）／ B 留后（店员拖拽时偶发 50001，与 BASE 相同）。
