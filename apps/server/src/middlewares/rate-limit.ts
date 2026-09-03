import rateLimit from 'express-rate-limit'
import { config } from '../config'

/**
 * 限流阈值在 mock 模式下放宽。
 *
 * 为什么安全：config.ts 会在生产环境下检查 enabledMocks，只要任一 mock 打开就直接 process.exit(1)。
 * 所以「mock 开着」与「这是生产」互斥，放宽只可能发生在本地与 CI。
 *
 * 为什么需要：e2e 是一个连续跑几百条断言的黑盒脚本，一轮就要登录若干次、支付二十几次。
 * 按生产阈值跑，脚本会撞限流而红——那不是被测代码的问题，却会淹没真正的回归信号，
 * 也逼着人在两轮之间干等 60 秒。放宽后仍留有限上限，跑飞的循环照样会被拦下。
 */
const mockCeiling = (production: number, relaxed: number, mockOn: boolean) => (mockOn ? relaxed : production)

// 登录接口限流：防暴力破解
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: mockCeiling(5, 200, config.mock.login),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 42901, message: '请求过于频繁，请稍后再试', data: null },
})

// 支付发起限流：防刷单
export const payLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: mockCeiling(20, 500, config.mock.pay),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 42901, message: '请求过于频繁，请稍后再试', data: null },
})
