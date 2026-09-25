import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmLabel, callConfirmText, normalCardSub, fastCardSub, ladderLine, quoteFooter } from './call-dialog.ts'

test('confirmLabel：不拼金额，默认动词「呼叫」', () => {
  assert.equal(confirmLabel('normal'), '呼叫 · 普通')
  assert.equal(confirmLabel('fast'), '呼叫 · 极速')
  assert.equal(confirmLabel('normal', '接单并呼叫'), '接单并呼叫 · 普通')
  for (const s of [confirmLabel('normal'), confirmLabel('fast'), confirmLabel('normal', '接单并呼叫')]) {
    assert.equal(/[¥\d]/.test(s), false, s)
  }
})

test('normalCardSub：三种模式 + 无报价兜底', () => {
  assert.equal(normalCardSub('SOLO_LOWEST', 3, 'dadatongcheng'), '先呼达达')
  assert.equal(normalCardSub('CHEAPEST_N', 3), '并呼最便宜 3 家')
  assert.equal(normalCardSub('ALL', 5), '并呼全部 5 家')
  assert.equal(normalCardSub('SOLO_LOWEST', 3, null), '按设置呼叫')
})

test('fastCardSub：有/无闪送报价', () => {
  assert.equal(fastCardSub(true), '闪送专人送')
  assert.equal(fastCardSub(false), '闪送暂无运力')
})

test('ladderLine：普通 SOLO_LOWEST esc=3 → 含「3 分钟没人接」与「最便宜 3 家」', () => {
  const s = ladderLine({ choice: 'normal', mode: 'SOLO_LOWEST', cheapestN: 3, escalateMin: 3, callTimeoutMin: 10 })
  assert.ok(s.includes('3 分钟没人接'), s)
  assert.ok(s.includes('最便宜 3 家'), s)
})

test('ladderLine：极速 esc=3 → 含「改为并呼最便宜 3 家」', () => {
  const s = ladderLine({ choice: 'fast', mode: 'SOLO_LOWEST', cheapestN: 3, escalateMin: 3, callTimeoutMin: 10 })
  assert.ok(s.includes('改为并呼最便宜 3 家'), s)
})

test('ladderLine：普通 CHEAPEST_N esc=3 → 含「提醒店员」且不含「加呼」', () => {
  const s = ladderLine({ choice: 'normal', mode: 'CHEAPEST_N', cheapestN: 3, escalateMin: 3, callTimeoutMin: 10 })
  assert.ok(s.includes('提醒店员'), s)
  assert.equal(s.includes('加呼'), false, s)
})

test('ladderLine：普通 ALL（任何 esc）与 esc=0（任何 mode）→ 含 callTimeoutMin 分钟提醒且不含「自动」', () => {
  const a = ladderLine({ choice: 'normal', mode: 'ALL', cheapestN: 3, escalateMin: 3, callTimeoutMin: 10 })
  const b = ladderLine({ choice: 'normal', mode: 'ALL', cheapestN: 3, escalateMin: 0, callTimeoutMin: 10 })
  const c = ladderLine({ choice: 'normal', mode: 'SOLO_LOWEST', cheapestN: 3, escalateMin: 0, callTimeoutMin: 10 })
  const d = ladderLine({ choice: 'normal', mode: 'CHEAPEST_N', cheapestN: 3, escalateMin: 0, callTimeoutMin: 10 })
  for (const s of [a, b, c, d]) {
    assert.ok(s.includes('10 分钟'), s)
    assert.ok(s.includes('提醒'), s)
    assert.equal(s.includes('自动'), false, s)
  }
})

test('quoteFooter：正常态与过期态', () => {
  assert.equal(quoteFooter('22:50', false), '22:50 报价')
  assert.ok(quoteFooter('22:50', true).includes('已过期'))
})

// 复核 R1：确认键此前拼了「确认」二字（如「确认呼叫 · 普通」），店主要的是「呼叫 · 普通」——
// callConfirmText 是 callSpec 里 confirmText/confirmTextOf 唯一的落地点。
test('callConfirmText：四个调用点的 verb，均不含「确认」与金额', () => {
  assert.equal(callConfirmText({ verb: '呼叫', hasQuote: true, pick: null }), '呼叫 · 普通')
  assert.equal(callConfirmText({ verb: '重新呼叫', hasQuote: true, pick: { manual: true } }), '重新呼叫 · 极速')
  assert.equal(callConfirmText({ verb: '立即呼叫', hasQuote: true, pick: null }), '立即呼叫 · 普通')
  assert.equal(callConfirmText({ verb: '接单并呼叫', hasQuote: false, pick: null }), '接单并呼叫 · 普通')
  for (const s of [
    callConfirmText({ verb: '呼叫', hasQuote: true, pick: null }),
    callConfirmText({ verb: '重新呼叫', hasQuote: true, pick: { manual: true } }),
    callConfirmText({ verb: '立即呼叫', hasQuote: true, pick: null }),
    callConfirmText({ verb: '接单并呼叫', hasQuote: false, pick: null }),
  ]) {
    assert.equal(/确认|[¥\d]/.test(s), false, s)
  }
})
test('callConfirmText：hasQuote=false 时即便误传了 pick.manual 也按普通处理（报价块本就没渲染）', () => {
  assert.equal(callConfirmText({ verb: '接单并呼叫', hasQuote: false, pick: { manual: true } }), '接单并呼叫 · 普通')
})
