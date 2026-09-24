// 全店转发统一策略。
//
// 背景：「无法转发此页面」是因为大多数页面没挂 onShareAppMessage——微信默认
// 认为没实现分享回调的页面不可转发。修法是给 25 个页面统一挂同一个
// onShareAppMessage，而不是各写一份「转发到本页」（一堆页面转发过去后没有底部
// 导航、没法再往下逛，等于死胡同）。
//
// 「转发给好友」卡片点开后落到**封面页 pages/cover/index**（app.json 的
// pages[0]），不落到主页——由对方在封面自己选同城/邮寄，卡片不再带 channel
// 参数（PO 2026-09-23 拍板接受的退化：不会像以前一样自动切到分享人那套菜单）。
// 卡片本身的显示**完全不动**：标题、卡片图（30 周年图）与此前一致，只有落地
// 路径变了。
//
// 主页 pages/index/index.js 里「按 ?channel= 落地」的那段逻辑（onLoad 解析、
// onReady 过门、wx.onAppShow 去重、settle 收口）**必须保留，不能删**：这次调整
// 之前已审核上线的版本发出去的旧卡片仍指向 /pages/index/index?channel=X，聊天
// 记录里的旧链接被点开时还是要落到主页并按 channel 切渠道，不能因为新卡片改道
// 就让旧链接失效。HOME_PATH 常量因此保留（不再被本文件用来拼新卡片的 path，
// 但仍是文档，标注旧链接的落地目标）。
//
// 朋友圈只在主页保留（onShareTimeline 只挂在 pages/index/index）：朋友圈是
// 单页分享模式，只能分享「当前页」，做不到像好友卡片那样指定跳到封面，所以
// 朋友圈继续用主页 + channel query 的旧形态，不受这次调整影响。其余 24 页
// 不出现在微信客户端的「分享到朋友圈」入口里，本模块也不导出给它们用。
//
// 本文件是**新增文件**，纯 ES5（node scripts/check-miniapp-es5.mjs 强制），
// 因为它会被 25 个页面 require，其中不少页面本身不是 ES5，但新文件不跟着放宽。

var channelUtil = require('./channel')

var SHARE_TITLE = '阿福凉菜 · 家的味道，三十年老店'
var HOME_PATH = '/pages/index/index' // 旧版分享卡片的落地页，仍是朋友圈与旧链接的落地目标（见上方头注释）
var SHARE_LANDING_PATH = '/pages/cover/index' // 「转发给好友」卡片的新落地页：封面，pages[0]
var CARD_IMAGE = '/assets/share/card.png'
var TIMELINE_IMAGE = '/assets/share/timeline.png'

// ── 微信「单页模式」判定（2026-09-24）───────────────────────────────────────
//
// 朋友圈内直接点开分享卡片，先进入的是官方「单页模式」，并不会真正打开小程序
// （微信文档 share-timeline.html）：页面无登录态，wx.login 等登录相关接口都不
// 可用，也不允许真正跳转；点操作栏「前往小程序」才是一次真正的新启动（新 App
// 实例，scene 变成 1155）。单页模式对应的场景值是 1154，只需要在 App.onLaunch
// 判一次并缓存到 globalData，不必每次都重新判断。
var SINGLE_PAGE_SCENE = 1154

// options 里不保证一定带 scene；没有时退到 wx.getLaunchOptionsSync() 兜底，
// 旧基础库没有这个 API（或调用抛错）时按 try/catch 收口，一律当作「不是单页
// 模式」——宁可让普通启动多判一次，也不能把普通启动误判成单页模式而漏了登录。
function isSinglePageLaunch(options) {
  var scene = options && options.scene
  if (scene === undefined) {
    try {
      scene = wx.getLaunchOptionsSync && wx.getLaunchOptionsSync().scene
    } catch (e) {
      scene = undefined
    }
  }
  return scene === SINGLE_PAGE_SCENE
}

// 「转发给好友」卡片：固定落到封面页，不带渠道参数——对方点开后在封面自己选
// 同城/邮寄（见文件头注释）。标题与卡片图跟调整前完全一样，没有变化。
function shareCard() {
  return {
    title: SHARE_TITLE,
    path: SHARE_LANDING_PATH,
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

// 25 页统一挂的 onShareAppMessage。卡片固定落到封面、不带渠道参数（见文件头
// 注释），不需要再看当前购物渠道，所以不用 getApp()。
function onShareAppMessage() {
  return shareCard()
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
  SHARE_LANDING_PATH: SHARE_LANDING_PATH,
  CARD_IMAGE: CARD_IMAGE,
  TIMELINE_IMAGE: TIMELINE_IMAGE,
  SINGLE_PAGE_SCENE: SINGLE_PAGE_SCENE,
  isSinglePageLaunch: isSinglePageLaunch,
  shareCard: shareCard,
  homeTimeline: homeTimeline,
  channelFromQuery: channelFromQuery,
  onShareAppMessage: onShareAppMessage,
  rememberEntry: rememberEntry,
  noteEntry: noteEntry,
}
