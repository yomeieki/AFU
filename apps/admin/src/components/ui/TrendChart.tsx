import { useMemo, useState } from 'react'

interface TrendChartProps {
  data: { label: string; value: number }[]
  type?: 'line' | 'bar'
  height?: number
  valueFormatter?: (v: number) => string
}

// 轻量趋势图：手写 SVG（viewBox + w-full 自适应宽度），不引图表库
export default function TrendChart({
  data,
  type = 'line',
  height = 220,
  valueFormatter = (v) => String(v),
}: TrendChartProps) {
  const [hover, setHover] = useState<number | null>(null)

  const W = 720
  const H = height
  const PAD = { top: 16, right: 12, bottom: 28, left: 44 }
  const iw = W - PAD.left - PAD.right
  const ih = H - PAD.top - PAD.bottom

  const { max, points, ticks } = useMemo(() => {
    const rawMax = Math.max(1, ...data.map((d) => d.value))
    // y 轴上限取「不小于最大值的整洁数」
    const mag = Math.pow(10, Math.floor(Math.log10(rawMax)))
    const nice = [1, 2, 5, 10].map((n) => n * mag).find((n) => n >= rawMax) ?? rawMax
    const xStep = data.length > 1 ? iw / (data.length - 1) : 0
    const pts = data.map((d, i) => ({
      x: PAD.left + (data.length > 1 ? i * xStep : iw / 2),
      y: PAD.top + ih * (1 - d.value / nice),
    }))
    const tks = [0, 0.5, 1].map((r) => ({
      y: PAD.top + ih * (1 - r),
      v: nice * r,
    }))
    return { max: nice, points: pts, ticks: tks }
  }, [data, ih, iw])

  if (data.length === 0) {
    return <div className="text-sm text-gray-400 py-10 text-center">暂无数据</div>
  }

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${PAD.top + ih} L${points[0].x.toFixed(1)},${PAD.top + ih} Z`
  const barW = Math.min(32, (iw / data.length) * 0.6)
  // 横轴标签抽样：最多约 8 个
  const labelEvery = Math.max(1, Math.ceil(data.length / 8))

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} stroke="#f3f4f6" />
            <text x={PAD.left - 6} y={t.y + 4} textAnchor="end" fontSize="11" fill="#9ca3af">
              {valueFormatter(t.v)}
            </text>
          </g>
        ))}
        {type === 'line' ? (
          <>
            <path d={areaPath} fill="url(#trend-fill)" opacity="0.25" />
            <path d={linePath} fill="none" stroke="#e5441e" strokeWidth="2" strokeLinejoin="round" />
            <defs>
              <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#e5441e" />
                <stop offset="100%" stopColor="#e5441e" stopOpacity="0" />
              </linearGradient>
            </defs>
          </>
        ) : (
          points.map((p, i) => (
            <rect
              key={i}
              x={p.x - barW / 2}
              y={p.y}
              width={barW}
              height={PAD.top + ih - p.y}
              rx="3"
              fill={hover === i ? '#c33514' : '#e5441e'}
            />
          ))
        )}
        {/* hover 命中区 + 指示点 */}
        {points.map((p, i) => (
          <rect
            key={`h${i}`}
            x={p.x - (data.length > 1 ? (points[1].x - points[0].x) / 2 : iw / 2)}
            y={PAD.top}
            width={data.length > 1 ? points[1].x - points[0].x : iw}
            height={ih}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
        {type === 'line' && hover !== null && (
          <circle cx={points[hover].x} cy={points[hover].y} r="4" fill="#e5441e" stroke="#fff" strokeWidth="2" />
        )}
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <text
              key={i}
              x={points[i].x}
              y={H - 8}
              textAnchor="middle"
              fontSize="11"
              fill="#9ca3af"
            >
              {d.label.slice(5)}
            </text>
          ) : null
        )}
      </svg>
      {hover !== null && (
        <div
          className="absolute -translate-x-1/2 -translate-y-full bg-gray-800 text-white text-xs rounded px-2 py-1 pointer-events-none whitespace-nowrap"
          style={{
            left: `${(points[hover].x / W) * 100}%`,
            top: `${(points[hover].y / H) * 100}%`,
          }}
        >
          {data[hover].label}：{valueFormatter(data[hover].value)}
        </div>
      )}
      <span className="sr-only">最大值 {valueFormatter(max)}</span>
    </div>
  )
}
