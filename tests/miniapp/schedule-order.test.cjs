// 预约送达在订单详情/列表页的文案纯函数行为锁。
//
// 这些函数只读服务端已经算好的字段（order.schedule.* / canSelfCancel / canRequestCancel /
// order.scheduledAt），时刻格式化由调用方传入——这里用一个假的 fmtHHmm 钉文案，不摆弄真实
// 时间戳的时区换算。非预约单必须原样退回 ''/null：立即单、自取、邮寄逐字节不能变。
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  scheduleBannerText,
  schedulePaidExtra,
  scheduleStatusLabel,
  scheduleCancelCopy,
  scheduleTypeLabel,
} = require('../../apps/miniapp/utils/schedule-order')

// 假的 fmtHHmm：按输入的标记字符串回一个好认的钟点，断言只看文案拼接对不对。
function fakeFmt(v) {
  if (v === 'ACCEPT_DUE') return '11:11'
  if (v === 'PREP_START') return '11:16'
  if (v === 'SELF_CANCEL') return '10:00'
  return '??:??'
}

test('scheduleBannerText：预约单顶部横幅，非预约单返回空', function () {
  assert.equal(
    scheduleBannerText({ scheduledAt: '2026-09-23T04:00:00Z', schedule: { slotLabel: '明天 12:00–12:30' } }),
    '预约配送 · 明天 12:00–12:30 送达'
  )
  assert.equal(scheduleBannerText({ scheduledAt: null, schedule: null }), '')
  assert.equal(scheduleBannerText(null), '')
})

test('schedulePaidExtra：接单前提示确认截止，接单后提示备餐开始，非预约单返回空', function () {
  // 接单前：读 schedule.acceptDueAt
  assert.equal(
    schedulePaidExtra({ acceptedAt: null, schedule: { acceptDueAt: 'ACCEPT_DUE', prepStartAt: 'PREP_START' } }, fakeFmt),
    '商家将在 11:11 前确认'
  )
  // 接单后：读 schedule.prepStartAt
  assert.equal(
    schedulePaidExtra({ acceptedAt: '2026-09-23T03:00:00Z', schedule: { acceptDueAt: 'ACCEPT_DUE', prepStartAt: 'PREP_START' } }, fakeFmt),
    '商家已确认，11:16 开始备餐'
  )
  assert.equal(schedulePaidExtra({ acceptedAt: null, schedule: null }, fakeFmt), '')
})

test('scheduleStatusLabel：预约单 PAID 显示已预约，其余状态与非预约单都返回 null', function () {
  assert.equal(scheduleStatusLabel({ scheduledAt: '2026-09-23T04:00:00Z', status: 'PAID' }), '已预约')
  assert.equal(scheduleStatusLabel({ scheduledAt: '2026-09-23T04:00:00Z', status: 'PREPARING' }), null)
  assert.equal(scheduleStatusLabel({ scheduledAt: null, status: 'PAID' }), null)
})

test('scheduleCancelCopy：两小时外/两小时内未备好/已备好三段文案，非预约单返回空', function () {
  // 段一：两小时外，服务端 canSelfCancel=true
  assert.equal(
    scheduleCancelCopy({ canSelfCancel: true, canRequestCancel: false, schedule: { selfCancelUntil: 'SELF_CANCEL', readyAt: null } }, fakeFmt),
    '10:00 前可直接取消'
  )
  // 段二：两小时内且未备好，服务端 canRequestCancel=true
  assert.equal(
    scheduleCancelCopy({ canSelfCancel: false, canRequestCancel: true, schedule: { selfCancelUntil: 'SELF_CANCEL', readyAt: null } }, fakeFmt),
    '可申请取消，商家确认后全额退款'
  )
  // 段三：已备好，两个取消权限都没有了。需求变化（M3）：这句只在 PREPARING（备餐中）
  // 才该出现——服务端只在 PREPARING 写 readyAt（admin/delivery.ts），之后的
  // SHIPPED/COMPLETED/REFUNDED/CANCELLED 详情仍会下发 schedule.readyAt，取消卡不该
  // 再显示「餐品已在准备」这句已经不成立的话。
  assert.equal(
    scheduleCancelCopy({ status: 'PREPARING', canSelfCancel: false, canRequestCancel: false, schedule: { selfCancelUntil: 'SELF_CANCEL', readyAt: '2026-09-23T05:00:00Z' } }, fakeFmt),
    '餐品已在准备，如有问题请联系商家'
  )
  assert.equal(scheduleCancelCopy({ canSelfCancel: true, canRequestCancel: false, schedule: null }, fakeFmt), '')
})

// T3a（M3，复审阻塞）：已备好（readyAt 非空）不再是「两个取消权限都没有」时的兜底——
// 必须同时 status === 'PREPARING' 才显示这句话。终态单（配送中/已完成/已退款/已取消）
// 与仍在退款流程中的单，即便服务端仍下发了 schedule.readyAt，也不该再显示这句已经
// 不成立的「餐品已在准备」。
test('T3a M3：readyAt 非空但不在 PREPARING 时，一律返回空；PREPARING 才显示', function () {
  var terminalStatuses = ['SHIPPED', 'COMPLETED', 'REFUNDED', 'CANCELLED', 'REFUNDING']
  terminalStatuses.forEach(function (status) {
    assert.equal(
      scheduleCancelCopy({ status: status, canSelfCancel: false, canRequestCancel: false, schedule: { selfCancelUntil: 'SELF_CANCEL', readyAt: '2026-09-23T05:00:00Z' } }, fakeFmt),
      '',
      status + ' 不该再显示「餐品已在准备」'
    )
  })
  assert.equal(
    scheduleCancelCopy({ status: 'PREPARING', canSelfCancel: false, canRequestCancel: false, schedule: { selfCancelUntil: 'SELF_CANCEL', readyAt: '2026-09-23T05:00:00Z' } }, fakeFmt),
    '餐品已在准备，如有问题请联系商家'
  )
})

test('scheduleTypeLabel：预约单列表卡标签，非预约单返回 null', function () {
  assert.equal(scheduleTypeLabel({ scheduledAt: '2026-09-23T04:00:00Z' }), '同城 · 预约')
  assert.equal(scheduleTypeLabel({ scheduledAt: null }), null)
  assert.equal(scheduleTypeLabel({}), null)
})
