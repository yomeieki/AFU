import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { success } from '../utils/response'
import { expressQuoteLimiter } from '../middlewares/rate-limit'
import { quoteExpress } from '../services/express-quote-service'

const router = Router()

const quoteSchema = z
  .object({
    addressId: z.number().int().positive(),
    cartItemIds: z.array(z.number().int().positive()).min(1).optional(),
    directItem: z.object({ productId: z.number().int().positive(), skuId: z.number().int().positive().optional(), quantity: z.number().int().min(1).max(99) }).optional(),
    gifts: z.array(z.object({ pointsGoodId: z.number().int().positive(), quantity: z.number().int().min(1).max(9) })).max(5).optional(),
  })
  .refine((v) => !!v.cartItemIds !== !!v.directItem, { message: '请选择商品' })

// POST /api/express/quote — 邮寄运费报价（需登录；清单与下单同形，凭证按同一份清单签）
router.post('/quote', expressQuoteLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = quoteSchema.parse(req.body)
    success(res, await quoteExpress({ userId: req.userId!, ...body }))
  } catch (e) {
    next(e)
  }
})

export default router
