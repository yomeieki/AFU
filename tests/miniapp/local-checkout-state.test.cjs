// 同城结算页底部按钮的行为锁。
//
// 这个纯函数是整个结算页唯一的「能不能提交」判定。它存在的理由是一类具体事故：
// 地址换了、数量改了、券变了之后，页面上还留着一个能点的旧金额按钮，
// 顾客按下去，服务端拿着过期的 quoteToken 报 42239——顾客看到的是看不懂的报错。
//
// 所以这里锁的是三件事一起变：disabled / text / amountState，外加点下去干什么（action）。
// 只改文案不改可点性，或者只禁用不改金额展示，都算没做对。
const test = require('node:test')
const assert = require('node:assert/strict')

const { checkoutAction } = require('../../apps/miniapp/utils/local-checkout-state')

// 一份「什么都齐了、可以提交」的基线，各用例只覆盖自己关心的那一两个字段。
const READY = {
  hasAddress: true,
  hasLocation: true,
  quoteToken: 'signed',
  quoteExpiresAt: 1893456000000,
  now: 1893455000000,
  payAmount: 4900,
}
const on = function (over) { return Object.assign({}, READY, over) }

test('地址与报价一变，绝不留下一个能点的旧金额按钮', function () {
  assert.deepEqual(checkoutAction({ hasAddress: false }),
    { disabled: true, text: '请选择地址', amountState: 'pending', action: 'none' })
  assert.deepEqual(checkoutAction(on({ hasLocation: false })),
    { disabled: true, text: '请补充定位', amountState: 'pending', action: 'none' })
  assert.deepEqual(checkoutAction({ hasAddress: true, quoting: true }),
    { disabled: true, text: '正在计算运费', amountState: 'pending', action: 'none' })
})

// 店主 2026-09-07 拍板的方案 B：这一格按钮是**可点的**，点了重新报价。
// 与之配套的硬约束在 action 上——页面必须按 action 分派，不能以「没禁用」推断该提交。
test('报价失败：按钮可点，但它的动作是重新报价，不是提交', function () {
  assert.deepEqual(checkoutAction({ hasAddress: true, quoteError: true }),
    { disabled: false, text: '重新获取运费', amountState: 'error', action: 'retry' })
})

test('业务阻塞（暂停/打烊/超范围/未达起送）统一一句短文案，长原因不进按钮', function () {
  var blocked = checkoutAction(on({ blockReason: '超出配送范围：本单约 12.4 km，本店配送上限 10 km' }))
  assert.deepEqual(blocked, { disabled: true, text: '暂不可配送', amountState: 'blocked', action: 'none' })
})

test('只有报价新鲜且应付金额算得出来，才允许提交', function () {
  assert.deepEqual(checkoutAction(READY),
    { disabled: false, text: '提交订单', amountState: 'ready', action: 'submit' })
})

test('提交中：文案变、按钮锁死，但金额继续显示（顾客要看得见自己在付多少）', function () {
  assert.deepEqual(checkoutAction(on({ submitting: true })),
    { disabled: true, text: '提交中', amountState: 'ready', action: 'submit' })
})

test('没有 quoteToken 或算不出应付金额时，一律按「还在算」处理，不放行', function () {
  assert.deepEqual(checkoutAction(on({ quoteToken: null })),
    { disabled: true, text: '正在计算运费', amountState: 'pending', action: 'none' })
  assert.deepEqual(checkoutAction(on({ payAmount: null })),
    { disabled: true, text: '正在计算运费', amountState: 'pending', action: 'none' })
})

// 优先级是有意排的：先问地址，再问报价，最后才问业务规则。
// 反过来的话，没填地址的顾客会先看到「暂不可配送」——他会以为这个店送不到他那儿。
test('优先级固定：地址 → 报价 → 业务阻塞 → 提交中', function () {
  assert.equal(checkoutAction({ hasAddress: false, quoteError: true, blockReason: '已打烊' }).text, '请选择地址')
  assert.equal(checkoutAction({ hasAddress: true, hasLocation: false, blockReason: '已打烊' }).text, '请补充定位')
  assert.equal(checkoutAction({ hasAddress: true, quoting: true, blockReason: '已打烊' }).text, '正在计算运费')
  assert.equal(checkoutAction({ hasAddress: true, quoteError: true, blockReason: '已打烊' }).text, '重新获取运费')
  assert.equal(checkoutAction(on({ blockReason: '已打烊', submitting: true })).text, '暂不可配送')
})

// 按钮宽度是按这七种文案定的，多一种就可能在 320 宽的机器上溢出。
test('文案只允许这七种', function () {
  var allowed = ['请选择地址', '请补充定位', '正在计算运费', '重新获取运费', '暂不可配送', '提交订单', '提交中']
  var cases = [
    {}, { hasAddress: true }, { hasAddress: true, hasLocation: false },
    { hasAddress: true, quoting: true }, { hasAddress: true, quoteError: true },
    on({ blockReason: 'x' }), READY, on({ submitting: true }), on({ quoteToken: null }),
  ]
  cases.forEach(function (c) {
    var r = checkoutAction(c)
    assert.ok(allowed.indexOf(r.text) !== -1, '意外文案：' + r.text)
    assert.ok(['submit', 'retry', 'none'].indexOf(r.action) !== -1, '意外 action：' + r.action)
    assert.ok(['ready', 'pending', 'error', 'blocked'].indexOf(r.amountState) !== -1, '意外 amountState：' + r.amountState)
  })
})

test('传 undefined / 空对象不抛，按「没选地址」处理', function () {
  assert.equal(checkoutAction().text, '请选择地址')
  assert.equal(checkoutAction({}).text, '请选择地址')
})
