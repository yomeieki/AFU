import { test } from 'node:test'
import assert from 'node:assert/strict'
import { showWorkbenchLink, itemsSummary, channelTag, deliveryColumn } from './order-list.ts'

// 2026-09-18 12:00 Asia/Shanghai = 2026-09-18T04:00:00Z
const NOW = new Date('2026-09-18T04:00:00Z')
const TODAY_ISO = '2026-09-18T02:00:00Z' // 上海 10:00，今天
const YDAY_ISO = '2026-09-17T02:00:00Z' // 上海昨天

test('showWorkbenchLink：今天 PAID 的同城单 → true', () => {
  assert.equal(showWorkbenchLink({ deliveryType: 'LOCAL', status: 'PAID', createdAt: TODAY_ISO }, NOW), true)
})

test('showWorkbenchLink：今天 COMPLETED → false（终态不在看板上）', () => {
  assert.equal(showWorkbenchLink({ deliveryType: 'LOCAL', status: 'COMPLETED', createdAt: TODAY_ISO }, NOW), false)
})

test('showWorkbenchLink：昨天 PAID → false', () => {
  assert.equal(showWorkbenchLink({ deliveryType: 'LOCAL', status: 'PAID', createdAt: YDAY_ISO }, NOW), false)
})

test('showWorkbenchLink：今天 EXPRESS PAID → false（只认同城/自取）', () => {
  assert.equal(showWorkbenchLink({ deliveryType: 'EXPRESS', status: 'PAID', createdAt: TODAY_ISO }, NOW), false)
})

test('showWorkbenchLink：北京凌晨 00:30 下的单，now 为同日 08:00 → true', () => {
  // createdAt = UTC 前一日 16:30 = 北京 2026-09-18 00:30
  const createdAt = '2026-09-17T16:30:00Z'
  const now = new Date('2026-09-18T00:00:00Z') // 北京 08:00
  assert.equal(showWorkbenchLink({ deliveryType: 'LOCAL', status: 'PAID', createdAt }, now), true)
})

test('showWorkbenchLink：自取单同样适用', () => {
  assert.equal(showWorkbenchLink({ deliveryType: 'PICKUP', status: 'PREPARING', createdAt: TODAY_ISO }, NOW), true)
})

test('itemsSummary：拼商品摘要，赠品加「赠」前缀', () => {
  assert.equal(
    itemsSummary([
      { productName: '凉拌牛肉', specText: null, quantity: 1 },
      { productName: '红油毛肚', specText: '微辣', quantity: 2 },
      { productName: '小菜', specText: null, quantity: 1, isGift: true },
    ]),
    '凉拌牛肉×1，红油毛肚[微辣]×2，赠小菜×1'
  )
})

test('channelTag：三渠道', () => {
  assert.deepEqual(channelTag('LOCAL'), { label: '外送', tone: 'local' })
  assert.deepEqual(channelTag('PICKUP'), { label: '自取', tone: 'pickup' })
  assert.deepEqual(channelTag('EXPRESS'), { label: '邮寄', tone: 'express' })
})

test('deliveryColumn：LOCAL 有骑手', () => {
  const r = deliveryColumn(
    { deliveryType: 'LOCAL', status: 'SHIPPED', pickupAt: null, pickupReadyAt: null, completedAt: null, shipment: null, latestDelivery: { status: 'DELIVERING', courierName: '小李', courierCompany: null, provider: 'KD100' } },
    NOW
  )
  assert.deepEqual(r, ['骑手 小李', '配送中'])
})

test('deliveryColumn：LOCAL 未呼叫', () => {
  const r = deliveryColumn(
    { deliveryType: 'LOCAL', status: 'PAID', pickupAt: null, pickupReadyAt: null, completedAt: null, shipment: null, latestDelivery: null, scheduledAt: null, schedule: null },
    NOW
  )
  assert.deepEqual(r, ['未呼叫', ''])
})

test('deliveryColumn：LOCAL 预约单，有 schedule 节 → 首行用 slotLabel', () => {
  const r = deliveryColumn(
    {
      deliveryType: 'LOCAL', status: 'PAID', pickupAt: null, pickupReadyAt: null, completedAt: null, shipment: null, latestDelivery: null,
      scheduledAt: '2026-09-18T04:00:00Z',
      schedule: {
        scheduledAt: '2026-09-18T04:00:00Z', slotLabel: '今天 12:00-12:30', ticketAt: '2026-09-18T03:30:00Z',
        prepStartAt: '2026-09-18T03:40:00Z', callAt: '2026-09-18T03:55:00Z', acceptDueAt: '2026-09-18T02:00:00Z',
        selfCancelUntil: '2026-09-18T02:00:00Z', readyAt: null, phase: 'WAITING', etaIfCallNow: '2026-09-18T04:05:00Z', callToleranceMin: 5,
      },
    },
    NOW
  )
  assert.deepEqual(r, ['预约 今天 12:00-12:30', ''])
})

test('deliveryColumn：LOCAL 预约单，列表接口无 schedule 节 → 退回 fmtMonthDayTime(scheduledAt)', () => {
  const r = deliveryColumn(
    {
      deliveryType: 'LOCAL', status: 'PAID', pickupAt: null, pickupReadyAt: null, completedAt: null, shipment: null,
      latestDelivery: { status: 'CALLING', courierName: null, courierCompany: null, provider: 'KD100' },
      scheduledAt: '2026-09-18T04:00:00Z', schedule: undefined,
    },
    NOW
  )
  assert.deepEqual(r, ['预约 9-18 12:00', '待抢单'])
})

test('deliveryColumn：PICKUP 已备好', () => {
  const r = deliveryColumn(
    { deliveryType: 'PICKUP', status: 'SHIPPED', pickupAt: '2026-09-18T04:30:00Z', pickupReadyAt: '2026-09-18T03:00:00Z', completedAt: null, shipment: null, latestDelivery: null },
    NOW
  )
  assert.deepEqual(r, ['取餐 12:30', '已备好'])
})

test('deliveryColumn：PICKUP 已取走', () => {
  const r = deliveryColumn(
    { deliveryType: 'PICKUP', status: 'COMPLETED', pickupAt: '2026-09-18T04:30:00Z', pickupReadyAt: '2026-09-18T03:00:00Z', completedAt: '2026-09-18T05:00:00Z', shipment: null, latestDelivery: null },
    NOW
  )
  assert.deepEqual(r, ['取餐 12:30', '已取走'])
})

test('deliveryColumn：EXPRESS 未发货', () => {
  const r = deliveryColumn(
    { deliveryType: 'EXPRESS', status: 'PAID', pickupAt: null, pickupReadyAt: null, completedAt: null, shipment: null, latestDelivery: null },
    NOW
  )
  assert.deepEqual(r, ['未发货', ''])
})

test('deliveryColumn：EXPRESS 已发货', () => {
  const r = deliveryColumn(
    {
      deliveryType: 'EXPRESS', status: 'SHIPPED', pickupAt: null, pickupReadyAt: null, completedAt: null,
      shipment: { id: 1, orderId: 1, expressCompany: '顺丰速运', expressNo: 'SF123', shippedAt: '2026-09-10T04:00:00Z', remark: null },
      latestDelivery: null,
    },
    NOW
  )
  assert.deepEqual(r, ['顺丰速运 SF123', '9-10 12:00 发货'])
})
