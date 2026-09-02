import 'dotenv/config'
import { z } from 'zod'

// 启动时集中校验环境变量：关键配置缺失立即退出，绝不静默回退
const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),

  // JWT 密钥必填，无默认值（防止硬编码弱密钥被带上生产）
  JWT_SECRET: z.string().min(16, 'JWT_SECRET 必须配置且不少于 16 位'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  ADMIN_JWT_SECRET: z.string().min(16, 'ADMIN_JWT_SECRET 必须配置且不少于 16 位'),
  ADMIN_JWT_EXPIRES_IN: z.string().default('24h'),

  // CORS 白名单，逗号分隔；开发环境未配置时默认放开 localhost
  CORS_ORIGINS: z.string().optional(),

  // 对外可访问的基础 URL（用于拼接上传图片等静态资源地址），生产必须配置为 https://api.xxx.com
  PUBLIC_BASE_URL: z.string().optional(),

  // Mock 开关：默认全部关闭，仅显式 =true 时启用
  WECHAT_PAY_MOCK: z.string().optional(),
  WECHAT_LOGIN_MOCK: z.string().optional(),
  WECHAT_QRCODE_MOCK: z.string().optional(),

  // 微信小程序 / 支付（懒校验：下单/退款时 validatePayConfig 再查缺项；这里只登记以便集中管理）
  WECHAT_APP_ID: z.string().optional(),
  WECHAT_APP_SECRET: z.string().optional(),
  WECHAT_MCH_ID: z.string().optional(),
  WECHAT_PAY_SERIAL_NO: z.string().optional(),
  WECHAT_PAY_PRIVATE_KEY_PATH: z.string().optional(),
  WECHAT_PAY_API_V3_KEY: z.string().optional(),
  WECHAT_PAY_NOTIFY_URL: z.string().optional(),
  WECHAT_PAY_REFUND_NOTIFY_URL: z.string().optional(),
  // 回调验签材料：二选一（新商户默认「微信支付公钥」）
  WECHAT_PAY_PLATFORM_CERT_PATH: z.string().optional(),
  WECHAT_PAY_PUBLIC_KEY_PATH: z.string().optional(),
  WECHAT_PAY_PUBLIC_KEY_ID: z.string().optional(),
  WECHAT_PAY_CERT_AUTO_DOWNLOAD: z.string().optional(),

  // 订单生命周期：待付款超时（分钟）、发货后自动确认收货（天）
  PAY_TIMEOUT_MIN: z.coerce.number().int().min(1).default(15),
  AUTO_COMPLETE_DAYS: z.coerce.number().int().min(1).default(7),
  // 定时任务开关（多实例或调试时可关）
  SCHEDULER_DISABLED: z.string().optional(),

  // 小程序订阅消息模板（公众平台「订阅消息」选用公共模板后填入）
  WECHAT_TMPL_SHIP: z.string().optional(),
  WECHAT_TMPL_SHIP_FIELDS: z.string().optional(),
  WECHAT_TMPL_REFUND: z.string().optional(),
  WECHAT_TMPL_REFUND_FIELDS: z.string().optional(),

  // 通知/告警
  ORDER_NOTIFY_WECOM_WEBHOOK: z.string().optional(),
  ORDER_NOTIFY_PUSHPLUS_TOKEN: z.string().optional(),
  ORDER_NOTIFY_PUSHPLUS_TOPIC: z.string().optional(),
  SYSTEM_ALERT_WECOM_WEBHOOK: z.string().optional(),

  // 腾讯云 COS（图片存储）：生产必填，开发未配置时回退本地 uploads/
  COS_SECRET_ID: z.string().optional(),
  COS_SECRET_KEY: z.string().optional(),
  COS_BUCKET: z.string().optional(),
  COS_REGION: z.string().optional(),
  COS_BASE_URL: z.string().optional(),
})

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('[config] 环境变量校验失败，服务拒绝启动：')
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

const env = parsed.data
const isProduction = env.NODE_ENV === 'production'

const isSet = (v: string | undefined): v is string => !!v && v.trim() !== ''
const cosEnabled =
  isSet(env.COS_SECRET_ID) && isSet(env.COS_SECRET_KEY) && isSet(env.COS_BUCKET) && isSet(env.COS_REGION)

// 生产环境额外校验：mock 一律不允许开启
if (isProduction) {
  const enabledMocks = (
    [
      ['WECHAT_PAY_MOCK', env.WECHAT_PAY_MOCK],
      ['WECHAT_LOGIN_MOCK', env.WECHAT_LOGIN_MOCK],
      ['WECHAT_QRCODE_MOCK', env.WECHAT_QRCODE_MOCK],
    ] as const
  ).filter(([, v]) => v === 'true')
  if (enabledMocks.length > 0) {
    console.error(
      `[config] 生产环境禁止开启 mock：${enabledMocks.map(([k]) => k).join(', ')}，服务拒绝启动`
    )
    process.exit(1)
  }

  // 图片存储：生产必须走 COS（本地盘已迁移，不再接受新写入）
  if (!cosEnabled) {
    console.error('[config] 生产环境必须配置 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION，服务拒绝启动')
    process.exit(1)
  }

  // 回调验签材料缺失只警告（商户号配置可能晚于部署），回调侧会直接拒绝
  if (env.WECHAT_PAY_MOCK !== 'true' && !isSet(env.WECHAT_PAY_PUBLIC_KEY_PATH) && !isSet(env.WECHAT_PAY_PLATFORM_CERT_PATH)) {
    console.warn('[config] 未配置 WECHAT_PAY_PUBLIC_KEY_PATH 或 WECHAT_PAY_PLATFORM_CERT_PATH，微信支付/退款回调将被拒绝')
  }
}

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction,
  port: env.PORT,
  jwt: {
    userSecret: env.JWT_SECRET,
    userExpiresIn: env.JWT_EXPIRES_IN,
    adminSecret: env.ADMIN_JWT_SECRET,
    adminExpiresIn: env.ADMIN_JWT_EXPIRES_IN,
  },
  publicBaseUrl: env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`,
  corsOrigins: env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : null,
  mock: {
    pay: env.WECHAT_PAY_MOCK === 'true',
    login: env.WECHAT_LOGIN_MOCK === 'true',
    qrcode: env.WECHAT_QRCODE_MOCK === 'true',
  },
  order: {
    payTimeoutMin: env.PAY_TIMEOUT_MIN,
    autoCompleteDays: env.AUTO_COMPLETE_DAYS,
  },
  schedulerEnabled: env.SCHEDULER_DISABLED !== 'true',
  subscribe: {
    shipTemplateId: env.WECHAT_TMPL_SHIP ?? '',
    shipFields: env.WECHAT_TMPL_SHIP_FIELDS ?? '',
    refundTemplateId: env.WECHAT_TMPL_REFUND ?? '',
    refundFields: env.WECHAT_TMPL_REFUND_FIELDS ?? '',
  },
  cos: {
    enabled: cosEnabled,
    secretId: env.COS_SECRET_ID ?? '',
    secretKey: env.COS_SECRET_KEY ?? '',
    bucket: env.COS_BUCKET ?? '',
    region: env.COS_REGION ?? '',
    baseUrl: (env.COS_BASE_URL ?? '').replace(/\/+$/, ''),
  },
}
