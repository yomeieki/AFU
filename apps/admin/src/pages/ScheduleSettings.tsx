import { useEffect, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { getLocalSettings, updateLocalSettings } from '../api/admin'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/Toast'
import type { LocalDeliverySettings, ScheduleSettings as Sched } from '../types'
import { useUnsavedSettings } from '../components/UnsavedSettings'
import { fmtHHmm, todayKey } from '../utils/time'

const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
    {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
  </div>
)

/**
 * 示例钟点——**与服务端 services/delivery/schedule.ts 的 scheduleTimeline 同一套公式**，改这里必须同时改那边。
 * 3 km 的单、约 12:00 送达（用上海日历的今天 12:00）：呼叫 = 送达 − 路上 − 呼叫到取走；开始备餐 = 呼叫 − 备餐；
 * 出票 = 开始备餐 − 提前量；接单截止 = 开始备餐 − 缓冲；自助取消截止 = 送达 − selfCancelLeadMin。
 *
 * 只用「上海今天 12:00」这个演示锚点，不能用 `setHours`（本地时区 API，scripts/check-admin-timezone.mjs 会拦）——
 * 用 `todayKey()` 取上海日历的今天日期，拼上明确的 +08:00 偏移得到瞬时值。
 */
function example(s: LocalDeliverySettings, sc: Sched, selfCancelLeadMin: number) {
  const noon = new Date(`${todayKey(new Date())}T12:00:00+08:00`)
  const ride = Math.round((3 / s.riderSpeedKmh) * 60)
  const t = noon.getTime()
  const callAt = t - (ride + s.callToPickupMin) * 60_000
  const prepStartAt = callAt - sc.prepMinutes * 60_000
  return {
    ticket: fmtHHmm(prepStartAt - sc.prepTicketLeadMin * 60_000),
    acceptDue: fmtHHmm(prepStartAt - sc.acceptBufferMin * 60_000),
    prepStart: fmtHHmm(prepStartAt),
    call: fmtHHmm(callAt),
    selfCancel: fmtHHmm(t - selfCancelLeadMin * 60_000),
    ride,
  }
}

export default function ScheduleSettings() {
  const { setDirty } = useUnsavedSettings()
  const [s, setS] = useState<LocalDeliverySettings | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  const hydrate = (v: LocalDeliverySettings) => { setS(v); setDirty(false) }
  useEffect(() => {
    getLocalSettings().then(hydrate).catch(() => { setLoadFailed(true); toast.error('预约设置加载失败，请刷新重试') })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  if (loadFailed) return <div className="text-red-600">预约设置加载失败，请刷新页面重试。</div>
  if (!s) return <div className="text-gray-500">加载中...</div>

  const sc = s.schedule
  const patch = (x: Partial<Sched>) => setS({ ...s, schedule: { ...sc, ...x } })
  const ex = example(s, sc, s.selfCancelLeadMin)
  const formError = sc.enabled && s.businessHours.length === 0 ? '开通预约配送须先在「营业时间」页设置营业时段' : ''

  const save = async () => {
    if (formError) { toast.error(formError); return }
    setSaving(true)
    try {
      let fresh: LocalDeliverySettings
      try { fresh = await getLocalSettings() } catch { toast.error('读取最新设置失败，本次未保存，请刷新后重试'); return }
      const next = await updateLocalSettings({ ...fresh, schedule: sc, selfCancelLeadMin: s.selfCancelLeadMin })
      hydrate(next)
      toast.success('已保存，新参数对已付款的预约单也立即生效（倒推时刻按当时设置重算）')
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败')
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4 max-w-3xl" onChangeCapture={() => setDirty(true)}>
      <h3 className="text-lg font-semibold text-gray-800">预约送达设置</h3>
      {!sc.enabled && <div className="rounded-md bg-gray-50 border border-gray-200 p-3 text-sm text-gray-600">预约送达未开通，顾客结算页只有「尽快送达」。开通前请确认工作台已升级到带「预约单」组的版本（否则出票前的预约单在工作台上看不见）。</div>}

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800 flex items-center gap-1"><CalendarClock className="w-4 h-4" />预约送达</h3>
        <p className="text-xs text-gray-500">
          预约单从顾客选的送达时段倒推：呼叫 = 送达 − 路上 − 呼叫到取走；开始备餐 = 呼叫 − 备餐；备餐票 = 开始备餐 − 提前量；接单截止 = 开始备餐 − 缓冲。店员点「已备好」后系统到点自动呼叫；「立即呼叫」可跳过等待。
        </p>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={sc.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          开通预约送达
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="时段粒度（分）" hint="顾客按格选送达时间，如 30 = 12:00–12:30">
            <select className={inputCls} value={sc.slotMinutes} onChange={(e) => patch({ slotMinutes: Number(e.target.value) })}>
              {[15, 20, 30, 60].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="可预约">
            <select className={inputCls} value={sc.daysAhead} onChange={(e) => patch({ daysAhead: Number(e.target.value) })}>
              <option value={0}>仅今天</option><option value={1}>今天和明天</option><option value={2}>三天内</option><option value={3}>四天内</option>
            </select>
          </Field>
          <Field label="接单缓冲（分）" hint="接单截止 = 开始备餐 − 它；到点未接单才催"><input className={inputCls} type="number" min={0} max={30} value={sc.acceptBufferMin} onChange={(e) => patch({ acceptBufferMin: Number(e.target.value) })} /></Field>
          <Field label="预约单备餐时长（分）" hint="与立即单分开；热菜怕冷可调短，高峰取与高峰上界的大者"><input className={inputCls} type="number" min={0} max={180} value={sc.prepMinutes} onChange={(e) => patch({ prepMinutes: Number(e.target.value) })} /></Field>
          <Field label="备餐票提前量（分）" hint="开始备餐前多久出备餐票并语音播报；0 = 到点才出"><input className={inputCls} type="number" min={0} max={60} value={sc.prepTicketLeadMin} onChange={(e) => patch({ prepTicketLeadMin: Number(e.target.value) })} /></Field>
          <Field label="催备好间隔（分）" hint="到该呼叫时刻仍未点「已备好」，每隔这么久出一张催促小条"><input className={inputCls} type="number" min={1} max={15} value={sc.readyRemindEveryMin} onChange={(e) => patch({ readyRemindEveryMin: Number(e.target.value) })} /></Field>
          <Field label="催备好上限（次）" hint="超过后停止小条并告警一次"><input className={inputCls} type="number" min={1} max={10} value={sc.readyRemindMaxTimes} onChange={(e) => patch({ readyRemindMaxTimes: Number(e.target.value) })} /></Field>
          <Field label="呼叫容忍窗口（分）" hint="早于「该呼叫 − 它」点呼叫要二次确认（立即呼叫）"><input className={inputCls} type="number" min={0} max={15} value={sc.callToleranceMin} onChange={(e) => patch({ callToleranceMin: Number(e.target.value) })} /></Field>
          <Field label="自助取消截止（分）" hint="自取与预约外送共用：约定时刻前这么多分钟内，顾客不能自助秒退，只能申请取消">
            <input className={inputCls} type="number" min={0} max={720} value={s.selfCancelLeadMin} onChange={(e) => setS({ ...s, selfCancelLeadMin: Number(e.target.value) })} /></Field>
        </div>
        <div className="rounded-md bg-gray-50 border border-gray-200 p-3">
          <p className="text-xs font-medium text-gray-600 mb-1.5">示例：3 km 的单约今天 12:00 送达（路上 {ex.ride} 分、呼叫到取走 {s.callToPickupMin} 分，按当前输入实时算）</p>
          <ul className="text-xs text-gray-600 space-y-1">
            <li>{ex.selfCancel} 顾客自助取消截止</li>
            <li>{ex.ticket} 出备餐票 · {ex.acceptDue} 接单截止 · <b>{ex.prepStart} 开始备餐</b> · <b>{ex.call} 呼叫骑手</b> · 12:00 送达</li>
          </ul>
        </div>
      </section>

      <div className="flex justify-end">
        {formError && <span className="text-xs text-red-600 self-center mr-2">{formError}</span>}
        <Button loading={saving} disabled={!!formError} onClick={() => void save()}>{saving ? '保存中...' : '保存'}</Button>
      </div>
    </div>
  )
}
