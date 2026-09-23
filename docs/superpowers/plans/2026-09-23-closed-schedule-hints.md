# 同城主页：打烊／午休的预约提示 + 主页渠道标识（2026-09-23）

【工序】规划 【模型】Fable 5.1 【等级】M

- worktree：`/Users/yumingyi/food-shop/.claude/worktrees/closed-hints`（分支 `claude/closed-schedule-hints`）
- BASE：`e7d44e36db26a84def75e9cc00e8e772b31dbc3e`
- 店主已确认的预览：`docs/superpowers/previews/2026-09-23-closed-schedule-hints.html`（375 宽；文案以该页为准）
- 定级 M（§2.2 第 3 条：既有模块行为调整）。调查后确认**不命中第 2 条**：服务端只在公开 `GET /api/local/meta` 的 `pickup` 节**新增一个只读字符串字段**并给既有文案补一个空格；不涉认证、支付、迁移、删除、事务、破坏性接口变更、部署配置。`apps/server/prisma/**` 不动。

## 0. 调查结论（执行者不必重查；行号按 BASE）

| 条目 | 根因 / 现状 | 位置 |
|---|---|---|
| 1 自取「（可预约）」丢失 | `pickupModeHint` 判 `d.tone === 'closed' && p.tone === 'open'`；预约送达上线后外送打烊时 tone 是 `'schedule'`，条件不成立 | `apps/miniapp/utils/local-catalog.js:159-164` |
| 2 自取营业外提示无时段 | 文案写死「当前非营业时间，可预约后续时段」；meta 的 `pickup` 节没有最早可取时段 | `local-catalog.js:63`；`apps/server/src/services/local-settings.ts:1148-1161`（`publicLocalMeta().pickup`）；外送的做法 `apps/server/src/routes/local.ts:24-32`（路由层补 `delivery.earliestScheduleText`）、`services/delivery/schedule.ts:93-97` |
| 3 午休写成「已打烊 · 可预约」 | `deliveryScheduleOnly` 分支（:42）排在 BREAK 分支（:44）之前 | `local-catalog.js:40-46` |
| 4 自取胶囊营业中也是「可预约」 | PICKUP 分支恒返回 `{ tone:'open', label:'可预约' }` | `local-catalog.js:34-39` |
| 5 主页没有渠道标识 | 主页 `<local-store-header>` 未传 `channel`（组件 `wx:if="{{channel}}"` 才画标识）；切换弹层是分类页**页内**的 markup + CSS + 4 个 handler，不是组件 | `apps/miniapp/pages/index/index.wxml:22`；`pages/product/list.wxml:53`（传 channel）、`:157-169`（弹层 markup）；`list.js:645-660`；`list.wxss:287-295` |
| 7 结算条提示行 | `.cart-tip` 无单行/省略规则；购物车页有同名同样式副本 | `components/local-cart-bar/index.wxss:115`；`pages/cart/index.wxss:182` |
| 8a 「11:30送达」缺空格 | 在**服务端**拼：``最早${slotLabel(...)}送达`` | `services/delivery/schedule.ts:96`；自测断言了无空格串 `apps/server/scripts/selftest-schedule.ts:95-96` |
| 8b 「今日现拌」 | 主页区块标题 | `pages/index/index.wxml:98`（`index.js:6` 注释） |

其它事实：

- 自取的「营业时间外」应看 `meta.closedKind !== 'OPEN'`，**不看 `meta.isOpen`**：`isOpenNow` 含 `s.enabled && !isPaused`（`local-settings.ts:768-770`），外送关闭/暂停时 `isOpen=false` 与自取无关；`closedKind` 只看时段与休业（`:798-807`）。`headNoticeOf` 的 PICKUP 分支已是这么判的（`local-catalog.js:63`）。
- `headNoticeOf(meta,'PICKUP')` 还有一个消费方：自取结算页 `pages/local/pickup.js:141-149` 把 `notice.text` 显示为软提示（`pickup.wxml:3-4`）。改条目 2 的文案会同时改到那里（见「待用户决定」①）。
- 自绘导航栏与胶囊：`index.js:139-162 computeNavBar`：`navContent = (menu.top − statusBarHeight) × 2 + menu.height`（守卫 `menu.top >= statusBarHeight`），`navTotal = statusBarHeight + navContent`。于是 `navTotal − (menu.top + menu.height) = menu.top − statusBarHeight ≥ 0`：**胶囊下沿永远不低于导航栏下沿**；门店头排在 `<view style="height:{{navTotal}}px">` 占位块（`index.wxml:19`）之后的正常流里，任何机型都在胶囊之下。守卫不成立/拿不到胶囊时退回 `navContent=44`，而微信胶囊在所有机型上都落在状态栏下 44pt 之内（iOS top=状态栏+4、高 32）。这条要用单测钉住（验收 1-e）。
- 标题行挤压规则（`components/local-store-header/index.wxss:6-10`）：店名可收缩省略，胶囊与标识不收缩不换行。最长组合「午间休息 · 可预约」+「同城配送 ▾」在 375 宽下约 552rpx < 可用 702rpx；rpx 随屏宽等比缩放，机型间比例一致。预览已按真实 rpx÷2 画过并经店主确认。
- 主页顶栏那枚 `navbar-channel` 仍只在 EXPRESS 渲染（`navbar-index.test.cjs:32-40` 钉住）——本批的标识放在门店头里，不进 `<view class="navbar">` 段，该测试保持不改仍绿。
- `freeship-bar.test.cjs:195-199` 钉住主页 wxml 里 `<promo-bar` → `<promo-bar kind="freeship"` → `<local-mode-bar` 的先后顺序；新加的 `<channel-sheet>` 不得插进这段之间（放在文件末尾 `<local-cart-bar>` 之后）。
- 既有断言了被改行为的测试（本批**点名放开**，改成新断言，见验收 1-a）：`tests/miniapp/local-catalog.test.cjs:79`（PICKUP 营业中 label `'可预约'`）、`:81-82`（旧自取提示文案）、`:128-135`（`pickupModeHint` 五种情形——结论不变，但要补「外送 tone 为 schedule」与「外送暂停」两例）、`:139/:144`（fixture `'最早明天 09:30–10:00送达'` 无空格——仅 fixture，可改可不改，改则同步 :144 期望）；`apps/server/scripts/selftest-schedule.ts:95-96`（无空格串，必改）。
- e2e 对 `/local/meta` 的断言只有 `pickup.enabled / discountText / delivery.enabled / businessHours`（`scripts/e2e.d/62-pickup.sh:20-24`）与 `delivery.earliestScheduleText | length > 0`（`69-scheduled-delivery.sh:46-48`），没有键集合比较；加字段、补空格都不影响。`e2e.sh` 一律 source 全部分片（`scripts/e2e.sh:2008`），**不能单跑分片**。
- 预览台镜像：主页四个镜像 `tools/miniapp-preview/pages/index-local{,-pickup,-closed,-schedule}.html` 都写着「今日现拌」、都没有标识；closed/schedule 两个共用 `index-local.generated.css`（`serve.mjs:113-114`），组件 wxss 由 `PAGE_COMPONENTS`（`serve.mjs:39-40`）决定，目前**没登记 `channel-badge`**。分类页镜像（`pages/product-list-preview.js`）的 wxml 结构本批不变，不动。
- ES5 闸门 `scripts/check-miniapp-es5.mjs <file...>` 只对**新增文件**生效（文件头注释）。基线实测：`utils/local-catalog.js`、`components/local-mode-bar/index.js`、`local-store-header/index.js`、`channel-badge/index.js`、`local-cart-bar/index.js` 通过；`pages/index/index.js`、`pages/product/list.js` 本来就是 ES6（`const`，:11），不查它们、只保证新增行不用 ES6。
- 本机基线（BASE，本 worktree 实跑）：`npm run -s test:miniapp` → 367 pass / 0 fail；`npx tsc --noEmit -p apps/server` → exit 0；`selftest-schedule` 20、`selftest-pickup` 14、`selftest-local-settings` 35 全过。

## 验收标准

编号前缀对应店主清单条目。所有命令在 worktree 根目录跑；服务端命令加 `TZ=Asia/Shanghai`。

1. `npm run -s test:miniapp` → `fail 0`，`pass ≥ 367 + 本批新增用例数`，且下列行为各有用例（做错即红）：
   - a. `tests/miniapp/local-catalog.test.cjs`（改既有 + 新增）：
     - 【4】`storeStatusOf(PK,'PICKUP')`（`closedKind:'OPEN'`）→ `{ tone:'open', label:'营业中' }`（:79 由 `'可预约'` 改为 `'营业中'`）；`closedKind:'CLOSED'` → `{ tone:'schedule', label:'已打烊 · 可预约' }`；`closedKind:'BREAK'` → `{ tone:'schedule', label:'午间休息 · 可预约' }`；自取暂停 + CLOSED → 仍 `{ tone:'paused', label:'暂停接单' }`（暂停优先）；未开通、休业 → 与改前逐字节一致。
     - 【2】`headNoticeOf(PK + closedKind:'CLOSED' + pickup.earliestPickupText:'最早明天 10:30–11:00 可取','PICKUP')` → `{ text:'现在下单为预约自取，最早明天 10:30–11:00 可取', blocking:false }`；无 `earliestPickupText`（老服务端）→ `{ text:'现在下单为预约自取', blocking:false }`（:81-82 改为这两条）；营业中仍 `{ text:'', blocking:false }`；未开通/暂停/休业阻塞态与改前逐字节一致。
     - 【3】`storeStatusOf(closedSched + closedKind:'BREAK','DELIVERY')` → `{ tone:'schedule', label:'午间休息 · 可预约' }`；`closedSched`（CLOSED）仍 `'已打烊 · 可预约'`；`closedNoSched + BREAK` 仍 `{ tone:'closed', label:'午间休息' }`；`headNoticeOf(closedSched,'DELIVERY')` 不变。
     - 【1】`pickupModeHint`：既有 :128-135 六条结论不变；新增：`PK + isOpen:false + closedKind:'CLOSED' + delivery:{scheduleEnabled:true}`（外送 tone 为 `schedule`，即回归场景）→ `'（可预约）'`；`PK + closedKind:'BREAK' + paused:{reason:'x'}`（外送暂停）→ `'（可预约）'`；`closedKind:'CLOSED'` 但 `pickup.enabled:false` → `''`。`deliveryModeHint` 三条既有断言不变。
   - b. 【5】新文件 `tests/miniapp/closed-schedule-hints.test.cjs`（夹具照 `local-mode.test.cjs` 的 `loadPage/makeCtx`，app 桩加 `gateLocalChannel`，照 `channel-badge-page.test.cjs:41-46`）：
     - 主页 `onPickChannel({ detail:{ channel:'EXPRESS' } })`（同城态）→ `app.globalData.shoppingChannel === 'EXPRESS'`、发出 `/categories?channel=EXPRESS`、`page.data.channelSheetOpen === false`；
     - 主页同城态 `onPickChannel` 选 `'LOCAL'` → 不发请求、不过门、弹层关闭；
     - 主页 `openChannelSheet/closeChannelSheet` 切换 `channelSheetOpen`；
     - 组件 `components/channel-sheet/index.js`：`onPick`（`currentTarget.dataset.channel:'EXPRESS'`）触发 `pick` 且 `detail.channel === 'EXPRESS'`；`onClose` 触发 `close`；`noop` 存在可调用。
   - c. 【5】源码级断言（同一新文件）：`pages/index/index.wxml` 的 `<local-store-header` 标签含 `channel="{{channel}}"` 与 `bind:switchchannel="openChannelSheet"`；`index.wxml` 含 `<channel-sheet`，且其位置在 `<local-cart-bar` 之后；`pages/product/list.wxml` 含 `<channel-sheet`、不再含 `class="channel-mask"`；`pages/index/index.json` 与 `pages/product/list.json` 的 `usingComponents` 含 `channel-sheet`。
   - d. 【8b】源码级：`index.wxml` 含 `'今日推荐'`、不含 `'今日现拌'`。
   - e. 【5·机型】`computeNavBar` 矩阵：对 `{statusBarHeight, top, height}` = (44,48,32)、(20,24,32)、(24,30,32)、(20,26,32) 及守卫不成立的 (44,40,32)，`page.data.navTotal >= top + height`；并断言 `getMenuButtonBoundingClientRect` 返回 `null` 时 `navTotal === statusBarHeight + 44`。
   - f. 【7】源码级（可放 `cart-bar-page.test.cjs` 或新文件）：`components/local-cart-bar/index.wxss` 与 `pages/cart/index.wxss` 的 `.cart-tip {` 规则块内含 `white-space: nowrap`、`overflow: hidden`、`text-overflow: ellipsis`。
   - g. 既有 `tests/miniapp/channel-badge-page.test.cjs`、`navbar-index.test.cjs`、`freeship-bar.test.cjs`、`local-mode.test.cjs`、`confirm-page.test.cjs`、`pickup-page.test.cjs` **不改一字**仍绿（`git diff --stat BASE -- <这六个文件>` 为空）。
2. 【ES5】`node scripts/check-miniapp-es5.mjs apps/miniapp/components/channel-sheet/index.js apps/miniapp/utils/local-catalog.js apps/miniapp/components/local-mode-bar/index.js apps/miniapp/components/local-store-header/index.js apps/miniapp/components/local-cart-bar/index.js` → `全部通过（5 个文件）`。`pages/index/index.js`、`pages/product/list.js` 新增行只用 `var`/`function`（复核人工看 diff）。
3. 【服务端类型】`npx tsc --noEmit -p apps/server` → exit 0、无输出。
4. 【2/8a 服务端自测】在 `apps/server` 下，`TZ=Asia/Shanghai JWT_SECRET=0123456789abcdef0123 ADMIN_JWT_SECRET=0123456789abcdef0123 npx ts-node --transpile-only scripts/selftest-pickup.ts` → `全部通过 ≥ 19`（14 + 新增 ≥ 5），新增覆盖 `earliestPickupText`（base 设置：10:00–14:00 / 17:00–20:00，slot 30，备餐 20，缓冲 5，daysAhead 1）：
   - `sh('2026-09-11T15:10:00')` → `'最早今天 17:00–17:30 可取'`；`sh('2026-09-11T22:39:00')` → `'最早明天 10:00–10:30 可取'`；`sh('2026-09-11T09:00:00')` → `'最早今天 10:00–10:30 可取'`；
   - `pickup.enabled:false` → `''`；自取暂停（`until:null`）→ `''`；休业覆盖两天（照 `selftest-pickup.ts:73` 的 `holiday: { until: '2026-09-20' }` 夹具）→ `''`。
   同命令跑 `scripts/selftest-schedule.ts` → `全部通过 20`，其中 :95-96 的期望改为 `'最早今天 11:00–11:30 送达'`（有空格）；`scripts/selftest-local-settings.ts` → `全部通过 35`（不改）。
5. 【2 接口契约】本地起 API（mock 全开 + `SCHEDULER_DISABLED=true`，见 §环境）后。**前置**：seed 默认 `pickup.enabled=false`、`schedule.enabled=false`（`local-settings.ts:311/316`），先用管理员 token 开通——`AT=$(curl -s -X POST localhost:<port>/api/admin/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123456"}' | jq -r .data.token)`，再照 `scripts/e2e.d/62-pickup.sh:6` 的 `p62_put` 写法 GET 当前设置、`jq '.pickup.enabled=true | .schedule.enabled=true | .holiday=null | .paused=null | .pickup.paused=null'` 后 PUT `/api/admin/settings/local-delivery`（在 e2e **之前**做，或在 e2e 之后重做——e2e 收尾会把设置恢复成关闭）。然后：`curl -s localhost:<port>/api/local/meta | jq '.data.pickup | keys'` 含 `"earliestPickupText"`，且 `.data.pickup.earliestPickupText` 与 `.data.delivery.earliestScheduleText` 均非空，前者以 `' 可取'` 结尾、后者以 `' 送达'` 结尾（`jq -r '.data.pickup.earliestPickupText | endswith(" 可取")'` → `true`）；`pickup` 节其余 8 个键（`enabled, paused, available, minOrderAmountFen, discount, discountText, slotMinutes, daysAhead`）与改前一致；把 `.pickup.enabled=false` 后 `earliestPickupText === ""`。
6. 【e2e】干净库全量 `DB_NAME=<本批库> BASE=http://localhost:<port> bash scripts/e2e.sh`（≈10 分钟，后台跑）→ 末行 `失败 0`；出现红时对照已知偶发清单（§环境）判定，偶发以外的红即失败。分片 62（`meta.pickup.*`）、69（`earliestScheduleText` 非空、票面 `送达 ` 匹配）、52（`closedKind`）必须全绿。
7. 【预览台】`npm run preview:miniapp`（5180）后人工检查并截图存 `docs/superpowers/notes/2026-09-23-closed-hints-acceptance/`：四个主页镜像的门店头第一行右端有「同城配送 ▾」，与店名/胶囊同一行不换行；`index-local-closed`：胶囊蓝色「午间休息 · 可预约」、切换栏两格都带「（可预约）」、软提示「现在下单为预约自取，最早今天 17:00–17:30 可取」；`index-local-schedule`：两格都带「（可预约）」、提示「…最早明天 11:00–11:30 送达」（有空格）；`index-local-pickup`：绿色「营业中」；四个镜像区块标题「今日推荐」。判定标准：与店主确认的预览页逐格一致。
8. 【范围】`git diff --stat BASE -- apps/server/prisma apps/admin apps/server/src/services/local-settings.ts apps/server/src/services/slots.ts apps/miniapp/utils/channel.js apps/miniapp/app.js apps/miniapp/components/local-store-header/index.wxml apps/miniapp/components/local-store-header/index.wxss apps/miniapp/components/channel-badge scripts/e2e.sh scripts/e2e.d` → 空。
9. 【真机】店主用微信开发者工具真机预览走三态（营业中 / 午休 / 打烊，外送与自取各切一次），并在至少两种胶囊位置不同的机型（如 iPhone 刘海机 + 非刘海机或 iPad）上看门店头第一行不被胶囊压住。这一步由编排者安排，不在执行者验证里；执行者只交付 7 的截图。

## 实现方向

1. 【8a】`apps/server/src/services/delivery/schedule.ts:96` 改为 ``最早${slotLabel(...)} 送达``；同步 `scripts/selftest-schedule.ts:95-96` 的用例名与期望。（预计涉及：这两个文件）
2. 【2 服务端】`apps/server/src/services/pickup.ts` 新增导出 `earliestPickupText(s, now = new Date()): string`：`const v = buildPickupSlots(s, now); if (v.blocked || !v.earliestAt) return ''; return \`最早${slotLabel(new Date(v.earliestAt), v.slotMinutes, now)} 可取\``（与 `earliestScheduleText` 同构；`slotLabel` 已从 `./slots` 引入）。`routes/local.ts:29` 改为同时补 `pickup: { ...meta.pickup, earliestPickupText: earliestPickupText(s) }`（照 `delivery` 的写法，`publicLocalMeta` 不动——它不 import pickup.ts 的理由同 `local-settings.ts:1145` 注释）。`selftest-pickup.ts` 加验收 4 的六个用例。`docs/api.md:1847` 的 `pickup` 节字段清单补 `earliestPickupText`，并在 :2185 那张表后按同格式加一行「`GET /api/local/meta` | `pickup` 节加 `earliestPickupText`（『最早今天 17:00–17:30 可取』；不可约为空串）」。（预计涉及：`services/pickup.ts`、`routes/local.ts`、`scripts/selftest-pickup.ts`、`docs/api.md`）
3. 【1/2/3/4 小程序纯函数】`apps/miniapp/utils/local-catalog.js`：
   - 抽一个内部小函数 `outOfHours(meta)` = `!!(meta.closedKind && meta.closedKind !== 'OPEN')`，与 `closedLabel(meta)` = `meta.closedKind === 'BREAK' ? '午间休息' : '已打烊'`，三处共用；
   - `storeStatusOf` PICKUP 分支（:38）：`outOfHours` → `{ tone:'schedule', label: closedLabel + ' · 可预约' }`，否则 `{ tone:'open', label:'营业中' }`；未开通/暂停/休业分支顺序不动；
   - `storeStatusOf` DELIVERY 分支（:42）：`deliveryScheduleOnly` → `{ tone:'schedule', label: closedLabel + ' · 可预约' }`（BREAK 时自然得「午间休息 · 可预约」；`deliveryScheduleOnly` 定义 :167-171 不动）；
   - `headNoticeOf` PICKUP 分支（:63）：`outOfHours` → `'现在下单为预约自取' + (pk.earliestPickupText ? '，' + pk.earliestPickupText : '')`，`blocking:false`；
   - `pickupModeHint`（:159-164）：`!meta || meta.holiday` → `''`；`!modeAvailable(meta,'PICKUP')` → `''`；否则 `outOfHours(meta) ? '（可预约）' : ''`。不再依赖外送的 tone。`deliveryModeHint` 不动。
   - 更新文件头与 :157-158、:172 的注释；`components/local-mode-bar/index.js:3`、`index.wxss:1-2`、`local-store-header/index.js:21` 的过时注释一并改（只改注释）。
   （预计涉及：`utils/local-catalog.js`、`tests/miniapp/local-catalog.test.cjs`、三处注释）
4. 【5 弹层抽组件】新建 `apps/miniapp/components/channel-sheet/{index.js,index.wxml,index.wxss,index.json}`（ES5）：properties `open:Boolean`、`channel:String`；wxml 即 `list.wxml:157-169` 那段，根节点 `wx:if="{{open}}"`，遮罩 `bindtap="onClose" catchtouchmove="noop"`，选项 `bindtap="onPick" data-channel`；`onPick` → `triggerEvent('pick', { channel })`，`onClose` → `triggerEvent('close')`；wxss 即 `list.wxss:287-295` 八条规则原样搬入（含 z-index 100 注释）。分类页：`list.json` 登记；`list.wxml:157-169` 换成 `<channel-sheet open="{{channelSheetOpen}}" channel="{{channel}}" bind:pick="onPickChannel" bind:close="closeChannelSheet" />`；`list.wxss` 删掉搬走的八条；`list.js:652` 的 `onPickChannel` 读取改为 `var target = (e.detail && e.detail.channel) || (e.currentTarget && e.currentTarget.dataset.channel)`（与批次二 `pickup.js` 读 idx 的先例同一写法，`channel-badge-page.test.cjs:85` 传 `currentTarget` 的用例照旧绿）；`openChannelSheet/closeChannelSheet/noop` 三个方法保留不动。（预计涉及：新组件四文件、`pages/product/list.{json,wxml,wxss,js}`）
5. 【5 主页接线】`pages/index/index.json` 登记 `channel-sheet`；`index.wxml:22` 加 `channel="{{channel}}" bind:switchchannel="openChannelSheet"`；文件末尾 `<local-cart-bar …/>` 之后加 `<channel-sheet open="{{channelSheetOpen}}" channel="{{channel}}" bind:pick="onPickChannel" bind:close="closeChannelSheet" />`（不得插进 promo-bar/local-mode-bar 之间）；`index.js` data 加 `channelSheetOpen:false`，方法 `openChannelSheet/closeChannelSheet/noop/onPickChannel`——`onPickChannel`：关弹层；目标 === 当前渠道 → return；`'EXPRESS'` → `this.onGoExpress()`（:351-354 已有：定渠道 + `loadData`）；`'LOCAL'` → `app.gateLocalChannel().then(function(ok){ if (ok) self.loadData() })`。`index.wxml:13-15` 与 `index.js:152-155` 关于顶栏标识的注释仍成立，不改。（预计涉及：`pages/index/index.{json,wxml,js}`、新测试文件）
6. 【7】`components/local-cart-bar/index.wxss:115` 与 `pages/cart/index.wxss:182` 的 `.cart-tip` 各加 `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`（文案不改；`local-cart-bar` 的 `measureDock` 量的是整个 dock 高度，单行后高度稳定，无需改 js）。（预计涉及：两个 wxss）
7. 【8b】`index.wxml:98` `'今日现拌'` → `'今日推荐'`；`index.js:6` 注释同步。（预计涉及：这两处）
8. 【镜像】`tools/miniapp-preview/serve.mjs:39-40` 两个 `index-local*` 条目加 `'channel-badge'`；四个 `pages/index-local*.html`：标题行 `store-title-row` 末尾加 `<span class="channel-badge"><span class="channel-badge-text">同城配送</span><span class="channel-badge-caret">▾</span></span>`（保持真实 class 名）；`index-local-closed.html:24` 胶囊改 `status-pill-schedule`「午间休息 · 可预约」、:28-29 两格都带 `（可预约）`、门店头加软提示 `<div class="head-notice head-notice-soft"><span class="head-notice-text">现在下单为预约自取，最早今天 17:00–17:30 可取</span></div>`；`index-local-pickup.html:24`「自取开放」→「营业中」；`index-local-schedule.html` 自取格补 `（可预约）`、提示补空格；四处「今日现拌」→「今日推荐」。（预计涉及：`serve.mjs`、四个 html）
9. 【验证与交付】按验收 1–8 逐条跑并附原始输出；e2e 用 §环境 的干净库配方；截图存 notes 目录。

## 授权范围

```
apps/server/src/routes/local.ts
apps/server/src/services/pickup.ts
apps/server/src/services/delivery/schedule.ts
apps/server/scripts/selftest-pickup.ts
apps/server/scripts/selftest-schedule.ts
apps/miniapp/utils/local-catalog.js
apps/miniapp/components/channel-sheet/**
apps/miniapp/components/local-mode-bar/index.js
apps/miniapp/components/local-mode-bar/index.wxss
apps/miniapp/components/local-store-header/index.js
apps/miniapp/components/local-cart-bar/index.wxss
apps/miniapp/pages/index/index.js
apps/miniapp/pages/index/index.wxml
apps/miniapp/pages/index/index.json
apps/miniapp/pages/product/list.js
apps/miniapp/pages/product/list.wxml
apps/miniapp/pages/product/list.wxss
apps/miniapp/pages/product/list.json
apps/miniapp/pages/cart/index.wxss
tests/miniapp/local-catalog.test.cjs
tests/miniapp/cart-bar-page.test.cjs
tests/miniapp/closed-schedule-hints.test.cjs
tools/miniapp-preview/serve.mjs
tools/miniapp-preview/pages/index-local*.html
docs/api.md
docs/superpowers/notes/2026-09-23-closed-hints-*
docs/superpowers/notes/2026-09-23-closed-hints-acceptance/**
```

限定：`local-mode-bar/index.js`、`index.wxss`、`local-store-header/index.js` 只允许改注释；`pages/product/list.js` 只允许改 `onPickChannel` 里读取目标渠道的那一个表达式；`list.wxml` 只允许把弹层那段换成组件标签；`list.wxss` 只允许删除搬入组件的八条规则；`pages/cart/index.wxss` 只允许在 `.cart-tip` 规则里加三条声明。

## 禁止修改

```
apps/server/prisma/**
apps/server/src/services/local-settings.ts
apps/server/src/services/slots.ts
apps/server/src/services/wechat-pay*.ts
apps/server/src/services/refund*.ts
apps/server/src/services/order-*.ts
apps/server/src/routes/orders.ts
apps/server/src/routes/admin/**
apps/server/src/middlewares/**
apps/server/scripts/selftest-local-settings.ts
apps/admin/**
apps/miniapp/app.js
apps/miniapp/app.json
apps/miniapp/utils/channel.js
apps/miniapp/utils/promo.js
apps/miniapp/utils/request.js
apps/miniapp/config/**
apps/miniapp/components/channel-badge/**
apps/miniapp/components/local-store-header/index.wxml
apps/miniapp/components/local-store-header/index.wxss
apps/miniapp/components/local-store-header/index.json
apps/miniapp/components/local-cart-bar/index.js
apps/miniapp/components/local-cart-bar/index.wxml
apps/miniapp/pages/index/index.wxss
apps/miniapp/pages/local/**
apps/miniapp/pages/order/**
apps/miniapp/pages/cart/index.js
apps/miniapp/pages/cart/index.wxml
tests/miniapp/channel-badge-page.test.cjs
tests/miniapp/navbar-index.test.cjs
tests/miniapp/freeship-bar.test.cjs
tests/miniapp/local-mode.test.cjs
tests/miniapp/confirm-page.test.cjs
tests/miniapp/pickup-page.test.cjs
scripts/e2e.sh
scripts/e2e.d/**
scripts/check-miniapp-es5.mjs
docs/superpowers/previews/**
.agent/**
```

## 上报条件

- 需要改授权范围外的文件，或对「限定」列出的文件做限定之外的改动（尤其 `local-settings.ts`、`slots.ts`、`channel.js`、`app.js`、`local-store-header` 的 wxml/wxss、`channel-badge`）。
- 禁止清单里的六个测试文件任一用例由绿转红，且原因不是本方案点名放开的那几条（本方案只放开 `local-catalog.test.cjs` 与 `selftest-schedule.ts` 的指定断言）。
- 弹层抽组件后 `channel-badge-page.test.cjs` 变红，且不是 `onPickChannel` 读 `e.detail.channel` 那一处能解决的。
- `tsc` 报 Prisma 字段不存在（共享 client 过期）：不要 `prisma generate`，原样上报。
- 预览台 375 宽下门店头第一行出现换行、标识被压缩或与胶囊/店名重叠；或 `computeNavBar` 矩阵任一组不满足 `navTotal ≥ top + height`。
- `/local/meta` 实测 `pickup.earliestPickupText` 在自取开通、非休业、非暂停时为空串（说明 `buildPickupSlots` 在当前设置下算不出格子，属设置/算法问题，不得用兜底文案糊过去）。
- e2e 出现已知偶发清单之外的红，重跑一次仍红。
- 发现 `headNoticeOf(meta,'PICKUP')` 除 `pages/local/pickup.js` 之外还有别的消费方会因文案变化改变行为。

## 待用户决定

- ① **自取结算页的软提示会跟着变**：`pages/local/pickup.js:141-149` 与主页共用 `headNoticeOf(meta,'PICKUP')`，条目 2 改文案后，自取结算页营业时间外的灰色提示也从「当前非营业时间，可预约后续时段」变成「现在下单为预约自取，最早 X 可取」。规划者按「同一口径」实现（不加分支）；若店主希望结算页保留旧句子，需在 `local-catalog.js` 多给一个参数或在 `pickup.js` 单独拼文案（`pickup.js` 现在禁改，要扩授权）。影响：只是文案；结算页本身有时段选择器，顾客不会被误导。
- ② **自取胶囊不再受外送暂停/关闭影响**：条目 4 让自取胶囊只看营业时段（`closedKind`）。店主按下「暂停外送」或关闭同城外送开关、而自取开着且在营业时段时，自取侧胶囊显示绿色「营业中」（改前是绿色「可预约」，同样不受影响，只是字变了）。规划者认为这是正确语义（自取有自己的暂停开关），不改；如店主希望外送暂停时自取也带提示，是新需求。
- ③ **算不出最早可取时段时的兜底句**：`buildPickupSlots` 在 `daysAhead` 内一格都没有（例如 `daysAhead=0` 且今天最后一格已过）时 `earliestPickupText` 为空串，主页提示只显示「现在下单为预约自取」（与外送 `earliestScheduleText` 为空时的处理一致）。这是技术兜底，不另加文案；若店主要一句更明确的（如「今日已无可取时段」），需另定文案。

## 环境与坑（给执行者）

- 所有命令在 `/Users/yumingyi/food-shop/.claude/worktrees/closed-hints` 跑，不 cd 到主仓。不 `npm install`（依赖向上解析到主仓 `node_modules`）；不 `prisma generate`；不裸 `git stash`；不 ssh/scp；不合并、不部署。
- 本机是 JST：服务端自测、起 API、e2e 一律加 `TZ=Asia/Shanghai`。本机 `grep` 是 ugrep 别名，正则用 `command grep`；没有 `timeout` 命令；zsh 里 `echo =====` 会当成命令，分隔线用引号。
- 自测需要 `JWT_SECRET`/`ADMIN_JWT_SECRET` ≥ 16 位（示例见验收 4）。
- 起本地 API（验收 5、6）：主仓 3100 常被占用，本批用 3125。干净库配方（照 `docs/superpowers/plans/2026-09-21-refund-reconcile-and-tz.md:395-420`，库名换成 `food_shop_ch`）：
  ```bash
  docker exec -i food-shop-mysql mysql -uroot -pfoodshop_root_password -e "
  DROP DATABASE IF EXISTS food_shop_ch; CREATE DATABASE food_shop_ch CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  GRANT ALL ON food_shop_ch.* TO 'foodshop_user'@'%'; FLUSH PRIVILEGES;"
  export DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_ch"
  export JWT_SECRET=e2e_jwt_secret_0123456789 ADMIN_JWT_SECRET=e2e_admin_secret_0123456789
  (cd apps/server && npx prisma migrate deploy && npx prisma db seed)     # 本批零迁移，不 generate
  cd apps/server && TZ=Asia/Shanghai PORT=3125 WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true WECHAT_QRCODE_MOCK=true \
    LOCAL_DELIVERY_PROVIDER_MOCK=true EXPRESS_PROVIDER_MOCK=true PRINTER_PROVIDER_MOCK=true SCHEDULER_DISABLED=true \
    npx ts-node-dev --respawn --transpile-only src/app.ts      # 后台起，curl :3125/health 确认
  DB_NAME=food_shop_ch BASE=http://localhost:3125 bash scripts/e2e.sh > /tmp/e2e-ch.log 2>&1   # 后台 + 轮询
  ```
  `SCHEDULER_DISABLED=true` 必带（否则 60s 心跳打乱 §59/§60 精确计数）。跑 e2e 的 shell 里也要 `export DATABASE_URL`。
- 已知偶发（基线红，不算本批新增）：`e2e.d/42` B4-1 同用户 5 并发领券偶发 0 成功；`e2e.d/45` 打印机 4 条依赖执行顺序；§38 E 在本机偏移为 0 时跳过；服务端日志里的 3 条 write conflict 不影响断言。
- 验收 5 的 curl 结果与当前时刻有关：seed 的营业时间下，只要自取开通且 `daysAhead ≥ 1`，任何时刻都应有格子；为空即上报。
- 预览台：`npm run preview:miniapp`，画廊里四个主页镜像的入口在 `tools/miniapp-preview/index.html:122-125`；wxss 改动自动重生成，html 镜像要手改。
- 小程序改动要让店主真机看，最终须合到 main（微信开发者工具读主仓磁盘）——这是编排者的事，执行者不合并。
- 提交信息末尾加 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## 执行后交接

执行者按协议 §4 交付：改动文件、验证（验收 1–8 每条的命令与原始输出，e2e 附 `tail -3` 与 `grep '✘'`）、偏离方案、上报。复核（M 级 Opus 5.5）重点：验收 1-a/1-e 的断言是否真能区分做对做错、`onPickChannel` 兼容表达式、镜像与真实 wxml 的 class 一致、`.cart-tip` 三条声明两处都有、`docs/api.md` 与实际出参一致。

## 店主答复（2026-09-23，编排者转达）

「待用户决定」三条均按规划默认：① 自取结算页提示与主页一起变；② 自取胶囊只看营业时段，不受外送暂停/关闭影响；③ 算不出最早可取时段时只显示「现在下单为预约自取」。无需改方案。
