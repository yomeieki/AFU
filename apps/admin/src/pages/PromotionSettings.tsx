import { useEffect, useState } from 'react'
import { Percent, Plus, Trash2 } from 'lucide-react'
import { getLocalSettings, updateLocalSettings } from '../api/admin'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/Toast'
import type { LocalDeliverySettings, PromotionSettings as PromotionSettingsType, PromotionTier } from '../types'
import { useUnsavedSettings } from '../components/UnsavedSettings'
import { fmtDate, fmtHHmm } from '../utils/time'

// 与 PickupSettings.tsx 同款：不抽公共文件，两页各自维护一份（2026-09-17 全店满减设计执行计划要求）。
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

/** 到店自取当前折扣文案，与服务端 publicLocalMeta 的 pickup.discountText 同规则（纯字符串拼接，不复用服务端代码） */
function pickupDiscountText(discount: LocalDeliverySettings['pickup']['discount']): string {
  if (discount.type === 'PERCENT' && discount.value < 100) return `${(discount.value / 10).toFixed(1).replace(/\.0$/, '')} 折`
  if (discount.type === 'FIXED' && discount.value > 0) return `立减 ¥${(discount.value / 100).toFixed(2)}`
  return '未设优惠'
}

/** ISO 字符串 → { date: 'YYYY-MM-DD', time: 'HH:mm' }；null/空 → 两栏都空 */
function splitIso(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  return { date: fmtDate(iso, ''), time: fmtHHmm(iso, '') }
}
/** date+time 两栏拼回 ISO；纯字符串拼接，不经过 Date（check-admin-timezone.mjs 只放行 utils/time.ts 里的本地时区 API） */
function joinIso(date: string, time: string): string | null {
  if (!date || !time) return null
  return `${date}T${time}:00+08:00`
}

type TierRow = { minYuan: string; cutYuan: string }
const tiersToRows = (tiers: PromotionTier[]): TierRow[] => tiers.map((t) => ({ minYuan: toYuan(t.minFen), cutYuan: toYuan(t.cutFen) }))

/**
 * 全店自动满减设置（2026-09-17 设计）。存储在 local_delivery.promotion，走既有
 * `getLocalSettings → 展开 → updateLocalSettings` 的整包保存——放「店铺设置」而不是
 * 「会员营销」：`useUnsavedSettings()` 只在 SettingsCenter 的 Provider 里可用，配置本体
 * 也在 local_delivery 里（本批实施计划裁定，见「spec 与现状差异④」）。
 */
export default function PromotionSettings() {
  const { setDirty } = useUnsavedSettings()
  const [p, setP] = useState<PromotionSettingsType | null>(null)
  const [pickupDiscount, setPickupDiscount] = useState<LocalDeliverySettings['pickup']['discount'] | null>(null)
  const [startAt, setStartAt] = useState({ date: '', time: '' })
  const [endAt, setEndAt] = useState({ date: '', time: '' })
  const [rows, setRows] = useState<TierRow[]>([])
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  const hydrate = (v: LocalDeliverySettings) => {
    setP(v.promotion)
    setPickupDiscount(v.pickup.discount)
    setStartAt(splitIso(v.promotion.startAt))
    setEndAt(splitIso(v.promotion.endAt))
    setRows(tiersToRows(v.promotion.tiers))
    setDirty(false)
  }
  useEffect(() => {
    getLocalSettings().then(hydrate).catch(() => { setLoadFailed(true); toast.error('满减活动设置加载失败，请刷新重试') })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  if (loadFailed) return <div className="text-red-600">满减活动设置加载失败，请刷新页面重试。</div>
  if (!p || !pickupDiscount) return <div className="text-gray-500">加载中...</div>

  const patch = (x: Partial<PromotionSettingsType>) => setP({ ...p, ...x })
  const patchChannel = (key: keyof PromotionSettingsType['channels'], v: boolean) => patch({ channels: { ...p.channels, [key]: v } })

  // 逐行校验：格式（金额）、亏本（cut>=min）、门槛重复。全部通过才允许保存，
  // 与服务端 validateLocalSettings 的规则一致，前端先拦一遍减少一次往返。
  const rowErrors: (string | null)[] = rows.map((r, i) => {
    const min = toFen(r.minYuan), cut = toFen(r.cutYuan)
    if (min === null || cut === null) return '金额格式不正确（最多两位小数）'
    if (cut >= min) return '减的比门槛还多，这样配会亏本'
    if (rows.some((other, j) => j !== i && toFen(other.minYuan) === min)) return '门槛重复'
    return null
  })
  const formError =
    rowErrors.some((e) => e !== null) ? '请先修正档位里标红的行'
    : p.enabled && rows.length === 0 ? '启用满减至少要配一档'
    : p.name.trim().length === 0 ? '活动名称不能为空'
    : startAt.date && !startAt.time ? '请补全开始时间的时刻'
    : endAt.date && !endAt.time ? '请补全结束时间的时刻'
    : ''

  const addRow = () => { if (rows.length < 10) setRows([...rows, { minYuan: '', cutYuan: '' }]) }
  const removeRow = (i: number) => setRows(rows.filter((_, j) => j !== i))
  const patchRow = (i: number, x: Partial<TierRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...x } : r)))

  const save = async () => {
    if (formError) { toast.error(formError); return }
    const tiers: PromotionTier[] = rows.map((r) => ({ minFen: toFen(r.minYuan)!, cutFen: toFen(r.cutYuan)! }))
    setSaving(true)
    try {
      let fresh: LocalDeliverySettings
      try { fresh = await getLocalSettings() } catch { toast.error('读取最新设置失败，本次未保存，请刷新后重试'); return }
      const next = await updateLocalSettings({
        ...fresh,
        promotion: {
          ...p,
          startAt: joinIso(startAt.date, startAt.time),
          endAt: joinIso(endAt.date, endAt.time),
          tiers,
        },
      })
      hydrate(next)
      toast.success('已保存，即刻生效（活动到期后自动停止）')
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败')
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4 max-w-3xl" onChangeCapture={() => setDirty(true)}>
      <h3 className="text-lg font-semibold text-gray-800">满减活动</h3>
      <p className="text-xs text-gray-500">
        顾客下单达标自动减，不用领券；与优惠券可叠加，先算满减再用券抵扣剩下的金额；运费与打包费不参与满减；
        起送门槛与免运费门槛按减前的商品小计判断。
      </p>
      {!p.enabled && (
        <div className="rounded-md bg-gray-50 border border-gray-200 p-3 text-sm text-gray-600">
          满减未启用，顾客端不显示活动。
        </div>
      )}

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800 flex items-center gap-1"><Percent className="w-4 h-4" />基本设置</h3>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={p.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          启用满减
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="活动名称" hint="1–20 字，顾客端活动条显示这个名字">
            <input className={inputCls} maxLength={20} value={p.name} onChange={(e) => patch({ name: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="开始时间" hint="留空 = 立即生效">
            <div className="flex gap-2">
              <input className={inputCls} type="date" value={startAt.date} onChange={(e) => setStartAt({ ...startAt, date: e.target.value })} />
              <input className={inputCls} type="time" value={startAt.time} onChange={(e) => setStartAt({ ...startAt, time: e.target.value })} />
              <Button variant="secondary" onClick={() => setStartAt({ date: '', time: '' })}>清空</Button>
            </div>
          </Field>
          <Field label="结束时间" hint="留空 = 长期有效">
            <div className="flex gap-2">
              <input className={inputCls} type="date" value={endAt.date} onChange={(e) => setEndAt({ ...endAt, date: e.target.value })} />
              <input className={inputCls} type="time" value={endAt.time} onChange={(e) => setEndAt({ ...endAt, time: e.target.value })} />
              <Button variant="secondary" onClick={() => setEndAt({ date: '', time: '' })}>清空</Button>
            </div>
          </Field>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">生效渠道</h3>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={p.channels.LOCAL} onChange={(e) => patchChannel('LOCAL', e.target.checked)} />
          同城外送
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={p.channels.PICKUP} onChange={(e) => patchChannel('PICKUP', e.target.checked)} />
          到店自取
          <span className="text-xs text-gray-500">（自取已有{pickupDiscountText(pickupDiscount)}，勾选后两者叠加，请重算利润）</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={p.channels.EXPRESS} onChange={(e) => patchChannel('EXPRESS', e.target.checked)} />
          全国邮寄
        </label>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">档位</h3>
        <p className="text-xs text-gray-500">命中时只按满足条件里减得最多的一档减，不叠加多档；最多 10 档。</p>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-sm text-gray-600">满 ¥</span>
              <input className={`${inputCls} w-28`} inputMode="decimal" value={r.minYuan} onChange={(e) => patchRow(i, { minYuan: e.target.value })} />
              <span className="text-sm text-gray-600">减 ¥</span>
              <input className={`${inputCls} w-28`} inputMode="decimal" value={r.cutYuan} onChange={(e) => patchRow(i, { cutYuan: e.target.value })} />
              <button type="button" className="text-gray-400 hover:text-red-500" onClick={() => removeRow(i)} aria-label="删除档位">
                <Trash2 className="w-4 h-4" />
              </button>
              {rowErrors[i] && <span className="text-xs text-red-600">{rowErrors[i]}</span>}
            </div>
          ))}
          <Button variant="secondary" disabled={rows.length >= 10} onClick={addRow}>
            <Plus className="w-4 h-4 mr-1" />添加一档{rows.length >= 10 ? '（最多 10 档）' : ''}
          </Button>
        </div>
      </section>

      <div className="flex justify-end">
        {formError && <span className="text-xs text-red-600 self-center mr-2">{formError}</span>}
        <Button loading={saving} disabled={!!formError} onClick={() => void save()}>{saving ? '保存中...' : '保存'}</Button>
      </div>
    </div>
  )
}
