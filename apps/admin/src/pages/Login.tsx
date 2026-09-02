import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, UtensilsCrossed } from 'lucide-react'
import { useAuthStore } from '../store/auth'
import { login } from '../api/admin'
import Button from '../components/ui/Button'

export default function Login() {
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await login(username, password)
      const { token, adminInfo } = res.data.data
      setAuth(token, adminInfo)
      navigate('/dashboard')
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        '登录失败，请重试'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-brand-gradient relative overflow-hidden">
      {/* 装饰圆 */}
      <div className="absolute -top-24 -left-24 w-full max-w-sm mx-4 h-96 rounded-full bg-white/10" />
      <div className="absolute -bottom-32 -right-16 w-[28rem] h-[28rem] rounded-full bg-white/10" />
      <div className="absolute top-1/3 right-1/4 w-24 h-24 rounded-full bg-white/5" />

      <div className="relative bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm mx-4">
        <div className="flex flex-col items-center mb-6">
          <span className="w-14 h-14 rounded-2xl bg-brand-gradient flex items-center justify-center shadow-md mb-3">
            <UtensilsCrossed className="text-white" size={28} />
          </span>
          <h1 className="text-xl font-bold text-gray-800">阿福凉菜管理后台</h1>
          <p className="text-xs text-gray-400 mt-1">Food Shop Admin</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              placeholder="请输入用户名"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              placeholder="请输入密码"
              required
            />
          </div>
          {error && (
            <p className="flex items-center gap-1.5 text-red-500 text-sm bg-red-50 rounded-md px-3 py-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </p>
          )}
          <Button type="submit" loading={loading} className="w-full">
            {loading ? '登录中...' : '登 录'}
          </Button>
        </form>
      </div>
    </div>
  )
}
