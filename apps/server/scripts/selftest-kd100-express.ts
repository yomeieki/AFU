/**
 * 快递100 上门取件协议自测（离线）：cd apps/server && npx ts-node --transpile-only scripts/selftest-kd100-express.ts
 */
import assert from 'assert'
import { _buildBatchPriceParam, _parseBatchPrice, _mapExpressReturnCode } from '../src/services/delivery/kd100-express'
import { queueExpressDirective, resetExpressMock, expressMockProvider, getExpressCalls } from '../src/services/delivery/express-mock'
import { ProviderError } from '../src/services/delivery/types'

let pass = 0
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log('  ✔', name) }, (e) => { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 })
}

async function main() {
  await t('batchPrice param：编码数组、两端地址、重量一位小数', () => {
    const p = _buildBatchPriceParam({ couriers: ['jd', 'shunfeng'], senderAddr: '四川省自贡市A', receiverAddr: '北京市B', weightKg: 1.5 })
    assert.deepStrictEqual(p, { kuaidiComList: ['jd', 'shunfeng'], sendManPrintAddr: '四川省自贡市A', recManPrintAddr: '北京市B', weight: '1.5' })
  })
  await t('解析响应：元→分、null 保留、缺字段兜底', () => {
    const q = _parseBatchPrice([
      { kuaidiCom: 'jd', price: '11.30', defPrice: '15.00', serviceType: '特惠送' },
      { kuaidiCom: 'shunfeng', price: null, defPrice: null, serviceType: null },
      { kuaidiCom: '', price: '1.00' },
    ])
    assert.deepStrictEqual(q, [
      { kuaidicom: 'jd', serviceType: '特惠送', priceFen: 1130, defPriceFen: 1500 },
      { kuaidicom: 'shunfeng', serviceType: null, priceFen: null, defPriceFen: null },
    ])
    assert.deepStrictEqual(_parseBatchPrice('garbage'), [])
  })
  await t('解析响应：非正价格（0 / 空串）一律按 null 处理，不能进中位数', () => {
    const q = _parseBatchPrice([
      { kuaidiCom: 'jd', price: '0' },
      { kuaidiCom: 'yunda', price: '' },
    ])
    assert.deepStrictEqual(q, [
      { kuaidicom: 'jd', serviceType: null, priceFen: null, defPriceFen: null },
      { kuaidicom: 'yunda', serviceType: null, priceFen: null, defPriceFen: null },
    ])
  })
  await t('错误码映射：503/600/601 → CONFIG，余额 → BALANCE，其余 BUSINESS', () => {
    assert.strictEqual(_mapExpressReturnCode('503'), 'CONFIG')
    assert.strictEqual(_mapExpressReturnCode('600'), 'CONFIG')
    assert.strictEqual(_mapExpressReturnCode('601'), 'CONFIG')
    assert.strictEqual(_mapExpressReturnCode('500', '账户余额不足'), 'BALANCE')
    assert.strictEqual(_mapExpressReturnCode('500', '当前线路未设置价格'), 'BUSINESS')
    assert.strictEqual(_mapExpressReturnCode('400'), 'BUSINESS')
  })
  await t('mock：默认按 9 家固定表回价，重量续重生效，记录调用', async () => {
    resetExpressMock()
    const q = await expressMockProvider.batchPrice({ couriers: ['jtexpress', 'jd', 'shunfeng'], senderAddr: 'a', receiverAddr: 'b', weightKg: 1.5 })
    assert.deepStrictEqual(q.map((x) => [x.kuaidicom, x.priceFen]), [['jtexpress', 660 + 130], ['jd', 1130 + 130], ['shunfeng', null]])
    assert.strictEqual(getExpressCalls().length, 1)
  })
  await t('mock：指令 ok/timeout/error 各生效一次后回默认', async () => {
    resetExpressMock()
    queueExpressDirective({ kind: 'ok', quotes: [{ kuaidicom: 'jd', serviceType: '特惠送', priceFen: 999, defPriceFen: 1500 }] })
    queueExpressDirective({ kind: 'timeout' })
    queueExpressDirective({ kind: 'error', code: '600', message: '非法用户' })
    const i = { couriers: ['jd'], senderAddr: 'a', receiverAddr: 'b', weightKg: 1 }
    assert.strictEqual((await expressMockProvider.batchPrice(i))[0].priceFen, 999)
    await assert.rejects(() => expressMockProvider.batchPrice(i), (e: unknown) => e instanceof ProviderError && e.kind === 'TIMEOUT')
    await assert.rejects(() => expressMockProvider.batchPrice(i), (e: unknown) => e instanceof ProviderError && e.kind === 'CONFIG' && e.code === '600')
    assert.strictEqual((await expressMockProvider.batchPrice(i))[0].priceFen, 1130)
  })
  console.log(`\n通过 ${pass} 条${process.exitCode ? '，有失败' : ''}`)
}
main()
