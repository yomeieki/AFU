import { useEffect, useState } from 'react'
import {
  ClipboardList,
  Wallet,
  Package,
  FolderTree,
  TrendingUp,
  LucideIcon,
} from 'lucide-react'
import { getStats } from '../api/admin'
import type { Stats } from '../types'
import Spinner from '../components/ui/Spinner'

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string
  value: string | number
  icon: LucideIcon
  tone: 'brand' | 'blue' | 'green' | 'purple'
}) {
  const TONE = {
    brand: 'bg-brand-50 text-brand-500',
    blue: 'bg-blue-50 text-blue-500',
    green: 'bg-green-50 text-green-600',
    purple: 'bg-purple-50 text-purple-500',
  }
  return (
    <div className="bg-white rounded-lg shadow-card p-6 flex items-center gap-4">
      <span className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${TONE[tone]}`}>
        <Icon className="w-6 h-6" strokeWidth={1.8} />
      </span>
      <div className="min-w-0">
        <p className="text-sm text-gray-500">{label}</p>
        <p className="text-2xl font-bold text-gray-800 mt-0.5 truncate">{value}</p>
      </div>
    </div>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getStats()
      .then((res) => setStats(res.data.data))
      .finally(() => setLoading(false))
  }, [])

  if (loading)
    return (
      <div className="flex items-center gap-2 text-gray-500 text-sm">
        <Spinner /> 加载中...
      </div>
    )
  if (!stats) return <div className="text-red-500 text-sm">数据加载失败</div>

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-800">今日概览</h2>
      <div className="grid grid-cols-2 gap-4">
        <StatCard label="今日订单数" value={stats.today.orderCount} icon={ClipboardList} tone="brand" />
        <StatCard
          label="今日销售额"
          value={`¥${(stats.today.salesAmount / 100).toFixed(2)}`}
          icon={Wallet}
          tone="green"
        />
      </div>

      <h2 className="text-xl font-semibold text-gray-800">累计数据</h2>
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="总订单数" value={stats.total.orderCount} icon={ClipboardList} tone="blue" />
        <StatCard label="在售商品数" value={stats.total.productCount} icon={Package} tone="brand" />
        <StatCard label="分类数" value={stats.total.categoryCount} icon={FolderTree} tone="purple" />
      </div>

      <h2 className="flex items-center gap-2 text-xl font-semibold text-gray-800">
        <TrendingUp className="w-5 h-5 text-brand-500" />
        热销商品 Top 5
      </h2>
      <div className="bg-white rounded-lg shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left px-4 py-3">商品名称</th>
              <th className="text-right px-4 py-3">价格</th>
              <th className="text-right px-4 py-3">销量</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {stats.hotProducts.map((p) => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-800">{p.name}</td>
                <td className="px-4 py-3 text-right font-semibold text-brand-600">
                  ¥{(p.price / 100).toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right text-gray-600">{p.salesCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
