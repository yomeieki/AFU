/**
 * 上海自然日换算纯函数自测（无需 DB）：
 *   TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-local-day.ts
 *
 * 换算按**进程本地时区**解释（与 stats/shared.ts、scan-stats.ts、routes/admin/orders.ts
 * 同一实现来源），所以必须钉死以 TZ=Asia/Shanghai 运行——否则本机（JST）跑出来的结果碰巧
 * 也可能全绿，掩盖时区问题。
 */
import assert from 'assert'
import { parseLocalDayStart, localDayBounds } from '../src/utils/local-day'

if (new Date().getTimezoneOffset() !== -480) {
  console.error('本自测必须以 TZ=Asia/Shanghai 运行')
  process.exit(1)
}

let pass = 0
function t(name: string, fn: () => void) {
  try {
    fn()
    pass++
    console.log('  ✔', name)
  } catch (e) {
    console.error('  ✘', name, '\n    ', (e as Error).message)
    process.exitCode = 1
  }
}

// parseLocalDayStart
t('parseLocalDayStart(2026-09-18) = 北京 00:00 = UTC 前一日 16:00', () => {
  const d = parseLocalDayStart('2026-09-18')
  assert.ok(d)
  assert.strictEqual(d!.toISOString(), '2026-09-17T16:00:00.000Z')
})
t('parseLocalDayStart(2026-02-30) = null（回环到 03-02，日历上不存在）', () => {
  assert.strictEqual(parseLocalDayStart('2026-02-30'), null)
})
t('parseLocalDayStart(2026-13-01) = null（月份非法）', () => {
  assert.strictEqual(parseLocalDayStart('2026-13-01'), null)
})
t('parseLocalDayStart(2026-9-1) = null（格式非法，缺前导零）', () => {
  assert.strictEqual(parseLocalDayStart('2026-9-1'), null)
})
t('parseLocalDayStart(2026-12-31) 有效，跨年 lt 落到 2027-01-01', () => {
  const d = parseLocalDayStart('2026-12-31')
  assert.ok(d)
  const { lt } = localDayBounds('2026-12-31', '2026-12-31')
  assert.ok(lt)
  // 北京 2027-01-01 00:00 = UTC 2026-12-31 16:00
  assert.strictEqual(lt!.toISOString(), '2026-12-31T16:00:00.000Z')
})

// localDayBounds
t('localDayBounds(同日,同日)：gte/lt 各落在北京 00:00 边界', () => {
  const { gte, lt } = localDayBounds('2026-09-18', '2026-09-18')
  assert.ok(gte && lt)
  assert.strictEqual(gte!.toISOString(), '2026-09-17T16:00:00.000Z')
  assert.strictEqual(lt!.toISOString(), '2026-09-18T16:00:00.000Z')
  const inRange = new Date('2026-09-17T16:30:00.000Z') // 北京 09-18 00:30
  const outOfRange = new Date('2026-09-17T15:59:59.000Z') // 北京 09-17 23:59:59
  assert.ok(inRange.getTime() >= gte!.getTime() && inRange.getTime() < lt!.getTime())
  assert.ok(!(outOfRange.getTime() >= gte!.getTime() && outOfRange.getTime() < lt!.getTime()))
})
t('localDayBounds(起晚于止) 抛 RangeError', () => {
  assert.throws(() => localDayBounds('2026-09-18', '2026-09-17'), RangeError)
})
t('localDayBounds(undefined, 止) 只给 lt', () => {
  const b = localDayBounds(undefined, '2026-09-18')
  assert.strictEqual(b.gte, undefined)
  assert.ok(b.lt)
})
t('localDayBounds() 为空对象', () => {
  assert.deepStrictEqual(localDayBounds(), {})
})

console.log(`\n${pass} 例通过${process.exitCode ? '，存在失败' : ''}`)
