/**
 * 统计口径：只算真实经营数据，排除联调/回归留在正式库里的测试单。
 *
 * 为什么抽成常量：接入点已经有 10 处（后台概览 3、工作台 3、趋势 1、扫码转化 2、按商品转化 1），
 * 在每处手写 `isTest: false` 的话，将来新增一个统计查询必然漏掉一处，而漏掉是「静默」的——
 * 数字看着正常，只是偷偷多算了几笔测试单。**新增任何统计查询都必须 spread REAL_ORDERS
 * （原生 SQL 用 realOrdersSql()），不要手写字面量。**
 *
 * 口径是实时的、不是快照：把一张已经计入过统计的单标成测试单，之前的日期区间数字会**回溯性**
 * 变小（趋势图上那天的柱子会矮下去）。这正是我们要的——联调那几天的假峰应该消失——但要知道
 * 它会变，别在事后对不上历史截图时以为出了 bug。
 *
 * 挡不住的地方：热销榜读 Product.salesCount 冗余列（下单瞬间 +1，与订单行无关），
 * 加多少 where 都过滤不掉。那条靠「联调用专门的测试商品、联调后软删除」隔离，
 * 详见 docs/ops-test-orders.md。
 */
import { Prisma } from '@prisma/client'

/** Prisma where 片段：`where: { ...REAL_ORDERS, 其它条件 }` */
export const REAL_ORDERS = { isTest: false } as const

/**
 * 原生 SQL 片段（对象没法 spread 进 $queryRaw）：拼在 WHERE 后面，自带前导 AND。
 * @param alias orders 表的别名，如 `o`；无别名传空
 *
 * 用 Prisma.raw 是因为标识符不能参数化。alias 只允许字母数字下划线，
 * 且调用点全是代码里写死的字面量，不接受任何外部输入。
 */
export function realOrdersSql(alias = ''): Prisma.Sql {
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`realOrdersSql: 非法表别名 ${alias}`)
  }
  return Prisma.raw(`AND ${alias ? `${alias}.` : ''}is_test = FALSE`)
}
