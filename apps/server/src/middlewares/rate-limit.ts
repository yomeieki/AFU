import rateLimit from 'express-rate-limit'

// 登录接口限流：防暴力破解
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 42901, message: '请求过于频繁，请稍后再试', data: null },
})

// 支付发起限流：防刷单
export const payLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 42901, message: '请求过于频繁，请稍后再试', data: null },
})
