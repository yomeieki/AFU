import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, RefreshCw } from 'lucide-react'
import client from '../api/client'
import type { ApiResponse } from '../types'
import Spinner from '../components/ui/Spinner'
import Button from '../components/ui/Button'
import { CenterAction } from '../components/BusinessCenter'

interface SystemStatusData {
  env: string
  mock: { login: boolean; pay: boolean; qrcode: boolean }
  wechat: { appIdSet: boolean; appSecretSet: boolean }
  pay: {
    mchIdSet: boolean
    serialNoSet: boolean
    privateKeySet: boolean
    apiV3KeySet: boolean
    notifyUrlSet: boolean
    notifyUrlIsHttps: boolean
    platformCertSet: boolean
    refundNotifyUrlSet: boolean
    refundNotifyUrlIsHttps: boolean
    publicKeySet: boolean
    publicKeyIdSet: boolean
    verifyMode: 'public-key' | 'platform-cert' | 'both' | 'none'
    certAutoDownload: boolean
  }
  cos: {
    secretIdSet: boolean
    secretKeySet: boolean
    bucketSet: boolean
    regionSet: boolean
    baseUrlSet: boolean
    enabled: boolean
  }
  notify: {
    wecomSet: boolean
    pushplusSet: boolean
    pushplusTopicSet: boolean
    systemAlertWecomSet: boolean
    systemAlertPushplusSet: boolean
  }
  subscribe: {
    paidTemplateSet: boolean
    shipTemplateSet: boolean
    refundTemplateSet: boolean
    deliverTemplateSet: boolean
    pickupTemplateSet: boolean
  }
  kd100: {
    keySet: boolean
    secretSet: boolean
    mock: boolean
    callbackUrlSample: string
    callbackUrlOk: boolean
    circuitTripped: boolean
  }
  publicBaseUrl: string
}

interface CheckItem {
  ok: boolean
  label: string
  hint: string // 未配置时提示（.env 键名）
  optional?: boolean
}

function Row({ item }: { item: CheckItem }) {
  return (
    <div className="flex items-start gap-2.5 py-2.5 border-b border-gray-50 last:border-0">
      {item.ok ? (
        <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
      ) : (
        <XCircle className={`w-5 h-5 shrink-0 mt-0.5 ${item.optional ? 'text-gray-300' : 'text-gray-400'}`} />
      )}
      <div className="min-w-0">
        <p className="text-sm text-gray-800">
          {item.label}
          {item.optional && <span className="ml-1.5 text-xs text-gray-400">可选</span>}
        </p>
        {!item.ok && <p className="text-xs text-gray-400 mt-0.5">{item.hint}</p>}
      </div>
    </div>
  )
}

export default function SystemStatus() {
  const [data, setData] = useState<SystemStatusData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    client
      .get<ApiResponse<SystemStatusData>>('/admin/system/status')
      .then((res) => setData(res.data.data))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  if (loading && !data)
    return (
      <div className="flex items-center gap-2 text-gray-500 text-sm">
        <Spinner /> 加载中...
      </div>
    )
  if (!data) return <div className="text-red-500 text-sm">加载失败</div>

  const isDev = data.env !== 'production'
  const anyMock = data.mock.login || data.mock.pay || data.mock.qrcode
  const verifyReady = data.pay.publicKeySet || data.pay.platformCertSet
  // 同城运力密钥都配好了，才把同城相关项当必填（否则纯邮寄店会看到一堆无关的红叉）
  const localReady = data.kd100.keySet && data.kd100.secretSet
  const payReady =
    data.pay.mchIdSet &&
    data.pay.serialNoSet &&
    data.pay.privateKeySet &&
    data.pay.apiV3KeySet &&
    data.pay.notifyUrlSet &&
    data.pay.notifyUrlIsHttps &&
    verifyReady

  const groups: { title: string; items: CheckItem[] }[] = [
    {
      title: '微信小程序登录',
      items: [
        { ok: data.wechat.appIdSet, label: '小程序 AppID', hint: '在 .env 配置 WECHAT_APP_ID' },
        { ok: data.wechat.appSecretSet, label: '小程序 AppSecret', hint: '在 .env 配置 WECHAT_APP_SECRET' },
      ],
    },
    {
      title: '微信支付（上线必须全绿，详见 docs/payment-setup.md）',
      items: [
        { ok: data.pay.mchIdSet, label: '商户号', hint: '在 .env 配置 WECHAT_MCH_ID（微信支付商户平台申请）' },
        { ok: data.pay.apiV3KeySet, label: 'APIv3 密钥', hint: '在 .env 配置 WECHAT_PAY_API_V3_KEY' },
        { ok: data.pay.serialNoSet, label: '商户证书序列号', hint: '在 .env 配置 WECHAT_PAY_SERIAL_NO' },
        { ok: data.pay.privateKeySet, label: '商户私钥文件（存在性已校验）', hint: 'WECHAT_PAY_PRIVATE_KEY_PATH 指向 apiclient_key.pem' },
        { ok: data.pay.notifyUrlSet, label: '支付回调地址', hint: '在 .env 配置 WECHAT_PAY_NOTIFY_URL（公网 HTTPS）' },
        { ok: data.pay.notifyUrlIsHttps, label: '回调地址为 HTTPS', hint: '微信要求回调必须是 https:// 开头' },
        { ok: data.pay.refundNotifyUrlSet && data.pay.refundNotifyUrlIsHttps, label: '退款回调地址', hint: '默认由支付回调地址派生（/notify → /refund-notify），也可配置 WECHAT_PAY_REFUND_NOTIFY_URL' },
      ],
    },
    {
      title: '回调验签（公钥 / 平台证书 二选一，商户平台「API 安全」页看当前模式）',
      items: [
        { ok: data.pay.publicKeySet, label: '微信支付公钥（2024 年起新商户默认）', hint: 'WECHAT_PAY_PUBLIC_KEY_PATH 指向 pub_key.pem', optional: data.pay.platformCertSet },
        { ok: data.pay.publicKeyIdSet, label: '公钥 ID（可选，用于校验回调头）', hint: 'WECHAT_PAY_PUBLIC_KEY_ID = PUB_KEY_ID_xxx', optional: true },
        { ok: data.pay.platformCertSet, label: '平台证书（老商户）', hint: 'WECHAT_PAY_PLATFORM_CERT_PATH；序列号不匹配时会自动拉取', optional: data.pay.publicKeySet },
        { ok: verifyReady, label: `验签材料就绪（当前：${{ 'public-key': '公钥', 'platform-cert': '平台证书', both: '公钥+证书', none: '未配置' }[data.pay.verifyMode]}）`, hint: '两者都未配置时生产环境会拒绝所有支付/退款回调', optional: isDev },
      ],
    },
    {
      title: '图片存储 COS（生产必须，未配置服务拒绝启动）',
      items: [
        { ok: data.cos.secretIdSet && data.cos.secretKeySet, label: '访问密钥', hint: 'COS_SECRET_ID / COS_SECRET_KEY（建议子账号密钥，仅授权该桶）', optional: isDev },
        { ok: data.cos.bucketSet && data.cos.regionSet, label: '存储桶与地域', hint: 'COS_BUCKET / COS_REGION', optional: isDev },
        { ok: data.cos.baseUrlSet, label: '自定义访问域名', hint: 'COS_BASE_URL（未配置时使用桶默认域名）', optional: true },
        { ok: data.cos.enabled, label: `COS 已启用（当前上传走 ${data.cos.enabled ? 'COS' : '本地磁盘'}）`, hint: '开发环境未配置时回退本地 uploads/', optional: isDev },
      ],
    },
    {
      title: '新订单推送（店员收）',
      items: [
        // 这一项不是 optional：两个通道都空 = 顾客付了钱店员完全不知道
        { ok: data.notify.wecomSet || data.notify.pushplusSet, label: '至少有一个推送通道', hint: '都未配置时，店员只能靠盯着本页面才知道来单了' },
        { ok: data.notify.pushplusSet, label: 'PushPlus', hint: '在 .env 配置 ORDER_NOTIFY_PUSHPLUS_TOKEN', optional: true },
        { ok: data.notify.pushplusTopicSet, label: 'PushPlus 群组（多店员共享）', hint: 'ORDER_NOTIFY_PUSHPLUS_TOPIC；不配则只推给 token 所属账号本人', optional: true },
        { ok: data.notify.wecomSet, label: '企业微信群机器人', hint: '在 .env 配置 ORDER_NOTIFY_WECOM_WEBHOOK', optional: true },
      ],
    },
    {
      title: '系统告警（接口 500 / 进程异常 / 退款失败，老板收）',
      items: [
        { ok: data.notify.systemAlertWecomSet || data.notify.wecomSet || data.notify.systemAlertPushplusSet, label: '至少有一个告警通道', hint: '都未配置时告警只写进 pm2 日志，没人会看到' },
        { ok: data.notify.systemAlertPushplusSet, label: '告警 PushPlus（一对一）', hint: 'SYSTEM_ALERT_PUSHPLUS_TOKEN；不配则回退订单 token，且不带群组——只推给本人，不进店员群', optional: true },
        { ok: data.notify.systemAlertWecomSet || data.notify.wecomSet, label: '告警企微群', hint: 'SYSTEM_ALERT_WECOM_WEBHOOK（未配置时回退到新订单推送群）', optional: true },
      ],
    },
    {
      title: '订阅消息模板（未配置时不弹授权、不推送，且不报错）',
      items: [
        { ok: data.subscribe.paidTemplateSet, label: '付款成功通知', hint: 'WECHAT_TMPL_PAID / WECHAT_TMPL_PAID_FIELDS', optional: true },
        { ok: data.subscribe.shipTemplateSet, label: '发货通知', hint: 'WECHAT_TMPL_SHIP / WECHAT_TMPL_SHIP_FIELDS（公共模板库「发货通知」类）' },
        { ok: data.subscribe.refundTemplateSet, label: '退款通知', hint: 'WECHAT_TMPL_REFUND / WECHAT_TMPL_REFUND_FIELDS（公共模板库「退款通知」类）' },
        // 同城专用：缺这项时「配送中」推送会静默不发，页面上看不出异常，只能靠这一行
        { ok: data.subscribe.deliverTemplateSet, label: '同城「配送中」通知', hint: 'WECHAT_TMPL_DELIVER / WECHAT_TMPL_DELIVER_FIELDS（公共模板 584「订单配送通知」，值见 docs/wechat-platform-local-delivery-setup.md）', optional: !localReady },
        { ok: data.subscribe.pickupTemplateSet, label: '自取「取餐提醒」通知', hint: 'WECHAT_TMPL_PICKUP / WECHAT_TMPL_PICKUP_FIELDS（公共模板 250「取餐提醒」，key 见 .env.example）', optional: true },
      ],
    },
    {
      title: '同城配送运力（快递100）',
      items: [
        { ok: data.kd100.keySet && data.kd100.secretSet, label: '快递100 密钥', hint: 'KD100_KEY / KD100_SECRET（企业版后台 → 我的信息 → 企业信息；需先企业认证并预充值）', optional: isDev },
        { ok: !data.kd100.mock, label: `运力模式：${data.kd100.mock ? 'Mock（不打真实接口）' : '真实运力'}`, hint: 'LOCAL_DELIVERY_PROVIDER_MOCK=true 时走本地指令队列；生产开启会拒绝启动', optional: isDev },
        { ok: data.kd100.callbackUrlOk, label: `回调地址长度合规（${data.kd100.callbackUrlSample.length}/50）`, hint: `快递100 对 callbackUrl 限长 50 字符，当前最坏值 ${data.kd100.callbackUrlSample} 超长——换更长域名前须先缩短路径前缀` },
        { ok: !data.kd100.circuitTripped, label: data.kd100.circuitTripped ? '⚠️ 熔断已触发（呼叫骑手被暂停）' : '熔断未触发', hint: '余额不足/配置错会熔断，充值或改配置后需在配送设置页手动重置' },
      ],
    },
  ]

  return (
    <div className="space-y-4 max-w-2xl">
      <CenterAction>
        <Button variant="secondary" size="sm" onClick={load} loading={loading}>
          <RefreshCw className="w-4 h-4" />
          刷新
        </Button>
      </CenterAction>

      {/* 总览横幅 */}
      <div
        className={`rounded-lg p-4 text-sm ${
          anyMock ? 'bg-amber-50 text-amber-800' : payReady ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'
        }`}
      >
        <p className="font-medium">
          {anyMock ? '开发模式（Mock 已开启）' : payReady ? '支付配置就绪' : '支付配置未完成'}
        </p>
        <p className="mt-1 text-xs opacity-80">
          运行环境：{data.env}　服务地址：{data.publicBaseUrl}
          {anyMock &&
            `　Mock：${[data.mock.login && '登录', data.mock.pay && '支付', data.mock.qrcode && '二维码']
              .filter(Boolean)
              .join(' / ')}（生产环境会被启动校验强制禁用）`}
        </p>
      </div>

      {groups.map((g) => (
        <div key={g.title} className="bg-white rounded-lg shadow-card p-4">
          <h3 className="text-sm font-medium text-gray-700 mb-1">{g.title}</h3>
          {g.items.map((it) => (
            <Row key={it.label} item={it} />
          ))}
        </div>
      ))}

      <p className="text-xs text-gray-400">
        本页只读，仅显示配置是否存在，不展示任何密钥内容。修改配置需编辑服务器上的 .env 文件并重启服务。
      </p>
    </div>
  )
}
