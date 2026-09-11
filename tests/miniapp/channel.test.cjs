// 渠道上下文的行为锁。
//
// 这个模块是「同城 / 邮寄」两套内容共用四个 tabBar 页的地基：页面自己不判渠道，
// 只问它。所以它出错的表现不是报错，而是**顾客在同城模式下看到邮寄的商品**——
// 静默、且不容易在开发者工具里发现。用测试钉死。
const test = require('node:test')
const assert = require('node:assert/strict')

const MODULE = '../../apps/miniapp/utils/channel'

/** 每个用例都换一份 wx 桩，并清掉 require 缓存，避免用例之间互相污染。 */
function load(stub) {
  delete require.cache[require.resolve(MODULE)]
  global.wx = stub
  return require(MODULE)
}

test('切 tab 不会改变渠道：LOCAL 存进去读出来还是 LOCAL，查询串显式带渠道', function () {
  const channel = load({
    getStorageSync: function () { return 'LOCAL' },
    setStorageSync: function () {},
  })
  assert.equal(channel.getShoppingChannel(), 'LOCAL')
  assert.equal(channel.channelQuery('LOCAL'), 'channel=LOCAL')
  assert.equal(channel.channelQuery('EXPRESS'), 'channel=EXPRESS')
})

test('storage 里是非法值时回落 EXPRESS，不是抛错也不是原样透传', function () {
  const channel = load({ getStorageSync: function () { return 'OTHER' } })
  assert.equal(channel.getShoppingChannel(), 'EXPRESS')
})

test('storage 为空（首次冷启动）回落 EXPRESS', function () {
  const channel = load({ getStorageSync: function () { return '' } })
  assert.equal(channel.getShoppingChannel(), 'EXPRESS')
})

test('setShoppingChannel 归一化后再写，并把归一化结果返回给调用方', function () {
  const written = []
  const channel = load({
    getStorageSync: function () { return '' },
    setStorageSync: function (k, v) { written.push([k, v]) },
  })
  assert.equal(channel.setShoppingChannel('LOCAL'), 'LOCAL')
  assert.equal(channel.setShoppingChannel('rubbish'), 'EXPRESS')
  assert.deepEqual(written, [['shoppingChannel', 'LOCAL'], ['shoppingChannel', 'EXPRESS']])
})

// 隐私模式、storage 被清、开发者工具偶发都可能让这两个 API 抛。
// 抛在 app.onLaunch 里就是整个小程序打不开——比渠道记错严重得多。
test('storage 读写抛异常时不向上抛，读回落 EXPRESS、写仍返回归一化值', function () {
  const channel = load({
    getStorageSync: function () { throw new Error('storage unavailable') },
    setStorageSync: function () { throw new Error('storage unavailable') },
  })
  assert.equal(channel.getShoppingChannel(), 'EXPRESS')
  assert.equal(channel.setShoppingChannel('LOCAL'), 'LOCAL')
})

test('normalizeChannel 只认这两个值', function () {
  const channel = load({ getStorageSync: function () { return '' } })
  assert.equal(channel.normalizeChannel('LOCAL'), 'LOCAL')
  assert.equal(channel.normalizeChannel('EXPRESS'), 'EXPRESS')
  assert.equal(channel.normalizeChannel('local'), 'EXPRESS')
  assert.equal(channel.normalizeChannel(undefined), 'EXPRESS')
  assert.equal(channel.normalizeChannel(null), 'EXPRESS')
})
test('同城子模式：只认 PICKUP，其余一律 DELIVERY；落盘失败不抛', function () {
  const channel = load({
    getStorageSync: function () { return 'PICKUP' },
    setStorageSync: function () { throw new Error('quota') },
  })
  assert.equal(channel.getLocalMode(), 'PICKUP')
  assert.equal(channel.normalizeLocalMode('WHATEVER'), 'DELIVERY')
  assert.equal(channel.setLocalMode('PICKUP'), 'PICKUP')
  assert.equal(channel.MODE_STORAGE_KEY, 'localMode')
})
test('storage 读模式抛错时回落 DELIVERY', function () {
  const channel = load({ getStorageSync: function () { throw new Error('boom') } })
  assert.equal(channel.getLocalMode(), 'DELIVERY')
})
