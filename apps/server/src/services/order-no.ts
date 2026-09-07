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
 * 换成当日流水后后四位当天唯一。但**流水号不能直接印在票上**（PO 2026-09-07 追加）：
 * `#0087` 等于告诉顾客「你是今天第 87 单」，中午一单、晚上一单就能算出当天的营业量，
 * 这是外人不该知道的经营数据。
 *
 * 所以取号仍走流水（唯一性靠它），显示前再过一层 **4 轮 Feistel 置换**：
 * 0000–9999 一一映射到 0000–9999，是**双射**，所以「当天唯一」原样保住；
 * 而相邻流水映射出来的值毫无关联（1→7314、2→0925、3→4460），看不出先后、
 * 更算不出总量。置换的密钥里掺了日期，所以换一天整张映射表就变了，
 * 拿昨天的号推今天也无效。
 *
 * 新号 15 位、旧号 18 位，两者不可能重号，所以历史单不用动。
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

// ── 把流水号打散成看不出顺序的四位数 ─────────────────────────────────────
//
// 4 轮平衡 Feistel，两半各 0–99（100 × 100 = 10000）。Feistel 的性质：**无论轮函数
// 是什么，整体都是双射**——这正是这里需要的，因为「当天唯一」全靠双射保住，
// 不能退化成「随机数 + 查重」（那要么有并发竞态，要么要额外的重试）。
//
// 密钥只写在代码里，没有放进 .env：它防的是顾客拿着两张小票倒推营业量，不是防拿到
// 源码的人。真要提高强度，把 SCRAMBLE_KEY 挪到环境变量即可，但**换密钥会让当天已发
// 出的号与之后的号落在两张映射表上**，同一天内可能撞号——只能在跨日的时候换。
const SCRAMBLE_KEY = 0x5f3a9c7b

/** 32 位雪崩混合。轮函数只要求「输入变一点、输出面目全非」，不要求可逆 */
function mix(x: number): number {
  let h = x >>> 0
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0
  h ^= h >>> 13; h = Math.imul(h, 3266489917) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/** 日盐：同一个流水号在不同日期映射到不同的四位数，昨天的号推不出今天的 */
function daySalt(dayKey: string): number {
  return mix(Number(dayKey) ^ SCRAMBLE_KEY)
}

/** 0–9999 → 0–9999 的双射 */
export function scramble4(n: number, dayKey: string): number {
  const salt = daySalt(dayKey)
  let l = Math.floor(n / 100) % 100
  let r = n % 100
  for (let i = 0; i < 4; i++) {
    const f = mix(r ^ Math.imul(salt ^ i, 0x9e3779b1)) % 100
    const prevL = l
    l = r
    r = (prevL + f) % 100
  }
  return l * 100 + r
}

/**
 * `ORD` + 8 位日期 + 4 位**打散后**的当日号，例如 `ORD202609077314`，票面显示 `#7314`。
 * 当天内唯一（双射保证），但看不出是第几单。
 *
 * 超过 9999 单/天时会多出一位（`ORD` + 日期 + 4 位 + 圈数），此时后四位才可能重复一次。
 * 本店日均两位数，真到那个量级该做的是把票面位数一起加宽，而不是在这里悄悄取模。
 *
 * 兜底重试：只有在计数器被人为重置（还原旧库、手工清表）时才可能撞上已存在的号。
 * 撞上就再取一个，不做别的补偿——`orders.order_no` 上的唯一索引是最后一道闸。
 */
export async function allocateOrderNo(at: Date = new Date()): Promise<string> {
  const dayKey = shanghaiDayKey(at)
  for (let i = 0; i < 5; i++) {
    const seq = await nextSeq(dayKey)
    const cycle = Math.floor(seq / 10000)
    const orderNo = `ORD${dayKey}${String(scramble4(seq % 10000, dayKey)).padStart(4, '0')}${cycle || ''}`
    if (!(await prisma.order.findUnique({ where: { orderNo }, select: { id: true } }))) return orderNo
  }
  throw new Error(`单号连续 5 次重复，检查 order_no_seq 是否被重置：day_key=${dayKey}`)
}
