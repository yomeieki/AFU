/** 快递100 状态回调。公开路由（安全性来自 per-单 salt 验签），body 为 x-www-form-urlencoded */
import express, { Router, Request, Response } from 'express'
import { handleKdCallback } from '../services/delivery/callback'
import { kdCallbackLimiter } from '../middlewares/rate-limit'

const router = Router()
router.post('/:deliveryNo', kdCallbackLimiter, express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  let http: 200 | 500 = 200
  try {
    http = (await handleKdCallback(String(req.params.deliveryNo), (req.body ?? {}) as Record<string, string>)).http
  } catch (e) {
    console.error('[kd-callback] 未捕获异常:', e)
    http = 500
  }
  if (http === 200) res.json({ result: true, returnCode: '200', message: '成功' })
  else res.status(500).json({ result: false, returnCode: '500', message: '服务器异常，请重推' })
})
export default router
