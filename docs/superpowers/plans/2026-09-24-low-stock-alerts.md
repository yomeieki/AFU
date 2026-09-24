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
7. 【e2e】新分片 `scripts/e2e.d/73-low-stock.sh`，并跑**干净库全量** `TZ=Asia/Shanghai DB_NAME=<本批库> BASE=http://localhost:<port> bash scripts/e2e.sh`（≈10 分钟，后台跑；配方见 §环境）→ 末行 `失败 0`；出现红时对照已知偶发清单判定，偶发以外的红即失败。分片 73 必须覆盖并全绿：
   - 73.0 设置：`PUT /admin/settings/low-stock {lowThreshold:3,pushBelow:2}` → code 0；非法 `{3,5}` → 40001。
   - 73.1 造数：`POST /admin/products`（`categoryId=$LCAT`，`specDimensions:[{name:'辣度',values:['微辣','中辣','白味']}]`，`skus` 三条 stock 10）与一个无规格邮寄商品（`$ECAT`，stock 10）；记 `P73`、三个 `skuId`、`Q73`。然后 `sched '{}'` 一次**冲刷**（把别的分段留下的售罄单位先推掉，不断言数值）。
   - 73.2 改库存接口：`PUT /admin/products/$P73/stock {skuId:A, stock:1}` → `code 0`、`data.stock=1`、`data.productStock=21`；`sql "SELECT stock FROM products WHERE id=$P73"` = 21；`PUT {stock:1}`（不带 skuId）打在多规格商品上 → 40001；`PUT {skuId:A, stock:1}` 打在 `$Q73` 上 → 40001；`PUT {skuId:<别的商品的 sku>, stock:1}` 打在 `$P73` → 40401；`PUT {stock:-1}` → 40001。
   - 73.3 列表与角标：`GET /admin/products/low-stock` 里 `P73` 组有 A 且 `level='LOW'`；`GET /admin/orders/pending-count` → `lowStockCount ≥ 1`、`lowStockThreshold=3`；`GET /admin/products?keyword=<P73 名>` → `.data.list[0].stockAlert == {out:0,low:1}`。
   - 73.4 推送去重（断言 `sched` 返回的 `.data.lowStockScan`，用 `num()` 兜底）：A=1 → `sched` = 1；再 `sched` = 0；A=0 → 1；A=1 → 0；A=0 → 0；A=5 → 0；A=0 → 1（直接跌到 0 只推一条）；B=1 且 C=0 同时 → 2。
   - 73.5 只统计在架：`PUT /admin/products/$P73 {status:'OFF_SHELF'}` → `low-stock` 不含 `P73`、`?keyword=` 列表 `stockAlert == {0,0}`；`sched` = 0；重新 `ON_SHELF` → `sched` = 2（B、C 作为新事件再推；A 此时为 0 也再推 → 实际是 3，**执行者按实际实现的语义写死期望并在注释里说明**）。
   - 73.6 无规格商品：`PUT /admin/products/$Q73/stock {stock:0}` → `code 0`、`productStock=0`；`low-stock` 里 `Q73` 组 `hasSkus=false`、单位 `skuId=null`、`level='OUT'`；`?keyword=` 列表 `stockAlert == {1,0}`。
   - 73.7 每日汇总：`sched '{"forceLowStockDaily":true}'` → `.data.lowStockDaily ≥ 1`；紧接着 `sched '{}'` → `.data.lowStockDaily == 0`（当天已发）；再 `sched '{"forceLowStockDaily":true}'` → `≥ 1`（force 绕过日切）。
   - 73.8 收尾：两个商品 `DELETE`；`PUT /admin/settings/low-stock` 复位为 `{3,2}`；再 `sched '{}'` 一次让状态里的 P73/Q73 键被清掉。
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
13. **测试** 新建 `apps/server/scripts/selftest-low-stock.ts`（照 `selftest-product-sort.ts` 的 `t()` 计数风格；末行 `console.log(\`全部通过 ${pass}\`)` 且失败时 `process.exitCode=1`）、`scripts/e2e.d/73-low-stock.sh`（照 `62-pickup.sh` 的 `p62_put` 写法封装 `p73_stock`、`p73_sched`；全部数值断言经 `num()`；所有变量带 `P73_`/`Q73_` 前缀；**不得使用 `R1`/`R2` 变量名**，见 `e2e.sh:141-146` 注释）、`apps/admin/src/utils/stock-alert.test.ts`；改 `apps/admin/src/navigation.test.ts:35`。
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
scripts/e2e.d/73-low-stock.sh
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
scripts/e2e.d/7[0-2]*.sh
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
- 发现 `runSchedulerTick` 的 `running` 守卫让 73 分片的精确条数断言在**未禁用心跳**的环境下不稳定——按 `.claude/launch.json` 的 `SCHEDULER_DISABLED=true` 跑，不得放宽断言；若禁用后仍不稳定，上报。
- 后台任何一处需要新增依赖或改 `package.json`——上报。
- 发现 `BusinessCenter` 加角标后「推广运营」五页签在 375 宽横滑（现在是 344/344 卡满，见 `BusinessCenter.tsx` 注释）——本批只给商品管理传 `badges`，其它中心不传就不受影响；若仍横滑，上报截图。

## 待用户决定

- ① **后台登录时那条一次性 toast**（`usePendingOrders.ts:90-93`「有 N 个商品库存不足」）：本批默认**删除**，由页签/侧栏角标常驻替代。理由：店主已决定让同城三道菜的 100 克规格保持上架且库存为 0，那条 toast 会在每次登录时永远弹「有 12 个规格售罄」。若店主要保留，改文案为「有 N 个规格售罄或库存紧张（≤T），请到「商品管理 → 库存预警」处理」即可，其余不变。
- ② **每日汇总在休业日（`holiday`）与「今天没有任何售罄/紧张」时的行为**：本批按「休业日照常按营业时间推（店主可能正要补货）；没有任何单位时不推」执行。若店主希望休业日不推，多一条 `isHolidayOn(localSettings, today)` 判断即可，不影响其它。
- ③ **重新上架的售罄规格会再推一次**（下架时状态被丢弃，上架视为新事件，验收 73.5 钉住此行为）。若店主觉得「下架再上架不该再吵」，改为保留状态、只在 `stock ≥ pushBelow` 时删；影响只在这一处判断与 73.5 的期望值。

## 环境（给执行者）

- 本机 JST，服务端自测/e2e 必须 `TZ=Asia/Shanghai`；`grep` 是 ugrep 别名用 `command grep`；无 `timeout` 命令；worktree 不 `npm install`、不 `prisma generate`（本批零迁移，主仓 client 即可）；不裸 `git stash`；不 ssh/scp 生产机；不合并不部署。
- 干净库配方（记忆 `e2e-fresh-db-recipe`）：`docker exec -i food-shop-mysql mysql -uroot -pfoodshop_root_password -e "DROP DATABASE IF EXISTS food_shop_lowstock; CREATE DATABASE food_shop_lowstock CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON food_shop_lowstock.* TO 'foodshop_user'@'%'; FLUSH PRIVILEGES;"` → `cd apps/server && DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_lowstock" npx prisma migrate deploy && DATABASE_URL=… npx prisma db seed` → 起 API（`PORT=<空闲端口，别用 3000/3100/3106> WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true WECHAT_QRCODE_MOCK=true LOCAL_DELIVERY_PROVIDER_MOCK=true EXPRESS_PROVIDER_MOCK=true PRINTER_PROVIDER_MOCK=true SCHEDULER_DISABLED=true JWT_SECRET=<≥16 位> ADMIN_JWT_SECRET=<≥16 位> DATABASE_URL=… npx ts-node-dev --transpile-only src/app.ts`）→ `TZ=Asia/Shanghai BASE=http://localhost:<port> DB_NAME=food_shop_lowstock bash scripts/e2e.sh`。已知偶发：`e2e.d/42` B4-1 并发领券、`e2e.d/45` 打印机 4 条依赖顺序。
- 跑 e2e 时本机 `.env` 若配了 `ORDER_NOTIFY_WECOM_WEBHOOK`/`PUSHPLUS`，73 分片会真的往群里推几条测试内容——跑之前把这两个变量置空（`ORDER_NOTIFY_WECOM_WEBHOOK= ORDER_NOTIFY_PUSHPLUS_TOKEN=` 前缀），`lowStockScan` 计数不依赖通道是否配置。
- 后台人工检查：`.claude/launch.json` 的 `admin` 配置代理到 3100；本批 API 若用别的端口，临时用 `VITE_PROXY_TARGET=http://localhost:<port> npm run dev --workspace=apps/admin -- --port <空闲>`，不要改 launch.json（禁止清单）。
