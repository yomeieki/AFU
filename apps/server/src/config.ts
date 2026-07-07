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
}
