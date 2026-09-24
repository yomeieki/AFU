# 后台库存预警：按规格判定 + 页签/角标 + 即时与每日推送（2026-09-24）

【工序】规划 【模型】Fable 5.1 【等级】M

- worktree：`/Users/yumingyi/food-shop/.claude/worktrees/low-stock`（分支 `claude/low-stock-alerts`）
- BASE：`26afa559b11944d0fcc82c3f66b4f23d4294bf00`
- 店主已看的预览：`docs/superpowers/previews/2026-09-24-low-stock-alerts.html`（布局以它为准；门槛/推送规则以本方案 §1 为准——预览里写的 5 已被店主改成 3）
- **最终等级：M**（§2.2 第 3 条：新功能 + 既有模块行为调整）。定级依据见 §0.1；结论是**不命中第 2 条**：零迁移、不碰下单/支付/退款/库存扣减链路、不改事务与幂等逻辑。

## 0. 调查结论（执行者不必重查；行号按 BASE）

### 0.1 触发点的三种做法与定级

| 做法 | 要动什么 | 等级 | 结论 |
|---|---|---|---|
| **A（推荐）60 秒心跳扫描 + 去重状态存 `settings` 表 JSON** | 只改 `services/scheduler.ts` 的任务表（把 `pushLowStock` 换成两个新任务）；去重状态存 `Setting(key='low_stock_alert_state')`，与 `services/member/cron-state.ts` 的 `member_cron_state` 同一做法（`settings` 表是 key/value，`prisma.setting.upsert`，见 `cron-state.ts:33-36`）；**零迁移**；进程重启不丢状态、不重复推 | **M** | 采用。「立即」= 最迟下一次心跳（≤60 秒）+ 通道投递时间；同城单从付款到备餐本来就以分钟计，这个延迟对店里侧无感 |
| A′ 心跳扫描 + 内存去重（照 `lastLowStockPushAt` 那种模块变量） | 同 A 但不写库 | M | 否决：每次部署/重启都会把在架的售罄规格再推一遍（生产现在就有 12 个长期为 0 的规格，每次发版都会收到一条「12 个售罄」） |
| B 在扣减点挂钩 | `routes/orders.ts:612-632`（下单事务内扣库存）、`utils/order-stock.ts`（取消/退款回滚）、`refund.ts`、`scheduler.ts` 的 `cancelExpiredOrders` | **L**（§2.2 第 2 条：下单事务） | 否决：仍然需要一份去重状态；后台改库存、赠品行、回滚都要各挂一处；收益只是把 ≤60 秒缩到 0 |
| C 给 `product_skus` 加「已推档位」列 | Prisma 迁移 | **L**（§2.2 第 2 条：数据迁移） | 否决：A 已能持久化，不值一次迁移 |

### 0.2 现状与根因

| 条目 | 现状 | 位置 |
|---|---|---|
| 阈值写死 | `LOW_STOCK_THRESHOLD = 5`；只有两个消费方 | `apps/server/src/utils/constants.ts:2`；`services/scheduler.ts:21,267,274`；`routes/admin/orders.ts:13`（import）、`:246-248`（count）与 `:268`（响应） |
| 现有推送 | 每 12 小时最多一次、只看 `product.stock ≤ 5`、`take: 30` | `scheduler.ts:42,46,264-276`（`LOW_STOCK_PUSH_INTERVAL_MS`、`lastLowStockPushAt`、`pushLowStock`）；任务表 `:129` `['lowStock', pushLowStock]` |
| 推送文案 | `notifyLowStock(products, threshold)`，企微 markdown + PushPlus | `services/order-notify.ts:293-305`；通道函数 `services/notify.ts:64-72`（`sendWecomMarkdown`/`sendPushPlus`，fire-and-forget，本批**不动**） |
| pending-count | `lowStockCount` = `product.count(ON_SHELF && stock ≤ 5)`，`lowStockThreshold: 5` | `routes/admin/orders.ts:227-275`（`Promise.all` 第 7 项 `:246-248`，响应 `:267-268`）。**另一批（`claude/local-address-dedup`）只改 `:180-193` 与 `:323-325` 的 `displayAddress`**；本批只改 `:227-275` 这一段，两批不重叠 |
| 后台 toast | 每次会话弹一次「有 N 个商品库存不足（≤5）」 | `apps/admin/src/hooks/usePendingOrders.ts:90-93`；`PendingCounts` 接口 `:9-15` 不含 lowStock |
| 商品列表标红 | `p.status === 'ON_SHELF' && p.stock <= 5` 写死两处（手机卡片 / 电脑表格） | `apps/admin/src/pages/Products.tsx:596`、`:703`；多规格只能进编辑改（`:313-318` `openStockModal` 直接 toast 拦下） |
| 商品/规格模型 | `Product.stock`=有规格时 `sum(sku.stock)`（服务端 `aggregateFromSkus` `routes/admin/products.ts:112-120` 回写；前端 `Products.tsx:261` 也这么算）；`Product.channel` 是 `'EXPRESS' \| 'LOCAL'`；`ProductSku {id, productId, specText, specValues, price, stock, sortOrder}` | `apps/server/prisma/schema.prisma:82-158` |
| 库存扣减/回滚 | 下单事务内 `updateMany(stock ≥ qty)` 扣 sku 与 product；取消/退款走 `rollbackOrderStock` | `routes/orders.ts:606-632`；`utils/order-stock.ts:14-31`。**本批不动** |
| 设置存储 | `settings` 表 `key VARCHAR(64)` / `value TEXT`；每类设置一个 key + 进程内 60 秒缓存 + `sanitize` 回落默认值，写入后立刻刷缓存 | `schema.prisma:573-579`；样板 `services/printer-settings.ts:17-18,157,181`、`services/local-settings.ts:698-724`；后台读写路由 `routes/admin/settings.ts:70-96`（member / local-delivery 的 GET/PUT 写法） |
| 营业时间 | `getLocalSettings().businessHours: {start:'HH:MM', end:'HH:MM'}[]`，可能无序（`local-settings.ts:598` 处自己排过序）；`sanitize` 只保留合法 HH:MM 行，可能为空数组 | `local-settings.ts:181,413-417`；`shanghaiDateStr(now)` `:826`（上海自然日字符串）、`shanghaiMinutes(now)` `:749` |
| 心跳与手动触发 | `TICK_MS=60s`；`runSchedulerTick(overrides)` 顺序跑任务表，每个任务各自 try/catch，返回 `stats[name]=返回值`；非生产 `POST /api/admin/system/run-scheduler` 透传 overrides（`bool()`/`num()` 白名单，`routes/admin/system.ts:111-140`） | `scheduler.ts:41,110-175` |
| 心跳里的顺序 | `cancelExpired`（回滚未付款单库存）排在 `lowStock` 之前（`:117` vs `:129`） | 同一轮里先回滚再扫描，回滚只会让规格「回到 OK」（删状态），不会产生推送 |
| e2e | `sched()` 帮助函数处理 `running` 守卫（`scripts/e2e.sh:47-57`）；分片在 `:2008` 一律全部 source，**不能单跑**；`$LCAT`/`$ECAT`（`:264/:267`）、`$AT`、`sql()`（`:1723`）在分片里可用；e2e **没有**任何 `lowStock*` 断言；`e2e.sh:812-814` 会造一个默认 `stock=0`、默认 `ON_SHELF` 的商品（本批的扫描会把它当售罄单位——分片开头必须先「冲刷」一轮） |
| 后台导航 | `centerTabs.catalog` 两项（`navigation.ts:50-53`）；`navigation.test.ts:35` **钉住了这两个 label**（必改）；`BusinessCenter` 页签目前**没有角标能力**（`components/BusinessCenter.tsx`），Orders 页的角标样式在 `pages/Orders.tsx:334`；侧栏角标按 `prefix` 索引 `navBadge`/`badgeTitle`（`Layout.tsx:54-62`），三处渲染都走 `badgeOf(item.prefix)`（`:132,:186,:243`），**加一项 `'/catalog'` 即可，不得改成按 `to` 索引** |
| 路由 | `App.tsx:71-75` `catalog` 下 `products`/`categories` |
| 表格外壳 | `components/ui/Table.tsx`：`head/columns/children/mobileCards`（<md 卡片、≥md 表格） |
| 本批用的 node_modules | worktree 无私有 `node_modules`，`require.resolve('@prisma/client')` 解析到 `/Users/yumingyi/food-shop/node_modules`（主仓）；零迁移所以 client 与 schema 一致，**不需要也不要 `prisma generate`** |
| 基线（本 worktree 实跑） | `npm test --workspace=apps/admin` → 143 pass / 0 fail；`npx tsc --noEmit -p apps/server` → exit 0；`cd apps/admin && npx tsc --noEmit` → exit 0 |

### 0.3 本批的业务规则（店主 2026-09-24 已定，写成可执行的判据）

- **单位**：一个「库存单位」= 有规格商品的每个规格；无规格商品就是商品本身。只统计 `deletedAt = null && status = 'ON_SHELF'` 的商品。
- **档位**（`lowThreshold` 默认 3，可改）：`stock ≤ 0` → 售罄（OUT）；`0 < stock ≤ lowThreshold` → 紧张（LOW）；否则 OK。
- **即时推送档位**（`pushBelow` 默认 2，可改，约束 `1 ≤ pushBelow ≤ lowThreshold`）：`stock ≤ 0` → 推「售罄」；`0 < stock < pushBelow` → 推「低于 pushBelow」；否则不推。
- **去重状态**：每个单位记「已推的最高严重度」`'LOW' | 'OUT'`；转移规则（本批的核心，必须有纯函数测试）：
  - 当前不该推（`stock ≥ pushBelow`）→ 删掉该单位的状态（**重置**）；
  - 当前 LOW：无状态 → 推 LOW 并记 LOW；已是 LOW 或 OUT → 不推（0→1 不算补货，不重置）；
  - 当前 OUT：已是 OUT → 不推；无状态或 LOW → 推 OUT 并记 OUT（≥pushBelow 直接跌到 0 只推一条售罄）；
  - 单位不再在架/被删 → 状态一并丢弃（重新上架时若仍售罄会再推一条，视为新事件）。
- **每日汇总**：取当天营业时段里最早的 `start`，减 30 分钟为「应发时刻」；当天（上海日）还没发过且 `now ≥ 应发时刻` → 发一次并记 `dailySentOn = 今天`；没有任何售罄/紧张单位时不发但同样记「今天已处理」；`businessHours` 为空 → 不发。首次上线当天若已过应发时刻会立刻补发一次（可接受，一次性）。

## 验收标准

所有命令在 worktree 根目录跑；服务端命令加 `TZ=Asia/Shanghai`；`grep` 用 `command grep`。

1. 【服务端类型】`npx tsc --noEmit -p apps/server` → exit 0、无输出。
2. 【服务端纯函数自测】`cd apps/server && TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-low-stock.ts` → 末行 `全部通过 N`（N ≥ 24），且下列行为各有用例（做错即红）：
   - a. `sanitizeLowStockSettings`：空/非法输入 → `{ lowThreshold: 3, pushBelow: 2 }`；`pushBelow > lowThreshold` → 回落到 `lowThreshold`；负数/小数/字符串 → 默认值；上限 999。
   - b. `classifyStock(stock, s)`：`0`/`-1` → `'OUT'`；`1..3` → `'LOW'`；`4` → `'OK'`；`lowThreshold=5` 时 `5` → `'LOW'`、`6` → `'OK'`。
   - c. `pushLevelOf(stock, s)`：`0` → `'OUT'`；`1` → `'LOW'`；`2` → `null`；`pushBelow=1` 时 `1` → `null`。
   - d. `diffAlertTransitions(prevLevels, units, s)` 矩阵（每条一个用例，断言 `pushes` 与 `nextLevels`）：
     - 3→1：推 `LOW`，状态 LOW；再扫一次（仍 1）：不推；
     - 1→0：推 `OUT`，状态 OUT；再扫：不推；
     - 0→1：不推，状态仍 OUT；1→0：不推；
     - 0→5：不推，状态删除；随后 5→0：推 `OUT`（只一条，没有 LOW）；
     - 3→0（无状态直接跌到 0）：只推一条 `OUT`；
     - 单位从 units 里消失（下架）：状态删除；
     - 同一轮多个单位各自独立（两个单位同时跌到 0 → 两条 push、两个状态）。
   - e. `dailySummaryDueAt(businessHours, now)`：`[{16:30-19:30},{10:00-14:30}]`（故意乱序）+ `now = 2026-09-24 08:00 上海` → 当天 `09:30` 上海（断言 `getHours()===9 && getMinutes()===30` 且同一天）；`[{00:10-12:00}]` → 前一天 `23:40`（跨零点减法不炸）；`[]` → `null`。
   - f. `shouldSendDaily(state, businessHours, now)`：`dailySentOn === 今天` → false；`now < due` → false；`now ≥ due` 且未发 → true；`businessHours=[]` → false。
   - g. 文案纯函数 `buildLowStockChangeContent(pushes, s)` / `buildLowStockDailyContent(overview, s)`：含 `同城`/`邮寄` 渠道字、商品名与规格文本、`（低于 2）`/`已售罄`/`≤3` 等门槛数字来自参数不是写死（用 `lowThreshold=4, pushBelow=3` 跑一遍，断言出现 `4` 与 `3`、不出现 `≤3`）；超过 30 行截断并带「…其余 N 项」。
3. 【既有服务端自测不回归】`cd apps/server && TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-local-settings.ts` → `全部通过 35`（不改）；`scripts/selftest-product-sort.ts` → 全过（不改）。
4. 【后台单测】`npm test --workspace=apps/admin` → `fail 0`、`pass ≥ 143 + 新增`，其中：
   - a. `apps/admin/src/navigation.test.ts:35` 期望改为 `['商品列表', '分类管理', '库存预警']`（放开旧断言，改成新断言）；
   - b. 新 `apps/admin/src/utils/stock-alert.test.ts`：`stockAlertLabel({out,low}, hasSkus)`：`{1,0}`+有规格 → `'1 个规格售罄'`；`{2,3}` → `'2 个规格售罄 · 3 个紧张'`；`{0,1}`+无规格 → `'库存紧张'`；`{1,0}`+无规格 → `'已售罄'`；`{0,0}` → `''`；`filterLowStockGroups(groups, { level, channel })`：`level='OUT'` 只留有售罄单位的组且组内只留售罄单位；`channel='LOCAL'` 只留同城组；两者叠加；`countLowStock(groups)` → `{ total, out, low }` 与手算一致。
5. 【后台构建与闸门】`npm run build --workspace=apps/admin` → exit 0（内含 `scripts/check-admin-timezone.mjs` 时区闸门 + `tsc` + `vite build`）。新页面时间/日期一律不出现 `getHours/getDate/toLocale*`（否则闸门红）。
6. 【接口契约】本地起 API（`.claude/launch.json` 的 `api-3100` 那套 env：全 mock + `SCHEDULER_DISABLED=true`；换端口时改 PORT）后，用管理员 token：
   - a. `GET /api/admin/settings/low-stock` → `{ lowThreshold: 3, pushBelow: 2 }`（未设置过时是默认值）；`PUT` `{ lowThreshold: 4, pushBelow: 3 }` → 回显同值；`PUT { lowThreshold: 3, pushBelow: 5 }` → `code 40001`；`PUT { lowThreshold: 0 }` → `40001`；
   - b. `GET /api/admin/orders/pending-count` → `lowStockCount` 为整数、`lowStockThreshold` 等于当前设置；
   - c. `GET /api/admin/products/low-stock` → `{ settings, counts:{ total, out, low, byChannel:{EXPRESS:{out,low},LOCAL:{out,low}} }, groups:[...] }`，`groups[].units[]` 只含 `level ∈ {'OUT','LOW'}`；
   - d. `PUT /api/admin/products/:id/stock` 见 e2e 分片（验收 7）。
7. 【e2e】新分片 `scripts/e2e.d/74-low-stock.sh`，并跑**干净库全量** `TZ=Asia/Shanghai DB_NAME=<本批库> BASE=http://localhost:<port> bash scripts/e2e.sh`（≈10 分钟，后台跑；配方见 §环境）→ 末行 `失败 0`；出现红时对照已知偶发清单判定，偶发以外的红即失败。分片 74 必须覆盖并全绿：
   - 74.0 设置：`PUT /admin/settings/low-stock {lowThreshold:3,pushBelow:2}` → code 0；非法 `{3,5}` → 40001。
   - 74.1 造数：`POST /admin/products`（`categoryId=$LCAT`，`specDimensions:[{name:'辣度',values:['微辣','中辣','白味']}]`，`skus` 三条 stock 10）与一个无规格邮寄商品（`$ECAT`，stock 10）；记 `P74`、三个 `skuId`、`Q74`。然后 `sched '{}'` 一次**冲刷**（把别的分段留下的售罄单位先推掉，不断言数值）。
   - 74.2 改库存接口：`PUT /admin/products/$P74/stock {skuId:A, stock:1}` → `code 0`、`data.stock=1`、`data.productStock=21`；`sql "SELECT stock FROM products WHERE id=$P74"` = 21；`PUT {stock:1}`（不带 skuId）打在多规格商品上 → 40001；`PUT {skuId:A, stock:1}` 打在 `$Q74` 上 → 40001；`PUT {skuId:<别的商品的 sku>, stock:1}` 打在 `$P74` → 40401；`PUT {stock:-1}` → 40001。
   - 74.3 列表与角标：`GET /admin/products/low-stock` 里 `P74` 组有 A 且 `level='LOW'`；`GET /admin/orders/pending-count` → `lowStockCount ≥ 1`、`lowStockThreshold=3`；`GET /admin/products?keyword=<P74 名>` → `.data.list[0].stockAlert == {out:0,low:1}`。
   - 74.4 推送去重（断言 `sched` 返回的 `.data.lowStockScan`，用 `num()` 兜底）：A=1 → `sched` = 1；再 `sched` = 0；A=0 → 1；A=1 → 0；A=0 → 0；A=5 → 0；A=0 → 1（直接跌到 0 只推一条）；B=1 且 C=0 同时 → 2。
   - 74.5 只统计在架：`PUT /admin/products/$P74 {status:'OFF_SHELF'}` → `low-stock` 不含 `P74`、`?keyword=` 列表 `stockAlert == {0,0}`；`sched` = 0；重新 `ON_SHELF` → `sched` = 2（B、C 作为新事件再推；A 此时为 0 也再推 → 实际是 3，**执行者按实际实现的语义写死期望并在注释里说明**）。
   - 74.6 无规格商品：`PUT /admin/products/$Q74/stock {stock:0}` → `code 0`、`productStock=0`；`low-stock` 里 `Q74` 组 `hasSkus=false`、单位 `skuId=null`、`level='OUT'`；`?keyword=` 列表 `stockAlert == {1,0}`。
   - 74.7 每日汇总：`sched '{"forceLowStockDaily":true}'` → `.data.lowStockDaily ≥ 1`；紧接着 `sched '{}'` → `.data.lowStockDaily == 0`（当天已发）；再 `sched '{"forceLowStockDaily":true}'` → `≥ 1`（force 绕过日切）。
   - 74.8 收尾：两个商品 `DELETE`；`PUT /admin/settings/low-stock` 复位为 `{3,2}`；再 `sched '{}'` 一次让状态里的 P74/Q74 键被清掉。
   - 既有分段 `e2e.sh:162-165`（§10 pending-count 字段）、`:325-339`（§20b 把库存钉到 5 再复位 50）、`:794-814`（§23a 默认 stock=0）**不改**，须仍绿。
8. 【范围】`git diff --stat BASE -- apps/miniapp apps/server/prisma apps/server/src/routes/orders.ts apps/server/src/routes/cart.ts apps/server/src/utils/order-stock.ts apps/server/src/services/refund.ts apps/server/src/services/refund-reconcile.ts apps/server/src/services/wechat-pay.ts apps/server/src/services/notify.ts apps/server/src/services/local-settings.ts apps/server/src/services/member scripts/e2e.sh scripts/deploy.sh` → 空。`git diff BASE -- apps/server/src/routes/admin/orders.ts` 只落在 `pending-count` 处理函数（BASE `:227-275`）与顶部 import 两处。
9. 【人工检查·后台页面】本地起 API + admin dev（`.claude/launch.json` `admin`，代理到本批 API 端口），用 SQL/接口把几个规格钉成 0 与 1–3，截图存 `docs/superpowers/notes/2026-09-24-low-stock-acceptance/`（只放 PNG，文件名带 `375-` / `desk-` 前缀）：
   - 375 宽（DevTools 设备模式 375×812）：`商品管理` 页签条通栏三项一行不横滑，「库存预警」带红色数字角标；顶栏入口网格「商品管理」格右上角有角标；页面顶部门槛卡片两个数字输入 + 保存；筛选胶囊一行可横滑；每组卡片：商品名 + 同城/邮寄标签 + 「N 个售罄、M 个紧张」；每行：规格文本、`售罄`/`剩 N 份` 胶囊、数字输入、保存；改一个规格库存到 10 点保存 → 该行消失、toast「已保存」。判定：与预览页「手机」栏逐格一致。
   - ≥1024 宽：左侧/顶栏「商品管理」带角标；表格四列「商品 / 规格 / 状态 / 改库存」，同商品多行只在第一行显示商品名；其余同上。判定：与预览页「电脑」栏逐格一致。
   - 商品列表页（两档）：多规格商品名旁出现「N 个规格售罄」红标 /「N 个规格紧张」琥珀标；无规格库存 0 显示「已售罄」；下架商品无标；库存数字仅在有售罄时红、仅紧张时琥珀。**不再**出现「总库存 ≤5 才红」的旧规则（把一个总库存 60、含 3 个 0 规格的商品放上去看）。
   - 门槛改成 5/3 保存后：列表、角标、筛选计数都按新门槛变（30 秒轮询后角标才变，页内计数立刻变）。
10. 【人工检查·推送】在本机把 `ORDER_NOTIFY_WECOM_WEBHOOK` 指到一个能看内容的地址（如 `python3 -m http.server` 后面接的 `nc -l`，或临时企微测试群），把一个规格钉到 1、再到 0，`SCHEDULER_DISABLED` 不设、等两次心跳：收到两条（「低于 2」与「已售罄」），再补到 5、再到 0：只收到一条「已售罄」。把营业时间第一段 `start` 改成「当前上海时间 + 31 分钟」再等心跳：不发；改成「+29 分钟」→ 下一次心跳发汇总；同一天再改回去不再发。把三条实际收到的内容原文贴进报告。

## 实现方向

1. **设置服务** 新建 `apps/server/src/services/low-stock-settings.ts`（照 `printer-settings.ts` 的 key/sanitize/cache/get/set/clearCache 结构）：`LOW_STOCK_SETTINGS_KEY='low_stock'`；`interface LowStockSettings { lowThreshold: number; pushBelow: number }`；`DEFAULT = {3, 2}`；`sanitizeLowStockSettings(raw)`：整数、`1 ≤ lowThreshold ≤ 999`、`1 ≤ pushBelow ≤ lowThreshold`（越界回落默认/夹到 lowThreshold）；`validateLowStockSettings(raw): string[]`（给 PUT 用：非整数/越界/`pushBelow > lowThreshold` 各一条中文错误）；`getLowStockSettings()`（60 秒缓存）、`setLowStockSettings()`（写后刷缓存）。（预计涉及：新文件）
2. **状态与判定纯函数** 新建 `apps/server/src/services/low-stock.ts`：
   - 类型：`StockUnit { key: string; productId; productName; channel: Channel; skuId: number|null; specText: string|null; stock: number }`（`key = sku:<id> | product:<id>`）、`AlertLevel = 'OUT'|'LOW'`、`AlertState { levels: Record<string, AlertLevel>; dailySentOn: string|null }`。
   - 纯函数：`classifyStock`、`pushLevelOf`、`diffAlertTransitions(prev, units, s) → { pushes: {unit, level}[]; nextLevels; changed: boolean }`、`dailySummaryDueAt(businessHours, now): Date|null`（`toMin(start)` 取最小值再减 30 分钟，用 `new Date(now)` 设 `setHours(h, m-30, 0, 0)`——进程已钉 Asia/Shanghai，`shanghaiDateStr` 用来记 `dailySentOn`）、`shouldSendDaily(state, businessHours, now)`、`unitsOfProducts(products)`（展平）、`groupUnits(units, s)`（页面结构 + counts）、`productAlertSummary(product, s) → {out, low}`（`status !== 'ON_SHELF'` → `{0,0}`）。
   - DB 函数：`getAlertState()/saveAlertState()`（`Setting(key='low_stock_alert_state')`，照 `cron-state.ts:19-36`，解析失败回默认）；`listOnShelfUnits()`（一条 `product.findMany({ where:{deletedAt:null,status:'ON_SHELF'}, select:{id,name,channel,stock,coverImage,skus:{select:{id,specText,stock,sortOrder},orderBy:{sortOrder:'asc'}}} })` 展平）；`lowStockOverview(s?)`（页面用）；`countLowStockUnits(s?)`（pending-count 用）；`scanLowStockAlerts(): Promise<number>`（读设置 + 状态 + 单位 → diff → 有 push 则 `notifyLowStockChange(pushes, s)` → `changed` 才写状态 → 返回 push 条数，**通道未配置也照常计数与写状态**）；`pushDailyLowStockSummary(now = new Date(), force = false): Promise<number>`（`force` 绕过 `dailySentOn` 与应发时刻；读 `getLocalSettings().businessHours`；发出后写 `dailySentOn = shanghaiDateStr(now)`；返回汇总里的单位数，不发返回 0）。
   - 文案纯函数放在这里导出（`buildLowStockChangeContent`、`buildLowStockDailyContent`），`order-notify.ts` 只负责投递。（预计涉及：新文件；`services/order-notify.ts`）
3. **通知** `services/order-notify.ts:293-305`：删 `notifyLowStock`，新增 `notifyLowStockChange(pushes, s)` 与 `notifyLowStockDaily(overview, s)`，各自 `if (!wecom && !pushplusToken) return`，内容用第 2 步的 builder，PushPlus 标题分别「库存告急 N 项」「今日库存清单」；渠道字用 `{ LOCAL:'同城', EXPRESS:'邮寄' }`。（预计涉及：`services/order-notify.ts`）
4. **scheduler** `services/scheduler.ts`：删 `LOW_STOCK_PUSH_INTERVAL_MS`（:42）、`lastLowStockPushAt`（:46）、`pushLowStock`（:263-276）及 `LOW_STOCK_THRESHOLD`/`notifyLowStock` import；任务表 `:129` 改为两行 `['lowStockScan', scanLowStockAlerts]`、`['lowStockDaily', () => pushDailyLowStockSummary(new Date(), overrides.forceLowStockDaily)]`（位置不变，仍在 `cancelExpired` 之后）；`SchedulerOverrides` 加 `forceLowStockDaily?: boolean`（注释照 `forceDailyMemberTasks`）；`routes/admin/system.ts:119-140` 的 `runSchedulerTick({...})` 加 `forceLowStockDaily: bool(body.forceLowStockDaily)`。`utils/constants.ts:1-2` 删 `LOW_STOCK_THRESHOLD`。（预计涉及：`scheduler.ts`、`routes/admin/system.ts`、`utils/constants.ts`）
5. **pending-count** `routes/admin/orders.ts:227-275`：处理函数开头 `const lowStock = await getLowStockSettings()`；`Promise.all` 第 7 项换成 `countLowStockUnits(lowStock)`；响应 `lowStockThreshold: lowStock.lowThreshold`；删 `LOW_STOCK_THRESHOLD` import。**只动这一段**（与同城地址去重那批的 `:180-193`/`:323-325` 不重叠）。（预计涉及：`routes/admin/orders.ts`）
6. **设置路由** `routes/admin/settings.ts`：加 `GET /low-stock`（返回 `getLowStockSettings()`）与 `PUT /low-stock`（zod `{ lowThreshold: int 1..999, pushBelow: int 1..999 }` → `validateLowStockSettings` 有错抛 `AppError(40001, errs.join('；'))` → `setLowStockSettings`），写法照 `:70-85` 的 member。（预计涉及：`routes/admin/settings.ts`）
7. **商品路由** `routes/admin/products.ts`：
   - `GET /low-stock`（**注册在所有 `/:id` 路由之前**，与 `batch-status`/`qrcode/batch` 同一理由）→ `success(res, await lowStockOverview())`；响应结构：`{ settings:{lowThreshold,pushBelow}, counts:{ total,out,low, byChannel:{EXPRESS:{out,low},LOCAL:{out,low}} }, groups:[{ productId, productName, channel, coverImage, hasSkus, out, low, units:[{ key, skuId, specText, stock, level }] }] }`；组排序：先含售罄的组，再按最小库存升序，再 `productId` 升序；组内按 `sortOrder`。
   - `PUT /:id/stock`：zod `{ skuId: int positive nullable optional, stock: int ≥ 0 ≤ 999999 }`；事务内：商品存在且未删（否则 40401）；`skuId` 有值 → `productSku.findFirst({ id, productId })` 不存在 → `40401 '规格不存在'`，`update sku.stock`，再 `aggregate _sum.stock where productId` 回写 `product.stock`；`skuId` 空 → 商品若有任一 sku → `40001 '多规格商品请按规格改库存'`，否则直接写 `product.stock`。响应 `{ productId, skuId, stock, productStock }`。**不碰 salesCount，不碰 price**。
   - `GET /`：两个分支的 `withSales` 之后再 map 一层加 `stockAlert: productAlertSummary(p, s)`（`s` 在处理函数开头 `await getLowStockSettings()` 一次）。（预计涉及：`routes/admin/products.ts`）
8. **后台 API/类型** `apps/admin/src/api/admin.ts`：`getPendingOrderCount` 类型不变（字段已在）；新增 `getLowStockOverview()`、`updateUnitStock(productId, { skuId, stock })`、`getLowStockSettings()/updateLowStockSettings()`，返回类型放 `types.ts`（`LowStockOverview`、`LowStockGroup`、`LowStockUnit`、`LowStockSettings`）；`Product` 加 `stockAlert?: { out: number; low: number }`。（预计涉及：`api/admin.ts`、`types.ts`）
9. **计数下发与角标**：`hooks/usePendingOrders.ts`：`PendingCounts` 加 `lowStockCount: number; lowStockThreshold: number`（`ZERO_COUNTS` 同步补 0/3），state 加两项并在 `poll` 里 `set`；**删掉** `:90-93` 那段一次性 toast 与 `lowStockNotifiedRef`（见待用户决定 ①，默认按删执行）。`components/Layout.tsx:54-62`：`navBadge['/catalog'] = lowStockCount`、`badgeTitle['/catalog'] = \`售罄或紧张的规格 ${lowStockCount}\``（其余三处渲染不动）。`components/BusinessCenter.tsx`：props 加可选 `badges?: Record<string, number>`（按 `tab.to` 取），页签文字后按 `pages/Orders.tsx:334` 的红色胶囊样式渲染 `>0` 的值（`>99` 显示 `99+`）；`pages/CatalogCenter.tsx` 用 `usePendingCounts()` 传 `{ '/catalog/low-stock': lowStockCount }`。`navigation.ts:50-53` `centerTabs.catalog` 追加 `{ to: '/catalog/low-stock', label: '库存预警' }`；`App.tsx:71-75` 加 `<Route path="low-stock" element={<LowStock />} />`。（预计涉及：这六个文件 + `navigation.test.ts`）
10. **库存预警页** 新建 `apps/admin/src/pages/LowStock.tsx` + 纯函数 `apps/admin/src/utils/stock-alert.ts`（`stockAlertLabel`、`filterLowStockGroups`、`countLowStock`、`unitLabel(stock, s)`：`0` → `'售罄'`，否则 `'剩 N 份'`）：
   - 顶部卡片：`剩余 ≤ [lowThreshold] 份算「紧张」，0 为「售罄」　剩余低于 [pushBelow] 份立即推送　[保存]`，副文案「按规格判断；多规格商品任何一个规格到门槛都会列出来；每天开店前 30 分钟推一次清单」。两个 `type="number" inputMode="numeric" min=1`，改动后 `setDirty(true)`（`useUnsavedSettings`，照 `BusinessHoursSettings.tsx:17`），保存成功 `setDirty(false)` + toast + 重新拉 overview；后端 40001 的 message 原样 toast。
   - 筛选胶囊一行（`overflow-x-auto`）：`全部 N`、`售罄 N`、`紧张 N`（互斥三选一）+ `同城`、`邮寄`（可单选、再点取消）；计数来自 `countLowStock`（按当前渠道筛选后的组算）。
   - 列表用 `Table`（`head` 四列：商品 / 规格 / 状态 / 改库存；`mobileCards` 每组一张卡：商品名 + 渠道小标签（同城蓝 / 邮寄紫，颜色照预览）+ 右侧灰字「N 个售罄、M 个紧张」；每行：`specText`（无规格显示「—」）、状态胶囊（售罄红 / 剩 N 份琥珀）、数字输入（`w-16`，`inputMode="numeric"`，`min=0`）、「保存」按钮（值未改时 disabled）。电脑表格同商品多行只第一行显示商品名+渠道标签（`rowSpan` 或空单元格都行，预览用的是空单元格）。
   - 保存：`updateUnitStock` 成功 → toast `已保存：<商品>（<规格>）库存 N` → 重新拉 overview（该行自然消失/降级）；失败 toast 后端 message。
   - 空态：「没有售罄或紧张的规格」。加载态用 `Table` 自带骨架。
   - 页头主操作槽（`CenterAction`）放一个「刷新」按钮。
   （预计涉及：新页面、新 util、新测试）
11. **商品列表** `pages/Products.tsx`：`:596` 与 `:703` 两处把 `p.stock <= 5` 的判定换成 `const alert = p.stockAlert ?? {out:0,low:0}`：库存数字 `alert.out>0 ? 'text-red-500 font-semibold' : alert.low>0 ? 'text-amber-600 font-semibold' : ...`；商品名旁（手机 `:567` 附近的「N 规格」标签后、电脑名称单元格）渲染 `stockAlertLabel(alert, hasSkus)` 非空时的小胶囊（售罄红底 / 仅紧张琥珀底）。`:313-318` 的 toast 文案改为「多规格商品请在「编辑」或「库存预警」页改各规格库存」。（预计涉及：`pages/Products.tsx`）
12. **文档** `docs/api.md`：§3.3 增 `GET /api/admin/products/low-stock`、`PUT /api/admin/products/:id/stock` 两小节与 `GET /api/admin/products` 的 `stockAlert` 字段说明；附录 A「管理端」表补 `GET/PUT /api/admin/settings/low-stock` 与 `pending-count.lowStockCount` 新口径（「在架商品的售罄+紧张**规格**数，门槛可改」）；`run-scheduler` 行补 `forceLowStockDaily`；在附录 M 之后新加「附录 N：库存预警（2026-09-24）」写清档位、去重规则、每日汇总时刻、`Setting(key=low_stock / low_stock_alert_state)` 两个 key。（预计涉及：`docs/api.md`）
13. **测试** 新建 `apps/server/scripts/selftest-low-stock.ts`（照 `selftest-product-sort.ts` 的 `t()` 计数风格；末行 `console.log(\`全部通过 ${pass}\`)` 且失败时 `process.exitCode=1`）、`scripts/e2e.d/74-low-stock.sh`（照 `62-pickup.sh` 的 `p62_put` 写法封装 `p74_stock`、`p74_sched`；全部数值断言经 `num()`；所有变量带 `P74_`/`Q74_` 前缀；**不得使用 `R1`/`R2` 变量名**，见 `e2e.sh:141-146` 注释）、`apps/admin/src/utils/stock-alert.test.ts`；改 `apps/admin/src/navigation.test.ts:35`。
14. **验证与交付**：按验收 1–10 逐条跑并附原始输出；e2e 用 §环境 的干净库配方；截图存 notes 目录；交付报告按协议 §4 格式。

## 授权范围

```
apps/server/src/services/low-stock.ts
apps/server/src/services/low-stock-settings.ts
apps/server/src/services/order-notify.ts
apps/server/src/services/scheduler.ts
apps/server/src/utils/constants.ts
apps/server/src/routes/admin/orders.ts
apps/server/src/routes/admin/products.ts
apps/server/src/routes/admin/settings.ts
apps/server/src/routes/admin/system.ts
apps/server/scripts/selftest-low-stock.ts
apps/admin/src/App.tsx
apps/admin/src/navigation.ts
apps/admin/src/navigation.test.ts
apps/admin/src/types.ts
apps/admin/src/api/admin.ts
apps/admin/src/hooks/usePendingOrders.ts
apps/admin/src/components/Layout.tsx
apps/admin/src/components/BusinessCenter.tsx
apps/admin/src/pages/CatalogCenter.tsx
apps/admin/src/pages/Products.tsx
apps/admin/src/pages/LowStock.tsx
apps/admin/src/utils/stock-alert.ts
apps/admin/src/utils/stock-alert.test.ts
scripts/e2e.d/74-low-stock.sh
docs/api.md
docs/superpowers/notes/2026-09-24-low-stock-*
docs/superpowers/notes/2026-09-24-low-stock-acceptance/**
```

限定：
- `apps/server/src/routes/admin/orders.ts` 只允许改 `GET /pending-count` 处理函数（BASE `:227-275`）与顶部 import（`:13`）；`:180-193`、`:323-325` 一带（`displayAddress`）**一个字都不动**（另一批在改）。
- `apps/server/src/utils/constants.ts` 只允许删 `LOW_STOCK_THRESHOLD` 及其注释。
- `apps/server/src/routes/admin/system.ts` 只允许在 `run-scheduler` 的 `runSchedulerTick({...})` 里加一个键。
- `apps/server/src/services/scheduler.ts` 只允许：删旧低库存三处、改任务表那一行为两行、`SchedulerOverrides` 加一个键、import 调整；其余任务不动。
- `apps/admin/src/components/Layout.tsx` 只允许在 `navBadge`/`badgeTitle` 两个对象里各加一项、解构里多取两个字段。
- `apps/admin/src/pages/Products.tsx` 只允许改两处库存标红判定、两处商品名旁加胶囊、`openStockModal` 的 toast 文案。
- `apps/admin/src/App.tsx` 只允许加一个 import 和一条 `<Route>`。

## 禁止修改

```
apps/miniapp/**
apps/server/prisma/**
apps/server/src/routes/orders.ts
apps/server/src/routes/cart.ts
apps/server/src/routes/products.ts
apps/server/src/routes/wechat-notify.ts
apps/server/src/routes/kd-*.ts
apps/server/src/services/wechat-*.ts
apps/server/src/services/refund*.ts
apps/server/src/services/notify.ts
apps/server/src/services/local-settings.ts
apps/server/src/services/express-settings.ts
apps/server/src/services/printer-settings.ts
apps/server/src/services/settings.ts
apps/server/src/services/member/**
apps/server/src/services/delivery/**
apps/server/src/services/ticket/**
apps/server/src/services/pickup*.ts
apps/server/src/utils/order-stock.ts
apps/server/src/middlewares/**
apps/server/src/config.ts
apps/server/scripts/selftest-*.ts（selftest-low-stock.ts 除外）
apps/admin/src/pages/Workbench.tsx
apps/admin/src/pages/Orders.tsx
apps/admin/src/pages/LocalOrders.tsx
apps/admin/src/pages/OrderDetail.tsx
apps/admin/src/components/ui/**
apps/admin/src/components/UnsavedSettings.tsx
scripts/e2e.sh
scripts/e2e.d/[0-6]*.sh
scripts/e2e.d/7[0-3]*.sh
scripts/deploy.sh
scripts/check-*.mjs
.claude/**
.agent/**
ecosystem.config.js
package.json
apps/*/package.json
```

## 上报条件

- 实现中发现必须改禁止清单里的任何文件（尤其 `routes/orders.ts`、`utils/order-stock.ts`、`prisma/**`）才能满足验收——停下上报，不得自行升级或绕过。
- `settings` 表 `value` 是 `TEXT`，状态 JSON 理论上够用；若实测单位数使状态 JSON 超过 60KB（不可能，生产 277 规格 ≈ 8KB）或 `prisma.setting.upsert` 在心跳里报错——上报。
- 基线检查（验收 1、3、4、5 的既有部分）在改动前就红——上报，不得顺手修。
- 干净库全量 e2e 出现已知偶发清单之外的红，且不能确定与本批相关——上报，附完整输出。
- 发现 `runSchedulerTick` 的 `running` 守卫让 74 分片的精确条数断言在**未禁用心跳**的环境下不稳定——按 `.claude/launch.json` 的 `SCHEDULER_DISABLED=true` 跑，不得放宽断言；若禁用后仍不稳定，上报。
- 后台任何一处需要新增依赖或改 `package.json`——上报。
- 发现 `BusinessCenter` 加角标后「推广运营」五页签在 375 宽横滑（现在是 344/344 卡满，见 `BusinessCenter.tsx` 注释）——本批只给商品管理传 `badges`，其它中心不传就不受影响；若仍横滑，上报截图。

## 待用户决定

- ① **后台登录时那条一次性 toast**（`usePendingOrders.ts:90-93`「有 N 个商品库存不足」）：本批默认**删除**，由页签/侧栏角标常驻替代。理由：店主已决定让同城三道菜的 100 克规格保持上架且库存为 0，那条 toast 会在每次登录时永远弹「有 12 个规格售罄」。若店主要保留，改文案为「有 N 个规格售罄或库存紧张（≤T），请到「商品管理 → 库存预警」处理」即可，其余不变。
- ② **每日汇总在休业日（`holiday`）与「今天没有任何售罄/紧张」时的行为**：本批按「休业日照常按营业时间推（店主可能正要补货）；没有任何单位时不推」执行。若店主希望休业日不推，多一条 `isHolidayOn(localSettings, today)` 判断即可，不影响其它。
- ③ **重新上架的售罄规格会再推一次**（下架时状态被丢弃，上架视为新事件，验收 74.5 钉住此行为）。若店主觉得「下架再上架不该再吵」，改为保留状态、只在 `stock ≥ pushBelow` 时删；影响只在这一处判断与 74.5 的期望值。

## 环境（给执行者）

- 本机 JST，服务端自测/e2e 必须 `TZ=Asia/Shanghai`；`grep` 是 ugrep 别名用 `command grep`；无 `timeout` 命令；worktree 不 `npm install`、不 `prisma generate`（本批零迁移，主仓 client 即可）；不裸 `git stash`；不 ssh/scp 生产机；不合并不部署。
- 干净库配方（记忆 `e2e-fresh-db-recipe`）：`docker exec -i food-shop-mysql mysql -uroot -pfoodshop_root_password -e "DROP DATABASE IF EXISTS food_shop_lowstock; CREATE DATABASE food_shop_lowstock CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON food_shop_lowstock.* TO 'foodshop_user'@'%'; FLUSH PRIVILEGES;"` → `cd apps/server && DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_lowstock" npx prisma migrate deploy && DATABASE_URL=… npx prisma db seed` → 起 API（`PORT=<空闲端口，别用 3000/3100/3106> WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true WECHAT_QRCODE_MOCK=true LOCAL_DELIVERY_PROVIDER_MOCK=true EXPRESS_PROVIDER_MOCK=true PRINTER_PROVIDER_MOCK=true SCHEDULER_DISABLED=true JWT_SECRET=<≥16 位> ADMIN_JWT_SECRET=<≥16 位> DATABASE_URL=… npx ts-node-dev --transpile-only src/app.ts`）→ `TZ=Asia/Shanghai BASE=http://localhost:<port> DB_NAME=food_shop_lowstock bash scripts/e2e.sh`。已知偶发：`e2e.d/42` B4-1 并发领券、`e2e.d/45` 打印机 4 条依赖顺序。
- 跑 e2e 时本机 `.env` 若配了 `ORDER_NOTIFY_WECOM_WEBHOOK`/`PUSHPLUS`，74 分片会真的往群里推几条测试内容——跑之前把这两个变量置空（`ORDER_NOTIFY_WECOM_WEBHOOK= ORDER_NOTIFY_PUSHPLUS_TOKEN=` 前缀），`lowStockScan` 计数不依赖通道是否配置。
- 后台人工检查：`.claude/launch.json` 的 `admin` 配置代理到 3100；本批 API 若用别的端口，临时用 `VITE_PROXY_TARGET=http://localhost:<port> npm run dev --workspace=apps/admin -- --port <空闲>`，不要改 launch.json（禁止清单）。

---

## 修订 1（2026-09-24，店主答复三条 + 分片编号冲突）

以下条目**覆盖**正文中对应内容；正文其余部分不变。正文里已把 e2e 分片从 73 统一改为 **74**（含验收 7、授权范围、禁止清单 `scripts/e2e.d/7[0-3]*.sh`）。

### R1-1 登录 toast：删除（同默认）

正文实现方向 9 照做：删 `usePendingOrders.ts:90-93` 与 `lowStockNotifiedRef`（`:50`）。正文「待用户决定 ①」关闭。

### R1-2 休业日：每日汇总不推；即时推送照常

- **休业判定复用既有口径**：`isHolidayOn(s, dateStr)`（`apps/server/src/services/local-settings.ts:829-832`：`holiday.until === null` → 无限期休业；否则 `dateStr <= until`）与 `isHolidayNow(s, now)`（`:833-835`，内部就是 `isHolidayOn(s, shanghaiDateStr(now))`）。**不另写一套**。
- `shouldSendDaily` 的签名改为 `shouldSendDaily(state, localSettings, now)`（正文 2-f 的 `businessHours` 参数换成整份 `LocalDeliverySettings`，内部取 `businessHours` 与 `holiday`）：`isHolidayNow(localSettings, now)` 为真 → `false`，**且不写 `dailySentOn`**（休业中每次心跳只是跳过；当天中途取消休业会在下一次心跳补发一次，这是「次日恢复照推」的自然推论，不是 bug）。
- `pushDailyLowStockSummary(now, force)` 的 `force` 只绕过 `dailySentOn` 与应发时刻两道门，**不绕过休业门**——否则 e2e 无法验证休业日不推。
- **即时推送在休业日照常**。理由：`local-settings.ts:786` 注释写明休业只停外送与自取，邮寄单在休业期间照常进来；后台改库存也照常；卖空仍要马上知道。不另问店主。
- 正文「待用户决定 ②」关闭。

### R1-3 下架不清状态；只有补货到 ≥ pushBelow 才重置；状态随删除清理

覆盖正文 §0.3「去重状态」最后一条与实现方向 2 的 `listOnShelfUnits`/`diffAlertTransitions`：

- **单位集合分两层**：扫描时查**所有未删商品**（`deletedAt = null`，不限 `status`）及其 sku，展平成单位并带 `onShelf: boolean`（`status === 'ON_SHELF'`）。页面 `lowStockOverview`、`countLowStockUnits`、`productAlertSummary` 仍只算 `onShelf` 的（口径不变）。
- `diffAlertTransitions(prev, units, s)` 规则改为：
  1. 单位 `stock ≥ pushBelow` → 删状态（**唯一的重置条件**，不看在架与否）；
  2. 单位 `!onShelf` 且 `stock < pushBelow` → 不推、状态**原样保留**（有就留着，没有也不新建）；
  3. 单位 `onShelf`：按正文规则推 / 记（LOW/OUT 转移不变）；
  4. `prev` 里有、`units` 里没有的 key（sku 被删、商品软删/硬删）→ 删状态。
- **状态大小上界** = 现存单位数（生产 ≈ 277 个 sku + 无规格商品数），每条 ≈ 20 字节，`settings.value` 是 `TEXT`（64KB）绰绰有余；`listOnShelfUnits` 改名 `listStockUnits` 并在注释里写明「查全部未删商品是为了按现存单位裁剪状态」。
- 正文「待用户决定 ③」关闭。

### R1-4 e2e 分片编号：74；加载方式核实

- `scripts/e2e.sh:2008` `for f in "$(dirname "$0")"/e2e.d/*.sh; do [[ -f "$f" ]] && source "$f"; done`：按文件名字典序逐个 `source`，每个分片自己造数、自己收尾；`73-local-address-dedup.sh`（另一批，已在其分支方案 `:96/:144` 占用）先于 `74-low-stock.sh` 跑。两者共用的只有 `$AT/$LCAT/$ECAT/sched()/num()/sql()` 这些正文里已列的公共 helper；74 开头的「冲刷」一轮（正文 74.1）本来就是为了把**任何**前序分片留下的售罄单位先推掉，因此 74 不依赖 73 是否存在、也不依赖 73 留下什么。反向：74 收尾会删除自己造的两个商品并复位设置，73 在它之前跑，不受影响。
- 分片内所有变量前缀 `P74_`/`Q74_`；helper 名 `p74_stock`、`p74_sched`、`p74_local_put`（照 `62-pickup.sh:6` 的 `p62_put` 写法，用于改 `holiday`）。

### 验收修订

- **验收 2-d 追加**（`diffAlertTransitions`）：
  - 单位 `onShelf=false`、`stock=0`、prev=OUT → 不推、状态仍 OUT；
  - 单位 `onShelf=false`、`stock=0`、prev 无 → 不推、状态仍无；
  - 单位 `onShelf=false`、`stock=5`、prev=OUT → 状态删除；
  - 单位从 `units` 消失（删除）、prev=OUT → 状态删除；
  - 同一轮：A 在架 0（prev OUT）、B 下架 0（prev OUT）、C 被删（prev LOW）→ 0 条 push，`nextLevels` 只剩 A、B。
- **验收 2-f 改为**：`shouldSendDaily(state, localSettings, now)`：`dailySentOn === 今天` → false；`now < due` → false；`now ≥ due` 且未发 → true；`businessHours=[]` → false；`holiday={until:null}` → false；`holiday={until:'2026-09-23'}`、`now=2026-09-24 09:40 上海` → true（休业已过）；`holiday={until:'2026-09-24'}` 同一 now → false。
- **验收 7 的 74.5 改为**：`PUT /admin/products/$P74 {status:'OFF_SHELF'}`（此时 A=0、B=1、C=0，状态里三者已是 OUT/LOW/OUT）→ `low-stock` 不含 `P74`、`?keyword=` 列表 `stockAlert == {0,0}`、`pending-count.lowStockCount` 比下架前少 3；`sched` = 0；`PUT {status:'ON_SHELF'}` → `sched` = **0**（下架再上架不再推）。随后：下架 → `PUT /stock {skuId:A, stock:5}` → 上架 → `sched` = 0（补货到 ≥2 只重置不推）→ `PUT {skuId:A, stock:0}` → `sched` = **1**（重置后再卖空会推）。
- **验收 7 新增 74.9 休业**：`p74_local_put '.holiday={until:null,reason:"e2e休业"}'` → `sched '{"forceLowStockDaily":true}'` → `.data.lowStockDaily == 0`（休业不推，force 也不推）；此时把 B 从 1 改到 0 → `sched` → `.data.lowStockScan == 1`（休业日即时推送照常）；`p74_local_put '.holiday=null'` → `sched '{"forceLowStockDaily":true}'` → `≥ 1`（恢复照推）。该段放在 74.7 之前，且结束时 `holiday` 必须复位为 `null`（`62-pickup.sh:11` 也依赖它为空）。
- **验收 7 新增 74.10 删除清理**：先 `sql "SELECT value FROM settings WHERE setting_key='low_stock_alert_state'"` 含 `sku:<A 的 id>`；`DELETE /admin/products/$P74` 后 `sched '{}'` → 同一条 SQL 不再含 `sku:<A>`、`sku:<B>`、`sku:<C>`；`DELETE $Q74` 后同理不含 `product:<Q74>`。此段并入正文 74.8 收尾。
- **验收 10（人工·推送）追加**：后台「营业时间」页把休业设为「今天起不限期」，把营业时间第一段 `start` 改成「当前 + 29 分钟」，等两次心跳：**不**收到汇总；取消休业 → 下一次心跳收到汇总。
- **验收 8（范围）**：`scripts/e2e.d/7[0-3]*.sh` 加入 `git diff --stat` 必须为空的清单。

### 授权范围修订

- `scripts/e2e.d/73-low-stock.sh` → **`scripts/e2e.d/74-low-stock.sh`**（正文已改）。
- 其余授权文件不变；`services/low-stock.ts` 允许 `import { isHolidayNow, shanghaiDateStr, getLocalSettings, type LocalDeliverySettings } from './local-settings'`（只 import，`local-settings.ts` 仍在禁止清单）。

### 禁止修改修订

- `scripts/e2e.d/7[0-2]*.sh` → **`scripts/e2e.d/7[0-3]*.sh`**（正文已改；`73-local-address-dedup.sh` 若已合入本分支基线，同样不得动）。

### 上报条件追加

- 若合并时发现 `73-local-address-dedup.sh` 与 74 之间存在共享变量名或对同一商品/设置的先后依赖（例如 73 改了 `holiday` 或 `low_stock` 设置未复位）——上报，不得在 74 里「顺手复位」对方的状态。

### 待用户决定

- 无（三条已答复；休业日即时推送照常按 R1-2 的理由自行定，不再问）。

---

## 修订 2（2026-09-24，L 级复核阻断项 R1/R2；建议项 R3–R7 的处理）

【工序】规划 【模型】Fable 5.1 【等级】L（编排者定级，§2.2 第 2 条：事务/一致性；定级只升不降）

以下条目覆盖正文与修订 1 中对应内容。行号按执行者提交 `c9df644`。

### R2-0 复核证据的亲自核实（§3.2）

在本 worktree 用 `c9df644` 起了一套隔离环境（库 `food_shop_ls_plan`、端口 3141、`SCHEDULER_DISABLED=true`、全 mock），造多规格商品 P（A/B/C 各 10）后重跑复核者的两个脚本形态（mysql 会话持锁 2 秒 + `PUT /api/admin/products/:id/stock` 并发）：

```
== race1（下单事务扣 B 期间 PUT A=5）==
before: product=30 skus=A:10,B:10,C:10
{"code":0,...,"data":{"productId":10,"skuId":7,"stock":5,"productStock":25}}
after:  product=25 skus=A:5,B:9,C:10 realSum=24        ← 丢 1
== race2（取消回滚 B+1 期间 PUT A=0）==
before: product=11 skus=A:1,B:0,C:10
after:  product=10 skus=A:0,B:1,C:10 realSum=11        ← 丢 1
```

**R1 成立**。根因如复核所述：`routes/admin/products.ts:330-333` 先 `update sku`，再 `aggregate _sum`（REPEATABLE-READ 下是事务开始时的一致性快照，读不到并发事务已提交/在途的 B），再把这个陈旧和**绝对覆盖** `product.stock`。`@@transaction_isolation = REPEATABLE-READ`、`innodb_lock_wait_timeout = 50`（本机 docker MySQL 实查）。

同一环境用 mysql 会话模拟「修订 2 的写法」（`SELECT … FOR UPDATE` 读旧值 → 写 sku 绝对值 → `product.stock = stock + (新 − 旧)`）：

```
-- 正向：扣 B 期间 PUT A=5 --      after: product=24 skus=A:5,B:9,C:10 realSum=24   ✔
-- 反向：回滚 B+1 期间 PUT A=0 --  after: product=20 skus=A:0,B:10,C:10 realSum=20  ✔
-- 死锁：两行订单（先 B 再 A）vs PUT A --
  [put] ERROR 1213 (40001): Deadlock found when trying to get lock; try restarting transaction
  [order] order-done
  after: product=28 skus=A:9,B:9,C:10 realSum=28                                   ✔（不变量保住，但 PUT 被选为牺牲者）
```

结论：相对增量 + sku→product 锁序**修得掉 R1**；两行订单（同一商品两个规格）与 PUT 之间存在**可被 InnoDB 即时检测**的死锁（不是 50 秒等待），牺牲者由 InnoDB 选（本机三次都是 PUT），所以 PUT 必须对死锁重试。这个死锁类别与**既有的**「两笔多行订单以不同顺序扣同一商品的规格」完全同类（`routes/orders.ts:612-632` 逐行 sku→product，没有重试）——本批不引入新的锁序，只是把后台改库存也纳入同一锁序。

### R2-1 [R1 阻断] `PUT /api/admin/products/:id/stock` 改为「锁读旧值 + 相对增量 + 死锁重试」

覆盖正文实现方向 7 第二条。文件 `apps/server/src/routes/admin/products.ts`（`:312-344` 那一段整体重写，其余路由不动）：

- **有规格分支**（`skuId` 非空）：事务内
  1. `tx.$queryRaw` ``SELECT id, stock FROM product_skus WHERE id = ${skuId} AND product_id = ${id} FOR UPDATE``（X 锁 sku 行；查不到 → `40401 '规格不存在'`）；
  2. `tx.productSku.update({ where: { id: skuId }, data: { stock } })`（绝对值，编辑的那个单位以店员实点数为准）；
  3. `delta = stock − 旧值`；`tx.product.update({ where: { id }, data: { stock: { increment: delta } } })`（X 锁 product 行；**相对增量**，并发的扣减/回滚不会被覆盖）；响应里的 `productStock` 取这条 update 的返回行 `.stock`，**不再 aggregate**；
  4. 事务前的 `findFirst(product)`/`count(skus)` 存在性与「有无规格」校验保留（非锁定读只用于分派错误码，不参与算术）。
- **锁序**：sku → product，与 `routes/orders.ts:612-623`（每行先 `productSku.updateMany` 再 `product.update`）和 `utils/order-stock.ts:19-30`（先 sku 再 product）**同序**。任何一方持 product 锁时都已经持有了自己那行 sku 的锁，两个单行事务之间无环。**多行订单 vs PUT** 的环（订单持 B+product 等 A；PUT 持 A 等 product）由 InnoDB 死锁检测即时打断（实测 `ERROR 1213`，不走 50 秒 `innodb_lock_wait_timeout`）。
- **死锁重试**：把整个 `prisma.$transaction(...)` 包成最多 3 次的循环，只对 Prisma `P2034`（`PrismaClientKnownRequestError`，MySQL 1213/40001 的映射）重试，两次之间 `await sleep(50 * attempt)` 毫秒；第 3 次仍失败原样抛出（走统一错误处理）。重试安全：sku 写的是绝对值、delta 每次从 `FOR UPDATE` 的新鲜值重算。重试时 `console.warn('[products] 改库存遇死锁，重试 %d/3', attempt)`。
- **无规格分支**：保持 `UPDATE products SET stock = ?`（绝对值）。理由：无规格商品没有 sum 不变量；`UPDATE` 本身会等在途订单事务的 product 行锁释放后再写，最终值就是店员的实点数；并发那一单的扣减被实点数覆盖是「绝对值编辑」的固有语义，与既有 `PUT /:id {stock}`（e2e `e2e.sh:334/:798` 在用）完全一致。写进 `docs/api.md`。
- **既有整表单 `PUT /:id`（`:346-431`）不修**，理由：它在同一事务里把每个 sku 与 `product.stock` 都从**同一份 payload** 写出（`:359-375` + `aggregateFromSkus`），任何交错下 `product.stock == SUM(sku.stock)` 都成立；它丢的只是并发那一单的扣减（绝对值编辑语义，本批之前就如此）。残留缺口：带 `stock` 但不带 `skus` 的 `PUT /:id` 打在多规格商品上（`Products.tsx:261` 用前端旧列表算的 sum）会破坏不变量——**本批之前就存在、不在本批范围**，记入本修订末尾「留后」。

### R2-2 [R1 验收] e2e 分片 74 新增 74.11「并发一致性」（放在 74.7 之后、74.8 收尾之前）

helper：`p74_sql_bg() { ( sql "$1" >/dev/null 2>&1 ) & }`（复用 `e2e.sh:1723` 的 `sql()`，后台子 shell），`p74_sum() { sql "SELECT stock FROM products WHERE id=$1;"; sql "SELECT COALESCE(SUM(stock),0) FROM product_skus WHERE product_id=$1;"; }`。每步先复位 A=B=C=10（三次 `p74_stock`）并断言 `product=30`。

| 步 | 后台 mysql 会话（`BEGIN; …; SELECT SLEEP(2); COMMIT;`） | 0.7s 后并发的接口 | 断言 |
|---|---|---|---|
| a 扣减 | `UPDATE product_skus SET stock=stock-1 WHERE id=$B AND stock>=1; UPDATE products SET stock=stock-1, sales_count=sales_count+1 WHERE id=$P` | `p74_stock $P {skuId:$A, stock:5}` | `code 0`、`data.stock=5`、`data.productStock=24`；`wait` 后 `products.stock=24`、`SUM(sku)=24`、A=5、B=9 |
| b 回滚 | `… stock=stock+1 WHERE id=$B; UPDATE products SET stock=stock+1, sales_count=sales_count-1 …`（先把 B 钉成 0） | `p74_stock $P {skuId:$A, stock:0}` | `code 0`；`wait` 后 `products.stock == SUM(sku)`，A=0、B=1（或按复位值算） |
| c 死锁 | `UPDATE sku B -1; UPDATE product -1; SELECT SLEEP(1.5); UPDATE product_skus SET stock=stock-1 WHERE id=$A AND stock>=1; UPDATE product -1` | `p74_stock $P {skuId:$A, stock:5}` | **`code 0`**（重试后成功；`e2e.sh:33` 的 `req` 不重试，所以 5xx 会直接现形）；`wait` 后 `products.stock == SUM(sku)`；A=5；B ∈ {9,10}（订单会话也可能是牺牲者，其语句整批回滚）——用 `[[ "$B" == 9 || "$B" == 10 ]]` |
| d 无规格 | `UPDATE products SET stock=stock-1, sales_count=sales_count+1 WHERE id=$Q AND stock>=1`（先把 Q 钉成 10） | `p74_stock $Q {stock:7}` | `code 0`、`productStock=7`；`wait` 后 `products.stock=7`（绝对值语义） |

- 全部数值经 `num()`；`wait` 只等本分片自己起的后台会话（74 之前的分段都已各自 `wait` 过，`e2e.sh:150` 同样用法）。四步共增加 ≈ 9 秒。
- **改坏验证**（执行者必做并贴输出）：① 把第 3 步改回 `aggregate` 绝对覆盖 → 74.11-a/b 必红（`product ≠ SUM`）；② 去掉 `P2034` 重试 → 74.11-c 连跑 3 次至少 1 次红（`code` 非 0）。本机三次复现里牺牲者都是 PUT，若执行者 3 次都是订单会话被牺牲，把 `SLEEP(1.5)` 改 `SLEEP(1)`、`sleep 0.7` 改 `sleep 0.5` 再试并注明。

### R2-3 [R2 阻断] 商品列表局部更新后 `stockAlert` 失真

覆盖正文实现方向 11 与 `Products.tsx:303-336` 现状：

- **服务端**（`routes/admin/products.ts`）：`PUT /:id`（`:429 success(res, product)`）与 `POST /`（`:241`）的响应都补 `stockAlert: productAlertSummary(product, await getLowStockSettings())`——与列表同一口径、同一门槛来源，前端不必自己算、不受 `PendingCounts` 30 秒轮询的门槛陈旧影响。`product` 已 `include: skuInclude`（含 `skus`），`productAlertSummary` 的入参形状满足。
- **前端**：`apps/admin/src/utils/stock-alert.ts` 新增纯函数 `mergeProductPatch(list, id, patch)`：把 `patch`（含 `status`/`stock`/`stockAlert` 任意子集）合并到 `id` 那一项，`patch.stockAlert === undefined` 时保留原值。`Products.tsx` 的 `handleToggleStatus`（`:306-307`）与 `handleStockSave`（`:329-330`）改为拿 `updateProduct` 的响应 `res.data.data.stockAlert`，用 `mergeProductPatch(ls, id, { status|stock, stockAlert })` 更新列表；不整页 `load()`（保留「局部更新不整页刷新」的既有设计）。
- **测试**：`stock-alert.test.ts` 加 3 例：合并 `status` 与 `stockAlert`；`patch` 无 `stockAlert` 时保留原值；不改其它 id 的项。e2e 74.12（放在 74.6 之后）：`PUT /admin/products/$P74 {status:'OFF_SHELF'}` 响应 `.data.stockAlert == {"out":0,"low":0}`；此时 A=0、B=1、C=0 → `PUT {status:'ON_SHELF'}` 响应 `{"out":2,"low":1}`；`PUT /admin/products/$Q74 {stock:50}` 响应 `{"out":0,"low":0}`、`{stock:0}` → `{"out":1,"low":0}`。
- **人工检查追加**（验收 9）：列表里把一个无规格售罄商品库存改成 50 → 红标即刻消失、数字变灰；把带售罄规格的商品下架 → 标签即刻消失；再上架 → 标签即刻回来；都不刷新页面。

### R2-4 [R6，本方案自身的验收缺口] 74.7 的「当天已发」门要可证明

修订 1 的 74.9/74.7 依赖「现在已过应发时刻」，上午 08:30（seed 默认营业 `09:00`，`local-settings.ts:329`）之前跑就证明不了。改法：74.9 开头先 `P74_BH_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data.businessHours)`，再 `p74_local_put '.businessHours=[{start:"00:00",end:"23:59"}]'`（应发时刻 = 前一天 23:30，任何时刻都已过），74.7 的三条断言不变但此后**确实**在证明日切门；74.8 收尾 `p74_local_put ".businessHours=$P74_BH_ORIG"` 复位（62 分片在 74 之前跑、且自己会重设 `businessHours`，但保持「谁改谁复位」）。

### R2-5 建议项处理（§2.4：建议项不安排修改）

- **R3**（`low-stock.ts:332-347` 读库失败/JSON 损坏当空状态）：**不修**。不与 R1/R2 同文件；且 `scanLowStockAlerts` 的 `listStockUnits` 与 `getAlertState` 打同一个库，库不可用时单位也读不出、任务在 scheduler 的 try/catch 里失败，不会形成推送风暴；JSON 损坏只会重推一轮后被合法状态覆盖。记入「留后」。
- **R4**（上线首次心跳把现有 ≤1/0 的在架规格各推一条）：店主已答复「要，推一次就行」。**不改行为**；编排者交付说明里写明：部署后第一次心跳会收到一条「库存告急」，按生产 2026-09-24 只读快照约 12 个售罄 + 若干「低于 2」，之后只推变化。
- **R5**（`LowStock.tsx` 保存行库存后 `load()` 覆盖门槛草稿；行输入不在未保存守卫内）：**不修**（不与 R1/R2 同文件）。记入「留后」。
- **R7**（`ticket/index.ts:830-832` 注释引用已删的 `lastLowStockPushAt`）：禁改文件，**留后**。

### 验收增补汇总

- 验收 7 分片 74：新增 74.11（并发一致性四步 + 两项改坏验证）、74.12（PUT/POST 响应 `stockAlert`）；74.9/74.8 按 R2-4 增改。
- 验收 4：`stock-alert.test.ts` +3 例（`pass ≥ 143 + 9 + 3`）。
- 验收 9：R2-3 的三条人工步骤。
- 验收 1/5：不变（`$queryRaw` 模板字面量需 `Prisma.sql` 类型，`tsc` 会查）。
- `docs/api.md`：`PUT /api/admin/products/:id/stock` 小节补「有规格：锁读旧值、product 相对增量、死锁自动重试 3 次；无规格：绝对值；并发语义」；`PUT /:id`、`POST /` 响应补 `stockAlert`。
- **既有断言放开情况：无**。74.2 的 `productStock=21`、74.5、74.6 的期望在相对增量下不变。

### 授权范围增减

- **不新增文件**。R1 落在 `apps/server/src/routes/admin/products.ts`（已授权）；R2 落在 `products.ts`、`apps/admin/src/pages/Products.tsx`、`apps/admin/src/utils/stock-alert.ts`、`stock-alert.test.ts`（已授权）；R6 落在 `scripts/e2e.d/74-low-stock.sh`（已授权）；`docs/api.md`（已授权）。
- 正文对 `Products.tsx` 的限定放宽一句：允许改 `handleToggleStatus`/`handleStockSave` 两个函数体（其余限定不变）。
- **禁止清单不变**，特别重申：`apps/server/src/routes/orders.ts`、`apps/server/src/utils/order-stock.ts`、`apps/server/src/services/refund.ts` 不动——修法是让 PUT 对齐它们的锁序，不是改它们。

### 上报条件增补

- Prisma 对 MySQL 1213 的映射若不是 `P2034`（用 `e.code` 与 `e.message` 实测），停下上报实际错误对象，不得按 message 文本模糊匹配。
- 74.11-c 若出现 PUT 重试 3 次仍失败（响应非 0）——上报，附 server 日志里的 `[products] 改库存遇死锁` 行。
- 分片里的 `wait` 若等到了不属于 74 的后台作业（表现为分片耗时异常或前序分段 fail）——上报，不得改 `e2e.sh`。

### 待用户决定

- 无。

### 留后（不在本批，交编排者登记）

- 既有 `PUT /:id` 带 `stock` 不带 `skus` 打在多规格商品上会用前端旧 sum 覆盖 `product.stock`（`Products.tsx:261`），本批前已存在。
- R3、R5、R7 原文见复核。

---

## 修订 3（2026-09-24，L 级全量复核 R2：锁序分析漏了外键 S 锁）

【工序】规划 【模型】Fable 5.1 【等级】L

行号按执行者提交 `91f1b0e`。

### R3-0 亲自核实（§3.2）

在本 worktree 用 `91f1b0e` 起隔离环境（库 `food_shop_ls_plan3`、端口 3142、`SCHEDULER_DISABLED=true`、全 mock；先用 mock 用户真下一单让 `orders` 表有一条可引用的 id），造双规格商品（A/B 各 100）后重跑复核者 `fk-race.sh` 的形态（mysql 会话：`INSERT order_items(product_id=P, sku_id=S)` → `SLEEP(1.5)` → 扣 sku S → 扣 product；0.7 秒时并发 `PUT /:id/stock` 改 A=5）：

```
OS=A（订单行与 PUT 同一规格）  PUT → code 0, productStock=105   retries in server.log: 1   after: product=105 SUM=105  ✔（PUT 是牺牲者，重试成功，订单不受影响）
OS=B（订单行是另一规格）       PUT → code 0, productStock=104   retries: 0                 after: product=104 SUM=104  ✔（不成环）
OS=A 重跑                      同上，retries: 1                                                                        ✔
```

再用**真实 `POST /api/orders`**（不是 SLEEP 会话）与同一规格的 `PUT` 并发：60 轮同时发、40 轮 PUT 延后 20 ms、40 轮延后 50 ms、40 轮延后 100 ms → 订单 180/180 成功、PUT 180/180 成功、**重试 0 次**、每轮结束 `product == SUM`。复核者的 26/120 是饱和压测（2 单 + 2 改库存同时打）下的数字；真实单笔下单事务里「插 order_items → 扣 sku」之间只有微秒级窗口，所以低延迟形态几乎撞不上。

**R2 成立**：`products.ts:325-330` 的「两个单行事务之间不会互相等待成环」与 `docs/api.md:792`「一张跨两个规格的订单…仍可能互锁」都漏了外键 S 锁，说法与事实不符；结果正确、重试有效。生产 MySQL 参数（编排者只读核实：`innodb_deadlock_detect=1`、`innodb_lock_wait_timeout=50`、REPEATABLE-READ、8.0.46）与本机一致，死锁由检测器即时打断、不会走 50 秒等待。

### R3-1 锁序分析改正（注释 + 文档；只改文字）

`apps/server/src/routes/admin/products.ts:314-330` 那段注释、`docs/api.md:791-792`（3.3 节「并发语义」）与 `:2316`（附录 N）统一改成下面的事实，不得再出现「单行事务之间不会成环」「只有跨两个规格的订单才会互锁」：

1. **下单事务的锁序**（`routes/orders.ts`：`order.create({ items: { create } })` 在扣减循环之前）：`INSERT order_items` 因外键 `order_items_product_id_fkey`（`prisma/migrations/20260509073712_init/migration.sql:252`）先取得 **products 行的 S 锁** → 扣 sku 行 X 锁 → 扣 products 行 X 锁（S→X 升级）。
2. **改库存接口**：sku 行 X 锁（`FOR UPDATE`）→ products 行 X 锁。
3. **成环条件**：订单行与改库存是**同一规格**——改库存持 X(sku A) 等 X(products)，被订单的 S(products) 挡住；订单接着要 X(sku A)，被改库存挡住 → 环。**单行订单也会**，不只是跨规格订单。**不同规格不成环**：订单的 S→X 升级只等其它事务**已授予**的冲突锁，改库存那个**等待中**的 X 请求不挡它（实测 OS=B 无死锁）；改库存等订单提交后再拿到 products 行。
4. **取消/退款回滚**（`utils/order-stock.ts`）没有外键插入，锁序 sku → products，与改库存只在「多行回滚跨到改库存那一规格」时成环（修订 2 的分析对这一支仍成立）。
5. **牺牲者**：InnoDB 选 undo 量小的一方，实测恒为改库存事务（订单事务已插入 `orders`/`order_items`），顾客下单不受影响；改库存捕获 `P2034` 重试，重试时重新 `FOR UPDATE` 读到订单提交后的新值，delta 仍正确。
6. 既有的「两笔多行订单以不同顺序扣同一商品」死锁（复核 R3）**不在本批**，`orders.ts` 禁改。

### R3-2 重试上限 3 → 5

`products.ts:339` `STOCK_UPDATE_MAX_ATTEMPTS = 3` 改为 `5`，退避仍 `50 × attempt` ms（最长累计等待 50+100+150+200 = 500 ms，远小于任何前端超时）。理由：按复核饱和压测的每次尝试死锁率 p ≈ 26/120 ≈ 0.22 估算，3 次连败 ≈ 1.0%、5 次连败 ≈ 0.05%；真实下单形态本机 180 轮 0 次；改库存是店员低频手工操作，多两次尝试没有代价，却把饱和场景的失败率压到可忽略。日志文案里的 `/3` 随常量变（模板字符串已引用常量，`:376` 一带核对）。改坏验证不变：去掉重试 → 74.11-c/e 现形。

### R3-3 验收增补（`scripts/e2e.d/74-low-stock.sh`）

- **74.11-e 外键 S 锁 · 同一规格**（复现 R2 形态，放在 c 之后）：复位 A=B=C=10、product=30；`P74_OID=$(sql "SELECT MAX(id) FROM orders;")`（74 之前的分段已下过单，非空；为空则 `fail` 并跳过本步）；后台会话 `BEGIN; INSERT INTO order_items (order_id,product_id,sku_id,product_name,product_price,quantity,subtotal,updated_at) VALUES ($P74_OID,$P74_PID,$P74_A,'e2e-fk-lock',1000,1,1000,NOW(3)); SELECT SLEEP(1.5); UPDATE product_skus SET stock=stock-1 WHERE id=$P74_A AND stock>=1; UPDATE products SET stock=stock-1, sales_count=sales_count+1 WHERE id=$P74_PID; COMMIT;`；0.7 秒后 `p74_stock $P74_PID {skuId:$P74_A, stock:5}` → **`code 0`**、`data.stock=5`；`wait` 后 `products.stock == SUM(sku)`、A=5、B=10、C=10（无论哪一方是牺牲者，终值都相同）；收尾 `sql "DELETE FROM order_items WHERE product_name='e2e-fk-lock';"`。
- **74.11-f 外键 S 锁 · 不同规格**（钉住「不同规格不成环」这条说法）：同上但 `sku_id=$P74_B`、扣 B；断言 `code 0`、`products.stock == SUM(sku)`、A=5、B=9；收尾同上。
- **并发真的发生了**（R4 同款证据）：74.11-a/b/c/d/e/f 每步都记 PUT 的墙钟耗时 `P74_T0=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')`（macOS `date` 无 `%N`），断言 `耗时 ≥ 700`（后台会话至少还要持锁 0.8 秒，PUT 必然在锁上等过；e/f 步 ≥ 700 同样成立：PUT 要么等订单会话到 1.5 秒后提交、要么被牺牲后重试再等）。
- **[R4] 74.11-d 改成真并发**：后台语句改为 `BEGIN; UPDATE products SET stock=stock-1, sales_count=sales_count+1 WHERE id=$Q74_PID AND stock>=1; SELECT SLEEP(2); COMMIT;`（现在是裸 UPDATE，瞬间提交，PUT 根本没等到锁），加上面的耗时 ≥ 1000 断言；终值断言 `products.stock=7` 不变（绝对值语义）。
- 改坏验证追加：把 `FOR UPDATE` 去掉（退化成快照读）→ 74.11-e 必红（`product ≠ SUM`）。

### R3-4 [R7] `docs/api.md` 附录 N 第 4 条

`docs/api.md:2299`（附录 N 列表第 4 条）「状态一并丢弃；重新上架时若仍售罄会再推一条，视为新事件」是修订 1 之前的旧口径，改为：「商品被软删或规格被删除（不再出现在扫描结果里）→ 状态一并丢弃；**下架不丢状态**，重新上架、库存仍 < `pushBelow` 的规格不再推，只有补货到 ≥ `pushBelow` 才重置（修订 1 R1-3）」。与同文件的 R3-1 改动一起做。

### 不纳入本修订

- **R6**（`services/low-stock-settings.ts` 读失败把默认值缓存 60 秒、与注释相反）：不在修订 3 涉及的文件里，按 §2.4 不安排修改；编排者登记。
- R1/R3/R5/R8/R9/R10 由编排者按协议处理，不在本修订。

### 验收增补汇总 / 既有断言放开情况

- 验收 7：74.11 新增 e、f 两步；a–f 加耗时断言；d 改真并发；改坏验证加「去掉 `FOR UPDATE`」。
- 验收 1/4/5 不变。
- **既有断言放开情况：无**。

### 授权范围增减

- 无新增文件：`apps/server/src/routes/admin/products.ts`（注释 + 一个常量）、`docs/api.md`（两处 + 附录 N 第 4 条）、`scripts/e2e.d/74-low-stock.sh`（已授权）。
- `products.ts` 限定：本修订只允许改 `:314-330` 注释块与 `STOCK_UPDATE_MAX_ATTEMPTS` 的值；事务体不动。
- 禁止清单不变；`routes/orders.ts` 不动（复核 R3 的订单互锁登记独立批次）。

### 上报条件增补

- 74.11-e 若 `SELECT MAX(id) FROM orders` 为空（分段顺序变了）——上报，不得自己造 `orders` 行。
- 74.11-e/f 若 PUT 在 5 次重试后仍非 0——上报并附 server 日志。
- 耗时断言若在执行者机器上因 docker exec 启动慢而偶发（表现为 a–f 里 PUT 耗时 < 700 但终值全对）——先把 `sleep 0.7` 改 `sleep 0.5` 重跑一次；仍偶发则上报，不得删耗时断言。

### 待用户决定

- 无。
