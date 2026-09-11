import { useState } from 'react'
import Modal from './ui/Modal'
import Button from './ui/Button'
import { applyPauseScope, resumeLocal, resumePickup, clearHoliday } from '../api/admin'
import { PAUSE_SCOPES, validatePauseInput, pauseStateLines, type PauseScope, type PauseState } from '../utils/pause-scope'
import { todayKey } from '../utils/time'

const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const apiMessage = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback

/** 「暂停接单」四选一 + 当前状态逐项恢复（spec 2026-09-11 §6.1，P12）。设置页用；工作台有同逻辑的深色版 */
export default function PauseScopeDialog({ state, onClose, onDone }: {
  state: PauseState; onClose: () => void; onDone: (msg: string) => void
}) {
  const [scope, setScope] = useState<PauseScope>('DELIVERY')
  const [reason, setReason] = useState('临时暂停接单')
  const [until, setUntil] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lines = pauseStateLines(state)

  const pick = (s: PauseScope) => {
    setScope(s)
    setReason(s === 'HOLIDAY' ? '节假日休业' : '临时暂停接单')
    setError('')
  }
  const submit = async () => {
    const err = validatePauseInput(scope, { reason, until }, todayKey())
    if (err) { setError(err); return }
    setBusy(true); setError('')
    try {
      await applyPauseScope(scope, { reason, until })
      onDone(scope === 'HOLIDAY' ? `已休业至 ${until}` : scope === 'DELIVERY' ? '已暂停外送' : scope === 'PICKUP' ? '已暂停自取' : '已暂停外送与自取，今天 24:00 自动恢复')
    } catch (e) { setError(apiMessage(e, '操作失败，请重试')) }
    finally { setBusy(false) }
  }
  const resume = async (key: 'HOLIDAY' | 'DELIVERY' | 'PICKUP') => {
    setBusy(true); setError('')
    try {
      if (key === 'HOLIDAY') await clearHoliday()
      else if (key === 'DELIVERY') await resumeLocal()
      else await resumePickup()
      onDone(key === 'HOLIDAY' ? '已结束休业' : key === 'DELIVERY' ? '已恢复外送' : '已恢复自取')
    } catch (e) { setError(apiMessage(e, '恢复失败，请重试')) }
    finally { setBusy(false) }
  }

  return (
    <Modal title="暂停接单 / 休业" onClose={onClose} closeOnOverlay={!busy}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>关闭</Button>
        <Button variant="danger" loading={busy} onClick={() => void submit()}>{PAUSE_SCOPES.find((s) => s.key === scope)!.label}</Button>
      </>}>
      <div className="space-y-4">
        {lines.length > 0 && (
          <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 space-y-2">
            {lines.map((l) => (
              <div key={l.key} className="flex items-center justify-between gap-2">
                <span>{l.text}</span>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void resume(l.key)}>
                  {l.key === 'HOLIDAY' ? '结束休业' : l.key === 'DELIVERY' ? '恢复外送' : '恢复自取'}
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-2">
          {PAUSE_SCOPES.map((s) => (
            <label key={s.key} className={`flex gap-2 items-start rounded-md border p-2 cursor-pointer ${scope === s.key ? 'border-brand-400 bg-brand-50' : 'border-gray-200'}`}>
              <input type="radio" name="pause-scope" className="mt-1" checked={scope === s.key} onChange={() => pick(s.key)} disabled={busy} />
              <span>
                <span className="block text-sm font-medium text-gray-800">{s.label}</span>
                <span className="block text-xs text-gray-500">{s.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {scope === 'HOLIDAY' && (
          <label className="block text-sm">
            <span className="block text-gray-700 mb-1">恢复营业日期（含当天仍休业）</span>
            <input type="date" className={inputCls} value={until} min={todayKey()} onChange={(e) => setUntil(e.target.value)} disabled={busy} />
          </label>
        )}
        <label className="block text-sm">
          <span className="block text-gray-700 mb-1">原因（顾客可见）</span>
          <input className={inputCls} value={reason} maxLength={60} onChange={(e) => setReason(e.target.value)} disabled={busy} />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  )
}
