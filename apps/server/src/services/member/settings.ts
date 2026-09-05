/**
 * 会员设置：settings 表（key='member'）的读写 + 进程内缓存。
 * 结构与缓存范式照抄 ../settings.ts（运费设置）。
 *
 * 与运费设置的一处关键不同：读失败时的兜底值不是「正常默认值」，而是
 * `points.enabled=false` 的保守值——运费读失败最坏后果是少收了运费，
 * 而积分读失败若仍按「默认开启」处理，会在数据库抖动的几十秒里悄悄按
 * 未知的比例发錯分（且事后没有配置记录可查是当时哪个值生效）。宁可这次
 * 结算失败（有兜底任务 settleMissedPoints 补），也不要在配置不可信时发分。
 */
import prisma from '../../utils/prisma'
import { AppError } from '../../middlewares/error'
import { notifySystemAlert } from '../notify'

export interface MemberSettings {
  points: {
    enabled: boolean
    /** 每消费 1 元得多少分 */
    earnRatePerYuan: number
    /** 积分有效期（天） */
    validDays: number
  }
  newcomer: {
    /** 新客券模板 id；null = 不发新客券 */
    templateId: number | null
  }
  /** 规则说明页的补充文案 */
  rulesText: string
}

// 上线默认关闭发放（PO 2026-09-05 认可）：顾客端五个会员页面要到 M4 才有，现在发分
// 顾客完全看不见；且积分价（兑换券/赠品所需分数）尚未按 rate=100 重定，此时放分等于
// 让顾客攒一个兑换价随时会变的东西。由店主在 M3 设置页显式打开——即使打开，比例也
// 必须是 100（与 printer 的默认取向一致：新能力默认关，店主自己决定何时开）。
export const DEFAULT_MEMBER_SETTINGS: MemberSettings = {
  points: { enabled: false, earnRatePerYuan: 100, validDays: 365 },
  newcomer: { templateId: null },
  rulesText: '',
}

/** 读失败时的保守兜底：只关掉发放开关，其余字段仍用正常默认值（供 UI 展示）。
 *  与 DEFAULT_MEMBER_SETTINGS 现在同值（都是 enabled:false）——这不是巧合：读取失败时
 *  「不知道店主有没有打开过开关」，保守起见按未开处理，和默认值取向一致。 */
const CONSERVATIVE_FALLBACK: MemberSettings = {
  ...DEFAULT_MEMBER_SETTINGS,
  points: { ...DEFAULT_MEMBER_SETTINGS.points, enabled: false },
}

const MEMBER_KEY = 'member'
const CACHE_TTL_MS = 60 * 1000

let cached: { value: MemberSettings; at: number } | null = null

function sanitize(raw: unknown): MemberSettings {
  const o = (raw ?? {}) as Record<string, unknown>
  const points = (o.points ?? {}) as Record<string, unknown>
  const newcomer = (o.newcomer ?? {}) as Record<string, unknown>

  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  const intInRange = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Number(v)
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback
  }
  const nullableId = (v: unknown, fallback: number | null) => {
    if (v === null) return null
    const n = Number(v)
    return Number.isInteger(n) && n > 0 ? n : fallback
  }

  return {
    points: {
      enabled: bool(points.enabled, DEFAULT_MEMBER_SETTINGS.points.enabled),
      earnRatePerYuan: intInRange(points.earnRatePerYuan, 1, 100, DEFAULT_MEMBER_SETTINGS.points.earnRatePerYuan),
      validDays: intInRange(points.validDays, 1, 3650, DEFAULT_MEMBER_SETTINGS.points.validDays),
    },
    newcomer: {
      templateId: nullableId(newcomer.templateId, DEFAULT_MEMBER_SETTINGS.newcomer.templateId),
    },
    rulesText: typeof o.rulesText === 'string' ? o.rulesText.slice(0, 2000) : DEFAULT_MEMBER_SETTINGS.rulesText,
  }
}

export async function getMemberSettings(): Promise<MemberSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  try {
    const row = await prisma.setting.findUnique({ where: { key: MEMBER_KEY } })
    const value = row ? sanitize(JSON.parse(row.value)) : DEFAULT_MEMBER_SETTINGS
    cached = { value, at: Date.now() }
    return value
  } catch (e) {
    // 同 services/settings.ts 的处理：兜底值不进缓存（一次 DB 抖动不能让接下来 60 秒
    // 都按保守值处理），下一次调用重新去读真值；同时告警。
    console.warn('[member/settings] 读取会员配置失败，回退保守默认值（积分暂停发放）:', (e as Error).message)
    notifySystemAlert('会员设置读取失败', ['积分发放已按保守值暂停（未写缓存，下次调用重读）', (e as Error).message], {
      key: 'settings:member-fallback',
    })
    return CONSERVATIVE_FALLBACK
  }
}

export interface SetMemberSettingsInput {
  points: { enabled: boolean; earnRatePerYuan: number; validDays: number }
  newcomer: { templateId: number | null }
  rulesText: string
}

/**
 * 写入前的业务校验：templateId 非空时必须指向存在且 source='NEWCOMER' 的模板。
 * 数值范围校验交给路由层 zod（结构简单，两处各管各的即可）。
 */
export async function setMemberSettings(input: SetMemberSettingsInput): Promise<MemberSettings> {
  const value = sanitize(input)
  if (value.newcomer.templateId !== null) {
    const tpl = await prisma.couponTemplate.findUnique({ where: { id: value.newcomer.templateId } })
    if (!tpl || tpl.source !== 'NEWCOMER') {
      throw new AppError(40001, '新客券模板不存在或不是新客券类型')
    }
  }
  const json = JSON.stringify(value)
  await prisma.setting.upsert({
    where: { key: MEMBER_KEY },
    create: { key: MEMBER_KEY, value: json },
    update: { value: json },
  })
  cached = { value, at: Date.now() }
  return value
}

/** 测试与后台保存后手动失效用 */
export function clearMemberSettingsCache(): void {
  cached = null
}
