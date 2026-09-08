/**
 * 快递100 协议自测（离线）：cd apps/server && npx ts-node --transpile-only scripts/selftest-kd100.ts
 * 集成模式（真实只读询价，需 KD100_KEY/SECRET 与门店坐标）：... selftest-kd100.ts --integration
 */
import assert from 'assert'
import crypto from 'crypto'
import { _sign, _mapReturnCode, _buildOrderParam, kd100Provider } from '../src/services/delivery/kd100'
import { signKd100 } from '../src/services/delivery/kd100-client'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}
const md5U = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase()

t('签名 = MD5(param+t+key+secret) 32 位大写', () => {
  const s = _sign('{"a":1}', '1725400000000', 'K', 'S')
  assert.strictEqual(s, md5U('{"a":1}' + '1725400000000' + 'K' + 'S'))
  assert.match(s, /^[0-9A-F]{32}$/)
})
t('错误码映射', () => {
  for (const c of ['30001','30002','30003','30006']) assert.strictEqual(_mapReturnCode(c), 'CONFIG', c)
  assert.strictEqual(_mapReturnCode('30005'), 'CAPACITY')
  assert.strictEqual(_mapReturnCode('30004'), 'BALANCE')
  assert.strictEqual(_mapReturnCode('50000'), 'BUSINESS')
})
t('下单 param：坐标 6 位小数、重量 1 位、金额转元、callbackUrl 原样', () => {
  const p = _buildOrderParam({
    deliveryNo: 'D42-1', callbackUrl: 'http://x/api/kd/D42-1', callbackSalt: 'salt16charsalt16',
    sender: { name:'店', mobile:'15309003232', province:'四川省', city:'自贡市', district:'高新区', address:'丹桂40栋', latE6: 29339000, lngE6: 104778000 },
    receiver: { name:'客', mobile:'13800000000', province:'四川省', city:'自贡市', district:'高新区', address:'某小区', latE6: 29350000, lngE6: 104790000 },
    goods: { title:'凉菜', weightKg: 0.6, totalPriceFen: 2400, count: 2 }, remark: '不要辣',
  }, ['shunfengtongcheng','dadatongcheng'], '食品') as Record<string, unknown>
  assert.strictEqual(p.sendManLat, '29.339000'); assert.strictEqual(p.recManLng, '104.790000')
  assert.strictEqual(p.lbsType, 2); assert.strictEqual(p.weight, '0.6'); assert.strictEqual(p.price, '24.00')
  assert.deepStrictEqual(p.kuaidiComList, ['shunfengtongcheng','dadatongcheng'])
  assert.deepStrictEqual(p.goods, [{ name: '凉菜', type: '食品', count: 2 }])
  assert.strictEqual(p.callbackUrl, 'http://x/api/kd/D42-1'); assert.strictEqual(p.salt, 'salt16charsalt16')
  assert.strictEqual(p.orderType, 0)
})
t('回调验签：正确通过、篡改失败、多字节 sign 不抛异常、缺 param 报 BAD_PARAM', () => {
  const salt = 'abc123'
  const param = JSON.stringify({ orderId:'KD1', kuaidicom:'shansongtongcheng', status:'310', statusDesc:'骑手已取货', courierName:'张三', courierMobile:'13911112222', updateTime:'2026-09-04 10:00:00' })
  const good = { taskId: 'T1', param, sign: md5U(param + salt) }
  const r1 = kd100Provider.verifyAndParseCallback(good, salt)
  assert.ok(r1.ok && r1.payload.providerStatus === '310' && r1.payload.courierName === '张三')
  assert.ok(r1.ok && r1.payload.providerUpdateTime instanceof Date)
  const r2 = kd100Provider.verifyAndParseCallback({ ...good, sign: md5U(param + 'WRONG') }, salt)
  assert.deepStrictEqual(r2, { ok: false, reason: 'SIGN_MISMATCH' })
  const r3 = kd100Provider.verifyAndParseCallback({ ...good, sign: '汉'.repeat(32) }, salt)
  assert.deepStrictEqual(r3, { ok: false, reason: 'SIGN_MISMATCH' })
  // 签名必须算对，否则会在字节长度短路处返回 SIGN_MISMATCH，永远踏不到 BAD_PARAM 分支
  const r4 = kd100Provider.verifyAndParseCallback({ taskId:'T1', param: 'not-json', sign: md5U('not-json' + salt) }, salt)
  assert.deepStrictEqual(r4, { ok: false, reason: 'BAD_PARAM' })
  const r5 = kd100Provider.verifyAndParseCallback({ taskId:'T1', sign: md5U('x' + salt) } as never, salt)
  assert.deepStrictEqual(r5, { ok: false, reason: 'BAD_PARAM' })   // param 缺失
})
t('回调字段截断（statusDesc 500 字 → 255）', () => {
  const salt = 's'
  const param = JSON.stringify({ orderId:'K', status:'510', statusDesc: '异'.repeat(500), updateTime: null })
  const r = kd100Provider.verifyAndParseCallback({ taskId:'T', param, sign: md5U(param + salt) }, salt)
  assert.ok(r.ok && (r.payload.statusDesc ?? '').length === 255)
})
t('_sign 与 kd100-client.signKd100 逐字节一致', () => {
  assert.strictEqual(_sign('{"x":"中文"}', '1725400000000', 'K', 'S'), signKd100('{"x":"中文"}', '1725400000000', 'K', 'S'))
})
console.log(`\n${process.exitCode ? '有失败' : `全部通过 ${pass}`}`)

if (process.argv.includes('--integration')) {
  ;(async () => {
    const { config } = await import('../src/config')
    if (!config.kd100.key || !config.kd100.secret) { console.log('（--integration 跳过：未配置 KD100_KEY/SECRET）'); return }
    const { getLocalSettings } = await import('../src/services/local-settings')
    const s = await getLocalSettings()
    if (s.store.latE6 === null || s.store.lngE6 === null) { console.log('（--integration 跳过：门店未设坐标）'); return }
    const r = await kd100Provider.price({
      deliveryNo: 'probe', callbackUrl: '', callbackSalt: '',
      sender: { name: s.store.name, mobile: s.store.phone, province: s.store.province, city: s.store.city, district: s.store.district, address: s.store.address, latE6: s.store.latE6, lngE6: s.store.lngE6 },
      receiver: { name: '探测', mobile: '13800000000', province: s.store.province, city: s.store.city, district: s.store.district, address: '探测点', latE6: s.store.latE6 + 9000, lngE6: s.store.lngE6 + 9000 },
      goods: { title: '凉菜', weightKg: 0.5, totalPriceFen: 2000, count: 1 }, remark: '',
    } as never)
    console.log('真实询价（只读不扣费）:', JSON.stringify(r))
    // 断言，不只是打印。此前这里只 console.log，于是 2026-09-06 之前
    // 「查价其实一直在失败」（price() 把 callbackUrl 写成空串 → 30001）
    // 跑这个 --integration 也是 exit 0，等于没有闸门。
    if (!r.quotes || r.quotes.length === 0) {
      console.error('  ✘ 没有拿到任何运力报价——密钥、门店坐标、运力覆盖、callbackUrl 格式，四者之一有问题')
      process.exit(1)
    }
    if (r.distanceM === null || r.distanceM === undefined) {
      console.error('  ✘ 拿到报价但没有 distanceM——字段名可能变了（官方文档是驼峰 kuaidiCom/distance）')
      process.exit(1)
    }
    console.log(`  ✔ ${r.quotes.length} 家运力有覆盖，最低 ¥${(r.feeFen / 100).toFixed(2)}，道路距离 ${r.distanceM}m`)
    for (const q of r.quotes) console.log(`      ${q.provider.padEnd(22)} ¥${(q.feeFen / 100).toFixed(2)}  ${q.distanceM ?? '?'}m`)
    process.exit(process.exitCode ?? 0)
  })().catch((e) => { console.error('--integration 失败:', (e as Error).message); process.exit(1) })
}
