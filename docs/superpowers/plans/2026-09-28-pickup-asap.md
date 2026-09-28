【工序】规划 【模型】Opus 5.5 【等级】L

> 方案目标文件：`docs/superpowers/plans/2026-09-28-pickup-asap.md`。规划者不改仓库文件，本文件由编排者原样落盘并提交。
> BASE = `72d441f00317e843fc7f4c13f848435b60f17352`；worktree = `/Users/yumingyi/food-shop/.claude/worktrees/pickup-asap`（下文记作 `$WT`）。
> 店主已确认的预览：`docs/superpowers/previews/2026-09-28-pickup-asap.html`。

# 硬条款

## 目标

到店自取新增「尽快取」：营业中顾客不选时段直接下单，服务端按下单时刻算出预计可取时间写进 `pickupAt`，并用新列 `pickupAsap=true` 标记这是尽快单。尽快单在店家接单前可自助秒退，一接单顾客侧就既不能取消、也没有「申请取消」入口。票面、工作台、后台订单页、企微推送、小程序结算页和订单详情都按尽快单展示。预约自取的行为，以及老版本小程序发来的请求，都与 BASE 逐字节一致。

## 验收标准

**运行环境（每条命令都在这个环境下跑，输出里写明）**
- cwd 一律用 `$WT` 下的绝对路径，不 cd 到主仓 `/Users/yumingyi/food-shop`。
- 本 worktree **没有自己的 `node_modules`**，依赖从主仓 `/Users/yumingyi/food-shop/node_modules` 往上解析，Prisma client 也和主仓共用。**禁止**在本 worktree 直接跑 `npx prisma generate`，那样会覆盖所有会话共用的 client。必须先做私有 client（配方见「实现建议·步骤 0」）；改了 schema 就重新做一次。
- 服务端相关命令一律加 `TZ=Asia/Shanghai`。起服务时带上 `SCHEDULER_DISABLED=true`，并把 `ORDER_NOTIFY_WECOM_WEBHOOK`、`ORDER_NOTIFY_PUSHPLUS_TOKEN`、`SYSTEM_ALERT_WECOM_WEBHOOK`、`SYSTEM_ALERT_PUSHPLUS_TOKEN` 置空。worktree 没有 `apps/server/.env`，要先 export `DATABASE_URL`（指向自己新建的库）、`JWT_SECRET`、`ADMIN_JWT_SECRET`（各 ≥16 位）和全部 mock 开关，再起服务。起服务后先确认连的是自己的库，再开始测试。
- 进程只杀自己记下 PID 的，不用 pkill/killall。搜索用 `command grep`（`grep` 是 ugrep 别名）。本机没有 `timeout`。

1. `command grep -c pickupAsap /Users/yumingyi/food-shop/node_modules/.prisma/client/index.d.ts` → `0`（共用 client 没被动过）；`command grep -c pickupAsap $WT/node_modules/.prisma/client/index.d.ts` → ≥1（私有 client 已生效）。
2. `cd $WT/apps/server && TZ=Asia/Shanghai npx tsc --noEmit` → 退出码 0，无输出。
3. 在自己新建的空库上：`cd $WT/apps/server && npx prisma migrate deploy` → 包括新迁移在内全部 applied；接着 `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` → 退出码 0，库与 schema 无漂移；`SHOW COLUMNS FROM orders LIKE 'pickup_asap'` → `tinyint(1) | NO | 默认 0`。
   人工检查：新迁移目录下的 `migration.sql` 只有一条 `ALTER TABLE \`orders\` ADD COLUMN \`pickup_asap\` ... NOT NULL DEFAULT false`（MySQL 写作 `BOOLEAN`/`TINYINT(1)` 都算）→ 没有其他语句。
4. `cd $WT/apps/server && TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-pickup-asap.ts` → 0 失败，并覆盖下文「测试用例」A 组的每一条（每条用例名写明对应编号）。
5. 既有自测不回归，0 失败，通过条数不少于 BASE：`selftest-pickup.ts`（BASE 30）、`selftest-ticket-schedule.ts`（BASE 8）、`selftest-schedule.ts`（BASE 20）、`selftest-member.ts`（BASE 68）、`selftest-promotion.ts`（BASE 26）。都用 `TZ=Asia/Shanghai npx ts-node --transpile-only scripts/<名>.ts` 跑。
6. `cd $WT && npm run test:miniapp` → `fail 0`，`tests` ≥ 405 + 本次新增条数；新增用例覆盖下文 D 组。
7. `cd $WT/apps/admin && npm test` → `fail 0`，`tests` ≥ 224 + 本次新增条数；新增用例覆盖下文 C 组的纯函数部分。
8. `cd $WT/apps/admin && npm run build` → 退出码 0（会依次跑 check-admin-timezone、tsc、vite build）。
9. `cd $WT && node scripts/check-miniapp-es5.mjs apps/miniapp/pages/local/pickup.js apps/miniapp/utils/pickup-checkout-state.js apps/miniapp/utils/local-catalog.js <本次新增的所有小程序 .js>` → `全部通过`。`pages/order/detail.js` 在 BASE 就不是 ES5，不列入。
10. 既有测试没有被删改：`cd $WT && git diff 72d441f -- tests/miniapp scripts/e2e.sh scripts/e2e.d apps/server/scripts 'apps/admin/src/*.test.ts' | command grep -cE '^-[^-]'` → `0`（只允许追加，不允许删改既有行）。
11. e2e 全量：新建空库，migrate deploy + seed，用 mock 环境在自选端口起服务，然后跑 `cd $WT && TZ=Asia/Shanghai BASE=http://localhost:<端口> DB_NAME=<库名> bash scripts/e2e.sh`。期望末尾汇总 `FAIL=0`，新分片 `scripts/e2e.d/79-pickup-asap.sh` 覆盖下文 B 组全部条目。只有已知偶发项变红（`e2e.d/42` B4-1 五并发领券、`e2e.d/45` 打印机 4 条）时，再重跑一次全量，贴出两次原始汇总。其他任何红都不算通过。
12. 人工检查（编排者或店主真机走查，提审前做）：在微信开发者工具或真机上，按预览文件的 ①–⑤ 五个画面逐一对照：营业中默认选中尽快取并显示「约 N 分钟 / 预计 HH:mm 可取」；改选预约后和现在一样；打烊、午休或本段来不及时尽快取置灰；接单前详情显示取消按钮；接单后显示「店家已接单，不可取消」，且没有取消和申请取消按钮。判定标准：五个画面的文案、可点性都与预览一致。

## 既有检查

- `cd apps/server && npx tsc --noEmit`（来源：`apps/server/package.json` 的 `build: tsc`；`scripts/deploy.sh:145` 的 `npm run build -- --outDir dist.next`）
- `cd apps/server && npx prisma migrate deploy`（来源：`scripts/deploy.sh:150`）
- `npx prisma generate`（来源：`scripts/deploy.sh:142`；本地用「私有 client」配方代替，见步骤 0）
- `cd apps/admin && npm run build`（来源：`apps/admin/package.json` 的 build = `node ../../scripts/check-admin-timezone.mjs && tsc && vite build`；`scripts/deploy.sh:253` 的 `npm run build:admin`）
- `cd apps/admin && npm test`（来源：`apps/admin/package.json` 的 test）
- `npm run test:miniapp`（来源：根 `package.json`）
- `node scripts/check-miniapp-es5.mjs <files>`（来源：`scripts/check-miniapp-es5.mjs`，把守新增的和已是 ES5 的小程序文件）
- `TZ=Asia/Shanghai BASE=… DB_NAME=… bash scripts/e2e.sh`（来源：`scripts/e2e.sh`，末尾还会跑 `scripts/check-channel-consistency.mjs`（:2550）和 `scripts/check-points-consistency.mjs`（:2553））
- 服务端纯函数自测 `apps/server/scripts/selftest-{pickup,ticket-schedule,schedule,member,promotion}.ts`（来源：各文件头注释的用法）
- 仓库没有 git 钩子（`.git/hooks` 只有 sample，`core.hooksPath` 未设置），也没有 CI 配置（没有 `.github/`）。

## 影响范围

- 数据：`Order.pickupAt`（`apps/server/prisma/schema.prisma:324`）语义扩展，尽快单里它是「预计可取时刻」；新增 `Order.pickupAsap`。引用 pickupAt 的地方（模块：server）：
  - `routes/orders.ts:86-96` pickupViewOf、`:102-120` canSelfCancelOf、`:130-150` cancelWindowOf、`:171-174,204` 下单 schema、`:236` orderCreatedView、`:294-307` 自取校验、`:674` 落库、`:946` 详情、`:975-985,997` 申请取消、`:1100-1128` 自助取消 timed 分支、`:1129-1138` 立即单分支、`:1172-1177` 兜底报错、`:1288-1291` mock 支付来单推送
  - `routes/wechat-notify.ts:282-285`（真实支付回调的来单推送文案）
  - `services/pickup-tasks.ts:19-33` 未接单催单、`:35-53` 过时未取、`:55-76` 自动完成
  - `services/ticket/index.ts:152-189,219-227`（票面输入）、`:716-720,737-738`（repeatAnnounce 的自取门槛和营业门控）
  - `services/ticket/content.ts:70-82,352,369-378`（取餐联、明日单戳）
  - `services/order-notify.ts:58`（自取新订单标题）、`:322-346`（未取、自动完成的 slotLabel）
  - `services/subscribe-message.ts:259-283`（取餐提醒 pickupTime；本批行为不变）
  - `routes/admin/workbench.ts:119-131`（卡片 pickup 节）、`:139-156` sortColumn、`:213-215`（prepStartAt/slotLabel）
  - `routes/admin/orders.ts:51`（列表 select；详情是整行 include，会自动带上新列）
  - `services/scheduler.ts:263`（remindUnacceptedOrders 排除 PICKUP；**不改**，自取催单继续走 pickup-tasks）
- 新增公共计算（`services/pickup.ts`）被 `routes/local.ts:24-47`（meta 与 pickup-slots）和 `routes/orders.ts` 下单共用。
- 后台（模块：admin）：`src/types.ts:244-246`（Order）、`:837-848`（WorkbenchCard.pickup）；`src/utils/pickup.ts:17-54`；`src/utils/order-list.ts:62-75`；`src/components/orders/detail/DetailCustomer.tsx:36-41`；`src/pages/Workbench.tsx:64`（ChannelBadge）、`:243-300`（紧急度、pickupCapsule）、`:1223-1227`（卡片取餐行）、`:2111-2115`（抽屉取餐信息）。
- 小程序（模块：miniapp）：`pages/local/pickup.{js,wxml,wxss}`；`utils/pickup-checkout-state.js:61-84`；`utils/local-catalog.js:87-113` headNoticeOf，它是共享函数，调用方有 `components/local-store-header/index.js:43`、`pages/product/list.js:166,667`、`pages/cart/index.js:83`、`pages/local/pickup.js:142`；`pages/order/detail.js:278-284,329-411,684-700`；`pages/order/detail.wxml:34-39,107-127,350-353`。
- 按字符串匹配或契约依赖的东西：错误码 42280/42281/42282（小程序 `pages/local/pickup.js:493,502` 按码分派；新增 42285）；下单 zod 报错文案「请选择取餐时间并填写取餐人手机号」（`orders.ts:204`，老客户端可能按文案匹配，必须逐字不变）；`sortColumn`/`SortableCard` 被 `scripts/selftest-schedule.ts:11` import；`ticketLabel` 的返回形状被 `selftest-pickup.ts:101-103` 深比较（**不得改**）；票面 `<B>` 放大行 ≤16 列（`content.ts:120` BIG_LINE_WIDTH，`selftest-ticket-schedule.ts` 校验）。
- 回归测试：
  - `TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-{pickup,ticket-schedule,schedule,member,promotion}.ts`
  - `npm run test:miniapp`（重点：`tests/miniapp/pickup-checkout-state.test.cjs`、`pickup-page.test.cjs`、`local-catalog.test.cjs`、`closed-schedule-hints.test.cjs`、`order-channel.test.cjs`、`order-status-tag.test.cjs`）
  - `cd apps/admin && npm test`（重点：`src/utils/pickup.test.ts`、`src/utils/order-list.test.ts`）
  - e2e 全量（重点分片：`62-pickup`、`63-packing-fee`、`64-tableware`、`65-product-sort`、`66-promotion`、`69-scheduled-delivery`，这几片都按预约口径建自取单，必须不改一行照样全绿）

## 测试用例

（L 级：下面是必须覆盖的行为，具体用例由执行者设计。A 进服务端新自测，B 进 e2e 新分片 79，C 进后台单测，D 进小程序单测。）

**A. 纯函数（注入 now 与设置，不依赖真实时钟）**
- A1 常规：营业 10:00–14:30，prep 15、buffer 5，高峰 12:00–13:00（上限 30），11:20:00 → available，minutes=20，readyAt=11:40。
- A2 高峰判定看取餐时刻：11:45 → 按 prep 算的临时取餐时刻 12:05 落在高峰 → 改用高峰上限 30+5 → readyAt=12:20，minutes=35。11:20 → 11:40 不在高峰 → 20。
- A3 取整：11:20:31 → readyAt 向上取整到分钟 = 11:41:00。
- A4 本段来不及：14:05 → 14:25 < 14:30 → available；14:10:01 → 取整后 14:31 ≥ 14:30 → reason=TOO_LATE；恰好等于段结束 → TOO_LATE（严格小于才可用）。
- A5 不在营业段：09:50、14:40（午休）、20:00（打烊）→ reason=CLOSED。
- A6 休业 → HOLIDAY；自取暂停（until 为空或在未来）→ PAUSED；未开通 → DISABLED；外送暂停但自取未暂停 → 不影响（仍可 available）。
- A7 今日已约满：daysAhead=0 且今天已无可选格（earliestPickupInfo 为 NONE）→ reason=NONE。
- A8 票面：尽快单的取餐联放大行是「尽快取 约 HH:mm」，宽度 ≤16 列，不盖明日单戳，也不出日期行；预约单票面与 BASE 逐字节一致（同一输入对比 BASE 的输出字符串）。
- A9 sortColumn：同一列、同为 PICKUP 时，非 done 列里尽快单排在预约单前面；done 列口径不变；原有的 LOCAL 预约排序用例不回归。
- A10 文案 helper：尽快单的取餐文案（工作台、企微、未取提醒共用那一个）是「尽快取 约 HH:mm」，预约单仍是 `slotLabel()` 原样输出。

**B. e2e（分片 `scripts/e2e.d/79-pickup-asap.sh`，变量统一加 `P79_` 前缀，收尾把设置恢复成进来时的样子）**
- B1 `/api/local/pickup-slots` 和 `/api/local/meta` 的 `pickup.asap` 结构齐全；营业时段覆盖当前时刻时 available=true、readyAt 与 now+minutes 相差不到 2 分钟；把营业时段改成不含当前时刻 → available=false、reason=CLOSED；未开通、暂停、休业各返回对应 reason。
- B2 下单 `pickupMode:"ASAP"`、不带 pickupAt → code 0，返回 `pickupAsap=true`，`pickupAt` 等于服务端算出的 readyAt（与下单前查到的 readyAt 相差 ≤1 分钟）；落库 `pickup_asap=1`。
- B3 ASAP 同时带 pickupAt → 40001；ASAP 不在营业段 → 42285，库存和券都没扣（下单前后的库存、券状态对比）；未开通、暂停、休业仍然报 42280。
- B4 老客户端兼容：不传 pickupMode、只传 pickupAt → 走预约口径（落库 `pickup_asap=0`，时段校验照旧，报错码和文案不变）；deliveryType 不是 PICKUP 却带 pickupMode → 40001。
- B5 付款后未接单：详情 `canSelfCancel=true`、`canRequestCancel=false`、`pickup.asap=true`；`PUT /cancel` → code 0，订单进入 REFUNDING/REFUNDED（mock），出了 CANCEL 票（这一段把打印机设成启用的 mock 打印机，或者按 62 分片现有的打印断言方式断言）。
- B6 付款后已接单（通用 `/admin/orders/:id/accept`）：详情 `canSelfCancel=false`、`canRequestCancel=false`；`PUT /cancel` → 42204，订单状态不变；`POST /cancel-request` → 42229，`cancel_requested_at` 仍为 NULL。用 sql 把 pickup_at 改到任意时刻（过去或未来 3 小时后）重复一遍，结论不变（证明不走 selfCancelLeadMin 口径）。
- B7 并发：同一张 PAID 尽快单，同时发 `PUT /cancel` 和 `/admin/orders/:id/accept` → 恰好一个成功；成功的是取消就是 REFUNDING 且 accepted_at 为 NULL，成功的是接单就是 PREPARING 且没有退款行。
- B8 店家后台主动退款不受影响：已接单的尽快单 `POST /admin/orders/:id/refund` → code 0。
- B9 催单：尽快单 PAID、付款时刻回拨到 16 分钟前 → `sched` 一次后 `accept_reminded_at` 非空；回拨 10 分钟时仍为空（与同城立即单同一口径：付款 + 15 分钟）。
- B10 过时未取和自动完成沿用现有规则：SHIPPED 的尽快单 pickup_at 回拨超过 unpickedRemindAfterMin → 提醒打标；超过 autoCompleteAfterMin → COMPLETED。
- B11 工作台快照：尽快单卡片 `pickup.asap=true`；pending 列里，同为自取的尽快单排在当天较晚取餐的预约单前面。
- B12 NEW_ORDER 票内容（PrintJob.content）含「尽快取 约 HH:mm」，不含「【明日单】」。
- B13 预约自取回归：同一分片里按预约口径下一单，详情 `pickup.asap=false`，`canSelfCancel`、`canRequestCancel` 与 62 分片相同情形下的结论一致。

**C. 后台**
- C1 `order-list.ts` deliveryColumn：尽快单第一行显示「尽快取 约 HH:mm」，预约单仍是「取餐 HH:mm」。
- C2 工作台 pending 列的尽快单从付款时刻开始计等待，不出现「HH:mm 开始备餐」胶囊；备餐中显示「距取餐 N 分」/超时，紧急度沿用现有阈值；卡片和抽屉徽标或取餐行能看出「尽快」。
- C3 后台订单详情（DetailCustomer）：尽快单显示「尽快取 · 预计 HH:mm」，不显示「预约取餐」。

**D. 小程序**
- D1 pickupCheckoutAction：不传新入参时，对 BASE 的所有既有输入输出逐字节一致（既有测试不改即绿）。
- D2 尽快模式：不需要时段也能提交，前提是 asap 可用、手机号合法、达到起送、餐具已选；尽快模式下 asap 变成不可用时，按钮不能落到 submit（要么禁用，要么动作是切回预约或重新选择）。
- D3 结算页：pickup-slots 返回 asap.available=true → 默认选中尽快取；false → 尽快取置灰，默认停在预约模式且时段**不自动预选**（沿用 2026-09-17 规则）；老服务端没有 asap 字段 → 页面行为与 BASE 一致（只有预约）。
- D4 提交载荷：尽快取带 `pickupMode:'ASAP'`、不带 pickupAt；预约带 pickupAt。切换模式后换一个新的 clientRequestId。
- D5 42285：弹提示、重拉时段、切回预约模式、清掉已选时段。
- D6 headNoticeOf：meta.pickup.asap.available=true 时，自取模式不再出「现在下单为预约自取…」（非阻塞，文案为空）；asap 缺失或不可用时与 BASE 逐字节一致；blocking 取值在任何输入下都与 BASE 一致。
- D7 订单详情：尽快单显示「尽快取 预计 HH:mm 可取」；PAID 且可取消时提示「店家接单前可随时取消，取消后原路退款」，有取消按钮；接单后显示「店家已接单，不可取消」，没有取消和申请取消按钮；预约单的展示与 BASE 一致。

## 关键决定

- **数据模型**：`orders` 加一列 `pickup_asap BOOLEAN NOT NULL DEFAULT false`（Prisma 字段 `pickupAsap`）。尽快单的 `pickupAt` 存预计可取时刻，**自取单的 pickupAt 永不为空**。存量数据都是 false，就是预约单。只加列，回滚代码不用回滚库。
- **下单契约**：`POST /api/orders` 新增可选 `pickupMode: 'ASAP' | 'SCHEDULED'`，不传就是 SCHEDULED。只有 `deliveryType=PICKUP` 能带它，否则报 40001。ASAP 时 `pickupAt` 必须不传（传了报 40001），`pickupContact` 仍然必填。SCHEDULED（含不传）时，校验、报错码、报错文案与 BASE 逐字节一致。
- **可用性与预计时刻（服务端唯一实现，在 `services/pickup.ts`，结算页、meta、下单三处共用）**：设 now 为此刻，B=`pickup.acceptBufferMin`。先用 P=`prepMinutes` 算临时取餐时刻 now+P+B；它落在高峰窗口里（`minutesInPeak`）就把 P 换成 `peak.prepMaxMinutes`。`readyAt = ceil到整分(now + P + B)`，`minutes = P + B`。可用条件（按下面顺序判，第一个不满足的就是 reason）：自取已开通（DISABLED）→ 今天不休业（HOLIDAY）→ 自取没有暂停（PAUSED）→ now 落在某个营业段 [start,end) 内（CLOSED）→ daysAhead 内至少有一格可选，即 earliestPickupInfo 不是 NONE（NONE，对应店主说的「今日已约满」）→ `readyAt < 该营业段 end`，严格小于（TOO_LATE）。**外送暂停不影响尽快取**。
- **对外结构**：`GET /api/local/pickup-slots` 和 `GET /api/local/meta` 的 `pickup` 节都新增 `asap: { available: boolean; readyAt: string|null; minutes: number|null; reason: null|'DISABLED'|'PAUSED'|'HOLIDAY'|'CLOSED'|'NONE'|'TOO_LATE' }`（不可用时 readyAt、minutes 为 null）。已有字段一个不动。
- **下单时的校验顺序**：沿用现有的 42280（未开通、休业、暂停，文案不变）→ 尽快不可用（CLOSED/NONE/TOO_LATE）报 **42285**（新码，文案按 reason 区分）→ 42282 起送门槛 → 券。42285 必须在任何库存和券的写操作之前报出。
- **预计时刻只在下单时算一次**，付款时、接单时都不重算（店主定的是「下单时刻」，预览里接单前后显示同一个时刻）。见「待用户决定」Q2。
- **取消规则（顾客侧）**：尽快单 PENDING_PAYMENT 可取消，与 BASE 一致。PAID 且 `acceptedAt` 为空 → 可自助秒退，走 `orders.ts:1129-1138` 的立即单分支（条件写 `status='PAID' AND accepted_at IS NULL`，与接单互斥）。接单后 `canSelfCancel=false`、`canRequestCancel` 恒为 false，`/cancel` 报 42204，`/cancel-request` 报 42229，都不改任何列。尽快单**不进** timed 分支，不看 `selfCancelLeadMin`。店家后台退款、拒单、售后路由都不改。
- **催单口径与同城立即单一致**：企微催单在付款 + `ACCEPT_REMIND_AFTER_MIN` 触发；repeatAnnounce 从付款时刻起算，用 `repeat.localAfterMin`，并且**不受 `shopOpen` 门控**（与 LOCAL 相同）。预约自取的催单口径不变。
- **票面**：尽快单取餐联的放大行是「尽快取 约 HH:mm」（≤16 列），不盖日期戳，不出日期行。预约单票面逐字节不变。`ticketLabel` 的返回形状不改。
- **不新增任何设置项**：尽快取跟随 `pickup.enabled`、暂停、休业、营业时间。
- **不做**「已备好推送顾客」的新逻辑（现有的 `sendPickupReadySubscribeMessage` 保持原样，对尽快单照常生效）。

## 授权范围

```
apps/server/prisma/schema.prisma
apps/server/prisma/migrations/*pickup_asap*
apps/server/src/routes/orders.ts
apps/server/src/routes/local.ts
apps/server/src/routes/wechat-notify.ts
apps/server/src/routes/admin/workbench.ts
apps/server/src/routes/admin/orders.ts
apps/server/src/services/pickup.ts
apps/server/src/services/pickup-tasks.ts
apps/server/src/services/slots.ts
apps/server/src/services/order-notify.ts
apps/server/src/services/ticket/index.ts
apps/server/src/services/ticket/content.ts
apps/server/scripts/selftest-pickup-asap.ts
apps/server/scripts/selftest-schedule.ts
apps/server/scripts/selftest-ticket-schedule.ts
scripts/e2e.d/79-pickup-asap.sh
apps/admin/src/types.ts
apps/admin/src/utils/pickup*.ts
apps/admin/src/utils/order-list*.ts
apps/admin/src/components/orders/detail/*
apps/admin/src/pages/Workbench*
apps/miniapp/pages/local/pickup.*
apps/miniapp/pages/order/detail.*
apps/miniapp/utils/pickup-checkout-state.js
apps/miniapp/utils/pickup-asap*.js
apps/miniapp/utils/local-catalog.js
tests/miniapp/*
docs/api.md
docs/order-flow.md
docs/staff-guide.md
docs/superpowers/*
```

## 禁止修改

```
.agent/*
.claude/*
CLAUDE.md
package.json
package-lock.json
apps/*/package.json
.env.example
scripts/deploy.sh
scripts/set-env.sh
scripts/import-secrets.sh
scripts/e2e.sh
scripts/e2e.d/0*
scripts/e2e.d/1*
scripts/e2e.d/2*
scripts/e2e.d/3*
scripts/e2e.d/4*
scripts/e2e.d/5*
scripts/e2e.d/6*
scripts/e2e.d/70*
scripts/e2e.d/71*
scripts/e2e.d/72*
scripts/e2e.d/74*
scripts/e2e.d/75*
scripts/e2e.d/76*
scripts/e2e.d/77*
scripts/e2e.d/78*
apps/server/prisma/migrations/migration_lock.toml
apps/server/prisma/migrations/20260[5-8]*
apps/server/prisma/migrations/2026090*
apps/server/prisma/migrations/2026091*
apps/server/prisma/migrations/2026092[0-4]*
apps/server/src/config.ts
apps/server/src/middlewares/*
apps/server/src/services/refund*.ts
apps/server/src/services/wechat-pay*.ts
apps/server/src/services/member/*
apps/server/src/services/promotion.ts
apps/server/src/services/packing-fee.ts
apps/server/src/services/delivery/*
apps/server/src/services/local-settings.ts
apps/server/src/services/scheduler.ts
apps/server/src/services/subscribe-message.ts
apps/server/src/routes/admin/after-sales.ts
apps/server/src/routes/admin/delivery.ts
apps/server/scripts/selftest-pickup.ts
apps/server/scripts/selftest-member.ts
apps/server/scripts/selftest-promotion.ts
```

## 上报条件

- 要改禁止清单里的文件，或者改授权范围外的文件（特别是 `local-settings.ts`、`scheduler.ts`、`refund*.ts`、`subscribe-message.ts`）。
- 既有测试或 e2e 分片（含 62–69）要删改任何一行断言才能通过，或者不改代码就过不了。
- 发现预约自取、邮寄、同城外送的任何既有行为必须跟着变（包括报错码、报错文案、票面字符串、接口已有字段）。
- 迁移除了给 `orders` 加 `pickup_asap` 还要别的语句，或者要回填存量数据。
- 私有 Prisma client 配方做不成，只能在共用 client 上 generate。
- 实现中发现店主规则之间自相矛盾（例如「今日已约满」和「本段来不及」给出相反结论），或者预览里的某个画面按本方案做不出来。
- 需要触碰生产（ssh/scp）、部署、合并 main，或者需要 npm install。

## 待用户决定

- **Q1 尽快单取走后还能不能申请售后？** 现在所有自取单在「已备好/已取走」后都能申请售后（少发、错发、变质，店员审核后退款），入口在 `orders.ts:1193-1225`（POST /:id/after-sale），展示条件在详情 `canApplyAfterSale`。店主说「只要接单就不可退款」，预览只讲了取消。
  - A（建议）：售后不变。它处理的是出品质量问题，跟「接单后不能反悔取消」是两回事，与预约自取一致。方案按 A 写，零额外改动。
  - B：尽快单连售后也关掉。顾客遇到少发、变质只能打电话，由店家后台退款。要多改售后入口和详情展示，这部分属于高风险路径 `routes/orders.ts`。
- **Q2 预计可取时间在下单时算还是付款时算？** 下单后最长 15 分钟内付款都有效（`PAY_TIMEOUT_MIN`）。按下单时刻算，拖到最后才付款的单，票上「约 11:40」离付款可能只剩 5 分钟，后厨会被压时间，顾客看到的时刻也偏早。
  - A（方案现按此）：只在下单时算。实现简单，结算页、详情、票面三处时刻完全一致。
  - B：付款成功时重算成 max(原预计, 付款时刻 + 备餐 + 缓冲)。更准，但顾客在结算页看到的时刻可能跟付款后的不一样，而且 mock 支付和真实回调两条路径都要写库（`wechat-notify.ts` 属于高风险路径）。

# 实现建议（执行者可调整）

## 步骤

0. **私有 Prisma client（先做，schema 一改就重做）**
   ```bash
   WT=/Users/yumingyi/food-shop/.claude/worktrees/pickup-asap
   TD=/private/tmp/claude-501/-Users-yumingyi-food-shop/1ea94700-3881-4214-9638-2f2669d4f9b1/scratchpad/task-asap-pickup.OG61
   mkdir -p "$WT/node_modules/@prisma"
   [ -d "$WT/node_modules/@prisma/client" ] || cp -R /Users/yumingyi/food-shop/node_modules/@prisma/client "$WT/node_modules/@prisma/client"
   perl -pe 's|^generator client \{|generator client {\n  output = "'"$WT"'/node_modules/.prisma/client"|' "$WT/apps/server/prisma/schema.prisma" > "$WT/apps/server/prisma/.schema.local.prisma"
   (cd "$WT/apps/server" && npx prisma generate --schema prisma/.schema.local.prisma)
   rm "$WT/apps/server/prisma/.schema.local.prisma"   # 它不在 .gitignore，留着会被范围检查判越界
   ```
   `node_modules/` 已在 .gitignore 里。Node 会先命中 worktree 自己这层 `node_modules/@prisma/client`（是真拷贝，不是软链），从而遮住主仓的共用 client。生成完用验收 1 自检。
   迁移用 `npx prisma migrate dev --create-only --name order_pickup_asap` 需要 shadow 库，太麻烦。更简单的做法是手写 `prisma/migrations/20260928000000_order_pickup_asap/migration.sql`，再用验收 3 的 `migrate diff --exit-code` 证明它与 schema 一致。
1. **计算层**（`services/pickup.ts`）：新增 `pickupAsapInfo(s, now)`，按「关键决定」给出 available/readyAt/minutes/reason；新增一个取餐文案 helper，例如 `pickupTimeLabel({pickupAt, pickupAsap}, s, now)`：尽快单返回「尽快取 约 HH:mm」，预约单原样返回 `slotLabel`。工作台、企微推送、未取提醒、自动完成都走这个 helper。营业段判定照抄 `earliestPickupInfo` 里的 `currentWindow` 写法（`local-settings.ts` 的 `inHours` 没导出，也不在授权范围）。
2. **公开接口**（`routes/local.ts`）：pickup-slots 返回 `{ ...buildPickupSlots(...), asap }`；meta 的 pickup 节补 `asap`，与现有 `earliestPickupWhen` 的补法相同。**不要改 `publicLocalMeta`**：`local-settings.ts` 不能 import `pickup.ts`，否则循环依赖。
3. **下单**（`routes/orders.ts`）：schema 加 `pickupMode`，把 `:204` 那条 refine 拆开，保证老文案逐字不变。PICKUP 分支里 ASAP 走 `pickupAsapInfo(s, now)`，不可用就抛 42285；可用就把 `pickupSnapshot` 写成 `{ pickupAt: readyAt, pickupAsap: true, pickupDiscountAmount }`。`orderCreatedView` 补 `pickupAsap`。
4. **取消**（`routes/orders.ts`）：`canSelfCancelOf`、`cancelWindowOf`、`PUT /cancel` 的 `timed` 判定、`/cancel-request` 的报错文案都按 `pickupAsap` 分流，见「关键决定·取消规则」。`/cancel-request` 对尽快单的文案建议：PAID 时「商家尚未接单，可直接取消订单」，已接单时「店家已接单，不可取消」。`/cancel` 已接单时建议「店家已接单，不可取消，如有问题请联系商家」，码仍然是 42204。`pickupViewOf` 补 `asap` 字段，尽快单的 `slotLabel` 用新 helper 的文案。
5. **推送、催单、票面**：`orders.ts:1288` 和 `wechat-notify.ts:282` 换成 helper。`order-notify.ts:58` 对尽快单不要拼出「尽快取 约 11:40 取」这种重复的「取」字。`pickup-tasks.ts:28` 对尽快单用付款锚点。`ticket/index.ts:717-720,737` 对尽快单跳过 prepStart 门槛和 shopOpen 门控。`ORDER_SELECT`、`OrderForTicket`、`toTicketInput`、`TicketOrderInput` 各加一个字段（四处都要加，漏一处票面就永远打不出来，而且编译器不会报错，见 `index.ts:162-165` 的注释）。`content.ts` 的取餐联按新字段出单行 `<B>尽快取 约 HH:mm</B>`，并且不盖戳。
6. **工作台**（`routes/admin/workbench.ts`）：卡片 `pickup` 节加 `asap`；`SortableCard` 加可选的 `pickup?: { asap?: boolean } | null`，`sortColumn` 在非 done 列、同为 PICKUP 时让 asap 在前；尽快单的 `prepStartAt` 建议给付款时刻，这样前端 `pickupPendingAnchor` 自然从付款时刻开始计时。
7. **后台前端**：types 加字段；`order-list.ts` deliveryColumn、`DetailCustomer.tsx`、`Workbench.tsx`（徽标或取餐行显示「尽快」、抽屉里的「取餐时段/开始备餐」两行给尽快单换成「预计可取」）。时间一律用 `utils/time.ts`，否则 check-admin-timezone 会拦。
8. **小程序结算页**：`pickup.wxml` 的「取餐时间」卡改成两个选项「尽快取 / 预约时段」，样式抄 `confirm.wxml:48-57`，wxss 自己写一份。尽快取选中时下面显示「预计 HH:mm 可取」和「店家接单后开始备餐；接单前可随时取消，接单后不可取消」。`pickupCheckoutAction` 加 `mode`、`asapAvailable` 两个入参，缺省时走老路径。`loadSlots` 处理 `view.asap`：第一次拉到时按 available 决定默认模式；之后刷新时，如果顾客选的是尽快取而它已经不可用，就切回预约并提示。`doSubmit` 的守卫（`pickup.js:443`）按模式放行。`handleSubmitError` 加 42285。
9. **小程序详情**：`pickupHintOf`、`decorateOrder` 按 `order.pickupAsap`（或 `order.pickup.asap`）分支，出预览 ④⑤ 的文案；`showLocalCancelUnavailable` 分支对尽快单给「店家已接单，不可取消」。
10. **headNoticeOf**：在 `when === 'LATER'` 分支之前加一句：`pk.asap && pk.asap.available` 时返回 `{ text: '', blocking: false }`。storeStatusOf 不动（营业段内本来就显示「营业中」）。
11. **文档**：`docs/api.md` 补 `pickupMode`、`asap` 结构、42285、详情 `pickup.asap`；`docs/order-flow.md` 补尽快单的取消和催单口径；`docs/staff-guide.md` 补店员怎么看尽快单（可选）。
12. **测试**：新写 `scripts/selftest-pickup-asap.ts`（A 组）和 `scripts/e2e.d/79-pickup-asap.sh`（B 组，自取设置照 62 分片的做法先 GET 再改，最后恢复原值）。在 `tests/miniapp` 和 `apps/admin/src/utils/*.test.ts` 追加 C、D 组。e2e 用真实时钟，营业时段要按当前上海时刻动态拼：可用场景用 `00:00–23:59`，并把 prep、buffer 调小（上海 23:30 以后仍可能 TOO_LATE，分片里要判断当前时刻，必要时把可用场景的营业段拼成「现在−1h 到 现在+2h」，跨零点时跳过并打印原因，不能静默算过）。

## 已排除的做法

- **尽快单的 pickupAt 存 NULL（仿同城 `scheduledAt` 为空即立即单）**：排除。自取的取消、申请取消、未取提醒、自动完成、工作台、票面全都以 pickupAt 为基准；`orders.ts:980,1108` 还把「自取单 pickupAt 为空」当数据异常处理。存 NULL 会把这些路径全部改一遍，最后还是得另开一列存预计时刻。
- **不加列，靠「pickupAt 不落在时段格上」推断尽快单**：排除。预计时刻恰好是整半点（如 11:30）时就会误判；店主改 slotMinutes 以后，历史单的判定也会翻转。
- **把预计时刻写进 `estimatedDeliveryAt`**：排除。那是同城外送的列，被同城统计、工作台同城卡片、`delivery.ts` doAccept 读写，混进自取单会污染这些口径。
- **接单时重算预计时刻（仿 `routes/admin/delivery.ts:50-56` 同城立即单的做法）**：排除。店主定的是「下单时刻」，预览接单前后是同一个时刻，而且会让顾客看到的时刻跳动。
- **尽快单沿用 timed 分支，把 selfCancelLeadMin 设成 0 之类**：排除。timed 分支接单后仍可申请取消，并且以约定时刻为界，与「一接单就不可取消」相反。
- **尽快不可用时复用 42281**：排除。小程序对 42281 的处理是「清选择并打开时段选择器」，拿不到原因；也会让 42281 的含义（时段过期）变得含糊。新开 42285。
- **在 `publicLocalMeta`（local-settings.ts）里算 asap**：排除。`pickup.ts` import 了 `local-settings.ts`，反向 import 会循环依赖；现有的 `earliestPickupWhen` 就是在 `routes/local.ts` 里补的，照同样位置补。
- **把尽快单并进 `scheduler.ts` 的 `remindUnacceptedOrders`（去掉 `deliveryType: { not: 'PICKUP' }`）**：排除。那样预约自取也会在付款 15 分钟后被催，破坏「明天的单今晚不催」；应该在 `pickup-tasks.ts` 里按 `pickupAsap` 分流。
- **尽快取也受外送暂停控制（用 `isShopOpenNow`/`isOpenNow` 判营业）**：排除。这两个函数含外送暂停或外送开关；自取有自己的暂停开关，2026-09-23 起自取已不读外送状态（`local-catalog.js:41-49` 注释）。
- **新增「尽快取开关」设置项**：排除，需求里没有，也会牵动后台设置页和 `local-settings.ts`。
- **在 worktree 里直接 `npx prisma generate` 或 `npm install`**：排除。会覆盖主仓共用的 client，打断其他会话。

# 额外发现

- **e2e 分片编号**：`scripts/e2e.d/77-callback-before-landing.sh`、`78-escalation-history.sh` 已经存在，交接里说「用到 76」不准，新分片用 79。
- **「已备好推送顾客」其实已经有实现**：`routes/admin/orders.ts:473` 在点「已备好」时调 `sendPickupReadySubscribeMessage`（`services/subscribe-message.ts:259-283`），模板变量是 `WECHAT_TMPL_PICKUP`、`WECHAT_TMPL_PICKUP_FIELDS`；自取结算页也已经在请求 pickup 模板订阅（`pages/local/pickup.js:95`）。生产没推，多半是这两个环境变量没配。店主要的话，也许只需要去公众平台申请模板、配上环境变量，不用写代码（本批不动）。
- **预约自取的重复播报被「外送暂停」误伤**：`services/ticket/index.ts:707,737` 用 `isShopOpenNow`（含外送暂停 `isPaused`）来门控非 LOCAL 单。外送暂停、自取照常营业时，预约自取单到点后不会重复播报。本方案只让尽快单绕开这道门；预约自取的这个问题没修，另起一批。
- **「今日已约满」基本碰不到**：生产 daysAhead=1，而休业是按「截至某日」覆盖的，今天不休业时明天一定有格，所以 earliestPickupInfo 实际不会返回 NONE。店主列的「今日已约满时尽快取置灰」在生产上基本不会触发，只在 daysAhead=0 时有意义；此时本段尾部（没格但来得及）尽快取会被一起挡掉，与店主的表述一致。
- **预览 ③ 看起来预选了时段**：「明天 10:30–11:00 更改 ›」像是自动预选。现行规则（2026-09-17，`pages/local/pickup.js:207-209` 与 `tests/miniapp/pickup-page.test.cjs` 护栏）是「不自动预选，顾客自己选」，店主又说预约自取现有行为保持不变，所以本方案不预选。店主如果其实想要预选，需要另行确认。
- **后台订单列表的「尽快/预约」筛选**（`routes/admin/orders.ts:147-150`）只针对同城外送，自取尽快单筛不出来。本批不改，店主有需要再加。
- **交接声明缺【模型】字段**，本方案由 Opus 5.5 出，不是协议指定的规划模型 Fable 5.1。按 `.agent/agent-protocol.md` §2.6，这属于降级运行，交付报告要注明。
