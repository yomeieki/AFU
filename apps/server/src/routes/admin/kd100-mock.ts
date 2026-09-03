import { Router, Request, Response, NextFunction } from 'express'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { queueDirective, getCalls, resetMock, MockDirective } from '../../services/delivery/mock'
import prisma from '../../utils/prisma'

const router = Router()

// POST /api/admin/system/kd100-mock/reset — Reset mock state
router.post('/reset', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    resetMock()
    success(res, {})
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/system/kd100-mock/queue — Queue a directive
router.post('/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const op = body.op as string | undefined
    const directive = body.directive as unknown

    if (!op || !['createOrder', 'cancelOrder', 'precancelOrder', 'addTip', 'queryCourier', 'price'].includes(op)) {
      throw new AppError(40000, '无效操作', 400)
    }

    queueDirective(op as 'createOrder' | 'cancelOrder' | 'precancelOrder' | 'addTip' | 'queryCourier' | 'price', directive as MockDirective)
    success(res, {})
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/system/kd100-mock/calls — Get recorded calls
router.get('/calls', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    success(res, getCalls())
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/system/kd100-mock/salt/:deliveryNo — Get salt for a delivery
router.get('/salt/:deliveryNo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deliveryNo = req.params.deliveryNo as string
    const delivery = await prisma.delivery.findUnique({
      where: { deliveryNo },
      select: { callbackSalt: true },
    })

    if (!delivery) {
      throw new AppError(40401, '配送单不存在', 404)
    }

    success(res, { salt: delivery.callbackSalt })
  } catch (e) {
    next(e)
  }
})

export default router
