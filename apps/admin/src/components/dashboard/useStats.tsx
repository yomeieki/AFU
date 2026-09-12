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

/**
 * 重拉时**不卸载**已有内容（stale-while-revalidate）：原来一 loading 就把整个 tab 换成一行「加载中…」，
 * 页面高度瞬间塌掉，浏览器把滚动条钳回顶部——在页面中段点热销榜的「同城/自取/邮寄」切换，
 * 眼前的内容先消失、再回到顶部、再重新出现（PO 2026-09-12 抓到）。
 * 现在：已有数据就原地保留并压淡，右上角挂一个「更新中…」；只有第一次（还没数据）才显示占位。
 * 失败同理：有旧数据时在上方挂一条红字 + 重试，旧数据留着；没数据才整块换成失败提示。
 */
export function StatsShell({ loading, failed, reload, hasData, children }: { loading: boolean; failed: boolean; reload: () => void; hasData: boolean; children: ReactNode }) {
  if (!hasData) {
    if (failed) return (
      <div className="bg-white rounded-lg shadow-card p-6 text-sm text-red-500 flex items-center gap-3">
        数据加载失败 <button onClick={reload} className="text-brand-600 underline">重试</button>
      </div>
    )
    return <div className="text-sm text-gray-500">加载中…</div>
  }
  return (
    <div className="relative">
      {failed && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-600 flex items-center gap-3">
          刷新失败，下面仍是上一次的数据 <button onClick={reload} className="underline">重试</button>
        </div>
      )}
      {loading && (
        <span className="absolute right-0 -top-7 text-xs text-gray-400" aria-live="polite">更新中…</span>
      )}
      <div className={loading ? 'opacity-60 pointer-events-none transition-opacity' : 'transition-opacity'}>{children}</div>
    </div>
  )
}
