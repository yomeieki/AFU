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
