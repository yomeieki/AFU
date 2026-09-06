import { Prisma } from '@prisma/client'

/**
 * 「按本地自然日分桶」的唯一实现。原生 SQL 侧提取 + JS 侧归桶，两边必须成对使用。
 *
 * ⚠️ **今后任何按天分桶的原生查询都必须用这一对，不许再各写一份。**
 * 这条不是洁癖：`stats.ts` 的 `/trend` 修过一次这个 bug，但当时没有搜同样的模式还出现在哪，
 * 于是 `scan-stats.ts` 里一模一样的写法原样留在线上（后台「独立访客」因此长期显示 0）。
 * 把实现收成一处，就是为了让下一次修复自动覆盖所有调用点。
 *
 * ── 为什么不能直接 `GROUP BY DATE(created_at)` ──────────────────────────────
 *
 * `created_at` 是 DATETIME(3)，Prisma 以 **UTC 墙钟**写入（2026-09-06 实测：本地 JST 01:23
 * 落库是 15:48 UTC）。MySQL 的 `DATE()` 是纯提取、不做任何时区换算，所以它给出的是 **UTC 日期**；
 * 而 JS 侧若用 `getFullYear/getMonth/getDate` 拼 key，给出的是 **进程本地日期**。
 * 两者只有在「数据库时区 == 进程时区」时才碰巧一致——生产两边都是 CST 所以看不出问题，
 * 但本机 Docker MySQL 跑 UTC、Node 跑 JST，每天 JST 00:00–09:00 这段时间里今天的数据会被
 * 归进昨天那一桶，趋势图直接错位一天。
 *
 * 修法不是「把两边都钉到系统时区」——那只是把巧合固化。这里让 SQL 只做**不涉及时区的提取**
 * （年月日 + 小时），JS 侧用真实 Date 把它还原成瞬时再按本地日历归桶。这样跨夏令时也正确，
 * 且不需要在任何地方硬编码偏移量。30 天窗口最多 720 行，代价可以忽略。
 *
 * ⚠️ **适用前提：整小时的 UTC 偏移。** 按 UTC 整小时聚合、再用桶的起点落本地日历，
 * 对 CST/JST 这类整小时偏移完全正确；对半小时偏移的时区（+5:30 印度、+5:45 尼泊尔、
 * +3:30 伊朗、+9:30 阿德莱德、−3:30 纽芬兰）会有半小时的边界错位。生产是 CST，不受影响；
 * 真要支持半小时偏移，把提取粒度降到分钟即可（`localDayPartsSql` 多提一个 `MINUTE(col)`）。
 *
 * 仍然承载的唯一假设：**落库值是 UTC**。这条假设本来就是全站承重的（`created_at >= ${start}`
 * 这类比较同样依赖它），不是本模块新引入的。
 *
 * ── 一个调用方必须自己想清楚的坑：聚合函数可不可加 ──────────────────────────
 *
 * 本模块按**小时**分桶、再在 JS 侧合并成天。`COUNT(*)` / `SUM()` 跨小时**可加**，直接相加即可；
 * 但 `COUNT(DISTINCT x)` **不可加**——同一个 x 出现在同一天的两个小时里，按小时算再相加会数成 2。
 * 需要去重计数时，把那一列也放进 `GROUP BY`，在 JS 侧用 `Set` 归并（见 `scan-stats.ts` 的 `/trend`）。
 */

/** SQL 提取出来的原始分量。数值来自 MySQL，可能是 number 也可能是 bigint，用 `Number()` 收口 */
export interface LocalDayParts {
  y: number | bigint
  mo: number | bigint
  d: number | bigint
  h: number | bigint
}

/** 列名只允许 `col` 或 `t.col`：它要走 Prisma.raw（标识符不能参数化），必须自己把住 */
const IDENT = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)?$/

/**
 * SELECT 片段：`YEAR(col) y, MONTH(col) mo, DAY(col) d, HOUR(col) h`。
 * **纯提取，不做任何时区换算**——这正是它能配合 `localDayKeyFromParts` 得出正确结果的原因。
 */
export function localDayPartsSql(column = 'created_at'): Prisma.Sql {
  if (!IDENT.test(column)) throw new Error(`非法列名: ${column}`)
  const c = Prisma.raw(column)
  return Prisma.sql`YEAR(${c}) y, MONTH(${c}) mo, DAY(${c}) d, HOUR(${c}) h`
}

/** 配 `GROUP BY` 用。与 `localDayPartsSql` 的别名同源，避免两处各写一串导致别名对不上 */
export const LOCAL_DAY_GROUP_BY: Prisma.Sql = Prisma.raw('y, mo, d, h')

/** 本地自然日键 `YYYY-MM-DD`。JS 侧的唯一取键方式 */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 把 SQL 提取出的「UTC 年月日时」还原成瞬时，再按**本地**日历取键。
 * 两次换算都交给 `Date` 完成，任何地方都不出现硬编码的偏移量。
 */
export function localDayKeyFromParts(r: LocalDayParts): string {
  return localDayKey(new Date(Date.UTC(Number(r.y), Number(r.mo) - 1, Number(r.d), Number(r.h))))
}
