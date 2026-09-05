# 第二轮复核 · 已核实清单（2026-09-05）

> 三个 opus 复验方并行审查第一轮 34 个修复 commit（`c826405..HEAD`）。
> charter 不是「重新审查代码库」，而是**「真修到了吗、有没有修坏别的、那 116 条新断言是不是真的」**。
> 本文件是去重、交叉验证、并由我逐条核实过代码/实测过之后的清单。
>
> **好消息**：第一轮的 7 条 BLOCKER + 11 条 HIGH，**绝大多数确认真修到了**（见文末白名单）。
> **坏消息**：修复过程本身引入了 6 条新 BLOCKER，其中 4 条是「两个各自正确的改动叠在一起就破了」。

---

# 一、我实测/核实过的三条（不是转述）

| 条目 | 验证方式 | 结果 |
|---|---|---|
| **R1 deploy.sh 的 pipefail** | 用复核方给的命令实跑 | `REACHED` 未打印，**exit=1**，脚本当场死掉 ✔ 成立 |
| **R3 finalizeRefundSuccess 的 read view** | 两个 MySQL 会话实测 | 甲（第一句普通读）：另一会话已提交 100，事务内第二次读到的**仍是 0**；乙（第一句 `FOR UPDATE`）：另一会话被**阻塞** ✔ 成立 |
| **R4 孤儿回收窗口** | 读常量 | `SENDING_ORPHAN_AFTER_MS=15s`，`feie.ts TIMEOUT_MS=10s`，print 10s + queryStatus 10s = **20s > 15s** ✔ 成立 |

**一处复核方之间的分歧，以实测为准**：回归复核方认为 H1「代码修法我认可、不会死锁」，
会员复核方认为 H1 **只修了一半**。上面的两会话实测证明**会员复核方是对的**——
回归方只看了 `settlePoints` 那一侧，没看退款侧。

---

# BLOCKER（不修不能部署，且都是第一轮修复自己造的）

### R1 · `deploy.sh:164` 的 B2 修复会让恢复指引一个字都打不出来

`scripts/deploy.sh:8` 是 `set -euo pipefail`；`:164` 的 `grep -o 'CREATE TABLE ...' | sed | paste`
在 **grep 无命中时返回 1** → `pipefail` 判整条管道失败 → `set -e` 终止脚本。
而 `20260907000000_review_fixes/migration.sql` **一条 `CREATE TABLE` 都没有**，这是本次部署的必然情况。

后果：迁移失败时，`restore_artifacts` 之后的 `ERROR:` 提示、**备份文件路径**、
**第 ③ 步「清 `_prisma_migrations` 失败记录」的命令全部不执行**。运维只看到 migrate 报错然后脚本静默死掉。
不做第 ③ 步，下次部署必然 P3009 卡死。

`docs/deployment.md:317` 还明文写着「会被脚本判定为『不建表，跳过』——这是预期行为」，
**那条 else 分支永远走不到**。

**修法**：管道加 `|| true`（或局部 `set +e`），并把 deployment.md 那两句改对。

---

### R2 · `deploy.sh:163` 的 `tail -1` 只扫最后一个迁移，而本次要应用**两个**

生产在跑的 `def96c2` 只有 15 个迁移目录；`20260906000000_member_points_coupon`（**4 条 CREATE TABLE**）
与 `20260907000000_review_fixes`（0 条）**都不是它的祖先**，明天会一次应用两个。

失败点若落在 `20260906`（无论 ALTER 还是第 2 张表），`LATEST_MIG` 拿到的是 `20260907` → 读出空 →
脚本告诉运维「本次迁移不建表，跳过②」→ 灌回备份、跳过②→ 库里残留最多 4 张新表 →
下次 `migrate deploy` 撞 1050 → **永久 P3009**。

这正是 B2 想消灭的危害，方向反过来了：旧版**多说**了不该删的表，新版**漏说**了该删的表。

**修法**：探测范围从「最后一个目录」扩到「本次所有 pending 迁移」——
用 `_prisma_migrations` 里已完成的最大 `migration_name` 做下界。

---

### R3 · H1 只修了一半：`finalizeRefundSuccess` 的 read view 在拿锁**之前**就被钉死

`services/refund.ts` 事务第一句是 `tx.refund.findUnique`（**普通读**）→ InnoDB 在这里创建 read view；
orders 行锁要到第 27 句的 `UPDATE ... LEAST(...)` 才拿到。
而 `settlePoints` 是 `SELECT ... FOR UPDATE` 当**第一句**（锁定读不创建 read view），所以那一侧是对的。

失效时序：`finalizeRefundSuccess` 的 read view 固化在「settlePoints 提交之前」→
`points.ts` 读 `user.pointsBalance` 走旧快照读到 **0** → `calcRefundDeduct(..., balance=0)` → `min(...,0)=0`
→ **全额退款成功，积分一分没扣，永久留在账上**。orders 行因为被本事务写过所以是新的，
users 行没被写过所以是旧的——这个不对称正是坑所在。

即使用户原本有余额也只会扣到那个旧值；且 `deductFromEarnRows` 在旧快照下**看不见新建的 EARN 行**，
会去扣更老的行——不变式仍成立，但扣错了行、扣少了量。

**修法**：把两条**锁定读**提到事务最前面当第一、二句：
```ts
const [{ order_id }] = await tx.$queryRaw`SELECT order_id FROM refunds WHERE id=${input.refundId} FOR UPDATE`
await tx.$queryRaw`SELECT id FROM orders WHERE id=${order_id} FOR UPDATE`
```
锁定读不创建 read view，后续普通读自动推进到拿锁之后。加锁顺序 refunds→orders 与现状一致。
**合入前顺带核 `initiateRefund` 有没有反向的 orders→refunds 段**（防死锁环）。

---

### R4 · 孤儿回收窗口(15s) < TIMEOUT 分支的实际 SENDING 时长(~20s) → 静默无限重发

`index.ts:60` `SENDING_ORPHAN_AFTER_MS = 15s`，注释写「比 feie 的 10s 超时多留 5s 缓冲」。
这个前提在 M11 落地后不成立：M11 在**同一个 SENDING 窗口内**又加了一次 `queryStatus`，它自己也是 10s。

```
t=0     认领 PENDING→SENDING，print() 打飞鹅（网络黑洞）
t=10s   print 超时 → handleSendFailure 在仍是 SENDING 的状态下发起 queryStatus，也挂住
t=15s   孤儿回收把该行改回 PENDING，attempts 不变（仍是 0）→ 同轮 PENDING 扫描立刻选中 → 再发一次
t=20s   第一次的 handleSendFailure 醒了 → updateMany where status='SENDING' → 命中 0 行
        → attempts 不递增、lastError 不写、不判 FAILED、不告警、不触发 M3 兜底推送
→ 循环，永不终止
```

**M11 存在的理由正是「飞鹅无幂等 token，超时重试会真的多出一张纸」——这条把它的封顶静默作废了。**
命中概率：一次 TIMEOUT + tick 落在 [15s,20s] → 60s 心跳下约 8%。
**恰恰在飞鹅网络劣化时（唯一产生 TIMEOUT 的场景）完全静默地无限重发。**

**修法**：`SENDING_ORPHAN_AFTER_MS` 提到 ≥ 2×TIMEOUT+缓冲（如 60s）；
并在 `handleSendFailure` 判 `updateMany.count === 0` 时告警（说明状态机有洞）。

---

### R5 · 离线恢复补发会把「已经印好、只是还没确认」的票再印一遍

`index.ts:766-786` 的 `recent` 筛选条件只有 `printerSn + status IN (PENDING,SENT) + createdAt ≥ now−30min`，
**没有任何条件区分「离线期间排进云端队列的票」与「离线之前就已正常打印、只是还没确认成 PRINTED 的票」**。
而 SENT→PRINTED 要等 `sentAt` 满 3 分钟。

```
19:00–19:03  正常出票 5 单 → 5 行 SENT（未到确认窗口）
19:03:10     断电 30 秒，期间来 1 单 → 排进云端队列，第 6 行 SENT
19:04:00     健康检测轮询到 ONLINE、waiting>0 → clearQueue → recent 查出 6 行 → 全部重发
结果：厨房拿到 5 张重复接单票，5 单各做两份
```

离线越短、生意越忙，重复越多（上限＝30 分钟内该打印机所有未确认行）。

**修法**：`healthTrack` 里已有 `offlineSince`，传进 `recoverFromOfflineQueue`，
`recent` 只取 `sentAt >= offlineSince`；重发前对有 `providerJobId` 的行先 `queryJob`，
`printed=true` 就直接置 PRINTED 跳过。不需要加列。

---

### R6 · M13 的 CAS 把 H9 的循环提前打断（两条修复互相拆台）

`scheduler.ts:263-265` 的 `if (result < limit) break`，而 `expirePointsBatch` 返回的是
**处理成功条数**不是候选条数。三种情况会「取了不算数」：CAS `count===0`、`remaining<=0`、单行抛错被 catch。

M13 这次新加的 `expiresAt: { lt: now }` CAS 条件，**恰恰把「被 `extendLivePoints` 续期救回来」
变成一种日常会发生的 skip**。600 行候选、其中 1 个用户在任务运行期间下单触发续期 →
第一轮返回 199 < 200 → break → 且 `patchCronState` 照样写 → **剩下 400 行留到明天**。
H9 想解决的「一天只清 200 行」几乎原样保留。

**修法**：`expirePointsBatch` 改成返回 `{ scanned, processed }`，按 `scanned < limit` 退出、
按 `processed` 累计。`expireCouponsBatch` 同理。

---

# HIGH

### R7 · D2 的核心机制在真机上赢不了竞速，而 mock 刻意不模拟它 → 关键断言是假保证

`mock.ts:12-15` 自陈「不模拟『打印机一恢复就自动吐出』那个瞬间的竞态——这是刻意简化」。
而这恰恰是决定生产结果的那件事。真机事实：通电 74s 后打印机在线、**队列里那张票已经自己吐了、waiting=0**。
我们的健康检测是 60s 轮询。

- **多数情况**：tick 落在飞鹅吐完之后 → `waiting<=0` 直接 return → `clearQueue` 不调、
  30 分钟窗口的 `STALE:DROPPED` 不执行。规格「超过 30 分钟的旧单不再补打」**在生产上根本没生效**。
- **少数情况**：tick 撞在吐纸吐到一半 → 掐掉剩下的（这部分有价值），但已吐出去的照样是纸，
  再叠加 R5 的无差别补发。

`e2e.d/45:26` 断言「打印机物理只收到 1 次 print()」**完全是 mock 产物**，真机同样时序是 2 张纸。
**这条断言不是在验证行为正确，是在把 mock 的简化固化成「已验证」。**

**叠加的第二个未验证假设**：`feie.ts:157-166` 的 `queryQueueInfo` 假定 `Open_printerInfo` 的
`data.data` 是**对象**且含 `waiting` 键，解析失败一律按 0。但同文件 `parseStatus` 表明
`Open_queryPrinterStatus` 的 `data.data` 是**字符串**。若 `Open_printerInfo` 也返回字符串，
`waiting` 恒为 0 → 整条链路静默 no-op 且无痕（waiting=0 == 「没事可做」）。
**E1 实验是用 scratchpad 脚本跑的，没走这段代码。**

**修法**：先用只读接口打印 `Open_printerInfo` 的**原始 JSON**确认结构；mock 加「恢复即吐出」开关，
把断言改成「真机语义下会多印几张」让风险在测试里显形。

### R8 · `STALE:DROPPED` 把 M4 刚明确「不许改判」的行改判成 FAILED

`index.ts:750-762` 的 `stale` 条件不区分这些行是不是本次离线造成的。会落进来的典型：
M4 留下的 `SENT + CONFIRM:GAVE_UP` 僵尸行（M4 的注释白纸黑字写「不知道有没有打印成功，不能武断改判」），
以及任何超 30 分钟未确认、其中相当一部分实际已出过纸的行。
后台「打印记录」会冒出一批 FAILED，店员点「失败重试」→ **真的重印一张 24 小时前的接单票**。

**修法**：`stale` 加 `createdAt >= offlineSince` 下界，或排除 `lastError='CONFIRM:GAVE_UP'`。

### R9 · H5「补打不该绑死 alerted」只修了 OFFLINE，真正会 FAILED 的 ABNORMAL 没修

`index.ts:834-838`：`retryRecoveredPrinterJobs` 仍绑在 `track.alerted` 上；
`wasOffline` 只在 `state==='OFFLINE'` 时置位。
**E1 之后，唯一还会让 `print()` 真失败的设备类故障就是 ABNORMAL（缺纸/开盖）**——
缺纸 4 分钟（告警阈值 5 分钟）→ 期间的单走完重试推到 FAILED → 换纸恢复 →
`alerted` 从未 true → **永远停在 FAILED**。H5 原文的失效链原样保留，只是把「离线」换成「缺纸」。

`e2e.sh §35` 显示补打成功，是因为它先注入了 `health-track{offlineSinceMsAgo}` 把 `alerted` 拉起来。
`45:60`（号称测 pm2 重启丢记忆）同样是假的：清空 healthTrack 后又跑了一轮「仍离线」把 `wasOffline`
重新建立起来才切 ONLINE——真实重启场景是**重启后第一次轮询就是 ONLINE**，两条恢复路径一条都不走。

### R10 · B1 挂在「钱真的退到」而非「决定退款」，ABNORMAL/CLOSED 时厨房仍收不到取消票

`refund.ts:353-359` 只在 `flippedToRefunded` 时出票。微信返回 `ABNORMAL`（用户账户异常，
需商户平台人工处理，可能拖几天）或 `CLOSED` 时，订单停在 `REFUNDING`，**CANCEL 票一辈子不出**。
而拒单与顾客自助取消都是在「决定退款」那一刻出票的。

**修法**：`initiateRefund` 里 `isFull && !fromRefunding` 那次 `updateMany` 命中后
也 fire-and-forget 一次 `enqueueOrderTicket(orderId,'CANCEL')`（seq=0，与 finalize 那次天然去重）。

### R11 · 人工标记退款完成：钱记了、**积分不扣**

`routes/admin/orders.ts:407-452` 自己在事务里写 `Refund.status='SUCCESS'` + `order.status='REFUNDED'`，
**不经** `finalizeRefundSuccess`，因此全仓唯一的 `deductPointsOnRefund` 调用点够不着它。
失效场景：订单已结算发分 → 全额退款 → 微信回调丢失 → 店员用「人工标记退款完成」收尾 →
**钱退了、积分一分没扣**，且 `pointsSettledAt` 已置位，兜底任务不会再碰。

（反方向确认干净：`finalizeRefundSuccess` 里退款翻转与积分扣回同事务，扣回抛错整笔回滚，
不会出现「分扣了钱没退」。）

---

# 验收真实性 —— 5 条假用例

| 位置 | 问题 |
|---|---|
| `e2e.d/45:26` | 「物理只收到 1 次 print」纯粹是 mock 不实现自动吐纸的产物（R7） |
| `e2e.d/45:14` | 「修复前会推成 FAILED」的前提是**旧 mock**；D2 同批把 mock 的 OFFLINE 语义也改了。**旧应用代码 + 新 mock 同样得到 SENT**——只区分了新旧 mock，没区分新旧应用代码 |
| `e2e.d/45:60` | 「pm2 重启丢记忆」用例中间多跑了一轮「仍离线」，把 `wasOffline` 重新建立起来了（R9） |
| `e2e.d/43:37` | H9 主断言靠 `dailyTaskBatchLimit:2`，而这个 override **本身就是 H9 这次新加的**；跑在修复前的代码上 override 被忽略、走默认 200、一批处理完 5 条 → **照样通过** |
| `e2e.d/40:205` | `ok "M13：..."` **无条件通过**，纯粹给通过数 +1，什么都没验 |

**所以 620 → 736 这个数字是虚高的，不能拿来当上线依据。**

另外 `e2e.d/42:78/93` 用了裸 `R2`，与主脚本 `e2e.sh:124` 的全局 `R2=$(mktemp)` 撞车
（收尾 `rm -f "$R2"` 打不到真临时文件，每跑一次泄漏一个）。43/44/45 都加了前缀，只有 42 漏了。

**没有 e2e 覆盖的条目**：H1（分片自陈无法复现真并发）、M13（空转 `ok`）、
B2（无任何自动化验证——而它正是 R1/R2 所在）、H10（纯文档）、H5b（仅 mock）。

---

# 其他（MEDIUM，不阻塞但要有归属）

- **M15 被改得更糟**：A 组把 `getMemberSettings()`（用全局 `prisma`）从事务外挪进了事务内，
  且在 `FOR UPDATE` **之后**。缓存未命中时等于「握着行锁再去连接池要第二条连接」。
  修法：提到 `$transaction` 之前读。
- **M10 收窄过头**：删掉了 `签名|USER|UKEY|账号`，`用户名` 还在。若飞鹅文案是「签名错误」「账号异常」，
  配置错误会被判 BUSINESS → 每张票烧 4 次 ×10s 外呼才 FAILED。与 H10 描述的生产首发场景正相关。
- **M4 只修了一半**：SENT 确认批量降到 20，但 PENDING 重试循环仍是 100 条串行外呼，
  最坏一轮 ~1000 秒，期间 scheduler 的 `running` 一直持有 → 同城呼叫骑手/待付款超时取消全部停摆。
- **`UNKNOWN` 被当成「已恢复」**：`index.ts:818` 的 `bad` 只含 OFFLINE/ABNORMAL/ERROR，
  而工作台的 `summarizePrinterStatus` 把 UNKNOWN 归到 ABNORMAL——两处口径相反。
- **M16 停在一半**：`routes/member.ts:24` 没透传 `pointsExpireAt`，
  而 `docs/member-terms-copy.md:30` 的常驻文案需要它渲染。C 组本来就改了这个文件，一行的成本。
- **`getPointsSummary` 变成热路径全表拉取**：从「读一个冗余列」变成「把该用户全部在世行拉进 Node 求和」。
  滚动续期意味着老顾客的行永远不到期、一单一行。建议改 `aggregate`。
- **`docs/api.md` 四处过时**：`:1182` 还写 `CANCEL`（已改 `CANCEL_REQUEST`，且缺 `RESUME` 一行）；
  `:1193` 还写「3 次失败转 FAILED」（M2 已改成 4 次发送）；`:1195` 只描述老的补打路径，
  完全没提 D2 的 `recoverFromOfflineQueue`；全文搜不到 `SENDING`/`CANCEL_REQUEST`/`RESUME`/`clear-queue`。
- **`docs/member-terms-copy.md` 的一处措辞偏差**（需 PO 知情，不是 bug）：
  文案说「有效期为最后一次消费后 {validDays} 天」，但店家**调短** `validDays` 后，
  `max()` 让新得的分也跟着老分的更晚日期走。方向对顾客只多不少、不违约，但页面显示与实际短期内对不上。
- **券的三句文案（只抵商品/一单一券/退款不退券）目前无代码可比对**：M1 只落了模板与发放，
  下单侧用券逻辑要到 M2。**实现用券时必须回来对这三句。**

---

# 确认真修到了的（这一节决定不用再派轮）

三位复验方各自尽力构造反例而未能构造出来的：

**会员侧**：B5 累计公式（四种组合逐个手算：多次部分退、金额除不尽、结算前已退、`pointsBase=null` 老单）、
B7 的 `max` 语义与 X.6 一致、B4 的 `FOR UPDATE` 位置与锁顺序（两函数一致、与 settle/refund 不成环）、
C 组自加的 `status==='OFF'`（保住 42254 精确性）、M13 的 CAS 本身、M5、H7、
H8 不变式（五条写余额路径逐条核过全部同事务等量增减）、B3 默认值与「关着时不落锁」的约定。

**出票侧**：H2 转义（覆盖全部可控字段，剥字符比转义更对）、B6 认领态（五个调用点全经 `attemptSend` 单一出口）、
§8b 同 SN 串行链、M8 长度（最长 50 < 64）、M1 copies、M2 退避与耗尽次数、M12 当日流水、
M10/M9/H4 三处、H6 独立 kind、M3/M14/H3。

**上线侧**：两条迁移对既有数据安全（新增列全部可空或带默认、4 张新表的唯一索引建在空表上）、
应用顺序正确（字典序 `20260906` < `20260907`）、目录改名对**生产**零风险（生产从未应用过）、
新代码 + 生产现有配置能起来（`FEIE_*` 懒校验、`getPrinterSettings` 的 9 个调用点无漏接）、
**打印与会员两套定时任务在生产默认配置下全部是 no-op**（不会给历史订单出票也不会发分）。

---

# 如果明天上线，必须先做的（按「不做就会出事」筛）

1. **修 `deploy.sh:163-164` 的 R1 + R2，并把新版 scp 到 `/home/ubuntu/deploy.sh`。**
   不做等于本次部署的失败恢复路径是坏的——迁移多半会成功，但那正是「出事时才发现兜底没了」。
2. **同步改 `docs/deployment.md:315-317`** 的第 0 步与第 3 条，两句都错。
3. **R3（退款侧锁）** —— 会员积分虽然默认关，但这条一旦开启就是真金白银算错。

**明确不必上线前做的**：R4/R5/R7/R8/R9/R10 全部只在**打印开关或积分开关被打开之后**才可能发生，
而本次部署两个开关都是 `false`。它们是「开打印/开积分之前必须清掉」，不是「明天上线之前」。
