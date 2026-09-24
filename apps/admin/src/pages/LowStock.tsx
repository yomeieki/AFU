import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { getLowStockOverview, updateUnitStock, updateLowStockSettings } from '../api/admin'
import { CenterAction } from '../components/BusinessCenter'
import Button from '../components/ui/Button'
import Table from '../components/ui/Table'
import { toast } from '../components/ui/Toast'
import { useUnsavedSettings } from '../components/UnsavedSettings'
import { filterLowStockGroups, countLowStock, unitLabel, parseStockInput } from '../utils/stock-alert'
import type { Channel, LowStockGroup, LowStockOverview, LowStockUnit } from '../types'

// 短渠道标签：CHANNEL_LABEL 的「同城配送/全国邮寄」在筛选胶囊/分组小标签里太长
const CH_SHORT: Record<Channel, string> = { LOCAL: '同城', EXPRESS: '邮寄' }
const CH_TAG_CLS: Record<Channel, string> = {
  LOCAL: 'bg-blue-50 text-blue-600',
  EXPRESS: 'bg-purple-50 text-purple-600',
}

type LevelFilter = 'ALL' | 'OUT' | 'LOW'

function groupCounts(g: LowStockGroup): { out: number; low: number } {
  const out = g.units.filter((u) => u.level === 'OUT').length
  return { out, low: g.units.length - out }
}

function groupSummary(g: LowStockGroup): string {
  const { out, low } = groupCounts(g)
  const parts: string[] = []
  if (out > 0) parts.push(`${out} 个售罄`)
  if (low > 0) parts.push(`${low} 个紧张`)
  return parts.join('、')
}

function extractMessage(e: unknown, fallback: string): string {
  return (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback
}

export default function LowStock() {
  const { setDirty } = useUnsavedSettings()
  const [overview, setOverview] = useState<LowStockOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [level, setLevel] = useState<LevelFilter>('ALL')
  const [channel, setChannel] = useState<Channel | null>(null)

  const [lowThreshold, setLowThreshold] = useState('')
  const [pushBelow, setPushBelow] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)

  const [edits, setEdits] = useState<Record<string, string>>({})
  const [savingKey, setSavingKey] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const data = await getLowStockOverview()
      setOverview(data)
      setLowThreshold(String(data.settings.lowThreshold))
      setPushBelow(String(data.settings.pushBelow))
      setDirty(false)
    } catch {
      toast.error('加载失败，请刷新重试')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveThresholds = async () => {
    const lt = Number(lowThreshold)
    const pb = Number(pushBelow)
    if (!Number.isInteger(lt) || !Number.isInteger(pb) || lt < 1 || pb < 1) {
      toast.error('请输入 1 以上的整数')
      return
    }
    setSavingSettings(true)
    try {
      // 读最新设置校验用不到，直接整包写回（这两个字段就是全部结构）
      await updateLowStockSettings({ lowThreshold: lt, pushBelow: pb })
      toast.success('已保存')
      setDirty(false)
      await load()
    } catch (e) {
      toast.error(extractMessage(e, '保存失败'))
    } finally {
      setSavingSettings(false)
    }
  }

  const saveUnit = async (g: LowStockGroup, u: LowStockUnit) => {
    const raw = edits[u.key] ?? String(u.stock)
    const v = parseStockInput(raw)
    if (v === null) {
      toast.error('请输入不小于 0 的整数')
      return
    }
    setSavingKey(u.key)
    try {
      await updateUnitStock(g.productId, { skuId: u.skuId, stock: v })
      toast.success(`已保存：${g.productName}（${u.specText ?? '无规格'}）库存 ${v}`)
      setEdits((e) => {
        const next = { ...e }
        delete next[u.key]
        return next
      })
      await load()
    } catch (e) {
      toast.error(extractMessage(e, '保存失败'))
    } finally {
      setSavingKey(null)
    }
  }

  const groups = overview?.groups ?? []
  const byChannel = channel ? groups.filter((g) => g.channel === channel) : groups
  const allCounts = countLowStock(byChannel)
  const outCounts = countLowStock(filterLowStockGroups(byChannel, { level: 'OUT' }))
  const lowCounts = countLowStock(filterLowStockGroups(byChannel, { level: 'LOW' }))
  const displayed = filterLowStockGroups(groups, { level: level === 'ALL' ? null : level, channel })

  const rows = displayed.flatMap((g) =>
    g.units.map((u, i) => ({ group: g, unit: u, first: i === 0, groupSize: g.units.length })),
  )

  return (
    <div className="space-y-4">
      <CenterAction>
        <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-1 inline ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </CenterAction>

      {/* 门槛设置 */}
      <div
        className="bg-white rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-2 text-sm text-gray-600"
        onChangeCapture={() => setDirty(true)}
      >
        <span>剩余 ≤</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={lowThreshold}
          onChange={(e) => setLowThreshold(e.target.value)}
          className="w-16 h-8 border border-gray-300 rounded-md text-center text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
        />
        <span>份算「紧张」，0 为「售罄」</span>
        <span className="mx-1">·</span>
        <span>剩余低于</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={pushBelow}
          onChange={(e) => setPushBelow(e.target.value)}
          className="w-16 h-8 border border-gray-300 rounded-md text-center text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
        />
        <span>份立即推送</span>
        <Button size="sm" loading={savingSettings} onClick={() => void saveThresholds()}>
          保存
        </Button>
        <p className="basis-full text-xs text-gray-400 mt-1">
          按规格判断；多规格商品任何一个规格到门槛都会列出来；每天开店前 30 分钟推一次清单
        </p>
      </div>

      {/* 筛选胶囊 */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {(
          [
            ['ALL', `全部 ${allCounts.total}`],
            ['OUT', `售罄 ${outCounts.out}`],
            ['LOW', `紧张 ${lowCounts.low}`],
          ] as [LevelFilter, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setLevel(v)}
            className={`h-8 px-3 rounded-full text-sm whitespace-nowrap border ${
              level === v ? 'bg-brand-50 border-brand-300 text-brand-600 font-medium' : 'bg-white border-gray-200 text-gray-600'
            }`}
          >
            {label}
          </button>
        ))}
        {(['LOCAL', 'EXPRESS'] as Channel[]).map((c) => (
          <button
            key={c}
            onClick={() => setChannel((cur) => (cur === c ? null : c))}
            className={`h-8 px-3 rounded-full text-sm whitespace-nowrap border ${
              channel === c ? 'bg-brand-50 border-brand-300 text-brand-600 font-medium' : 'bg-white border-gray-200 text-gray-600'
            }`}
          >
            {CH_SHORT[c]}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg shadow-card overflow-hidden">
      <Table
        columns={4}
        loading={loading}
        isEmpty={!loading && rows.length === 0}
        emptyText="没有售罄或紧张的规格"
        head={
          <tr>
            <th className="text-left px-4 py-3 w-[26%]">商品</th>
            <th className="text-left px-4 py-3 w-[24%]">规格</th>
            <th className="text-left px-4 py-3 w-[18%]">状态</th>
            <th className="text-left px-4 py-3">改库存</th>
          </tr>
        }
        mobileCards={
          <>
            {displayed.map((g) => (
              <div key={g.productId} className="border border-gray-100 rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-gray-50 flex items-center gap-2 text-sm font-semibold text-gray-800">
                  {g.productName}
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${CH_TAG_CLS[g.channel]}`}>{CH_SHORT[g.channel]}</span>
                  <span className="ml-auto text-xs font-normal text-gray-500">{groupSummary(g)}</span>
                </div>
                <div className="divide-y divide-gray-100">
                  {g.units.map((u) => {
                    const val = edits[u.key] ?? String(u.stock)
                    const parsedVal = parseStockInput(val)
                    const changed = parsedVal !== null && parsedVal !== u.stock
                    return (
                      <div key={u.key} className="flex items-center gap-2 px-3 py-2 text-sm">
                        <span className="flex-1 min-w-0 truncate text-gray-700">{u.specText ?? '—'}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${u.level === 'OUT' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}>
                          {unitLabel(u.stock)}
                        </span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          value={val}
                          onChange={(e) => setEdits((cur) => ({ ...cur, [u.key]: e.target.value }))}
                          className="w-14 h-8 border border-gray-300 rounded-md text-center text-sm"
                        />
                        <Button size="sm" variant="secondary" disabled={!changed} loading={savingKey === u.key} onClick={() => void saveUnit(g, u)}>
                          保存
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </>
        }
      >
        {rows.map((r) => {
          const val = edits[r.unit.key] ?? String(r.unit.stock)
          const parsedVal = parseStockInput(val)
          const changed = parsedVal !== null && parsedVal !== r.unit.stock
          // 组首行（同一商品的第一个规格）上边线更深，把不同商品之间的分隔和组内规格的分隔区分开
          const rowTopBorder = r.first ? 'border-t border-gray-300' : 'border-t border-gray-100'
          return (
            <tr key={r.unit.key}>
              {r.first && (
                <td
                  rowSpan={r.groupSize}
                  className={`px-4 py-3 align-top border-r border-gray-100 bg-gray-50/50 ${rowTopBorder}`}
                >
                  <span className="inline-flex items-center gap-1.5 font-medium text-gray-800">
                    {r.group.productName}
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${CH_TAG_CLS[r.group.channel]}`}>{CH_SHORT[r.group.channel]}</span>
                  </span>
                </td>
              )}
              <td className={`px-4 py-3 text-gray-600 ${rowTopBorder}`}>{r.unit.specText ?? '—'}</td>
              <td className={`px-4 py-3 ${rowTopBorder}`}>
                <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${r.unit.level === 'OUT' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}>
                  {unitLabel(r.unit.stock)}
                </span>
              </td>
              <td className={`px-4 py-3 ${rowTopBorder}`}>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={val}
                    onChange={(e) => setEdits((cur) => ({ ...cur, [r.unit.key]: e.target.value }))}
                    className="w-16 h-8 border border-gray-300 rounded-md text-center text-sm"
                  />
                  <Button size="sm" variant="secondary" disabled={!changed} loading={savingKey === r.unit.key} onClick={() => void saveUnit(r.group, r.unit)}>
                    保存
                  </Button>
                </div>
              </td>
            </tr>
          )
        })}
      </Table>
      </div>
    </div>
  )
}
