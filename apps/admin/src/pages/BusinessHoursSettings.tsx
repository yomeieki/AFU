import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { getLocalSettings, updateLocalSettings } from '../api/admin'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/Toast'
import { RowList, TimeRangeRow, validateRanges, sortRanges } from '../components/ui/RowList'
import { useUnsavedSettings } from '../components/UnsavedSettings'

const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'

/**
 * 营业时间（全店统一）——spec 2026-09-11 §4.10 / P13。
 * 存储仍是 local_delivery.businessHours（服务端单一来源），这里只编辑这一个字段：
 * 保存前先取最新设置再整包写回，其余字段原样带回（服务端 PUT 是整包覆盖）。
 */
export default function BusinessHoursSettings() {
  const { setDirty } = useUnsavedSettings()
  const [hours, setHours] = useState<{ start: string; end: string }[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getLocalSettings()
      .then((v) => { setHours([...v.businessHours]); setDirty(false) })
      .catch(() => { setLoadFailed(true); toast.error('营业时间加载失败，请刷新重试') })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  if (loadFailed) return <div className="text-red-600">营业时间加载失败，请刷新页面重试。</div>
  if (!hours) return <div className="text-gray-500">加载中...</div>

  const errs = validateRanges(hours)
  const hasErr = errs.some(Boolean)
  const sorted = sortRanges(hours)
  const breakText = !hasErr && sorted.length >= 2
    ? sorted.slice(1).map((h, i) => `${sorted[i].end}–${h.start}`).join('、') + ' 顾客端显示「午间休息」'
    : ''

  const save = async () => {
    if (hasErr) { toast.error('营业时段有错误，请先改正'); return }
    setSaving(true)
    try {
      let fresh
      try { fresh = await getLocalSettings() } catch { toast.error('读取最新设置失败，本次未保存，请刷新后重试'); return }
      const next = await updateLocalSettings({ ...fresh, businessHours: sortRanges(hours) })
      setHours([...next.businessHours]); setDirty(false)
      toast.success('已保存，外送下单、自取时段、来单催单与小程序「关于」页即刻按新时段')
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败')
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4 max-w-3xl" onChangeCapture={() => setDirty(true)}>
      <h3 className="text-lg font-semibold text-gray-800">营业时间</h3>
      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800 flex items-center gap-1"><Clock className="w-4 h-4" />营业时间（全店统一）</h3>
        <p className="text-xs text-gray-500">
          这一份时段同时决定：外送什么时候能下单、自取能选哪些取餐时段、来单催单在什么时段响、小程序「关于」页显示的营业时间。
          开门前顾客端显示「今天 HH:mm 营业」，两段之间显示「午间休息」，打烊后显示「明天 HH:mm 营业」。首期不支持跨零点；多段不可重叠。
        </p>
        <RowList rows={hours} onChange={setHours}
          blank={() => ({ start: '', end: '' })} errors={errs} addLabel="再加一段"
          emptyHint="一段都没有 = 全天不营业（外送与自取都无法开通）"
          render={(row, set) => <TimeRangeRow row={row} set={set} cls={inputCls} />} />
        {sorted.length > 0 && !hasErr && <p className="text-xs text-gray-500">今天 {sorted.map((h) => `${h.start}–${h.end}`).join('、')} 营业{breakText ? `；${breakText}` : ''}</p>}
        <p className="text-xs text-gray-400">高峰时段（备餐更慢的那几段）在「同城配送设置」里；休业在同城配送设置右上角「暂停 / 休业」。</p>
      </section>
      <div className="flex justify-end">
        {hasErr && <span className="text-xs text-red-600 self-center mr-2">营业时段有错误，请先改正</span>}
        <Button loading={saving} disabled={hasErr} onClick={() => void save()}>{saving ? '保存中...' : '保存'}</Button>
      </div>
    </div>
  )
}
