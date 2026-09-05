/**
 * 会员两个「每日一次」定时任务（expirePoints/expireCoupons）的执行判定。
 * 用 Setting(key='member_cron_state') 记录上次成功执行的时间戳，到日切才跑：
 * 避免进程重启后重复跑一整天多次，也避免因为某次 tick 异常一整天都没跑上。
 * tick 间隔（60s）远小于一天，进程只要存活就一定会跨过日切那一刻。
 */
import prisma from '../../utils/prisma'

const KEY = 'member_cron_state'

export interface MemberCronState {
  lastExpirePointsAt: string | null
  lastExpireCouponsAt: string | null
}

const DEFAULT_STATE: MemberCronState = { lastExpirePointsAt: null, lastExpireCouponsAt: null }

export async function getCronState(): Promise<MemberCronState> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: KEY } })
    if (!row) return DEFAULT_STATE
    const parsed = JSON.parse(row.value) as Partial<MemberCronState>
    return {
      lastExpirePointsAt: typeof parsed.lastExpirePointsAt === 'string' ? parsed.lastExpirePointsAt : null,
      lastExpireCouponsAt: typeof parsed.lastExpireCouponsAt === 'string' ? parsed.lastExpireCouponsAt : null,
    }
  } catch {
    return DEFAULT_STATE
  }
}

export async function patchCronState(patch: Partial<MemberCronState>): Promise<void> {
  const current = await getCronState()
  const json = JSON.stringify({ ...current, ...patch })
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: json }, update: { value: json } })
}

/** 两个时间是否落在同一个（服务器本地时区的）日历日 */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
