import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../utils/prisma'
import { success } from '../utils/response'
import { optionalUserAuth } from '../middlewares/auth'

const router = Router()

const scanLogSchema = z.object({
  scene: z.string().min(1, '请填写 scene'),
  source: z.string().max(32).default('package'),
})

// POST /api/scan-logs
// 不强制登录：有有效 token 则记录 userId，匿名扫码 userId 为空
router.post('/', optionalUserAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { scene, source } = scanLogSchema.parse(req.body)

    // Only handle known p_{id} scenes; silently succeed for unknown formats
    const match = scene.match(/^p_(\d+)$/)
    if (!match) {
      return success(res, null)
    }

    const productId = Number(match[1])
    const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } })
    if (!product) {
      return success(res, null)
    }

    await prisma.scanLog.create({
      data: {
        productId,
        userId: req.userId ?? null,
        scene,
        source,
        ip: req.ip ?? null,
      },
    })

    success(res, null)
  } catch (e) {
    next(e)
  }
})

export default router
