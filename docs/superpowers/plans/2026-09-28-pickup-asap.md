【工序】规划 【模型】Opus 5.5 【等级】L

> 方案目标文件：`docs/superpowers/plans/2026-09-28-pickup-asap.md`。规划者不改仓库文件，本文件由编排者原样落盘并提交。
> BASE = `72d441f00317e843fc7f4c13f848435b60f17352`；worktree = `/Users/yumingyi/food-shop/.claude/worktrees/pickup-asap`（下文记作 `$WT`）。
> 店主已确认的预览：`docs/superpowers/previews/2026-09-28-pickup-asap.html`。
> 修订 1（2026-09-28）：店主对 Q2 选了 B「付款成功时重算」，Q1 选了 A「售后照常」。本版据此修订，改动清单见交付报告。
> 修订 2（2026-09-28）：店主确认 Q3=A「照收照做」；真实回调的重算锚点改为 max(微信 `success_time`, 服务器处理该回调的时刻)，mock 仍为服务器当前时刻；`paidAt` 的取值与含义不变。改动清单见交付报告。

# 硬条款

## 目标

到店自取新增「尽快取」：营业中顾客不选时段直接下单，服务端按下单时刻算出预计可取时间写进 `pickupAt`，并用新列 `pickupAsap=true` 标记这是尽快单。**付款成功时**（真实回调和 mock 支付两条路径），在同一事务里把尽快单的 `pickupAt` 重算为 max(原值, 锚点 + 备餐 + 缓冲)。锚点在真实回调里是 max(微信 `success_time`, 服务器处理该回调的时刻)，在 mock 付款里是服务器当前时刻。订单和支付记录的 `paidAt` 仍写原来的值（真实回调写 `success_time`，mock 写服务器当前时刻），锚点只用来算 `pickupAt`。重算只发生一次，回调重推不会再推后，也永远不会往前挪。票面、工作台、详情、推送、催单、未取提醒读到的都是重算后的值。尽快单在店家接单前可自助秒退，一接单顾客侧就既不能取消、也没有「申请取消」入口；售后照常。票面、工作台、后台订单页、企微推送、小程序结算页和订单详情都按尽快单展示。预约自取、同城外送、邮寄的行为，以及老版本小程序发来的请求，都与 BASE 逐字节一致。

## 验收标准

**运行环境（每条命令都在这个环境下跑，输出里写明）**
- cwd 一律用 `$WT` 下的绝对路径，不 cd 到主仓 `/Users/yumingyi/food-shop`。
- 本 worktree **没有自己的 `node_modules`**，依赖从主仓 `/Users/yumingyi/food-shop/node_modules` 往上解析，Prisma client 也和主仓共用。**禁止**在本 worktree 直接跑 `npx prisma generate`，那样会覆盖所有会话共用的 client。必须先做私有 client（配方见「实现建议·步骤 0」）；改了 schema 就重新做一次。
- 服务端相关命令一律加 `TZ=Asia/Shanghai`。起服务时带上 `SCHEDULER_DISABLED=true`，并把 `ORDER_NOTIFY_WECOM_WEBHOOK`、`ORDER_NOTIFY_PUSHPLUS_TOKEN`、`SYSTEM_ALERT_WECOM_WEBHOOK`、`SYSTEM_ALERT_PUSHPLUS_TOKEN` 置空。worktree 没有 `apps/server/.env`，要先 export `DATABASE_URL`（指向自己新建的库）、`JWT_SECRET`、`ADMIN_JWT_SECRET`（各 ≥16 位）和全部 mock 开关，再起服务。起服务后先确认连的是自己的库，再开始测试。
- **真实支付回调段的额外环境（验收 11 用）**：起服务的 shell 和跑 e2e 的 shell 都 export 同一个 `WECHAT_PAY_API_V3_KEY`（恰好 32 字节 ASCII，自拟，例如 `e2e_asap_api_v3_key_32bytes_long`），并且 `WECHAT_PAY_PUBLIC_KEY_PATH`、`WECHAT_PAY_PLATFORM_CERT_PATH`、`WECHAT_PAY_PRIVATE_KEY_PATH` 都**不设**，`WECHAT_PAY_CERT_AUTO_DOWNLOAD=false`。这样 `wechat-notify.ts:69` 走开发环境的跳过验签分支，只解密（`wechat-notify.ts:101-117`、`services/wechat-pay.ts:295-311`）。`WECHAT_PAY_MOCK=true` 照开，mock 支付与真实回调两条路同时可测。
- 进程只杀自己记下 PID 的，不用 pkill/killall。搜索用 `command grep`（`grep` 是 ugrep 别名）。本机没有 `timeout`。

1. `command grep -c pickupAsap /Users/yumingyi/food-shop/node_modules/.prisma/client/index.d.ts` → `0`（共用 client 没被动过）；`command grep -c pickupAsap $WT/node_modules/.prisma/client/index.d.ts` → ≥1（私有 client 已生效）。
2. `cd $WT/apps/server && TZ=Asia/Shanghai npx tsc --noEmit` → 退出码 0，无输出。
3. 在自己新建的空库上：`cd $WT/apps/server && npx prisma migrate deploy` → 包括新迁移在内全部 applied；接着 `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` → 退出码 0，库与 schema 无漂移；`SHOW COLUMNS FROM orders LIKE 'pickup_asap'` → `tinyint(1) | NO | 默认 0`。
   人工检查：新迁移目录下的 `migration.sql` 只有一条 `ALTER TABLE \`orders\` ADD COLUMN \`pickup_asap\` ... NOT NULL DEFAULT false`（MySQL 写作 `BOOLEAN`/`TINYINT(1)` 都算）→ 没有其他语句。
4. `cd $WT/apps/server && TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-pickup-asap.ts` → 0 失败，并覆盖下文「测试用例」A 组的每一条（A1–A16，每条用例名写明对应编号）。
5. 既有自测不回归，0 失败，通过条数不少于 BASE：`selftest-pickup.ts`（BASE 30）、`selftest-ticket-schedule.ts`（BASE 8）、`selftest-schedule.ts`（BASE 20）、`selftest-member.ts`（BASE 68）、`selftest-promotion.ts`（BASE 26）。都用 `TZ=Asia/Shanghai npx ts-node --transpile-only scripts/<名>.ts` 跑。另跑 `cd $WT/apps/server && npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/selftest-wechat-notify.ts`（单元模式）→ 0 失败（验签/解密工具链没被波及）。
6. `cd $WT && npm run test:miniapp` → `fail 0`，`tests` ≥ 405 + 本次新增条数；新增用例覆盖下文 D 组。
7. `cd $WT/apps/admin && npm test` → `fail 0`，`tests` ≥ 224 + 本次新增条数；新增用例覆盖下文 C 组的纯函数部分。
8. `cd $WT/apps/admin && npm run build` → 退出码 0（会依次跑 check-admin-timezone、tsc、vite build）。
9. `cd $WT && node scripts/check-miniapp-es5.mjs apps/miniapp/pages/local/pickup.js apps/miniapp/utils/pickup-checkout-state.js apps/miniapp/utils/local-catalog.js <本次新增的所有小程序 .js>` → `全部通过`。`pages/order/detail.js` 在 BASE 就不是 ES5，不列入。
10. 既有测试没有被删改：`cd $WT && git diff 72d441f -- tests/miniapp scripts/e2e.sh scripts/e2e.d apps/server/scripts 'apps/admin/src/*.test.ts' | command grep -cE '^-[^-]'` → `0`（只允许追加，不允许删改既有行）。
11. e2e 全量：新建空库，migrate deploy + seed，用 mock 环境（含上面「真实支付回调段的额外环境」）在自选端口起服务，然后跑 `cd $WT && TZ=Asia/Shanghai BASE=http://localhost:<端口> DB_NAME=<库名> WECHAT_PAY_API_V3_KEY=<同一个 key> bash scripts/e2e.sh`。期望末尾汇总 `FAIL=0`，新分片 `scripts/e2e.d/79-pickup-asap.sh` 覆盖下文 B 组全部条目；**输出里 B19 真实回调段必须是实跑的 ok 行，不能出现本分片的 SKIP 行**（分片在 shell 没有 key 时要打印醒目的 SKIP 行并跳过该段，这种运行不算本条通过）。只有已知偶发项变红（`e2e.d/42` B4-1 五并发领券、`e2e.d/45` 打印机 4 条）时，再重跑一次全量，贴出两次原始汇总。其他任何红都不算通过。
12. 人工检查（编排者或店主真机走查，提审前做）：在微信开发者工具或真机上，按预览文件的 ①–⑤ 五个画面逐一对照：营业中默认选中尽快取并显示「约 N 分钟 / 预计 HH:mm 可取」；改选预约后和现在一样；打烊、午休或本段来不及时尽快取置灰；接单前详情显示取消按钮；接单后显示「店家已接单，不可取消」，且没有取消和申请取消按钮。另看一个待付款的尽快单：详情不显示具体 HH:mm，付款后刷新出重算后的时刻。判定标准：五个画面的文案、可点性都与预览一致，待付款画面符合 D7。
13. `wechat-notify.ts` 改动只落在允许的范围内（每条都在 `$WT` 下跑，期望无输出、退出码 0）：
    - `diff <(git show 72d441f:apps/server/src/routes/wechat-notify.ts | sed -n '/^class AmountMismatchError/,/^export async function wechatPayNotifyHandler/p') <(sed -n '/^class AmountMismatchError/,/^export async function wechatPayNotifyHandler/p' apps/server/src/routes/wechat-notify.ts)`（replyOk/replyFail/parseNotify 零改动）
    - `diff <(git show 72d441f:apps/server/src/routes/wechat-notify.ts | sed -n '/^export async function wechatRefundNotifyHandler/,$p') <(sed -n '/^export async function wechatRefundNotifyHandler/,$p' apps/server/src/routes/wechat-notify.ts)`（退款回调零改动）
    - `git diff 72d441f -- apps/server/src/routes/wechat-notify.ts | command grep -E '^[-+][^-+]' | command grep -cE "REFUNDING|lateCancelled|AmountMismatch|payment\.upsert|initiateRefund|replyOk|replyFail|status: 'CANCELLED'"` → `0`（金额校验、payment.upsert、取消后仍付款的两个退款分支、应答都没被动）
    - `command grep -cF "const paidAt = transaction.success_time ? new Date(transaction.success_time) : new Date()" apps/server/src/routes/wechat-notify.ts` → `1`（真实回调 paidAt 的取值行原样保留）
    - `command grep -c "const paidAt = new Date()" apps/server/src/routes/orders.ts` → `1`（mock 付款 paidAt 的取值行原样保留；BASE 也是 1）
14. `orders.ts` 的真实支付预下单分支零改动：`cd $WT && diff <(git show 72d441f:apps/server/src/routes/orders.ts | sed -n '/\/\/ Real WeChat Pay/,$p') <(sed -n '/\/\/ Real WeChat Pay/,$p' apps/server/src/routes/orders.ts)` → 无输出。
15. 人工检查（复核者看代码）：①两条付款路径里，`pickupAt` 的重算写和 `PENDING_PAYMENT→PAID` 的条件写在**同一个事务**里，并且只在该条件写 `count=1` 时生效；`wasCancelled` 分支和 `count=0` 回落分支都不写 `pickupAt`。②mock 路径发给 `notifyOrderPaid` 的取餐文案取的是重算后的值，不是事务前读到的 `order.pickupAt`（`orders.ts:1247` 那个快照）。③两条路径都调用 `services/pickup.ts` 里同一个重算函数，没有各写一份公式。④锚点 max(paidAt, 处理时刻) 在这个共享函数**内部**取，函数同时接收 paidAt 与处理时刻两个入参；真实回调传入的处理时刻是服务器时钟在处理本次回调时取的 `new Date()`，不是从回调报文、订单行或支付记录里读出来的。⑤`paidAt` 语义不变：真实回调写进 `orders.paid_at`、`payments.paid_at` 的仍是 `:164` 那个 `paidAt`（`success_time`，缺省服务器时刻），mock 仍是 `:1257` 那个；锚点不回写任何 paidAt 列，也不进推送、订阅消息的 `paidAt` 字段。判定：五点都成立才算通过。

## 既有检查

- `cd apps/server && npx tsc --noEmit`（来源：`apps/server/package.json` 的 `build: tsc`；`scripts/deploy.sh:145` 的 `npm run build -- --outDir dist.next`）
- `cd apps/server && npx prisma migrate deploy`（来源：`scripts/deploy.sh:150`）
- `npx prisma generate`（来源：`scripts/deploy.sh:142`；本地用「私有 client」配方代替，见步骤 0）
- `cd apps/admin && npm run build`（来源：`apps/admin/package.json` 的 build = `node ../../scripts/check-admin-timezone.mjs && tsc && vite build`；`scripts/deploy.sh:253` 的 `npm run build:admin`）
- `cd apps/admin && npm test`（来源：`apps/admin/package.json` 的 test）
- `npm run test:miniapp`（来源：根 `package.json`）
- `node scripts/check-miniapp-es5.mjs <files>`（来源：`scripts/check-miniapp-es5.mjs`，把守新增的和已是 ES5 的小程序文件）
- `TZ=Asia/Shanghai BASE=… DB_NAME=… bash scripts/e2e.sh`（来源：`scripts/e2e.sh`，末尾还会跑 `scripts/check-channel-consistency.mjs`（:2550）和 `scripts/check-points-consistency.mjs`（:2553））
- 服务端纯函数自测 `apps/server/scripts/selftest-{pickup,ticket-schedule,schedule,member,promotion}.ts`、`selftest-wechat-notify.ts`（单元模式）（来源：各文件头注释的用法）
- 仓库没有 git 钩子（`.git/hooks` 只有 sample，`core.hooksPath` 未设置），也没有 CI 配置（没有 `.github/`）。

## 影响范围

- 数据：`Order.pickupAt`（`apps/server/prisma/schema.prisma:324`）语义扩展，尽快单里它是「预计可取时刻」，下单时写一次，付款成功时可能被推后一次。新增 `Order.pickupAsap`。全仓写 `pickupAt` 的地方只有下单一处（`routes/orders.ts:292,306,674`；`command grep -rn pickup_at apps/server/src` 无原生 SQL 写入），本批新增两处付款写入。引用 pickupAt 的地方（模块：server）：
  - `routes/orders.ts:86-96` pickupViewOf、`:102-120` canSelfCancelOf、`:130-150` cancelWindowOf、`:171-174,204` 下单 schema、`:236` orderCreatedView、`:294-307` 自取校验、`:674` 落库、`:946` 详情、`:975-985,997` 申请取消、`:1100-1128` 自助取消 timed 分支、`:1129-1138` 立即单分支、`:1172-1177` 兜底报错
  - **付款路径（本版新增）**：`routes/orders.ts:1240-1311` `POST /:id/pay` 的 mock 分支——`:1247` 事务前读到的 `order` 快照、`:1257` paidAt、`:1274-1277` 条件写 PAID、`:1288-1300` 来单推送用的是 `order` 快照（重算后会过期，必须改用重算值）、`:1307` 出票；`:1313` 起的真实预下单分支**不改**。
  - **真实支付回调（本版新增）**：`routes/wechat-notify.ts:147-240` 事务——`:164` paidAt = `success_time`（缺省服务器时刻），**本批不改它的取值**，重算锚点另取 max(paidAt, 处理时刻)、`:210-221` 取消后仍付款分支（不重算）、`:222-239` 条件写 PAID 及 count=0 回落（重算只挂在 count=1 上）；`:266-323` 事务后重新查库发推送，`:282-285` 取餐文案；`:332` 事务后出票（`enqueueOrderTicket` 内部按 id 重新查库，`services/ticket/index.ts:188,219`，所以读到的是重算后的值）。
  - 付款后读库、会自动拿到重算值的下游（不需要为重算额外改，但要在测试里证明读到的是新值）：`services/ticket/index.ts:152-189,219-227`（票面输入）、`:690,716-720,737-738`（repeatAnnounce）；`routes/admin/workbench.ts:119-131,139-156,213-215`；`services/pickup-tasks.ts:19-76`；`services/order-notify.ts:58,322-346`；`services/subscribe-message.ts:259-283`（「已备好」取餐提醒，由 `routes/admin/orders.ts:473` 触发，本批行为不变）；`routes/admin/orders.ts:51`；`routes/orders.ts:86-96` pickupViewOf。
  - `services/scheduler.ts:263`（remindUnacceptedOrders 排除 PICKUP；**不改**，自取催单继续走 pickup-tasks）
  - `paidAt` 的读方：工作台等待计时（`routes/admin/workbench.ts:221-222` 用 `o.paidAt` 做卡片锚点）、今日统计（`:246-256`）、`services/pickup-tasks.ts:23-28` 催单、`services/scheduler.ts:263`、推送与订阅消息里的付款时间。`paidAt` 取值不变，这些读方不受锚点改动影响。回调晚到时，尽快单的 `pickup_at − paid_at` 会大于「备餐 + 缓冲」，上面这些读方都不依赖这个差值。
- 小程序付款后的刷新链路：`pages/order/detail.js:608-672` startPay/pollPaidStatus 付款后轮询详情并 `loadOrder`，所以付款后显示的就是服务端重算值；mock `/pay` 的响应体 `{ mode, status, paidAt }`（`orders.ts:1310`）**不改**。下单后 `pages/local/pickup.js:467` 直接跳详情（autopay），不使用 orderCreatedView 里的 pickupAt。
- 新增公共计算（`services/pickup.ts`）被 `routes/local.ts:24-47`（meta 与 pickup-slots）、`routes/orders.ts` 下单、`routes/orders.ts` mock 付款、`routes/wechat-notify.ts` 真实回调共用。
- 后台（模块：admin）：`src/types.ts:244-246`（Order）、`:837-848`（WorkbenchCard.pickup）；`src/utils/pickup.ts:17-54`；`src/utils/order-list.ts:62-75`；`src/components/orders/detail/DetailCustomer.tsx:36-41`；`src/pages/Workbench.tsx:64`（ChannelBadge）、`:243-300`（紧急度、pickupCapsule）、`:1223-1227`（卡片取餐行）、`:2111-2115`（抽屉取餐信息）。
- 小程序（模块：miniapp）：`pages/local/pickup.{js,wxml,wxss}`；`utils/pickup-checkout-state.js:61-84`；`utils/local-catalog.js:87-113` headNoticeOf，它是共享函数，调用方有 `components/local-store-header/index.js:43`、`pages/product/list.js:166,667`、`pages/cart/index.js:83`、`pages/local/pickup.js:142`；`pages/order/detail.js:278-284,329-411,684-700`；`pages/order/detail.wxml:34-39,107-127,350-353`。
- 按字符串匹配或契约依赖的东西：错误码 42280/42281/42282（小程序 `pages/local/pickup.js:493,502` 按码分派；新增 42285）；下单 zod 报错文案「请选择取餐时间并填写取餐人手机号」（`orders.ts:204`，老客户端可能按文案匹配，必须逐字不变）；`sortColumn`/`SortableCard` 被 `scripts/selftest-schedule.ts:11` import；`ticketLabel` 的返回形状被 `selftest-pickup.ts:101-103` 深比较（**不得改**）；票面 `<B>` 放大行 ≤16 列（`content.ts:120` BIG_LINE_WIDTH，`selftest-ticket-schedule.ts` 校验）；支付回调应答 `SUCCESS/FAIL` 与幂等判断（`wechat-notify.ts:155`，微信按应答决定是否重推）。
- e2e 环境：多 export 一个 `WECHAT_PAY_API_V3_KEY` 后，`GET /api/admin/system/status` 的 `pay.apiV3KeySet` 会变成 true（`routes/admin/system.ts:39`）；`scripts/e2e.sh:89` 只断言字段非 null，不受影响；`apps/admin/src/pages/SystemStatus.tsx:118,135` 只是展示。
- 回归测试：
  - `TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-{pickup,ticket-schedule,schedule,member,promotion}.ts`；`npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/selftest-wechat-notify.ts`
  - `npm run test:miniapp`（重点：`tests/miniapp/pickup-checkout-state.test.cjs`、`pickup-page.test.cjs`、`local-catalog.test.cjs`、`closed-schedule-hints.test.cjs`、`order-channel.test.cjs`、`order-status-tag.test.cjs`）
  - `cd apps/admin && npm test`（重点：`src/utils/pickup.test.ts`、`src/utils/order-list.test.ts`）
  - e2e 全量（重点分片：`62-pickup`、`63-packing-fee`、`64-tableware`、`65-product-sort`、`66-promotion`、`69-scheduled-delivery`，这几片都按预约口径建自取单并走 mock 付款，必须不改一行照样全绿；`scripts/e2e.sh:2395-2440`「支付与取消并发」段必须照样绿，它钉住的就是本次要改的那条条件写）

## 测试用例

（L 级：下面是必须覆盖的行为，具体用例由执行者设计。A 进服务端新自测，B 进 e2e 新分片 79，C 进后台单测，D 进小程序单测。）

**A. 纯函数（注入 now/paidAt 与设置，不依赖真实时钟）**
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
- A11 付款重算（设置同 A1；处理时刻 = paidAt，即 mock 口径）：原 pickupAt 11:40，paidAt 11:20:10 → ceil(11:40:10)=11:41 → 结果 11:41；paidAt 11:29:00 → 11:49；paidAt 11:10:00（新值 11:30 早于原值）→ 保持 11:40，不回退；结果永远是整分。
- A12 付款重算的高峰判定看重算后的取餐时刻（处理时刻 = paidAt）：原 11:59，paidAt 11:44 → 临时 12:04 落在高峰 → 11:44+30+5 = 12:19；paidAt 11:30 → 临时 11:50 不在高峰 → 11:50 < 原 11:59 → 保持 11:59。
- A13 付款重算不看可用性（Q3=A，店主已确认；处理时刻 = paidAt）：原 14:25（段结束 14:30），paidAt 14:19 → 14:39，不封顶；同一输入分别叠加「自取暂停」「今天休业」「营业时段不含 paidAt」，结果都是 14:39。
- A14 只作用于尽快单：`pickupAsap=false` 的自取单、LOCAL（立即/预约）、EXPRESS、`pickupAt` 为空 → 重算函数返回「不写」（null 或等价标记），调用方不会产生任何 `pickupAt` 写入。
- A15 跨零点：营业段 18:00–23:59，原 23:50，paidAt 23:44 → 次日 00:04；文案「尽快取 约 00:04」；票面仍不盖明日单戳、不出日期行。
- A16 锚点取 paidAt 与处理时刻中较晚者（设置同 A1，原 pickupAt 11:40）：
  - (a) 回调晚到：paidAt（success_time）11:20:10、处理时刻 11:23:30 → 锚点 11:23:30 → ceil(11:43:30) = 11:44（按 success_time 算会得 11:41，用例必须能区分）。
  - (b) 服务器时钟慢于微信：paidAt 11:25:00、处理时刻 11:22:00 → 锚点 11:25:00 → 11:45（只用处理时刻会得 11:42）。
  - (c) 高峰按锚点判：paidAt 11:30:00、处理时刻 11:44:00 → 临时 12:04 落在高峰 → 11:44 + 30 + 5 = 12:19（按 paidAt 判会得 11:50）。
  - (d) 两者相等时与 A11 同值；非尽快单无论两个时刻怎么给都返回「不写」。

**B. e2e（分片 `scripts/e2e.d/79-pickup-asap.sh`，变量统一加 `P79_` 前缀，收尾把设置恢复成进来时的样子）**
- B1 `/api/local/pickup-slots` 和 `/api/local/meta` 的 `pickup.asap` 结构齐全；营业时段覆盖当前时刻时 available=true、readyAt 与 now+minutes 相差不到 2 分钟；把营业时段改成不含当前时刻 → available=false、reason=CLOSED；未开通、暂停、休业各返回对应 reason。
- B2 下单 `pickupMode:"ASAP"`、不带 pickupAt → code 0，返回 `pickupAsap=true`，**付款前**的 `pickupAt` 等于服务端算出的 readyAt（与下单前查到的 readyAt 相差 ≤1 分钟）；落库 `pickup_asap=1`。
- B3 ASAP 同时带 pickupAt → 40001；ASAP 不在营业段 → 42285，库存和券都没扣（下单前后的库存、券状态对比）；未开通、暂停、休业仍然报 42280。
- B4 老客户端兼容：不传 pickupMode、只传 pickupAt → 走预约口径（落库 `pickup_asap=0`，时段校验照旧，报错码和文案不变）；deliveryType 不是 PICKUP 却带 pickupMode → 40001。
- B5 付款后未接单：详情 `canSelfCancel=true`、`canRequestCancel=false`、`pickup.asap=true`；`PUT /cancel` → code 0，订单进入 REFUNDING/REFUNDED（mock），出了 CANCEL 票（这一段把打印机设成启用的 mock 打印机，或者按 62 分片现有的打印断言方式断言）。
- B6 付款后已接单（通用 `/admin/orders/:id/accept`）：详情 `canSelfCancel=false`、`canRequestCancel=false`；`PUT /cancel` → 42204，订单状态不变；`POST /cancel-request` → 42229，`cancel_requested_at` 仍为 NULL。用 sql 把 pickup_at 改到任意时刻（过去或未来 3 小时后）重复一遍，结论不变（证明不走 selfCancelLeadMin 口径）。
- B7 并发：同一张 PAID 尽快单，同时发 `PUT /cancel` 和 `/admin/orders/:id/accept` → 恰好一个成功；成功的是取消就是 REFUNDING 且 accepted_at 为 NULL，成功的是接单就是 PREPARING 且没有退款行。
- B8 店家后台主动退款不受影响：已接单的尽快单 `POST /admin/orders/:id/refund` → code 0。
- B9 催单：尽快单 PAID、付款时刻回拨到 16 分钟前 → `sched` 一次后 `accept_reminded_at` 非空；回拨 10 分钟时仍为空（与同城立即单同一口径：付款 + 15 分钟）。
- B10 过时未取和自动完成沿用现有规则：SHIPPED 的尽快单 pickup_at 回拨超过 unpickedRemindAfterMin → 提醒打标；超过 autoCompleteAfterMin → COMPLETED。
- B11 工作台快照：尽快单卡片 `pickup.asap=true`；pending 列里，同为自取的尽快单排在当天较晚取餐的预约单前面。
- B12 NEW_ORDER 票内容（PrintJob.content）含「尽快取 约 HH:mm」，其中 HH:mm 等于**付款后**库里 pickup_at 的上海时间；不含「【明日单】」。
- B13 预约自取回归：同一分片里按预约口径下一单，详情 `pickup.asap=false`，`canSelfCancel`、`canRequestCancel` 与 62 分片相同情形下的结论一致。
- B14 mock 付款推后：高峰窗口设成不覆盖当前时刻附近；下尽快单后用 sql 把 pickup_at 往前拨 10 分钟（模拟拖到很晚才付款），再 mock 付款 → `TIMESTAMPDIFF(SECOND, paid_at, pickup_at)` 落在 `[(P+B)*60, (P+B)*60+59]`，且 pickup_at 是整分（秒与毫秒为 0）；详情 `pickup.pickupAt`、工作台卡片 `pickup.pickupAt`、NEW_ORDER 票面的 HH:mm 三者都等于这个新值。
- B15 mock 付款不回退：付款前 sql 把 pickup_at 设成「现在 + 3 小时」的整分 → 付款后 pickup_at 与付款前逐字相等。
- B16 mock 付款的高峰判定：把高峰窗口设成覆盖「现在 + P + B」、上限设成与 P 明显不同的值 → 付款后 `TIMESTAMPDIFF(SECOND, paid_at, pickup_at)` 落在 `[(peakMax+B)*60, (peakMax+B)*60+59]`。
- B17 mock 幂等：对已付款的尽快单再发一次 `/pay` → 42203，pickup_at、paid_at 不变。
- B18 零影响：预约自取单 mock 付款 → pickup_at 与付款前逐字相等、pickup_asap=0；同城立即单、同城预约单 mock 付款 → pickup_at 仍为 NULL、scheduled_at 与付款前逐字相等。
- B19 真实支付回调（`POST /api/wechat/pay/notify`，`event_type=TRANSACTION.SUCCESS`，resource 用 `WECHAT_PAY_API_V3_KEY` 做 AES-256-GCM 加密，密文 = base64(密文‖16 字节 tag)，`out_trade_no=order_<id>_<ts>`，`amount.total` 等于 actual_amount，`success_time` 显式给定）：
  - 处理时刻的参照：`payments.updated_at` 由 Prisma 在回调事务的 `payment.upsert` 里按服务器时钟写入，本流程之后不再改它，拿它当「服务器处理本次回调的时刻」。
  - (a1) 回调晚到，锚点取处理时刻：下尽快单，sql 把 pickup_at 往前拨 20 分钟；`success_time` = 现在 − 5 分钟（整秒，带 +08:00）→ 应答 200 `SUCCESS`；订单 PAID；`orders.paid_at` 与 `payments.paid_at` 都等于 success_time（按秒比，证明 paidAt 语义没变）；`TIMESTAMPDIFF(SECOND, payments.updated_at, orders.pickup_at)` 落在 `[(P+B)*60−1, (P+B)*60+61]`；`TIMESTAMPDIFF(SECOND, orders.paid_at, orders.pickup_at)` ≥ `(P+B)*60+240`（排除「锚点用 success_time」的实现）；pickup_at 是整分；NEW_ORDER 票面 HH:mm 等于新 pickup_at。
  - (a2) success_time 晚于处理时刻，锚点取 success_time：另一张尽快单，同样把 pickup_at 往前拨 20 分钟；`success_time` = 现在 + 3 分钟 → 200 `SUCCESS`；`orders.paid_at` 等于 success_time；`TIMESTAMPDIFF(SECOND, orders.paid_at, orders.pickup_at)` 落在 `[(P+B)*60, (P+B)*60+59]`；`TIMESTAMPDIFF(SECOND, payments.updated_at, orders.pickup_at)` ≥ `(P+B)*60+120`（排除「锚点只用处理时刻」的实现）。这张单之后不再参与其他断言（paid_at 在未来）。
  - (b) 重推：原样重放 (a1) 的请求体 → 200 `SUCCESS`，pickup_at、paid_at 与重放前逐字相等，NEW_ORDER 票没有多出一张。
  - (c) 不回退：另一张尽快单付款前 pickup_at 设成「现在 + 3 小时」→ 回调后逐字不变。
  - (d) 取消后才到的付款：尽快单待付款时 `PUT /cancel` → CANCELLED；再发回调 → REFUNDING，pickup_at 与取消前逐字相等（不重算）。
  - (e) 预约自取单走回调 → pickup_at 逐字不变、pickup_asap=0。
  - shell 里没有 `WECHAT_PAY_API_V3_KEY` 时整段打印 `SKIP` 行跳过（见验收 11，这样的运行不算通过）。
- B20 付款时已不满足尽快条件（Q3=A 照收照做，店主已确认）：下尽快单后分别把设置切到 (i) 自取暂停、(ii) 今天休业、(iii) 营业时段不含当前时刻，再 mock 付款 → 都是 code 0、PAID，pickup_at 按 B14 的公式重算，并出了 NEW_ORDER 票；每种情形结束都把设置恢复。

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
- D7 订单详情：
  - 待付款的尽快单**不显示具体 HH:mm**（那是下单时刻算的，付款时会重算），改为提示付款后才出预计时间，建议文案「尽快取 · 付款成功后显示预计可取时间」，执行者可微调措辞，但不得出现时刻。
  - 已付款的尽快单显示「尽快取 预计 HH:mm 可取」，HH:mm 取服务端返回的 `pickup.pickupAt`（重算后）；PAID 且可取消时提示「店家接单前可随时取消，取消后原路退款」，有取消按钮；接单后显示「店家已接单，不可取消」，没有取消和申请取消按钮。
  - 预约单的展示与 BASE 一致。

## 关键决定

- **数据模型**：`orders` 加一列 `pickup_asap BOOLEAN NOT NULL DEFAULT false`（Prisma 字段 `pickupAsap`）。尽快单的 `pickupAt` 存预计可取时刻，**自取单的 pickupAt 永不为空**。存量数据都是 false，就是预约单。只加列，回滚代码不用回滚库。
- **下单契约**：`POST /api/orders` 新增可选 `pickupMode: 'ASAP' | 'SCHEDULED'`，不传就是 SCHEDULED。只有 `deliveryType=PICKUP` 能带它，否则报 40001。ASAP 时 `pickupAt` 必须不传（传了报 40001），`pickupContact` 仍然必填。SCHEDULED（含不传）时，校验、报错码、报错文案与 BASE 逐字节一致。
- **可用性与预计时刻（服务端唯一实现，在 `services/pickup.ts`，结算页、meta、下单、两条付款路径共用）**：设 t 为计算时刻（下单时 = 此刻，付款时 = paidAt），B=`pickup.acceptBufferMin`。先用 P=`prepMinutes` 算临时取餐时刻 t+P+B；它落在高峰窗口里（`minutesInPeak`）就把 P 换成 `peak.prepMaxMinutes`。`readyAt = ceil到整分(t + P + B)`，`minutes = P + B`。下单时的可用条件（按下面顺序判，第一个不满足的就是 reason）：自取已开通（DISABLED）→ 今天不休业（HOLIDAY）→ 自取没有暂停（PAUSED）→ now 落在某个营业段 [start,end) 内（CLOSED）→ daysAhead 内至少有一格可选，即 earliestPickupInfo 不是 NONE（NONE，对应店主说的「今日已约满」）→ `readyAt < 该营业段 end`，严格小于（TOO_LATE）。**外送暂停不影响尽快取**。
- **付款成功时重算（店主 2026-09-28 选 Q2=B）**：
  - 公式：新 `pickupAt = max(原 pickupAt, readyAt(实时设置, paidAt))`，readyAt 用上一条同一个函数，高峰按重算的临时取餐时刻判。
  - 锚点（店主 2026-09-28 确认）：`锚点 = max(paidAt, 处理时刻)`，在共享重算函数内部取。真实回调里 paidAt 是 `success_time`（没有时用服务器当前时刻，`wechat-notify.ts:164` 原逻辑），处理时刻是服务器处理本次回调时的 `new Date()`，所以回调晚到时以服务器收到并处理的时刻起算，保证后厨至少有「备餐 + 缓冲」。mock 里 paidAt 就是服务器当前时刻（`orders.ts:1257`），处理时刻传同一个值，锚点等于它。
  - `paidAt` 的取值与含义不变：`orders.paid_at`、`payments.paid_at` 仍写微信记录的付款时刻 `success_time`（mock 为服务器当前时刻）。工作台等待计时、催单、统计、推送里的付款时间都照旧读它。锚点只用于算 `pickupAt`，不落库。
  - 触发范围：只作用于 `deliveryType='PICKUP' AND pickupAsap=true`，只挂在 `PENDING_PAYMENT→PAID` 那次条件写成功（count=1）上，和它在**同一个事务**里写库（建议直接并进同一条 `updateMany` 的 data）。`wasCancelled` 分支、count=0 回落分支都不重算。预约自取、同城、邮寄一律不写 `pickupAt`。
  - 幂等：回调重推时状态已不是 `PENDING_PAYMENT`，走 `wechat-notify.ts:155` 的早退，不会再推后；mock 再次 `/pay` 报 42203。取 max 保证永不回退。
  - 付款时**不校验**尽快可用性（店主 2026-09-28 确认 Q3=A「照收照做」）：付款永远照常成功、照常出票；预计时间按公式算，可以落在本段营业结束之后，不封顶，票面、工作台、推送都不加标注。与预约自取「下单后店家暂停或休业，付款照样成功」的现状一致。
  - 接单时不重算。
  - 一致性：票面、工作台、详情、催单、未取提醒、自动完成、新订单推送、已备好提醒一律读库里重算后的 `pickupAt`，不各自再算。出票和推送都在事务提交之后触发（`wechat-notify.ts:266,332`、`orders.ts:1280,1307`）。mock 路径的推送必须用重算值，不能用事务前的 `order` 快照。
- **对外结构**：`GET /api/local/pickup-slots` 和 `GET /api/local/meta` 的 `pickup` 节都新增 `asap: { available: boolean; readyAt: string|null; minutes: number|null; reason: null|'DISABLED'|'PAUSED'|'HOLIDAY'|'CLOSED'|'NONE'|'TOO_LATE' }`（不可用时 readyAt、minutes 为 null）。已有字段一个不动。mock `/pay` 的响应体不变。
- **下单时的校验顺序**：沿用现有的 42280（未开通、休业、暂停，文案不变）→ 尽快不可用（CLOSED/NONE/TOO_LATE）报 **42285**（新码，文案按 reason 区分）→ 42282 起送门槛 → 券。42285 必须在任何库存和券的写操作之前报出。
- **取消规则（顾客侧）**：尽快单 PENDING_PAYMENT 可取消，与 BASE 一致。PAID 且 `acceptedAt` 为空 → 可自助秒退，走 `orders.ts:1129-1138` 的立即单分支（条件写 `status='PAID' AND accepted_at IS NULL`，与接单互斥）。接单后 `canSelfCancel=false`、`canRequestCancel` 恒为 false，`/cancel` 报 42204，`/cancel-request` 报 42229，都不改任何列。尽快单**不进** timed 分支，不看 `selfCancelLeadMin`。店家后台退款、拒单、售后路由都不改。
- **售后照常（店主 2026-09-28 确认 Q1=A）**：尽快单取走后仍按现有规则申请售后（`orders.ts:1193-1225`、详情 `canApplyAfterSale` 不改）。「接单后不可退款」只关顾客侧的自助取消与申请取消。
- **催单口径与同城立即单一致**：企微催单在付款 + `ACCEPT_REMIND_AFTER_MIN` 触发；repeatAnnounce 从付款时刻起算，用 `repeat.localAfterMin`，并且**不受 `shopOpen` 门控**（与 LOCAL 相同）。预约自取的催单口径不变。
- **票面**：尽快单取餐联的放大行是「尽快取 约 HH:mm」（≤16 列），不盖日期戳，不出日期行，HH:mm 取付款重算后的值。预约单票面逐字节不变。`ticketLabel` 的返回形状不改。
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

两个高风险文件只许改下面这些位置（验收 13、14、15 把关）：
- `apps/server/src/routes/wechat-notify.ts`：①import 行；②`wechatPayNotifyHandler` 事务内，为重算读设置、调用重算函数，以及 `PENDING_PAYMENT→PAID` 那条 `updateMany` 的 `data`；③事务后推送里的取餐文案块（BASE `:278-288`）换成新 helper。金额校验、`payment.upsert`、`wasCancelled` 分支、count=0 回落分支、`lateCancelled` 退款与告警、出票调用、应答、`parseNotify`、`wechatRefundNotifyHandler` 一律不动。
- `apps/server/src/routes/orders.ts` 的 `POST /:id/pay`：只许改 `if (useMockPay) { ... }` 块内部（重算、条件写的 data、推送文案用重算值）；`// Real WeChat Pay` 起到文件尾一律不动。该文件其余路由按原方案的下单、详情、取消改动授权。

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
apps/server/src/app.ts
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
apps/server/scripts/selftest-wechat-notify.ts
apps/server/scripts/selftest-refund-reconcile.ts
apps/miniapp/api/payment.js
```

## 上报条件

- 要改禁止清单里的文件，或者改授权范围外的文件（特别是 `local-settings.ts`、`scheduler.ts`、`refund*.ts`、`subscribe-message.ts`、`wechat-pay*.ts`、`app.ts`）。
- 付款重算需要动 `wechat-notify.ts` 或 `orders.ts /pay` 里「授权范围」写明位置之外的代码（例如金额校验、`payment.upsert`、`lateCancelled` 分支、退款回调、`parseNotify`、真实预下单分支）。
- 重算写没法和 `PENDING_PAYMENT→PAID` 条件写放进同一个事务（例如只能在事务提交后另起一次写）。
- 发现除下单（`orders.ts:306`）和本批两条付款路径之外，还有别的代码在写 `pickupAt`。
- e2e 真实回调段在「真实支付回调段的额外环境」下跑不通，必须改验签或配置代码才能测。
- 既有测试或 e2e 分片（含 62–69、`e2e.sh:2395-2440` 支付并发段）要删改任何一行断言才能通过，或者不改代码就过不了。
- 发现预约自取、邮寄、同城外送的任何既有行为必须跟着变（包括报错码、报错文案、票面字符串、接口已有字段、支付回调应答）。
- 迁移除了给 `orders` 加 `pickup_asap` 还要别的语句，或者要回填存量数据。
- 私有 Prisma client 配方做不成，只能在共用 client 上 generate。
- 实现中发现店主规则之间自相矛盾（例如「今日已约满」和「本段来不及」给出相反结论），或者预览里的某个画面按本方案做不出来。
- 锚点只能靠改写 `paidAt`（订单或支付记录）的取值才能实现，或者处理时刻只能从回调报文、订单行里取。
- 需要触碰生产（ssh/scp）、部署、合并 main，或者需要 npm install。

## 待用户决定

无

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
1. **计算层**（`services/pickup.ts`）：
   - `asapReadyAt(s, t)`：纯函数，返回 `{ readyAt, minutes }`，只管公式（高峰判定、取整），不判可用性。
   - `pickupAsapInfo(s, now)`：在 `asapReadyAt` 之上按「关键决定」的顺序判 available/reason。
   - `asapPickupAtOnPaid(order: { deliveryType; pickupAsap; pickupAt }, s, paidAt, processedAt): Date | null`：非尽快单或 pickupAt 为空返回 null；否则 `anchor = max(paidAt, processedAt)`，返回 `max(order.pickupAt, asapReadyAt(s, anchor).readyAt)`，值没变时也可以返回 null 表示不用写。两条付款路径只调它，都不在调用处自己取 max。
   - 取餐文案 helper，例如 `pickupTimeLabel({pickupAt, pickupAsap}, s, now)`：尽快单返回「尽快取 约 HH:mm」，预约单原样返回 `slotLabel`。工作台、企微推送、未取提醒、自动完成都走它。
   - 营业段判定照抄 `earliestPickupInfo` 里的 `currentWindow` 写法（`local-settings.ts` 的 `inHours` 没导出，也不在授权范围）。
2. **公开接口**（`routes/local.ts`）：pickup-slots 返回 `{ ...buildPickupSlots(...), asap }`；meta 的 pickup 节补 `asap`，与现有 `earliestPickupWhen` 的补法相同。**不要改 `publicLocalMeta`**：`local-settings.ts` 不能 import `pickup.ts`，否则循环依赖。
3. **下单**（`routes/orders.ts`）：schema 加 `pickupMode`，把 `:204` 那条 refine 拆开，保证老文案逐字不变。PICKUP 分支里 ASAP 走 `pickupAsapInfo(s, now)`，不可用就抛 42285；可用就把 `pickupSnapshot` 写成 `{ pickupAt: readyAt, pickupAsap: true, pickupDiscountAmount }`。`orderCreatedView` 补 `pickupAsap`。
4. **取消**（`routes/orders.ts`）：`canSelfCancelOf`、`cancelWindowOf`、`PUT /cancel` 的 `timed` 判定、`/cancel-request` 的报错文案都按 `pickupAsap` 分流，见「关键决定·取消规则」。`/cancel-request` 对尽快单的文案建议：PAID 时「商家尚未接单，可直接取消订单」，已接单时「店家已接单，不可取消」。`/cancel` 已接单时建议「店家已接单，不可取消，如有问题请联系商家」，码仍然是 42204。`pickupViewOf` 补 `asap` 字段，尽快单的 `slotLabel` 用新 helper 的文案。
5. **付款重算**：
   - mock（`orders.ts:1256-1311`）：`order` 在 `:1247` 已经读过、`paidAt` 在 `:1257` 已经定好，所以在事务前 `const retimed = order.deliveryType === 'PICKUP' && order.pickupAsap ? asapPickupAtOnPaid(order, await getLocalSettings(), paidAt, paidAt) : null`（mock 的处理时刻就是 paidAt），把 `...(retimed ? { pickupAt: retimed } : {})` 并进 `:1274-1277` 的 `data`。推送改成 `{ ...order, pickupAt: retimed ?? order.pickupAt, paidAt, ... }`，文案走 helper。
   - 真实回调（`wechat-notify.ts`）：在事务里、`wasCancelled` 分支之后、`:222` 条件写之前，对尽快单取 `const processedAt = new Date()` 并算 `retimed = asapPickupAtOnPaid(order, s, paidAt, processedAt)`（`:164` 的 `paidAt` 一个字不改；`getLocalSettings()` 带缓存，出错时回退默认值、不会抛，见 `local-settings.ts:698-710`；只在尽快单上调用即可，别让其他订单多一次读），并进 `:224` 的 `data`。事务后推送（`:281-288`）改用 helper，它读的 `paid` 是重新查的，自然是新值。
   - 出票两处都不用改：`enqueueOrderTicket` 在提交后按 id 重新查库。
6. **推送、催单、票面**：`order-notify.ts:58` 对尽快单不要拼出「尽快取 约 11:40 取」这种重复的「取」字。`pickup-tasks.ts:28` 对尽快单用付款锚点。`ticket/index.ts:717-720,737` 对尽快单跳过 prepStart 门槛和 shopOpen 门控。`ORDER_SELECT`、`OrderForTicket`、`toTicketInput`、`TicketOrderInput` 各加一个字段（四处都要加，漏一处票面就永远打不出来，而且编译器不会报错，见 `index.ts:162-165` 的注释）。`content.ts` 的取餐联按新字段出单行 `<B>尽快取 约 HH:mm</B>`，并且不盖戳。
7. **工作台**（`routes/admin/workbench.ts`）：卡片 `pickup` 节加 `asap`；`SortableCard` 加可选的 `pickup?: { asap?: boolean } | null`，`sortColumn` 在非 done 列、同为 PICKUP 时让 asap 在前；尽快单的 `prepStartAt` 建议给付款时刻，这样前端 `pickupPendingAnchor` 自然从付款时刻开始计时。
8. **后台前端**：types 加字段；`order-list.ts` deliveryColumn、`DetailCustomer.tsx`、`Workbench.tsx`（徽标或取餐行显示「尽快」、抽屉里的「取餐时段/开始备餐」两行给尽快单换成「预计可取」）。时间一律用 `utils/time.ts`，否则 check-admin-timezone 会拦。
9. **小程序结算页**：`pickup.wxml` 的「取餐时间」卡改成两个选项「尽快取 / 预约时段」，样式抄 `confirm.wxml:48-57`，wxss 自己写一份。尽快取选中时下面显示「预计 HH:mm 可取」和「店家接单后开始备餐；接单前可随时取消，接单后不可取消」（预览原文，不改）。`pickupCheckoutAction` 加 `mode`、`asapAvailable` 两个入参，缺省时走老路径。`loadSlots` 处理 `view.asap`：第一次拉到时按 available 决定默认模式；之后刷新时，如果顾客选的是尽快取而它已经不可用，就切回预约并提示。`doSubmit` 的守卫（`pickup.js:443`）按模式放行。`handleSubmitError` 加 42285。
10. **小程序详情**：`pickupHintOf`、`decorateOrder` 按 `order.pickupAsap`（或 `order.pickup.asap`）和 `status` 分支：待付款出 D7 的「付款成功后显示预计可取时间」，已付款出预览 ④⑤ 的文案；`showLocalCancelUnavailable` 分支对尽快单给「店家已接单，不可取消」。付款后的轮询和 `loadOrder`（`detail.js:608-672`）不用改，刷新即得重算值。
11. **headNoticeOf**：在 `when === 'LATER'` 分支之前加一句：`pk.asap && pk.asap.available` 时返回 `{ text: '', blocking: false }`。storeStatusOf 不动（营业段内本来就显示「营业中」）。
12. **文档**：`docs/api.md` 补 `pickupMode`、`asap` 结构、42285、详情 `pickup.asap`，并写明「尽快单 pickupAt 在付款成功时可能被推后」；`docs/order-flow.md` 补尽快单的付款重算、取消和催单口径；`docs/staff-guide.md` 补店员怎么看尽快单（可选）。
13. **测试**：新写 `scripts/selftest-pickup-asap.ts`（A 组）和 `scripts/e2e.d/79-pickup-asap.sh`（B 组，自取设置照 62 分片的做法先 GET 再改，最后恢复原值）。在 `tests/miniapp` 和 `apps/admin/src/utils/*.test.ts` 追加 C、D 组。
    - e2e 用真实时钟，营业时段要按当前上海时刻动态拼：可用场景用 `00:00–23:59`，并把 prep、buffer 调小（上海 23:30 以后仍可能 TOO_LATE，分片里要判断当前时刻，必要时把可用场景的营业段拼成「现在−1h 到 现在+2h」，跨零点时跳过并打印原因，不能静默算过）。
    - B19 的加密用 `node -e` 调 `crypto.createCipheriv('aes-256-gcm', key, nonce)`（nonce 12 字节字符串、`associated_data` 可用 `transaction`，与 `decryptNotifyResource` 对称：密文‖authTag 再 base64），外层 JSON 形如 `{"id":"…","event_type":"TRANSACTION.SUCCESS","resource":{"algorithm":"AEAD_AES_256_GCM","ciphertext":"…","nonce":"…","associated_data":"transaction"}}`；明文带 `out_trade_no`、`transaction_id`、`trade_state:"SUCCESS"`、`success_time`、`amount.total`。用 `curl --data-binary` 以 `Content-Type: application/json` 发。
    - B14/B16/B19 断言时间差用 `TIMESTAMPDIFF(SECOND, …)`，别在 shell 里算时区。B19 的 `success_time` 用 `node -e` 生成：同时输出带 `+08:00` 的 ISO 串（放进回调明文）和对应的 UTC `YYYY-MM-DD HH:MM:SS`（与 `DATE_FORMAT(paid_at,'%Y-%m-%d %H:%i:%s')` 比，Prisma 按 UTC 落库）。「处理时刻」一律以 `payments.updated_at` 为参照，不用 MySQL 的 `NOW()`（会话时区可能不是 UTC）。

## 已排除的做法

- **尽快单的 pickupAt 存 NULL（仿同城 `scheduledAt` 为空即立即单）**：排除。自取的取消、申请取消、未取提醒、自动完成、工作台、票面全都以 pickupAt 为基准；`orders.ts:980,1108` 还把「自取单 pickupAt 为空」当数据异常处理。存 NULL 会把这些路径全部改一遍，最后还是得另开一列存预计时刻。
- **不加列，靠「pickupAt 不落在时段格上」推断尽快单**：排除。预计时刻恰好是整半点（如 11:30）时就会误判；店主改 slotMinutes 以后，历史单的判定也会翻转。
- **把预计时刻写进 `estimatedDeliveryAt`**：排除。那是同城外送的列，被同城统计、工作台同城卡片、`delivery.ts` doAccept 读写，混进自取单会污染这些口径。
- **接单时重算预计时刻（仿 `routes/admin/delivery.ts:50-56` 同城立即单的做法）**：排除。店主定的是付款时重算；接单时再改会让顾客看到的时刻在备餐中跳动，票面也已经印出去了。
- **付款成功后在事务外再发一次 update 写 pickupAt**：排除。PAID 提交到这次写之间，出票（`enqueueOrderTicket` 提交后立刻查库）和推送可能读到旧值；这次写失败还会留下 PAID 但没重算的单。必须和条件写同事务。
- **在条件写的 where 里加 `pickupAt = 原值` 做守卫**：排除。一旦失配，count=0 会被 `wechat-notify.ts:226-238` 当成「与取消并发」，把一张正常付款的单送进自动退款。待付款阶段没有别的代码写 pickupAt（见影响范围），不需要这层守卫。
- **锚点只用 `success_time`（修订 1 的写法）**：排除。店主 2026-09-28 选了「取较晚的那个」：回调晚到几十秒到几分钟时，只用 success_time 会让预计时刻离出票不足「备餐 + 缓冲」，甚至早于出票。
- **锚点只用服务器处理时刻**：排除。服务器时钟慢于微信时，锚点会早于微信记录的付款时刻；店主定的是两者取较晚者。A16(b) 和 B19(a2) 专门区分这种实现。
- **把 `paidAt` 本身改写成 max(success_time, 处理时刻)，再拿它当锚点**：排除。`paidAt` 是微信记录的付款时刻，`payments.paid_at` 用于对账，工作台等待计时、催单、统计、推送都读它；改了它，这些口径会跟着变，还会让同一张单的订单 paidAt 和支付记录、微信账单对不上。锚点只进重算函数，不落库。
- **处理时刻从 `payments.updated_at`、订单行或回调报文里读**：排除。处理时刻就是服务器处理本次回调时的时钟，直接 `new Date()`；`payments.updated_at` 只是 e2e 用来断言的参照。
- **在 `lateCancelled`/REFUNDING 分支里也重算**：排除。这些单不会履约，重算没有意义，还会扩大高风险文件的改动面。
- **出票、推送、详情各自按 paidAt 现算预计时刻，不落库**：排除。各处设置读取时刻不同就会互相打架，催单、未取提醒按库里的旧值跑会与票面不一致。只落库一次，读方只读。
- **付款时再判一次可用性，不满足就拒收、自动退款或封顶到营业结束**：排除。店主 2026-09-28 确认 Q3=A「照收照做」；钱已扣，回调里拒收会导致微信重推，自动退款体验更差，封顶会压缩后厨备餐时间。
- **在 mock `/pay` 的响应体里加 pickupAt**：排除。小程序付款后按轮询重拉详情（`detail.js:655-672`），用不到；改响应体会动契约。
- **把尽快单的待付款详情照样显示下单时算出的 HH:mm**：排除。付款时会重算，先显示一个时刻、付款后又变，顾客会以为店家改了时间。
- **尽快单沿用 timed 分支，把 selfCancelLeadMin 设成 0 之类**：排除。timed 分支接单后仍可申请取消，并且以约定时刻为界，与「一接单就不可取消」相反。
- **尽快不可用时复用 42281**：排除。小程序对 42281 的处理是「清选择并打开时段选择器」，拿不到原因；也会让 42281 的含义（时段过期）变得含糊。新开 42285。
- **在 `publicLocalMeta`（local-settings.ts）里算 asap**：排除。`pickup.ts` import 了 `local-settings.ts`，反向 import 会循环依赖；现有的 `earliestPickupWhen` 就是在 `routes/local.ts` 里补的，照同样位置补。
- **把尽快单并进 `scheduler.ts` 的 `remindUnacceptedOrders`（去掉 `deliveryType: { not: 'PICKUP' }`）**：排除。那样预约自取也会在付款 15 分钟后被催，破坏「明天的单今晚不催」；应该在 `pickup-tasks.ts` 里按 `pickupAsap` 分流。
- **尽快取也受外送暂停控制（用 `isShopOpenNow`/`isOpenNow` 判营业）**：排除。这两个函数含外送暂停或外送开关；自取有自己的暂停开关，2026-09-23 起自取已不读外送状态（`local-catalog.js:41-49` 注释）。
- **新增「尽快取开关」设置项**：排除，需求里没有，也会牵动后台设置页和 `local-settings.ts`。
- **在 worktree 里直接 `npx prisma generate` 或 `npm install`**：排除。会覆盖主仓共用的 client，打断其他会话。
- **为了测真实回调给 e2e 服务配验签材料（公钥/证书）**：排除。那样得在 shell 里做 RSA 签名，还会让其他依赖「开发环境跳过验签」的调用变红；只配 `WECHAT_PAY_API_V3_KEY`、不配验签材料，就能走通解密与业务逻辑。

# 额外发现

- **回调晚到时 `pickup_at − paid_at` 会大于「备餐 + 缓冲」**：锚点已按店主答复改成 max(success_time, 处理时刻)，后厨从出票起至少有「备餐 + 缓冲」。代价是这类单在工作台上一进待接单列就显示「已等 N 分钟」（等待计时仍从 paidAt 起算，现状如此），催单也可能比出票早到。店主若在意，另起一批改工作台锚点，本批不动。
- **e2e 的 B19(a2) 会留下一张 paid_at 在未来 3 分钟的订单**：只影响这一张单，分片里不要拿它做催单、统计类断言。
- **结算页显示的「预计 HH:mm」可能比付款后的晚 0–1 分钟**：结算页的时刻是页面拉取时算的，下单和付款时各重算一次（取 max），顾客正常付款通常只差 0–1 分钟，拖得久最多差约 15 分钟，回调晚到时再加上晚到的时长。预览文案没改。店主介意的话，可以在结算页加一行「以付款时间起算」。
- **e2e 分片编号**：`scripts/e2e.d/77-callback-before-landing.sh`、`78-escalation-history.sh` 已经存在，交接里说「用到 76」不准，新分片用 79。
- **「已备好推送顾客」其实已经有实现**：`routes/admin/orders.ts:473` 在点「已备好」时调 `sendPickupReadySubscribeMessage`（`services/subscribe-message.ts:259-283`），模板变量是 `WECHAT_TMPL_PICKUP`、`WECHAT_TMPL_PICKUP_FIELDS`；自取结算页也已经在请求 pickup 模板订阅（`pages/local/pickup.js:95`）。生产没推，多半是这两个环境变量没配。店主要的话，也许只需要去公众平台申请模板、配上环境变量，不用写代码（本批不动）。
- **预约自取的重复播报被「外送暂停」误伤**：`services/ticket/index.ts:707,737` 用 `isShopOpenNow`（含外送暂停 `isPaused`）来门控非 LOCAL 单。外送暂停、自取照常营业时，预约自取单到点后不会重复播报。本方案只让尽快单绕开这道门；预约自取的这个问题没修，另起一批。
- **「今日已约满」基本碰不到**：生产 daysAhead=1，而休业是按「截至某日」覆盖的，今天不休业时明天一定有格，所以 earliestPickupInfo 实际不会返回 NONE。店主列的「今日已约满时尽快取置灰」在生产上基本不会触发，只在 daysAhead=0 时有意义；此时本段尾部（没格但来得及）尽快取会被一起挡掉，与店主的表述一致。
- **预览 ③ 看起来预选了时段**：「明天 10:30–11:00 更改 ›」像是自动预选。现行规则（2026-09-17，`pages/local/pickup.js:207-209` 与 `tests/miniapp/pickup-page.test.cjs` 护栏）是「不自动预选，顾客自己选」，店主又说预约自取现有行为保持不变，所以本方案不预选。店主如果其实想要预选，需要另行确认。
- **后台订单列表的「尽快/预约」筛选**（`routes/admin/orders.ts:147-150`）只针对同城外送，自取尽快单筛不出来。本批不改，店主有需要再加。
- **e2e 真实回调段需要额外环境变量**：干净库跑 e2e 的现有配方（记忆里的 food_shop_e2e 配方）没有 `WECHAT_PAY_API_V3_KEY`，按老配方跑，79 分片的 B19 会打印 SKIP。合并后建议把这个变量补进团队的 e2e 配方。
- **交接声明缺【模型】字段**，本方案（含本次修订）由 Opus 5.5 出，不是协议指定的规划模型 Fable 5.1。按 `.agent/agent-protocol.md` §2.6，这属于降级运行，交付报告要注明。

## 店主答复（2026-09-28，编排者转达）
- Q1：**A 售后照常**——尽快单取走后仍可按现有规则申请售后；「接单后不可退款」只关顾客侧的自助取消与申请取消。
- Q2：**B 付款成功时重算**——付款成功时把 `pickupAt` 更新为 max(原预计, 付款时刻 + 备餐 + 缓冲)（与方案原 A 不同，需修订受影响条目）。
- Q3：**A 照收照做**（同方案默认）。
- 追加（额外发现「回调晚到」）：重算锚点取 **max(微信 success_time, 服务器处理回调的时刻)**（与方案现写的「真实回调用 success_time」不同，需修订）；mock 路径仍用服务器当前时刻。
