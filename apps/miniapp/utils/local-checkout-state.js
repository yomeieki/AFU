// 同城结算页底部按钮的唯一判定。
//
// 为什么把它抽成纯函数：结算页有九种可见状态（无地址 / 缺定位 / 报价中 / 报价失败 /
// 暂停 / 打烊 / 超范围 / 未达起送 / 提交中），每一种都要同时决定三件事——
// 按钮能不能点、按钮写什么、金额显示成什么。散在页面里用 wxml 三元表达式拼，
// 必然会出现「文案改了但按钮还能点」这种半吊子状态，而它的后果是顾客拿着过期的
// quoteToken 提交，被服务端 42239 拒掉，看到一句看不懂的报错。
//
// 优先级是有意排的：地址 → 报价 → 业务阻塞 → 提交中。
// 反过来的话，还没填地址的顾客会先看到「暂不可配送」，他会以为这个店送不到他那儿。
//
// ⚠️ action 是店主 2026-09-07 选的方案 B 引入的硬约束。
// 报价失败时按钮**不禁用**（点了重新报价），所以页面的 tap 处理必须按 action 分派：
//   action === 'retry'  → refreshQuote()
//   action === 'submit' → doSubmit()
// 绝不允许写成「按钮没禁用就去提交」。

// 按钮宽度是按这七种文案定的；多一种就可能在 320 宽的机器上把金额挤没。
var TEXT = {
  NO_ADDRESS: '请选择地址',
  NO_LOCATION: '请补充定位',
  QUOTING: '正在计算运费',
  RETRY: '重新获取运费',
  BLOCKED: '暂不可配送',
  SUBMIT: '提交订单',
  SUBMITTING: '提交中',
}

function result(disabled, text, amountState, action) {
  return { disabled: disabled, text: text, amountState: amountState, action: action }
}

/**
 * @param {Object} s 结算页当前状态，字段全部可选：
 *   hasAddress    已选中收货地址
 *   hasLocation   该地址有地图坐标。**只有显式 false 才算缺定位**——
 *                 调用方在还没拿到地址时不该被判成「缺定位」，那是 hasAddress 管的事
 *   quoting       正在请求 /local/quote
 *   quoteError    上一次报价失败（网络/限流）
 *   blockReason   业务阻塞原因（暂停/打烊/超范围/未达起送），非空即阻塞
 *   submitting    正在提交订单
 *   quoteToken    服务端签发的报价凭证
 *   payAmount     应付金额（分）
 * @returns {{disabled:boolean, text:string, amountState:'ready'|'pending'|'error'|'blocked', action:'submit'|'retry'|'none'}}
 */
function checkoutAction(s) {
  var st = s || {}
  if (!st.hasAddress) return result(true, TEXT.NO_ADDRESS, 'pending', 'none')
  if (st.hasLocation === false) return result(true, TEXT.NO_LOCATION, 'pending', 'none')
  if (st.quoting) return result(true, TEXT.QUOTING, 'pending', 'none')
  if (st.quoteError) return result(false, TEXT.RETRY, 'error', 'retry')
  if (st.blockReason) return result(true, TEXT.BLOCKED, 'blocked', 'none')
  // 报价还没回来（或应付金额算不出来）时不放行。这一格也兜住了「地址刚换、
  // 旧 token 已作废、新报价还在路上」那一瞬间——页面调 invalidateCheckout 把
  // quoteToken 置空之后，这里立刻变成不可提交，不依赖网络返回的时序。
  if (!st.quoteToken || st.payAmount == null) return result(true, TEXT.QUOTING, 'pending', 'none')
  // 提交中：按钮锁死，但金额继续显示——顾客要看得见自己正在付多少钱。
  if (st.submitting) return result(true, TEXT.SUBMITTING, 'ready', 'submit')
  return result(false, TEXT.SUBMIT, 'ready', 'submit')
}

module.exports = {
  TEXT: TEXT,
  checkoutAction: checkoutAction,
}
