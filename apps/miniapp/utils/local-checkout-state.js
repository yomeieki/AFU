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
 *   quoteExpiresAt 该凭证的过期时刻（毫秒）。**由服务端随报价下发**，客户端不再自己写死 TTL——
 *                 原来页面写「超过 10 分钟算陈旧」而服务端签 15 分钟，中间 5 分钟里
 *                 页面以为还新鲜、服务端已经准备拒了。为 0/null 时不判过期
 *                 （老版本接口没有这个字段，判过期会让整页都提交不了）
 *   now           当前时刻（毫秒），仅为可测试性而暴露，页面不传
 *   benefitsLoading 优惠券/赠品正在重算
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
  // 凭证过期：按「还在算」处理，页面据此立刻重新报价。
  // 边界与服务端一致——verifyQuote 判的是 `e < now`（local-settings.ts:606），
  // 所以过期时刻那一毫秒本身仍然有效，两边不要各留各的余量。
  if (st.quoteExpiresAt && (st.now || Date.now()) > st.quoteExpiresAt) {
    return result(true, TEXT.QUOTING, 'pending', 'none')
  }
  // 优惠重算中：合计此刻是不确定的，放行会让顾客按着旧的应付金额提交，
  // 而服务端按新的券状态算出另一个数。金额继续显示（不闪成「待计算」）——
  // 券的抵扣额通常只差几块，把整个合计抹掉反而像是出了故障。
  if (st.benefitsLoading) return result(true, TEXT.SUBMIT, 'ready', 'submit')
  // 提交中：按钮锁死，但金额继续显示——顾客要看得见自己正在付多少钱。
  if (st.submitting) return result(true, TEXT.SUBMITTING, 'ready', 'submit')
  return result(false, TEXT.SUBMIT, 'ready', 'submit')
}

/**
 * 下单幂等键（UUID v4）。
 *
 * 治的是「服务端已经建单、客户端超时没收到响应」这一类重复下单：顾客点一次、
 * 网络卡住、他再点一次，库里就是两张单、库存扣两次、券核销两次。
 * 每进一次结算页生成一个，**重试时必须沿用同一个**——每次调用都新生成等于没有幂等。
 *
 * 不用 crypto.randomUUID：小程序没有。Math.random 的碰撞概率在「同一个用户、
 * 同一次结算」的尺度上完全无关紧要，而服务端的唯一键还带着 userId。
 */
function newClientRequestId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = (Math.random() * 16) | 0
    var v = c === 'x' ? r : ((r & 0x3) | 0x8)
    return v.toString(16)
  })
}

module.exports = {
  TEXT: TEXT,
  checkoutAction: checkoutAction,
  newClientRequestId: newClientRequestId,
}
