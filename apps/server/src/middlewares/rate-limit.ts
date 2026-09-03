import rateLimit from 'express-rate-limit'
import { config } from '../config'

/**
 * 限流阈值在非生产环境放宽。
 *
 * 为什么需要：e2e 是一个连续跑几百条断言的黑盒脚本，一轮就要登录若干次、支付二十几次。
 * 按生产阈值跑，脚本会撞限流而红——那不是被测代码的问题，却会淹没真正的回归信号，
 * 也逼着人在两轮之间干等 60 秒。放宽后仍留有限上限，跑飞的循环照样会被拦下。
 *
 * 为什么以 isProduction 为条件而不是以某个 mock 开关为条件：
 * loginLimiter 同时罩着**管理员密码登录**（admin/auth.ts），而 WECHAT_LOGIN_MOCK 说的是顾客侧微信登录 mock，
 * 两者语义无关。用后者做条件，会出现「顾客登录 mock 打开 → 管理员爆破上限从 5/分悄悄变成 200/分」这种
 * 谁也没打算要的耦合。以「这不是生产」为条件，说的才是真正想说的那件事。
 */
const devCeiling = (production: number, relaxed: number) => (config.isProduction ? production : relaxed)

// 登录接口限流：防暴力破解
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: devCeiling(5, 200),
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
