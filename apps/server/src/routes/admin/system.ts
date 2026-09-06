import { Router, Request, Response, NextFunction } from 'express'
import fs from 'fs'
import { success } from '../../utils/response'
import { config } from '../../config'
import { getVerifyStatus } from '../../services/wechat-pay-verify'
import { getRefundNotifyUrl } from '../../services/wechat-pay'
import { runSchedulerTick } from '../../services/scheduler'
import { AppError } from '../../middlewares/error'
import { isCircuitTripped, resetCircuit, getCircuitState } from '../../services/delivery/circuit'

const router = Router()

const isSet = (v: string | undefined): boolean => !!v && v.trim() !== ''

// GET /api/admin/system/status — 配置状态自检（只返回布尔/枚举，绝不返回任何密钥值）
router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const keyPath = process.env.WECHAT_PAY_PRIVATE_KEY_PATH
    const certPath = process.env.WECHAT_PAY_PLATFORM_CERT_PATH
    const notifyUrl = process.env.WECHAT_PAY_NOTIFY_URL
    const refundNotifyUrl = getRefundNotifyUrl()
    const verify = getVerifyStatus()

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
        // 退款回调地址（未显式配置时由支付回调地址派生）
        refundNotifyUrlSet: isSet(refundNotifyUrl),
        refundNotifyUrlIsHttps: refundNotifyUrl.startsWith('https://'),
        // 回调验签材料：公钥 / 平台证书 二选一即可
        publicKeySet: verify.publicKeySet,
        publicKeyIdSet: verify.publicKeyIdSet,
        verifyMode: verify.mode,
        certAutoDownload: verify.certAutoDownload,
      },
      cos: {
        secretIdSet: isSet(process.env.COS_SECRET_ID),
        secretKeySet: isSet(process.env.COS_SECRET_KEY),
        bucketSet: isSet(process.env.COS_BUCKET),
        regionSet: isSet(process.env.COS_REGION),
        baseUrlSet: isSet(process.env.COS_BASE_URL),
        enabled: config.cos.enabled,
      },
      notify: {
        wecomSet: isSet(process.env.ORDER_NOTIFY_WECOM_WEBHOOK),
        pushplusSet: isSet(process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN),
        pushplusTopicSet: isSet(process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC),
        systemAlertWecomSet: isSet(process.env.SYSTEM_ALERT_WECOM_WEBHOOK),
        systemAlertPushplusSet: isSet(
          process.env.SYSTEM_ALERT_PUSHPLUS_TOKEN || process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
        ),
      },
      order: {
        payTimeoutMin: config.order.payTimeoutMin,
        autoCompleteDays: config.order.autoCompleteDays,
        schedulerEnabled: config.schedulerEnabled,
      },
      subscribe: {
        paidTemplateSet: !!config.subscribe.paidTemplateId && !!config.subscribe.paidFields,
        shipTemplateSet: !!config.subscribe.shipTemplateId && !!config.subscribe.shipFields,
        refundTemplateSet: !!config.subscribe.refundTemplateId && !!config.subscribe.refundFields,
        // 同城配送「配送中」推送。缺模板时 subscribe-message.ts 会静默 return（无日志无告警），
        // 所以「生产没报错」不能当作已配置的证据——这一行就是它唯一的可观测出口。
        deliverTemplateSet: !!config.subscribe.deliverTemplateId && !!config.subscribe.deliverFields,
      },
      kd100: {
        keySet: !!config.kd100.key,
        secretSet: !!config.kd100.secret,
        mock: config.mock.delivery,
        callbackUrlSample: `${config.publicBaseUrl}/api/kd/D999999-99`,
        callbackUrlOk: `${config.publicBaseUrl}/api/kd/D999999-99`.length <= 50,
        circuitTripped: isCircuitTripped(),
      },
      publicBaseUrl: config.publicBaseUrl,
    })
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/system/run-scheduler — 手动跑一轮定时任务（仅非生产，供联调/e2e）
router.post('/run-scheduler', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (config.isProduction) throw new AppError(40301, '生产环境不允许手动触发', 403)
    const body = (_req.body ?? {}) as Record<string, unknown>
    const num = (v: unknown) => (typeof v === 'number' && v >= 0 ? v : undefined)
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)
    success(
      res,
      await runSchedulerTick({
        payTimeoutMin: num(body.payTimeoutMin),
        autoCompleteDays: num(body.autoCompleteDays),
        remindAfterMin: num(body.remindAfterMin),
        callTimeoutMin: num(body.callTimeoutMin),
        acceptedStuckMin: num(body.acceptedStuckMin),
        deliveringTimeoutMin: num(body.deliveringTimeoutMin),
        unknownStuckMin: num(body.unknownStuckMin),
        localUncalledMin: num(body.localUncalledMin),
        cancelRequestPendingMin: num(body.cancelRequestPendingMin),
        autoCallDelayMin: num(body.autoCallDelayMin),
        quoteRefreshMin: num(body.quoteRefreshMin),
        escalateAfterMin: num(body.escalateAfterMin),
        settleMissedPointsAfterMin: num(body.settleMissedPointsAfterMin),
        forceDailyMemberTasks: bool(body.forceDailyMemberTasks),
        dailyTaskBatchLimit: num(body.dailyTaskBatchLimit),
      })
    )
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/system/kd100-circuit/reset — 手动恢复快递100 余额熔断（充值后点击）
router.post('/kd100-circuit/reset', async (req: Request, res: Response, next: NextFunction) => {
  try {
    resetCircuit(req.adminUsername ?? 'admin')
    success(res, getCircuitState())
  } catch (e) {
    next(e)
  }
})

export default router
