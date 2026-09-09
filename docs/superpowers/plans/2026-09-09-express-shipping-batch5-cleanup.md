# 全国邮寄接快递100 · 批次五：清理与提醒补齐 —— 实施计划

> **工序 00 规划 · 模型 fable。** 改动等级 **L**（跨回调 / 定时任务 / 预约编排三个模块，动订单状态联动；不确定向上取一级），链路 `fable → sonnet → opus → fable → haiku`。
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**原始需求**（批次四终审与复核记账的三条候选 + 两条顺手项）：
1. `express-track.ts` 里签收的「先 10 再 13」两步循环，在批次四把补记下沉到 `applyProviderStatus` 后已成冗余，删掉，只留一处。
2. 对账查单结果是「快递100 查不到该单」时，即使已发过「时段已过仍未取件」提醒，也要再通知一次（「没这张单」比「还没来取」严重）；「有单但无进展」仍不重复通知。这条要改批次四定下的验收 A5，在本 00 重定。
3. 30 天外的历史孤儿单（预约已签收、订单仍备货）不进定时任务，给一个只读的一次性核查脚本。
4. 顺手：`express-booking.ts` 两处「单号一到就写 Shipment」的 upsert 加 `activeOrderId === orderId` 守卫（批次三审计 Minor，此前不在白名单）。
5. 文档同步（api.md 对账段落、审核笔记整改状态）。

**Goal:** 签收补记只有一份实现；对账「查不到该单」不被抑制；历史孤儿单有查法；Shipment 写入不再依赖阅读者记住上下文。

**Architecture:** 不加迁移、不改错误码、不动同城、不动小程序与后台。三处改动都在服务端 `services/delivery/` 与一个只读脚本。

## 未决歧义（默认已定；店主不同意再改）

| # | 歧义 | 默认 |
|---|---|---|
| Q1 | 对账 `101/400`（在途/派送中）的补记要不要也下沉到 `applyProviderStatus`？ | **不下沉**。它们是 IGNORE 状态，只有对账路径会拿到，留在 `reconcileStaleBooking` 里；只把 `13` 的重复删掉 |
| Q2 | 「查不到该单」通知是否受 `staleRemindedAt` 一次性限制？ | **受限**：每单最多一次无结论提醒；只是当这一次的结论是 NOT_FOUND 时不再被「已发过未取件提醒」抑制 |
| Q3 | 孤儿单脚本是否顺手修单？ | **只读**，打印清单与建议命令，不改任何行 |

## Global Constraints

- **同城 LOCAL 零行为变化；老邮寄单零行为变化；不加迁移；不改 4226x 错误码；不动 `apps/admin`、`apps/miniapp`。**
- 签收语义不变：预约到 DELIVERED 前订单必须经过 SHIPPED（`Shipment.shippedAt` 有值、发货订阅消息一次）再 COMPLETED。
- 每单每类提醒只发一次（DB 标记列）。
- e2e 干净库 `SCHEDULER_DISABLED=true` 全量：断言只增不减（基线 **1499/0**）。
- 每次交接声明「当前工序 · 模型」。

## 允许修改的文件白名单

```
apps/server/src/services/delivery/express-track.ts            # 仅删两步循环、改为单次 applyProviderStatus('13')
apps/server/src/services/delivery/express-callback.ts         # 仅补记事件的 statusDesc 文案
apps/server/src/services/delivery/express-booking-tasks.ts    # needsPickBackfill 收窄；NOT_FOUND 通知规则 + 留痕
apps/server/src/services/delivery/express-booking.ts          # 仅两处 shipment.upsert 的 activeOrderId 守卫
apps/server/scripts/express-orphans.ts                        # 新建，只读
scripts/e2e.d/61-express-track.sh
docs/api.md
docs/superpowers/notes/2026-09-09-express-batches-integration-audit.md   # 末尾追加「七、整改状态（批次五）」
```

## 上报触发条件（执行方必须停下）

1. 需要改白名单外的任何文件（含 e2e §59/§60、schema、同城任何文件、小程序、后台）。
2. tsc / selftest / e2e 出现与本次改动无关的失败，且干净库重跑一次仍红。
3. 删掉 `express-track.ts` 两步循环后 §61 ④（BOOKED 直接签收）任一断言变红。
4. 任何一步需要 `prisma generate` / 迁移 / 改 `.env`。

## 验收标准（只在这里定义）

| # | 命令 / 用例 | 期望 |
|---|---|---|
| A1 | `cd apps/server && npx tsc --noEmit` | 无输出、退出码 0 |
| A2 | `cd apps/server && npx ts-node --transpile-only scripts/selftest-express-booking.ts \| tail -1` | `通过 22 条`（不变） |
| A3 | e2e §61 ④（BOOKED 直接签收）既有 4 条断言 + 新增 1 条 | 既有全绿；新增：该预约 `express_booking_events` 里 `provider_status=10 AND source='SYSTEM'` 恰好 1 条（补记留痕来自 `applyProviderStatus`，不再来自 express-track） |
| A4 | `grep -n "needsPickBackfill" apps/server/src/services/delivery/express-booking-tasks.ts` | 判定列表只含 `'101', '400'`；e2e §61 ⑦「BOOKED + detail 13 → DELIVERED / 订单 COMPLETED / Shipment SET」既有断言全绿 |
| A5 | e2e §61 ⑦c（已发未取件提醒后对账 `found:false`）+ 新增 ⑦d（已发未取件提醒后对账 `found:true,status:1`） | ⑦c：`stale_reminded_at` SET 且该预约有 1 条 SYSTEM 事件 `statusDesc` 含「查不到该单」；⑦d：`stale_reminded_at` SET 且此类事件 0 条（有单无进展仍抑制） |
| A6 | `cd apps/server && DATABASE_URL=mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_e2e npx ts-node --transpile-only scripts/express-orphans.ts` | 退出码 0；首行是表头、末行是「共 N 条」；N 取决于 e2e 库当时的数据（⑦b 已把孤儿单改回 COMPLETED，多半为 0），以「不报错、格式正确」为准 |
| A7 | `git diff main --stat -- apps/admin apps/miniapp` | 空 |
| A8 | 干净库全量 `DB_NAME=food_shop_e2e bash scripts/e2e.sh` | `失败 0`，通过数 ≥ 1499 + 本批新增断言数 |
| A9 | `git diff main --stat -- apps/server/src/services/delivery/orchestrator.ts apps/server/src/services/delivery/callback.ts apps/server/src/services/delivery/state.ts apps/server/src/routes/admin/delivery.ts apps/server/prisma scripts/e2e.d/59-express-callback.sh scripts/e2e.d/60-express-guards.sh` | 空 |
| A10 | `grep -n "查不到该单" docs/api.md` | 对账段落含「NOT_FOUND 即使已发过未取件提醒也通知一次」的说明 |

---

### Task 1: 删冗余两步、收窄对账补记

**工序 01 执行 · sonnet。**

**Files:**
- Modify: `apps/server/src/services/delivery/express-track.ts:61-68`
- Modify: `apps/server/src/services/delivery/express-callback.ts`（补记事件 `statusDesc` 与 payload `statusDesc`：`'回调直接签收，补记取件'` → `'签收到达而预约未取件，补记取件'`——轨迹与回调两条路径现在共用这句）
- Modify: `apps/server/src/services/delivery/express-booking-tasks.ts`（`needsPickBackfill`）
- Test: `scripts/e2e.d/61-express-track.sh` ④

- [ ] **Step 1: e2e 先加断言**（§61 ④ 末尾、`echo "-- ⑤ abort…"` 之前）

```bash
assert_eq "补记取件留痕只有一条、且来自统一入口（SYSTEM）" "$(sql "SELECT COUNT(*) FROM express_booking_events e JOIN express_bookings b ON b.id=e.booking_id WHERE b.booking_no='$X61_BN2' AND e.provider_status=10 AND e.source='SYSTEM';")" "1"
```

- [ ] **Step 2: 跑 §61 看现状**：当前 express-track 自己走了 '10' 一步（无 SYSTEM 留痕）→ 断言实际 0，红。

- [ ] **Step 3: `express-track.ts`** 把

```ts
      const steps = booking.statusRank < BOOKING_RANK.PICKED ? ['10', '13'] : ['13']
      let cur: BookingWithOrder = booking
      for (const s of steps) {
        await applyProviderStatus(tx, cur, syntheticPayload(cur, p, s), after, costAlertRatio)
        const st = s === '10' ? 'PICKED' : 'DELIVERED'
        cur = { ...cur, status: st, statusRank: BOOKING_RANK[st], kuaidinum: p.nu ?? cur.kuaidinum }
      }
```

替换为

```ts
      // 签收 = 取件 + 签收：预约还没到 PICKED 时的「先补一步 10」已内置在 applyProviderStatus（批次四），
      // 三条签收路径（回调 / 轨迹 / 对账）共用一处，这里只按 13 走一遍
      await applyProviderStatus(tx, booking, syntheticPayload(booking, p, '13'), after, costAlertRatio)
```

若 `BookingWithOrder` / `BOOKING_RANK` 因此无引用，删掉对应 import/type（tsc 会报 unused 时才动）。

- [ ] **Step 4: `express-booking-tasks.ts`** `needsPickBackfill` 改为只对在途/派送中：

```ts
    // 13（签收）的补记已内置在 applyProviderStatus；这里只管 101/400 这两种「在途但还没取件回调」的 IGNORE 状态
    const needsPickBackfill = b.statusRank < BOOKING_RANK.PICKED && ['101', '400'].includes(status)
```

同时更新函数头注释里提到「13」的那句。

- [ ] **Step 5: `express-callback.ts`** 两处 `'回调直接签收，补记取件'` → `'签收到达而预约未取件，补记取件'`。

- [ ] **Step 6: 验收 A1、A2、A3、A4、A8（先跑一次全量）**

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/services/delivery/express-track.ts apps/server/src/services/delivery/express-callback.ts apps/server/src/services/delivery/express-booking-tasks.ts scripts/e2e.d/61-express-track.sh
git commit -m "邮寄签收补记只留 applyProviderStatus 一处：轨迹签收改单次 13、对账补记只管 101/400；e2e §61 ④ 锁定补记留痕来源"
```

---

### Task 2: 「查不到该单」不被抑制 + 孤儿单脚本 + Shipment 守卫 + 文档

**工序 01 执行 · sonnet。**

**Files:**
- Modify: `apps/server/src/services/delivery/express-booking-tasks.ts`（无结论提醒分支）
- Modify: `apps/server/src/services/delivery/express-booking.ts:195, 288`
- Create: `apps/server/scripts/express-orphans.ts`
- Test: `scripts/e2e.d/61-express-track.sh` ⑦c / ⑦d
- Modify: `docs/api.md`、`docs/superpowers/notes/2026-09-09-express-batches-integration-audit.md`

- [ ] **Step 1: e2e**——⑦c 末尾（`req POST … booking/cancel` 之前）加：

```bash
assert_eq "查不到该单：即使已发过未取件提醒也留一条 SYSTEM 事件（通知随之发出）" "$(sql "SELECT COUNT(*) FROM express_booking_events e JOIN express_bookings b ON b.id=e.booking_id WHERE b.booking_no='$X61_BN11' AND e.source='SYSTEM' AND e.status_desc LIKE '%查不到该单%';")" "1"
```

其后新增 ⑦d（放在 ⑦c 的 cancel 之后、`req POST /api/admin/system/express-mock/reset` 之前）：

```bash
echo "-- ⑦d 已发未取件提醒后，对账查到有单但无进展：仍抑制通知（不留「查不到」事件）--"
X61_O12=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O12/book" "$AT" '{"kuaidicom":"jd","dayType":"今天"}' >/dev/null
X61_BN12=$(x59_bk "$X61_O12" | jq -r .data.booking.bookingNo)
sql "UPDATE express_bookings SET pickup_date='2020-01-01', pickup_end='09:00' WHERE booking_no='$X61_BN12';"
# 首轮 sched 里 expressStale 也会占坑查一次：先排好「有单」指令，别让 mock 默认值被判成 NOT_FOUND
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":true,"status":0}}' >/dev/null
R=$(sched '{"expressUnpickedMin":0,"expressStaleIntervalMin":9999}'); assert_eq "⑦d 未取件提醒 1 条" "$(jq -r '.data.expressUnpicked // -1' <<<"$R")" "1"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":true,"status":0}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}')
assert_eq "⑦d 有单无进展：打标 SET" "$(sql "SELECT IF(stale_reminded_at IS NULL,'NULL','SET') FROM express_bookings WHERE booking_no='$X61_BN12';")" "SET"
assert_eq "⑦d 有单无进展：不留「查不到」事件" "$(sql "SELECT COUNT(*) FROM express_booking_events e JOIN express_bookings b ON b.id=e.booking_id WHERE b.booking_no='$X61_BN12' AND e.status_desc LIKE '%查不到该单%';")" "0"
req POST "/api/admin/express/orders/$X61_O12/booking/cancel" "$AT" '{}' >/dev/null
```

说明：⑦c 保持原样即可——首轮 sched 里 `expressStale` 用 mock 默认值判成 NOT_FOUND，按新规则会通知并留一条事件；第二轮 `found:false` 时 `staleRemindedAt` 已 SET，不再留第二条，所以恰好 1 条。⑦d 两轮都先排「有单」指令，保证走 UNCHANGED 分支。

- [ ] **Step 2: 跑 §61 看现状**：⑦c 新断言红（当前抑制分支不发通知也不留痕）。

- [ ] **Step 3: `express-booking-tasks.ts` 无结论提醒分支**改为：

```ts
  if (m.count > 0) {
    // 已发过「时段已过仍未取件」的（BOOKED/ACCEPTED 起点）：有单无进展不再重复轰炸；
    // 但「查不到该单」是另一回事——快递100 那头压根没这张单，店员必须去后台核对，照发。
    const suppressed = b.status !== 'PICKED' && !!b.unpickedRemindedAt && result !== 'NOT_FOUND'
    if (!suppressed) {
      const why = b.status === 'PICKED'
        ? [`已取件超过 ${pickedDays} 天仍无签收回调，主动查单${result === 'NOT_FOUND' ? '查不到该单' : '也无新进展'}`, '订单已按 7 天规则自动完成；如顾客反馈未收到，请到快递100 后台或联系快递公司查件']
        : [`预约时段已过，至今无取件回调，主动查单${result === 'NOT_FOUND' ? '查不到该单' : '也无新进展'}`, '请联系快递员确认是否已取件；未取请改约或取消后换家重约']
      notifyExpressAlert(b.status === 'PICKED' ? '邮寄单取件后长时间未签收' : '预约时段过后仍无进展', [`订单 ${b.orderNo} · ${label}${b.kuaidinum ? ` ${b.kuaidinum}` : ''}`, ...why], { key: `express-stale:${b.id}` })
      if (result === 'NOT_FOUND') {
        await recordBookingEvent(prisma, { bookingId: b.id, dedupeKey: adminBookingEventKey(), source: 'SYSTEM', statusDesc: '对账查单：快递100 查不到该单，已提醒店员核对' })
      }
    }
  }
```

（`adminBookingEventKey` 从 `./express-events` 导入。）

- [ ] **Step 4: `express-booking.ts` 两处 upsert 守卫**

`:195`（createBooking 事务内）：`if (r.kuaidinum)` → `if (r.kuaidinum && row.activeOrderId === i.orderId)`；
`:288`（reconcileUnknownBooking）：`if (d.kuaidinum)` → `if (d.kuaidinum && b.activeOrderId === b.orderId)`。各加一行注释「Shipment 以 orderId 为键，只允许当前活跃预约写」。

- [ ] **Step 5: 只读脚本 `apps/server/scripts/express-orphans.ts`**

```ts
/**
 * 一次性核查：预约已签收（DELIVERED）但订单仍停在 PAID/PREPARING 的「孤儿单」（历史上快递100 漏推 10 直推 13
 * 留下的；批次四之后不再产生，定时任务只扫最近 30 天）。只读，不改任何行。
 *   cd apps/server && DATABASE_URL=... npx ts-node --transpile-only scripts/express-orphans.ts
 */
import prisma from '../src/utils/prisma'

async function main() {
  const rows = await prisma.expressBooking.findMany({
    where: { status: 'DELIVERED', order: { status: { in: ['PAID', 'PREPARING'] } } },
    orderBy: { deliveredAt: 'asc' },
    select: { id: true, bookingNo: true, orderNo: true, orderId: true, kuaidicom: true, kuaidinum: true, deliveredAt: true, staleRemindedAt: true, order: { select: { status: true } } },
  })
  console.log('booking_id\tbooking_no\torder_no\torder_status\tkuaidicom\tkuaidinum\tdelivered_at\treminded')
  for (const r of rows) console.log([r.id, r.bookingNo, r.orderNo, r.order.status, r.kuaidicom, r.kuaidinum ?? '', r.deliveredAt?.toISOString() ?? '', r.staleRemindedAt ? 'Y' : 'N'].join('\t'))
  console.log(`\n共 ${rows.length} 条。处理方式：工作台对该订单「填单号发货」→「确认收货」；或联系开发核对。`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 6: 文档**——`docs/api.md` 对账段落（`reconcileExpressStale` 那一节）加一条：「无结论提醒每单一次；若已发过「时段过未取件」提醒，有单无进展不再重复通知，但 `detail` **查不到该单**仍通知一次并留 SYSTEM 事件『对账查单：快递100 查不到该单』（批次五）」；审核笔记末尾追加「## 七、整改状态（批次五）」（三条候选 + Shipment 守卫的处理与提交号）。

- [ ] **Step 7: 验收 A1、A5、A6、A7、A9、A10，再 A8 全量**

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/services/delivery/express-booking-tasks.ts apps/server/src/services/delivery/express-booking.ts apps/server/scripts/express-orphans.ts scripts/e2e.d/61-express-track.sh docs/api.md docs/superpowers/notes/2026-09-09-express-batches-integration-audit.md
git commit -m "对账「查不到该单」不再被未取件提醒抑制并留痕；Shipment 单号写入加活跃预约守卫；孤儿单只读核查脚本；文档"
```

---

### 复核与收尾（工序 02–04）

- **02 复核 · opus（新会话）**：只给「原始需求 + 全局约束 + 白名单 + 触发条件 + 验收 A1–A10」与 `git diff main..HEAD`（排除方案文档）；输出 [阻断/需改/建议] 清单并指明违反哪条 A；无问题写「无阻断项」。
- **03 回判 · fable**：逐条 [成立/误判/需澄清]；成立项派 sonnet 修（单提交），再过一次 02。
- **04 机械核对 · haiku**：A1、A2、A4 的 grep、A6、A7、A9、A10、提交数与白名单对照。
- 全过后 `superpowers:finishing-a-development-branch`：ff 合入 main；主仓库根 tsc。**部署由店主决定**。
