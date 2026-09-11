import { useEffect, useState } from 'react'
import { Store } from 'lucide-react'
import { getLocalSettings, updateLocalSettings } from '../api/admin'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/Toast'
import type { LocalDeliverySettings } from '../types'
import { useUnsavedSettings } from '../components/UnsavedSettings'
import { pauseActive } from '../utils/pause-scope'

const toYuan = (fen: number) => (fen / 100).toFixed(2)
function toFen(input: string): number | null {
  const v = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null
  const [yuan, dec = ''] = v.split('.')
  return Number(yuan) * 100 + Number(dec.padEnd(2, '0'))
}
const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
    {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
  </div>
)

type Pickup = LocalDeliverySettings['pickup']

/**
 * 到店自取设置（PO 2026-09-11：从同城配送设置里拆成独立页签）。
 * 存储仍是 local_delivery.pickup；本页只编辑这一节：保存前先取最新设置再整包写回，
 * 其余字段（坐标/营业时段/暂停/休业）原样带回，pickup.paused 也用服务端最新值。
 */
export default function PickupSettings() {
  const { setDirty } = useUnsavedSettings()
  const [p, setP] = useState<Pickup | null>(null)
  const [money, setMoney] = useState({ minOrder: '', fixed: '' })
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  const hydrate = (v: LocalDeliverySettings) => {
    setP(v.pickup)
    setMoney({ minOrder: toYuan(v.pickup.minOrderAmountFen), fixed: v.pickup.discount.type === 'FIXED' ? toYuan(v.pickup.discount.value) : '0.00' })
    setDirty(false)
  }
  useEffect(() => {
    getLocalSettings().then(hydrate).catch(() => { setLoadFailed(true); toast.error('自取设置加载失败，请刷新重试') })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  if (loadFailed) return <div className="text-red-600">自取设置加载失败，请刷新页面重试。</div>
  if (!p) return <div className="text-gray-500">加载中...</div>

  const patch = (x: Partial<Pickup>) => setP({ ...p, ...x })
  const formError = p.unpickedRemindAfterMin >= p.autoCompleteAfterMin ? '「过时未取提醒」须早于「超时自动完成」' : ''

  const save = async () => {
    const minOrder = toFen(money.minOrder), fixed = toFen(money.fixed)
    if (minOrder === null || fixed === null) { toast.error('金额格式不正确（最多两位小数）'); return }
    if (formError) { toast.error(formError); return }
    setSaving(true)
    try {
      let fresh: LocalDeliverySettings
      try { fresh = await getLocalSettings() } catch { toast.error('读取最新设置失败，本次未保存，请刷新后重试'); return }
      const next = await updateLocalSettings({
        ...fresh,
        pickup: {
          ...p,
          paused: fresh.pickup.paused,
          minOrderAmountFen: minOrder,
          discount: p.discount.type === 'FIXED' ? { type: 'FIXED', value: fixed } : p.discount,
        },
      })
      hydrate(next)
      toast.success('已保存，顾客端自取入口即刻按新设置')
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败')
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4 max-w-3xl" onChangeCapture={() => setDirty(true)}>
      <h3 className="text-lg font-semibold text-gray-800">到店自取设置</h3>
      {pauseActive(p.paused) && (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
          自取已暂停：{p.paused?.reason || '手动暂停'}——在「同城配送设置」右上角「暂停 / 休业」或工作台顶栏里恢复。
        </div>
      )}
      {!p.enabled && <div className="rounded-md bg-gray-50 border border-gray-200 p-3 text-sm text-gray-600">到店自取未开通，顾客端不显示「自取」。开通前请先在「同城配送设置」填好门店电话、地址，在「营业时间」页填好时段。</div>}

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800 flex items-center gap-1"><Store className="w-4 h-4" />到店自取</h3>
        <p className="text-xs text-gray-500">
          自取与外送共用菜单和营业时间；运费为 0，可另设自取优惠与起送门槛。休业会同时停外送与自取，邮寄不受影响。
        </p>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={p.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          开通到店自取（开通需已填门店电话、地址与营业时段）
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="取餐时段粒度（分）" hint="顾客按格选时间，如 30 = 12:00–12:30">
            <select className={inputCls} value={p.slotMinutes} onChange={(e) => patch({ slotMinutes: Number(e.target.value) })}>
              {[15, 20, 30, 60].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="接单缓冲（分）" hint="最早可取 = 现在 + 缓冲 + 备餐时长，向上取整到粒度">
            <input className={inputCls} type="number" min={0} max={60} value={p.acceptBufferMin} onChange={(e) => patch({ acceptBufferMin: Number(e.target.value) })} /></Field>
          <Field label="可预订">
            <select className={inputCls} value={p.daysAhead} onChange={(e) => patch({ daysAhead: Number(e.target.value) })}>
              <option value={0}>仅今天</option><option value={1}>今天和明天</option>
            </select>
          </Field>
          <Field label="自取起送金额（元）" hint="0 = 无门槛；与外送起送分开设">
            <input className={inputCls} inputMode="decimal" value={money.minOrder} onChange={(e) => setMoney({ ...money, minOrder: e.target.value })} /></Field>
          <Field label="自取优惠" hint="先扣自取优惠再算券；券门槛看原小计，券面额封顶到小计−自取优惠">
            <select className={inputCls} value={p.discount.type}
              onChange={(e) => {
                const type = e.target.value as 'NONE' | 'PERCENT' | 'FIXED'
                patch({ discount: type === 'PERCENT' ? { type, value: p.discount.type === 'PERCENT' ? p.discount.value : 90 } : type === 'FIXED' ? { type, value: 0 } : { type: 'NONE', value: 0 } })
                // 离开 FIXED 时把隐藏字段清零：否则残留的半截小数会在保存时被「金额格式不正确」拦下，店主却看不出是哪个字段
                if (type !== 'FIXED') setMoney({ ...money, fixed: '0.00' })
              }}>
              <option value="NONE">不打折</option><option value="PERCENT">按折扣</option><option value="FIXED">立减固定金额</option>
            </select>
          </Field>
          {p.discount.type === 'PERCENT' && (
            <Field label="按几折收（%）" hint="90 = 九折（减 10%）；1–100">
              <input className={inputCls} type="number" min={1} max={100} value={p.discount.value}
                onChange={(e) => patch({ discount: { type: 'PERCENT', value: Number(e.target.value) } })} /></Field>
          )}
          {p.discount.type === 'FIXED' && (
            <Field label="立减（元）" hint="超过小计时按小计减">
              <input className={inputCls} inputMode="decimal" value={money.fixed} onChange={(e) => setMoney({ ...money, fixed: e.target.value })} /></Field>
          )}
          <Field label="过时未取提醒（分）" hint="取餐时间过后这么久推一次提醒给顾客与店员">
            <input className={inputCls} type="number" min={5} max={1440} value={p.unpickedRemindAfterMin} onChange={(e) => patch({ unpickedRemindAfterMin: Number(e.target.value) })} /></Field>
          <Field label="超时自动完成（分）" hint="取餐时间过后这么久仍未点「已取走」则自动完成；须大于上一项">
            <input className={inputCls} type="number" min={10} max={1440} value={p.autoCompleteAfterMin} onChange={(e) => patch({ autoCompleteAfterMin: Number(e.target.value) })} /></Field>
        </div>
      </section>

      <div className="flex justify-end">
        {formError && <span className="text-xs text-red-600 self-center mr-2">{formError}</span>}
        <Button loading={saving} disabled={!!formError} onClick={() => void save()}>{saving ? '保存中...' : '保存'}</Button>
      </div>
    </div>
  )
}
