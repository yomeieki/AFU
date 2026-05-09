import { useEffect, useState } from 'react'
import { getStats } from '../api/admin'
import type { Stats } from '../types'

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-800 mt-1">{value}</p>
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

  if (loading) return <div className="text-gray-500 text-sm">加载中...</div>
  if (!stats) return <div className="text-red-500 text-sm">数据加载失败</div>

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-800">今日概览</h2>
      <div className="grid grid-cols-2 gap-4">
        <StatCard label="今日订单数" value={stats.today.orderCount} />
        <StatCard
          label="今日销售额"
          value={`¥${(stats.today.salesAmount / 100).toFixed(2)}`}
        />
      </div>

      <h2 className="text-xl font-semibold text-gray-800">累计数据</h2>
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="总订单数" value={stats.total.orderCount} />
        <StatCard label="在售商品数" value={stats.total.productCount} />
        <StatCard label="分类数" value={stats.total.categoryCount} />
      </div>

      <h2 className="text-xl font-semibold text-gray-800">热销商品 Top 5</h2>
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
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
                <td className="px-4 py-3 text-right text-gray-600">
                  ¥{(p.price / 100).toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right text-orange-600 font-medium">
                  {p.salesCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
