import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, RefreshCw } from 'lucide-react'
import client from '../api/client'
import type { ApiResponse } from '../types'
import Spinner from '../components/ui/Spinner'
import Button from '../components/ui/Button'

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
  }
  notify: { wecomSet: boolean; pushplusSet: boolean }
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
  const payReady =
    data.pay.mchIdSet &&
    data.pay.serialNoSet &&
    data.pay.privateKeySet &&
    data.pay.apiV3KeySet &&
    data.pay.notifyUrlSet &&
    data.pay.notifyUrlIsHttps

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
        { ok: data.pay.platformCertSet, label: '平台证书（生产必须）', hint: 'WECHAT_PAY_PLATFORM_CERT_PATH，用于回调验签', optional: isDev },
      ],
    },
    {
      title: '新订单推送',
      items: [
        { ok: data.notify.wecomSet, label: '企业微信群机器人', hint: '在 .env 配置 ORDER_NOTIFY_WECOM_WEBHOOK', optional: true },
        { ok: data.notify.pushplusSet, label: 'PushPlus', hint: '在 .env 配置 ORDER_NOTIFY_PUSHPLUS_TOKEN', optional: true },
      ],
    },
  ]

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-gray-800">系统状态</h2>
        <Button variant="secondary" size="sm" onClick={load} loading={loading}>
          <RefreshCw className="w-4 h-4" />
          刷新
        </Button>
      </div>

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
