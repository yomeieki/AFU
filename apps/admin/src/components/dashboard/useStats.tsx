import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

/** 三个 tab 共用：拉一次、失败可重试。deps 变了就重拉。 */
export function useStats<T>(fetcher: () => Promise<{ data: { data: T } }>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  // 连点两次范围时后发先至：只认最后一次请求，晚到的旧响应一律丢掉，
  // 否则「今日」的数字会顶着「近 30 天」的标签显示出来，页面上看不出任何异常。
  const seq = useRef(0)
  const load = useCallback(() => {
    const mine = ++seq.current
    setLoading(true); setFailed(false)
    fetcher()
      .then((r) => { if (mine === seq.current) setData(r.data.data) })
      .catch(() => { if (mine === seq.current) setFailed(true) })
      .finally(() => { if (mine === seq.current) setLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => { load() }, [load])
  return { data, loading, failed, reload: load }
}

export function StatsShell({ loading, failed, reload, children }: { loading: boolean; failed: boolean; reload: () => void; children: ReactNode }) {
  if (failed) return (
    <div className="bg-white rounded-lg shadow-card p-6 text-sm text-red-500 flex items-center gap-3">
      数据加载失败 <button onClick={reload} className="text-brand-600 underline">重试</button>
    </div>
  )
  if (loading) return <div className="text-sm text-gray-500">加载中…</div>
  return <>{children}</>
}
