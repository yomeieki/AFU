// 订单状态标签组件（components/order-status-tag）的行为锁。
//
// M2（复审阻塞，2026-09-23）：「我的订单」列表里同城配送中的单显示「已发货」——
// 组件表原来只对 PICKUP 改文案，缺 LOCAL SHIPPED → 「配送中」这一条。列表页
// list.js 自己算出的 LOCAL_STATUS_LABEL/statusLabel 是对的，但渲染早就换成了
// 这个组件（list.wxml:47），statusLabel 字段无人再读——这也是原有测试只断言
// decorate() 的数据、测不出真实渲染结果的原因（假绿）。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const FILE = path.resolve(__dirname, '../../apps/miniapp/components/order-status-tag/index.js')

// 与 tests/miniapp/freeship-bar.test.cjs 的 promoBarComponent() 同一套 node:vm 加载手法：
// 组件文件里没有 module.exports，只能靠劫持全局 Component() 把配置对象接出来。
function loadOrderStatusTagComponent() {
  let config
  vm.runInNewContext(fs.readFileSync(FILE, 'utf8'), {
    require: (name) => require(path.resolve(path.dirname(FILE), name)),
    Component: (c) => { config = c },
  })
  return config
}

function tagLabelOf(status, deliveryType, scheduled) {
  const config = loadOrderStatusTagComponent()
  const c = { data: { label: '' }, setData(p) { Object.assign(this.data, p) } }
  config.observers['status, deliveryType, scheduled'].call(c, status, deliveryType, !!scheduled)
  return c.data.label
}

test('T2a M2：LOCAL SHIPPED 显示「配送中」（预约/非预约都一样），其余渠道/状态不变', () => {
  assert.equal(tagLabelOf('SHIPPED', 'LOCAL', false), '配送中')
  assert.equal(tagLabelOf('SHIPPED', 'LOCAL', true), '配送中')
  assert.equal(tagLabelOf('SHIPPED', 'PICKUP', false), '待取餐')
  assert.equal(tagLabelOf('SHIPPED', 'EXPRESS', false), '已发货')
  assert.equal(tagLabelOf('PAID', 'LOCAL', true), '已预约')
  assert.equal(tagLabelOf('PAID', 'LOCAL', false), '待发货')
  assert.equal(tagLabelOf('COMPLETED', 'LOCAL', false), '已完成')
  assert.equal(tagLabelOf('REFUNDING', 'LOCAL', false), '退款中')
})

test('T2b M2：列表页 wxml 渲染走组件，不再直接输出 item.statusLabel', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '../../apps/miniapp/pages/order/list.wxml'), 'utf8')
  assert.match(wxml, /<order-status-tag[^>]*>/)
  const tag = /<order-status-tag[^>]*>/.exec(wxml)[0]
  assert.match(tag, /delivery-type="\{\{item\.deliveryType\}\}"/)
  assert.match(tag, /scheduled="\{\{!!item\.scheduledAt\}\}"/)
  assert.doesNotMatch(wxml, /\{\{item\.statusLabel\}\}/)
})

