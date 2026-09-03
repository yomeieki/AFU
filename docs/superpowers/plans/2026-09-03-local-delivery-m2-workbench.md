# M2-B 接单工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **前置**：M2-A 引擎计划（`2026-09-03-local-delivery-m2-engine.md`）T0-T9 已全部完成合入——本计划消费其全部服务端接口。

**Goal:** 按店主定稿的界面规格（`docs/design/workbench-ui-spec.md`，逐条为准）实现店员默认落地页「接单工作台」：五列看板、两渠道混排、详情抽屉、分级确认、拒单弹窗、顶栏；外加 `/local/orders` 历史列表页与导航/落地页改造。

**Architecture:** 服务端一个聚合端点 `GET /admin/workbench/snapshot`（归类与排序都在服务端，3 秒缓存），前端 10s 轮询（页面隐藏 60s）；`/workbench` 是 RequireAuth 内、Layout **外**的全屏独立路由，自带 scoped CSS token（不吃 Layout 侧栏）；历史检索留在 Layout 内的 `/local/orders`。

**Tech Stack:** React 18 + TS + react-router-dom 6 + Tailwind 3（工作台页另带一段 scoped 原生 CSS token 实现日夜双主题）+ axios + zustand + lucide-react。

## Global Constraints

- **UI 逐条以 `docs/design/workbench-ui-spec.md` 为准**（店主定稿，实现者必须先通读）。本计划只补代码骨架，与规格冲突时规格赢。
- 排序硬规则（规格 §2）：每列内**同城恒排邮寄之上，不比等待时长**；同渠道内等待久的在上。
- 渠道三重编码（§3）：4px 色条 + 徽章 + 字段差异；渠道色 `--local #e5441e` / `--express #3b5bdb`（深色 `#ff7a54` / `#8fa5ff`），soft 底 `#fdf0ec` / `#eef1fd`（深色 `#33191180` / `#1a1f3d80`）；语义色 `--ok #15803d / --warn #a15c07 / --danger #b3261e` 独立于渠道色；中性 `--bg #f6f5f3 / --surface #fff / --text-1 #1b1918`。
- 卡片只放摘要（§4）：≥3 样 → `前两菜名 等 N 样 / M 份`；**无备注必须明写「无备注」**；等待胶囊 >3:00 琥珀、>6:00 红底白字。
- 抽屉防挤扁（§5）：`.drawer__body > * { flex: none }` + 父级 `min-height: 0`；数量列 44px / 金额列 78px 定宽右对齐。
- 确认分级（§6）：打给骑手/看进度/查物流**不弹**；改状态或花钱的全弹；弹窗写「会发生什么/顾客看到什么/花多少钱」；确认按钮跟渠道色。
- 拒单（§7）：入口在抽屉底部红链；5 原因（顾客原样可见）；其他原因强制说明≤40 字；售罄展开勾选并联动下架；红条写明退款金额。
- 顶栏（§8）：打印机状态占位「未接入」（M2b 接上）；日夜切换写 `data-theme`+localStorage（try/catch）；全屏被拒退化「专注模式」；退出确认写明「工作台仍在后台接单、出票和播报」。
- `<900px` 横滑一屏一列 `grid-auto-columns: 86vw`，默认停「待接单」（§9）。
- v1 不做（§10）：骑手地图、拖拽列、工作台内历史检索。
- 「等待配送员」列 v1 **只放同城单**（决策 N2）；邮寄从备餐中填单号直接跳配送中。
- 服务端约定沿用 M2-A Global Constraints（错误码 42221-42238、金额分、时间 ISO）。
- 环境：worktree 独立库 `food_shop_sc`、后端 :3100 热重载常驻、admin dev 用 `.claude/launch.json` 的预览（勿用 Bash 起服务器）；e2e 连跑间隔 60s。
- 提交信息中文 `type(scope): 摘要`，结尾 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。

## 文件结构

| 路径 | 职责 |
|---|---|
| `apps/server/src/routes/admin/workbench.ts` | snapshot 聚合端点（归类/排序/统计/3s 缓存） |
| `apps/admin/src/pages/Workbench.tsx` | 工作台整页（列/卡片/抽屉/确认/拒单/顶栏） |
| `apps/admin/src/pages/Workbench.css` | 工作台 scoped token 与布局（日夜两套） |
| `apps/admin/src/components/CancelAndRefundModal.tsx` | 「取消配送并退款」两步引导（同一 Modal 内步进，不嵌 confirmDialog——层级会被压住） |
| `apps/admin/src/pages/LocalOrders.tsx` | 同城订单历史列表页（AfterSalePanel 式单列卡片） |
| 改动 | `apps/admin/src/{types.ts, api/admin.ts, App.tsx, components/Layout.tsx, components/ui/StatusBadge.tsx, hooks/usePendingOrders.ts, pages/WebviewLogin.tsx, components/RefundDialog.tsx}`、`scripts/e2e.sh`（第 31 段）、`docs/api.md` |

---

### Task U1: `GET /admin/workbench/snapshot`

**Files:**
- Create: `apps/server/src/routes/admin/workbench.ts`
- Modify: `apps/server/src/routes/admin/index.ts`（`router.use('/workbench', workbenchRouter)`）
- Test: `scripts/e2e.sh` 新增「== 31. 工作台快照 ==」

**Interfaces:**
- Consumes: M2-A 的 `getActiveDelivery` 语义（直接查 `delivery.activeOrderId in ids`）、`DELIVERY_STATUS_LABEL`、`circuit.getCircuitState`、`local-settings.getLocalSettings/isOpenNow`。
- Produces（响应 data，前端 U2 类型逐字对齐）:
```ts
interface WorkbenchCard {
  orderId: number; orderNo: string; channel: 'LOCAL' | 'EXPRESS'; status: string
  waitSince: string                      // 本列计时锚点 ISO：pending=paidAt / preparing=acceptedAt / waitingCourier=delivery.calledAt /
                                         // delivering=同城 delivery.pickedUpAt、邮寄 shipment.shippedAt（Order 没有 shippedAt 列）/ done=completedAt
  amountFen: number
  items: { first: string[]; kinds: number; units: number }   // first=前两个菜名（含 ×n）
  note: string | null
  receiver: { name: string; phone: string }
  express: { province: string; city: string; expressCompany: string | null; expressNo: string | null } | null
  local: {
    distanceM: number | null
    cancelRequested: boolean
    delivery: { status: string; statusLabel: string; courierName: string | null; courierMobile: string | null } | null
  } | null
}
interface WorkbenchSnapshot {
  columns: { pending: WorkbenchCard[]; preparing: WorkbenchCard[]; waitingCourier: WorkbenchCard[]; delivering: WorkbenchCard[]; done: WorkbenchCard[] }
  stats: { todayOrders: number; todayRevenueFen: number; avgDeliverMinutes: number | null }
  circuit: { tripped: boolean }
  localEnabled: boolean; localOpenNow: boolean
  paused: { reason: string; until: string | null } | null
  printer: { status: 'NOT_CONNECTED' }   // M2b 接飞鹅后替换
  pendingAlerts: number                  // 未处理取消申请 + ABNORMAL/UNKNOWN 在途配送单 + 熔断(1)
  now: string
}
```
- 归类规则（决策 N2 已定）：`pending`=PAID（双渠道）；`preparing`=PREPARING 且（EXPRESS 一律 ∨ LOCAL 无在途配送单）；`waitingCourier`=**仅 LOCAL**，PREPARING 且在途配送单 status∈{CALLING,ACCEPTED,ARRIVING,ARRIVED,REASSIGNING,ABNORMAL,UNKNOWN}（异常留在本列变红，规格 §1「异常不单开一列」）；`delivering`=SHIPPED（双渠道）；`done`=今日 COMPLETED（≤30 张，新在上）。
- 排序在服务端：`pending/preparing/waitingCourier/delivering` 按 [LOCAL 优先, waitSince 升序]；`done` 按 [LOCAL 优先, completedAt 降序]。
- 缓存：模块级 `{ at, data }` 3 秒；`?fresh=1` 跳过（e2e 与操作后强刷用）。

- [ ] **Step 1: e2e（RED）**

第 30 段之后、清理段之前插入（复用 `mk_local_paid`/`kd_cb`/`dstat`；`$PID/$ADDR` 为邮寄既有变量）：
```bash
echo "== 31. 工作台快照 =="
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
snap() { req GET "/api/admin/workbench/snapshot?fresh=1" "$AT"; }
col_has() { jq -r --argjson id "$2" ".data.columns.$1 | map(.orderId) | index(\$id) != null" <<<"$3"; }
# 先造邮寄单再造同城单：邮寄等得更久，若实现只按等待时长排序这条硬规则断言就会翻车（规格 §2 活例）
R=$(req POST /api/cart "$UT" "{\"productId\":$PID,\"quantity\":1}"); WBC=$(jq -r .data.id <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$WBC],\"addressId\":$ADDR,\"deliveryType\":\"EXPRESS\"}")
WBE1=$(jq -r .data.orderId <<<"$R"); req POST "/api/orders/$WBE1/pay" "$UT" >/dev/null
sleep 1
WBL1=$(mk_local_paid)
S=$(snap)
assert_eq "同城单入待接单列" "$(col_has pending $WBL1 "$S")" "true"
assert_eq "邮寄单入待接单列" "$(col_has pending $WBE1 "$S")" "true"
# 硬排序：邮寄单付款更早（等更久），同城单仍必须排在它上面
LIDX=$(jq -r --argjson id $WBL1 '.data.columns.pending | map(.orderId) | index($id)' <<<"$S")
EIDX=$(jq -r --argjson id $WBE1 '.data.columns.pending | map(.orderId) | index($id)' <<<"$S")
[[ "$LIDX" -lt "$EIDX" ]] && ok "同城恒排邮寄之上" || fail "排序硬规则" "local=$LIDX express=$EIDX"
assert_eq "卡片渠道标注 LOCAL" "$(jq -r --argjson id $WBL1 '.data.columns.pending[] | select(.orderId==$id) | .channel' <<<"$S")" "LOCAL"
assert_eq "邮寄卡片带省市" "$(jq -r --argjson id $WBE1 '.data.columns.pending[] | select(.orderId==$id) | .express.province != null' <<<"$S")" "true"
assert_eq "同城卡片 local 块存在" "$(jq -r --argjson id $WBL1 '.data.columns.pending[] | select(.orderId==$id) | .local != null' <<<"$S")" "true"
req POST "/api/admin/local/orders/$WBL1/accept" "$AT" >/dev/null
S=$(snap); assert_eq "接单后入备餐中" "$(col_has preparing $WBL1 "$S")" "true"
req POST "/api/admin/local/orders/$WBL1/call" "$AT" >/dev/null
S=$(snap)
assert_eq "呼叫后入等待配送员" "$(col_has waitingCourier $WBL1 "$S")" "true"
assert_eq "配送状态标签=待抢单" "$(jq -r --argjson id $WBL1 '.data.columns.waitingCourier[] | select(.orderId==$id) | .local.delivery.statusLabel' <<<"$S")" "待抢单"
assert_eq "等待配送员列无邮寄单（N2）" "$(jq -r '[.data.columns.waitingCourier[] | select(.channel=="EXPRESS")] | length' <<<"$S")" "0"
WBT=$(req GET "/api/admin/local/orders/$WBL1/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
WBD=$(req GET "/api/admin/local/orders/$WBL1/delivery" "$AT" | jq -r .data.delivery.deliveryNo)
kd_cb "$WBD" "$WBT" 310 '骑手已取货' '2026-09-04 15:00:00' >/dev/null
S=$(snap); assert_eq "310 后入配送中" "$(col_has delivering $WBL1 "$S")" "true"
kd_cb "$WBD" "$WBT" 520 '已送达' '2026-09-04 15:20:00' >/dev/null
S=$(snap); assert_eq "520 后入已完成" "$(col_has done $WBL1 "$S")" "true"
assert_eq "打印机占位" "$(jq -r .data.printer.status <<<"$S")" "NOT_CONNECTED"
assert_eq "熔断未触发" "$(jq -r .data.circuit.tripped <<<"$S")" "false"
[[ "$(jq -r .data.stats.todayOrders <<<"$S")" -ge 1 ]] && ok "今日单数 ≥1" || fail "stats" "$S"
```
Run RED。

- [ ] **Step 2: 实现 workbench.ts**

完整代码：
```ts
/**
 * 接单工作台快照：五列归类与排序都在服务端做——排序硬规则（同城恒上）是产品规则不是展示偏好，
 * 放服务端保证小程序端未来复用同一口径。3 秒缓存挡 10s×N 店员的轮询洪峰；?fresh=1 供操作后强刷。
 */
import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { DELIVERY_STATUS_LABEL } from '../../services/delivery/state'
import { getCircuitState } from '../../services/delivery/circuit'
import { getLocalSettings, isOpenNow } from '../../services/local-settings'

const router = Router()
const WAITING_STATUSES = ['CALLING', 'ACCEPTED', 'ARRIVING', 'ARRIVED', 'REASSIGNING', 'ABNORMAL', 'UNKNOWN']
let cache: { at: number; data: unknown } | null = null

function startOfToday(): Date { const d = new Date(); d.setHours(0, 0, 0, 0); return d }

type OrderRow = Awaited<ReturnType<typeof loadOrders>>[number]
async function loadOrders() {
  return prisma.order.findMany({
    where: {
      OR: [
        { status: { in: ['PAID', 'PREPARING', 'SHIPPED'] } },
        { status: 'COMPLETED', completedAt: { gte: startOfToday() } },
      ],
    },
    include: {
      items: { select: { productName: true, quantity: true } },
      shipment: { select: { expressCompany: true, expressNo: true, shippedAt: true } },
    },
    orderBy: { id: 'desc' },
    take: 300,
  })
}

function toCard(o: OrderRow, waitSince: Date | null, d: { status: string; courierName: string | null; courierMobile: string | null; providerDistanceM: number | null; pickedUpAt?: Date | null } | null): Record<string, unknown> {
  const units = o.items.reduce((n, it) => n + it.quantity, 0)
  return {
    orderId: o.id, orderNo: o.orderNo, channel: o.deliveryType, status: o.status,
    waitSince: (waitSince ?? o.createdAt).toISOString(), amountFen: o.actualAmount,
    items: { first: o.items.slice(0, 2).map((it) => `${it.productName} ×${it.quantity}`), kinds: o.items.length, units },
    note: o.remark || null,
    receiver: { name: o.receiverName, phone: o.receiverPhone },
    express: o.deliveryType === 'EXPRESS'
      ? { province: o.receiverProvince, city: o.receiverCity, expressCompany: o.shipment?.expressCompany ?? null, expressNo: o.shipment?.expressNo ?? null }
      : null,
    local: o.deliveryType === 'LOCAL'
      ? {
          distanceM: d?.providerDistanceM ?? null,
          cancelRequested: !!o.cancelRequestedAt && !['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(o.status),
          delivery: d ? { status: d.status, statusLabel: DELIVERY_STATUS_LABEL[d.status] ?? d.status, courierName: d.courierName, courierMobile: d.courierMobile } : null,
        }
      : null,
  }
}

/** 规格 §2：同城恒排邮寄之上；同渠道内等待久的在上（done 列新在上） */
function sortColumn(cards: { channel: string; waitSince: string }[], newestFirst = false) {
  cards.sort((a, b) => {
    if (a.channel !== b.channel) return a.channel === 'LOCAL' ? -1 : 1
    return newestFirst ? b.waitSince.localeCompare(a.waitSince) : a.waitSince.localeCompare(b.waitSince)
  })
}

router.get('/snapshot', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.query.fresh !== '1' && cache && Date.now() - cache.at < 3000) return success(res, cache.data)
    const [orders, settings] = await Promise.all([loadOrders(), getLocalSettings()])
    const localIds = orders.filter((o) => o.deliveryType === 'LOCAL').map((o) => o.id)
    const actives = localIds.length
      ? await prisma.delivery.findMany({ where: { activeOrderId: { in: localIds } }, select: { activeOrderId: true, status: true, courierName: true, courierMobile: true, providerDistanceM: true, calledAt: true } })
      : []
    const byOrder = new Map(actives.map((d) => [d.activeOrderId!, d]))

    const cols: Record<string, ReturnType<typeof toCard>[]> = { pending: [], preparing: [], waitingCourier: [], delivering: [], done: [] }
    for (const o of orders) {
      const d = byOrder.get(o.id) ?? null
      if (o.status === 'PAID') cols.pending.push(toCard(o, o.paidAt, d))
      else if (o.status === 'PREPARING') {
        if (o.deliveryType === 'LOCAL' && d && WAITING_STATUSES.includes(d.status)) cols.waitingCourier.push(toCard(o, d.calledAt, d))
        else cols.preparing.push(toCard(o, o.acceptedAt, d))
      // Order 没有 shippedAt 列——同城取配送单的取货时间，邮寄取运单的发货时间，都缺则退回接单时间
      else if (o.status === 'SHIPPED') cols.delivering.push(toCard(o, d?.pickedUpAt ?? o.shipment?.shippedAt ?? o.acceptedAt, d))
      else if (o.status === 'COMPLETED') cols.done.push(toCard(o, o.completedAt, d))
    }
    for (const k of ['pending', 'preparing', 'waitingCourier', 'delivering'] as const) sortColumn(cols[k] as never)
    sortColumn(cols.done as never, true)
    cols.done = cols.done.slice(0, 30)

    const today = startOfToday()
    const [todayOrders, revenue, doneLocal, cancelReqCount, badDeliveries] = await Promise.all([
      prisma.order.count({ where: { paidAt: { gte: today } } }),
      prisma.order.aggregate({ where: { paidAt: { gte: today } }, _sum: { actualAmount: true } }),
      prisma.order.findMany({ where: { deliveryType: 'LOCAL', status: 'COMPLETED', completedAt: { gte: today } }, select: { paidAt: true, completedAt: true }, take: 200 }),
      prisma.order.count({ where: { deliveryType: 'LOCAL', cancelRequestedAt: { not: null }, status: { notIn: ['COMPLETED', 'CANCELLED', 'REFUNDED'] } } }),
      prisma.delivery.count({ where: { activeOrderId: { not: null }, status: { in: ['ABNORMAL', 'UNKNOWN'] } } }),
    ])
    const durations = doneLocal.filter((o) => o.paidAt && o.completedAt).map((o) => (o.completedAt!.getTime() - o.paidAt!.getTime()) / 60000)
    const circuit = getCircuitState()
    const data = {
      columns: cols,
      stats: {
        todayOrders,
        todayRevenueFen: revenue._sum.actualAmount ?? 0,
        avgDeliverMinutes: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      },
      circuit: { tripped: circuit.tripped },
      localEnabled: settings.enabled, localOpenNow: isOpenNow(settings),
      paused: settings.paused ? { reason: settings.paused.reason, until: settings.paused.until } : null,
      printer: { status: 'NOT_CONNECTED' as const },
      pendingAlerts: cancelReqCount + badDeliveries + (circuit.tripped ? 1 : 0),
      now: new Date().toISOString(),
    }
    cache = { at: Date.now(), data }
    success(res, data)
  } catch (e) { next(e) }
})
export default router
```
（`isOpenNow` 的实参签名以 local-settings.ts 现状为准；shipment/receiver 字段名照 schema。）挂载进 `admin/index.ts`。

- [ ] **Step 3: GREEN + 提交**

`cd apps/server && npx tsc --noEmit && cd ../.. && bash scripts/e2e.sh 2>&1 | tail -3` → 第 31 段全 `✔`。
```bash
git add apps/server/src/routes/admin/workbench.ts apps/server/src/routes/admin/index.ts scripts/e2e.sh
git commit -m "feat(admin): 工作台快照端点——五列归类/同城恒上排序/统计/3s缓存

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task U2: admin 前端地基——types / api / StatusBadge / usePendingOrders / Layout 徽标

**Files:**
- Modify: `apps/admin/src/types.ts`
- Modify: `apps/admin/src/api/admin.ts`
- Modify: `apps/admin/src/components/ui/StatusBadge.tsx`
- Modify: `apps/admin/src/hooks/usePendingOrders.ts`
- Modify: `apps/admin/src/components/Layout.tsx`

**Interfaces:**
- Consumes: U1 的 `WorkbenchSnapshot/WorkbenchCard`（类型逐字照抄）、M2-A 的全部路由与 `GET /admin/orders/pending-count` 的 `localPendingCount`。
- Produces（U3/U4 依赖，命名固定）:
  - types.ts 追加：`DeliveryInfo`、`DeliveryEventInfo`、`WorkbenchCard`、`WorkbenchSnapshot`、`RejectReason = 'SOLD_OUT'|'OUT_OF_RANGE'|'PAST_ACCEPT_TIME'|'CUSTOMER_CANCEL'|'OTHER'`：
```ts
export interface DeliveryInfo {
  id: number; deliveryNo: string; provider: 'KD100' | 'SELF' | 'MOCK'
  status: string; statusRank: number; activeOrderId: number | null
  courierCompany: string | null; courierName: string | null; courierMobile: string | null
  quotedFee: number | null; actualFee: number | null; tipFee: number; cancelFee: number
  providerDistanceM: number | null; errorCode: string | null; failReason: string | null
  calledAt: string | null; acceptedAt: string | null; pickedUpAt: string | null
  deliveredAt: string | null; cancelledAt: string | null; cancelReason: string | null
}
export interface DeliveryEventInfo {
  id: number; source: string; providerStatus: number | null; statusDesc: string | null
  courierName: string | null; operator: string | null; createdAt: string
}
```
  - api/admin.ts 追加（全部走既有 `client`；返回类型 `ApiResponse<…>`）：
```ts
export const getWorkbenchSnapshot = (fresh = false) =>
  client.get<ApiResponse<WorkbenchSnapshot>>('/admin/workbench/snapshot', { params: fresh ? { fresh: 1 } : undefined })
export const acceptLocalOrder = (id: number) => client.post<ApiResponse<Order>>(`/admin/local/orders/${id}/accept`)
export const acceptAndCallLocalOrder = (id: number) => client.post<ApiResponse<{ accepted: boolean; deliveryNo: string; status: string }>>(`/admin/local/orders/${id}/accept-and-call`)
export const callRider = (id: number) => client.post<ApiResponse<{ deliveryNo: string; status: string; quotedFeeFen: number | null }>>(`/admin/local/orders/${id}/call`)
export const getOrderDelivery = (id: number) => client.get<ApiResponse<{ delivery: DeliveryInfo | null; events: DeliveryEventInfo[] }>>(`/admin/local/orders/${id}/delivery`)
export const precancelDelivery = (id: number) => client.post<ApiResponse<{ cancelFeeFen: number | null }>>(`/admin/local/orders/${id}/delivery/precancel`)
export const cancelDelivery = (id: number, reason?: string) => client.post<ApiResponse<{ cancelFeeFen: number | null }>>(`/admin/local/orders/${id}/delivery/cancel`, { reason })
export const addDeliveryTip = (id: number, amount: number) => client.post<ApiResponse<{ tipFeeFen: number }>>(`/admin/local/orders/${id}/delivery/tip`, { amount })
export const selfDeliverOrder = (id: number, data: { name: string; phone: string }) => client.post<ApiResponse<{ deliveryNo: string }>>(`/admin/local/orders/${id}/self-deliver`, data)
export const markOrderDelivered = (id: number) => client.post<ApiResponse<null>>(`/admin/local/orders/${id}/delivered`)
export const voidUnknownDelivery = (id: number) => client.post<ApiResponse<null>>(`/admin/local/orders/${id}/delivery/void`)
export const rejectOrder = (id: number, data: { reason: RejectReason; note?: string; soldOutProductIds?: number[] }) =>
  client.post<ApiResponse<{ refund: unknown; offShelfCount: number; cancelReason: string }>>(`/admin/orders/${id}/reject`, data)
export const resetKd100Circuit = () => client.post<ApiResponse<unknown>>('/admin/system/kd100-circuit/reset')
```
  - StatusBadge：`STATUS_MAP` 追加 12 个配送状态（订单键不冲突，`CANCELLED` 复用既有）：`PENDING 待呼叫(gray) / CALLING 待抢单(amber: bg-[#fff7e8] text-[#a15c07]) / ACCEPTED 骑手已接单(blue) / ARRIVING 赶来取货(blue) / ARRIVED 已到店(indigo) / DELIVERING 配送中(cyan) / REASSIGNING 改派中(amber) / ABNORMAL 配送异常(bg-red-50 text-red-600) / DELIVERED 已送达(green) / FAILED 呼叫失败(red) / UNKNOWN 状态未确认(red)`。
  - usePendingOrders：解构响应新增 `localPendingCount`，`useState` + 返回值加 `localPendingCount`（提醒逻辑不动——同城新单提醒 M2b 随打印机语音一起做，此处只出数）。
  - Layout：navItems 首位加 `{ to: '/workbench', label: '接单工作台', icon: Bike }`（同城设置改用 `Settings2` 或保持 Bike 但工作台优先——用规格语义：工作台图标 `ClipboardList` 换 `LayoutGrid` 亦可，实现者取 lucide 现有图标即可，但**必须与「邮寄订单」「同城设置」图标互异**）；徽标改为按 navItem 分挂：`/orders` 挂 `count + afterSaleCount`（现状）、`/workbench` 挂 `localPendingCount`。

- [ ] **Step 1: 实现四文件 + 编译**

按 Interfaces 逐字实现。Run: `cd apps/admin && npx tsc --noEmit && npm run build`
Expected: 零错误（Workbench 页尚未存在，路由不加——U4 才接线，本任务只铺地基不引用）。

- [ ] **Step 2: 提交**

```bash
git add apps/admin/src/types.ts apps/admin/src/api/admin.ts apps/admin/src/components/ui/StatusBadge.tsx apps/admin/src/hooks/usePendingOrders.ts apps/admin/src/components/Layout.tsx
git commit -m "feat(admin): 工作台前端地基——类型/api/配送状态徽标/同城徽标计数

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task U3: Workbench 页面（UI 规格全量）

**Files:**
- Create: `apps/admin/src/pages/Workbench.tsx`
- Create: `apps/admin/src/pages/Workbench.css`
- Create: `apps/admin/src/components/CancelAndRefundModal.tsx`
- Modify: `apps/admin/src/App.tsx`（RequireAuth 内、Layout 外加 `<Route path="/workbench" element={<Workbench />} />`）

**Interfaces:**
- Consumes: U2 全部 api/types；`confirmDialog`（仅用于「退出工作台」一处；页内业务确认用自绘 Modal 以便跟渠道色）；`toast`。
- Produces: 路由 `/workbench`；`CancelAndRefundModal({ orderId, orderNo, amountFen, deliveryStatusLabel, hasActiveDelivery, onClose, onDone })`——两步同 Modal 步进：step1 取消配送（展示 precancel 取消费，调 `cancelDelivery`；无在途单自动跳过）→ step2 全额退款确认（调 `refundOrder(id, { amount, reason: '顾客申请取消' })`）。**不嵌 confirmDialog**（其 Host 层级会压住本 Modal）。

**实现前必读** `docs/design/workbench-ui-spec.md` 全文与本计划 Global Constraints。以下为骨架与关键代码，逐段落实：

- [ ] **Step 1: Workbench.css（token 与布局，日夜两套）**

```css
/* 接单工作台 scoped 样式。token 逐字来自 UI 规格 §3（店主定稿原型），改动须先改规格。 */
.wb { --local:#e5441e; --local-soft:#fdf0ec; --express:#3b5bdb; --express-soft:#eef1fd;
  --ok:#15803d; --warn:#a15c07; --danger:#b3261e;
  --bg:#f6f5f3; --surface:#fff; --text-1:#1b1918; --text-2:#6b6461; --line:#e8e4e1;
  --note-bg:#fdf6e3; --note-line:#d9b23a;
  min-height:100vh; background:var(--bg); color:var(--text-1); font-size:14px; }
.wb[data-theme="dark"] { --local:#ff7a54; --local-soft:#33191180; --express:#8fa5ff; --express-soft:#1a1f3d80;
  --ok:#4ade80; --warn:#fbbf24; --danger:#f87171;
  --bg:#171412; --surface:#211d1a; --text-1:#f0ece9; --text-2:#a39c96; --line:#37312d;
  --note-bg:#332b12; --note-line:#a1802a; }
.wb__board { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; padding:12px; align-items:start; }
.wb__col { background:color-mix(in srgb, var(--surface) 55%, var(--bg)); border-radius:12px; padding:8px; min-height:60vh; }
.wb__card { position:relative; background:var(--surface); border:1px solid var(--line); border-radius:10px;
  padding:10px 10px 10px 14px; margin-bottom:8px; }
.wb__card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:4px; border-radius:10px 0 0 10px; }
.wb__card--local::before { background:var(--local); }
.wb__card--express::before { background:var(--express); }
.wb__card--alert { border-color:var(--danger); box-shadow:0 0 0 1px var(--danger); }
.wb__wait { font-variant-numeric:tabular-nums; border-radius:999px; padding:1px 8px; font-size:12px;
  background:var(--line); }
.wb__wait--warn { background:#fff3d6; color:var(--warn); }
.wb__wait--danger { background:var(--danger); color:#fff; }
.wb__note { background:var(--note-bg); border-left:3px solid var(--note-line); font-weight:600;
  padding:4px 8px; border-radius:4px; margin-top:6px; }
.wb__drawer { position:fixed; inset:0 0 0 auto; width:440px; max-width:100vw; background:var(--surface);
  box-shadow:-8px 0 32px rgba(0,0,0,.18); display:flex; flex-direction:column; z-index:50; }
.wb__drawer-body { flex:1; overflow-y:auto; display:flex; flex-direction:column; min-height:0; padding:16px; }
.wb__drawer-body > * { flex:none; }   /* 规格 §5 防挤扁：缺这行内容会被压没而不是滚动 */
.wb__qty { width:44px; text-align:right; }
.wb__amt { width:78px; text-align:right; font-variant-numeric:tabular-nums; }
.wb--focus .wb__legend, .wb--focus .wb__hint { display:none; }   /* 全屏被拒时的专注模式退化 */
@media (max-width:900px) {
  .wb__board { grid-template-columns:none; grid-auto-flow:column; grid-auto-columns:86vw;
    overflow-x:auto; scroll-snap-type:x mandatory; }
  .wb__col { scroll-snap-align:start; }
  .wb__drawer { width:100vw; }
}
```

- [ ] **Step 2: Workbench.tsx 骨架**

结构与关键逻辑（完整实现按此展开，每块对应规格章节）：
```tsx
/** 接单工作台：店员默认落地页。界面规格 docs/design/workbench-ui-spec.md 为唯一依据。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './Workbench.css'
// …import U2 的 api 与类型、CancelAndRefundModal、RejectModal 同文件内组件

const COLUMNS: { key: keyof WorkbenchSnapshot['columns']; title: string }[] = [
  { key: 'pending', title: '待接单' }, { key: 'preparing', title: '备餐中' },
  { key: 'waitingCourier', title: '等待配送员' }, { key: 'delivering', title: '配送中' },
  { key: 'done', title: '已完成' },
]

function useSnapshot() {   // 10s 轮询、隐藏 60s、操作后 refresh(fresh=true)
  const [snap, setSnap] = useState<WorkbenchSnapshot | null>(null)
  const timerRef = useRef<number | null>(null)
  const load = useCallback(async (fresh = false) => {
    try { setSnap((await getWorkbenchSnapshot(fresh)).data.data) } catch { /* 轮询失败静默，下一拍重试 */ }
  }, [])
  useEffect(() => {
    const schedule = () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
      timerRef.current = window.setInterval(() => void load(), document.hidden ? 60_000 : 10_000)
    }
    void load(true); schedule()
    document.addEventListener('visibilitychange', schedule)
    return () => { if (timerRef.current) window.clearInterval(timerRef.current); document.removeEventListener('visibilitychange', schedule) }
  }, [load])
  return { snap, refresh: () => load(true) }
}

/** 等待胶囊：m:ss 等宽数字；>3:00 琥珀、>6:00 红底白字（§4） */
function waitLabel(sinceIso: string, now: number): { text: string; cls: string } {
  const sec = Math.max(0, Math.floor((now - Date.parse(sinceIso)) / 1000))
  const min = Math.floor(sec / 60)
  const text = `${min}:${String(sec % 60).padStart(2, '0')}`
  return { text, cls: min >= 6 ? 'wb__wait--danger' : min >= 3 ? 'wb__wait--warn' : '' }
}

function itemsSummary(items: WorkbenchCard['items']): string {
  if (items.kinds <= 2) return items.first.join(' · ')
  return `${items.first.map((s) => s.replace(/ ×\d+$/, '')).join('、')} 等 ${items.kinds} 样 / ${items.units} 份`
}
```
卡片（§3/§4）：色条 `wb__card--local/express`；徽章（Bike/Package 图标+文字，soft 底渠道色字）；同城字段=距离/骑手/预计送达，邮寄字段=省市/快递公司/运单号；备注行 `card.note ?? '无备注'`（无备注为普通灰字但**必须渲染**）；`local.cancelRequested || delivery.status ∈ {ABNORMAL,UNKNOWN,FAILED}` 加 `wb__card--alert`；点商品摘要区开抽屉。
抽屉（§5）：`getOrder(id)` + `getOrderDelivery(id)` 并取；自上而下备注放大→StatusBadge 状态条→完整清单（`wb__qty/wb__amt` 定宽）→收货信息（`<a href={\`tel:\${phone}\`}>` 直拨）→骑手块（已接单时，电话同样可拨，**拨号不弹确认**）→金额明细（含配送单 quotedFee/tipFee/cancelFee）→单号时间→底部操作区→最底红字拒单链接。
操作区按列与状态给按钮（§6 分级确认；确认按钮 style 用渠道色变量）：
- 待接单：同城=「接单」「接单并呼叫」/邮寄=「接单」；`accept-and-call` 弹窗必须含琥珀色花钱提示（规格 §6 例文）。
- 备餐中：同城=「呼叫骑手」（settings.defaultProvider 是后端语义，前端不判——按钮恒为呼叫+并列「自己送」）/邮寄=「填单号发货」（复用 Orders 页 ship modal 逻辑简版）。
- 等待配送员：CALLING=「加小费」（弹窗写 `本次 ¥X。单次上限 ¥20，本单已加 ¥Y，累计上限 ¥50`）「取消呼叫」（先 `precancelDelivery` 把取消费写进确认文案）「打给骑手」；ACCEPTED+=「打给骑手」「取消配送」；UNKNOWN=「作废重呼」；FAILED（在备餐中列）=重呼。
- 配送中：同城=「标记已送达」/邮寄=「查物流」（复制运单号+跳快递100 查询页，不弹确认）。
- 取消申请横幅：卡片与抽屉顶部黄条「顾客申请取消」→按钮开 `CancelAndRefundModal`。
拒单弹窗（§7）：5 原因单选（未选禁用确认）；SOLD_OUT 展开本单菜品勾选（数据来自订单 items 的 productId+productName）；OTHER 强制 note；红条 `确认后全额退款 ¥xx 原路退回，顾客会收到退款通知。此操作不可撤销。`；提交 `rejectOrder`；42221 错误 toast 提示先取消配送。
顶栏（§8）：左=店名+日期/营业状态(`localOpenNow`/`paused`)/打印机「未接入」灰点/告警数 `pendingAlerts`（>0 红点）+熔断时红条「快递100 余额不足已暂停呼叫」附「恢复」按钮(`resetKd100Circuit`)；右=stats 三项 / 日夜切换（`data-theme` 挂 `.wb` 根、localStorage `wb-theme` try/catch）/ 全屏（`requestFullscreen()` reject→`setFocusMode(true)` 加 `wb--focus`）/ 退出工作台（confirmDialog 文案**必须原样**：`工作台仍在后台接单、出票和播报，退出不影响来单提醒`→`navigate('/dashboard')`）。

- [ ] **Step 3: CancelAndRefundModal.tsx**

按 Interfaces 实现：Modal 内两步指示器（1 取消配送 → 2 退款）；step1 载入时调 `precancelDelivery` 展示「取消费约 ¥x.xx」，确认调 `cancelDelivery(orderId, '顾客申请取消')`；`hasActiveDelivery=false` 时直接从 step2 起；step2 红字金额确认调 `refundOrder(orderId, { amount: amountFen, reason: '顾客申请取消' })`；成功 `onDone()` 刷新快照。42238 错误提示「运力方响应超时，请稍后重试」，留在 step1。

- [ ] **Step 4: 编译 + 浏览器冒烟 + 提交**

```bash
cd apps/admin && npx tsc --noEmit && npm run build
```
预览验证（浏览器面板起 admin dev server + 后端 :3100 已常驻）：登录后访问 `/workbench`——五列渲染、mock 造 1 同城 1 邮寄待接单单（可用 e2e 片段手工 curl）确认同城在上、卡片三重编码、抽屉打开不被挤扁（塞 10+ 菜品单验证滚动）、日夜切换、<900px 横滑（`resize_window` 375px）、退出确认文案。截图留档。
```bash
git add apps/admin/src/pages/Workbench.tsx apps/admin/src/pages/Workbench.css apps/admin/src/components/CancelAndRefundModal.tsx apps/admin/src/App.tsx
git commit -m "feat(admin): 接单工作台页面——五列看板/抽屉/分级确认/拒单/顶栏（UI 规格 v1 全量）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task U4: `/local/orders` 历史页 + 路由落地页 + RefundDialog 配送费参考

**Files:**
- Create: `apps/admin/src/pages/LocalOrders.tsx`
- Modify: `apps/admin/src/App.tsx`（Layout 内加 `<Route path="local/orders" element={<LocalOrders />} />`）
- Modify: `apps/admin/src/components/Layout.tsx`（navItems 在「同城设置」上方加 `{ to: '/local/orders', label: '同城订单', icon: ClipboardList }`——图标与邮寄订单区分，可换 `History`）
- Modify: `apps/admin/src/pages/WebviewLogin.tsx`（落地页与白名单）
- Modify: `apps/admin/src/components/RefundDialog.tsx`（`deliveryCostFen?: number` 参考行）
- Modify: `docs/api.md`（workbench/snapshot 补记）

**Interfaces:**
- Consumes: U2 api（`getOrders({ deliveryType: 'LOCAL' })` 需后端支持——`GET /admin/orders` 已有 status/keyword 参数，若无 `deliveryType` 过滤则在本任务给 `routes/admin/orders.ts` 的列表查询补 `deliveryType` 可选参数，zod `z.enum(['EXPRESS','LOCAL']).optional()`，where 合并）、`getOrderDelivery`、StatusBadge。
- Produces:
  - LocalOrders 页：AfterSalePanel 式单列卡片；筛选（状态 tabs：全部/待接单/备餐中/配送中/已完成/已退款 + 关键字搜订单号或手机）；卡片=订单摘要+配送单状态徽标+骑手信息+金额（含配送费/小费/取消费）；卡片展开显示 DeliveryEvent 时间线（`getOrderDelivery`懒加载）；操作只留「退款」（开 RefundDialog 传 `deliveryCostFen`）与「查看工作台」链接——操作面在工作台，这里是查账页（规格 §10）。
  - WebviewLogin：`safeTo` 正则放宽到多段路径 `/^[a-z0-9-]+(\/[a-z0-9-]+)*(\?[^\s]*)?$/i`；默认落地 `'/orders?status=PAID'` 改为 `'/workbench'`。
  - RefundDialog：新可选 prop `deliveryCostFen?: number`；有值时金额输入框下加灰字参考行 `该单配送成本 ¥x.xx（已呼骑手/小费/取消费合计），退款金额不含此成本`——纯展示不参与校验。
- 登录后的默认跳转（`pages/Login.tsx` 成功后 navigate 目标）同步改 `/workbench`。

- [ ] **Step 1: 实现 + 编译**

按 Interfaces 实现四处改动与新页面。Run: `cd apps/admin && npx tsc --noEmit && npm run build` → 零错误。
若补了服务端 `deliveryType` 参数：`cd apps/server && npx tsc --noEmit` 且 e2e 全量回归一次。

- [ ] **Step 2: 浏览器冒烟 + 提交**

预览验证：`/m?code=…` 不可测（需小程序），改为直接断言 WebviewLogin 正则单测式验证——在浏览器 console 跑 `/^[a-z0-9-]+(\/[a-z0-9-]+)*(\?[^\s]*)?$/i.test('local/orders')` 为 true、`.test('//evil.com')` 为 false；`/local/orders` 页筛选与时间线展开正常；登录默认落地 `/workbench`。
```bash
git add apps/admin/src apps/server/src/routes/admin/orders.ts docs/api.md
git commit -m "feat(admin): 同城订单历史页 + 工作台设为默认落地页 + 退款弹窗配送费参考行

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task V: 真实联调 + 全量验收

**Files:** 无新代码（联调发现的问题按 systematic-debugging 修复并单独提交）；产出 `docs/research/2026-09-XX-kd100-integration-notes.md`（真实响应字段与 statusDesc 文案记录）。

**前置（店主手动，聊天里只提醒不经手）：** KD100_KEY/SECRET 由店主自行填到服务器 `.env`（本地联调则填本机 `apps/server/.env`）；**密钥值绝不进入仓库、聊天与截图**。回调需要公网可达的 `PUBLIC_BASE_URL`——在已部署的服务器上做，或本机内网穿透。

- [ ] **Step 1: 只读询价探测**

```bash
cd apps/server && npx ts-node --transpile-only scripts/selftest-kd100.ts --integration
```
Expected: 打出自贡门店→探测点的真实报价数组（只读不扣费）。失败先查 key/secret/企业认证状态。

- [ ] **Step 2: 一单全流程真实联调（花钱，先向店主确认时段）**

`LOCAL_DELIVERY_PROVIDER_MOCK=false` 重启后端：小程序真实下一笔同城单 → 工作台接单 → 呼叫骑手 → 观察回调逐拍推进（`GET /admin/local/orders/:id/delivery` 的 events）→ 送达。重点核实并记录：①batchOrder 真实响应字段名与本实现解析是否一致（fee/taskId/orderId/deliveryDistance）；②**并呼 720 语义**（未中标运力是否真的推 720、taskId 是否可区分——spec §5.4 遗留问号）；③各状态 statusDesc 原文。
第二单：呼叫成功后立即取消，核对 precancel/cancel 的 cancelFee 与账面扣费一致。

- [ ] **Step 3: 浏览器全量验收 + e2e 双跑**

工作台桌面 + 375px、日夜、全屏与退化、拒单全流程、`/local/orders`、`/orders` 行为不变；`bash scripts/e2e.sh` 连跑两次（间隔 60s）幂等全绿；`selftest-*` 三个全绿；tsc/build 零错误。

- [ ] **Step 4: 记录与提交**

联调笔记落 `docs/research/`（**不含任何密钥**），修正实现与 spec 中被真实响应推翻的假设，提交：
```bash
git add docs/research apps/server docs/superpowers/specs
git commit -m "docs(delivery): 快递100 真实联调笔记与实现修正

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
