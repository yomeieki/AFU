import { Prisma } from '@prisma/client'

/**
 * P2034 = Prisma 对 MySQL 1213（Deadlock found when trying to get lock）的映射。
 * 1205（锁等待超时）在本仓库 `innodb_lock_wait_timeout`（50s）远大于事务 `timeout`（15s）
 * 的配置下，实际总是先撞事务 timeout 变成 P2028，不在这里出现，因此不重试 P2028。
 */
export function isDeadlockError(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface DeadlockRetryOptions {
  attempts?: number
  baseDelayMs?: number
}

/**
 * 整事务重试兜底。固定锁序（见 docs/superpowers/plans/2026-09-24-order-deadlock.md §0.4）
 * 已经消灭了本批覆盖路径的死锁；这里只兜本方案未覆盖的残余环（如后台整包编辑商品按请求体
 * 顺序锁 sku——见方案「留后」）。只重试 P2034，其余错误（含业务 AppError、P2002、P2028）
 * 原样上抛，不重试——尤其是幂等键冲突（P2002）：它不是死锁，重试没有意义，必须让调用方
 * 自己的「查赢家」逻辑去处理。
 *
 * 日志文案固定为「下单遇死锁」（不随 label 变化），是验收/e2e 用来计数的锚点，改动前确认
 * 没有 `grep '下单遇死锁'` 依赖这个字符串。
 */
export async function withDeadlockRetry<T>(label: string, fn: () => Promise<T>, opts: DeadlockRetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5
  const baseDelayMs = opts.baseDelayMs ?? 50
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (isDeadlockError(e) && attempt < attempts) {
        console.warn(`[${label}] 下单遇死锁，重试 ${attempt}/${attempts}`)
        await sleep(baseDelayMs * attempt + Math.random() * 30)
        continue
      }
      throw e
    }
  }
  /* istanbul ignore next -- 循环要么在某次 attempt 里 return，要么在最后一次 attempt 里 throw */
  throw new Error('withDeadlockRetry: unreachable')
}
