/**
 * 打印机运营设置（settings 表 key='printer'）。结构照规格 §8b 原样实现：
 * `{ enabled, provider, printers[], voice, repeat, offlineAlertMin, printCancel }`。
 *
 * 密钥（FEIE_USER/FEIE_UKEY/FEIE_API_BASE）走 env（见 config.ts），不进这张表；
 * 打印机的绑定密钥（KEY）只在绑定调用时用一次，同样不落库明文——这里只存 sn/name/channels/copies。
 *
 * 缓存策略：60 秒进程内缓存（PM2 单实例 fork，进程内缓存前提成立），保存即失效。
 * **读失败时的正确写法**（对照 services/local-settings.ts 现存的坑：读库异常时把兜底默认值也写进了
 * `cached`，导致接下来 60 秒即使库恢复也读不到真值；已在 services/settings.ts 修过一次，这里照
 * 修过的写法来）——读失败只把默认值返回给这一次调用，不写 `cached`，下一次调用会重新尝试读库。
 */
import prisma from '../utils/prisma'
import { notifySystemAlert } from './notify'
import { PrinterError } from './ticket/printer'

export const PRINTER_SETTINGS_KEY = 'printer'
const CACHE_TTL_MS = 60 * 1000

export type PrinterChannel = 'LOCAL' | 'EXPRESS'

export interface PrinterEntry {
  sn: string
  name: string
  channels: PrinterChannel[]
  /** 打印份数，1–10 */
  copies: number
}

export interface PrinterSettings {
  enabled: boolean
  /** 首期只有 FEIE；XPYUN 留作二期（services/ticket/xpyun.ts 尚未实现） */
  provider: 'FEIE' | 'XPYUN'
  printers: PrinterEntry[]
  voice: {
    enabled: boolean
    localText: string
    expressText: string
  }
  repeat: {
    /** 同城单：付款后多少分钟未接单开始重复播报 */
    localAfterMin: number
    /** 邮寄单：付款后多少分钟未接单开始重复播报 */
    expressAfterMin: number
    /** 重复播报间隔（分钟） */
    everyMin: number
    /** 最多重复次数，耗尽后告警老板 */
    maxTimes: number
    /** true = 重复播报时重打整张全票；false（默认）= 只打精简「催接单」小票 */
    reprint: boolean
  }
  /** 打印机连续离线超过多少分钟告警老板 */
  offlineAlertMin: number
  /** 取消/退款是否也出提醒票 */
  printCancel: boolean
}

export const DEFAULT_PRINTER_SETTINGS: PrinterSettings = {
  enabled: false,
  provider: 'FEIE',
  printers: [],
  voice: {
    enabled: true,
    localText: '您有新的同城订单',
    expressText: '您有新的邮寄订单',
  },
  repeat: {
    localAfterMin: 2,
    // PO 2026-09-06 定：邮寄从规格的 5 分钟放宽到 10 —— 邮寄单不赶时间，没必要 5 分钟就喂。
    // 同城保持 2 分钟不变（骨子里是赶时间的）。
    expressAfterMin: 10,
    everyMin: 2,
    maxTimes: 5,
    reprint: false,
  },
  offlineAlertMin: 5,
  printCancel: true,
}

// ── sanitize ────────────────────────────────────────────────
const asObj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb)
const str = (v: unknown, fb: string, max = 128) => (typeof v === 'string' ? v.trim().slice(0, max) : fb)
const int = (v: unknown, fb: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : fb
}
const CHANNELS: readonly PrinterChannel[] = ['LOCAL', 'EXPRESS']

function sanitizePrinterEntry(raw: unknown): PrinterEntry | null {
  const o = asObj(raw)
  const sn = str(o.sn, '', 32)
  if (!sn) return null
  const channels = Array.isArray(o.channels)
    ? o.channels.filter((c): c is PrinterChannel => typeof c === 'string' && CHANNELS.includes(c as PrinterChannel))
    : []
  return {
    sn,
    name: str(o.name, sn, 64),
    channels: channels.length ? [...new Set(channels)] : [...CHANNELS],
    copies: int(o.copies, 1, 1, 10),
  }
}

export function sanitizePrinterSettings(raw: unknown): PrinterSettings {
  const o = asObj(raw)
  const D = DEFAULT_PRINTER_SETTINGS
  const voice = asObj(o.voice)
  const repeat = asObj(o.repeat)
  const printers = Array.isArray(o.printers)
    ? o.printers.map(sanitizePrinterEntry).filter((p): p is PrinterEntry => p !== null).slice(0, 20)
    : []
  return {
    enabled: bool(o.enabled, D.enabled),
    provider: o.provider === 'XPYUN' ? 'XPYUN' : D.provider,
    printers,
    voice: {
      enabled: bool(voice.enabled, D.voice.enabled),
      localText: str(voice.localText, D.voice.localText, 60),
      expressText: str(voice.expressText, D.voice.expressText, 60),
    },
    repeat: {
      localAfterMin: int(repeat.localAfterMin, D.repeat.localAfterMin, 1, 60),
      expressAfterMin: int(repeat.expressAfterMin, D.repeat.expressAfterMin, 1, 60),
      everyMin: int(repeat.everyMin, D.repeat.everyMin, 1, 60),
      maxTimes: int(repeat.maxTimes, D.repeat.maxTimes, 0, 20),
      reprint: bool(repeat.reprint, D.repeat.reprint),
    },
    offlineAlertMin: int(o.offlineAlertMin, D.offlineAlertMin, 1, 120),
    printCancel: bool(o.printCancel, D.printCancel),
  }
}

/** 校验重复出现的 SN、渠道未覆盖等结构合法但业务上有问题的组合（保存时用） */
export function validatePrinterSettings(s: PrinterSettings): string[] {
  const errs: string[] = []
  // H4：sanitize 允许 provider='XPYUN' 原样通过（校验要有机会看到用户到底选了什么），但保存时
  // 必须挡在这里——首期只实现了 feie.ts，选了 XPYUN 存进库会变成一条只有 getProvider() 抛错时
  // 才会暴露的定时炸弹（脏行躺在库里，直到某次出票才炸）。
  if (s.provider !== 'FEIE') errs.push('该打印平台尚未支持（二期开放），暂仅支持飞鹅（FEIE）')
  const seen = new Set<string>()
  for (const p of s.printers) {
    if (seen.has(p.sn)) errs.push(`打印机编号 ${p.sn} 重复`)
    seen.add(p.sn)
  }
  if (s.enabled && s.printers.length === 0) errs.push('启用打印前请至少绑定一台打印机')
  return errs
}

// ── 读写 + 缓存 ─────────────────────────────────────────────
let cached: { value: PrinterSettings; at: number } | null = null

export async function getPrinterSettings(): Promise<PrinterSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  let value: PrinterSettings
  try {
    const row = await prisma.setting.findUnique({ where: { key: PRINTER_SETTINGS_KEY } })
    value = row ? sanitizePrinterSettings(JSON.parse(row.value)) : DEFAULT_PRINTER_SETTINGS
  } catch (e) {
    // M9：「读不到配置」与「本来就没配置」是两回事。没配置时不出票是安全默认；读失败（DB 抖动/
    // JSON 损坏）如果也退化成同一个默认值再悄悄放行，出票层会以为一切正常只是没开——不建行、
    // 不告警，比"未配置"更危险的路径反而什么都不留（原实现的坑）。改成抛出，交给各调用方按
    // 自己的语义处理：enqueueOrderTicket 落一条 SKIPPED 痕迹，healthCheck/repeatAnnounce/
    // printerHealthTask 按"本轮跳过"处理，bindPrinterToAccount/unbindPrinter/
    // enqueuePrinterTestJob 这类管理员主动操作直接把错误透传给路由层。
    // 兜底值不写进 cached：一次 DB 抖动不能让接下来 60 秒都读不到真实配置，下一次调用要重新
    // 尝试读库（对照 services/settings.ts 里这条修过的坑）。
    console.warn('[printer-settings] 读取失败:', (e as Error).message)
    notifySystemAlert('打印机配置读取失败', ['出票/健康检查本轮将按需要跳过或留痕（不再静默当作未配置）', (e as Error).message], {
      key: 'settings:printer-fallback',
    })
    throw new PrinterError('CONFIG', 'SETTINGS_UNREADABLE', `打印机配置读取失败：${(e as Error).message}`)
  }
  cached = { value, at: Date.now() }
  return value
}

export async function setPrinterSettings(next: PrinterSettings): Promise<PrinterSettings> {
  const value = sanitizePrinterSettings(next)
  const json = JSON.stringify(value)
  await prisma.setting.upsert({
    where: { key: PRINTER_SETTINGS_KEY },
    create: { key: PRINTER_SETTINGS_KEY, value: json },
    update: { value: json },
  })
  cached = { value, at: Date.now() }
  return value
}

/** 测试/脚本按需清缓存；线上单进程 fork，setPrinterSettings 已即时刷新本进程缓存，不需要额外调用 */
export function clearPrinterSettingsCache(): void {
  cached = null
}

/** 某渠道当前配置的打印机列表（按 sn 去重后原顺序） */
export function printersForChannel(s: PrinterSettings, channel: PrinterChannel): PrinterEntry[] {
  return s.printers.filter((p) => p.channels.includes(channel))
}
