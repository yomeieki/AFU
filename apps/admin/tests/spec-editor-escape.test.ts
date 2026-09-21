import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleEscapeKey } from '../src/components/SpecEditor'

// R4（第一轮复核 R4）：规格值改名输入框按 Esc 取消时，不能连带关掉外层「编辑商品」
// Modal —— 外层 Modal 在 document 上注册的是原生 keydown 监听（见
// apps/admin/src/components/ui/Modal.tsx），只调用 React 合成事件的
// stopPropagation 挡不住它，必须额外调用 nativeEvent.stopImmediatePropagation()。
// handleEscapeKey 是从 SpecEditor 的 Escape 分支里抽出的纯函数，这里直接验证
// 它确实调用了三个方法（包括 stopImmediatePropagation），不依赖 DOM/jsdom。
test('R4 handleEscapeKey 调用 preventDefault / stopPropagation / nativeEvent.stopImmediatePropagation', () => {
  let preventDefaultCalled = false
  let stopPropagationCalled = false
  let stopImmediatePropagationCalled = false

  handleEscapeKey({
    preventDefault: () => {
      preventDefaultCalled = true
    },
    stopPropagation: () => {
      stopPropagationCalled = true
    },
    nativeEvent: {
      stopImmediatePropagation: () => {
        stopImmediatePropagationCalled = true
      },
    },
  })

  assert.equal(preventDefaultCalled, true)
  assert.equal(stopPropagationCalled, true)
  assert.equal(stopImmediatePropagationCalled, true)
})

test('R4 handleEscapeKey 在没有 nativeEvent.stopImmediatePropagation 时不抛错（可选链兜底）', () => {
  let preventDefaultCalled = false
  let stopPropagationCalled = false
  assert.doesNotThrow(() =>
    handleEscapeKey({
      preventDefault: () => {
        preventDefaultCalled = true
      },
      stopPropagation: () => {
        stopPropagationCalled = true
      },
    })
  )
  assert.equal(preventDefaultCalled, true)
  assert.equal(stopPropagationCalled, true)
})
