import { useEffect, useState } from 'react'
import { MapPin, PauseCircle, PlayCircle } from 'lucide-react'
import { getLocalSettings, updateLocalSettings, pauseLocal, resumeLocal } from '../api/admin'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/Toast'
import { confirmDialog } from '../components/ui/ConfirmDialog'
import type { LocalDeliverySettings } from '../types'

const toYuan = (fen: number) => (fen / 100).toFixed(2)
function toFen(input: string): number | null {
  const v = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null
  const [yuan, dec = ''] = v.split('.')
  return Number(yuan) * 100 + Number(dec.padEnd(2, '0'))
}
// 自贡市大致范围：纬度 28.9–29.9，经度 104.0–105.3（防经纬度填反 / 抄错坐标系）
const inZigong = (latE6: number, lngE6: number) => latE6 >= 28_900_000 && latE6 <= 29_900_000 && lngE6 >= 104_000_000 && lngE6 <= 105_300_000

const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
    {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
  </div>
)

export default function LocalSettings() {
  const [s, setS] = useState<LocalDeliverySettings | null>(null)
  const [money, setMoney] = useState({ baseFee: '', perKmFee: '', freeThreshold: '', minOrderAmount: '', maxPerCall: '', maxPerOrder: '' })
  const [coord, setCoord] = useState({ lat: '', lng: '' })
  // 门店坐标另有一条写入路径（小程序商家端一键定位 → PATCH store-location），而本页的保存是整包
  // 覆盖式 PUT、服务端没有乐观锁。店主按本页指引去店门口定完位、回到这个还开着的标签页改别的参数
  // 再保存，若把页面加载时缓存的旧坐标一起写回，新坐标就被静默改掉了。
  // 所以只有店主真的动过这两个输入框才发送手填值，否则保存前先取服务端最新坐标合并。
  const [coordDirty, setCoordDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const hydrate = (v: LocalDeliverySettings) => {
    setS(v)
    setMoney({
      baseFee: toYuan(v.fee.baseFee), perKmFee: toYuan(v.fee.perKmFee), freeThreshold: toYuan(v.fee.freeThreshold),
      minOrderAmount: toYuan(v.fee.minOrderAmount), maxPerCall: toYuan(v.tip.maxPerCall), maxPerOrder: toYuan(v.tip.maxPerOrder),
    })
    setCoord({ lat: v.store.latE6 === null ? '' : (v.store.latE6 / 1e6).toFixed(6), lng: v.store.lngE6 === null ? '' : (v.store.lngE6 / 1e6).toFixed(6) })
    setCoordDirty(false)
  }
  const editCoord = (p: Partial<typeof coord>) => { setCoord({ ...coord, ...p }); setCoordDirty(true) }
  const [loadFailed, setLoadFailed] = useState(false)
  // 没有 catch 的话接口一挂，页面就永远停在「加载中...」，店主只会以为后台坏了。
  useEffect(() => {
    getLocalSettings()
      .then(hydrate)
      .catch(() => { setLoadFailed(true); toast.error('同城设置加载失败，请刷新重试') })
  }, [])

  if (loadFailed) return <div className="text-red-600">同城设置加载失败，请刷新页面重试。</div>

  if (!s) return <div className="text-gray-500">加载中...</div>

  const patch = (p: Partial<LocalDeliverySettings>) => setS({ ...s, ...p })
  const patchStore = (p: Partial<LocalDeliverySettings['store']>) => setS({ ...s, store: { ...s.store, ...p } })

  const handleSave = async (enabledOverride?: boolean) => {
    const fen = Object.fromEntries(Object.entries(money).map(([k, v]) => [k, toFen(v)])) as Record<keyof typeof money, number | null>
    if (Object.values(fen).some((v) => v === null)) { toast.error('金额格式不正确（最多两位小数）'); return }
    // 手填坐标只在店主动过输入框时才算数；没动过就在下面用服务端最新值
    let typedLatE6: number | null = null, typedLngE6: number | null = null
    if (coordDirty && (coord.lat.trim() || coord.lng.trim())) {
      if (!coord.lat.trim() || !coord.lng.trim()) { toast.error('请同时填写纬度和经度'); return }
      const lat = Number(coord.lat), lng = Number(coord.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) { toast.error('坐标格式不正确'); return }
      typedLatE6 = Math.round(lat * 1e6); typedLngE6 = Math.round(lng * 1e6)
      if (!inZigong(typedLatE6, typedLngE6)) {
        const ok = await confirmDialog({ title: '坐标看起来不在自贡附近', content: '请确认没有把经纬度顺序填反、且使用的是腾讯/高德坐标。仍要保存？', danger: true })
        if (!ok) return
      }
    }
    setSaving(true)
    try {
      // 服务端 PUT 是整包覆盖（缺 latE6/lngE6 会被置空），所以不能省掉这两个字段，
      // 只能保存前先取一次最新设置，把别的路径写进去的坐标（以及暂停状态）合并进来再写回
      let fresh: LocalDeliverySettings
      try {
        fresh = await getLocalSettings()
      } catch {
        toast.error('读取最新设置失败，本次未保存，请刷新后重试')
        return
      }
      const latE6 = coordDirty ? typedLatE6 : fresh.store.latE6
      const lngE6 = coordDirty ? typedLngE6 : fresh.store.lngE6
      const payload: LocalDeliverySettings = {
        ...s,
        version: fresh.version,
        paused: fresh.paused,
        enabled: enabledOverride ?? s.enabled,
        store: { ...s.store, latE6, lngE6 },
        fee: { ...s.fee, baseFee: fen.baseFee!, perKmFee: fen.perKmFee!, freeThreshold: fen.freeThreshold!, minOrderAmount: fen.minOrderAmount! },
        tip: { maxPerCall: fen.maxPerCall!, maxPerOrder: fen.maxPerOrder! },
      }
      // 保存后的提示按「这次是否动了门店坐标」分叉，因为两种情况对顾客的影响完全不同：
      //  - 动了坐标：在途报价凭证里签的是旧门店坐标，那段道路距离量的是另一条路，只能整张作废
      //    （顾客提交时收到 42227「配送费已更新，请刷新后重新提交」）；
      //  - 没动坐标：凭证里除距离外每个量（运费/范围/起送门槛）都在下单时按当前设置重算，
      //    所以新参数立刻生效，正在结算页的顾客**不会**被踢下来，按新参数校验即可。
      // 比对对象必须是服务端最新坐标，跟页面缓存的旧值比会恒为 false。
      const storeMoved = latE6 !== fresh.store.latE6 || lngE6 !== fresh.store.lngE6
      hydrate(await updateLocalSettings(payload))
      toast.success(storeMoved
        ? '已保存（门店坐标已变更，正在结算页的顾客需刷新后重新报价）'
        : '已保存（即刻生效；正在结算页的顾客提交时按新参数校验，无需重新报价）')
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败')
    } finally {
      setSaving(false)
    }
  }

  // 与 handleSave 保持一致：失败要让店主看见，不能静默吞掉
  const handlePause = async () => {
    const reason = window.prompt('暂停原因（顾客可见）', '临时暂停接单') ?? ''
    if (!reason.trim()) return
    try {
      hydrate(await pauseLocal(reason.trim()))
      toast.success('已暂停同城接单')
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '暂停失败，请重试')
    }
  }
  const handleResume = async () => {
    try {
      hydrate(await resumeLocal())
      toast.success('已恢复接单')
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '恢复失败，请重试')
    }
  }

  // 按距离档试算
  const sample = (km: number) => {
    const baseFee = toFen(money.baseFee) ?? 0, perKm = toFen(money.perKmFee) ?? 0
    if (km > s.radiusKm) return '超出配送范围'
    return `¥${toYuan(baseFee + Math.max(0, Math.ceil(km - s.fee.baseKm)) * perKm)}`
  }
  const hoursText = s.businessHours.map((h) => `${h.start}-${h.end}`).join('\n')

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-gray-800">同城设置</h2>
        <div className="flex items-center gap-2">
          {s.paused ? (
            <Button variant="secondary" size="sm" onClick={handleResume}><PlayCircle className="w-4 h-4" />恢复接单</Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={handlePause}><PauseCircle className="w-4 h-4" />暂停接单</Button>
          )}
          <Button size="sm" loading={saving} onClick={() => handleSave(!s.enabled)}>{s.enabled ? '关闭同城配送' : '开启同城配送'}</Button>
        </div>
      </div>
      {s.paused && <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">已暂停接单：{s.paused.reason}</div>}
      {!s.enabled && <div className="rounded-md bg-gray-50 border border-gray-200 p-3 text-sm text-gray-600">同城配送未开启，顾客端入口显示「即将开通」。填齐门店坐标、营业时段、运费后点右上角开启。</div>}

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800 flex items-center gap-1"><MapPin className="w-4 h-4" />门店</h3>
        <div className="rounded-md bg-brand-50 border border-brand-100 p-3 text-xs text-gray-700 space-y-1">
          <p className="font-medium">推荐：在店里用小程序设置坐标（3 步）</p>
          <p>① 打开小程序 →「我的」→「商家管理」登录 → ② 点「在地图上设置门店位置」，在地图上确认图钉落在店门口 → ③ 回到本页刷新确认。</p>
          <p className="text-gray-500">手填经纬度是高级选项：需用腾讯地图坐标拾取器取「纬度,经度」（GCJ-02），填错会导致所有订单距离与运费算错。</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="门店名称"><input className={inputCls} value={s.store.name} onChange={(e) => patchStore({ name: e.target.value })} /></Field>
          <Field label="门店电话"><input className={inputCls} value={s.store.phone} onChange={(e) => patchStore({ phone: e.target.value })} /></Field>
          <Field label="省 / 市 / 区">
            <div className="flex gap-2">
              <input className={inputCls} value={s.store.province} onChange={(e) => patchStore({ province: e.target.value })} />
              <input className={inputCls} value={s.store.city} onChange={(e) => patchStore({ city: e.target.value })} />
              <input className={inputCls} value={s.store.district} onChange={(e) => patchStore({ district: e.target.value })} />
            </div>
          </Field>
          <Field label="详细地址"><input className={inputCls} value={s.store.address} onChange={(e) => patchStore({ address: e.target.value })} /></Field>
          <Field label="纬度（高级）" hint="如 29.339123"><input className={inputCls} inputMode="decimal" value={coord.lat} onChange={(e) => editCoord({ lat: e.target.value })} /></Field>
          <Field label="经度（高级）" hint="如 104.778456"><input className={inputCls} inputMode="decimal" value={coord.lng} onChange={(e) => editCoord({ lng: e.target.value })} /></Field>
        </div>
        {coord.lat && coord.lng && (
          <a className="text-xs text-blue-600 underline" target="_blank" rel="noreferrer"
            href={`https://apis.map.qq.com/uri/v1/marker?marker=coord:${coord.lat},${coord.lng};title:门店;addr:${encodeURIComponent(s.store.address)}`}>
            在腾讯地图中核对这个点
          </a>
        )}
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">配送范围与运费</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="配送半径（道路距离，km）" hint={`查价失败时按直线 ${(s.radiusKm / s.detourFactor).toFixed(1)} km 兜底`}>
            <input className={inputCls} type="number" step="0.5" min={0.5} value={s.radiusKm} onChange={(e) => patch({ radiusKm: Number(e.target.value) })} /></Field>
          <Field label="绕路系数（兜底用）" hint="正常按运力方返回的真实道路距离计费；只有查价超时/失败时才用「直线 × 系数」估算，默认 1.7">
            <input className={inputCls} type="number" step="0.05" min={1} max={3} value={s.detourFactor} onChange={(e) => patch({ detourFactor: Number(e.target.value) })} /></Field>
          <Field label="基础运费（元）"><input className={inputCls} inputMode="decimal" value={money.baseFee} onChange={(e) => setMoney({ ...money, baseFee: e.target.value })} /></Field>
          <Field label="基础公里数" hint="不超过此距离只收基础运费">
            <input className={inputCls} type="number" step="0.5" min={0} value={s.fee.baseKm} onChange={(e) => patch({ fee: { ...s.fee, baseKm: Number(e.target.value) } })} /></Field>
          <Field label="超出每公里加价（元）"><input className={inputCls} inputMode="decimal" value={money.perKmFee} onChange={(e) => setMoney({ ...money, perKmFee: e.target.value })} /></Field>
          <Field label="满额免运费（元）" hint="0 = 不设"><input className={inputCls} inputMode="decimal" value={money.freeThreshold} onChange={(e) => setMoney({ ...money, freeThreshold: e.target.value })} /></Field>
          <Field label="起送金额（元）" hint="0 = 无门槛"><input className={inputCls} inputMode="decimal" value={money.minOrderAmount} onChange={(e) => setMoney({ ...money, minOrderAmount: e.target.value })} /></Field>
        </div>
        <div className="rounded-md bg-gray-50 border border-gray-200 p-3">
          <p className="text-xs font-medium text-gray-600 mb-1.5">按距离试算（不含满额免）</p>
          <ul className="text-xs text-gray-600 space-y-1">
            <li>1 km → {sample(1)}</li><li>3 km → {sample(3)}</li><li>5 km → {sample(5)}</li><li>{s.radiusKm + 1} km → {sample(s.radiusKm + 1)}</li>
          </ul>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">营业与履约</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="营业时段（每行一段 HH:mm-HH:mm）" hint="首期不支持跨零点；多段不可重叠">
            <textarea className={inputCls} rows={3} defaultValue={hoursText}
              onBlur={(e) => patch({ businessHours: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [start, end] = l.split('-'); return { start: start?.trim() ?? '', end: end?.trim() ?? '' } }) })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="备餐时长（分）"><input className={inputCls} type="number" min={0} value={s.prepMinutes} onChange={(e) => patch({ prepMinutes: Number(e.target.value) })} /></Field>
            <Field label="骑行均速（km/h）"><input className={inputCls} type="number" min={5} value={s.riderSpeedKmh} onChange={(e) => patch({ riderSpeedKmh: Number(e.target.value) })} /></Field>
            <Field label="接单后可取消（分）" hint="顾客申请取消的窗口"><input className={inputCls} type="number" min={0} max={30} value={s.acceptGraceMin} onChange={(e) => patch({ acceptGraceMin: Number(e.target.value) })} /></Field>
            <Field label="接单后自动呼叫（分）" hint="0 = 手动呼叫；须 ≥ 可取消窗口"><input className={inputCls} type="number" min={0} max={15} value={s.autoCallDelayMin} onChange={(e) => patch({ autoCallDelayMin: Number(e.target.value) })} /></Field>
            <Field label="单次最多件数"><input className={inputCls} type="number" min={1} value={s.limits.maxItems} onChange={(e) => patch({ limits: { ...s.limits, maxItems: Number(e.target.value) } })} /></Field>
            <Field label="单次最大重量（kg）"><input className={inputCls} type="number" step="0.5" min={0.5} value={s.limits.maxWeightKg} onChange={(e) => patch({ limits: { ...s.limits, maxWeightKg: Number(e.target.value) } })} /></Field>
          </div>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">运力（快递100 接入后生效）</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* 「默认运力」下拉先藏起来：服务端目前完全不读 defaultProvider（呼叫/自送都是看板上逐单点的），
              露在页面上等于让店主改一个不生效的开关。等服务端真的按它分流时再放出来。
          <Field label="默认运力" hint="日常走快递100 叫骑手；选「店内自送」则每单默认自己送（看板上仍可逐单切换）">
            <select className={inputCls} value={s.defaultProvider} onChange={(e) => patch({ defaultProvider: e.target.value as 'KD100' | 'SELF' })}>
              <option value="KD100">快递100 同城急送</option><option value="SELF">店内自送</option>
            </select>
          </Field>
          */}
          <Field label="商品默认净重（克）" hint="商品未填净重时用"><input className={inputCls} type="number" min={50} value={s.kd100.defaultItemWeightG} onChange={(e) => patch({ kd100: { ...s.kd100, defaultItemWeightG: Number(e.target.value) } })} /></Field>
          <Field label="小费单次上限（元）"><input className={inputCls} inputMode="decimal" value={money.maxPerCall} onChange={(e) => setMoney({ ...money, maxPerCall: e.target.value })} /></Field>
          <Field label="小费单笔订单累计上限（元）"><input className={inputCls} inputMode="decimal" value={money.maxPerOrder} onChange={(e) => setMoney({ ...money, maxPerOrder: e.target.value })} /></Field>
        </div>
      </section>

      <div className="flex justify-end">
        <Button loading={saving} onClick={() => handleSave()}>{saving ? '保存中...' : '保存'}</Button>
      </div>
    </div>
  )
}
