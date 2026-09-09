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
    select: { id: true, bookingNo: true, orderNo: true, kuaidicom: true, kuaidinum: true, deliveredAt: true, staleRemindedAt: true, order: { select: { status: true } } },
  })
  console.log('booking_id\tbooking_no\torder_no\torder_status\tkuaidicom\tkuaidinum\tdelivered_at\treminded')
  for (const r of rows) console.log([r.id, r.bookingNo, r.orderNo, r.order.status, r.kuaidicom, r.kuaidinum ?? '', r.deliveredAt?.toISOString() ?? '', r.staleRemindedAt ? 'Y' : 'N'].join('\t'))
  console.log(`\n共 ${rows.length} 条。处理方式：工作台对该订单「填单号发货」→「确认收货」；或联系开发核对。`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
