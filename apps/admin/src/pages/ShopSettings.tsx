import { useEffect, useState } from 'react'
import { getShippingSettings, updateShippingSettings } from '../api/admin'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/Toast'

/** 分 → 元字符串（输入框用） */
const toYuan = (fen: number) => (fen / 100).toFixed(2)

/**
 * 元字符串 → 分。返回 null 表示格式非法。
 * 走字符串正则而不是 parseFloat*100：0.29*100 在浮点下是 28.999999999999996，
 * 直接取整会少收一分钱。
 */
function toFen(input: string): number | null {
  const v = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null
  const [yuan, dec = ''] = v.split('.')
  return Number(yuan) * 100 + Number(dec.padEnd(2, '0'))
}

interface FormState {
  fee: string
  freeThreshold: string
  minOrderAmount: string
}

export default function ShopSettings() {
  const [form, setForm] = useState<FormState>({ fee: '0.00', freeThreshold: '0.00', minOrderAmount: '0.00' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  // 加载失败时表单停留在 useState 的 0.00 默认值，保存按钮若仍可点，店主一键就把「全场包邮」写进库里。
  // 所以失败必须锁住保存并明说，范式同 LocalSettings。
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    getShippingSettings()
      .then((s) =>
        setForm({
          fee: toYuan(s.fee),
          freeThreshold: toYuan(s.freeThreshold),
          minOrderAmount: toYuan(s.minOrderAmount),
        })
      )
      .catch(() => { setLoadFailed(true); toast.error('运费规则加载失败，请刷新') })
      .finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    if (loadFailed) { toast.error('运费规则加载失败，请刷新后再保存'); return }
    const fee = toFen(form.fee)
    const freeThreshold = toFen(form.freeThreshold)
    const minOrderAmount = toFen(form.minOrderAmount)
    const next: Partial<Record<keyof FormState, string>> = {}
    if (fee === null) next.fee = '请填写金额，最多两位小数'
    if (freeThreshold === null) next.freeThreshold = '请填写金额，最多两位小数'
    if (minOrderAmount === null) next.minOrderAmount = '请填写金额，最多两位小数'
    setErrors(next)
    if (fee === null || freeThreshold === null || minOrderAmount === null) return

    setSaving(true)
    try {
      const saved = await updateShippingSettings({ fee, freeThreshold, minOrderAmount })
      setForm({
        fee: toYuan(saved.fee),
        freeThreshold: toYuan(saved.freeThreshold),
        minOrderAmount: toYuan(saved.minOrderAmount),
      })
      toast.success('已保存，新下单立即按新规则计费')
    } catch (e) {
      toast.error((e as Error).message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const field = (
    key: keyof FormState,
    label: string,
    hint: string,
    zeroMeans: string
  ) => (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">¥</span>
        <input
          inputMode="decimal"
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          className="w-full border border-gray-300 rounded-md pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
        />
      </div>
      <p className="mt-1 text-xs text-gray-500">{hint}</p>
      <p className="text-xs text-gray-400">填 0 = {zeroMeans}</p>
      {errors[key] && <p className="mt-1 text-xs text-red-600">{errors[key]}</p>}
    </div>
  )

  // 用当前表单值算一组例子，比读说明直观
  const feeFen = toFen(form.fee) ?? 0
  const thresholdFen = toFen(form.freeThreshold) ?? 0
  const minFen = toFen(form.minOrderAmount) ?? 0
  const example = (subtotalFen: number) => {
    if (minFen > 0 && subtotalFen < minFen) return '不满起送金额，无法下单'
    if (feeFen <= 0) return `运费 ¥0.00，实付 ¥${toYuan(subtotalFen)}`
    const ship = thresholdFen > 0 && subtotalFen >= thresholdFen ? 0 : feeFen
    return ship === 0
      ? `满额包邮，实付 ¥${toYuan(subtotalFen)}`
      : `运费 ¥${toYuan(ship)}，实付 ¥${toYuan(subtotalFen + ship)}`
  }

  if (loading) return <div className="text-gray-500">加载中...</div>

  return (
    <div className="space-y-4 max-w-2xl">
      <h2 className="text-xl font-semibold text-gray-800">店铺设置</h2>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
        <div>
          <h3 className="font-medium text-gray-800">运费规则</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            包邮门槛与起送金额都按<strong>商品小计</strong>判断（不含运费）。改动立即对新下单生效，已下单的订单不受影响。
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {field('fee', '运费', '每单收取的固定运费', '全场包邮')}
          {field('freeThreshold', '满额包邮', '商品小计达到该金额免运费', '不设包邮门槛')}
          {field('minOrderAmount', '起送金额', '商品小计低于该金额不能下单', '无起送门槛')}
        </div>

        <div className="rounded-md bg-gray-50 border border-gray-200 p-3">
          <p className="text-xs font-medium text-gray-600 mb-1.5">按当前填写的值试算</p>
          <ul className="text-xs text-gray-600 space-y-1">
            <li>买 ¥30 商品 → {example(3000)}</li>
            <li>买 ¥80 商品 → {example(8000)}</li>
            <li>买 ¥150 商品 → {example(15000)}</li>
          </ul>
        </div>

        {loadFailed && (
          <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
            运费规则加载失败，上面显示的不是当前生效的值，请刷新页面后再修改。
          </div>
        )}
        <div className="flex justify-end">
          <Button loading={saving} disabled={loadFailed} onClick={handleSave}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}
