# 全国邮寄接快递100 · 批次四：收尾（衔接审核整改）—— 实施计划

> **工序 00 规划 · 模型 fable。** 本计划按「模型分工协议」写：改动等级 **L**（跨模块 + 改订单状态这类不可逆联动），链路 `fable → sonnet → opus → fable → haiku`。
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**原始需求**：`docs/superpowers/notes/2026-09-09-express-batches-integration-audit.md` 第五节「建议的下一步」——修 Critical（回调直推 13 时订单卡 PREPARING）、下线旧接口 `PUT /admin/settings/shipping` 写侧、批处理 Minor，不动同城、不加迁移。

**Goal:** 让「签收自动完成」在快递100 漏推 10 直推 13 时也成立；堵住把全店计费静默切回一口价的旧接口；把审核里的小问题一次清掉。

**Architecture:** 把「签收到达而预约未到 PICKED → 先按 10 走一遍」下沉到 `applyProviderStatus`（三条签收路径共用一处）；对账任务加一支「预约已签收但订单仍备货」的检测 + 一次性告警；旧接口写侧只在非生产挂载。其余为文案/文档/阈值。

**Tech Stack:** 同前三批。无迁移。

## 未决歧义（列出来问；执行方按「默认」做，店主不同意再改）

| # | 歧义 | 默认 |
|---|---|---|
| Q1 | 「预约已签收但订单仍备货」的兜底是自动修复订单（补 SHIPPED→COMPLETED）还是只告警？ | **只检测 + 一次性告警**（生产尚无此类行；T1 修好后不再产生；自动改订单状态风险大于收益） |
| Q2 | 未取件提醒与对账「无进展」提醒同一 tick 双发，删前者还是抑制后者？ | **保留两条任务，对账方对「已发过未取件提醒」的预约不再发无进展提醒**（信息量少的那条先到，不重复轰炸） |
| Q3 | 快照保鲜基准改成报价时刻还是缩短窗口？ | **缩短 `BOOKING_QUOTE_STALE_MS` 到 90 分钟**（不改快照结构） |
| Q4 | 回调限流 120/min 是否上调？ | **上调到 300/min**（状态 + 轨迹共用一桶，503 只是延迟不丢数据） |
| Q5 | 审核建议去掉 PAID 状态的「商家备货中」卡；但 spec §4.2 明确写 PAID/PREPARING 都显示 | **不改**（spec 说了算） |
| Q6 | `42225` 复用给「回调地址超长」，要不要换新码？ | **不换**（客户端契约不动，只补文档） |

## Global Constraints

- **同城 LOCAL 零行为变化；老邮寄单零行为变化；不加迁移；不改 4226x 错误码的值**。
- 签收语义：预约到 DELIVERED 时订单必须已经过 SHIPPED（`Shipment.shippedAt` 有值、发货订阅消息发过一次）再到 COMPLETED（`completedAt` 有值）。
- 生产环境不得暴露 `PUT /api/admin/settings/shipping` 写侧；`GET` 兼容视图保留；e2e（非生产）仍可调用 PUT。
- 每单每类提醒只发一次（DB 标记列，不靠内存去重）。
- e2e 干净库 `SCHEDULER_DISABLED=true` 全量：断言只增不减（基线 **1480/0**）。
- 每次交接声明「当前工序 · 模型」。

## 允许修改的文件白名单

```
apps/server/src/services/delivery/express-callback.ts
apps/server/src/services/delivery/express-booking-tasks.ts
apps/server/src/services/delivery/express-booking.ts          # 仅 BOOKING_QUOTE_STALE_MS、getBookingQuotes 复用条件、42225 文案
apps/server/src/routes/admin/settings.ts                       # 仅 PUT /shipping 挂载条件
apps/server/src/middlewares/rate-limit.ts                      # 仅 kdExpressCallbackLimiter 的 limit
apps/server/src/config.ts                                      # 仅 worstKdExpressUrl 常量
apps/admin/src/api/admin.ts                                    # 仅删 getShippingSettings/updateShippingSettings
apps/admin/src/types.ts                                        # 仅当 ShippingSettings 变成无引用时删
apps/miniapp/pages/order/detail.wxml                           # 仅删预约卡里的商家备注行
scripts/e2e.d/59-express-callback.sh
scripts/e2e.d/61-express-track.sh
apps/server/scripts/selftest-express-booking.ts
docs/api.md
docs/superpowers/notes/2026-09-09-express-batches-integration-audit.md   # 仅在末尾追加「整改状态」
```
白名单外的文件一律不得改；需要改时停止并回报。

## 上报触发条件（执行方必须停下）

1. 需要改白名单外的任何文件（含 `schema.prisma`、`orders.ts`、`express-track.ts`、同城任何文件、小程序 js）。
2. tsc / selftest / e2e 出现与本次改动无关的失败，且在干净库重跑一次后仍红。
3. 发现 `applyProviderStatus` 的递归补记会对 `UNKNOWN`/`PENDING` 起点产生双发发货消息或双写 Shipment（按验收 A3 判定）。
4. e2e §59 新用例要求的断言与现有 §59/§60/§61 任一断言冲突（例如 `X59_KEEP_O4` 的状态被改变）。
5. 任何一步需要 `prisma generate`/迁移/改 `.env`。

## 验收标准（只在这里定义，后续工序不得增删）

| # | 命令 | 期望 |
|---|---|---|
| A1 | `cd apps/server && npx tsc --noEmit` | 无输出、退出码 0 |
| A2 | `cd apps/server && npx ts-node --transpile-only scripts/selftest-express-booking.ts \| tail -1` | `通过 22 条`（原 21 + 本批 1） |
| A3 | e2e §59 新增 ⑩「BOOKED 直推 13」 | 预约 DELIVERED、`pickedAt` 非空、订单 COMPLETED、`shipments.shipped_at` SET、`express_booking_events` 里该预约 `provider_status=10` 的 SYSTEM/CALLBACK 留痕 **恰好 1 条**、`provider_status=13` 1 条 |
| A4 | e2e §61 新增「预约 DELIVERED 但订单被人工改回 PREPARING → 对账 tick」 | `expressStale` 不推进（0）、`stale_reminded_at` SET；第二次 tick 不再打标（值不变） |
| A5 | e2e §60/§61 既有「未取件提醒」「对账无进展」用例 + 新增 ⑦c | 既有全部保持绿；⑦c：先跑 `expressUnpicked`（提醒 1 条）再跑 `expressStale` 后 `stale_reminded_at` 与 `unpicked_reminded_at` 都 SET；**通知只发一条**由 02 复核读 `reconcileStaleBooking` 确认 `unpickedRemindedAt` 非空时不调用 `notifyExpressAlert` |
| A6 | `curl -s -o /dev/null -w '%{http_code}' -X PUT http://localhost:3100/api/admin/settings/shipping`（dev） | 401（路由存在、要鉴权）；`NODE_ENV=production` 下 `grep -n "isProduction" apps/server/src/routes/admin/settings.ts` 能看到 PUT 被条件挂载 |
| A7 | `cd apps/admin && npx tsc --noEmit && npm test && npm run build` | 干净、12/12、build 成功；`grep -rn "settings/shipping" apps/admin/src` 为空 |
| A8 | `npm run test:miniapp` | 79/79 |
| A9 | 干净库全量 `DB_NAME=food_shop_e2e bash scripts/e2e.sh` | `失败 0`，通过数 ≥ 1480 + 本批新增断言数 |
| A10 | `grep -n "42210\|42225" docs/api.md` | 邮寄错误码表含 `42210`（起送不足，邮寄复用）与 `42225`（回调地址超长）两行 |
| A11 | `git diff main --stat -- apps/server/src/services/delivery/orchestrator.ts apps/server/src/services/delivery/callback.ts apps/server/src/services/delivery/state.ts apps/server/src/routes/admin/delivery.ts apps/server/prisma` | 空 |

---

### Task 1: 签收直达补取件（Critical）+ 对账兜底 + e2e

**工序 01 执行 · sonnet。**

**Files:**
- Modify: `apps/server/src/services/delivery/express-callback.ts:102`（`if (mapped.type === 'rank')` 之前）
- Modify: `apps/server/src/services/delivery/express-booking-tasks.ts`（`reconcileExpressStale` 的 where 加 C 支；`reconcileStaleBooking` 处理 DELIVERED 起点）
- Modify: `apps/server/src/services/delivery/express-booking.ts`（无；仅当 tsc 需要导出类型时）
- Test: `scripts/e2e.d/59-express-callback.sh`（⑩）、`scripts/e2e.d/61-express-track.sh`（⑦ 末尾追加）

**Interfaces:**
- Consumes: `applyProviderStatus(tx, booking, p, after, costAlertRatio)`、`BOOKING_RANK`、`recordBookingEvent`、`notifyExpressAlert`。
- Produces: 无新导出。`reconcileStaleBooking` 返回值集合不变。

- [ ] **Step 1: 写失败的 e2e**

`scripts/e2e.d/59-express-callback.sh` 在「⑨ 未知状态码」段之后、`X59_KEEP_O4=` 之前插入：

```bash
echo "-- ⑩ 漏推 10 直推 13：先补取件（订单 SHIPPED + Shipment + 发货通知）再签收 → COMPLETED --"
X59_O5=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X59_O5/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
X59_BN7=$(x59_bk "$X59_O5" | jq -r .data.booking.bookingNo)
assert_eq "起点 BOOKED" "$(x59_bk "$X59_O5" | jq -r .data.booking.status)" "BOOKED"
HTTPC=$(x59_cb "$X59_BN7" 13 '{"kuaidinum":"JD-DIRECT-13"}'); assert_eq "直推 13 HTTP 200" "$HTTPC" "200"
R=$(x59_bk "$X59_O5")
assert_eq "预约 DELIVERED" "$(jq -r .data.booking.status <<<"$R")" "DELIVERED"
assert_eq "pickedAt 已补" "$(jq -r '.data.booking.pickedAt != null' <<<"$R")" "true"
assert_eq "不再活跃" "$(jq -r .data.active <<<"$R")" "false"
assert_eq "订单 COMPLETED（经过 SHIPPED）" "$(order_status $X59_O5)" "COMPLETED"
assert_eq "Shipment 单号+发货时间" "$(sql "SELECT CONCAT(express_no,'|',IF(shipped_at IS NULL,'NULL','SET')) FROM shipments WHERE order_id=$X59_O5;")" "JD-DIRECT-13|SET"
assert_eq "completedAt 有值" "$(sql "SELECT IF(completed_at IS NULL,'NULL','SET') FROM orders WHERE id=$X59_O5;")" "SET"
assert_eq "补记取件只留痕一次（provider_status=10）" "$(sql "SELECT COUNT(*) FROM express_booking_events e JOIN express_bookings b ON b.id=e.booking_id WHERE b.booking_no='$X59_BN7' AND e.provider_status=10;")" "1"
assert_eq "签收留痕一次（provider_status=13）" "$(sql "SELECT COUNT(*) FROM express_booking_events e JOIN express_bookings b ON b.id=e.booking_id WHERE b.booking_no='$X59_BN7' AND e.provider_status=13;")" "1"
```

`scripts/e2e.d/61-express-track.sh` 在 ⑦ 的 `req POST /api/admin/system/express-mock/reset` 之前插入：

```bash
echo "-- ⑦b 兜底：预约已签收但订单仍备货 → 对账只告警一次、不改状态 --"
X61_O7=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O7/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
X61_BN7=$(x59_bk "$X61_O7" | jq -r .data.booking.bookingNo)
x59_cb "$X61_BN7" 10 '{"kuaidinum":"JD-REPAIR"}' >/dev/null; x59_cb "$X61_BN7" 13 '{}' >/dev/null
assert_eq "前置：预约 DELIVERED" "$(x59_bk "$X61_O7" | jq -r .data.booking.status)" "DELIVERED"
sql "UPDATE orders SET status='PREPARING', completed_at=NULL WHERE id=$X61_O7;"
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "兜底不推进（只告警）" "$(jq -r '.data.expressStale // -1' <<<"$R")" "0"
assert_eq "兜底：订单仍 PREPARING（不自动改）" "$(order_status $X61_O7)" "PREPARING"
assert_eq "兜底：已打一次性告警标记" "$(sql "SELECT IF(stale_reminded_at IS NULL,'NULL','SET') FROM express_bookings WHERE booking_no='$X61_BN7';")" "SET"
X61_REM7=$(sql "SELECT stale_reminded_at FROM express_bookings WHERE booking_no='$X61_BN7';")
R=$(sched '{"expressStaleIntervalMin":0}')
assert_eq "兜底：第二次 tick 不再告警（标记不变）" "$(sql "SELECT stale_reminded_at FROM express_bookings WHERE booking_no='$X61_BN7';")" "$X61_REM7"
sql "UPDATE orders SET status='COMPLETED', completed_at=NOW() WHERE id=$X61_O7;"
echo "-- ⑦c 未取件提醒先发，对账无进展不重复提醒 --"
X61_O8=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O8/book" "$AT" '{"kuaidicom":"jd","dayType":"今天"}' >/dev/null
X61_BN8=$(x59_bk "$X61_O8" | jq -r .data.booking.bookingNo)
sql "UPDATE express_bookings SET pickup_date='2020-01-01', pickup_end='09:00' WHERE booking_no='$X61_BN8';"
R=$(sched '{"expressUnpickedMin":0,"expressStaleIntervalMin":9999}'); assert_eq "未取件提醒 1 条" "$(jq -r '.data.expressUnpicked // -1' <<<"$R")" "1"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":false}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}')
assert_eq "对账无结论：照旧打标（通知被抑制由代码复核确认）" "$(sql "SELECT IF(stale_reminded_at IS NULL,'NULL','SET') FROM express_bookings WHERE booking_no='$X61_BN8';")" "SET"
assert_eq "前置成立：未取件提醒确实先打过标" "$(sql "SELECT IF(unpicked_reminded_at IS NULL,'NULL','SET') FROM express_bookings WHERE booking_no='$X61_BN8';")" "SET"
assert_eq "对账确实查过（计次 ≥ 1；首轮 tick 里 expressStale 也会占坑一次，所以不断言恰好 1）" "$(sql "SELECT stale_tries >= 1 FROM express_bookings WHERE booking_no='$X61_BN8';")" "1"
req POST "/api/admin/express/orders/$X61_O8/booking/cancel" "$AT" '{}' >/dev/null
```

- [ ] **Step 2: 跑确认失败**

Run: `DB_NAME=food_shop_e2e bash scripts/e2e.sh 2>&1 | grep -E "✘" | head`
Expected: ⑩「订单 COMPLETED」实际 PREPARING、「Shipment 单号+发货时间」NULL；⑦b「已打一次性告警标记」NULL；⑦c「不重复提醒」SET。

- [ ] **Step 3: `express-callback.ts` 补记下沉**

在 `if (mapped.type === 'rank' && mapped.status === 'BOOKED') await applyFee(...)` 之后、`if (mapped.type === 'rank') {` 之前插入：

```ts
  // 签收（13）到达而预约还没到 PICKED：快递100 漏推了 10。先按 10 走一遍（订单 SHIPPED、Shipment.shippedAt、
  // 发货订阅消息），再让下面的 rank 分支收尾成 DELIVERED——否则预约成了 DELIVERED、订单却永远卡在 PREPARING，
  // 且 7 天自动完成 / 对账任务 / 未取件提醒都够不到它。三条签收路径（回调 / 轨迹 / 对账）都经过这里，只修一处。
  if (mapped.type === 'rank' && mapped.status === 'DELIVERED' && current.statusRank < BOOKING_RANK.PICKED) {
    // 单独留一条 SYSTEM 事件：外层只记了这条 13 回调，补记的 10 不留痕的话抽屉时间线看不出「为什么突然发货了」
    await recordBookingEvent(tx, { bookingId: current.id, dedupeKey: adminBookingEventKey(), source: 'SYSTEM', providerStatus: 10, statusDesc: '回调直接签收，补记取件' })
    await applyProviderStatus(tx, current, { ...p, status: '10', statusDesc: '回调直接签收，补记取件' }, after, costAlertRatio)
    current = { ...current, status: 'PICKED', statusRank: BOOKING_RANK.PICKED, kuaidinum: p.kuaidinum ?? current.kuaidinum }
  }
```
（`adminBookingEventKey` 从 `./express-events` 导入，与 `recordBookingEvent` 同处。）

说明：递归调用走的是同一函数，`identity` 的「有值才写、taskId/kdOrderId 只补空」守卫保证第二次不覆盖；`express-track.ts` 与 `express-booking-tasks.ts` 里既有的两步循环保留不动（对 13 会变成幂等的重复一步：`canTransition('PICKED','PICKED')` 为 false 只落 identity；对 101/400 仍由它们负责）。

- [ ] **Step 4: `express-booking-tasks.ts` 兜底 C 支 + 去重复提醒**

`reconcileExpressStale` 的 `where.OR` 增加第三支：

```ts
      // C. 预约已签收但订单还停在备货：历史上「漏推 10 直推 13」留下的孤儿单（T1 之后不再产生）。只告警不改单。
      { status: 'DELIVERED', staleRemindedAt: null, order: { status: { in: ['PAID', 'PREPARING'] } } },
```

`reconcileStaleBooking` 开头（`if (!b || !['BOOKED','ACCEPTED','PICKED'].includes(b.status)) return 'UNCHANGED'` 之前）加：

```ts
  if (b && b.status === 'DELIVERED') {
    if (!['PAID', 'PREPARING'].includes(b.order.status)) return 'UNCHANGED'
    const m = await prisma.expressBooking.updateMany({ where: { id: b.id, staleRemindedAt: null }, data: { staleRemindedAt: new Date() } })
    if (m.count > 0) notifyExpressAlert('预约已签收但订单仍在备货中', [`订单 ${b.orderNo} · ${COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom}${b.kuaidinum ? ` ${b.kuaidinum}` : ''}`, '快递100 已签收，但系统没有收到取件回调，订单没有自动发货', '请在工作台「填单号发货」后再「确认收货」，或联系开发核对'], { key: `express-orphan:${b.id}` })
    return 'UNCHANGED'
  }
```
（`b` 的 include 里已有 `order`；确认 `orderInclude` 选出了 `order.status`，没有则在 include 里补 `status: true`——这是 select 子集，属白名单内文件。）

去重复提醒（00 修订，2026-09-09：原写法与 §61 ⑦ 既有断言「查不到：提醒已打标 SET」冲突，因为同一次 `run-scheduler` 里 `expressUnpicked` 先跑）：**打标照旧、只抑制通知**。`reconcileStaleBooking` 里 BOOKED/ACCEPTED 分支的「无结论提醒」保持 `updateMany({ staleRemindedAt: null })` 打标，但 `m.count > 0` 之后加：`if (b.status !== 'PICKED' && b.unpickedRemindedAt) { /* 已发过「时段已过仍未取件」，不再发第二条近义通知 */ } else { notifyExpressAlert(...) }`。既有 e2e 只断言 `stale_reminded_at` 列，不受影响；通知是否被抑制由 02 复核读代码确认（A5）。

- [ ] **Step 5: selftest 一条**

`apps/server/scripts/selftest-express-booking.ts` 末尾加：

```ts
await t('签收 13 的 rank 高于 PICKED，且 BOOKED/ACCEPTED 都允许直达 DELIVERED（正是补记 10 存在的理由）', () => {
  assert.ok(BOOKING_RANK.DELIVERED > BOOKING_RANK.PICKED)
  assert.ok(canTransition('BOOKED', 'DELIVERED') && canTransition('ACCEPTED', 'DELIVERED'))
  assert.strictEqual(KD_EXPRESS_STATUS_MAP['13'].type, 'rank')
})
```

- [ ] **Step 6: 验收 A1、A2、A3、A4、A5、A9**（A9 先跑一次；若无关段红，重建干净库再跑一次）

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/services/delivery/express-callback.ts apps/server/src/services/delivery/express-booking-tasks.ts apps/server/scripts/selftest-express-booking.ts scripts/e2e.d/59-express-callback.sh scripts/e2e.d/61-express-track.sh
git commit -m "邮寄签收直达补取件：13 到达而预约未到 PICKED 时先按 10 走一遍（三路径共用）；对账加「已签收但订单仍备货」一次性告警；未取件提醒后不重复无进展提醒"
```

---

### Task 2: 下线旧接口写侧（Important）+ Minor 批处理 + 文档

**工序 01 执行 · sonnet。**

**Files:**
- Modify: `apps/server/src/routes/admin/settings.ts`（PUT `/shipping` 只在 `!config.isProduction` 挂载；`config` 已 import 否则补）
- Modify: `apps/admin/src/api/admin.ts`（删 `getShippingSettings`、`updateShippingSettings`；若 `ShippingSettings` 类型随之无引用，在 `types.ts` 一并删）
- Modify: `apps/server/src/services/delivery/express-booking.ts`（`BOOKING_QUOTE_STALE_MS = 90 * 60 * 1000`；`getBookingQuotes` 复用条件加 `snap.quotes.filter((q) => (q.priceFen ?? 0) > 0).length >= s.fee.minQuoteCount`；42225 两处文案 `${callbackUrl.length}` → `${Buffer.byteLength(callbackUrl)}`、同 pollCallbackUrl）
- Modify: `apps/server/src/middlewares/rate-limit.ts`（`devCeiling(120, 2000)` → `devCeiling(300, 2000)`，注释说明状态+轨迹共用一桶）
- Modify: `apps/server/src/config.ts`（`E999999-99/track` → `E9999999999-999/track`，注释改成「订单号十位、序号三位的上界」）
- Modify: `apps/miniapp/pages/order/detail.wxml`（删预约卡内 `order.shipment.remark` 三行——预约路径从不写 remark）
- Modify: `docs/api.md`（邮寄错误码表补 `42210`、`42225` 两行；`1597` 行「批次二后计划删除」改为「写侧仅非生产环境挂载（e2e 用），生产只保留 GET 兼容视图」）
- Modify: `docs/superpowers/notes/2026-09-09-express-batches-integration-audit.md`（末尾追加「## 六、整改状态（批次四）」：逐条写已修/未修+理由，Q1–Q6 的默认）

- [ ] **Step 1: `settings.ts`**

```ts
// 写侧只在非生产挂载：applyLegacyShipping 会把全店切回 TABLE 一口价并抹平分组表（2026-09-09 线上事故），
// 生产只留 GET 兼容视图；e2e（dev 端口）仍靠 PUT 造一口价基线。
if (!config.isProduction) {
  router.put('/shipping', async (req, res, next) => { …原函数体不变… })
}
```

- [ ] **Step 2: admin 死导出、服务端 Minor、小程序 remark 行、docs**（逐项按 Files 说明改）

- [ ] **Step 3: 验收 A1、A6、A7、A8、A10、A11，再跑 A9 全量**

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/admin/settings.ts apps/admin/src/api/admin.ts apps/admin/src/types.ts apps/server/src/services/delivery/express-booking.ts apps/server/src/middlewares/rate-limit.ts apps/server/src/config.ts apps/miniapp/pages/order/detail.wxml docs/api.md docs/superpowers/notes/2026-09-09-express-batches-integration-audit.md
git commit -m "旧运费接口写侧只在非生产挂载、删后台死导出；预约快照复用加有价家数门槛与 90 分钟窗口；回调限流 300、启动自检上界、42225 文案字节；文档补 42210/42225"
```

---

### 复核与收尾（工序 02–04）

- **02 复核 · opus（新会话）**：只给「原始需求」（本文件顶部一段 + 验收标准表）与 `git diff main..HEAD`；输出问题清单，每条 [阻断/需改/建议] 并指明违反 A1–A11 哪条；无问题写「无阻断项」。
- **03 回判 · fable**：逐条 [成立/误判/需澄清]；成立项派 sonnet 修（单提交），再走一次 02。
- **04 机械核对 · haiku**：只跑脚本：A1、A2、A6 的 grep、A7 的 grep、A8、A10、A11，以及 `git log --oneline main..HEAD` 与本计划改动清单逐条对照。
- 全过后 `superpowers:finishing-a-development-branch`：ff 合入 main；主仓库根 `prisma generate` 后 tsc。**是否部署到生产由店主决定**（本批含订单联动改动，部署走 `docs/deployment.md` bundle 法）。
