# 三方复核发现 · 修复实施计划（2026-09-05）

> **输入**：`docs/superpowers/notes/2026-09-05-review-findings.md`（7 BLOCKER / 11 HIGH / 17 MEDIUM，已逐条核实）。
> **本文档性质**：规划文档，只排批次、定顺序、写验收；不改任何 `apps/`、`scripts/` 代码。
> **For agentic workers**：每组用 superpowers:subagent-driven-development 逐任务执行；执行用 **sonnet**，复核用 **opus**（PO 定的分工）。
> 组内任务用 checkbox（`- [ ]`）追踪。

---

## 0. 硬约束（执行方必须遵守，违反即打回）

| # | 约束 | 备注 |
|---|---|---|
| C1 | **禁止 `git push`** | GitHub 账号挂起，本地即源 |
| C2 | 状态推进一律 `updateMany({ where: { id, <状态守卫> }, data })` 再判 `count` | 不要「先读后写」 |
| C3 | 幂等靠唯一索引；捕 P2002 后用 `findUnique` 取回既有行 | **不要解析 `err.meta.target`** |
| C4 | 迁移必须 additive（只加表 / 加可空列 / 加带默认值的列） | 生产 `orders` 14 行、`users` 6 行真实数据；**全部计划只允许一条新迁移**（见 S 组），其他组发现还要加列就停下来报告，不许自己再加第二条 |
| C5 | 所有出站 `fetch` 带 `AbortSignal.timeout(...)` | 新加的 `Open_delPrinterSqs` 也一样 |
| C6 | 所有 worktree **共用**主仓库的 `node_modules/.prisma` | **各组不许自己跑 `prisma generate`**；S 组合入后由集成方生成一次，之后所有组的 `tsc --noEmit` 都基于这一份。**e2e 验证必须串行**（见 §6） |
| C7 | 提交信息中文、`type(scope): 摘要`，结尾 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` | |
| C8 | e2e 新增用例**不要往 `scripts/e2e.sh` 尾部追加**，改为新建 `scripts/e2e.d/NN-<组名>.sh`（S 组负责在 e2e.sh 的「11. 清理」之前加一个 `source` 循环） | 五个组都要加用例，同一个文件尾部会连环冲突。**只有 D 组允许改 `e2e.sh` 本体**（改 §35 既有断言） |
| C9 | 不重新审查、不质疑发现是否成立 | 只按本计划修；修法要偏离清单的，在 §7 已经列出的范围内偏离，超出的先报告 |

e2e 基线：**620 / 0**（端口 3105、库 `food_shop_audit`、`.claude/launch.json` 的 `api-3105`）。
每组合入后：`BASE=http://localhost:3105 DB_NAME=food_shop_audit bash scripts/e2e.sh` 通过数**必须上升、失败保持 0**。

---

## 1. 分组总览

按**文件不重叠**切分，各组可并行派给不同 agent；同一文件只归一个组。S 组是所有组的前置，必须先合入。

| 组 | 名称 | 编号 | 要碰的文件 | 文件数 | 档位 | 何时 |
|---|---|---|---|---|---|---|
| **S** | schema 底座 | B5 列、M1 列、M8 键、H8 注释、C8 的 source 循环 | `apps/server/prisma/schema.prisma`、`apps/server/prisma/migrations/20260907000000_review_fixes/migration.sql`、`scripts/e2e.sh`（仅加 source 循环）、`scripts/e2e.d/.gitkeep` | 4 | 执行 sonnet / 复核 opus | **第一个**，其他组都从它之后分支 |
| **A** | 退款 × 积分 | B7, H1, B5, B1, H7, M16, M5, M13, (M15 随 B5 消失) | `apps/server/src/services/member/points.ts`、`apps/server/src/services/refund.ts`、`scripts/e2e.d/40-points-refund.sh` | 3 | 执行 sonnet / 复核 **opus（必须）** | 部署前 |
| **B** | 会员默认值 | B3 | `apps/server/src/services/member/settings.ts`、`scripts/e2e.d/41-member-defaults.sh` | 2 | 执行 sonnet / 复核 opus | 部署前 |
| **C** | 领券并发 | B4, M7, M6 | `apps/server/src/services/member/coupons.ts`、`apps/server/src/routes/member.ts`、`scripts/e2e.d/42-coupon-concurrency.sh` | 3 | 执行 sonnet / 复核 opus | 部署前 |
| **D** | 出票核心 | H2, B6(+M14), H4(+M9), H6, M1, M2, M8, M10, M4(一半), M3, M12 | `apps/server/src/services/ticket/index.ts`、`ticket/content.ts`、`ticket/printer.ts`、`ticket/mock.ts`、`ticket/feie.ts`（仅 M10）、`apps/server/src/services/printer-settings.ts`、`apps/server/src/services/order-notify.ts`（仅 M3）、`apps/server/src/routes/admin/printer.ts`（mock 钩子）、`apps/server/src/routes/orders.ts`（仅 :539）、`apps/server/src/routes/admin/delivery.ts`（仅 reject）、`scripts/e2e.sh` §35 | 11 | 执行 sonnet / 复核 **opus（必须）** | H2/B6/H4/H6 部署前；M 系列可延后但同组做 |
| **D2** | 离线语义 | H5, H5b, M11, M4(另一半) | 与 D 同一批文件（`ticket/index.ts`、`printer.ts`、`feie.ts`、`mock.ts`、`routes/admin/printer.ts`）+ `scripts/e2e.d/45-printer-offline.sh` | 6 | 执行 sonnet / 复核 opus | **⚠️ 等实验 E1 出结果；且必须排在 D 合入之后**（同文件） |
| **F** | 支付回调 | H3 + 删除 `wechat-notify.ts:312` 被 B1 取代的冗余出票 | `apps/server/src/routes/wechat-notify.ts` | 1 | 执行 sonnet / 复核 opus | 部署前；**合入顺序在 A 之后**（语义依赖 B1，文件不冲突） |
| **G** | 部署与文档 | B2, H10, H8(脚本), M17 | `scripts/deploy.sh`、`docs/deployment.md`、`scripts/check-points-consistency.mjs`、`docs/api.md` | 4 | 执行 sonnet（M17 可 haiku）/ 复核 opus | B2/H10 部署前；M17 随时 |
| **H** | 定时任务 | H9 | `apps/server/src/services/scheduler.ts`、`apps/server/src/routes/admin/system.ts`（加 e2e override）、`scripts/e2e.d/43-daily-task-loop.sh` | 3 | 执行 sonnet / 复核 opus | 部署前 |

**文件归属冲突检查**（已逐一核过）：
- `services/refund.ts` → 只归 A。B1 与 B5 都在 A 内串行做。
- `services/ticket/index.ts` → 只归 D（D2 在 D 合入之后接手）。
- `services/member/points.ts` → 只归 A。
- `services/ticket/content.ts` → 只归 D（H2 与 H6/M12 都要动它，所以 H2 不能单独成组）。
- `routes/wechat-notify.ts` → 只归 F。**A 组的 B1 不碰这个文件**，:312 那条由 F 删。
- `routes/orders.ts` → 只归 D（H6 改 :539）。A 组的 B1 **不碰** :625 自助取消那条（dedupe 让它成为无害的提前出票）。
- `routes/admin/orders.ts`、`routes/admin/after-sales.ts` → **没人碰**。:367 拒单 / :461 人工补记两条保留（前者比 B1 更早出票，后者绕过了 `finalizeRefundSuccess`，B1 覆盖不到）。
- `schema.prisma` → 只归 S。后续组可以改注释但**不许加迁移**。
- `routes/admin/system.ts` → 只归 H。printer-mock 钩子在 `routes/admin/printer.ts`（`admin/index.ts:39` 挂到 `/system/printer-mock`），归 D。
- `scripts/e2e.sh` 本体 → S 加一处 source 循环；之后只有 D 改 §35。

---

## 2. 关键路径与依赖

```
S（迁移 + prisma generate 一次）
 ├─► A（B7 → H1 → B5 → B1 → H7/M16 → M5 → M13）──► F（H3 + 删 :312）
 ├─► B（B3）
 ├─► C（B4 → M7 → M6）
 ├─► D（H2 → B6/M14 → H4/M9 → M1 → M2 → M8 → H6 → M10 → M4½ → M3 → M12）──► D2（H5/H5b/M11/M4½）◄── 实验 E1
 ├─► H（H9）
 └─► G（B2 → H10 → H8 → M17）           （G 不依赖 S，但也没必要抢跑）
```

**卡住其他所有事的三条**：
1. **S 组**——A 的 B5、D 的 M1/M8 都要它的列；C6 规定 prisma generate 只做一次，所以没 S 谁也没法 `tsc`。
2. **A 组**——最长、最容易出错、且 F 的语义依赖它。A 一天做不完，整体就一天上不了。
3. **实验 E1**——D2 的方向由它决定，见 §2.1。E1 不做，H5/H5b/M11 只能空着。

### 2.1 ⚠️ H5 与 H5b 依赖实验 E1，**实验没结果前不许开工**

**实验 E1（PO 在店里做，本会话用 scratchpad 脚本调接口）**：
PO **拔掉打印机电源**（FP-V58-WHC 是 4G+WiFi 双通道，拔网线会自动切 4G，不构成离线）→ 用 `Open_queryPrinterStatus` 确认飞鹅侧已显示「离线。」→ 下发一张测试票，**记录 `Open_printMsg` 的 `ret` 与 `data`** → PO 通电 → 观察是否自动吐纸，并用 `Open_queryOrderState` 查那张票。

| E1 结果 | 含义 | D2 的修法方向 |
|---|---|---|
| **甲：离线时 `ret≠0`（下发失败）** | 我们这边的「重试 → FAILED → 恢复补打」模型成立 | H5 按清单修（补打只看 bad→good，不看 `alerted`；`pm2 restart` 后首轮 `healthTrack` 空也要能补）；H5b 实现 `clearQueue(sn)` 但只作恢复前的保险调用 |
| **乙：离线时 `ret=0` 且通电后自动吐纸（云端排队）** | PrintJob 走 SENT 而非 FAILED，H5 描述的整条路径**在真实世界不会发生** | 真正要做的是：① 下发前查 `queryStatus`，OFFLINE 则**不下发**、记 PENDING 等恢复（这才是规格「离线期间记 PENDING」的原意）；② 恢复时先调 `Open_delPrinterSqs` 清飞鹅云端队列，再只补发 30 分钟内的 PENDING/SENT-未确认作业；③ M4 的 SENT 终止规则要把「离线期间的 SENT」视为正常而非僵尸 |

**两种结果下都要做的**：`Printer` 接口加 `clearQueue(sn): Promise<void>`，`feie.ts` 实现 `Open_delPrinterSqs`（带 `AbortSignal.timeout`），`mock.ts` 实现为清 jobs。
**实验 E4**（真机用「退款」Tab 退一分钱，看 `Refund.wxResponseData.status`）只影响 B1 是「100% 复现」还是「概率」，**不改 B1 修法**，不阻塞 A 组。

### 2.2 部署前 / 部署后

| 必须在部署前修完 | 可以留到部署后（但要有归属） |
|---|---|
| S；A 的 B7/H1/B5/B1/H7；B；C 的 B4；D 的 H2/B6/H4/H6；F；G 的 B2/H10；H | A 的 M5/M13/M16；C 的 M7/M6；D 的 M1/M2/M8/M10/M3/M4/M12；G 的 H8/M17；**D2 整组**（前提：打印机开关默认 `enabled:false`，D2 必须在**店主打开打印机开关之前**完成，不是在部署之前） |

> 这里「部署」指把这批代码推到 162.14.114.95。`deploy.sh`（B2）改完要**一并传到生产机 `/home/ubuntu/deploy.sh`**，因为生产机跑的是部署前那一版。

---

## 3. 各组任务（含组内顺序与验收）

### S 组 · schema 底座（先做，独占）

**为什么合并成一条迁移**：B5 要 `Order.pointsBase`，M1 要 `PrintJob.copies`。C4 只允许一条。

- [ ] **S1** `schema.prisma`：
  - `Order` 加 `pointsBase Int? @map("points_base")`，注释「结算时用于算分的基数 = actualAmount − refundedAmount(结算时刻)；退款扣回按 pointsEarned × 退款额 / pointsBase 摊，与 earnRatePerYuan 无关。null = 该单在本列上线前结算（退化用 actualAmount）」。
  - `PrintJob` 加 `copies Int @default(1)`，注释「入队时从 PrinterEntry.copies 快照，重试/补打/手动重试一律读本列」。
  - `PrintJob.status` 注释追加 `SENDING`（B6 认领态，D 组使用）；`kind` 注释追加 `CANCEL_REQUEST | RESUME`（H6，D 组使用）。
  - **H8 注释**：`User.pointsBalance` 的注释改成「== Σ 入账行 remaining（**不带**到期过滤；到期行由 expirePoints 清零时等量 decrement）」。
- [ ] **S2** 迁移 `20260907000000_review_fixes/migration.sql`，**只有两条 ALTER**：
  ```sql
  ALTER TABLE `orders` ADD COLUMN `points_base` INTEGER NULL;
  ALTER TABLE `print_jobs` ADD COLUMN `copies` INTEGER NOT NULL DEFAULT 1;
  ```
  **不要**把 `dedupe_key` 加宽——M8 改用 SN 的 sha1 前 10 位入键（见 D 组），64 字符够用，不动列。
- [ ] **S3** `scripts/e2e.sh`：在 `echo "== 11. 清理 =="`（现 :1684）之前插入
  ```bash
  for f in "$(dirname "$0")"/e2e.d/*.sh; do [[ -f "$f" ]] && source "$f"; done
  ```
  并建 `scripts/e2e.d/.gitkeep`。
- [ ] **S4** 集成方（不是各组）执行：`npx prisma generate`（一次）→ 对 `food_shop_audit` 跑 `prisma migrate deploy` → 重启 `api-3105` → 跑 e2e，**预期 620 / 0 不变**。

**验收**：`prisma migrate diff` 与 schema 一致；e2e 620/0；迁移文件里只有 ALTER ADD COLUMN。
**档位**：执行 sonnet；复核 opus（10 分钟，重点核 S2 是否 additive、S1 注释是否与 H8 一致）。

---

### A 组 · 退款 × 积分（关键路径，opus 复核必须）

组内顺序**不能换**：B7 一行先落（最小、独立）；H1 把 `settlePoints` 的订单读进事务，B5 要在这个事务里写 `pointsBase`；B1 最后，因为它改 `finalizeRefundSuccess` 的返回结构。

- [ ] **A1 · B7** `extendLivePoints` 的 `where` 加 `expiresAt: { gt: now, lt: expiresAt }`，续期单调只增。
  **并且**（见 §7-2 的分歧）：`settlePoints` 计算目标到期日时取 `max(completedAt + validDays, 当前在世行最大 expiresAt)`，新建的 EARN 行也用这个值——否则「补发旧单」会留下一条比全账户早几天到期的行，破坏「全部积分同一天过期」（H7/M16 与协议文案的前提）。
- [ ] **A2 · H1** `settlePoints` 把订单读挪进 `$transaction`，第一句 `SELECT ... FROM orders WHERE id=? FOR UPDATE`（`tx.$queryRaw`），再读字段判断 `status/isTest/pointsSettledAt`；`earn` 用锁后读到的 `refundedAmount` 算。锁顺序：`orders → points_ledgers → users`，与 `finalizeRefundSuccess`（`UPDATE orders` 先持行锁，再动 ledger/users）一致，不会死锁。earn≤0 分支同样进事务。
- [ ] **A3 · B5** 
  - `settlePoints` 在同一事务里写 `pointsBase = actualAmount − refundedAmount`（锁后值）。
  - `deductPointsOnRefund` 改用**累计**公式（见 §7-1，比清单里的逐笔 floor 更稳）：
    ```
    base   = order.pointsBase ?? order.actualAmount           // 旧单退化
    cumRef = max(0, order.refundedAmount + base − order.actualAmount)   // 结算之后累计退了多少
    targetCum = base > 0 ? floor(pointsEarned × cumRef / base) : pointsEarned
    deduct = max(0, min(targetCum − alreadyDeducted, pointsEarned − alreadyDeducted, balance))
    ```
    `order.refundedAmount` 用 `finalizeRefundSuccess` 里 `UPDATE ... LEAST(...)` 之后重读的值（已经是这样）。
  - **删掉** `deductPointsOnRefund` 里的 `getMemberSettings()` 调用与 `calcRefundDeduct` 的 `ratePerYuan` 参数——公式已与比例无关，**M15 随之消失**。
  - `refund.ts:320-324` 传入 `pointsBase`、`actualAmount`、`refundedAmount`（`RefundDeductOrder` 接口扩三个字段）。
- [ ] **A4 · B1** `finalizeRefundSuccess`：事务内把 `:302` 的 `updateMany` 结果记为 `flippedToRefunded = moved.count === 1`，随返回值带出；事务提交后（在 `:329` 那段 fire-and-forget 旁边）`if (flippedToRefunded) enqueueOrderTicket(orderId, 'CANCEL').catch(log)`。
  - **必须在事务外**：`enqueueOrderTicket` 用全局 `prisma` 且会做最长 10s 的外呼，放事务内等于抱着行锁打飞鹅。
  - `refund.ts` 新增 `import { enqueueOrderTicket } from './ticket'`——已核：`ticket/index.ts` 不反向依赖 `refund.ts`，无循环。
  - 不改任何调用点。`wechat-notify.ts:312` 由 F 组删；`admin/orders.ts:367/:461`、`orders.ts:625` 保留。
- [ ] **A5 · H7 + M16** `getPointsSummary`：`balance` 改为实算 `Σ remaining WHERE type IN (EARN,GIFT_REVERT) AND remaining>0 AND expiresAt>now`；同一查询顺带返回 `pointsExpireAt = max(expiresAt)`（账户级到期日，M4 常驻文案用）。`routes/member.ts` **不改**（A 不拥有它）——`PointsSummary` 多一个字段，路由等 M4 需要时再透传；本组只保证服务层返回。
- [ ] **A6 · M5** `deductFromEarnRows`：两处查询都加 `expiresAt: { gt: now }`；`own` 行也只在活着时才优先扣。
- [ ] **A7 · M13** `expirePointsBatch` 的 CAS `where` 补 `expiresAt: { lt: now }`。
- [ ] **A8** e2e `scripts/e2e.d/40-points-refund.sh`（复用 §36 的 `m1_login`/`m1_completed_order`/`sql`；本段开头自己 PUT 一次会员设置 `enabled:true, rate:1`，结尾还原）：

| 编号 | 用例 | 断言 |
|---|---|---|
| B7-1 | 用户 A 完成订单 A1（今天）→ settle；再 `sql` 造订单 A0：`completed_at = NOW()-6 DAY, points_settled_at=NULL`，跑 `run-scheduler {settleMissedPointsAfterMin:0}` | A1 那行 `expires_at` **不变**（与补发前相等）；A0 新建的 EARN 行 `expires_at == A1 行的 expires_at`（同一天，A1 的 max 变体） |
| B7-2 | PUT 会员设置 `validDays:90` → 用户 A 再完成一单 | 旧行 `expires_at` 仍是原值（≈+365），**没有被拉到 +90**；新行 `expires_at == max(now+90, 旧值)`；`GET /member/summary` 的 `balance` = 三单之和 |
| B5-1 | 用户 B 完成 ¥100 单 → settle（rate=1，得 100 分）→ PUT rate=100 → 部分退 ¥1 | `REFUND_DEDUCT` 流水 `delta == -1`（不是 -100）；`points_balance == 99` |
| B5-2 | 同一单再退 ¥33、¥33、¥33（分三次，总额打满） | 三次累计扣回 == 100（累计公式在最后一次把零头补齐；逐笔 floor 会剩 1 分） |
| B5-3 | 用户 C 完成 ¥100 单，**settle 之前**先部分退 ¥40，再 settle | `points_base == 6000`、`points_earned == 60`；随后退剩下 ¥60 → 累计扣回恰好 60 |
| H1-1 | （串行替代，竞争在 bash 里复现不了）B5-3 已覆盖「退款先于结算」的账面一致性；另加：settle 后 `sql` 直接 `UPDATE orders SET refunded_amount` 不经退款流程 → 再跑 `settleMissedPoints` | `pointsSettledAt` 已置位的单不重发（流水条数不变） |
| B1-1 | 打印开、`printCancel:true`；订单 PREPARING → `POST /admin/orders/:id/refund` 全额（mock 同步 SUCCESS） | 该单 `print_jobs` 里 `kind=CANCEL` **恰好 1 条** |
| B1-2 | 售后路径：SHIPPED → 顾客申请售后 → 后台同意全额 | `kind=CANCEL` 1 条 |
| B1-3 | 部分退款（不打满） | `kind=CANCEL` **0 条** |
| B1-4 | 顾客自助取消（`orders.ts:625` 先出票，再 mock 秒退触发 B1） | `kind=CANCEL` 仍 **恰好 1 条**（dedupe 生效，无重复） |
| H7-1 | `sql` 把用户 D 一条在世行 `expires_at` 改成昨天（不跑 expire 任务） | `/member/summary.pointsBalance` 已排除它；`POST /points/redeem` 若余额不足返回 42250，与显示一致；跑 `expirePoints` 后 `pointsBalance` **不变** |
| M5-1 | 用户 E 有一条昨天到期未清扫的 EARN 行 + 一条在世行 → 退款扣回 | 扣的是在世行（到期行 `remaining` 不变） |
| M13-1 | 无法在 bash 里造亚秒竞争，验收 = opus 复核确认 `where` 含 `expiresAt lt now` | — |

跑完 `node scripts/check-points-consistency.mjs`（G 组改好之前它会因为带到期过滤而误报——本组验收时**用不带过滤的 SQL 手查**：`SELECT u.id, u.points_balance, COALESCE(SUM(l.remaining),0) FROM users u LEFT JOIN points_ledgers l ON ... WHERE type IN ('EARN','GIFT_REVERT') GROUP BY u.id HAVING ...`，必须 0 行）。

**验收**：上表全绿；e2e 通过数 ≥ 基线 + 14，失败 0；opus 复核重点：A2 的锁顺序、A3 的公式边界（`base=0`、旧单 `pointsBase=null`）、A4 的 enqueue 在事务外。

---

### B 组 · 会员默认值（B3）

两件事分开提交，commit message 也分开——一条是纠错，一条是产品决定：

- [ ] **B-1 · 纠错** `DEFAULT_MEMBER_SETTINGS.points.earnRatePerYuan: 1 → 100`（与 spec :217、`docs/member-terms-copy.md` 对齐）。`sanitize` 的 `intInRange(…, 1, 100, …)` 与 `routes/admin/settings.ts:50` 的 `max(100)` 已经容得下 100，不用动。
  commit：`fix(member): 默认每元得分改为 100，与定稿对齐`
- [ ] **B-2 · 产品决定** `enabled: true → false`（PO 2026-09-05 认可）。`CONSERVATIVE_FALLBACK` 与之同值，注释说明「上线默认关，由店主在 M3 设置页显式打开；即使打开，比例也必须是 100」。
  commit：`feat(member): 积分发放默认关闭（PO 认可，M3 设置页显式打开）`
- [ ] **B-3** e2e `scripts/e2e.d/41-member-defaults.sh`：
  - 缓存 60s TTL 且没有清缓存的路由，**不能靠删 `settings` 行再 GET 来验默认值**。改为源码级断言：`(cd apps/server && npx ts-node --transpile-only -e "const s=require('./src/services/member/settings');const d=s.DEFAULT_MEMBER_SETTINGS.points;if(d.enabled!==false||d.earnRatePerYuan!==100||d.validDays!==365)process.exit(1)")`，退出码 0 记 ok。
  - 行为断言：新用户完成一单前，本段先 PUT `enabled:false`，settle 后 `points_ledgers` 无该单流水且 `points_settled_at` **仍为 NULL**（关着的时候 `settlePoints` 在 `enabled` 判断处直接 return，不落锁——这保证以后打开开关时 7 天内的单还能补发）。
  - 复位：还原本段开头 GET 到的原值。
- [ ] **B-4** 检查 §36 的既有断言是否依赖默认值：已核 `:1405`、`:1570` 都显式 PUT 了 `rate:1`，`:1680` 用 GET 到的原值还原，**不依赖默认**。若集成后 §36 变红，先查这里。

**验收**：e2e +3，失败 0。**档位**：sonnet 执行；opus 复核 5 分钟。

---

### C 组 · 领券并发（B4、M7、M6）

- [ ] **C1 · B4** `claimCampaign` 与 `redeemByPoints` 事务第一句 `await tx.$queryRaw\`SELECT id FROM coupon_templates WHERE id = ${templateId} FOR UPDATE\``，然后才 `findUnique` 模板、`count` 已领数、递增、发券。MySQL RR 下 `FOR UPDATE` 读最新已提交行，`count` 看到的是串行化后的值。`redeemByPoints` 还要保持「先发券再 `consumePoints`」的既有顺序。
- [ ] **C2 · M7** `redeemByPoints` 补 `totalLimit` 的 `updateMany` 条件递增（照 `claimCampaign` 的写法），`count===0` → 42253。
- [ ] **C3 · M6** `routes/member.ts` 两个 POST 的响应改用 GET 侧同一份白名单函数（`id/code/name/amount/threshold/channel/status/source/expiresAt/usedAt`）。白名单函数若在 `coupons.ts` 里，导出复用；不要在路由里再抄一份。
- [ ] **C4** e2e `scripts/e2e.d/42-coupon-concurrency.sh`：

| 编号 | 用例 | 断言 |
|---|---|---|
| B4-1 | 建 CAMPAIGN 模板 `perUserLimit:1, totalLimit:null`；**同一用户** 5 个并发 `POST /coupons/claim`（`&` + `wait`，限流 20/分钟容得下） | 恰好 1 个 `code=0`、4 个 `42253`；`sql COUNT(*) FROM user_coupons WHERE user_id=? AND template_id=?` == 1 |
| B4-2 | 建 POINTS 模板 `perUserLimit:1, pointsCost:10`；给用户 100 分；同一用户 5 个并发 `POST /points/redeem` | 1 成 4 败；`points_balance == 90`（只扣一次）；`user_coupons` 1 条 |
| B4-3 | 既有的两用户 `totalLimit` 用例（`e2e.sh:1591`）保持绿 | — |
| M7-1 | POINTS 模板 `totalLimit:1`，两个用户各兑一次 | 第二个 42253；`issued_count == 1` |
| M6-1 | 两个 POST 的响应 | `jq 'has("issuedBy") or has("remark") or has("sourceRef") or has("templateId")'` == false |

**验收**：e2e +6，失败 0。opus 复核：`FOR UPDATE` 是否在事务**第一句**（放在 `findUnique` 之后就白锁了）。

---

### D 组 · 出票核心（opus 复核必须）

组内顺序有讲究：H2 最小先落；B6 改 `attemptSend` 的状态机，H4/M1/M2/M14 都碰同一个函数，紧跟着做；M8 改 dedupeKey 格式，H6 依赖它（新 kind + 新 seq 语义）；M 系列最后。

- [ ] **D1 · H2** `content.ts` 加 `esc = (s) => s.replace(/[<>]/g, '')`，所有插值的顾客/商家可控字符串（`remark`、`receiverName/Phone/PoiName/Detail/District/FullAddress`、`productName/specText`、打印机 `name`）经过它。**不要**替换成全角——直接剥掉，票面更干净。
- [ ] **D2 · B6 + M14** `attemptSend` 开头先认领：`updateMany({ where: { id, status: 'PENDING' }, data: { status: 'SENDING' } })`，`count===0` 直接返回；成功写 `where: { id, status: 'SENDING' }` → SENT；`handleSendFailure` 的守卫与写回都改成 `SENDING`（失败 → 回 PENDING 或 FAILED），`attempts` 改 `{ increment: 1 }`（M14）。
  - **孤儿回收**：进程在 SENDING 中被杀会留下永远不被扫的行。`processQueue` 开头加一步：`SENDING` 且 `updatedAt < now − (TIMEOUT_MS + 5s)` 的行 → `updateMany` 回 PENDING（`lastError = 'SENDING:ORPHANED'`）。
  - **同 SN 串行 + ≥300ms**（规格 §8b）：`index.ts` 加一个 `Map<sn, Promise<void>>` 的进程内链，`attemptSend` 对同 SN 排队；间隔只对 `FEIE` provider 生效（mock 设 0，不拖慢 e2e）。
  - 三处调用（`enqueueOrderTicket`、`retryPrintJob`、`enqueuePrinterTestJob`）自动受益，不用各改。
- [ ] **D3 · H4 + M9** `processQueue` 的 PENDING 循环包 try/catch；`getProvider` 挪进 `attemptSend` 的 try 内（抛出按 CONFIG 走 `handleSendFailure`）。`printer-settings.ts`：`validatePrinterSettings` 对 `provider !== 'FEIE'` 报「该打印平台尚未支持」；`sanitize` 保持原样（让校验有机会看到用户到底选了什么）。M9：`getPrinterSettings` 读库失败时**抛出**而不是返回默认值——由 `enqueueOrderTicket` 捕获后落一条 `SKIPPED`（`lastError='CONFIG:SETTINGS_UNREADABLE'`，dedupeKey 带 `|skip` 后缀，见 D5）+ 告警；其他调用方（`healthCheck`、`repeatAnnounce`）自己 try/catch 按「本轮跳过」处理。
- [ ] **D4 · M1 + M2** `enqueueOrderTicket` 建行时写 `copies: printer.copies`；`attemptSend` 签名去掉 `copies` 参数，从行上读；`:256/:457/:571` 三处硬编码 `1` 删除。M2：`processQueue` 的退避索引改 `retryDelaysMs[job.attempts − 1]`（attempts=1 等 5s、=2 等 30s、=3 已 FAILED）；`MAX_ATTEMPTS` 语义核对：规格是「失败按 5s/30s/2min 重试 3 次后 FAILED」= 首发 + 3 次重试 = 4 次发送，现在是 3 次，改 `shouldFail = attempts > retryDelaysMs.length`。e2e `retry-delays [50,50,50]` 那段的 attempts 断言要跟着改。
- [ ] **D5 · M8** `buildDedupeKey(orderId, kind, seq, sn)` → `${orderId}|${kind}|${seq}|${sha1(sn).slice(0,10)}`（最长 10+1+14+1+13+1+10 = 50 < 64，不用加宽列）；SKIPPED 留痕行的 key 加 `|skip` 后缀，让它不再占真实作业的槽位。`enqueuePrinterTestJob` 的 key 同步改。
- [ ] **D6 · H6** 
  - `printer.ts` 的 `PrintJobKind` 加 `'CANCEL_REQUEST' | 'RESUME'`；`content.ts` 加 `renderCancelRequestTicket`（标题「顾客申请取消」，正文「待店员确认，请暂停制作」）与 `renderResumeTicket`（标题「取消申请已驳回」，正文「请继续制作」）；`renderForKind` 分发。三种取消类票都受 `printCancel` 开关管。
  - `routes/orders.ts:539` 改 `enqueueOrderTicket(id, 'CANCEL_REQUEST', { seq: cancelRequestedAt.getTime() })`——**seq 不能是 0**：驳回后 `cancelRequestedAt` 被清空，顾客可以再申请，第二次也要能出票。
  - `routes/admin/delivery.ts` 的 `cancel-request/reject` 成功后 `enqueueOrderTicket(id, 'RESUME', { seq: Date.now() })`（fire-and-forget）。
  - 真正的 `CANCEL` 保持 `seq=0`，槽位由 A4 的 B1 与既有三处共用。
- [ ] **D7 · M10** `feie.ts:_mapFeieError`：CONFIG 只认确定的 `ret` 码（已确认 1002；其余按官方文档补，**没查到的不猜**）与「打印机不存在/未绑定」关键字；`签名/USER/UKEY/账号` 从 CONFIG 关键字里**移除**（时钟漂移会命中）。这几类落到 BUSINESS 走重试，不会永久失去补打资格。
- [ ] **D8 · M4（D 组这一半）** SENT 确认循环：单轮上限 `BATCH` 改 20；`queryJob` 返回「订单不存在/1001」类错误或 `sentAt` 超过 24h → `updateMany` 写 `lastError='CONFIRM:GAVE_UP'`，查询条件加 `lastError: null`，僵尸行不再占批。另一半（离线期间 SENT 的语义）归 D2。
- [ ] **D9 · M3** `handleSendFailure` 在 `shouldFail && kind==='NEW_ORDER'` 时调 `order-notify.ts` 新加的 `notifyPrintFailed(order, items)`（文案含商品与地址，前缀「打印失败，已改为推送」）。`retryRecoveredPrinterJobs` 补打成功不撤回，无所谓。
- [ ] **D10 · M12** `toTicketInput` 的 `seq` 改为当日流水：`count(orders WHERE paidAt >= 今天 0 点 AND paidAt <= 本单 paidAt AND isTest=false AND status NOT IN (PENDING_PAYMENT, CANCELLED))`；REPEAT 票面同时打「今日第 N 单」与「第 K 次催单」（`waitedMin` 之外再传 `announceNo`）。
- [ ] **D11 · mock 钩子**（`ticket/mock.ts` + `routes/admin/printer.ts`）：`POST /system/printer-mock/delay { sn, ms }`（让 `print()` 睡 ms 毫秒）、`GET /system/printer-mock/jobs?sn=`（暴露 `_listMockJobs`）。B6 的复现用例靠它们。
- [ ] **D12** e2e（改 `e2e.sh` §35 本体，允许）：

| 编号 | 用例 | 断言 |
|---|---|---|
| H2-1 | 下单时 `remark: "<CUT>前置切纸<QR>x</QR>"`，mock 支付 | `print_jobs.content` 里 `<CUT>` 出现次数 == 1（只有末尾那个）、不含 `<QR>`；`<CB>备注：` 后面紧跟 `前置切纸x` |
| B6-1 | `printer-mock/delay {sn:E2E-P1, ms:1500}` → 后台 `&` 发起 mock 支付 → `sleep 0.3` → `run-scheduler`（processQueue）→ `wait` → `sleep 1.5` | `printer-mock/jobs?sn=E2E-P1` 中含该订单号的作业 **恰好 1 条**；该 PrintJob `status=SENT, attempts` 与只发一次一致；**不能只是「没报错」**，必须数 mock 收到的作业数 |
| B6-2 | 同一 FAILED 作业两个并发 `POST /print-jobs/:id/retry` | 一个 `ok`、一个 `CONCURRENT`；mock 作业只多 1 条 |
| B6-3 | `sql` 造一条 `status='SENDING', updated_at=NOW()-1 MINUTE` 的行 → `run-scheduler` | 行回到 PENDING 并被发出（最终 SENT） |
| H4-1 | `PUT /settings/printer {provider:'XPYUN',…}` | 返回校验错误（40001 类），设置未写入 |
| H4-2 | `sql` 插一条 `provider='XPYUN'` 的 PENDING 脏行 + 正常下一单 → `run-scheduler` | 脏行 FAILED（`lastError` 以 `CONFIG:` 开头）；正常单 SENT；`run-scheduler` 响应里 `printQueueSweep` 是数字不是缺失 |
| M1-1 | 打印机 `copies:2`，造单后让首发失败（`printer-mock/fail CAPACITY`）→ 重试成功 | mock 作业 `copies == 2`；`print_jobs.copies == 2` |
| M2-1 | 既有「重试耗尽」用例 | `attempts` 终值 == 4（首发+3 重试）而不是 3；`retry-delays` 断言按新索引调整 |
| M8-1 | 两台打印机 A、B 都在 LOCAL 渠道，下单出票后**解绑 A**，再对同单 `reprint` | B 的 REPRINT 正常落库（旧实现下标漂移会撞键跳过） |
| M8-2 | 渠道无打印机 → SKIPPED；随后配上打印机再 `reprint` | 新 PENDING 行落库成功，不被 SKIPPED 行的 key 挡住 |
| H6-1 | 改既有 `:1355` 断言：cancel-request 后 | `kind=CANCEL_REQUEST` 1 条、`kind=CANCEL` 0 条 |
| H6-2 | 驳回（`/local/orders/:id/cancel-request/reject`） | `kind=RESUME` 1 条；顾客再次 cancel-request → `CANCEL_REQUEST` 变 2 条 |
| H6-3 | 上单最后真被退款（B1 路径） | `kind=CANCEL` 1 条（槽位没被申请占掉） |
| M10-1 | `printer-mock/fail BUSINESS "签名错误"` | 行进入退避重试而不是立即 FAILED（`attempts=1, status=PENDING`） |
| M4-1 | `sql` 把一条 SENT 行 `sent_at` 改到 25h 前 → 两轮 `run-scheduler` | 第一轮后 `lastError='CONFIRM:GAVE_UP'`，第二轮不再被查（mock 计数不增） |
| M12-1 | 同一天连下两单 | 第二单票面含「今日第 2 单」；REPEAT 票含「第 1 次催单」 |

**验收**：e2e ≥ 基线 + 20，失败 0；opus 复核重点：D2 的状态机每条路径的守卫（PENDING→SENDING→SENT/PENDING/FAILED，加孤儿回收）、D5 的 key 长度、D6 的 seq 选择、D3 的 M9 抛出不会把 `wechat-notify` 的回调应答打挂（`enqueueOrderTicket` 是 async，同步抛也只是 rejected promise，调用点都有 `.catch`——已在清单「排除项」里核过，但 M9 改了抛出点，要再看一眼）。

---

### D2 组 · 离线语义（⚠️ 等 E1，且在 D 合入后）

- [ ] **D2-0** 拿到 E1 结果（甲/乙），在本组的第一个 commit message 里写明依据。
- [ ] **D2-1** `printer.ts` 加 `clearQueue(sn)`；`feie.ts` 实现 `Open_delPrinterSqs`（`AbortSignal.timeout`）；`mock.ts` 清 jobs；`routes/admin/printer.ts` 加 `POST /printers/:sn/clear-queue`（后台 M3 页用得上）。
- [ ] **D2-2（甲）** H5：`printerHealthTask` 补打条件改「上一轮 bad、本轮 good」，`healthTrack` 里没记录（重启后首轮）也视为可能刚恢复 → 跑一次 `retryRecoveredPrinterJobs`（它自己有 30 分钟窗口，多跑无害）。恢复前先 `clearQueue`。
- [ ] **D2-2（乙）** `attemptSend` 前 `queryStatus`，OFFLINE → 不下发、保持 PENDING、`lastError='OFFLINE:WAIT'`、不占 `attempts`；恢复时 `clearQueue` → 只补发 `createdAt > now−30min` 的 PENDING/SENT-未确认行，更旧的写 `FAILED lastError='STALE:DROPPED'`（不告警）。M4 的 24h 放弃规则对 `OFFLINE` 期间的 SENT 行不生效。
- [ ] **D2-3 · M11** TIMEOUT 最多重试 1 次（不是 3 次），第二次仍超时 → FAILED + 告警文案「可能已打印，请查看打印机」。乙情况下更保守：TIMEOUT 后先 `queryStatus`，在线才重试。
- [ ] **D2-4** e2e `scripts/e2e.d/45-printer-offline.sh`：mock 增加「OFFLINE 时 print 返回成功但不出纸、恢复后一次性吐出」的乙模式开关；两种模式各写「离线 4 分钟（低于告警阈值）→ 恢复 → 该单最终 SENT 且 mock 只收到 1 条」「30 分钟前的旧单不补」「`healthTrack` 清空后恢复仍补打」三条。

**验收**：e2e ≥ +8，失败 0。opus 复核：与 D8 的 M4 规则不打架。

---

### F 组 · 支付回调（H3）

- [ ] **F1** `wechat-notify.ts:222-242`：`enqueueOrderTicket(orderId,'NEW_ORDER')` 从 `.then()` 里挪出来，紧跟在 `lateCancelled` 早退之后**单独起一条 promise 链**（照 `orders.ts:758` mock 路径的写法与注释）；`:242` 的 `.catch(() => undefined)` 改成 `console.error('[wechat-notify] 付款后通知失败:', err)`；`sendPaidSubscribeMessage` 与 `notifyOrderPaid` 各自包 try/catch（两个都是同步 void，其中一个抛不该吞掉另一个）。
- [ ] **F2** 删掉 `:305-314` 退款回调里的 `CANCEL` 出票（B1 已下沉进 `finalizeRefundSuccess`，这里留着只是死代码；注释同步删）。
- [ ] **F3** 验收：e2e 走的是 mock 支付，不经这个 handler。验收 = ① `tsc --noEmit` 过；② opus 复核对照 `orders.ts:748-760` 的结构；③ 若 `wechat-pay-verify.ts` 的 mock 验签模式能在 e2e 里构造回调（`pay.verifyMode` 字段存在，说明有双模式），补一条「回调 → 该单 `NEW_ORDER` 1 条」；构造不了就写在报告里，不硬凑。

**档位**：sonnet 执行 30 分钟；opus 复核 10 分钟。**合入顺序在 A 之后**（F2 删的那条在 B1 落地前不能删）。

---

### G 组 · 部署与文档（B2、H10、H8、M17）

- [ ] **G1 · B2** `deploy.sh:172-176` else 分支：
  ```bash
  LATEST_MIG=$(ls -d prisma/migrations/*/ | sort | tail -1)
  NEW_TABLES=$(grep -o 'CREATE TABLE `[^`]*`' "${LATEST_MIG}migration.sql" | sed 's/CREATE TABLE //' | paste -sd, -)
  ```
  空则打印「本次迁移不建表，② 跳过」。**删除**硬编码的 `delivery_events, deliveries, print_jobs` 与「本轮同城上线」文案。本次的 `20260907000000_review_fixes` 不建表，所以生成结果应为空——这正是 B2 要修的场景。
  改完**同步到生产机 `/home/ubuntu/deploy.sh`**（写进 `docs/deployment.md` 的部署清单，作为本次部署的第 0 步）。
- [ ] **G2 · H10** `docs/deployment.md` §四 加「飞鹅云打印」一节：`FEIE_USER`、`FEIE_UKEY`、`FEIE_API_BASE=https://api.feieyun.cn`（国内站，2026-09-05 真机核实；**不是** `api.de.feieyun.com`），用 `set-env.sh` 填；说明缺失时的症状（`CONFIG:MISSING_CONFIG` 直接 FAILED、bind 返回 42240）。部署清单加一行勾选。
- [ ] **G3 · H8** `check-points-consistency.mjs:29` 去掉 `and l.expires_at > now()`；另加一列 `liveSum`（带过滤）作 informational 输出，不参与判红。头注释改写。
- [ ] **G4 · M17** `docs/api.md`：删附录 D「已知缺口（拒单不出票）」段（`cb27694` 已作废）；附录 E 钩子表删 `autoCompleteShippedOrders` 那行（不存在）；「退款扣回…靠微信回调重试补」改为「与退款同事务，扣回失败整笔回滚并抛错；`refund-complete` 人工路径无微信重试」。附录 D 顺带补 `CANCEL_REQUEST/RESUME` 两种 kind 与 `SENDING` 状态（D 组定稿后再写，G4 可以最后做）。
- [ ] **G5** 验收：`bash -n scripts/deploy.sh`；在本地 `cd apps/server` 跑 G1 那两行，输出为空串且脚本不报错；再对 `20260906000000_member_points_coupon` 跑一次，输出 `` `points_ledgers`,`coupon_templates`,`user_coupons`,`points_goods` ``。H8：对 `food_shop_audit` 跑脚本，A 组合入后应为 ✔（合入前如果有到期未清扫行会 ✘——那是旧判据的误报，正是 H8 要修的）。

**档位**：sonnet；M17 可 haiku；opus 复核 B2 那段 shell。

---

### H 组 · 定时任务（H9）

- [ ] **H1** `scheduler.ts:runMemberDailyTask`：循环 `fn()` 直到返回值 `< limit` 或 `=== 0`，总轮数上限 50（10000 行/天封顶，防打死）；全部跑完才 `patchCronState`。`expirePointsBatch`/`expireCouponsBatch` 的 `limit` 通过 `SchedulerOverrides.dailyTaskBatchLimit` 可注入（e2e 用小值）。
- [ ] **H2** `routes/admin/system.ts` 的 `run-scheduler` 解析 `dailyTaskBatchLimit`。
- [ ] **H3** e2e `scripts/e2e.d/43-daily-task-loop.sh`：给一个用户 `sql` 插 5 条 `expires_at = 昨天` 的 EARN 行（`remaining=10`，`points_balance` 同步 +50）；`run-scheduler {forceDailyMemberTasks:true, dailyTaskBatchLimit:2}` **一次** → 5 条全部 `remaining=0`、`points_balance` 回落 50、`EXPIRE` 流水 5 条；再跑一次 → 0 条处理（`lastExpirePointsAt` 只写了一次，看 `member_cron_state`）。
- [ ] **H4** 注意 `expirePointsBatch` 对单行异常是 `catch` 后继续、不计入 `count`——若某批全是坏行会返回 0，循环按 `=== 0` 退出，不会空转到 50 轮。

**验收**：e2e +4，失败 0。sonnet 执行 / opus 复核。

---

## 4. 验收总表（必须补的 e2e 与「怎么才算过」）

| 编号 | 必补用例 | 为什么以前漏 | 过的标准 |
|---|---|---|---|
| B4 | **同一用户**并发领 / 兑（C 组 B4-1/2） | 既有并发用例测 `totalLimit` 且用**两个用户** | 1 成 N−1 败 + DB 行数 1 + 余额只扣一次 |
| B6 | mock 延迟 + 立即发送与兜扫同时命中（D 组 B6-1） | 既有用例只看「状态没写坏」，纸出了几张没人数 | **数 mock 收到的作业数 == 1**，不是「跑一遍没报错」 |
| B7 | 补发 6 天前旧单（A 组 B7-1）+ 调短 validDays（B7-2） | 既有续期用例只测「往后推」 | 旧行 `expires_at` **不变**（不往前拽）；新行与账户同日 |
| B5 | rate 变更后退款（B5-1）、三笔部分退款打满（B5-2）、结算前先退（B5-3） | 既有退款扣分用例 rate 恒为 1 | 扣分与 rate 无关；累计恰好 == pointsEarned |
| B1 | 后台退款 Tab 全额（B1-1）/ 售后同意（B1-2）/ 部分不出（B1-3）/ 自助取消不重复（B1-4） | 既有 CANCEL 用例只覆盖自助取消、拒单、cancel-request | 每条 `kind=CANCEL` 计数精确 |
| H6 | cancel-request 独立 kind、驳回出 RESUME、之后真取消仍出 CANCEL（D 组 H6-1/2/3） | 既有 `:1355` 把「申请」当「取消」断言 | 三种 kind 各自计数 |
| H4 | XPYUN 脏行不瘫痪队列（H4-2） | 无 | 脏行 FAILED、后续正常 |
| H7 | 到期未清扫行不计入 summary（H7-1） | 无 | summary 与 redeem 一致 |
| H9 | 5 行 / 批 2 一次跑完（H 组 H3） | 无 | 一轮 tick 全部处理，cron state 只写一次 |
| H1 | 竞争在 bash 复现不了 | — | 串行替代用例 + opus 确认 `FOR UPDATE` |
| M13 | 同上 | — | opus 确认 CAS where |

---

## 5. 风险与顺序陷阱

1. **B6 修好后 M14 自然消失**——但仍按清单改成 `increment`，因为认领态失败回写时读-改-写的窗口虽然关了，`increment` 更短。
2. **B1 下沉后 H6 的槽位问题变形**：原来 cancel-request 占 `CANCEL|0` 挡住真取消；改成独立 kind 之后 `CANCEL|0` 只剩四个来源（B1、自助取消 :625、拒单 :367、人工补记 :461），全部 seq=0 互相 dedupe，**这是期望行为**，不要给它们各自分 seq。
3. **B1 与 `admin/orders.ts:461`**：人工补记路径自己在事务里写 `Refund.status='SUCCESS'`，**不经** `finalizeRefundSuccess`，所以 B1 覆盖不到它——:461 必须保留。复核方若建议「B1 之后所有调用点都删」，是错的。
4. **B5 修好后 M15 自然消失**（`deductPointsOnRefund` 不再读设置）。A3 做完要把 `calcRefundDeduct` 的签名连同 `settings` 一起删干净，别留一个不用的参数。
5. **H1 的 `FOR UPDATE` 与 `settleMissedPoints` 的 `take: BATCH`**：兜底任务串行 `await settlePoints(id)`，每个自己开事务，锁粒度是单行，不会一次锁一批。但 `runSchedulerTick` 的 `running` 标志在这 100 个事务期间持有——现有行为，不是新引入。
6. **M8 改 dedupeKey 格式**是**破坏性**的：旧格式的行（e2e 库里有）与新格式的行对同一 `(orderId,kind,seq)` 不再互斥。生产 `print_jobs` 是空表，无影响；`food_shop_audit` 建议 D 组合入前 `TRUNCATE print_jobs`（写进验证步骤）。
7. **D2 的 M2 改了 `MAX_ATTEMPTS` 语义**（3 → 4 次发送），既有 e2e `:1344`「CONFIG 类错误立即 FAILED 不重试 attempts=1」不受影响，但 `retry-delays` 段的 attempts 终值断言要改。
8. **D3 的 M9 把「读库失败」从返回默认值改成抛出**：`getPrinterSettings` 有 4 个调用方（`enqueueOrderTicket`、`repeatAnnounce`、`healthCheck`/`printerHealthTask`、`bindPrinterToAccount`/`unbindPrinter`、`enqueuePrinterTestJob`），每个都要接住；漏一个，scheduler 那一轮的 `printerHealth` 键就会缺失（`2336987` 修过一次同类问题）。
9. **B3 的 `enabled:false` 与 e2e 顺序**：§16「自动收货」等段会产生 COMPLETED 单；默认关之后这些单 `pointsSettledAt` 保持 NULL（`settlePoints` 在 `enabled` 判断处 return，**在** `pointsSettledAt` 落锁之前——A2 把订单读进事务后这个顺序不能变：先判 `enabled` 再锁，否则关着的时候也会落锁）。§36 自己 PUT 开关，7 天窗口内会把前面段的单也补发——这与基线行为相同（基线默认就是 true），不会改变通过数。
10. **G1 的 B2 与本次迁移**：`20260907000000_review_fixes` 不建表 → 新逻辑输出空 → 提示「跳过 ②」。这恰好验证了 B2 修对了；但**也意味着如果本次迁移失败，恢复只有 ① ③ 两步**——写进 deployment.md。
11. **`A5` 的 `pointsExpireAt` 与 `M16`**：只做服务层，路由不透传（`routes/member.ts` 归 C 组）。M4 需要时一行透传，不在本计划内。
12. **F 必须在 A 之后合入**：F2 删的是 B1 的替代物，先删后落等于制造一个窗口期没有任何取消票。
13. **D2 与 D8 的 M4 规则可能打架**（乙情况下离线期间的 SENT 不该被 24h 规则放弃）：D8 先做保守版（24h），D2 再按 E1 结果收窄。两次改同一段，接受。

---

## 6. 验证协议（串行，C6）

1. 集成分支 = `claude/jolly-visvesvaraya-4c32f4`（本 worktree）。各组从 **S 合入后的 HEAD** 建自己的 worktree。
2. 各组自验只做：`cd apps/server && npx tsc --noEmit`（共用的 `.prisma` 已含新列）+ 自己的 e2e 段**静态过一遍**（不起服务）。**不许**各自起 3105 跑 e2e、不许 `prisma generate`。
3. 集成方按顺序合入并逐次验证：**S → B → C → A → F → H → G → D → D2**。每次：重启 `api-3105`（D 组前先 `TRUNCATE print_jobs`）→ `BASE=http://localhost:3105 DB_NAME=food_shop_audit bash scripts/e2e.sh` → 记录「通过/失败」→ 失败 0 才合下一组。
4. 每组合入后的预期通过数：S 620 → B 623 → C 629 → A 643 → F 643 → H 647 → G 647 → D ≥667 → D2 ≥675。数字是下限，多了是好事，少了要解释。
5. 全部合入后跑一次 `node scripts/check-points-consistency.mjs`（G3 之后的判据）与 `check-channel-consistency.mjs`，都要 ✔。
6. opus 复核每组一次，用 superpowers:requesting-code-review 的格式；复核方**只读**，发现问题打回给执行方，不自己改。

---

## 7. 我认为清单里的建议修法有问题或互相矛盾的地方（PO 单独看）

1. **B5 的公式逐笔 `floor` 会少扣**。清单写 `deduct = min(floor(pointsEarned × refundAmount / pointsBase), …)`。¥100 得 100 分，分三次各退 ¥33.33：每次 `floor(100×3333/10000)=33`，三次共 99，最后 1 分永远扣不回；且只要金额不整除，全额退完也扣不满。改成**累计目标 − 已扣**（A3 的写法）：`floor(pointsEarned × 累计退款 / pointsBase) − alreadyDeducted`，退满时精确等于 `pointsEarned`。这是对清单修法的替换，不是补充。

2. **B7 的「一行修法」与 H7/M16 的前提矛盾**。加 `lt: 目标到期日` 之后旧行不再被往前拽，**但补发的旧单 B 自己那条新行仍是 `B.completedAt + 365`**，比账户早 6 天。H7 与 M16 都建立在「全账户在世行共用同一个到期日」上，协议文案也承诺「N 分将于 X 日**全部**过期」。一行修法让这件事从「总是成立」变成「差不多成立」。A1 加了一句：目标到期日取 `max(本单 completedAt + validDays, 当前在世行最大 expiresAt)`。副作用：店家调短 `validDays` 后，**新**得的分也会跟着老分的更晚日期走，直到 `now + 新天数` 超过老日期为止——对顾客只多不少，与 X.6 方向一致，但 PO 要知道「调短有效期不会立刻对新分生效」。

3. **B1 下沉之后会给「已发货/已完成再全额退款」的单也出 CANCEL 票**。售后路径退的是已经送到顾客手里的单，厨房收到一张「订单取消/退款」纯属噪音。现在 `wechat-notify.ts:312` 的行为也是这样（只看 `REFUNDED`），所以 B1 是**行为对齐**而非新问题。要不要在 `finalizeRefundSuccess` 里按 `shippedAt/completedAt` 非空跳过——是产品判断，我按「对齐现状、不跳过」写进 A4，PO 若想跳过，A4 加一个条件即可。

4. **H6 说「独立 kind 或独立 seq」，两者不等价**。独立 seq 仍是 `CANCEL` kind，票面靠 `reason` 文案区分，但 `printCancel` 开关、打印记录筛选、M12 的票面标题都分不出来；而且**驳回之后顾客可以再申请**（`cancelRequestedAt` 被清空），固定 seq 第二次会被 dedupe 吞掉。D6 选独立 kind + `seq = cancelRequestedAt.getTime()`。清单没把「可重复申请」算进去。

5. **H5 与 H5b 的修法在 E1 结果为「乙」时互相抵消**。H5 让 FAILED 更积极地补打，H5b 说票根本不会 FAILED 而是堵在飞鹅云端。乙情况下 H5 的修法是**无效代码**（永远没有 FAILED 可补），真正要改的是「下发前查在线、恢复前清云端队列」。清单已经说了要等实验，但 §2.1 的表把两个方向的具体做法写清楚了——**执行方不要在没有 E1 的时候按 H5 字面修**。

6. **H4 建议「`validatePrinterSettings` 拦掉未实现的 provider」与 `sanitize` 放行 XPYUN 的现状，两处只改一处不够**。如果只在 `sanitize` 里把 XPYUN 强转 FEIE，校验永远看不到用户选错；如果只在 `validate` 里拦，`getProvider` 的抛出仍要挪进 try（脏行已经在库里的情况）。D3 三处都做。

7. **M8 建议「dedupeKey 用 SN」会撞 64 字符上限**。`orderId|CANCEL_REQUEST|13位时间戳|32位SN` 最长 72 字符，`.slice(0,64)` 会**静默截断**制造假冲突。要么加宽列（违反 C4 的「只加列」精神，虽然 MySQL 加宽 varchar 是原地的），要么哈希 SN。D5 选哈希前 10 位，不动列。

8. **M4 的「SENT 无终止」与 H5b 的「云端排队」在乙情况下是同一件事**：打印机离线一晚，所有票都是 SENT-未确认，M4 的 24h 放弃规则会把它们标成僵尸，而 H5b 的恢复逻辑正需要这批 SENT 来决定「哪些补、哪些丢」。D8 与 D2 拆开做是权宜，PO 要知道 D2 会改 D8 刚写的规则。

9. **H9 的「循环直到某轮返回 < limit」缺一个退出条件**：`expirePointsBatch` 对单行异常是 catch 后不计数，一批 200 行全坏时返回 0 < limit 正常退出没问题；但如果**恰好**返回 `limit` 且每轮都是同一批坏行（CAS 永远失败被重选），会空转到轮数上限。H 组加了 `=== 0` 与 50 轮上限两道，写在这里是提醒复核方看这个。

10. **M9 与 H4 的方向相反**：H4 要「一条脏行别炸掉整轮」（更多 try/catch），M9 要「读不到配置别静默」（更少吞错）。两条都对，边界是：**配置层**读失败要抛到出票层留 SKIPPED 痕迹；**出票层**逐条兜错。D3 按这个边界写，执行方不要「为了 H4 把 M9 的抛出又吞回去」。

11. **清单没提但会被 B6 引出的**：`SENDING` 是新状态，后台「打印记录」页的状态映射、工作台快照的统计、`api.md` 附录 D 都要跟。D 组做代码，G4 做文档；后台页面在 M3 才有，届时映射表要带上它。
