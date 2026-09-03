import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../utils/prisma'
import { success } from '../utils/response'
import { AppError } from '../middlewares/error'

const router = Router()

const addressBase = z.object({
  receiverName: z.string().min(1, '请填写收货人').max(64),
  receiverPhone: z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确'),
  province: z.string().min(1, '请填写省份').max(32),
  city: z.string().min(1, '请填写城市').max(32),
  district: z.string().min(1, '请填写区县').max(32),
  detail: z.string().min(1, '请填写详细地址').max(255),
  isDefault: z.number().int().min(0).max(1).default(0),
  // 同城配送用：GCJ-02 微度坐标 + 地图选点名称（成对出现）
  latE6: z.number().int().min(-90_000_000).max(90_000_000).nullable().optional(),
  lngE6: z.number().int().min(-180_000_000).max(180_000_000).nullable().optional(),
  poiName: z.string().max(128).nullable().optional(),
})
const addressSchema = addressBase.refine((v) => (v.latE6 == null) === (v.lngE6 == null), {
  message: '经纬度必须同时提供',
})

// GET /api/addresses
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const addresses = await prisma.address.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    })
    success(res, addresses)
  } catch (e) {
    next(e)
  }
})

// POST /api/addresses
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const data = addressSchema.parse(req.body)
    const fullAddress = `${data.province}${data.city}${data.district}${data.detail}`

    if (data.isDefault) {
      await prisma.address.updateMany({ where: { userId, deletedAt: null }, data: { isDefault: 0 } })
    }

    const address = await prisma.address.create({ data: { ...data, userId, fullAddress } })
    success(res, address)
  } catch (e) {
    next(e)
  }
})

// PUT /api/addresses/:id
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!

    const exists = await prisma.address.findFirst({ where: { id, userId, deletedAt: null } })
    if (!exists) throw new AppError(40401, '地址不存在', 404)

    const data = addressBase
      .partial()
      .refine((v) => (v.latE6 == null) === (v.lngE6 == null), { message: '经纬度必须同时提供' })
      .parse(req.body)
    const fullAddress = [
      data.province ?? exists.province,
      data.city ?? exists.city,
      data.district ?? exists.district,
      data.detail ?? exists.detail,
    ].join('')

    if (data.isDefault) {
      await prisma.address.updateMany({
        where: { userId, deletedAt: null, id: { not: id } },
        data: { isDefault: 0 },
      })
    }

    const address = await prisma.address.update({ where: { id }, data: { ...data, fullAddress } })
    success(res, address)
  } catch (e) {
    next(e)
  }
})

// DELETE /api/addresses/:id (软删除)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!

    const exists = await prisma.address.findFirst({ where: { id, userId, deletedAt: null } })
    if (!exists) throw new AppError(40401, '地址不存在', 404)

    await prisma.address.update({ where: { id }, data: { deletedAt: new Date() } })
    success(res, null, '删除成功')
  } catch (e) {
    next(e)
  }
})

export default router
