// 主页顶栏精简（2026-09-17 店主真机反馈）的行为锁。
//
// 店名与渠道标识都与下方门店头（同城）重复，店主要求同城顶栏只留返回箭头；
// 邮寄没有门店头，标识留着才看得出在哪个渠道。这是纯 wxml 条件渲染，没有
// 一套小程序渲染引擎能在 node 里跑，所以跟 order-channel.test.cjs 里
// 「确认收货按钮排除同城单」那三条一样，走源码级正则断言——只证明
// 「wx:if 条件还在、还是那句」，不证明真机渲染结果，真机验收见人工报告。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const readSrc = (rel) => require('node:fs')
  .readFileSync(path.join(__dirname, '../../apps/miniapp', rel), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')

// 顶栏那一段（<view class="navbar"> … </view>）。店名断言必须只看这一段：
// 主页别处（分享卡、空态文案）将来正当出现店名是允许的，扫全文会误红。
const navbarOf = (src) => {
  const i = src.indexOf('<view class="navbar"')
  assert.ok(i !== -1, '找不到 navbar 容器')
  const end = src.indexOf('<view style="height:', i)
  assert.ok(end > i, '找不到 navbar 容器的结尾占位块')
  return src.slice(i, end)
}

test('主页顶栏：店名节点已删除，两个渠道都不再显示店名', function () {
  const bar = navbarOf(readSrc('pages/index/index.wxml'))
  assert.ok(bar.indexOf('navbar-title') === -1, '顶栏不应再有 navbar-title 节点：' + bar)
  assert.ok(bar.indexOf('阿福凉菜') === -1, '顶栏内不应再硬编码店名：' + bar)
})

test('主页顶栏：渠道标识只在邮寄（EXPRESS）渲染，同城不渲染', function () {
  const src = readSrc('pages/index/index.wxml')
  const m = /<text[^>]*class="navbar-channel"[^>]*>/.exec(src)
  assert.ok(m, '找不到 navbar-channel 节点')
  // 往前找同一个 <text ...> 标签内的 wx:if，必须精确卡死在 EXPRESS，
  // 不能只是「非空即真」或反过来漏掉同城——回退验证时把这一条件去掉就会在这里变红。
  const tag = src.slice(src.lastIndexOf('<text', m.index), m.index + m[0].length)
  assert.ok(/wx:if="\{\{\s*channel\s*===\s*'EXPRESS'\s*\}\}"/.test(tag), '渠道标识必须只在 channel === EXPRESS 时渲染：' + tag)
})

test('主页顶栏：返回箭头不受渠道条件影响，两边都渲染', function () {
  const src = readSrc('pages/index/index.wxml')
  const m = /<view[^>]*class="navbar-back"[^>]*>/.exec(src)
  assert.ok(m, '找不到返回箭头节点')
  assert.ok(m[0].indexOf('wx:if') === -1, '返回箭头不应该有渠道条件：' + m[0])
})
