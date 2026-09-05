/**
 * 飞鹅云打印开放平台实现。协议细节来自 docs/research/2026-09-03-cloud-printer-feie-xpyun.md
 * 与 docs/superpowers/specs/2026-09-03-local-delivery-design.md §8b（标 ※ / [推断/待核实] 的地方
 * 在下面逐条注释复述，真机联调时对着核）。
 *
 * - 签名：sig = sha1(USER + UKEY + stime) 40 位小写，stime 为 10 位秒级时间戳 [已确认]
 * - 端点：POST {FEIE_API_BASE}/Api/Open/，application/x-www-form-urlencoded [已确认]
 * - 语音播报完全由硬件「真人语音」机型固件触发，本文件只管出票，不做任何播报相关调用
 *   [推断/待核实——<AUDIO-REFUND>/<AUDIO-CANCEL> 之类标签来自第三方博客，拼写与生效条件未在官方
 *   文档原文核实，首期不使用，等真机到手后由店主核对]。
 * - 无原生去重/幂等字段、无沙箱：本文件只负责单次协议调用，去重由 services/ticket/index.ts 的
 *   PrintJob.dedupeKey 负责。
 * - 全仓出站 fetch 统一加超时的约定（见 services/wechat-pay.ts、services/delivery/kd100.ts）：
 *   打印接口给 10s（比支付/快递100 稍短——打印是店内单点操作，不该让顾客付款回调等太久）。
 * - `FEIE_API_BASE`：飞鹅国内站与国际站是两套独立账号体系，账号注册在哪个站就只能打哪个站的接口，
 *   打错站一律返回 `ret=1002`「Printer Sn and User do not match」（看着像 SN 错，其实是站点错）。
 *   **2026-09-05 已用真机核实**（见 `.env.example` 同一时间点的说明）：国内站
 *   `https://api.feieyun.cn` 对真实 SN 的 `Open_queryPrinterStatus` 返回 `ret=0`；国际站
 *   `https://api.de.feieyun.com`（此前调研抓取到的地址）对同一 SN 返回 `ret=1002`——本项目账号
 *   注册在国内站（后台 admin.feieyun.com），因此 `FEIE_API_BASE` 应配置为前者。
 */
import crypto from 'crypto'
import { config, validateFeieConfig } from '../../config'
import {
  PrinterProvider, PrintTicketInput, PrintTicketResult, PrinterStatusResult, QueryJobResult,
  BindPrinterInput, PrinterError, PrinterErrorKind, PrinterOnlineState, PrinterQueueInfo,
} from './printer'

const TIMEOUT_MS = 10_000

export function _sign(user: string, ukey: string, stime: string): string {
  return crypto.createHash('sha1').update(user + ukey + stime, 'utf8').digest('hex')
}

/**
 * 飞鹅官方文档抓取里没有给出完整的 ret 错误码表（只有「HTTP 非 200 或 ret != 0 记 lastError」这条
 * 约定，见规格 §8b 与调研文档 §1.9「未查到官方限流/错误码表」）。这里按 msg 文案关键字做启发式分类，
 * **不是**一份权威码表——真机联调时如果发现某类错误分类不对（比如某条离线提示没命中 CAPACITY 的
 * 关键字导致被当成 BUSINESS 处理、重试次数用错），照这里加关键字即可，不用改调用方。
 *
 * 例外：`ret=1002`「Printer Sn and User do not match」是 2026-09-05 真机实测确认过的具体码
 * （账号/SN 跨站不匹配，见上方文件头注释），属于配置类错误，直接按 ret 数值命中，不依赖关键字匹配。
 */
export function _mapFeieError(ret: number | string | undefined, msg: string): PrinterErrorKind {
  if (String(ret) === '1002') return 'CONFIG' // 已确认：账号/SN 跨站（国内站 vs 国际站）不匹配
  const m = msg || ''
  // M10：CONFIG 是这套启发式唯一承重的分界——判成 CONFIG 直接 FAILED 且被永久排除在补打之外
  // （retryRecoveredPrinterJobs 明确跳过 `lastError` 以 `CONFIG:` 开头的行）。原来的关键字里
  // 「签名/USER/UKEY」对应的是 sig 校验失败，而 2026-09-05 已确认服务器时钟漂移会让
  // `stime` 超出飞鹅的校验窗口、返回一条同样含"签名"字样的错误——NTP 一修好这些请求立刻能
  // 重新发出去，属于会自愈的 BUSINESS/CAPACITY 类，判成 CONFIG 会让这些行永久失去补打资格，
  // NTP 修好后仍需店主逐条手点重试。这里排除掉「签名/USER/UKEY」这几个跟 sig 校验强相关、
  // 会被时钟漂移污染的词。
  //
  // 复核第二轮（M10 收窄过头）：上一版把「账号」也一并删了，但飞鹅账号本身被禁用/异常
  // （比如欠费、被封）返回的「账号异常」类文案，跟"时钟漂移导致签名超窗口"是两回事——
  // 已确认的时钟漂移错误文案只含"签名"字样，不含"账号"；"账号异常"不会随时间自己变好，
  // 误判成 BUSINESS 会让每张票白烧 4 次×10s 外呼才落到 FAILED，且下次"打印机恢复"时还会被
  // retryRecoveredPrinterJobs 反复重试（它只排除 CONFIG: 开头的行）。没有更细的官方 ret 码表
  // 可用来做比关键字更精确的判据（这是本项目从飞鹅原始文档抓取里能拿到的唯一确定信息，
  // 见文件头注释与调研文档 §1.9），所以仍是关键字匹配，只是把「账号」放回来、继续排除
  // 「签名/USER/UKEY」。
  if (/不存在|未绑定|未添加|用户名|账号|not match/i.test(m)) return 'CONFIG'
  if (/离线|不在线|缺纸|开盖|异常|队列已满|通信失败/.test(m)) return 'CAPACITY'
  return 'BUSINESS'
}

interface FeieResponse { ret?: number; msg?: string; data?: unknown }

async function post(apiname: string, params: Record<string, string>): Promise<FeieResponse> {
  try {
    validateFeieConfig()
  } catch (e) {
    throw new PrinterError('CONFIG', 'MISSING_CONFIG', (e as Error).message)
  }
  const stime = String(Math.floor(Date.now() / 1000))
  const sig = _sign(config.feie.user, config.feie.ukey, stime)
  const body = new URLSearchParams({ user: config.feie.user, stime, sig, apiname, ...params })
  const url = `${config.feie.apiBase}/Api/Open/`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const err = e as Error
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new PrinterError('TIMEOUT', 'TIMEOUT', `飞鹅打印请求超时: ${err.message}`, e)
    }
    throw new PrinterError('TIMEOUT', 'NETWORK', `飞鹅打印请求网络失败: ${err.message}`, e)
  }
  if (res.status >= 500) {
    // 网关级 5xx：不能证明请求没有在对方那头产生真实效果（可能已经进了打印队列），按超时语义处理，
    // 不当作「明确失败」直接判 BUSINESS/CONFIG（那两类会被上层当作可安全重试/不重试的确定结论）。
    throw new PrinterError('TIMEOUT', `HTTP_${res.status}`, `飞鹅网关异常 HTTP ${res.status}`)
  }
  let data: FeieResponse
  try { data = (await res.json()) as FeieResponse } catch {
    throw new PrinterError('BUSINESS', `HTTP_${res.status}`, '飞鹅响应非 JSON')
  }
  if (!res.ok || data.ret !== 0) {
    const msg = data.msg ?? '飞鹅返回异常'
    throw new PrinterError(_mapFeieError(data.ret ?? res.status, msg), String(data.ret ?? res.status), `ret:${data.ret ?? res.status} msg:${msg}`, data)
  }
  return data
}

/** 「在线，工作状态正常。」ONLINE ／「在线，工作状态不正常。」ABNORMAL（缺纸/开盖）／「离线。」OFFLINE
 *  [推断/待核实——三个前缀字符串来自调研摘要与规格 §8b，未见官方逐字文档页，真机联调时核对措辞是否一致] */
function parseStatus(raw: string): PrinterOnlineState {
  const s = (raw || '').trim()
  if (s.startsWith('在线，工作状态正常')) return 'ONLINE'
  if (s.startsWith('在线')) return 'ABNORMAL'
  if (s.startsWith('离线')) return 'OFFLINE'
  return 'UNKNOWN'
}

export const feieProvider: PrinterProvider = {
  name: 'FEIE',

  async print(job: PrintTicketInput): Promise<PrintTicketResult> {
    const data = await post('Open_printMsg', {
      sn: job.sn,
      content: job.content,
      times: String(job.copies ?? 1),
    })
    // Open_printMsg 成功时 data 为平台订单标识（字符串），供 Open_queryOrderState 查询打印状态用
    const providerJobId = typeof data.data === 'string' ? data.data : String(data.data ?? '')
    if (!providerJobId) {
      throw new PrinterError('BUSINESS', 'NO_JOB_ID', '飞鹅打印提交成功但未返回订单标识', data)
    }
    return { providerJobId, raw: data }
  },

  async queryStatus(sn: string): Promise<PrinterStatusResult> {
    const data = await post('Open_queryPrinterStatus', { sn })
    const raw = typeof data.data === 'string' ? data.data : String(data.data ?? '')
    return { sn, state: parseStatus(raw), raw }
  },

  async queryJob(providerJobId: string): Promise<QueryJobResult> {
    const data = await post('Open_queryOrderState', { orderid: providerJobId })
    // 2026-09-05 真机实测（SN 222601993，国内站）：data 是 **JSON 布尔**，不是字符串也不是 0/1——
    //   下发后立即查 → {"ret":0,"data":false}   打印完成后再查 → {"ret":0,"data":true}
    // false→true 的翻转就是 PrintJob 从 SENT 走到 PRINTED 的判据。
    // orderid 写错时返回 ret=1001「参数错误 : 订单ID错误.」，由 post() 抛错，不会走到这里。
    // 其余分支保留为向后兼容（飞鹅历史文档出现过字符串态），实测未见。
    const raw = data.data
    const printed = raw === true || raw === '1' || raw === 1 || (typeof raw === 'string' && raw.includes('已打印'))
    return { printed, raw }
  },

  async bindPrinter(input: BindPrinterInput): Promise<void> {
    // Open_printerAddlist：printerContent = "SN#KEY#备注名#手机号"，多台换行分隔；这里只绑一台
    const printerContent = `${input.sn}#${input.key}#${input.name ?? ''}#`
    await post('Open_printerAddlist', { printerContent })
  },

  // D2（H5b）：2026-09-05 真机实验确认飞鹅有云端待打印队列——打印机离线期间 Open_printMsg 仍返回
  // ret=0，票排进这个队列，恢复上线时会自动全部吐出。queryQueueInfo/clearQueue 是应对这件事的两个
  // 接口：前者观测积压（waiting），后者清空（不能按单删）。
  async queryQueueInfo(sn: string): Promise<PrinterQueueInfo> {
    const data = await post('Open_printerInfo', { sn })
    // [推断/待核实] 真机实验只确认了 data 里含数值型 waiting 字段，完整响应结构未见官方文档逐字
    // 给出——这里防御性解析，字段缺失/类型不对一律按 0 处理，不能因为解析失败挡住恢复补打流程。
    const raw = data.data
    let waiting = 0
    if (raw && typeof raw === 'object' && 'waiting' in (raw as Record<string, unknown>)) {
      const w = (raw as Record<string, unknown>).waiting
      const n = typeof w === 'number' ? w : parseInt(String(w), 10)
      if (Number.isFinite(n)) waiting = n
    }
    return { waiting, raw }
  },

  async clearQueue(sn: string): Promise<void> {
    await post('Open_delPrinterSqs', { sn })
  },
}
