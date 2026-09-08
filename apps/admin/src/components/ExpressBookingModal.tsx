/** 邮寄「预约取件」弹窗：各家报价（最便宜默认选中、标注与顾客付款的差价）、重量可改、时段手选（预填最近可约）、备注。 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import '../pages/Workbench.css'
import { bookExpress, getExpressBookingQuotes } from '../api/admin'
import type { ExpressBookingQuotes } from '../types'

const yuan = (fen: number) => (fen / 100).toFixed(2)
const apiMessage = (e: unknown, fallback: string) => (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback
export const DAYS = ['今天', '明天', '后天'] as const
type Day = (typeof DAYS)[number]
export const HOURS = Array.from({ length: 12 }, (_, i) => `${String(9 + i).padStart(2, '0')}:00`)   // 09:00–20:00
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
/** 与服务端 validateSlot 同规则（服务端仍会再校验一次） */
export function slotError(day: Day, start: string, end: string, kuaidicom: string, nowMin: number): string {
  if (!start && !end) return kuaidicom === 'shunfeng' ? '顺丰必须填写取件时段' : ''
  if (!start || !end) return '起止时间要一起填'
  if (toMin(end) - toMin(start) < 60) return '取件时段至少 1 小时'
  if (day === '今天' && nowMin >= toMin(end) - 120) return '今天的时段须在结束前 2 小时预约，请改晚一点或约明天'
  return ''
}
const shanghaiNowMin = () => { const d = new Date(Date.now() + 8 * 3600 * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes() }

export default function ExpressBookingModal({ orderId, defaultRemark, onClose, onDone }: { orderId: number; defaultRemark: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [q, setQ] = useState<ExpressBookingQuotes | null>(null)
  const [loading, setLoading] = useState(true)
  const [weight, setWeight] = useState('')
  const [kuaidicom, setKuaidicom] = useState('')
  const [day, setDay] = useState<Day>('今天')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [remark, setRemark] = useState(defaultRemark)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (w?: number) => {
    setLoading(true); setError('')
    try {
      const r = (await getExpressBookingQuotes(orderId, w)).data.data
      setQ(r)
      setWeight(String(r.weightKg))
      if (!kuaidicom) {
        const cheapest = [...r.quotes].filter((x) => x.priceFen !== null).sort((a, b) => a.priceFen! - b.priceFen!)[0]
        setKuaidicom(cheapest?.kuaidicom ?? '')
        setDay(r.suggestedSlot.dayType); setStart(r.suggestedSlot.pickupStart ?? ''); setEnd(r.suggestedSlot.pickupEnd ?? '')
      }
    } catch (e) { setError(apiMessage(e, '报价加载失败')) } finally { setLoading(false) }
  }, [orderId, kuaidicom])
  useEffect(() => { void load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    if (!q) return []
    const label = new Map(q.couriers.map((c) => [c.code, c.label]))
    return [...q.quotes].sort((a, b) => (a.priceFen ?? 1e9) - (b.priceFen ?? 1e9)).map((x) => ({ ...x, label: label.get(x.kuaidicom) ?? x.kuaidicom }))
  }, [q])
  const cheapest = rows.find((r) => r.priceFen !== null)?.kuaidicom
  const chosen = rows.find((r) => r.kuaidicom === kuaidicom)
  const err = slotError(day, start, end, kuaidicom, shanghaiNowMin())
  const canSubmit = !!q && !!kuaidicom && !err && !busy && !loading

  const onWeightBlur = () => { const w = Number(weight); if (Number.isFinite(w) && w >= 0.1 && w <= 50 && q && w !== q.weightKg) void load(Math.round(w * 10) / 10) }
  const submit = async () => {
    if (!canSubmit) return
    setBusy(true); setError('')
    try {
      const r = (await bookExpress(orderId, { kuaidicom, serviceType: chosen?.serviceType ?? null, weightKg: Number(weight), dayType: day, pickupStart: start || null, pickupEnd: end || null, remark })).data.data
      onDone(r.status === 'UNKNOWN' ? '快递100 未及时响应，预约状态待核对（系统会自动查单）' : `已预约 ${chosen?.label ?? kuaidicom}${r.kuaidinum ? ` · 单号 ${r.kuaidinum}` : ''}`)
    } catch (e) { setError(apiMessage(e, '预约失败，请重试')) } finally { setBusy(false) }
  }

  return (
    <div className="wb__modal-mask" onClick={onClose}>
      <div className="wb__modal" onClick={(e) => e.stopPropagation()}>
        <div className="wb__modal-head"><span>预约快递员上门取件</span><button className="wb__icon-btn" onClick={onClose} aria-label="关闭">×</button></div>
        <div className="wb__modal-body">
          {q && <div className="wb__line"><span>顾客付</span><strong>¥{yuan(q.customerFeeFen)}</strong><span className="wb__muted">{q.fromSnapshot ? '报价来自下单快照' : '刚查的价'}</span></div>}
          <label className="wb__field"><span>重量（kg）</span><input className="wb__input" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} onBlur={onWeightBlur} /></label>
          <div className="wb__quote-list" role="radiogroup" aria-label="选择快递">
            {loading && <div className="wb__muted">查价中…</div>}
            {!loading && rows.map((r) => {
              const disabled = r.priceFen === null
              const diff = q && r.priceFen !== null ? r.priceFen - q.customerFeeFen : null
              return (
                <button key={r.kuaidicom} type="button" role="radio" aria-checked={kuaidicom === r.kuaidicom} disabled={disabled}
                  className={`wb__quote-row ${kuaidicom === r.kuaidicom ? 'is-on' : ''} ${disabled ? 'is-off' : ''}`} onClick={() => setKuaidicom(r.kuaidicom)}>
                  <span>{r.label}{r.serviceType ? ` · ${r.serviceType}` : ''}{r.kuaidicom === cheapest ? <em className="wb__tag">最低</em> : null}</span>
                  <span>{disabled ? '无价' : `¥${yuan(r.priceFen!)}`}{diff !== null && <small className={diff > 0 ? 'wb__neg' : 'wb__pos'}>{diff > 0 ? `比顾客付的多 ¥${yuan(diff)}` : diff < 0 ? `少 ¥${yuan(-diff)}` : '与顾客付的相同'}</small>}</span>
                </button>
              )
            })}
          </div>
          <div className="wb__row">
            <select className="wb__select" value={day} onChange={(e) => setDay(e.target.value as Day)}>{DAYS.map((d) => <option key={d} value={d}>{d}</option>)}</select>
            <select className="wb__select" value={start} onChange={(e) => setStart(e.target.value)}><option value="">不限</option>{HOURS.map((h) => <option key={h} value={h}>{h}</option>)}</select>
            <span>–</span>
            <select className="wb__select" value={end} onChange={(e) => setEnd(e.target.value)}><option value="">不限</option>{HOURS.map((h) => <option key={h} value={h}>{h}</option>)}</select>
          </div>
          {err && <div className="wb__error">{err}</div>}
          <label className="wb__field"><span>备注</span><input className="wb__input" maxLength={50} value={remark} onChange={(e) => setRemark(e.target.value)} /></label>
          <p className="wb__muted">向快递100 下单，预扣{chosen?.priceFen != null ? ` ¥${yuan(chosen.priceFen)}` : '所选家报价'}，快递员上门后按实际重量多退少补。快递员上门前取消不收费；取件后取消要联系快递公司。货物名固定「食品」。</p>
          {error && <div className="wb__error">{error}</div>}
        </div>
        <div className="wb__modal-foot">
          <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>再想想</button>
          <button className="wb__btn wb__btn--fill" style={{ background: 'var(--express)' }} onClick={submit} disabled={!canSubmit}>{busy ? '预约中…' : '确认预约'}</button>
        </div>
      </div>
    </div>
  )
}
