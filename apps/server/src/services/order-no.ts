/**
 * 单号生成 —— **当日流水号**。
 *
 * 为什么换掉随机数（2026-09-07）：
 * 小票和工作台现在都只显示后四位——整串「ORD+日期+序号」在票面上没法逐位比对，
 * 这是店主定的口径。可旧实现是 `ORD + 日期 + 六位随机数`，后四位就是均匀随机的
 * 一万个数。生日问题下，同一天 100 单出现重号的概率 39%，200 单 86%；造预览时
 * 9 张单就撞出一对 #8779。撞号之后店员拿着票在工作台上点「同意退款」，退的可能
 * 是另一个人的钱——这是这次必须改掉它的原因。
 *
 * 换成当日流水后：后四位 = 当天第几单，**当天内保证唯一**，还自带先后顺序，
 * 跟餐馆叫号是同一个心智模型。新号 15 位、旧号 18 位，两者不可能重号，
 * 所以历史单不用动。
 *
 * ── 两个必须写下来的实现选择 ──────────────────────────────────────────
 *
 * ① 日界按 **Asia/Shanghai**，不用进程时区。旧实现用 `new Date().getDate()`，
 *    那是服务器本地日期；生产机是 CST 所以看不出问题，但只要进程时区不是 CST，
 *    每天有一段时间会取到相邻的日期，于是那段时间的单号挂到别的日子那一格上，
 *    跟那天的单撞号——正是这次要消灭的东西。
 *
 * ② 取号 **不放进下单事务**。放进去等于给计数器那一行加锁并持有到整笔交易结束
 *    （券核销、积分、库存扣减都在同一个事务里），下单会被彻底串行化。
 *    代价是下单失败会烧掉一个号，中间留个空档；这是给人读的号、不是会计流水，
 *    空档无所谓。
 */
import prisma from '../utils/prisma'

const DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
})

/** Asia/Shanghai 的 `YYYYMMDD`。en-CA 给的就是 `YYYY-MM-DD`，去掉连字符即可 */
export function shanghaiDayKey(at: Date = new Date()): string {
  return DAY_FMT.format(at).replace(/-/g, '')
}

/**
 * 原子取号。`LAST_INSERT_ID(expr)` 会把 expr 记到**本连接**的 LAST_INSERT_ID 上，
 * 于是自增和读取合成一条语句、并发下不会发重号；VALUES 那侧也要写 `LAST_INSERT_ID(1)`，
 * 否则当天第一单走的是 INSERT 分支，表里没有 AUTO_INCREMENT 列，LAST_INSERT_ID()
 * 会返回上一次的旧值（新连接上是 0）。
 *
 * 两条语句必须落在同一个连接上——Prisma 是连接池，所以套一层交互式事务把连接钉住。
 * 这个事务只碰计数器一行，两条语句就提交。
 */
async function nextSeq(dayKey: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO order_no_seq (day_key, seq) VALUES (${dayKey}, LAST_INSERT_ID(1))
      ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)`
    const rows = await tx.$queryRaw<{ seq: bigint | number }[]>`SELECT LAST_INSERT_ID() AS seq`
    return Number(rows[0]?.seq ?? 0)
  })
}

/**
 * `ORD` + 8 位日期 + 4 位当日流水，例如 `ORD202609070087`（今天第 87 单，票面显示 `#0087`）。
 *
 * 超过 9999 单/天时流水位自然变长，后四位这才可能重复一次——本店日均两位数，
 * 真到那个量级时该做的是把票面位数一起加宽，而不是在这里悄悄取模。
 *
 * 兜底重试：只有在计数器被人为重置（还原旧库、手工清表）时才可能撞上已存在的号。
 * 撞上就再取一个，不做别的补偿——`orders.order_no` 上的唯一索引是最后一道闸。
 */
export async function allocateOrderNo(at: Date = new Date()): Promise<string> {
  const dayKey = shanghaiDayKey(at)
  for (let i = 0; i < 5; i++) {
    const orderNo = `ORD${dayKey}${String(await nextSeq(dayKey)).padStart(4, '0')}`
    if (!(await prisma.order.findUnique({ where: { orderNo }, select: { id: true } }))) return orderNo
  }
  throw new Error(`单号连续 5 次重复，检查 order_no_seq 是否被重置：day_key=${dayKey}`)
}
