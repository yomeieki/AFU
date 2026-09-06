/**
 * 管理端时间格式化 —— **全站唯一出口，一律按 Asia/Shanghai**。
 *
 * 为什么必须集中（2026-09-06 首单排查时抓到的问题）：
 * 库里存的是 UTC（Prisma 往 DATETIME 列写 UTC 墙钟），而 `new Date(iso).getHours()`
 * 之类按**看的人那台电脑**的时区解读。店主在东七区的电脑上打开工作台，首单 19:59
 * 发生的事会显示成 18:59；两个人用不同时区的电脑看同一张单会看到不同的时间。
 * 小票（services/ticket/content.ts）、语音播报、订阅消息都是对的——服务端一律按
 * Asia/Shanghai 算——**只有后台网页错**，所以一直没人怀疑。
 *
 * 比显示错更隐蔽的一类是**查错数据**：扫码统计用本地日拼查询区间，而服务端按
 * Asia/Shanghai 分桶（server utils/local-day.ts）。浏览器换个时区，「今日」就去查了
 * 昨天或明天那个桶，页面上不会有任何异常提示。所以 todayKey/shiftDayKey 也在这里。
 *
 * 这条规则由 scripts/check-admin-timezone.mjs 把守（本文件是它唯一的白名单），
 * 并挂在 apps/admin 的 build 前置上——deploy.sh 在生产机 build admin，回归即部署失败。
 *
 * 实现照 services/ticket/content.ts 的 fmtDateTime：用 formatToParts 自己拼，
 * 不直接吃 toLocaleString 的输出（各浏览器/各 ICU 版本对 zh-CN 的分隔符与
 * 前导零并不一致，拼出来的字符串会随环境漂移）。格式化器实例模块级缓存——
 * Intl.DateTimeFormat 的构造是这里最贵的一步，列表页每行都 new 一个会很明显。
 */
const TZ = 'Asia/Shanghai'
const EMPTY = '--'

const DT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

type Input = string | number | Date | null | undefined

/** 解析成 Date；拿不到有效时间一律返回 null，由各 fmt 自己决定显示什么 */
function toDate(v: Input): Date | null {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

function parts(d: Date): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of DT.formatToParts(d)) out[p.type] = p.value
  // zh-CN 的 hour12:false 在部分 ICU 版本下把午夜给成 "24"，规格化回 "00"，
  // 否则「00:05」会显示成「24:05」——不是崩溃，是安静地显示了一个不存在的时间。
  if (out.hour === '24') out.hour = '00'
  return out
}

/** 'YYYY-MM-DD HH:mm' */
export function fmtDateTime(v: Input, empty = EMPTY): string {
  const d = toDate(v); if (!d) return empty
  const p = parts(d)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/** 'YYYY-MM-DD HH:mm:ss'——只给真正需要看到秒的地方（事件时间线、打印任务） */
export function fmtDateTimeSec(v: Input, empty = EMPTY): string {
  const d = toDate(v); if (!d) return empty
  const p = parts(d)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

/** 'YYYY-MM-DD' */
export function fmtDate(v: Input, empty = EMPTY): string {
  const d = toDate(v); if (!d) return empty
  const p = parts(d)
  return `${p.year}-${p.month}-${p.day}`
}

/** 'HH:mm' */
export function fmtHHmm(v: Input, empty = EMPTY): string {
  const d = toDate(v); if (!d) return empty
  const p = parts(d)
  return `${p.hour}:${p.minute}`
}

/** 'M-DD HH:mm'——工作台抽屉那种「今天前后几天」的紧凑写法 */
export function fmtMonthDayTime(v: Input, empty = EMPTY): string {
  const d = toDate(v); if (!d) return empty
  const p = parts(d)
  return `${Number(p.month)}-${p.day} ${p.hour}:${p.minute}`
}

/** 'M 月 D 日'——工作台顶栏那种给人读的写法 */
export function fmtMonthDayCn(v: Input, empty = EMPTY): string {
  const d = toDate(v); if (!d) return empty
  const p = parts(d)
  return `${Number(p.month)} 月 ${Number(p.day)} 日`
}

/**
 * 上海时区的「今天」日期键（YYYY-MM-DD）。
 * 扫码统计的查询区间必须用它而不是本地日——服务端按 Asia/Shanghai 分桶，
 * 用浏览器本地日拼区间会在别的时区查到相邻那一天的桶。
 */
export function todayKey(now: Date = new Date()): string {
  return fmtDate(now, '')
}

/**
 * 以上海时区的今天为基准，偏移 n 天的日期键（n 为负数表示往前）。
 *
 * 先取上海时区的 Y-M-D，再用 Date.UTC 在**无时区的纯日期**上做加减——
 * 不能用 `d.setDate(d.getDate() + n)`：那是在本地时区上算，跨月/跨年时
 * 会把上面刚校正好的上海日期又拉回本地日期。
 */
export function shiftDayKey(n: number, now: Date = new Date()): string {
  const [y, m, d] = todayKey(now).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  const p = (v: number) => String(v).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
}
