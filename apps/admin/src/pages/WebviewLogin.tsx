import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertCircle } from 'lucide-react'
import { useAuthStore } from '../store/auth'
import { loginWithWebviewCode } from '../api/admin'
import Spinner from '../components/ui/Spinner'

/**
 * 小程序 web-view 入口 /m?code=xxx：用一次性 code 换 token 后进入订单页。
 * code 60 秒有效、单次使用；失效则提示回小程序重新进入（不回退到账号密码页，避免员工重复输密码）。
 */
export default function WebviewLogin() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [error, setError] = useState('')
  // code 单次有效：React 18 StrictMode 开发态会双跑 effect，用 ref 保证只换一次
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const code = params.get('code')
    if (!code) {
      setError('缺少登录凭证，请从小程序「商家管理」重新进入')
      return
    }
    loginWithWebviewCode(code)
      .then((res) => {
        const { token, adminInfo } = res.data.data
        setAuth(token, adminInfo)
        // to=orders?status=PAID 之类的站内相对路径；防止外部跳转只允许无协议的相对路径
        const to = params.get('to') ?? ''
        const safeTo = /^[a-z0-9-]+(\?[^\s]*)?$/i.test(to) ? `/${to}` : '/orders?status=PAID'
        navigate(safeTo, { replace: true })
      })
      .catch((err: unknown) => {
        setError(
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
            '登录凭证已失效，请返回小程序重新进入'
        )
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 px-6">
      {error ? (
        <div className="bg-white rounded-xl shadow-card p-6 max-w-sm w-full text-center space-y-3">
          <AlertCircle className="w-8 h-8 text-red-500 mx-auto" />
          <p className="text-sm text-gray-700">{error}</p>
          <p className="text-xs text-gray-400">返回小程序 →「我的」→「商家管理」重新打开即可</p>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <Spinner className="w-4 h-4" />
          正在进入管理后台…
        </div>
      )}
    </div>
  )
}
