import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { Request } from 'express'
import { config } from '../config'

/**
 * 限流阈值在非生产环境放宽。
 *
 * 为什么需要：e2e 是一个连续跑几百条断言的黑盒脚本，一轮就要登录若干次、支付二十几次。
 * 按生产阈值跑，脚本会撞限流而红——那不是被测代码的问题，却会淹没真正的回归信号，
 * 也逼着人在两轮之间干等 60 秒。放宽后仍留有限上限，跑飞的循环照样会被拦下。
 *
 * 为什么以 isProduction 为条件而不是以某个 mock 开关为条件：
 * loginLimiter 罩的是**管理员密码登录**（admin/auth.ts），而 WECHAT_LOGIN_MOCK 说的是顾客侧微信登录 mock，
 * 两者语义无关。用后者做条件，会出现「顾客登录 mock 打开 → 管理员爆破上限从 5/分悄悄变成 200/分」这种
 * 谁也没打算要的耦合。以「这不是生产」为条件，说的才是真正想说的那件事。
 */
const devCeiling = (production: number, relaxed: number) => (config.isProduction ? production : relaxed)

// 管理员登录接口限流：防密码暴力破解（顾客微信登录另用下面的 userLoginLimiter）
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: devCeiling(5, 200),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 42901, message: '请求过于频繁，请稍后再试', data: null },
})

/**
 * 顾客微信登录限流，与管理员的 loginLimiter 分开。
 *
 * 为什么不能共用 loginLimiter：那个 5/分钟是为「防管理员密码爆破」定的，按 IP 计数；
 * 而小程序每次冷启动都无条件调一次 wechat-login（app.js onLaunch，本地有 token 也照发）。
 * 运营商 CGNAT / 店内 Wi-Fi 下多名顾客共用一个出口 IP，第 6 个人打开小程序就会被 429
 * 挤成「未登录」，此后 /cart /orders 全 401，request.js 的自动重登也撞同一个桶。
 * 而且 loginLimiter 是模块级单例，顾客登录风暴还会把同一 IP 下店主的后台密码登录一起挡住。
 *
 * 微信登录本身没有密码可爆破（code 一次性、由微信签发），限流只需拦脚本刷 code 换 token
 * 的滥用，60/分钟/IP 足够宽到容下一家店同时开小程序的顾客数。
 */
export const userLoginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: devCeiling(60, 2000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 42901, message: '请求过于频繁，请稍后再试', data: null },
})

// 支付发起限流：防刷单
export const payLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: devCeiling(20, 500),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 42901, message: '请求过于频繁，请稍后再试', data: null },
})

/**
 * 同城报价限流：`POST /local/quote` 挂 `optionalUserAuth`，匿名传坐标即可调用；
 * 报价强制凭证之后，每次调用都会外呼一次运力方 `batchPrice`（最长 5 秒连接占用），
 * 免费但仍是匿名可触发的第三方外呼，也会挤占店员侧共用的呼叫/回调队列节奏。
 *
 * 阈值要覆盖真实用法而不是拍脑袋：顾客在地址页选点可能连点好几次微调，进结算页
 * 通常还要再报一次——给到比登录/支付宽得多的窗口，只挡异常高频（脚本刷、死循环），
 * 不误伤正常顾客。
 */
export const localQuoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: devCeiling(30, 500),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 42901, message: '请求过于频繁，请稍后再试', data: null },
})

/**
 * 扫码日志限流：POST /scan-logs 是全仓唯一「匿名可写库且零校验」的接口
 * （optionalUserAuth，只要 scene 对上一个在售商品就 INSERT 一行）。
 * 不限流的话任何人循环 POST 就能把 scan_logs 灌到几十万行，后台「扫码统计」的
 * 转化率分母被抬高到接近 0，店主会据此误判「包装二维码没人扫」。
 *
 * 阈值：真人扫码一次一条，同一出口 IP（店内 Wi-Fi）一分钟里几十个顾客扫码已经是极端情况，
 * 30/分钟/IP 只挡脚本。小程序侧 api/scan.js 本来就吞掉这个请求的错误，限流命中对顾客无感。
 */
export const scanLogLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: devCeiling(30, 500),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 42901, message: '请求过于频繁，请稍后再试', data: null },
})

/**
 * 快递100 回调限流：/api/kd/:deliveryNo 未鉴权（安全性只靠 per-单 salt 验签），
 * deliveryNo=D<orderId>-<seq> 易猜，需要防有人拿它当灌爆事件表的免费写入点。
 *
 * 阈值定得比正常业务宽：一张配送单全程约 6 个状态回调，快递100 失败还会重推——
 * 宁可宽一点也不能挡掉真回调（挡掉的后果是丢失唯一的事实来源，比慢一点严重得多）。
 * statusCode 强制 200：回调应答语义与其它接口相反（N5），限流命中也不能例外，
 * 否则会被快递100 当成异常触发重推风暴。
 */
/** 挂在 verifyUserToken 之后，req.userId 恒有值；ipKeyGenerator 兜底只是与 upload.ts 同款防御写法 */
const memberKeyGenerator = (req: Request) => (req.userId ? `u:${req.userId}` : ipKeyGenerator(req.ip ?? ''))

// 会员只读端点（/member/summary、/member/points/ledger、/member/coupons）：查询，宽松限流
export const memberReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: devCeiling(120, 2000),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: memberKeyGenerator,
  message: { code: 42901, message: '请求过于频繁，请稍后再试', data: null },
})

// 会员写端点（/member/points/redeem、/member/coupons/claim）：会消耗积分/限量券库存，比只读更严
export const memberWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: devCeiling(20, 500),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: memberKeyGenerator,
  message: { code: 42901, message: '请求过于频繁，请稍后再试', data: null },
})

export const kdCallbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: devCeiling(120, 2000),
  standardHeaders: true,
  legacyHeaders: false,
  statusCode: 200,
  message: { result: true, returnCode: '200', message: '请求过于频繁，请稍后再试' },
})
