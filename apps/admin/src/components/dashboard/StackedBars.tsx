import { useMemo, useState } from 'react'

export interface BarSeries { name: string; color: string; values: number[] }

interface Props {
  labels: string[]
  series: BarSeries[]            // 1–3 个；values 长度 = labels 长度
  height?: number
  valueFormatter?: (v: number) => string
  /** x 轴标签最多显示几个（多了会挤），均匀抽样 */
  maxXLabels?: number
}

/** 手写 SVG 堆叠柱。与 ui/TrendChart 并存：那个是单系列折线/柱，扫码统计在用，不动它。 */
export default function StackedBars({ labels, series, height = 220, valueFormatter = (v) => String(v), maxXLabels = 12 }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 720, H = height
  const PAD = { top: 16, right: 12, bottom: 28, left: 48 }
  const iw = W - PAD.left - PAD.right, ih = H - PAD.top - PAD.bottom
  const n = labels.length

  const { max, ticks } = useMemo(() => {
    const totals = labels.map((_, i) => series.reduce((s, sr) => s + (sr.values[i] ?? 0), 0))
    const rawMax = Math.max(1, ...totals)
    const mag = Math.pow(10, Math.floor(Math.log10(rawMax)))
    const nice = [1, 2, 5, 10].map((k) => k * mag).find((k) => k >= rawMax) ?? rawMax
    return { max: nice, ticks: [0, 0.5, 1].map((r) => ({ y: PAD.top + ih * (1 - r), v: nice * r })) }
  }, [labels, series, ih])

  if (!n) return <div className="text-sm text-gray-400 text-center py-8">暂无数据</div>
  const slot = iw / n
  const bw = Math.max(2, slot * 0.6)
  const labelEvery = Math.max(1, Math.ceil(n / maxXLabels))

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t.v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} stroke="#e5e7eb" strokeDasharray="3 3" />
            <text x={PAD.left - 6} y={t.y + 4} fontSize="11" fill="#9ca3af" textAnchor="end">{valueFormatter(t.v)}</text>
          </g>
        ))}
        {labels.map((lb, i) => {
          const x = PAD.left + i * slot + (slot - bw) / 2
          let yTop = PAD.top + ih
          return (
            <g key={lb} onMouseEnter={() => setHover(i)}>
              <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={ih} fill={hover === i ? '#f3f4f6' : 'transparent'} />
              {series.map((sr) => {
                const v = sr.values[i] ?? 0
                const h = (v / max) * ih
                yTop -= h
                return <rect key={sr.name} x={x} y={yTop} width={bw} height={h} fill={sr.color} rx={1} />
              })}
              {i % labelEvery === 0 && (
                <text x={PAD.left + i * slot + slot / 2} y={H - 8} fontSize="11" fill="#6b7280" textAnchor="middle">{lb}</text>
              )}
            </g>
          )
        })}
      </svg>
      {hover != null && (
        <div className="pointer-events-none absolute top-2 right-2 bg-gray-900/90 text-white text-xs rounded px-2 py-1 space-y-0.5">
          <div className="text-gray-300">{labels[hover]}</div>
          {series.map((sr) => (
            <div key={sr.name} className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: sr.color }} />
              {sr.name} {valueFormatter(sr.values[hover] ?? 0)}
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex gap-4 text-xs text-gray-500">
        {series.map((sr) => (
          <span key={sr.name} className="inline-flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: sr.color }} />{sr.name}</span>
        ))}
      </div>
    </div>
  )
}
