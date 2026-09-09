// 邮寄订单详情的物流卡文案（spec §4.2 六种）与轨迹容错。纯函数，直接 require utils，不需要 Page 环境。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildExpressTrack, expressStageText } = require(path.join(__dirname, '..', '..', 'apps', 'miniapp', 'utils', 'express-track.js'))

const base = { deliveryType: 'EXPRESS', status: 'PREPARING', expressBooking: null }
const eb = (status, extra) => Object.assign({ status, statusLabel: '', courierLabel: '京东物流', courierName: null, slotText: '9月9日 14:00–16:00', kuaidinum: null }, extra || {})

test('§4.2 六种卡片文案', () => {
  assert.equal(expressStageText(base), '商家备货中')
  assert.equal(expressStageText({ ...base, status: 'PAID' }), '商家备货中')
  assert.equal(expressStageText({ ...base, expressBooking: eb('CANCELLED') }), '商家备货中')
  assert.equal(expressStageText({ ...base, expressBooking: eb('PENDING') }), '商家备货中')
  assert.equal(expressStageText({ ...base, expressBooking: eb('BOOKED') }), '已预约快递员上门取件 · 9月9日 14:00–16:00')
  assert.equal(expressStageText({ ...base, expressBooking: eb('UNKNOWN') }), '已预约快递员上门取件 · 9月9日 14:00–16:00')
  assert.equal(expressStageText({ ...base, expressBooking: eb('ACCEPTED', { courierName: '张师傅' }) }), '快递员已接单 · 张师傅 · 9月9日 14:00–16:00')
  assert.equal(expressStageText({ ...base, expressBooking: eb('PICKED', { kuaidinum: 'JD001' }) }), '已取件 · 京东物流 JD001')
  // 已发货：让位给 Shipment 卡（批次二决定，不变）
  assert.equal(expressStageText({ ...base, status: 'SHIPPED', expressBooking: eb('PICKED', { kuaidinum: 'JD001' }) }), '')
  // 批次三：订单完成且预约签收 → 已签收；老邮寄单（无预约）完成 → 仍不显示阶段卡
  assert.equal(expressStageText({ ...base, status: 'COMPLETED', expressBooking: eb('DELIVERED', { kuaidinum: 'JD001' }) }), '已签收 · 京东物流 JD001')
  assert.equal(expressStageText({ ...base, status: 'COMPLETED', expressBooking: eb('PICKED', { kuaidinum: 'JD001' }) }), '已签收 · 京东物流 JD001')
  assert.equal(expressStageText({ ...base, status: 'COMPLETED' }), '')
  assert.equal(expressStageText({ ...base, status: 'COMPLETED', expressBooking: eb('CANCELLED') }), '')
  // 同城/取消/退款：不显示
  assert.equal(expressStageText({ ...base, deliveryType: 'LOCAL', expressBooking: eb('BOOKED') }), '')
  assert.equal(expressStageText({ ...base, status: 'CANCELLED', expressBooking: eb('BOOKED') }), '')
  assert.equal(expressStageText({ ...base, status: 'REFUNDED', expressBooking: eb('PICKED') }), '')
})

test('轨迹：最新在上照服务端顺序、脏条目剔除、空/缺字段不抛', () => {
  assert.deepEqual(buildExpressTrack(null), [])
  assert.deepEqual(buildExpressTrack({}), [])
  assert.deepEqual(buildExpressTrack({ items: 'x' }), [])
  assert.deepEqual(buildExpressTrack({ items: [null, 1, { ftime: '2026-09-10 10:00:00' }, { context: '' }] }), [])
  const r = buildExpressTrack({ signed: false, items: [{ context: '【成都市】运输中', ftime: '2026-09-10 12:00:00' }, { context: '【自贡市】已揽收', ftime: 20260910 }] })
  assert.deepEqual(r, [{ context: '【成都市】运输中', timeText: '2026-09-10 12:00:00' }, { context: '【自贡市】已揽收', timeText: '' }])
})
