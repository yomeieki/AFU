// 时段选择弹层组件（components/slot-picker）的行为锁。
//
// M10（复审建议，纳入本批）：外送（同城预约送达）弹层里也显示「无可取时段」
// 「这一天已无可取时段」——这是自取页的用词，外送场景说「取」不通顺。
// 店主决定 D4：外送用「无可选时段」「这一天已无可选时段」，自取页文案逐字不变
// （默认值保持旧文案，只有 confirm.wxml 显式传新文案）。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../../apps/miniapp', rel), 'utf8')

function loadSlotPickerConfig() {
  let config
  const file = path.resolve(__dirname, '../../apps/miniapp/components/slot-picker/index.js')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: (name) => require(path.resolve(path.dirname(file), name)),
    Component: (c) => { config = c },
  })
  return config
}

test('T10 M10：组件 wxml 不再写死「无可取时段」字面量，改用可配置的 emptyLabel/dayEmptyLabel', () => {
  const wxml = read('components/slot-picker/index.wxml')
  assert.doesNotMatch(wxml, /无可取时段/)
  assert.match(wxml, /\{\{emptyLabel\}\}/)
  assert.match(wxml, /\{\{dayEmptyLabel\}\}/)
})

test('T10 M10：组件 properties 默认值仍是自取页原文案（自取页不用改一个字）', () => {
  const config = loadSlotPickerConfig()
  assert.equal(config.properties.emptyLabel.value, '无可取时段')
  assert.equal(config.properties.dayEmptyLabel.value, '这一天已无可取时段')
})

test('T10 D4：同城预约结算页（外送）显式传「无可选时段」新文案', () => {
  const wxml = read('pages/local/confirm.wxml')
  const tag = /<slot-picker[^>]*\/>/.exec(wxml)
  assert.ok(tag, '找不到 <slot-picker 标签')
  assert.match(tag[0], /empty-label="无可选时段"/)
  assert.match(tag[0], /day-empty-label="这一天已无可选时段"/)
})

test('T10 M10 回归：自取结算页不传 empty-label（沿用组件默认的自取文案）', () => {
  const wxml = read('pages/local/pickup.wxml')
  const tag = /<slot-picker[^>]*\/>/.exec(wxml) || /<slot-picker[\s\S]*?\/>/.exec(wxml)
  assert.ok(tag, '找不到 <slot-picker 标签')
  assert.doesNotMatch(tag[0], /empty-label=/)
})
