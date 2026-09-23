// 全店转发统一策略。
//
// 「无法转发此页面」是因为大多数页面没挂 onShareAppMessage——微信默认认为
// 没实现分享回调的页面不可转发。PO 2026-09-23 定：与其给 25 个页面各写一份
// 「转发到本页」（一堆页面转发过去后没有底部导航、没法再往下逛，等于死胡同），
// 统一改成全部转发到主页（tabBar[0]），并把当前购物渠道编进链接——
// 对方点开主页自动切到同一套菜单，不用重新选一次。
//
// 朋友圈只在主页保留（onShareTimeline 只挂在 pages/index/index），其余 24 页
// 不出现在微信客户端的「分享到朋友圈」入口里，本模块也不导出给它们用。
//
// 本文件是**新增文件**，纯 ES5（node scripts/check-miniapp-es5.mjs 强制），
// 因为它会被 25 个页面 require，其中不少页面本身不是 ES5，但新文件不跟着放宽。

var channelUtil = require('./channel')

var SHARE_TITLE = '阿福凉菜 · 家的味道，三十年老店'
var HOME_PATH = '/pages/index/index'
var CARD_IMAGE = '/assets/share/card.png'
var TIMELINE_IMAGE = '/assets/share/timeline.png'

// 「转发给好友」卡片：带渠道参数的主页链接。
// channel 用 normalizeChannel 归一化——脏值/undefined 一律落到 EXPRESS，
// 与全站「拿不准就当邮寄」的默认一致，不会把顾客莫名带进同城。
function homeShare(channel) {
  return {
    title: SHARE_TITLE,
    path: HOME_PATH + '?channel=' + channelUtil.normalizeChannel(channel),
    imageUrl: CARD_IMAGE,
  }
}

// 「分享到朋友圈」：只有主页有这个入口，同一份文案与图，query 是朋友圈卡片自己的格式
// （没有 path，只有 title/query/imageUrl）。
function homeTimeline(channel) {
  return {
    title: SHARE_TITLE,
    query: 'channel=' + channelUtil.normalizeChannel(channel),
    imageUrl: TIMELINE_IMAGE,
  }
}

// 从主页 onLoad(options) 里解析分享链接带来的渠道参数。
//
// 故意不用 normalizeChannel：normalizeChannel 是「拿不准就当邮寄」的宽松兜底，
// 用在这里会把任何脏查询参数（包括压根没有 channel 的普通主页访问）都误判成
// 「这是一次带 EXPRESS 的分享落地」，从而触发一次不必要的 setShoppingChannel。
// 这里要严格：只有明确写着 'LOCAL' 或 'EXPRESS' 才认，其余（包括大小写不对、
// 空串、undefined、不认识的值）一律 null，交给调用方走「不是分享落地」的默认路径。
function channelFromQuery(options) {
  var value = options && options.channel
  if (value === 'LOCAL' || value === 'EXPRESS') return value
  return null
}

// 25 页统一挂的 onShareAppMessage。getApp() 故意放在函数体内惰性调用——
// 模块加载时（页面 require 这个文件的那一刻）全局 App 实例可能还没注册好，
// 尤其是在测试桩里，Page 模块和 App 模块的加载顺序不保证。
function onShareAppMessage() {
  return homeShare(getApp().getShoppingChannel())
}

// ── 主页热启动入口去重（R1，2026-09-23 规划裁决）───────────────────────────
//
// 官方运行机制只保证：热启动 + 带 path 场景（分享卡对应场景值 1007/1008）时，
// 入口参数经 App.onShow / wx.onAppShow 送达；没有规定「目标是已挂载的 tabBar 页
// 时 onLoad 会不会重新执行」——主页是 tabBar[0]，热启动大概率不会重跑 onLoad，
// 所以只能在 wx.onAppShow 里收参数，页面自己决定要不要动作。
//
// Android 从桌面切回前台时，wx.onAppShow 收到的 entryOptions.scene 会保留
// 上一次冷启动/热启动时的场景值（不是「这次切回」真实的场景），不能拿 scene
// 判断「这是不是一次新的分享落地」。唯一可靠的信号是 path+channel 有没有变过——
// 所以按 (path, channel) 去重，不看 scene。
//
// 代价（可接受的退化）：同一会话内顾客手动切了一次渠道，然后又点开同一张分享
// 卡片切回小程序——因为 path+channel 跟上次记录的一样，会被判定成「已经处理过
// 的入口」而不再生效，需要顾客再点一次分享卡片（或走封面/我的页正常切渠道）。
var lastEntryKey = null

function entryKey(pagePath, query) {
  return String(pagePath || '').replace(/^\//, '') + '|' + ((query && query.channel) || '')
}

// 只登记，不判断。onLoad（冷启动/首次进入主页）调用一次，把这次的入口占成
// 「已见过」，避免同一个入口稍后又从 wx.onAppShow 里被误判成「新的一次」。
function rememberEntry(pagePath, query) {
  lastEntryKey = entryKey(pagePath, query)
}

// wx.onAppShow 里调用。key 跟上次记录的相同 → 判定为重复入口（同一张卡片、或
// 热启动路径本身触发的一次回声），返回 null 且不改状态；key 变了 → 记下新 key，
// 再看这次进的是不是主页——不是主页（比如从别的 tabBar 页热启动回来）不触发
// 渠道切换。
function noteEntry(pagePath, query) {
  var key = entryKey(pagePath, query)
  if (key === lastEntryKey) return null
  lastEntryKey = key
  var normalizedPath = String(pagePath || '').replace(/^\//, '')
  if (normalizedPath !== 'pages/index/index') return null
  return channelFromQuery(query)
}

module.exports = {
  SHARE_TITLE: SHARE_TITLE,
  HOME_PATH: HOME_PATH,
  CARD_IMAGE: CARD_IMAGE,
  TIMELINE_IMAGE: TIMELINE_IMAGE,
  homeShare: homeShare,
  homeTimeline: homeTimeline,
  channelFromQuery: channelFromQuery,
  onShareAppMessage: onShareAppMessage,
  rememberEntry: rememberEntry,
  noteEntry: noteEntry,
}
