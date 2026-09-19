const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const read = p => fs.readFileSync(path.join(__dirname, '../../apps/miniapp', p), 'utf8')
test('分类页占位位于 scroll-view 内容，分组与搜索各一处', () => {
  assert.doesNotMatch(read('pages/product/list.wxss'), /\.page-local\s+\.prod-panel/)
  const panel = read('pages/product/list.wxml').match(/<scroll-view\s+class="prod-panel"[\s\S]*?<\/scroll-view>/)[0]
  assert.equal((panel.match(/class="cart-spacer"/g) || []).length, 2)
  assert.match(read('pages/product/list.js').split('measureOffsets() {')[1], /cartSpacerPx/)
})
test('主页底部按实测高度占位', () => {
  assert.doesNotMatch(read('pages/index/index.wxss'), /\.page-local\s*\{/)
  assert.match(read('pages/index/index.wxml'), /class="cart-spacer"/)
})
test('结算条固定尺寸并包含进度提示与整体高度容器', () => {
  const css = read('components/local-cart-bar/index.wxss')
  assert.match(css, /\.local-cart-bar\s*\{[^}]*min-height:\s*88rpx/)
  assert.match(css, /\.local-cart-bar\s+\.checkout-btn\s*\{[^}]*height:\s*68rpx/)
  assert.doesNotMatch(css, /112rpx/)
  assert.match(read('components/local-cart-bar/index.wxml'), /class="cart-dock"/)
  assert.match(read('components/local-cart-bar/index.wxml'), /cart-tip/)
})
test('主页和分类页两个渠道都挂载结算条并监听高度', () => {
  for (const p of ['pages/index/index', 'pages/product/list']) {
    const tag = read(p + '.wxml').match(/<local-cart-bar\b[^>]*>/)[0]
    assert.doesNotMatch(tag, /wx:if/)
    assert.match(tag, /channel="{{channel}}"/)
    assert.match(tag, /bind:height="onCartHeight"/)
  }
})
test('两页活动条位于条件链之外并注册组件', () => {
  for (const p of ['pages/index/index', 'pages/product/list']) {
    const tag = read(p + '.wxml').match(/<promo-bar\b[^>]*>/)
    assert.ok(tag)
    assert.doesNotMatch(tag[0], /wx:elif/)
    assert.equal(JSON.parse(read(p + '.json')).usingComponents['promo-bar'], '/components/promo-bar/index')
  }
})
