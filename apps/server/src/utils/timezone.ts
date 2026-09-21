/**
 * 服务端固定北京时间（2026-09-21）：换服务器 / PM2 配置变成 UTC 时，所有「按上海自然日」的
 * 逻辑（经营概览、扫码统计、订单日期筛选、自取时段、营业时间、会员每日任务日切——见
 * utils/local-day.ts、services/member/cron-state.ts 等按**进程本地时区**换算的实现）
 * 不能错 8 小时且不能静默。纯函数，不 import 任何业务模块（供 config.ts 在最早期调用）。
 *
 * 2026-09-21 实测（本机 Node v25.9.0）：
 *  - `process.env.TZ = 'Asia/Shanghai'` 后 `Date.prototype.getTimezoneOffset()` 立刻从旧值
 *    变为 -480，**先前已创建的 Date 对象**的 `getHours()` 等也随之变化，
 *    `Intl.DateTimeFormat().resolvedOptions().timeZone` 变成 'Asia/Shanghai'（Node ≥ 13
 *    支持运行时改 TZ，生产 `deploy.sh` 要求 Node ≥ 18，达标）。
 *  - 赋一个不存在的时区名（如误配成 'Not/AZone'）会**静默回落到 UTC**（偏移 0），
 *    `process.env.TZ` 变量本身仍显示那个错误的名字——这是服务器缺 tzdata 时最可能出现的
 *    失败模式，必须靠 `checkTimezone` 的自检抓，不能只看 `env.TZ` 有没有设置。
 */

export const TARGET_TZ = 'Asia/Shanghai'
export const TARGET_OFFSET_MIN = -480

export interface PinResult {
  /** 进程原本的 TZ（pin 之前），未设置则为 undefined */
  previous: string | undefined
  /** 是否发生了覆盖（原值与目标不同，含原本未设置的情况） */
  overridden: boolean
}

/**
 * 无条件把 env.TZ 钉成 Asia/Shanghai（覆盖，不是「缺省才填」）。
 * 目标是「换服务器 / PM2 写成 UTC 也不错」——如果只在缺省时才填，PM2 显式给
 * `TZ=UTC` 时这道防线就失效了，所以必须无条件覆盖。
 */
export function pinTimezone(env: NodeJS.ProcessEnv = process.env): PinResult {
  const previous = env.TZ
  env.TZ = TARGET_TZ
  return { previous, overridden: previous !== TARGET_TZ }
}

export interface CheckResult {
  ok: boolean
  offsetMin: number
  /** Intl 解析出的实际生效时区名；与 TARGET_TZ 不同或偏移不对都说明钉死没生效 */
  resolved: string
}

/**
 * 自检：偏移必须是 -480 且 Intl 解析出的时区名必须是 Asia/Shanghai。
 * 两个条件都要——只看偏移会被「巧合出现 -480 偏移的其它时区」骗过（理论上不存在这种命名
 * 冲突，但两个独立信号比一个更抗静默失败，尤其是 §「赋错时区名静默回落到 UTC」这种情形，
 * offset 会变成 0，光看 offset 也能抓到，但把 resolved 一起断言更直接、报错信息更有用）。
 */
export function checkTimezone(now: Date = new Date()): CheckResult {
  const offsetMin = now.getTimezoneOffset()
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  return { ok: offsetMin === TARGET_OFFSET_MIN && resolved === TARGET_TZ, offsetMin, resolved }
}

export interface TimezoneReport extends CheckResult {
  overridden: boolean
  previousEnvTz: string | null
}

/**
 * pin + check 的组合入口，供 config.ts 在启动早期调用一次。
 * 生产环境自检失败：打 error 日志 + 拒绝启动（exit(1)）——见 §3.2 第 4 条设计理由：
 * 钉死之后自检还失败，只剩「服务器缺 tzdata / Node 不支持运行时改 TZ」两种部署环境问题，
 * 此时全部自然日逻辑都会错 8 小时，生产带错上线比停下来修 tzdata 更糟。
 * 非生产环境只 warn，不拒绝启动（本机/联调环境不强求时区正确，只提示）。
 * `exit`/`log` 可注入，方便自测不真的退出进程。
 */
export function enforceTimezone(opts: {
  isProduction: boolean
  log?: Pick<Console, 'error' | 'warn'>
  exit?: (code: number) => void
  now?: Date
  pin?: PinResult
}): TimezoneReport {
  const log = opts.log ?? console
  const exit = opts.exit ?? process.exit
  const check = checkTimezone(opts.now)
  const overridden = opts.pin?.overridden ?? false
  const previousEnvTz = opts.pin?.previous ?? null

  if (overridden) {
    log.warn(`[timezone] 环境 TZ=${previousEnvTz ?? '(未设置)'} 已被覆盖为 ${TARGET_TZ}`)
  }
  if (!check.ok) {
    const detail = `offset=${check.offsetMin}, resolved=${check.resolved}, env.TZ=${process.env.TZ}`
    if (opts.isProduction) {
      log.error(
        `[timezone] 进程时区不是 ${TARGET_TZ}（${detail}）：多半是服务器缺 tzdata 或 Node 不支持运行时改 TZ，服务拒绝启动`
      )
      exit(1)
    } else {
      log.warn(`[timezone] 进程时区不是 ${TARGET_TZ}（${detail}），非生产环境不拒绝启动`)
    }
  }
  return { ...check, overridden, previousEnvTz }
}
