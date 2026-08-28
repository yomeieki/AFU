import { Router, Request, Response, NextFunction } from 'express'
import fs from 'fs'
import { success } from '../../utils/response'
import { config } from '../../config'

const router = Router()

const isSet = (v: string | undefined): boolean => !!v && v.trim() !== ''

// GET /api/admin/system/status — 配置状态自检（只返回布尔/枚举，绝不返回任何密钥值）
router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const keyPath = process.env.WECHAT_PAY_PRIVATE_KEY_PATH
    const certPath = process.env.WECHAT_PAY_PLATFORM_CERT_PATH
    const notifyUrl = process.env.WECHAT_PAY_NOTIFY_URL

    success(res, {
      env: config.nodeEnv,
      mock: {
        login: config.mock.login,
        pay: config.mock.pay,
        qrcode: config.mock.qrcode,
      },
      wechat: {
        appIdSet: isSet(process.env.WECHAT_APP_ID),
        appSecretSet: isSet(process.env.WECHAT_APP_SECRET),
      },
      pay: {
        mchIdSet: isSet(process.env.WECHAT_MCH_ID),
        serialNoSet: isSet(process.env.WECHAT_PAY_SERIAL_NO),
        privateKeySet: isSet(keyPath) && fs.existsSync(keyPath!),
        apiV3KeySet: isSet(process.env.WECHAT_PAY_API_V3_KEY),
        notifyUrlSet: isSet(notifyUrl),
        notifyUrlIsHttps: isSet(notifyUrl) && notifyUrl!.startsWith('https://'),
        platformCertSet: isSet(certPath) && fs.existsSync(certPath!),
      },
      notify: {
        wecomSet: isSet(process.env.ORDER_NOTIFY_WECOM_WEBHOOK),
        pushplusSet: isSet(process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN),
      },
      publicBaseUrl: config.publicBaseUrl,
    })
  } catch (e) {
    next(e)
  }
})

export default router
