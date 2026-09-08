# 经营概览重做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把后台 `/dashboard` 重做成「统一时间范围 + 总览 / 同城配送 / 全国邮寄 三 tab」的经营看板，并把统计口径统一到「按付款日归属的已付款单」。

**Architecture:** 服务端在 `routes/admin/stats/` 下新增三个只读聚合接口（overview / local / express），共用 `shared.ts` 的区间解析与订单口径；老 `/admin/stats` 与 `/trend` 保留但改到同一口径。前端 `Dashboard.tsx` 变成壳（范围选择 + tab + URL 状态），三个 tab 各自拉各自的接口，图表继续手写 SVG。

**Tech Stack:** Express + Prisma（MySQL）+ zod v4；React + TypeScript + Tailwind（admin）；bash e2e（`scripts/e2e.sh` + `scripts/e2e.d/*.sh`，库 `food_shop_audit`）。

Spec: `docs/superpowers/specs/2026-09-08-dashboard-redesign-design.md`（口径以 spec §3 为准，本计划里的代码是它的落地）。

## Global Constraints

- **不加表、不加迁移。** 只写查询。
- **所有统计查询必须 `...REAL_ORDERS` / `realOrdersSql()`**（`apps/server/src/utils/stats-scope.ts`），不许手写 `isTest: false`。
- 订单归属按 **`paidAt`** 落在区间（上海自然日），状态不限；金额一律**分**，时长整数分钟/小时，无样本分位数为 `null`。
- 区间 `startDate`/`endDate`（`YYYY-MM-DD`，含端），默认近 7 天，上限 92 天，非法 → 40001（zod 由 `middlewares/error.ts` 统一转 40001）。
- 前端日期键只用 `apps/admin/src/utils/time.ts` 的 `todayKey/shiftDayKey`；**不得**调用 `Date.prototype.getDate/getHours/...`（`scripts/check-admin-timezone.mjs` 门禁会在 build 时拦）。
- 不动 `ui/TrendChart.tsx`、`ui/ChannelTabs.tsx`（别的页面在用）。
- 每个 Task 结束 `git commit`；提交信息中文、结尾加 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。**禁止 `git push`。**
- 验证命令：服务端 `npm run build --workspace=apps/server`；管理端 `npm run build --workspace=apps/admin`；e2e `BASE=http://localhost:3105 BASE=http://localhost:3105 DB_NAME=food_shop_audit bash scripts/e2e.sh`（基线 1199 绿 / 0 红；跑 e2e 前不要执行 `prisma generate/migrate`，会把跑着的服务打断）。e2e 依赖本机已经跑着的 dev server：`ts-node-dev` 起在 **3105**，cwd 就是本 worktree 的 `apps/server`（改 `.ts` 会自动重启），库 `food_shop_audit`，各 mock 开关都已打开。先 `curl -s -o /dev/null -w '%{http_code}' 'http://localhost:3105/api/products?pageSize=1'` 看到 200 再跑。**不要**另起一个。
- 不改老接口字段名：`GET /admin/stats` 返回 `today.orderCount/salesAmount`、`total.*`、`hotProducts`；`/admin/stats/trend` 返回 `list[{date,orderCount,salesAmount}]`——e2e §33 直接断言这些字段。

---

## File Structure

**服务端（新建目录 `apps/server/src/routes/admin/stats/`，删除原 `routes/admin/stats.ts`）**

| 文件 | 职责 |
|---|---|
| `stats/shared.ts` | `parseRange`（含上期）、`paidOrdersWhere`、`median/percentile`、`localHourFromParts` |
| `stats/legacy.ts` | 原 `/` 与 `/trend` 两个接口，改到新口径 |
| `stats/overview.ts` | `GET /overview` |
| `stats/local.ts` | `GET /local` |
| `stats/express.ts` | `GET /express` |
| `stats/index.ts` | 把四个 Router 挂在一起，export default |

`routes/admin/index.ts` 里 `import statsRouter from './stats'` 不用改（目录 index 解析）。

**管理端**

| 文件 | 职责 |
|---|---|
| `apps/admin/src/hooks/useIsPhone.ts` | 从 `pages/Workbench.tsx` 抽出来共用 |
| `apps/admin/src/components/dashboard/RangePicker.tsx` | 快捷项 + 自定义日期 |
| `apps/admin/src/components/dashboard/KpiCard.tsx` | 数字卡 + 较上期 |
| `apps/admin/src/components/dashboard/StackedBars.tsx` | 1–2 系列堆叠柱 SVG |
| `apps/admin/src/components/dashboard/OverviewTab.tsx` | 总览 |
| `apps/admin/src/components/dashboard/LocalTab.tsx` | 同城配送 |
| `apps/admin/src/components/dashboard/ExpressTab.tsx` | 全国邮寄 |
| `apps/admin/src/components/dashboard/format.ts` | `fen(v)`、`pct(v)`、`minutes(v)`、`hours(v)` 小工具 |
| `apps/admin/src/pages/Dashboard.tsx` | 壳：范围 + tab + URL |
| `apps/admin/src/types.ts` | `OverviewStats/LocalStats/ExpressStats/StatsRangeParams` |
| `apps/admin/src/api/admin.ts` | `getOverviewStats/getLocalStats/getExpressStats` |

**测试与文档**

| 文件 | 职责 |
|---|---|
| `scripts/e2e.d/54-dashboard-stats.sh` | §54 |
| `docs/api.md` §3.7 | 三个新接口 + 老接口口径说明 |

---

### Task 1: `stats/shared.ts` + 老接口改口径（拆目录）

**Files:**
- Create: `apps/server/src/routes/admin/stats/shared.ts`
- Create: `apps/server/src/routes/admin/stats/legacy.ts`（内容来自现 `routes/admin/stats.ts`）
- Create: `apps/server/src/routes/admin/stats/index.ts`
- Delete: `apps/server/src/routes/admin/stats.ts`
- Test: `scripts/e2e.d/54-dashboard-stats.sh`（本 task 只写 §54-A 段）

**Interfaces:**
- Produces:
  ```ts
  export interface Range { start: Date; endExclusive: Date; startDate: string; endDate: string; days: number }
  export function parseRange(query: unknown): { cur: Range; prev: Range }
  export function paidOrdersWhere(r: Range, channel?: 'LOCAL' | 'EXPRESS'): Prisma.OrderWhereInput
  export function percentile(values: number[], p: number): number | null   // p∈(0,1]，向上取整名次；空数组 null
  export const median = (v: number[]) => percentile(v, 0.5)
  export function localHourFromParts(r: LocalDayParts): number             // 0–23（上海）
  export const rangeOut = (cur: Range, prev: Range) => ({ startDate, endDate, prevStartDate, prevEndDate })
  ```

- [ ] **Step 1: 写 e2e §54-A（老接口口径：未付款单不计入）**

新建 `scripts/e2e.d/54-dashboard-stats.sh`：

```bash
# §54 经营概览三接口（overview / local / express）与老接口的新口径。
# 口径见 docs/superpowers/specs/2026-09-08-dashboard-redesign-design.md §3。
# 全部走「记基线 → 造单 → 比差值」，与 §33 同款：只断言 code 0 证明不了口径接上了。
echo "== 54. 经营概览：三接口与统一付款日口径 =="
S54=$(date +%F)
d54() { req GET "/api/admin/stats/$1?startDate=$S54&endDate=$S54" "$AT"; }

# ── A. 老接口：未付款单不进「今日单数」与趋势（原来按 created_at + status!=CANCELLED 会算进去） ──
A_TODAY=$(req GET /api/admin/stats "$AT" | jq -r '.data.today.orderCount')
A_TREND=$(req GET "/api/admin/stats/trend?days=7" "$AT" | jq -r --arg d "$S54" '[.data.list[]|select(.date==$d)][0].orderCount // 0')
R=$(req POST /api/cart "$UT" "{\"productId\":$PID,\"quantity\":1}"); C54=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$C54],\"addressId\":$ADDR,\"deliveryType\":\"EXPRESS\"}")
UNPAID54=$(jq -r '.data.orderId // .data.id // empty' <<<"$R")
[[ -n "$UNPAID54" ]] && ok "造一张未付款单 #$UNPAID54" || fail "造未付款单" "$R"
assert_eq "A① 未付款单不进今日单数" "$(req GET /api/admin/stats "$AT" | jq -r '.data.today.orderCount')" "$A_TODAY"
assert_eq "A② 未付款单不进趋势图" "$(req GET "/api/admin/stats/trend?days=7" "$AT" | jq -r --arg d "$S54" '[.data.list[]|select(.date==$d)][0].orderCount // 0')" "$A_TREND"
req PUT "/api/orders/$UNPAID54/cancel" "$UT" >/dev/null   # 不留待付款单给后面的段
```

（`e2e.sh:2004` 的 `for f in e2e.d/*.sh; do source` 会自动带上，不用登记。）

- [ ] **Step 2: 跑 e2e 只看 §54，确认 A①/A② 现在是红的**

Run: `BASE=http://localhost:3105 DB_NAME=food_shop_audit bash scripts/e2e.sh 2>&1 | sed -n '/== 54\./,/== 55\.\|^汇总\|^PASS/p'`
Expected: `A① … 期望 [N] 实际 [N+1]`、`A② …` 红（老口径把未付款单算进去了）。

- [ ] **Step 3: 写 `stats/shared.ts`**

```ts
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { REAL_ORDERS } from '../../../utils/stats-scope'
import type { LocalDayParts } from '../../../utils/local-day'

/**
 * 经营概览三接口共用的区间解析与订单口径。
 * 口径：docs/superpowers/specs/2026-09-08-dashboard-redesign-design.md §3。
 */
export interface Range {
  start: Date
  endExclusive: Date
  startDate: string
  endDate: string
  days: number
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 92

const rangeSchema = z.object({
  startDate: z.string().regex(DAY, '日期格式须为 YYYY-MM-DD').optional(),
  endDate: z.string().regex(DAY, '日期格式须为 YYYY-MM-DD').optional(),
})

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * [start 00:00, end 次日 00:00)，默认近 7 天（含今日）；同时给出紧挨在前、等长的「上期」。
 * `new Date('YYYY-MM-DDT00:00:00')` 按服务端本地时区解释——服务端固定 Asia/Shanghai，
 * 与 routes/admin/scan-stats.ts 的 parseRange 同一做法。
 */
export function parseRange(query: unknown): { cur: Range; prev: Range } {
  const q = rangeSchema.parse(query)
  const end = q.endDate ? new Date(`${q.endDate}T00:00:00`) : new Date(new Date().setHours(0, 0, 0, 0))
  const endExclusive = new Date(end)
  endExclusive.setDate(endExclusive.getDate() + 1)
  const start = q.startDate ? new Date(`${q.startDate}T00:00:00`) : new Date(end)
  if (!q.startDate) start.setDate(start.getDate() - 6)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new z.ZodError([{ code: 'custom', path: ['startDate'], message: '日期无效', input: q }])
  }
  const days = Math.round((endExclusive.getTime() - start.getTime()) / 86400000)
  if (days < 1 || days > MAX_DAYS) {
    throw new z.ZodError([{ code: 'custom', path: ['endDate'], message: `区间须为 1–${MAX_DAYS} 天`, input: q }])
  }
  const prevStart = new Date(start)
  prevStart.setDate(prevStart.getDate() - days)
  const prevEndDay = new Date(start)
  prevEndDay.setDate(prevEndDay.getDate() - 1)
  return {
    cur: { start, endExclusive, startDate: dayKey(start), endDate: dayKey(end), days },
    prev: { start: prevStart, endExclusive: start, startDate: dayKey(prevStart), endDate: dayKey(prevEndDay), days },
  }
}

export const rangeOut = (cur: Range, prev: Range) => ({
  startDate: cur.startDate,
  endDate: cur.endDate,
  prevStartDate: prev.startDate,
  prevEndDate: prev.endDate,
})

/** 参与统计的订单：真实单 + 付款时间落在区间内；状态不限（退款单也算单数，退款额另计） */
export function paidOrdersWhere(r: Range, channel?: 'LOCAL' | 'EXPRESS'): Prisma.OrderWhereInput {
  return {
    ...REAL_ORDERS,
    paidAt: { gte: r.start, lt: r.endExclusive },
    ...(channel ? { deliveryType: channel } : {}),
  }
}

/** 名次向上取整的分位数；空数组 null。结果四舍五入到整数（调用方传的是分钟/小时）。 */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return Math.round(sorted[idx])
}
export const median = (v: number[]) => percentile(v, 0.5)

/** 把 localDayPartsSql 取出的 UTC 年月日时还原成上海小时（0–23）。与 localDayKeyFromParts 同一思路。 */
export function localHourFromParts(r: LocalDayParts): number {
  return new Date(Date.UTC(Number(r.y), Number(r.mo) - 1, Number(r.d), Number(r.h))).getHours()
}

export const minutesBetween = (a: Date | null | undefined, b: Date | null | undefined): number | null =>
  a && b ? (b.getTime() - a.getTime()) / 60000 : null
```

- [ ] **Step 4: 把现 `stats.ts` 搬成 `stats/legacy.ts` 并改口径**

`git mv apps/server/src/routes/admin/stats.ts apps/server/src/routes/admin/stats/legacy.ts`，然后改三处：

1. import 路径多一层：`'../../../utils/prisma'`、`'../../../utils/response'`、`'../../../utils/stats-scope'`、`'../../../utils/local-day'`。
2. `GET /` 里两处今日口径改成按 `paidAt`、不限状态：

```ts
      prisma.order.count({ where: { ...REAL_ORDERS, paidAt: { gte: today, lt: tomorrow } } }),
      // …
      prisma.order.aggregate({
        // 与工作台「今日营业额」同口径（routes/admin/workbench.ts）：付过款就算，不按状态筛。
        // 原来只算 PAID/SHIPPED/COMPLETED，漏了 PREPARING（同城单大半天都在这个状态）。
        where: { ...REAL_ORDERS, paidAt: { gte: today, lt: tomorrow } },
        _sum: { actualAmount: true },
      }),
```

3. `GET /trend` 的 SQL 改成按付款日、只算已付款单：

```ts
      SELECT ${localDayPartsSql('paid_at')}, COUNT(*) cnt, SUM(actual_amount) amt
      FROM orders
      WHERE paid_at >= ${start} AND paid_at < ${endExclusive}
        ${realOrdersSql()}
      GROUP BY ${LOCAL_DAY_GROUP_BY}`
```

文件头注释加一行：`// 口径：按付款日归属的已付款单（spec 2026-09-08 §3.2）；只为 e2e §33 与老截图保留，新页面走 overview/local/express。`

- [ ] **Step 5: 写 `stats/index.ts`**

```ts
import { Router } from 'express'
import legacyRouter from './legacy'

const router = Router()
// 老接口：GET / 与 GET /trend（后台旧概览与 e2e §33 在用）
router.use(legacyRouter)
export default router
```

- [ ] **Step 6: 编译 + e2e**

Run: `npm run build --workspace=apps/server && BASE=http://localhost:3105 DB_NAME=food_shop_audit bash scripts/e2e.sh 2>&1 | tail -5`
Expected: 编译无错；e2e 汇总 **1201 绿 / 0 红**（原 1199 + A①A②）。§33 的 8 条仍绿。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/admin/stats scripts/e2e.d/54-dashboard-stats.sh
git rm -q --cached apps/server/src/routes/admin/stats.ts 2>/dev/null; true
git commit -m "经营统计：抽 stats/shared，老概览接口改到按付款日口径（未付款单不再计入）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `GET /admin/stats/overview`

**Files:**
- Create: `apps/server/src/routes/admin/stats/overview.ts`
- Modify: `apps/server/src/routes/admin/stats/index.ts`
- Test: `scripts/e2e.d/54-dashboard-stats.sh` §54-B

**Interfaces:**
- Consumes: Task 1 的 `parseRange/paidOrdersWhere/localHourFromParts/rangeOut`
- Produces: 响应结构见 spec §4（`kpi/channels/trend/hourly/customers/hotProducts`）

- [ ] **Step 1: 写 e2e §54-B**

追加到 `54-dashboard-stats.sh`：

```bash
# ── B. overview：造一张已付邮寄单，各口径 +1 ──
B0=$(d54 overview)
assert_eq "B 参数：startDate 格式错 40001" "$(code "$(req GET '/api/admin/stats/overview?startDate=2026/09/08' "$AT")")" "40001"
assert_eq "B 参数：区间 >92 天 40001" "$(code "$(req GET '/api/admin/stats/overview?startDate=2026-01-01&endDate=2026-06-30' "$AT")")" "40001"
assert_eq "B 参数：默认区间 code 0" "$(code "$(req GET /api/admin/stats/overview "$AT")")" "0"
B_CNT=$(jq -r .data.kpi.orderCount <<<"$B0"); B_REV=$(jq -r .data.kpi.revenueFen <<<"$B0")
B_EXP=$(jq -r .data.channels.EXPRESS.orderCount <<<"$B0")
B_HOT=$(jq -r --argjson p "$PID" '[.data.hotProducts[]|select(.productId==$p)][0].qty // 0' <<<"$B0")
B_USERS=$(jq -r .data.customers.users <<<"$B0")
BO=$(make_paid_order); [[ -n "$BO" ]] && ok "B 造已付邮寄单 #$BO" || fail "B 造单"
BO_AMT=$(req GET "/api/admin/orders/$BO" "$AT" | jq -r .data.actualAmount)
B1=$(d54 overview)
assert_eq "B① 单数 +1" "$(jq -r .data.kpi.orderCount <<<"$B1")" "$((B_CNT+1))"
assert_eq "B② 实收 +实付" "$(jq -r .data.kpi.revenueFen <<<"$B1")" "$((B_REV+BO_AMT))"
assert_eq "B③ 邮寄渠道 +1" "$(jq -r .data.channels.EXPRESS.orderCount <<<"$B1")" "$((B_EXP+1))"
assert_eq "B④ 趋势今日 = 两渠道之和 = kpi 单数" "$(jq -r --arg d "$S54" '[.data.trend[]|select(.date==$d)][0] | (.LOCAL.orderCount + .EXPRESS.orderCount)' <<<"$B1")" "$((B_CNT+1))"
assert_eq "B⑤ 24 小时桶之和 = kpi 单数" "$(jq -r '.data.hourly | add' <<<"$B1")" "$((B_CNT+1))"
assert_eq "B⑥ 热销榜该商品 qty +1（按 order_items 聚合）" "$(jq -r --argjson p "$PID" '[.data.hotProducts[]|select(.productId==$p)][0].qty // 0' <<<"$B1")" "$((B_HOT+1))"
assert_eq "B⑦ 客单价 = 实收/单数" "$(jq -r .data.kpi.avgOrderFen <<<"$B1")" "$(( (B_REV+BO_AMT) / (B_CNT+1) ))"
assert_eq "B⑧ 顾客数 = 新客 + 老客" "$(jq -r '.data.customers | (.newUsers + .returningUsers)' <<<"$B1")" "$(jq -r .data.customers.users <<<"$B1")"
[[ "$(jq -r .data.customers.users <<<"$B1")" -ge "$B_USERS" ]] && ok "B⑨ 顾客数不减少" || fail "B⑨ 顾客数" "$B1"
assert_eq "B⑩ channel=LOCAL 的热销榜不受邮寄单影响" "$(req GET "/api/admin/stats/overview?startDate=$S54&endDate=$S54&channel=LOCAL" "$AT" | jq -r --argjson p "$PID" '[.data.hotProducts[]|select(.productId==$p)][0].qty // 0')" "$B_HOT_L"
```

其中 `B_HOT_L` 要在 `BO=$(make_paid_order)` **之前**取（放在 `B_USERS=` 那行后面）：

```bash
B_HOT_L=$(req GET "/api/admin/stats/overview?startDate=$S54&endDate=$S54&channel=LOCAL" "$AT" | jq -r --argjson p "$PID" '[.data.hotProducts[]|select(.productId==$p)][0].qty // 0')
```

- [ ] **Step 2: 跑 §54，确认 B 段全红（404 → code 非 0）**

Run: `BASE=http://localhost:3105 DB_NAME=food_shop_audit bash scripts/e2e.sh 2>&1 | sed -n '/== 54\./,/^汇总\|PASS=/p' | head -30`

- [ ] **Step 3: 写 `overview.ts`**

```ts
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../../utils/prisma'
import { success } from '../../../utils/response'
import { REAL_ORDERS, realOrdersSql } from '../../../utils/stats-scope'
import { localDayPartsSql, LOCAL_DAY_GROUP_BY, localDayKey, localDayKeyFromParts } from '../../../utils/local-day'
import { parseRange, paidOrdersWhere, localHourFromParts, rangeOut, type Range } from './shared'

const router = Router()
type Channel = 'LOCAL' | 'EXPRESS'
const channelSchema = z.object({ channel: z.enum(['ALL', 'LOCAL', 'EXPRESS']).optional() })

async function kpiOf(r: Range) {
  const agg = await prisma.order.aggregate({
    where: paidOrdersWhere(r),
    _count: { _all: true },
    _sum: { actualAmount: true, refundedAmount: true },
  })
  const orderCount = agg._count._all
  const revenueFen = agg._sum.actualAmount ?? 0
  return {
    orderCount,
    revenueFen,
    refundFen: agg._sum.refundedAmount ?? 0,
    avgOrderFen: orderCount ? Math.round(revenueFen / orderCount) : 0,
  }
}

// GET /api/admin/stats/overview?startDate&endDate&channel=ALL|LOCAL|EXPRESS
router.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cur, prev } = parseRange(req.query)
    const ch = channelSchema.parse(req.query).channel ?? 'ALL'
    const hotChannel: Channel | undefined = ch === 'ALL' ? undefined : ch

    const [kpi, prevKpi, byChannel, rows, userRows] = await Promise.all([
      kpiOf(cur),
      kpiOf(prev),
      prisma.order.groupBy({
        by: ['deliveryType'],
        where: paidOrdersWhere(cur),
        _count: { _all: true },
        _sum: { actualAmount: true },
      }),
      // 趋势与时段分布共用一次查询：按渠道 × 上海小时桶聚合，JS 侧再折成日 / 小时
      prisma.$queryRaw<{ dt: string; y: number; mo: number; d: number; h: number; cnt: bigint; amt: bigint | null }[]>`
        SELECT delivery_type dt, ${localDayPartsSql('paid_at')}, COUNT(*) cnt, SUM(actual_amount) amt
        FROM orders
        WHERE paid_at >= ${cur.start} AND paid_at < ${cur.endExclusive}
          ${realOrdersSql()}
        GROUP BY dt, ${LOCAL_DAY_GROUP_BY}`,
      prisma.order.groupBy({ by: ['userId'], where: paidOrdersWhere(cur) }),
    ])

    const channels = { LOCAL: { orderCount: 0, revenueFen: 0 }, EXPRESS: { orderCount: 0, revenueFen: 0 } }
    for (const g of byChannel) {
      if (g.deliveryType === 'LOCAL' || g.deliveryType === 'EXPRESS') {
        channels[g.deliveryType] = { orderCount: g._count._all, revenueFen: g._sum.actualAmount ?? 0 }
      }
    }

    const byDay = new Map<string, { LOCAL: { orderCount: number; revenueFen: number }; EXPRESS: { orderCount: number; revenueFen: number } }>()
    const hourly = new Array<number>(24).fill(0)
    for (const r of rows) {
      const key = localDayKeyFromParts(r)
      const acc = byDay.get(key) ?? { LOCAL: { orderCount: 0, revenueFen: 0 }, EXPRESS: { orderCount: 0, revenueFen: 0 } }
      const c = r.dt === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
      acc[c].orderCount += Number(r.cnt)
      acc[c].revenueFen += Number(r.amt ?? 0)
      byDay.set(key, acc)
      hourly[localHourFromParts(r)] += Number(r.cnt)
    }
    const trend: { date: string; LOCAL: { orderCount: number; revenueFen: number }; EXPRESS: { orderCount: number; revenueFen: number } }[] = []
    for (const d = new Date(cur.start); d < cur.endExclusive; d.setDate(d.getDate() + 1)) {
      const key = localDayKey(d)
      trend.push({ date: key, ...(byDay.get(key) ?? { LOCAL: { orderCount: 0, revenueFen: 0 }, EXPRESS: { orderCount: 0, revenueFen: 0 } }) })
    }

    // 新客 = 该用户历史第一张已付单落在本期
    const userIds = userRows.map((u) => u.userId)
    const firstPaid = userIds.length
      ? await prisma.order.groupBy({
          by: ['userId'],
          where: { ...REAL_ORDERS, userId: { in: userIds }, paidAt: { not: null } },
          _min: { paidAt: true },
        })
      : []
    const newUsers = firstPaid.filter((f) => f._min.paidAt && f._min.paidAt >= cur.start).length
    const users = userIds.length
    const customers = {
      users,
      newUsers,
      returningUsers: users - newUsers,
      repeatRate: users ? (users - newUsers) / users : null,
    }

    // 热销榜按 order_items 聚合（不再读 Product.salesCount 冗余列，测试单自然排除）
    const hot = await prisma.orderItem.groupBy({
      by: ['productId'],
      where: { isGift: false, productId: { not: null }, order: paidOrdersWhere(cur, hotChannel) },
      _sum: { quantity: true, subtotal: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5,
    })
    const hotIds = hot.map((h) => h.productId!).filter((id) => id != null)
    const names = hotIds.length
      ? await prisma.orderItem.findMany({
          where: { productId: { in: hotIds } },
          orderBy: { id: 'desc' },
          distinct: ['productId'],
          select: { productId: true, productName: true },
        })
      : []
    const nameOf = new Map(names.map((n) => [n.productId, n.productName]))
    const hotProducts = hot.map((h) => ({
      productId: h.productId!,
      name: nameOf.get(h.productId!) ?? `#${h.productId}`,
      qty: h._sum.quantity ?? 0,
      revenueFen: h._sum.subtotal ?? 0,
    }))

    success(res, {
      range: rangeOut(cur, prev),
      kpi: { ...kpi, prev: prevKpi },
      channels,
      trend,
      hourly,
      customers,
      hotProducts,
    })
  } catch (e) {
    next(e)
  }
})

export default router
```

- [ ] **Step 4: 挂到 `index.ts`**

```ts
import overviewRouter from './overview'
// …
router.use(overviewRouter)
```

**顺序注意**：`legacyRouter` 里有 `router.get('/')` 与 `/trend`，新路由是 `/overview` 等具体路径，互不冲突，谁先谁后都行。

- [ ] **Step 5: 编译 + §54**

Run: `npm run build --workspace=apps/server && BASE=http://localhost:3105 DB_NAME=food_shop_audit bash scripts/e2e.sh 2>&1 | sed -n '/== 54\./,/^汇总\|PASS=/p'`
Expected: B 段 13 条全绿。若 `prisma.orderItem.groupBy` 的 `where.order` 关系过滤报类型错，改成两步：先 `prisma.order.findMany({ where: paidOrdersWhere(cur, hotChannel), select: { id: true } })` 取 id 列表，再 `where: { orderId: { in: ids } }`。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/admin/stats scripts/e2e.d/54-dashboard-stats.sh
git commit -m "经营统计：GET /admin/stats/overview（KPI/渠道/趋势/时段/新老客/热销榜按 order_items）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `GET /admin/stats/local`

**Files:**
- Create: `apps/server/src/routes/admin/stats/local.ts`
- Modify: `apps/server/src/routes/admin/stats/index.ts`
- Test: `scripts/e2e.d/54-dashboard-stats.sh` §54-C

**Interfaces:**
- Consumes: Task 1 的 `parseRange/paidOrdersWhere/percentile/median/minutesBetween/rangeOut`
- Produces: 响应结构见 spec §4 `local`

- [ ] **Step 1: 写 e2e §54-C**

```bash
# ── C. local：同城单走到送达，运费账 / 时效 / 承运商 / 阶梯都要动 ──
C0=$(d54 local)
C_CNT=$(jq -r .data.kpi.orderCount <<<"$C0"); C_PAID=$(jq -r .data.freight.customerPaidFen <<<"$C0")
C_DEL=$(jq -r .data.freight.deliveryFen <<<"$C0"); C_TOTN=$(jq -r '[.data.timing.stages[]|select(.key=="total")][0].n' <<<"$C0")
C_LAD=$(jq -r '.data.ladder | (.first + .cheapestN + .all)' <<<"$C0")
C_SS=$(jq -r '[.data.providers[]|select(.provider=="shansongtongcheng")][0].count // 0' <<<"$C0")
CO=$(mk_local_paid); [[ -n "$CO" ]] && ok "C 造已付同城单 #$CO" || fail "C 造单"
req POST "/api/admin/local/orders/$CO/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$CO/call" "$AT"); CD=$(jq -r .data.deliveryNo <<<"$R")
CT=$(req GET "/api/admin/local/orders/$CO/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
NOW54=$(date '+%F %H:%M')
kd_cb "$CD" "$CT" 100 '骑手已接单' "$NOW54:01" >/dev/null
kd_cb "$CD" "$CT" 310 '骑手已取货' "$NOW54:02" >/dev/null
kd_cb "$CD" "$CT" 520 '已送达' "$NOW54:03" >/dev/null
assert_eq "C 前置：订单已 COMPLETED" "$(order_status $CO)" "COMPLETED"
CO_SHIP=$(req GET "/api/admin/orders/$CO" "$AT" | jq -r .data.shippingFee)
CO_FEE=$(req GET "/api/admin/local/orders/$CO/delivery" "$AT" | jq -r '.data.delivery | (.actualFee // .quotedFee)')
C1=$(d54 local)
assert_eq "C① 同城单数 +1" "$(jq -r .data.kpi.orderCount <<<"$C1")" "$((C_CNT+1))"
assert_eq "C② 顾客付运费 +本单运费" "$(jq -r .data.freight.customerPaidFen <<<"$C1")" "$((C_PAID+CO_SHIP))"
assert_eq "C③ 付给骑手·配送费 +本单实扣" "$(jq -r .data.freight.deliveryFen <<<"$C1")" "$((C_DEL+CO_FEE))"
assert_eq "C④ 运费差额 = 顾客付 − 骑手合计" "$(jq -r '.data.freight | (.customerPaidFen - .riderTotalFen)' <<<"$C1")" "$(jq -r .data.freight.netFen <<<"$C1")"
assert_eq "C⑤ 时效 total 样本 +1" "$(jq -r '[.data.timing.stages[]|select(.key=="total")][0].n' <<<"$C1")" "$((C_TOTN+1))"
assert_eq "C⑥ 时效 5 个阶段齐全" "$(jq -r '.data.timing.stages | length' <<<"$C1")" "5"
assert_eq "C⑦ 承运商 闪送 +1" "$(jq -r '[.data.providers[]|select(.provider=="shansongtongcheng")][0].count // 0' <<<"$C1")" "$((C_SS+1))"
assert_eq "C⑧ 呼叫阶梯三项之和 +1" "$(jq -r '.data.ladder | (.first + .cheapestN + .all)' <<<"$C1")" "$((C_LAD+1))"
assert_eq "C⑨ 距离分布之和 = 同城单数" "$(jq -r '[.data.distance[].count] | add' <<<"$C1")" "$((C_CNT+1))"
```

> `kd_cb` 默认 `kuaidicom=shansongtongcheng`，中标运力就是闪送，所以 C⑦ 看闪送。若 §50 已把策略改成别的运力名，以 `/delivery` 里的 `.data.delivery.provider` 为准动态取。

- [ ] **Step 2: 跑 §54 确认 C 段红**

- [ ] **Step 3: 写 `local.ts`**

```ts
import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../../utils/prisma'
import { success } from '../../../utils/response'
import { parseRange, paidOrdersWhere, percentile, median, minutesBetween, rangeOut, type Range } from './shared'

const router = Router()
const SAMPLE_CAP = 2000

const STAGES = [
  { key: 'acceptToCall', label: '接单→呼叫' },
  { key: 'callToRider', label: '呼叫→骑手接单' },
  { key: 'riderToPickup', label: '骑手接单→取货' },
  { key: 'pickupToDone', label: '取货→送达' },
  { key: 'total', label: '下单→送达' },
] as const
type StageKey = (typeof STAGES)[number]['key']

/** 一次拉齐本期同城单与它们的全部配送单，所有数字在 JS 侧算（本店日单量两位数，92 天也不到封顶） */
async function localBlock(r: Range) {
  const orders = await prisma.order.findMany({
    where: paidOrdersWhere(r, 'LOCAL'),
    select: { id: true, status: true, paidAt: true, acceptedAt: true, shippingFee: true, actualAmount: true, distanceM: true, cancelRequestedAt: true },
    take: SAMPLE_CAP,
    orderBy: { paidAt: 'desc' },
  })
  const ids = orders.map((o) => o.id)
  const deliveries = ids.length
    ? await prisma.delivery.findMany({
        where: { orderId: { in: ids } },
        select: { orderId: true, status: true, provider: true, callStrategy: true, quotedFee: true, actualFee: true, tipFee: true, cancelFee: true, calledAt: true, acceptedAt: true, pickedUpAt: true, deliveredAt: true },
      })
    : []

  // KPI
  const orderCount = orders.length
  const revenueFen = orders.reduce((s, o) => s + o.actualAmount, 0)
  const withDist = orders.filter((o) => o.distanceM != null)
  const avgDistanceM = withDist.length ? Math.round(withDist.reduce((s, o) => s + o.distanceM!, 0) / withDist.length) : null
  const freeShipCount = orders.filter((o) => o.shippingFee === 0).length
  const kpi = { orderCount, revenueFen, avgDistanceM, freeShipCount, freeShipRate: orderCount ? freeShipCount / orderCount : null }

  // 运费账
  const fee = (d: { actualFee: number | null; quotedFee: number | null }) => d.actualFee ?? d.quotedFee ?? 0
  const customerPaidFen = orders.reduce((s, o) => s + o.shippingFee, 0)
  const deliveryFen = deliveries.filter((d) => d.status === 'DELIVERED').reduce((s, d) => s + fee(d), 0)
  const tipFen = deliveries.reduce((s, d) => s + d.tipFee, 0)
  const cancelFen = deliveries.filter((d) => d.status === 'CANCELLED').reduce((s, d) => s + d.cancelFee, 0)
  const riderTotalFen = deliveryFen + tipFen + cancelFen
  const freight = { customerPaidFen, deliveryFen, tipFen, cancelFen, riderTotalFen, netFen: customerPaidFen - riderTotalFen }

  // 时效：已完成单 × 它那张 DELIVERED 配送单
  const deliveredByOrder = new Map<number, (typeof deliveries)[number]>()
  for (const d of deliveries) if (d.status === 'DELIVERED' && !deliveredByOrder.has(d.orderId)) deliveredByOrder.set(d.orderId, d)
  const samples: Record<StageKey, number[]> = { acceptToCall: [], callToRider: [], riderToPickup: [], pickupToDone: [], total: [] }
  for (const o of orders) {
    if (o.status !== 'COMPLETED') continue
    const d = deliveredByOrder.get(o.id)
    if (!d) continue
    const push = (k: StageKey, v: number | null) => { if (v != null && v >= 0) samples[k].push(v) }
    push('acceptToCall', minutesBetween(o.acceptedAt, d.calledAt))
    push('callToRider', minutesBetween(d.calledAt, d.acceptedAt))
    push('riderToPickup', minutesBetween(d.acceptedAt, d.pickedUpAt))
    push('pickupToDone', minutesBetween(d.pickedUpAt, d.deliveredAt))
    push('total', minutesBetween(o.paidAt, d.deliveredAt))
  }
  const timing = { stages: STAGES.map((s) => ({ key: s.key, label: s.label, medianMin: median(samples[s.key]), p90Min: percentile(samples[s.key], 0.9), n: samples[s.key].length })) }

  // 承运商（只看送达的那张）
  const byProvider = new Map<string, { count: number; feeSum: number; pickup: number[] }>()
  for (const d of deliveries) {
    if (d.status !== 'DELIVERED') continue
    const acc = byProvider.get(d.provider) ?? { count: 0, feeSum: 0, pickup: [] }
    acc.count += 1
    acc.feeSum += fee(d)
    const pm = minutesBetween(d.calledAt, d.pickedUpAt)
    if (pm != null && pm >= 0) acc.pickup.push(pm)
    byProvider.set(d.provider, acc)
  }
  const providers = [...byProvider.entries()]
    .map(([provider, a]) => ({ provider, count: a.count, avgFeeFen: Math.round(a.feeSum / a.count), avgPickupMin: a.pickup.length ? Math.round(a.pickup.reduce((x, y) => x + y, 0) / a.pickup.length) : null }))
    .sort((a, b) => b.count - a.count)

  // 呼叫阶梯：一单可能呼叫多次，看它走到最高哪一级
  const ladder = { first: 0, cheapestN: 0, all: 0 }
  const strategiesByOrder = new Map<number, Set<string>>()
  for (const d of deliveries) {
    if (!d.callStrategy) continue
    const s = d.callStrategy.replace(/_HELD$/, '')
    ;(strategiesByOrder.get(d.orderId) ?? strategiesByOrder.set(d.orderId, new Set()).get(d.orderId)!).add(s)
  }
  for (const set of strategiesByOrder.values()) {
    if (set.has('ALL')) ladder.all += 1
    else if (set.has('CHEAPEST')) ladder.cheapestN += 1
    else ladder.first += 1
  }

  // 距离分布
  const distance = [
    { label: '≤2km', count: orders.filter((o) => o.distanceM != null && o.distanceM <= 2000).length },
    { label: '2–5km', count: orders.filter((o) => o.distanceM != null && o.distanceM > 2000 && o.distanceM <= 5000).length },
    { label: '>5km', count: orders.filter((o) => o.distanceM != null && o.distanceM > 5000).length },
    { label: '未知', count: orders.filter((o) => o.distanceM == null).length },
  ]

  const cancels = {
    requested: orders.filter((o) => o.cancelRequestedAt != null).length,
    deliveryCancelled: deliveries.filter((d) => d.status === 'CANCELLED').length,
  }

  return { kpi, freight, timing, providers, ladder, distance, cancels }
}

// GET /api/admin/stats/local?startDate&endDate
router.get('/local', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cur, prev } = parseRange(req.query)
    const [c, p] = await Promise.all([localBlock(cur), localBlock(prev)])
    success(res, {
      range: rangeOut(cur, prev),
      kpi: { ...c.kpi, prev: p.kpi },
      freight: { ...c.freight, prev: { customerPaidFen: p.freight.customerPaidFen, riderTotalFen: p.freight.riderTotalFen, netFen: p.freight.netFen } },
      timing: c.timing,
      providers: c.providers,
      ladder: c.ladder,
      distance: c.distance,
      cancels: c.cancels,
    })
  } catch (e) {
    next(e)
  }
})

export default router
```

- [ ] **Step 4: 挂到 `index.ts`**（`import localRouter from './local'` / `router.use(localRouter)`）

- [ ] **Step 5: 编译 + §54**

Run: `npm run build --workspace=apps/server && BASE=http://localhost:3105 DB_NAME=food_shop_audit bash scripts/e2e.sh 2>&1 | sed -n '/== 54\./,/^汇总\|PASS=/p'`
Expected: C 段全绿。若 C③ 差一笔：mock 回调认领 `actualFee` 的条件在 `services/delivery/callback.ts:207` 附近，查 `/delivery` 返回里 `actualFee` 是否为 null 再定——`fee()` 的 `actualFee ?? quotedFee` 与 `routes/admin/delivery.ts:185` 同口径。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/admin/stats scripts/e2e.d/54-dashboard-stats.sh
git commit -m "经营统计：GET /admin/stats/local（运费账/时效分位/承运商/呼叫阶梯/距离分布）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `GET /admin/stats/express` + 测试单隔离断言 + 文档

**Files:**
- Create: `apps/server/src/routes/admin/stats/express.ts`
- Modify: `apps/server/src/routes/admin/stats/index.ts`
- Modify: `docs/api.md` §3.7
- Test: `scripts/e2e.d/54-dashboard-stats.sh` §54-D/E

**Interfaces:**
- Consumes: Task 1 的 `parseRange/paidOrdersWhere/percentile/median/rangeOut`
- Produces: spec §4 `express`

- [ ] **Step 1: 写 e2e §54-D/E**

```bash
# ── D. express：B 段那张邮寄单还没发货 → 待发货积压里有它 ──
D1=$(d54 express)
assert_eq "D① 邮寄单数含 B 段那单" "$(jq -r '.data.kpi.orderCount >= 1' <<<"$D1")" "true"
[[ "$(jq -r .data.backlog.count <<<"$D1")" -ge 1 ]] && ok "D② 待发货积压 ≥1" || fail "D② 积压" "$D1"
assert_eq "D③ 积压最久单有单号" "$(jq -r '.data.backlog.oldestOrderNo | type' <<<"$D1")" "string"
assert_eq "D④ 运费收入 = Σ shippingFee（非负整数）" "$(jq -r '.data.kpi.shippingFeeFen >= 0' <<<"$D1")" "true"
assert_eq "D⑤ 快递公司分布是数组" "$(jq -r '.data.companies | type' <<<"$D1")" "array"
assert_eq "D⑥ 收件地 Top ≤5" "$(jq -r '.data.regions | length <= 5' <<<"$D1")" "true"

# ── E. 测试单隔离：三接口都必须真的变小（§33 同款） ──
E_O=$(d54 overview | jq -r .data.kpi.orderCount); E_L=$(d54 local | jq -r .data.kpi.orderCount); E_E=$(d54 express | jq -r .data.kpi.orderCount)
req PATCH "/api/admin/orders/$BO/test-flag" "$AT" '{"isTest":true}' >/dev/null
req PATCH "/api/admin/orders/$CO/test-flag" "$AT" '{"isTest":true}' >/dev/null
assert_eq "E① overview −2" "$(d54 overview | jq -r .data.kpi.orderCount)" "$((E_O-2))"
assert_eq "E② local −1" "$(d54 local | jq -r .data.kpi.orderCount)" "$((E_L-1))"
assert_eq "E③ express −1" "$(d54 express | jq -r .data.kpi.orderCount)" "$((E_E-1))"
assert_eq "E④ 热销榜不含测试单（回到 B 段前）" "$(d54 overview | jq -r --argjson p "$PID" '[.data.hotProducts[]|select(.productId==$p)][0].qty // 0')" "$B_HOT"
req PATCH "/api/admin/orders/$BO/test-flag" "$AT" '{"isTest":false}' >/dev/null
req PATCH "/api/admin/orders/$CO/test-flag" "$AT" '{"isTest":false}' >/dev/null
assert_eq "E⑤ 取消标记后 overview 回来" "$(d54 overview | jq -r .data.kpi.orderCount)" "$E_O"
```

- [ ] **Step 2: 跑 §54 确认 D 段红**

- [ ] **Step 3: 写 `express.ts`**

```ts
import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../../utils/prisma'
import { success } from '../../../utils/response'
import { REAL_ORDERS } from '../../../utils/stats-scope'
import { parseRange, paidOrdersWhere, percentile, median, rangeOut, type Range } from './shared'

const router = Router()
const SAMPLE_CAP = 2000

async function expressBlock(r: Range) {
  const orders = await prisma.order.findMany({
    where: paidOrdersWhere(r, 'EXPRESS'),
    select: { id: true, paidAt: true, actualAmount: true, shippingFee: true, refundedAmount: true, receiverProvince: true, shipment: { select: { shippedAt: true, expressCompany: true } } },
    take: SAMPLE_CAP,
    orderBy: { paidAt: 'desc' },
  })
  const orderCount = orders.length
  const kpi = {
    orderCount,
    revenueFen: orders.reduce((s, o) => s + o.actualAmount, 0),
    shippingFeeFen: orders.reduce((s, o) => s + o.shippingFee, 0),
  }
  const hoursToShip = orders
    .filter((o) => o.paidAt && o.shipment?.shippedAt)
    .map((o) => (o.shipment!.shippedAt!.getTime() - o.paidAt!.getTime()) / 3600000)
    .filter((h) => h >= 0)
  const shipTiming = { medianHours: median(hoursToShip), p90Hours: percentile(hoursToShip, 0.9), n: hoursToShip.length }

  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)
  const comp = new Map<string, number>()
  const prov = new Map<string, number>()
  for (const o of orders) {
    if (o.shipment?.shippedAt) count(comp, o.shipment.expressCompany?.trim() || '未填')
    count(prov, o.receiverProvince || '未知')
  }
  const companies = [...comp.entries()].map(([name, c]) => ({ name, count: c })).sort((a, b) => b.count - a.count)
  const regions = [...prov.entries()].map(([province, c]) => ({ province, count: c })).sort((a, b) => b.count - a.count).slice(0, 5)

  const refunded = orders.filter((o) => o.refundedAmount > 0)
  const afterSaleCount = orderCount ? await prisma.afterSale.count({ where: { orderId: { in: orders.map((o) => o.id) } } }) : 0
  const afterSales = { refundCount: refunded.length, refundFen: refunded.reduce((s, o) => s + o.refundedAmount, 0), afterSaleCount }

  return { kpi, shipTiming, companies, regions, afterSales }
}

// GET /api/admin/stats/express?startDate&endDate
router.get('/express', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cur, prev } = parseRange(req.query)
    const [c, p, backlogRows] = await Promise.all([
      expressBlock(cur),
      expressBlock(prev),
      // 待发货积压是「当前」的事，不受时间范围影响
      prisma.order.findMany({
        where: { ...REAL_ORDERS, deliveryType: 'EXPRESS', status: { in: ['PAID', 'PREPARING'] } },
        select: { orderNo: true, paidAt: true },
        orderBy: { paidAt: 'asc' },
      }),
    ])
    const oldest = backlogRows[0]
    const backlog = {
      count: backlogRows.length,
      oldestHours: oldest?.paidAt ? Math.floor((Date.now() - oldest.paidAt.getTime()) / 3600000) : null,
      oldestOrderNo: oldest?.orderNo ?? null,
    }
    success(res, {
      range: rangeOut(cur, prev),
      kpi: { ...c.kpi, prev: p.kpi },
      backlog,
      shipTiming: c.shipTiming,
      companies: c.companies,
      regions: c.regions,
      afterSales: c.afterSales,
    })
  } catch (e) {
    next(e)
  }
})

export default router
```

- [ ] **Step 4: 挂到 `index.ts`**，最终文件：

```ts
import { Router } from 'express'
import legacyRouter from './legacy'
import overviewRouter from './overview'
import localRouter from './local'
import expressRouter from './express'

const router = Router()
// 老接口：GET / 与 GET /trend（e2e §33 在用；口径已与下面三个统一）
router.use(legacyRouter)
// 新概览页：三个 tab 各一个接口，共用 shared.ts 的区间与订单口径
router.use(overviewRouter)
router.use(localRouter)
router.use(expressRouter)
export default router
```

- [ ] **Step 5: 编译 + 全量 e2e**

Run: `npm run build --workspace=apps/server && BASE=http://localhost:3105 DB_NAME=food_shop_audit bash scripts/e2e.sh 2>&1 | tail -4`
Expected: 全绿，总数 = 1199 + §54 的条数（A2 + B13 + C10 + D6 + E5 = 36 → **1235 / 0**；实际以脚本汇总为准，红必须为 0）。

- [ ] **Step 6: `docs/api.md` §3.7**

在 `#### GET /api/admin/stats` 之前加一段：

```markdown
> 口径（2026-09-08 起）：所有经营统计按**付款日**归属（`paid_at` 落在区间，上海自然日），
> 状态不限、排除测试单（`is_test`）。区间参数 `startDate`/`endDate`（`YYYY-MM-DD`，含端，默认近 7 天，最长 92 天）。
> 每个接口返回 `range.{startDate,endDate,prevStartDate,prevEndDate}`，`prev` 为紧挨在前的等长区间。金额单位分。

#### GET /api/admin/stats/overview?startDate&endDate&channel=ALL|LOCAL|EXPRESS
总览：`kpi{revenueFen,refundFen,orderCount,avgOrderFen,prev}`、`channels{LOCAL,EXPRESS}{orderCount,revenueFen}`、
`trend[{date,LOCAL,EXPRESS}]`、`hourly[24]`、`customers{users,newUsers,returningUsers,repeatRate}`、
`hotProducts[{productId,name,qty,revenueFen}]`（按 order_items 聚合、排除赠品；只有它受 `channel` 影响）。

#### GET /api/admin/stats/local?startDate&endDate
同城：`kpi{orderCount,revenueFen,avgDistanceM,freeShipCount,freeShipRate,prev}`、
`freight{customerPaidFen,deliveryFen,tipFen,cancelFen,riderTotalFen,netFen,prev}`（netFen<0 = 补贴）、
`timing.stages[{key,label,medianMin,p90Min,n}]`（acceptToCall/callToRider/riderToPickup/pickupToDone/total）、
`providers[{provider,count,avgFeeFen,avgPickupMin}]`（avgPickupMin = 呼叫→取货）、`ladder{first,cheapestN,all}`、
`distance[{label,count}]`、`cancels{requested,deliveryCancelled}`。

#### GET /api/admin/stats/express?startDate&endDate
邮寄：`kpi{orderCount,revenueFen,shippingFeeFen,prev}`、`backlog{count,oldestHours,oldestOrderNo}`（**实时**，不受区间影响）、
`shipTiming{medianHours,p90Hours,n}`、`companies[{name,count}]`、`regions[{province,count}]`（Top 5）、
`afterSales{refundCount,refundFen,afterSaleCount}`。
```

并把老接口说明里加一句「`today.*` 与 `/trend` 同为付款日口径」。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/admin/stats scripts/e2e.d/54-dashboard-stats.sh docs/api.md
git commit -m "经营统计：GET /admin/stats/express（待发货积压/发货时效/快递公司/地区）+ 三接口测试单隔离断言 + 文档

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 前端基础件：类型 / API / `useIsPhone` / `format.ts` / `KpiCard` / `RangePicker` / `StackedBars`

**Files:**
- Create: `apps/admin/src/hooks/useIsPhone.ts`
- Modify: `apps/admin/src/pages/Workbench.tsx:43-55`（删本地定义，改 import）
- Create: `apps/admin/src/components/dashboard/format.ts`
- Create: `apps/admin/src/components/dashboard/KpiCard.tsx`
- Create: `apps/admin/src/components/dashboard/RangePicker.tsx`
- Create: `apps/admin/src/components/dashboard/StackedBars.tsx`
- Modify: `apps/admin/src/types.ts`（追加）
- Modify: `apps/admin/src/api/admin.ts`（追加）

**Interfaces:**
- Produces:
  ```ts
  // hooks/useIsPhone.ts
  export function useIsPhone(): boolean
  // format.ts
  export const fen = (v: number | null | undefined, digits = 2) => string   // '¥1,234.50'；null → '—'
  export const pct = (v: number | null | undefined) => string               // 0.412 → '41.2%'；null → '—'
  export const minutes = (v: number | null) => string                      // 42 → '42 分'；null → '—'
  export const hours = (v: number | null) => string                        // 6 → '6 小时'
  export const km = (m: number | null) => string                           // 2400 → '2.4 km'
  // KpiCard
  <KpiCard label value sub? prev? tone? deltaTone? />   // prev 为数字时显示较上期
  // RangePicker
  <RangePicker value={{startDate,endDate}} onChange={(r)=>void} />
  // StackedBars
  <StackedBars labels={string[]} series={{name,color,values:number[]}[]} valueFormatter? height? />
  ```

- [ ] **Step 1: `hooks/useIsPhone.ts`**

```ts
import { useEffect, useState } from 'react'

const PHONE_QUERY = '(max-width: 700px)'

/** ≤700px 视为手机（工作台与经营概览共用同一分界） */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY)
    const onChange = (e: MediaQueryListEvent) => setPhone(e.matches)
    mq.addEventListener('change', onChange)
    setPhone(mq.matches) // 挂载与首帧之间可能已经转过屏
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return phone
}
```

在 `pages/Workbench.tsx` 删掉本地 `PHONE_QUERY` 与 `function useIsPhone()`（第 43–55 行附近），加 `import { useIsPhone } from '../hooks/useIsPhone'`。若 `PHONE_QUERY` 在该文件其他处还有引用，改成从 hook 文件 `export const PHONE_QUERY` 并 import。

- [ ] **Step 2: `format.ts`**

```ts
const nf = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const fen = (v: number | null | undefined, digits: 0 | 2 = 2): string =>
  v == null ? '—' : `¥${digits === 0 ? Math.round(v / 100).toLocaleString('zh-CN') : nf.format(v / 100)}`
export const pct = (v: number | null | undefined): string => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
export const minutes = (v: number | null | undefined): string => (v == null ? '—' : `${v} 分`)
export const hours = (v: number | null | undefined): string => (v == null ? '—' : `${v} 小时`)
export const km = (m: number | null | undefined): string => (m == null ? '—' : `${(m / 1000).toFixed(1)} km`)
```

- [ ] **Step 3: `KpiCard.tsx`**

```tsx
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'

interface Props {
  label: string
  value: string
  /** 主值下面的一行小字（如「退款后 ¥…」「占比 32%」） */
  sub?: string
  /** 本期与上期的原始数；都传了才显示「较上期」 */
  cur?: number | null
  prev?: number | null
  /** 上升是好事（实收/单数）还是坏事（退款）；默认 up-good */
  deltaTone?: 'up-good' | 'up-bad'
}

export default function KpiCard({ label, value, sub, cur, prev, deltaTone = 'up-good' }: Props) {
  let delta: { text: string; up: boolean } | null = null
  if (cur != null && prev != null) {
    if (prev === 0) delta = cur === 0 ? null : { text: '较上期 —', up: cur > 0 }
    else {
      const r = (cur - prev) / prev
      delta = { text: `较上期 ${r >= 0 ? '+' : ''}${(r * 100).toFixed(0)}%`, up: r >= 0 }
    }
  }
  const good = delta ? (deltaTone === 'up-good' ? delta.up : !delta.up) : true
  return (
    <div className="bg-white rounded-lg shadow-card p-4 min-w-0">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-800 mt-1 truncate">{value}</p>
      <div className="mt-1 flex items-center gap-2 text-xs min-h-[1rem]">
        {sub && <span className="text-gray-500 truncate">{sub}</span>}
        {delta && (
          <span className={`inline-flex items-center gap-0.5 ${good ? 'text-green-600' : 'text-red-500'}`}>
            {delta.up ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {delta.text}
          </span>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: `RangePicker.tsx`**

```tsx
import { todayKey, shiftDayKey } from '../../utils/time'

export interface DateRange { startDate: string; endDate: string }

export const QUICK = [
  { key: 'today', label: '今日', range: () => ({ startDate: todayKey(), endDate: todayKey() }) },
  { key: 'yesterday', label: '昨日', range: () => ({ startDate: shiftDayKey(-1), endDate: shiftDayKey(-1) }) },
  { key: '7d', label: '近 7 天', range: () => ({ startDate: shiftDayKey(-6), endDate: todayKey() }) },
  { key: '30d', label: '近 30 天', range: () => ({ startDate: shiftDayKey(-29), endDate: todayKey() }) },
] as const
export type QuickKey = (typeof QUICK)[number]['key']

export const MAX_DAYS = 92

/** 两个 YYYY-MM-DD 之间的天数（含端）；纯字符串算，不经本地时区 */
export function spanDays(r: DateRange): number {
  const [a, b] = [r.startDate, r.endDate].map((s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)))
  return Math.round((b - a) / 86400000) + 1
}
export const rangeError = (r: DateRange): string | null =>
  !r.startDate || !r.endDate ? '请选完整的起止日期'
  : r.endDate < r.startDate ? '结束日期早于开始日期'
  : spanDays(r) > MAX_DAYS ? `最多查 ${MAX_DAYS} 天`
  : null

/** 当前值命中哪个快捷项（用来高亮）；自定义则 null */
export function matchQuick(r: DateRange): QuickKey | null {
  for (const q of QUICK) { const x = q.range(); if (x.startDate === r.startDate && x.endDate === r.endDate) return q.key }
  return null
}

export default function RangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const active = matchQuick(value)
  const err = rangeError(value)
  return (
    <div className="bg-white rounded-lg shadow-card p-3 flex flex-wrap items-center gap-3">
      <div className="flex rounded-md border border-gray-200 overflow-hidden">
        {QUICK.map((q) => (
          <button key={q.key} type="button" onClick={() => onChange(q.range())}
            className={`px-3 py-1.5 text-sm transition-colors ${active === q.key ? 'bg-brand-500 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
            {q.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <input type="date" value={value.startDate} onChange={(e) => onChange({ ...value, startDate: e.target.value })} className="border border-gray-200 rounded-md px-2 py-1.5" />
        <span>至</span>
        <input type="date" value={value.endDate} onChange={(e) => onChange({ ...value, endDate: e.target.value })} className="border border-gray-200 rounded-md px-2 py-1.5" />
      </div>
      {err && <span className="text-xs text-red-500">{err}</span>}
    </div>
  )
}
```

- [ ] **Step 5: `StackedBars.tsx`**

```tsx
import { useMemo, useState } from 'react'

export interface BarSeries { name: string; color: string; values: number[] }

interface Props {
  labels: string[]
  series: BarSeries[]            // 1–2 个；values 长度 = labels 长度
  height?: number
  valueFormatter?: (v: number) => string
  /** x 轴标签最多显示几个（多了会挤），均匀抽样 */
  maxXLabels?: number
}

/** 手写 SVG 堆叠柱。与 ui/TrendChart 并存：那个是单系列折线/柱，扫码统计在用，不动它。 */
export default function StackedBars({ labels, series, height = 220, valueFormatter = (v) => String(v), maxXLabels = 12 }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 720, H = height
  const PAD = { top: 16, right: 12, bottom: 28, left: 48 }
  const iw = W - PAD.left - PAD.right, ih = H - PAD.top - PAD.bottom
  const n = labels.length

  const { max, ticks } = useMemo(() => {
    const totals = labels.map((_, i) => series.reduce((s, sr) => s + (sr.values[i] ?? 0), 0))
    const rawMax = Math.max(1, ...totals)
    const mag = Math.pow(10, Math.floor(Math.log10(rawMax)))
    const nice = [1, 2, 5, 10].map((k) => k * mag).find((k) => k >= rawMax) ?? rawMax
    return { max: nice, ticks: [0, 0.5, 1].map((r) => ({ y: PAD.top + ih * (1 - r), v: nice * r })) }
  }, [labels, series, ih])

  if (!n) return <div className="text-sm text-gray-400 text-center py-8">暂无数据</div>
  const slot = iw / n
  const bw = Math.max(2, slot * 0.6)
  const labelEvery = Math.max(1, Math.ceil(n / maxXLabels))

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t.v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} stroke="#e5e7eb" strokeDasharray="3 3" />
            <text x={PAD.left - 6} y={t.y + 4} fontSize="11" fill="#9ca3af" textAnchor="end">{valueFormatter(t.v)}</text>
          </g>
        ))}
        {labels.map((lb, i) => {
          const x = PAD.left + i * slot + (slot - bw) / 2
          let yTop = PAD.top + ih
          return (
            <g key={lb} onMouseEnter={() => setHover(i)}>
              <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={ih} fill={hover === i ? '#f3f4f6' : 'transparent'} />
              {series.map((sr) => {
                const v = sr.values[i] ?? 0
                const h = (v / max) * ih
                yTop -= h
                return <rect key={sr.name} x={x} y={yTop} width={bw} height={h} fill={sr.color} rx={1} />
              })}
              {i % labelEvery === 0 && (
                <text x={PAD.left + i * slot + slot / 2} y={H - 8} fontSize="11" fill="#6b7280" textAnchor="middle">{lb}</text>
              )}
            </g>
          )
        })}
      </svg>
      {hover != null && (
        <div className="pointer-events-none absolute top-2 right-2 bg-gray-900/90 text-white text-xs rounded px-2 py-1 space-y-0.5">
          <div className="text-gray-300">{labels[hover]}</div>
          {series.map((sr) => (
            <div key={sr.name} className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: sr.color }} />
              {sr.name} {valueFormatter(sr.values[hover] ?? 0)}
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex gap-4 text-xs text-gray-500">
        {series.map((sr) => (
          <span key={sr.name} className="inline-flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: sr.color }} />{sr.name}</span>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 6: `types.ts` 追加**

```ts
// ── 经营概览（spec 2026-09-08） ──
export interface StatsRangeParams { startDate: string; endDate: string }
export interface StatsRangeOut { startDate: string; endDate: string; prevStartDate: string; prevEndDate: string }
export interface ChannelAgg { orderCount: number; revenueFen: number }
export interface OverviewStats {
  range: StatsRangeOut
  kpi: { revenueFen: number; refundFen: number; orderCount: number; avgOrderFen: number; prev: { revenueFen: number; refundFen: number; orderCount: number; avgOrderFen: number } }
  channels: { LOCAL: ChannelAgg; EXPRESS: ChannelAgg }
  trend: { date: string; LOCAL: ChannelAgg; EXPRESS: ChannelAgg }[]
  hourly: number[]
  customers: { users: number; newUsers: number; returningUsers: number; repeatRate: number | null }
  hotProducts: { productId: number; name: string; qty: number; revenueFen: number }[]
}
export interface LocalStatsKpi { orderCount: number; revenueFen: number; avgDistanceM: number | null; freeShipCount: number; freeShipRate: number | null }
export interface LocalStats {
  range: StatsRangeOut
  kpi: LocalStatsKpi & { prev: LocalStatsKpi }
  freight: { customerPaidFen: number; deliveryFen: number; tipFen: number; cancelFen: number; riderTotalFen: number; netFen: number; prev: { customerPaidFen: number; riderTotalFen: number; netFen: number } }
  timing: { stages: { key: string; label: string; medianMin: number | null; p90Min: number | null; n: number }[] }
  providers: { provider: string; count: number; avgFeeFen: number; avgPickupMin: number | null }[]
  ladder: { first: number; cheapestN: number; all: number }
  distance: { label: string; count: number }[]
  cancels: { requested: number; deliveryCancelled: number }
}
export interface ExpressStatsKpi { orderCount: number; revenueFen: number; shippingFeeFen: number }
export interface ExpressStats {
  range: StatsRangeOut
  kpi: ExpressStatsKpi & { prev: ExpressStatsKpi }
  backlog: { count: number; oldestHours: number | null; oldestOrderNo: string | null }
  shipTiming: { medianHours: number | null; p90Hours: number | null; n: number }
  companies: { name: string; count: number }[]
  regions: { province: string; count: number }[]
  afterSales: { refundCount: number; refundFen: number; afterSaleCount: number }
}
```

- [ ] **Step 7: `api/admin.ts` 追加**（import 里加三个类型）

```ts
// 经营概览（三 tab 各一个接口）
export const getOverviewStats = (params: StatsRangeParams & { channel?: 'ALL' | 'LOCAL' | 'EXPRESS' }) =>
  client.get<ApiResponse<OverviewStats>>('/admin/stats/overview', { params })
export const getLocalStats = (params: StatsRangeParams) =>
  client.get<ApiResponse<LocalStats>>('/admin/stats/local', { params })
export const getExpressStats = (params: StatsRangeParams) =>
  client.get<ApiResponse<ExpressStats>>('/admin/stats/express', { params })
```

- [ ] **Step 8: 编译**

Run: `npm run build --workspace=apps/admin`
Expected: 时区门禁通过（`RangePicker.spanDays` 用的是 `Date.UTC` 静态方法，不是实例 getter；如果门禁仍拦，改成纯字符串比较 + 用 `shiftDayKey` 反推），tsc 无错（`Dashboard.tsx` 此时仍用老组件，不受影响）。

- [ ] **Step 9: Commit**

```bash
git add apps/admin/src/hooks/useIsPhone.ts apps/admin/src/pages/Workbench.tsx apps/admin/src/components/dashboard apps/admin/src/types.ts apps/admin/src/api/admin.ts
git commit -m "经营概览前端基础件：useIsPhone 抽 hook、KpiCard/RangePicker/StackedBars、三接口类型与 API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `Dashboard.tsx` 壳 + `OverviewTab`

**Files:**
- Modify: `apps/admin/src/pages/Dashboard.tsx`（整文件重写）
- Create: `apps/admin/src/components/dashboard/OverviewTab.tsx`
- Create: `apps/admin/src/components/dashboard/LocalTab.tsx`（本 task 先放占位「加载中」，Task 7 填）
- Create: `apps/admin/src/components/dashboard/ExpressTab.tsx`（同上，Task 8 填）

**Interfaces:**
- Consumes: Task 5 全部
- Produces: `<OverviewTab range />`、`<LocalTab range />`、`<ExpressTab range />`，props 都是 `{ range: DateRange }`

- [ ] **Step 1: `Dashboard.tsx`**

```tsx
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import RangePicker, { QUICK, rangeError, type DateRange } from '../components/dashboard/RangePicker'
import OverviewTab from '../components/dashboard/OverviewTab'
import LocalTab from '../components/dashboard/LocalTab'
import ExpressTab from '../components/dashboard/ExpressTab'

type Tab = 'overview' | 'local' | 'express'
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: '总览' },
  { key: 'local', label: '同城配送' },
  { key: 'express', label: '全国邮寄' },
]

/**
 * 经营概览：统一时间范围 + 三个 tab。tab 与范围都写进 URL（?tab=&start=&end=），刷新不丢。
 * 三个 tab 各拉各的接口（components/dashboard/*Tab.tsx），切换只重拉当前这个。
 */
export default function Dashboard() {
  const [sp, setSp] = useSearchParams()
  const tab: Tab = (TABS.find((t) => t.key === sp.get('tab'))?.key ?? 'overview') as Tab
  const range: DateRange = useMemo(() => {
    const s = sp.get('start'), e = sp.get('end')
    return s && e ? { startDate: s, endDate: e } : QUICK[2].range()   // 默认近 7 天
  }, [sp])

  const setTab = (t: Tab) => setSp((p) => { p.set('tab', t); return p }, { replace: true })
  const setRange = (r: DateRange) => setSp((p) => { p.set('start', r.startDate); p.set('end', r.endDate); return p }, { replace: true })
  const err = rangeError(range)

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-800">经营概览</h2>
      <RangePicker value={range} onChange={setRange} />
      <div className="flex gap-2 border-b border-gray-200" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${tab === t.key ? 'border-brand-500 text-brand-600 font-medium' : 'border-transparent text-gray-500'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {err ? (
        <div className="text-sm text-gray-500">请先把上面的时间范围改正确。</div>
      ) : tab === 'overview' ? <OverviewTab range={range} />
        : tab === 'local' ? <LocalTab range={range} />
        : <ExpressTab range={range} />}
    </div>
  )
}
```

- [ ] **Step 2: 共用的加载/失败壳（放进 `OverviewTab.tsx` 同目录的 `useStats.ts`）**

```ts
import { useCallback, useEffect, useState, type ReactNode } from 'react'

/** 三个 tab 共用：拉一次、失败可重试。deps 变了就重拉。 */
export function useStats<T>(fetcher: () => Promise<{ data: { data: T } }>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const load = useCallback(() => {
    setLoading(true); setFailed(false)
    fetcher().then((r) => setData(r.data.data)).catch(() => setFailed(true)).finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => { load() }, [load])
  return { data, loading, failed, reload: load }
}

export function StatsShell({ loading, failed, reload, children }: { loading: boolean; failed: boolean; reload: () => void; children: ReactNode }) {
  if (failed) return (
    <div className="bg-white rounded-lg shadow-card p-6 text-sm text-red-500 flex items-center gap-3">
      数据加载失败 <button onClick={reload} className="text-brand-600 underline">重试</button>
    </div>
  )
  if (loading) return <div className="text-sm text-gray-500">加载中…</div>
  return <>{children}</>
}
```


- [ ] **Step 3: `OverviewTab.tsx`**

```tsx
import { useState } from 'react'
import { getOverviewStats } from '../../api/admin'
import type { OverviewStats } from '../../types'
import KpiCard from './KpiCard'
import StackedBars from './StackedBars'
import { useStats, StatsShell } from './useStats'
import { fen, pct } from './format'
import type { DateRange } from './RangePicker'

const LOCAL_COLOR = '#f97316'   // 同城：橙（与工作台同城语义一致）
const EXPRESS_COLOR = '#3b82f6' // 邮寄：蓝

export default function OverviewTab({ range }: { range: DateRange }) {
  const [hotChannel, setHotChannel] = useState<'ALL' | 'LOCAL' | 'EXPRESS'>('ALL')
  const { data, loading, failed, reload } = useStats<OverviewStats>(
    () => getOverviewStats({ ...range, channel: hotChannel }),
    [range.startDate, range.endDate, hotChannel],
  )
  return (
    <StatsShell loading={loading} failed={failed} reload={reload}>
      {data && <Body d={data} hotChannel={hotChannel} setHotChannel={setHotChannel} />}
    </StatsShell>
  )
}

function Body({ d, hotChannel, setHotChannel }: { d: OverviewStats; hotChannel: 'ALL' | 'LOCAL' | 'EXPRESS'; setHotChannel: (c: 'ALL' | 'LOCAL' | 'EXPRESS') => void }) {
  const k = d.kpi
  const total = d.channels.LOCAL.revenueFen + d.channels.EXPRESS.revenueFen
  const localShare = total ? d.channels.LOCAL.revenueFen / total : 0
  const labels = d.trend.map((t) => t.date.slice(5))
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="实收" value={fen(k.revenueFen)} sub={`退款后 ${fen(k.revenueFen - k.refundFen)}`} cur={k.revenueFen} prev={k.prev.revenueFen} />
        <KpiCard label="订单数" value={String(k.orderCount)} cur={k.orderCount} prev={k.prev.orderCount} />
        <KpiCard label="客单价" value={fen(k.avgOrderFen)} cur={k.avgOrderFen} prev={k.prev.avgOrderFen} />
        <KpiCard label="退款" value={fen(k.refundFen)} sub={`退款率 ${pct(k.revenueFen ? k.refundFen / k.revenueFen : null)}`} cur={k.refundFen} prev={k.prev.refundFen} deltaTone="up-bad" />
      </div>

      <div className="bg-white rounded-lg shadow-card p-4">
        <p className="text-sm text-gray-500 mb-2">渠道占比（按实收）</p>
        <div className="h-3 rounded-full overflow-hidden bg-gray-100 flex">
          <div style={{ width: `${localShare * 100}%`, background: LOCAL_COLOR }} />
          <div style={{ flex: 1, background: EXPRESS_COLOR }} />
        </div>
        <div className="mt-2 flex flex-wrap justify-between text-sm text-gray-700">
          <span><i className="inline-block w-2.5 h-2.5 rounded-sm mr-1 align-middle" style={{ background: LOCAL_COLOR }} />同城 {d.channels.LOCAL.orderCount} 单 · {fen(d.channels.LOCAL.revenueFen)}</span>
          <span><i className="inline-block w-2.5 h-2.5 rounded-sm mr-1 align-middle" style={{ background: EXPRESS_COLOR }} />邮寄 {d.channels.EXPRESS.orderCount} 单 · {fen(d.channels.EXPRESS.revenueFen)}</span>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-card p-4">
        <p className="text-sm text-gray-500 mb-2">日实收趋势</p>
        <StackedBars labels={labels} valueFormatter={(v) => fen(v, 0)}
          series={[
            { name: '同城', color: LOCAL_COLOR, values: d.trend.map((t) => t.LOCAL.revenueFen) },
            { name: '邮寄', color: EXPRESS_COLOR, values: d.trend.map((t) => t.EXPRESS.revenueFen) },
          ]} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg shadow-card p-4">
          <p className="text-sm text-gray-500 mb-2">下单时段分布（单数）</p>
          <StackedBars height={180} labels={d.hourly.map((_, h) => `${h}`)} series={[{ name: '订单', color: '#6b7280', values: d.hourly }]} maxXLabels={24} />
        </div>
        <div className="bg-white rounded-lg shadow-card overflow-hidden">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <p className="text-sm text-gray-500">本期热销 Top 5</p>
            <div className="flex rounded-md border border-gray-200 overflow-hidden text-xs">
              {(['ALL', 'LOCAL', 'EXPRESS'] as const).map((c) => (
                <button key={c} onClick={() => setHotChannel(c)} className={`px-2 py-1 ${hotChannel === c ? 'bg-brand-500 text-white' : 'text-gray-600'}`}>
                  {c === 'ALL' ? '全部' : c === 'LOCAL' ? '同城' : '邮寄'}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600"><tr><th className="text-left px-4 py-2">商品</th><th className="text-right px-4 py-2">售出</th><th className="text-right px-4 py-2">金额</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {d.hotProducts.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-400">本期没有售出记录</td></tr>}
                {d.hotProducts.map((p) => (
                  <tr key={p.productId}><td className="px-4 py-2 text-gray-800">{p.name}</td><td className="px-4 py-2 text-right">{p.qty}</td><td className="px-4 py-2 text-right text-brand-600 font-medium">{fen(p.revenueFen)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-card p-4 text-sm text-gray-700 flex flex-wrap gap-x-6 gap-y-1">
        <span>顾客 <b>{d.customers.users}</b></span>
        <span>新客 <b>{d.customers.newUsers}</b></span>
        <span>老客 <b>{d.customers.returningUsers}</b></span>
        <span>复购率 <b>{pct(d.customers.repeatRate)}</b></span>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: `LocalTab.tsx` / `ExpressTab.tsx` 占位**

```tsx
import type { DateRange } from './RangePicker'
export default function LocalTab({ range }: { range: DateRange }) {
  return <div className="text-sm text-gray-500">同城配送板块建设中（{range.startDate} ~ {range.endDate}）</div>
}
```
（Express 同款，文字换「全国邮寄」。）

- [ ] **Step 5: 删掉不再引用的老代码**

`types.ts` 的 `Stats`、`SalesTrendPoint` 与 `api/admin.ts` 的 `getStats`、`getSalesTrend`：`grep -rn "getStats\|getSalesTrend\|SalesTrendPoint\|: Stats\b" apps/admin/src` 确认没有别的引用后删除（`ui/TrendChart.tsx` 保留，扫码统计在用）。

- [ ] **Step 6: 编译 + 浏览器验证**

Run: `npm run build --workspace=apps/admin`
然后用 Browser pane 打开本机管理端（`apps/admin` dev 起在 5199 或 `npm run dev --workspace=apps/admin` 看端口；本机 mock 登录 `admin / admin123456`），访问 `/dashboard`：
- 四张 KPI 有数、切「今日/近 30 天」数字变、URL 里出现 `?start=&end=`
- 趋势图两色、hover 有提示
- 热销榜切「同城」列表变化
- `resize_window` 手机预设：KPI 两列、表格可横滑
- `read_console_messages` 无报错

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src
git commit -m "经营概览：壳（范围 + 三 tab + URL 状态）与总览板块

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `LocalTab`

**Files:**
- Modify: `apps/admin/src/components/dashboard/LocalTab.tsx`（整文件）

- [ ] **Step 1: 写 `LocalTab.tsx`**

```tsx
import type { ReactNode } from 'react'
import { getLocalStats } from '../../api/admin'
import type { LocalStats } from '../../types'
import { PROVIDER_LABEL } from '../../utils/providers'
import KpiCard from './KpiCard'
import { useStats, StatsShell } from './useStats'
import { fen, pct, minutes, km } from './format'
import type { DateRange } from './RangePicker'

export default function LocalTab({ range }: { range: DateRange }) {
  const { data, loading, failed, reload } = useStats<LocalStats>(() => getLocalStats(range), [range.startDate, range.endDate])
  return <StatsShell loading={loading} failed={failed} reload={reload}>{data && <Body d={data} />}</StatsShell>
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <div className="bg-white rounded-lg shadow-card p-4"><p className="text-sm text-gray-500 mb-2">{title}</p>{children}</div>
}

function Body({ d }: { d: LocalStats }) {
  const k = d.kpi, f = d.freight
  const netGood = f.netFen >= 0
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="同城单量" value={String(k.orderCount)} cur={k.orderCount} prev={k.prev.orderCount} />
        <KpiCard label="实收" value={fen(k.revenueFen)} cur={k.revenueFen} prev={k.prev.revenueFen} />
        <KpiCard label="平均距离" value={km(k.avgDistanceM)} cur={k.avgDistanceM} prev={k.prev.avgDistanceM} deltaTone="up-bad" />
        <KpiCard label="免运费单" value={String(k.freeShipCount)} sub={`占比 ${pct(k.freeShipRate)}`} cur={k.freeShipCount} prev={k.prev.freeShipCount} deltaTone="up-bad" />
      </div>

      <Card title="运费账">
        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-gray-600">顾客付运费</dt><dd className="font-medium">{fen(f.customerPaidFen)}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-600">付给骑手 <span className="text-gray-400">（配送费 {fen(f.deliveryFen)} + 小费 {fen(f.tipFen)} + 取消费 {fen(f.cancelFen)}）</span></dt><dd className="font-medium">{fen(f.riderTotalFen)}</dd></div>
          <div className="flex justify-between border-t border-gray-200 pt-1.5">
            <dt className="text-gray-800 font-medium">运费差额</dt>
            <dd className={`font-bold ${netGood ? 'text-green-600' : 'text-red-500'}`}>{netGood ? '盈余 ' : '补贴 '}{fen(Math.abs(f.netFen))}</dd>
          </div>
          <div className="text-xs text-gray-400">上期差额 {f.prev.netFen >= 0 ? '盈余' : '补贴'} {fen(Math.abs(f.prev.netFen))}</div>
        </dl>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg shadow-card overflow-hidden">
          <p className="text-sm text-gray-500 px-4 pt-4 pb-2">时效（已完成单）</p>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600"><tr><th className="text-left px-4 py-2">阶段</th><th className="text-right px-4 py-2">中位</th><th className="text-right px-4 py-2">最慢(P90)</th><th className="text-right px-4 py-2">样本</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {d.timing.stages.map((s) => (
                <tr key={s.key} className={s.key === 'total' ? 'font-medium' : ''}><td className="px-4 py-2">{s.label}</td><td className="px-4 py-2 text-right">{minutes(s.medianMin)}</td><td className="px-4 py-2 text-right">{minutes(s.p90Min)}</td><td className="px-4 py-2 text-right text-gray-500">{s.n}</td></tr>
              ))}
            </tbody></table></div>
        </div>
        <div className="bg-white rounded-lg shadow-card overflow-hidden">
          <p className="text-sm text-gray-500 px-4 pt-4 pb-2">承运商（已送达）</p>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600"><tr><th className="text-left px-4 py-2">运力</th><th className="text-right px-4 py-2">单量</th><th className="text-right px-4 py-2">均价</th><th className="text-right px-4 py-2">呼叫→取货</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {d.providers.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">本期没有送达记录</td></tr>}
              {d.providers.map((p) => (
                <tr key={p.provider}><td className="px-4 py-2">{PROVIDER_LABEL[p.provider] ?? p.provider}</td><td className="px-4 py-2 text-right">{p.count}</td><td className="px-4 py-2 text-right">{fen(p.avgFeeFen)}</td><td className="px-4 py-2 text-right">{minutes(p.avgPickupMin)}</td></tr>
              ))}
            </tbody></table></div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
        <Card title="呼叫阶梯"><div className="space-y-1"><div>第一级成交 <b>{d.ladder.first}</b></div><div>升到 3 家并呼 <b>{d.ladder.cheapestN}</b></div><div>全呼 <b>{d.ladder.all}</b></div></div></Card>
        <Card title="距离分布"><div className="space-y-1">{d.distance.map((x) => <div key={x.label}>{x.label} <b>{x.count}</b></div>)}</div></Card>
        <Card title="取消"><div className="space-y-1"><div>顾客取消申请 <b>{d.cancels.requested}</b></div><div>配送中取消 <b>{d.cancels.deliveryCancelled}</b></div></div></Card>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 编译 + 浏览器验证**（同 Task 6 Step 6：切到「同城配送」tab；运费账三行、差额带颜色；手机宽度表格横滑）

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/components/dashboard/LocalTab.tsx
git commit -m "经营概览：同城配送板块（运费账/时效/承运商/阶梯/距离/取消）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `ExpressTab` + 收尾

**Files:**
- Modify: `apps/admin/src/components/dashboard/ExpressTab.tsx`（整文件）

- [ ] **Step 1: 写 `ExpressTab.tsx`**

```tsx
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { getExpressStats } from '../../api/admin'
import type { ExpressStats } from '../../types'
import KpiCard from './KpiCard'
import { useStats, StatsShell } from './useStats'
import { fen, hours } from './format'
import type { DateRange } from './RangePicker'

export default function ExpressTab({ range }: { range: DateRange }) {
  const { data, loading, failed, reload } = useStats<ExpressStats>(() => getExpressStats(range), [range.startDate, range.endDate])
  return <StatsShell loading={loading} failed={failed} reload={reload}>{data && <Body d={data} />}</StatsShell>
}

function Body({ d }: { d: ExpressStats }) {
  const k = d.kpi, b = d.backlog
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KpiCard label="邮寄单量" value={String(k.orderCount)} cur={k.orderCount} prev={k.prev.orderCount} />
        <KpiCard label="实收" value={fen(k.revenueFen)} cur={k.revenueFen} prev={k.prev.revenueFen} />
        <KpiCard label="运费收入" value={fen(k.shippingFeeFen)} cur={k.shippingFeeFen} prev={k.prev.shippingFeeFen} />
      </div>

      {b.count > 0 ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 flex items-start gap-3 text-sm">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
          <div>
            <p className="font-medium text-amber-800">当前待发货 {b.count} 单</p>
            <p className="text-amber-700 mt-0.5">最久已等 {hours(b.oldestHours)}{b.oldestOrderNo ? `（${b.oldestOrderNo}）` : ''}</p>
            <p className="text-xs text-amber-600 mt-1">这是当前实时数，不随上面的时间范围变化</p>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4 flex items-center gap-3 text-sm text-green-700">
          <CheckCircle2 className="w-5 h-5 shrink-0" /> 当前无待发货积压
        </div>
      )}

      <div className="bg-white rounded-lg shadow-card p-4 text-sm flex flex-wrap gap-x-8 gap-y-1">
        <span className="text-gray-500">付款→发货</span>
        <span>中位 <b>{hours(d.shipTiming.medianHours)}</b></span>
        <span>最慢(P90) <b>{hours(d.shipTiming.p90Hours)}</b></span>
        <span className="text-gray-500">样本 {d.shipTiming.n}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SmallTable title="快递公司" rows={d.companies.map((c) => [c.name, c.count])} empty="本期没有发货记录" />
        <SmallTable title="收件地 Top 5" rows={d.regions.map((r) => [r.province, r.count])} empty="本期没有邮寄单" />
      </div>

      <div className="bg-white rounded-lg shadow-card p-4 text-sm flex flex-wrap gap-x-8 gap-y-1">
        <span>退款 <b>{d.afterSales.refundCount}</b> 单 · {fen(d.afterSales.refundFen)}</span>
        <span>售后申请 <b>{d.afterSales.afterSaleCount}</b></span>
      </div>
    </div>
  )
}

function SmallTable({ title, rows, empty }: { title: string; rows: [string, number][]; empty: string }) {
  return (
    <div className="bg-white rounded-lg shadow-card overflow-hidden">
      <p className="text-sm text-gray-500 px-4 pt-4 pb-2">{title}</p>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-gray-100">
          {rows.length === 0 && <tr><td className="px-4 py-6 text-center text-gray-400">{empty}</td></tr>}
          {rows.map(([name, n]) => <tr key={name}><td className="px-4 py-2 text-gray-800">{name}</td><td className="px-4 py-2 text-right">{n}</td></tr>)}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: 编译 + 浏览器三 tab 全走一遍**

Run: `npm run build --workspace=apps/admin`
浏览器：三个 tab、切范围、手机宽度、`read_console_messages` 无错；截一张总览、一张同城的图给复核用（`computer screenshot`）。

- [ ] **Step 3: 全量 e2e 最后一遍**

Run: `BASE=http://localhost:3105 DB_NAME=food_shop_audit bash scripts/e2e.sh 2>&1 | tail -4`
Expected: 0 红。

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/components/dashboard/ExpressTab.tsx
git commit -m "经营概览：全国邮寄板块（待发货预警/发货时效/快递公司/地区/售后）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## 完成标准（复核者按这个看）

1. `git log main..HEAD` 有 8 个提交，每个能独立编译。
2. `BASE=http://localhost:3105 DB_NAME=food_shop_audit bash scripts/e2e.sh` 0 红，§33 与 §54 都绿。
3. `npm run build --workspace=apps/server` 与 `--workspace=apps/admin` 均通过（含时区门禁）。
4. `grep -rn "isTest: false" apps/server/src/routes/admin/stats` 为空（全部走 `REAL_ORDERS`）。
5. 浏览器截图：三 tab 各一张，手机宽度一张。
6. 老接口 `/admin/stats` 字段名一个没变。
