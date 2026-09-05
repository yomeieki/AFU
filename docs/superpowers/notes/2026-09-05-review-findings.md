# 三方对抗性复核 · 已核实发现清单（2026-09-05）

> 三个 opus 复核方并行审查 `def96c2..HEAD`（出票全链路 + 会员 M1 + 滚动续期），
> 只读、不改代码、不跑 e2e。本文件是**去重、交叉验证、并由我逐条核实过代码之后**的清单，
> 不是三份报告的拼接。修复计划以本文件为输入。
>
> **现状：这些缺陷全部不在生产。** 生产跑 `def96c2`，不含会员与打印机代码。
> 唯一已在生产机上的是 B2（`deploy.sh`），但它只在迁移失败时触发。
> 全国邮寄渠道在线运营中（14 单真实订单、¥138.40），所以修复不能破坏既有行为。

## 我核实过的环境事实

| 事实 | 值 | 影响 |
|---|---|---|
| 生产 `NODE_ENV` | `production` ✔ | `config.ts` 的生产守卫（禁 mock / 强制 COS / 回调 URL 长度）全部有效 |
| 生产 `settings` 表 | `member`/`printer`/`member_cron_state` 三个 key **都不存在** | 上线即走代码里的默认值 |
| 生产 COMPLETED 订单 | **1 单**（2026-09-02 完成），在 7 天窗口内 | 复核方说的「14 单」不对；但真正的问题是**之后每一单** |
| 生产迁移 | 15 条已应用，0 条未完成 | 新迁移 additive，已验证无 NOT NULL 无默认列 |

---

# BLOCKER（不修不能部署）

### B1 · 后台「退款」路径永远不出取消票 —— 厨房白做一单

**位置**：`services/refund.ts:226`（同步 SUCCESS 直接调 `finalizeRefundSuccess`）、
`routes/wechat-notify.ts:280`（幂等早退，跳过 `:312` 的出票）、
`routes/admin/orders.ts` 的 `POST /:id/refund` 与 `routes/admin/after-sales.ts` 全程无出票调用。

**链条（已核实）**：订单处于 `PAID`/`PREPARING`，厨房正在备餐 → 店员在后台「退款」Tab 全额退款
→ 微信 v3 对余额/未结算资金退款**常同步返回 SUCCESS** → `finalizeRefundSuccess` 把订单推到 `REFUNDED`
→ 随后异步通知到达，被 `refund.status === 'SUCCESS'` 的幂等守卫早退 → **唯一那条 CANCEL 出票代码永不执行**。

拒单（`admin/orders.ts:367`）与人工标记退款完成（`:461`）都补了票，唯独最常用的这条没有。
`refund-complete` 也够不着：它要求 `status === 'REFUNDING'`，而同步 SUCCESS 已经推到 `REFUNDED`。

**修法**：把 CANCEL 出票**下沉进 `finalizeRefundSuccess`**（翻转成 REFUNDED 的那一次），
而不是继续在各调用点散着补。这样所有退款入口自动覆盖，也不会再漏下一个。

---

### B2 · `deploy.sh` 迁移失败的恢复指引会让运维 DROP 掉有真实数据的生产表

**位置**：`scripts/deploy.sh:172-176`

新迁移 `20260906000000_member_points_coupon` 的**前三条语句是 ALTER TABLE**，CREATE TABLE 在后面。
任一条 ALTER 失败时库里一张新表都没有 → 自动探测算出空字符串 → 走 else 分支 →
打印出**上一批次硬编码的表名** `delivery_events, deliveries, print_jobs` 并给出 DROP 命令。
运维照做：① 灌回备份（把同城三张表连数据恢复）→ ② DROP 掉它们 → **配送单与打印记录全部丢失**。

文案里还写着「本轮同城上线」，是上一次部署的遗留，慌乱中没人会去核对。

**修法**：else 分支不要硬编码，从 `prisma/migrations` 最新目录
`grep -o 'CREATE TABLE \`[^\`]*\`'` 动态生成；实在要兜底就写本次的四张表。
**注意生产机上跑的是 `/home/ubuntu/deploy.sh`（部署前那一版），改完要一起传上去。**

---

### B3 · 会员默认配置与 PO 定稿矛盾 —— 每单按 1 分/元发分并永久落锁

**位置**：`services/member/settings.ts:32` = `{ enabled: true, earnRatePerYuan: 1, validDays: 365 }`
与 spec `:217`、`docs/member-terms-copy.md` 定的 **100 分/元** 直接矛盾。

生产 `settings` 表没有 `member` 这一行 → 走默认值。上线后每一单完成都按 1 分/元结算，
`pointsSettledAt` 一落锁就不会重扫（`@@unique` 让重扫只补标记不重发）。
事后纠正必须手工删流水行 + 改 `users.points_balance` + 清 `points_settled_at`，三步都对才不破坏一致性。

**修法（两件事，都要做）**：
1. 默认值改成 `earnRatePerYuan: 100`，与定稿对齐。
2. **默认 `enabled: false`**——顾客端五个页面要到 M4 才有，现在发分顾客完全看不见；
   且积分价尚未按 rate=100 重定，此时放分等于让顾客攒兑换价随时会变的东西。
   由店主在 M3 设置页显式打开。（与 printer 的默认取向一致。）

---

### B4 · 并发领券击穿「每人限领」

**位置**：`services/member/coupons.ts:127`（`claimCampaign`）、`:103`（`redeemByPoints`）

`tx.userCoupon.count()` 是快照读，之后的 `updateMany` 判 count **只覆盖 `totalLimit`**，
且仅在 `totalLimit != null` 时才真的构成条件——不限总量的券，`where` 里压根没有数量条件，
递增必然成功。同一顾客并发 5 个请求领 5 张限领 1 张的券，上限是限流的 20 张/分钟。
`redeemByPoints` 更彻底：整个函数没有任何 `updateMany` 判 count，`perUserLimit` 是纯裸读。

**e2e 为什么没抓到**：并发用例（`e2e.sh:1591`）测的是 `totalLimit` 且用了**两个不同用户**；
`perUserLimit` 只有串行的二次领取用例。

**修法**：事务第一句 `SELECT id FROM coupon_templates WHERE id=? FOR UPDATE` 锁模板行，
后续 count/递增/发券串行化。两个函数都要。**e2e 补同一用户并发领取的用例。**

---

### B5 · 退款按当前比例扣分 —— 退 1% 的钱扣光 100% 的积分

**位置**：`services/member/points.ts:390`（取当前 `earnRatePerYuan`）、`:55`（`calcRefundDeduct`）

一单 ¥100 在 rate=1 时得 100 分 → PO 把 rate 改成 100 → 顾客退 ¥1 →
`min(floor(100/100)×100 = 100, 100−0, balance)` = **100**，扣光整单积分。
反方向（100→1）则是全额退款只扣 100 分，剩下白送。

三重 min 封死了越界与负余额，封不住**比例错位**。危害有上界（不超过本单发放量），但单单级必错。

**修法（两位复核方给了不同方案，取更稳的）**：
`settlePoints` 落一列 `Order.pointsBase`（= 结算时用的 `actualAmount − refundedAmount`），
扣回改成按比例摊：`deduct = min(floor(pointsEarned × refundAmount / pointsBase), pointsEarned − 已扣, balance)`。
**这条式子与 rate 无关**，以后随便改比例都不会再错。

> 复核方 C 主张不加列、直接用 `actualAmount` 摊。分歧点：若结算**之前**已发生过退款，
> `pointsEarned` 是按 `actual − refunded` 算的，用 `actualAmount` 摊会少扣。
> 这是罕见路径，但加一个可空列的代价极低（现在零数据），取更稳的方案。

---

### B6 · 立即发送与定时兜扫无锁竞争 —— 同一张票发两次，厨房做两份

**位置**：`services/ticket/index.ts:188`（enqueue 后立即 `attemptSend`）与 `:253-258`（sweep 循环）

```
T+0.00  enqueueOrderTicket → PrintJob.create(PENDING, attempts=0)
T+0.01  attemptSend → provider.print() 开始（超时上限 10s）
T+0.30  scheduler tick → printQueueSweep 选中同一行（attempts=0，delay 判断不跳过）
T+0.31  第二次 print() 发出 → 打印机吐两张一模一样的新单票
```

`attemptSend` 里的 `updateMany({where:{id,status:'PENDING'}})` 只保证状态不被写坏，**纸已经出了**。
`dedupeKey` 只防重复建行，不防同一行被发两次。窗口 = 一次飞鹅调用耗时，对 60s 心跳约 1.7%–17%。
同样的竞争在 `retryPrintJob`（`:566`）与 `enqueuePrinterTestJob`（`:391`）也存在。

**这是规格违反**：§8b 明写「进程内对同一 SN 串行发送、间隔 ≥ 300ms」，全仓没有任何串行队列。

**修法**：发送前做认领写 `updateMany({where:{id,status:'PENDING'}, data:{status:'SENDING'}})`，
`count===0` 则放弃；或按规格加同 SN 的进程内串行队列。

---

### B7 · 滚动续期没有上界 —— 会把整个账户的到期日往前拽，且违反用户协议 X.6

**位置**：`services/member/points.ts` 的 `extendLivePoints`，`where` 只有 `expiresAt: { gt: now }`，
`data` 是无条件赋值。**这是 2026-09-05 本人写的代码，两位复核方独立发现。**

两条失效路径：
1. **旧单补发**：顾客 10:00 完成订单 A，全账户到期日推到 A+365。订单 B 在 6 天前完成
   （走「商家标记完成」或自动完成这两条没挂钩子的路径），10:05 被 `settleMissedPoints` 捡到
   → 写 `B.completedAt + 365`，比 A 早 6 天 → **全账户到期日倒退**。上界由 7 天窗口兜住。
2. **调短有效期**：店家把 `validDays` 从 365 调小到 90，顾客下一单完成时，
   一年前攒的、原本还剩 300 天的积分被**提前**到 90 天后到期。
   这正是 `docs/member-terms-copy.md` 的 X.6「规则调整不影响调整前已获得积分的有效期」
   承诺不会发生的事——那句话是特意写进去防霸王条款的，纠纷时会被直接拿来对照。

**修法**：`where` 加 `expiresAt: { gt: now, lt: <目标到期日> }`，让续期单调只增。一行。

---

# HIGH（上线前修完）

### H1 · `settlePoints` 事务外读订单 → 与部分退款并发，永久多发积分
`points.ts:181-196` 在事务外读 `refundedAmount` 算 `earn`。与 `finalizeRefundSuccess` 并发时：
settle 读到 `refundedAmount=0` 算出满额 earn；退款事务读到 `pointsEarned=0` 直接 return 不扣；
settle 随后提交。顾客拿到已退部分的积分，**且永远不会被扣回**（退款单已 SUCCESS，
`pointsSettledAt` 已置位不再重扫）。
**修法**：订单读进事务内并 `SELECT ... FOR UPDATE`，与退款那条 `UPDATE orders SET refunded_amount` 互斥。

### H2 · 顾客备注未转义飞鹅控制标签 → 撕票 / 整单一张纸都不出
`ticket/content.ts:146` 把顾客自填的 `remark`（上限 255 字符）原样拼进票面。
填 `<CUT>` → 打印机在**商品明细之前**切纸，金额与明细在第二段极易被漏；
填 `<QR>` → 触发飞鹅内容校验失败 → 重试 3 次全败 → FAILED，**这一单从头到尾没有纸**，
老板只收到一条不含商品与地址的泛化告警。`receiverPoiName`/`receiverDetail` 同样未转义。
**修法**：渲染前对所有顾客可控字段剥离 `<` `>`。

### H3 · 微信支付回调里出票挂在两个可同步抛出的 void 函数之后
`routes/wechat-notify.ts:222-242`：`sendPaidSubscribeMessage` 与 `notifyOrderPaid` 都是同步 void 函数，
任一处同步抛出（模板字段配错、`paid.user` 为空、`items[0]` 解构异常）→ 出票**永不执行**，
异常被 `:242` 的 `.catch(() => undefined)` 吞掉，**不打日志不告警不落行**。钱收了、推送没发、票没出、零痕迹。
**mock 支付路径（`orders.ts:754`）刻意单开了一条 promise 链并写了注释，生产路径没照做。**
**修法**：出票挪出这条 `.then()` 单开链；`:242` 至少 `console.error`。

### H4 · `processQueue` 无逐条兜错 + `getProvider()` 在 try 外 → 一条脏行永久瘫痪队列
`ticket/index.ts:206`（`getProvider` 在 `try {` 之前）、`:256`（`await attemptSend` 无 try/catch）。
`printer-settings.ts:112` 的 sanitize **放行** `provider:'XPYUN'`，而 `getProvider` 对它抛错。
店员误选后：每轮 `processQueue` 都在同一条行上炸，后面所有作业与 SENT 确认全部不执行，**队列永久瘫痪**。
恢复补打循环 `:459` 有 try/catch（`2336987` 专门修过），主路径 `:256` 没修。
**修法**：`:256` 加 try/catch；`getProvider` 挪进 try；`validatePrinterSettings` 拦掉未实现的 provider。

### H5 · 短时离线不补打；进程重启也丢补打
`ticket/index.ts:494/502`：补打的触发条件绑死在 `track.alerted`（曾经告警过）。
打印机抖动 4 分钟（默认告警阈值 5 分钟）：期间的单 150 秒内就走完 3 次重试推到 **FAILED**，
恢复时 `alerted` 从未置 true → 不补打 → 永远停在 FAILED。
`pm2 restart` 会清空进程内 `healthTrack`，离线 20 分钟后重启同样不补打。
规格 §8b 要的是「离线期间记 PENDING、恢复后补打」，实现把它们推成了 FAILED，
并把**告警阈值（运营参数）与补打触发（可靠性机制）耦合成同一个开关**。
**修法**：补打只看「本轮从 bad 变 good」，不看 `alerted`。

### H6 · 「申请取消」立刻出票，但店员可驳回；且占掉 dedupe 槽位让真正的取消票再也出不来
`routes/orders.ts:539` 顾客申请取消就打「订单取消」票（**订单状态其实没变**，还是 PREPARING）。
店员沟通后驳回（`admin/delivery.ts:91` 是明确支持的流程）→ 没有任何「继续做」的票。
更糟：CANCEL 的 dedupeKey 固定 `seq=0`（`ticket/index.ts:147`），这单后来真被退款/拒单时
撞唯一索引被跳过 → **真正的取消票永远不出**。申请取消（可撤销）与实际取消（终态）共用同一个槽位。
**修法**：cancel-request 用独立 kind 或独立 seq，票面改成「顾客申请取消，待店员确认」；驳回时补一张「请继续制作」。

### H7 · `/member/summary` 显示看得见花不掉的积分
`points.ts:428` 直接返回冗余列 `user.pointsBalance`，而 `consumePoints:95` 按 `expiresAt > now` 过滤。
`expirePoints` 每日一次，所以到期后最长约 24 小时里，顾客看到满额余额、点兑换、被告知「积分不足」。
**滚动续期让这从「零星几批」变成「整账户一次性」**——所有在世行共用同一个到期日。
券的三个只读路径都刻意做了实时判定，积分侧漏了。
**修法**：`getPointsSummary` 的 balance 实算 `Σ(remaining>0 && expiresAt>now)`。

### H8 · 一致性脚本判据本身是错的
`scripts/check-points-consistency.mjs:29` 的 `and l.expires_at > now()` 是多余条件。
代码真正维持的不变式是 **`pointsBalance == Σ remaining`（不带到期过滤）**——
四条写路径（settle 建行+increment、consume 减 remaining+decrement、expire 清零+decrement、
refund 减 remaining+decrement）全部在同一事务内等量增减，这条恒真。
带上到期过滤后，从积分到期那一刻到次日任务跑完，脚本会持续报红最长 24 小时。
**修法**：去掉该条件；「在世积分」另开一条 informational 输出。
顺带 `schema.prisma` 里 `points_balance` 的注释（「未过期入账行 remaining 之和」）也是错的。

### H9 · 每日任务跑一批 200 就记账收工
`scheduler.ts:245`（`await fn()` 一次就 `patchCronState`）、`points.ts:261`（`limit=200`）。
滚动续期让一个用户的全部在世行共用同一个到期日——一年下 200 单的老顾客，
到期那一刻 200 行同时过期，**一个人吃满当天全部配额**，其他人排到明天，明天又只跑 200。
**修法**：循环调用直到某轮返回 < limit（加总轮数上限防打死）。

### H10 · 飞鹅密钥未进生产 `.env`，也未进 `deployment.md`
`config.ts:212` 是懒校验，启动不会挂（这点安全）。但打印一旦开启，每张票都是
`CONFIG:MISSING_CONFIG` → 立刻 FAILED、不占重试次数，且被 `retryRecoveredPrinterJobs` 的
`NOT: { lastError: { startsWith: 'CONFIG:' } }` **永久排除在补打之外**。
`POST /admin/printers/bind` 返回 42240，看起来像打印机的问题而不是 env 的问题。
`docs/deployment.md` 本轮补了 KD100 一节，**没有飞鹅一节**。
**修法**：deployment.md 补一节；部署清单里写明用 `set-env.sh` 填三个键，
`FEIE_API_BASE=https://api.feieyun.cn`（国内站，2026-09-05 真机核实）。

---

# MEDIUM（可以排在上线之后，但要有归属）

- **M1** 重试/补打/手动重试三处硬编码 `copies=1`（`ticket/index.ts:256/457/571`），丢掉「同城 2 联」配置 → 骑手联缺失。`PrintJob` 需加 `copies` 列或回查设置。
- **M2** 退避索引 off-by-one（`ticket/index.ts:254`）：首次重试等 30s 而非规格的 5s，且总发送次数比规格少一次。
- **M3** 规格要求的「打印失败 → 回退强化推送」未实现（`ticket/index.ts:230`）。打印机是单点，这是它唯一的兜底。告警文案还只有订单号，没有商品和地址，老板拿到没法直接派单。
- **M4** SENT 确认无终止条件（`ticket/index.ts:260-282`）：飞鹅对久远 orderid 返回 1001 → 该行永远停在 SENT → 积累 100 条僵尸行后新的 SENT 永远排不进这批。且 `processQueue` 里 200 次串行外呼、单次超时 10s，最坏一轮 2000 秒，期间 scheduler 的 `running` 标志一直持有 → **飞鹅慢的时候，同城呼叫骑手、待付款超时取消、退款兜底全部停摆**。
- **M5** `deductFromEarnRows` 不过滤 `expiresAt` 且按 `expiresAt asc` 排序 → 优先扣「已死但未清扫」的行，退款扣回落空。
- **M6** `member.ts:89/:101` 两个 POST 把 `UserCoupon` 原始记录整个吐给前端（含 `issuedBy`/`remark`/`sourceRef`），违反 spec §5.7 白名单；GET 侧做了白名单。只泄露本人数据，无越权。
- **M7** `redeemByPoints` 完全不看 `totalLimit`。当前符合规格，但 `totalLimit` 是共享列，M3 后台表单一旦对 POINTS 模板露出该字段就是「限量兑换品可无限兑换」的静默漏洞。
- **M8** dedupeKey 第四段用 `printers` 数组下标而非 SN，店员增删打印机后下标会漂到别的 SN；SKIPPED 留痕行与真实作业共用槽位，会永久堵死同一 `(orderId, kind)` 的后续自动出票。
- **M9** 配置读库失败 → 出票静默跳过（`printer-settings.ts:149`），不建行不告警，只有一条 5 分钟限频的系统告警。同文件对「未配置打印机」精心留了 SKIPPED 行，唯独这条更危险的路径什么都不留。
- **M10** CONFIG 误判永久失去补打资格：`feie.ts:47` 的关键字含「签名」，服务器时钟漂移会让 `sig` 的 `stime` 超窗 → 判 CONFIG → 直接 FAILED 且**永久**排除补打。NTP 修好后仍需逐条手点。这套启发式**唯一承重的分界就是 CONFIG**（CAPACITY/BUSINESS/TIMEOUT 三类走完全相同的重试路径），建议收窄到确定的 ret 码。
- **M11** TIMEOUT 归为可重试，而飞鹅无幂等 token。飞鹅已收单但响应超时时，重试会真的多出一张纸。
- **M12** 票面「今日第 N 单」只在 REPEAT 打，且打的是播报次数不是当日流水（`content.ts:125` + `ticket/index.ts:194`）。NEW_ORDER 票完全没有规格要求的当日流水号；催单票上的「今日第 3 单」实际是「第 3 次催」，店员会读成流水号。
- **M13** `expirePointsBatch` 事务内 CAS 只比 `remaining` 没复核 `expiresAt`，与 `extendLivePoints` 有亚秒级竞争窗口。概率极低，修法是 CAS 的 where 补一条。
- **M14** `handleSendFailure` 用绝对值写 `attempts`（读-改-写），B6 修好后自然消失，仍建议改 `increment`。
- **M15** `getMemberSettings()` 用全局 `prisma` 在退款事务内调用，缓存未命中时会在持有事务的同时另占连接。本店退款量极低，风险很小。
- **M16** `summary.expiringSoon` 只在到期前 30 天内非空，而定稿文案要求会员中心**常驻**显示「若 1 年内无消费，您的 N 分将于 X 月 X 日全部过期」。M4 渲染时会拿不到 `expiresAt`，需要一个账户级 `pointsExpireAt`。
- **M17** 文档三处与代码不符：`api.md` 附录 D 的「已知缺口」段（拒单不出票）已被 `cb27694` 作废；附录 E 列了一个不存在的发分钩子 `autoCompleteShippedOrders`；附录 E 对退款扣回失败的兜底描述「靠微信回调重试补」不成立——`refund-complete` 那条路没有任何微信重试。

---

# 复核方明确排除的（不要再派人查）

**会员侧**：余额写不成负数（四条写路径逐条验过）；Σ 与余额不会永久漂移；
`consumePoints` 两轮重取在快照隔离下只会少扣不会多扣；`/member/*` 五个端点无越权
（全部 `req.userId!`，两个 POST 的 body 只收 `templateId`，限流是用户维度）；
`settlePoints` 确实做到「永不向调用方抛错」；`@@unique([type,refType,refId])` 五组 refId 各自全局唯一不会串号；
`settlePoints` 的 P2002 分支不会误吞（MySQL 下重复键会阻塞到对方提交，所以 P2002 只在对方已提交时出现）；
「用实际扣掉的量而非目标值减余额」这条加固是**必需的**，正是它让不变式恒成立。

**出票侧**：测试钩子生产不可达（三层独立防护，且 `NODE_ENV=production` 已核实）；
`enqueueOrderTicket` 作为 async 函数，体内同步抛出会变成 rejected promise，
**不会打挂微信回调应答**（问题只在 H3 的调用顺序）；
5000 字节的 UTF-8 假设风险很低（固定段最坏约 1.2KB，永远到不了 5000；
按 GBK 算的话当前实现只是更保守，是安全方向）；
`repeatAnnounce` 的 CAS 原子性与停止条件正确，不存在无限播报；
工作台状态灯最坏陈旧度约 93 秒，「最差者胜」的归并方向保守正确；
同城短地址在拆分字段缺失时的回退正确；32 列对齐在现实金额范围内不会串行。

**合并与上线**：新迁移对既有数据安全（三条 ALTER 全带 DEFAULT 或可空，
外键全建在本次新建的空表上）；回滚安全（纯 additive，旧代码打新库可用）；
新代码 + 生产现有配置能起来（`FEIE_*` 与会员相关全是 optional）；
新定时任务不会给历史订单出小票（`printer` 默认 `enabled:false`，`print_jobs` 生产是空表，
`repeatAnnounce` 只扫 `status='PAID'`）；scheduler 六个新任务各自 try/catch 不会互相拖垮；
`e2e.sh` 那次自动合并没有顺序隐患（两段顺序追加、段号不重复、各自备份复位设置、无共享可变状态）。

---

# 待 PO 决定 / 待实验

1. **会员积分默认开关**（B3 第 2 点）。建议默认 `false`：顾客端五页要到 M4 才有，
   现在发分顾客看不见；且积分价尚未按 rate=100 重定。等 M3 设置页做好由店主打开。
2. **实验 E1（需要 PO 在店里做）**：断开打印机网络 → 后台点「打印测试页」→
   记录 ① 接口返回成功还是失败 ② 恢复网络后那张票会不会自己吐出来。
   **若答案是「返回成功且恢复后自动吐出」**，说明飞鹅在云端排队、离线不会让 `print()` 失败，
   那么 H5 连同整套「离线→重试→FAILED→恢复补打」都建立在错误前提上：
   PrintJob 会走 SENT 而非 FAILED，而规格 §8b 要求的 `Open_delPrinterSqs`
   （恢复前丢弃 30 分钟前的旧单）**全仓没有实现**，店里会在恢复瞬间收到一叠过期小票。
   **这个实验的结果会改写 H5 的修法，所以 H5 应排在实验之后。**
3. **实验 E4**：真机联调时用「退款」Tab 退一笔一分钱订单，看 `Refund.wxResponseData` 的 `status`。
   若是 `SUCCESS`，B1 就是 100% 复现而非概率事件。
