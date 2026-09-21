/**
 * 服务端固定北京时间自测（无需 DB）。故意用 TZ=Asia/Tokyo 起进程，验证 pinTimezone 真的
 * 会覆盖一个"已经设置成别的时区"的环境，而不是只在缺省时才填：
 *   cd apps/server && TZ=Asia/Tokyo npx ts-node --transpile-only scripts/selftest-timezone.ts
 *
 * ① 起始状态确实是东京时区（offset -540），pinTimezone() 覆盖后自检通过、偏移变 -480。
 * ② 自检失败：生产环境 exit(1) 且日志含「拒绝启动」；非生产只 warn 不 exit。
 * ③ 赋一个不存在的时区名会静默回落 UTC（offset 变 0），自检同样能抓到（不依赖 process.env.TZ
 *    字符串本身「看起来设置了」，而是用 Intl 解析结果 + 实际偏移双重验证）。
 * ④ 恢复钉死后，local-day.ts 的换算确实跟着进程时区走（与 selftest-local-day.ts 同一断言）。
 */
import assert from 'assert'
import { pinTimezone, checkTimezone, enforceTimezone, TARGET_TZ, TARGET_OFFSET_MIN } from '../src/utils/timezone'

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

console.log('== ① 起始状态 + pinTimezone 覆盖 ==')
t('起始进程时区是东京（offset -540），证明本次自测确实以 TZ=Asia/Tokyo 启动', () => {
  assert.strictEqual(new Date().getTimezoneOffset(), -540)
})

let pin = pinTimezone()
t('pinTimezone() 返回 previous=Asia/Tokyo, overridden=true', () => {
  assert.strictEqual(pin.previous, 'Asia/Tokyo')
  assert.strictEqual(pin.overridden, true)
})
t('pin 之后 checkTimezone().ok === true，offsetMin === -480，resolved === Asia/Shanghai', () => {
  const c = checkTimezone()
  assert.strictEqual(c.ok, true)
  assert.strictEqual(c.offsetMin, TARGET_OFFSET_MIN)
  assert.strictEqual(c.resolved, TARGET_TZ)
})

console.log('== ② 自检失败：生产拒绝启动 / 非生产只警告 ==')
process.env.TZ = 'Etc/UTC'
t('process.env.TZ 改回 Etc/UTC 后 checkTimezone().ok === false', () => {
  assert.strictEqual(checkTimezone().ok, false)
})

t('enforceTimezone({isProduction:true}) → exit(1)，error 日志含「拒绝启动」', () => {
  let exitCode: number | undefined
  let errorMsg = ''
  const log = {
    error: (...args: unknown[]) => {
      errorMsg += args.join(' ')
    },
    warn: () => undefined,
  }
  enforceTimezone({ isProduction: true, log, exit: (code) => { exitCode = code } })
  assert.strictEqual(exitCode, 1)
  assert.ok(errorMsg.includes('拒绝启动'), `实际日志: ${errorMsg}`)
})

t('enforceTimezone({isProduction:false}) → 不 exit，只 warn', () => {
  let exitCalled = false
  let warnMsg = ''
  const log = {
    error: () => undefined,
    warn: (...args: unknown[]) => {
      warnMsg += args.join(' ')
    },
  }
  enforceTimezone({ isProduction: false, log, exit: () => { exitCalled = true } })
  assert.strictEqual(exitCalled, false)
  assert.ok(warnMsg.length > 0, '非生产环境应该有 warn 日志')
})

console.log('== ③ 赋错时区名静默回落 UTC，自检仍能抓到 ==')
process.env.TZ = 'Not/AZone'
t('赋一个不存在的时区名后 checkTimezone().ok === false（静默回落 UTC，offset 变 0）', () => {
  const c = checkTimezone()
  assert.strictEqual(c.ok, false)
  assert.strictEqual(c.offsetMin, 0, '静默回落到 UTC 时偏移应为 0')
})

console.log('== ④ 恢复钉死后 local-day 换算跟着进程时区走 ==')
pin = pinTimezone()
t('恢复钉死后 checkTimezone().ok === true', () => {
  assert.strictEqual(checkTimezone().ok, true)
})
t("parseLocalDayStart('2026-09-18') = 北京 00:00 = UTC 前一日 16:00（与 selftest-local-day.ts 同断言）", () => {
  // 延迟 require：必须等上面 pinTimezone() 生效之后再引入按进程时区换算的模块调用点，
  // 与 selftest-local-day.ts 的独立运行方式不同——这里是在同一进程里验证「改完 TZ 立即生效」。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parseLocalDayStart } = require('../src/utils/local-day')
  const d = parseLocalDayStart('2026-09-18')
  assert.ok(d)
  assert.strictEqual(d!.toISOString(), '2026-09-17T16:00:00.000Z')
})

console.log(`\n${pass} 例通过${process.exitCode ? '，存在失败' : ''}`)
