// 同城菜单的三段判断，抽成纯函数供主页与分类页共用。
//
// 为什么不各写一遍：两页都要判「店头显示什么」「车里多少钱」「能不能去结算」。
// 各写一遍迟早有一边漏掉「暂停接单时也要挡住结算」——而那一边看上去完全正常，
// 只有顾客真按下「去结算」、走到服务端 42226 那一刻才炸。

var formatPrice = require('./format').formatPrice

/**
 * 店头那颗状态胶囊。
 * 暂停优先于打烊：店主主动按下的暂停比「不在营业时段」更需要被顾客看到。
 * meta 还没回来时给「暂未营业」而不是空字符串——空胶囊是个视觉噪点，且会让人以为在营业。
 */
function storeStatusOf(meta) {
  if (!meta) return { tone: 'closed', label: '暂未营业' }
  if (meta.paused) return { tone: 'paused', label: '暂停接单' }
  if (!meta.enabled || !meta.isOpen) return { tone: 'closed', label: '已打烊' }
  return { tone: 'open', label: '营业中' }
}

/**
 * 页头那条通知。只在**真的挡住下单**时出现，blocking 同时给结算态用。
 * 商品在暂停/打烊时仍可浏览、仍可加购（顾客常常先挑好等开门），挡的只是结算。
 */
function headNoticeOf(meta) {
  if (!meta) return { text: '', blocking: false }
  if (!meta.enabled) return { text: '同城配送即将开通', blocking: true }
  if (meta.paused) {
    return {
      text: '暂停接单' + (meta.paused.reason ? '：' + meta.paused.reason : ''),
      blocking: true,
    }
  }
  if (!meta.isOpen) return { text: meta.nextOpenText || '当前非营业时间', blocking: true }
  return { text: '', blocking: false }
}

function summarizeCart(items) {
  return (items || []).reduce(function(summary, item) {
    summary.count += item.quantity || 0
    summary.amount += item.subtotal || 0
    return summary
  }, { count: 0, amount: 0 })
}

/**
 * 能不能去结算，以及按钮上写什么。
 * 差额一定要说出**具体数字**：顾客看到「还差 ¥15.00 起送」会回去加菜，
 * 看到一句「未达起送」只会直接退出去。
 * 业务阻塞（未开通/暂停/打烊）优先于起送线——加满也不能结，措辞不能误导成「再加点就行」。
 */
function checkoutStateOf(meta, count, amount, blocking) {
  var minimum = meta && meta.fee ? meta.fee.minOrderAmount || 0 : 0
  var gap = Math.max(0, minimum - amount)
  var disabled = !meta || !!blocking || count <= 0 || gap > 0
  var text = gap > 0 ? '还差 ¥' + formatPrice(gap) + ' 起送' : '去结算'
  if (blocking) text = '暂不可结算'
  return { gap: blocking ? 0 : gap, disabled: disabled, text: text }
}

module.exports = {
  storeStatusOf: storeStatusOf,
  headNoticeOf: headNoticeOf,
  summarizeCart: summarizeCart,
  checkoutStateOf: checkoutStateOf,
}
