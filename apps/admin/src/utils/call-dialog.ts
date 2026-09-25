/**
 * 呼叫骑手弹窗的纯文案函数（wb-escalation-display，店主 2026-09-25 决定：弹窗从「三段块 +
 * 琥珀警示 + 选一种方式」的复杂形态，简化成两张卡（只写价格和一句话）+ 卡下一句「没人接会
 * 怎样」+ 右下角报价时间与刷新 + 「再想想」/「呼叫 · 普通」「呼叫 · 极速」）。
 *
 * 确认按钮不再拼金额（店主原话）——金额只在卡片上，按钮只回答「按哪种方式呼叫」。
 */
import { providerLabel } from './providers.ts'

export type CallChoice = 'normal' | 'fast'
export type CallStrategyMode = 'SOLO_LOWEST' | 'CHEAPEST_N' | 'ALL'

/** 确认键文案：「呼叫 · 普通」/「呼叫 · 极速」；verb 换成「接单并呼叫」「立即呼叫」等场景词 */
export function confirmLabel(choice: CallChoice, verb: string = '呼叫'): string {
  return `${verb} · ${choice === 'fast' ? '极速' : '普通'}`
}

/**
 * 复核 R1：呼叫弹窗四处确认键此前都拼了「确认」二字（如「确认呼叫 · 普通」），店主要的是
 * 「呼叫 · 普通」——verb 本身就不该带「确认」，这里不做字符串清洗，靠调用方传对 verb
 * （callSpec 的四个调用点已改成「呼叫」「重新呼叫」「立即呼叫」「接单并呼叫」）。
 * `hasQuote=false` 时报价块不会渲染、`pick` 永远拿不到，这里仍显式按 pick.manual 判一次
 * ——即使将来误传了 pick 也不会因为 hasQuote 被忽略而算错。
 */
export function callConfirmText(input: { verb: string; hasQuote: boolean; pick?: { manual: boolean } | null }): string {
  const choice: CallChoice = input.hasQuote && input.pick?.manual ? 'fast' : 'normal'
  return confirmLabel(choice, input.verb)
}

/**
 * 普通卡片下的一句副标题：SOLO_LOWEST 报「先呼谁」，CHEAPEST_N 报「并呼几家」，
 * ALL 报「并呼全部几家」。拿不到最低价运力（还没查到价）时退回固定短句，不编造。
 */
export function normalCardSub(mode: CallStrategyMode, n: number, lowestProvider?: string | null): string {
  if (mode === 'CHEAPEST_N') return `并呼最便宜 ${n} 家`
  if (mode === 'ALL') return `并呼全部 ${n} 家`
  return lowestProvider ? `先呼${providerLabel(lowestProvider)}` : '按设置呼叫'
}

/** 极速卡片下的一句副标题：闪送有报价就说「专人送」，没有就说明白没运力（卡片同时会置灰） */
export function fastCardSub(hasFast: boolean): string {
  return hasFast ? '闪送专人送' : '闪送暂无运力'
}

/**
 * 卡下唯一一行「没人接会怎样」，口径与服务端 tasks.ts:escalateSoloCalls 对齐：
 * - 极速（只呼闪送一对一）：esc>0 时超时自动改普通并呼最便宜 N 家；esc<=0 不会自动改。
 * - 普通 SOLO_LOWEST：esc>0 时超时自动加呼最便宜 N 家（两级阶梯，第二级到头只提醒不再加）。
 * - 普通 CHEAPEST_N：本来就并呼 N 家，没有「加呼」这一级，esc>0 只是到点提醒店员。
 * - 普通 ALL，或 esc<=0（策略关闭升级）：不会自动加人，callTimeoutMin 分钟无人接才提醒店员。
 */
export function ladderLine(input: {
  choice: CallChoice
  mode: CallStrategyMode
  cheapestN: number
  escalateMin: number
  callTimeoutMin: number
}): string {
  const { choice, mode, cheapestN, escalateMin, callTimeoutMin } = input
  if (choice === 'fast') {
    return escalateMin > 0
      ? `${escalateMin} 分钟没人接，自动改为并呼最便宜 ${cheapestN} 家`
      : `不会加呼，${callTimeoutMin} 分钟没人接会提醒店员`
  }
  if (mode === 'ALL' || escalateMin <= 0) return `不会加呼，${callTimeoutMin} 分钟没人接会提醒店员`
  if (mode === 'SOLO_LOWEST') return `${escalateMin} 分钟没人接，自动加呼最便宜 ${cheapestN} 家`
  return `${escalateMin} 分钟没人接会提醒店员，不再自动加人`
}

/** 右下角小字：「HH:mm 报价」，过期时前面加「报价已过期 · 」（旁边另配一个刷新按钮，不在这个函数里） */
export function quoteFooter(hhmm: string, stale: boolean): string {
  return stale ? `报价已过期 · ${hhmm} 报价` : `${hhmm} 报价`
}
