/**
 * D4（2026-09-24）：一次性脚本，补回生产上「回调先于下单同步响应到达」这个竞态（P1/P2 修复前）
 * 留下的历史缺口——配送单缺 providerTaskId/providerOrderId/calledAt/quotedFee/
 * providerDistanceM，但 delivery_events 里其实已经有 CALLBACK 事件把这些信息带回来了
 * （生产实测：D33-1 五条、D32-1 一条，raw_payload 外层带 taskId、param 里带 orderId）。
 *
 * ⚠️ 只写一次性脚本，不接入任何自动化：
 *   - 只在 e2e 库验证过，**不得对生产或本机主库 `food_shop` 执行**；
 *   - 生产执行前先跑一次 `--dry-run` 把打印结果给店主确认，再由编排者另行授权执行；
 *   - 只回填当前为 NULL 的列（`updateMany({where:{id, <col>:null}})`），不会覆盖任何已有值，
 *     可以放心重复跑——已经补过的行第二次跑会显示「0 行需要修改」。
 *
 * 用法：
 *   npx ts-node --transpile-only scripts/repair-delivery-ids.ts --dry-run [--delivery-no D33-1]
 *   npx ts-node --transpile-only scripts/repair-delivery-ids.ts --dry-run --scan
 *   npx ts-node --transpile-only scripts/repair-delivery-ids.ts --yes [--delivery-no D33-1]
 *
 * 不带 --dry-run 时必须带 --yes，否则拒绝执行并提示（防止误触真的写库）。
 */
import 'dotenv/config'
import { PrismaClient, Prisma } from '@prisma/client'

const prisma = new PrismaClient()

const args = process.argv.slice(2)
const has = (flag: string) => args.includes(flag)
const valueOf = (flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const DRY_RUN = has('--dry-run')
const YES = has('--yes')
const SCAN = has('--scan')
const DELIVERY_NO = valueOf('--delivery-no') ?? 'D33-1'

type ProviderQuote = { provider?: unknown; feeFen?: unknown; distanceM?: unknown }

function parseParam(rawPayload: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return null
  const obj = rawPayload as Record<string, unknown>
  const paramStr = obj.param
  if (typeof paramStr !== 'string') return null
  try {
    const p = JSON.parse(paramStr) as Record<string, unknown>
    return p
  } catch {
    return null
  }
}
function outerTaskId(rawPayload: Prisma.JsonValue | null): string | null {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return null
  const v = (rawPayload as Record<string, unknown>).taskId
  return typeof v === 'string' && v ? v : null
}

function findQuote(list: unknown, provider: string): { feeFen: number | null; distanceM: number | null } | null {
  const arr = Array.isArray(list) ? (list as ProviderQuote[]) : null
  const hit = arr?.find((q) => q?.provider === provider)
  if (!hit) return null
  return {
    feeFen: typeof hit.feeFen === 'number' ? hit.feeFen : null,
    distanceM: typeof hit.distanceM === 'number' ? hit.distanceM : null,
  }
}

interface Plan {
  deliveryId: number
  deliveryNo: string
  providerTaskId: string | null
  providerOrderId: string | null
  calledAt: string | null
  quotedFee: number | null
  providerDistanceM: number | null
  sourceEventIds: number[]
}

async function computePlan(deliveryNo: string): Promise<Plan | null> {
  const d = await prisma.delivery.findUnique({ where: { deliveryNo } })
  if (!d) {
    console.error(`✘ 找不到配送单 ${deliveryNo}`)
    return null
  }
  const events = await prisma.deliveryEvent.findMany({
    where: { deliveryId: d.id, source: 'CALLBACK' },
    orderBy: { id: 'asc' },
    select: { id: true, rawPayload: true, createdAt: true },
  })
  if (events.length === 0) {
    console.error(`✘ ${deliveryNo} 没有 CALLBACK 事件，无法补录（没有回调原文可用）`)
    return null
  }

  const sourceEventIds: number[] = []
  let taskId: string | null = d.providerTaskId
  let orderId: string | null = d.providerOrderId
  let calledAt: Date | null = d.calledAt
  let winner: string | null = d.courierCompany

  const firstEvent = events[0]
  if (!taskId) {
    taskId = outerTaskId(firstEvent.rawPayload) ?? (() => {
      const p = parseParam(firstEvent.rawPayload)
      const v = p?.taskId
      return typeof v === 'string' && v ? v : null
    })()
    if (taskId) sourceEventIds.push(firstEvent.id)
  }
  if (!orderId) {
    for (const ev of events) {
      const p = parseParam(ev.rawPayload)
      const v = p?.orderId
      if (typeof v === 'string' && v) { orderId = v; sourceEventIds.push(ev.id); break }
      if (typeof v === 'number') { orderId = String(v); sourceEventIds.push(ev.id); break }
    }
  }
  if (!calledAt) {
    calledAt = firstEvent.createdAt
    sourceEventIds.push(firstEvent.id)
  }
  if (!winner) {
    // 回退最后一条带 kuaidicom 的回调（中标方通常是最后确定的）
    for (let i = events.length - 1; i >= 0; i--) {
      const p = parseParam(events[i].rawPayload)
      const v = p?.kuaidicom
      if (typeof v === 'string' && v) { winner = v; sourceEventIds.push(events[i].id); break }
    }
  }

  let quotedFee: number | null = d.quotedFee
  let providerDistanceM: number | null = d.providerDistanceM
  if (winner && (quotedFee === null || providerDistanceM === null)) {
    const fromOrderFees = findQuote(d.orderFees, winner)
    const snapshot = d.quoteSnapshot as { quotes?: unknown } | null
    const fromSnapshot = findQuote(snapshot?.quotes, winner)
    if (quotedFee === null) quotedFee = fromOrderFees?.feeFen ?? fromSnapshot?.feeFen ?? null
    if (providerDistanceM === null) providerDistanceM = fromOrderFees?.distanceM ?? fromSnapshot?.distanceM ?? null
  }

  return {
    deliveryId: d.id, deliveryNo: d.deliveryNo,
    providerTaskId: taskId, providerOrderId: orderId,
    calledAt: calledAt ? calledAt.toISOString() : null,
    quotedFee, providerDistanceM,
    sourceEventIds: [...new Set(sourceEventIds)],
  }
}

async function runScan(): Promise<void> {
  const rows = await prisma.delivery.findMany({
    where: { OR: [{ providerTaskId: null }, { providerOrderId: null }] },
    select: { id: true, deliveryNo: true, providerTaskId: true, providerOrderId: true },
  })
  const out: { deliveryNo: string; hasCallbackWithTaskId: boolean }[] = []
  for (const r of rows) {
    const ev = await prisma.deliveryEvent.findFirst({
      where: { deliveryId: r.id, source: 'CALLBACK' },
      select: { id: true, rawPayload: true },
    })
    if (!ev) continue
    const hasTaskId = !!outerTaskId(ev.rawPayload) || !!parseParam(ev.rawPayload)?.taskId
    if (hasTaskId) out.push({ deliveryNo: r.deliveryNo, hasCallbackWithTaskId: true })
  }
  console.log(JSON.stringify(out, null, 2))
  console.log(`共 ${out.length} 条缺 taskId/orderId 且有含 taskId 回调原文的行`)
}

async function main(): Promise<void> {
  if (!DRY_RUN && !YES) {
    console.error('拒绝执行：不带 --dry-run 时必须带 --yes（防止误触真的写库）。先跑 --dry-run 核对结果。')
    process.exitCode = 1
    return
  }
  if (SCAN) {
    await runScan()
    return
  }
  const plan = await computePlan(DELIVERY_NO)
  if (!plan) { process.exitCode = 1; return }

  if (DRY_RUN) {
    console.log(JSON.stringify(plan, null, 2))
    console.log('（dry-run，未写库）')
    return
  }

  // 只写一次性脚本，不接生产/主库：每次跑都打印目标库连到哪（DATABASE_URL 由调用方通过
  // 环境变量指定，见文件头用法），避免在错误的库上执行——这不是护栏，只是最后一道人眼检查。
  console.log(`目标库：${process.env.DATABASE_URL ?? '（未设置 DATABASE_URL）'}`)
  console.log(JSON.stringify(plan, null, 2))

  let changed = 0
  if (plan.providerTaskId !== null) {
    changed += (await prisma.delivery.updateMany({ where: { id: plan.deliveryId, providerTaskId: null }, data: { providerTaskId: plan.providerTaskId } })).count
  }
  if (plan.providerOrderId !== null) {
    changed += (await prisma.delivery.updateMany({ where: { id: plan.deliveryId, providerOrderId: null }, data: { providerOrderId: plan.providerOrderId } })).count
  }
  if (plan.calledAt !== null) {
    changed += (await prisma.delivery.updateMany({ where: { id: plan.deliveryId, calledAt: null }, data: { calledAt: new Date(plan.calledAt) } })).count
  }
  if (plan.quotedFee !== null) {
    changed += (await prisma.delivery.updateMany({ where: { id: plan.deliveryId, quotedFee: null }, data: { quotedFee: plan.quotedFee } })).count
  }
  if (plan.providerDistanceM !== null) {
    changed += (await prisma.delivery.updateMany({ where: { id: plan.deliveryId, providerDistanceM: null }, data: { providerDistanceM: plan.providerDistanceM } })).count
  }

  console.log(changed > 0 ? `✔ 已回填 ${changed} 列` : '0 行需要修改（已回填过，或没有可回填的值）')
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
