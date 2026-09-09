/** 快递100 上门取件状态回调。公开路由（安全性来自 per-预约 salt 验签），body 为 x-www-form-urlencoded */
import express, { Router, Request, Response } from 'express'
import { handleExpressCallback } from '../services/delivery/express-callback'
import { handleExpressTrackCallback } from '../services/delivery/express-track'
import { kdExpressCallbackLimiter } from '../middlewares/rate-limit'
const router = Router()
// 轨迹推送（bOrder 的 pollCallBackUrl）：同 salt、同验签、同限流、同 ack 形状；只是处理函数不同
router.post('/:bookingNo/track', kdExpressCallbackLimiter, express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  let http: 200 | 500 = 200
  try { http = (await handleExpressTrackCallback(String(req.params.bookingNo), (req.body ?? {}) as Record<string, string>)).http }
  catch (e) { console.error('[kd-express-track] 未捕获异常:', e); http = 500 }
  if (http === 200) res.json({ result: true, returnCode: '200', message: '成功' })
  else res.status(500).json({ result: false, returnCode: '500', message: '服务器异常，请重推' })
})
router.post('/:bookingNo', kdExpressCallbackLimiter, express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  let http: 200 | 500 = 200
  try { http = (await handleExpressCallback(String(req.params.bookingNo), (req.body ?? {}) as Record<string, string>)).http }
  catch (e) { console.error('[kd-express-callback] 未捕获异常:', e); http = 500 }
  if (http === 200) res.json({ result: true, returnCode: '200', message: '成功' })
  else res.status(500).json({ result: false, returnCode: '500', message: '服务器异常，请重推' })
})
export default router
