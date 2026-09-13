import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { MapPin, PauseCircle } from 'lucide-react'
import { getLocalSettings, updateLocalSettings } from '../api/admin'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/Toast'
import { confirmDialog } from '../components/ui/ConfirmDialog'
import type { LocalDeliverySettings } from '../types'
import { RowList, TimeRangeRow, validateRanges, sortRanges } from '../components/ui/RowList'
import { useUnsavedSettings } from '../components/UnsavedSettings'
import PauseScopeDialog from '../components/PauseScopeDialog'
import { pauseStateLines, holidayActive } from '../utils/pause-scope'
import { todayKey } from '../utils/time'

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
  const { setDirty } = useUnsavedSettings()
  const [s, setS] = useState<LocalDeliverySettings | null>(null)
  const [money, setMoney] = useState({ baseFee: '', perKmFee: '', minOrderAmount: '', maxPerCall: '', maxPerOrder: '', quoteMarkup: '', roundTo: '', quoteNearMarkup: '', packingPerItem: '' })
  const [coord, setCoord] = useState({ lat: '', lng: '' })
  const [pauseOpen, setPauseOpen] = useState(false)
  const [tiers, setTiers] = useState<{ minAmountFen: number; maxKm: number }[]>([])
  // 门店坐标另有一条写入路径（小程序商家端一键定位 → PATCH store-location），而本页的保存是整包
  // 覆盖式 PUT、服务端没有乐观锁。店主按本页指引去店门口定完位、回到这个还开着的标签页改别的参数
  // 再保存，若把页面加载时缓存的旧坐标一起写回，新坐标就被静默改掉了。
  // 所以只有店主真的动过这两个输入框才发送手填值，否则保存前先取服务端最新坐标合并。
  const [coordDirty, setCoordDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const hydrate = (v: LocalDeliverySettings) => {
    setS(v)
    setMoney({
      baseFee: toYuan(v.fee.baseFee), perKmFee: toYuan(v.fee.perKmFee),
      quoteMarkup: toYuan(v.fee.quoteMarkupFen), roundTo: toYuan(v.fee.roundToFen),
      quoteNearMarkup: toYuan(v.fee.quoteNearMarkupFen),
      minOrderAmount: toYuan(v.fee.minOrderAmount), maxPerCall: toYuan(v.tip.maxPerCall), maxPerOrder: toYuan(v.tip.maxPerOrder),
      packingPerItem: toYuan(v.packing.perItemFen),
    })
    setTiers([...(v.fee.freeShipTiers ?? [])])
    setCoord({ lat: v.store.latE6 === null ? '' : (v.store.latE6 / 1e6).toFixed(6), lng: v.store.lngE6 === null ? '' : (v.store.lngE6 / 1e6).toFixed(6) })
    setCoordDirty(false)
    setDirty(false)
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
    if (fen.packingPerItem! > 10_000) { toast.error('默认每份打包费不能超过 ¥100'); return }
    if (formErrors) { toast.error(formErrors); return }
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
        peak: { ...s.peak, windows: sortRanges(s.peak.windows) },
        version: fresh.version,
        paused: fresh.paused,
        holiday: fresh.holiday,
        businessHours: fresh.businessHours,   // Task 5 起营业时间在独立页编辑；这里绝不能用页面缓存覆盖
        enabled: enabledOverride ?? s.enabled,
        store: { ...s.store, latE6, lngE6 },
        fee: { ...s.fee, baseFee: fen.baseFee!, perKmFee: fen.perKmFee!, minOrderAmount: fen.minOrderAmount!, freeShipTiers: [...tiers].sort((a, b) => a.maxKm - b.maxKm),
          quoteMarkupFen: fen.quoteMarkup ?? s.fee.quoteMarkupFen, roundToFen: fen.roundTo ?? s.fee.roundToFen,
          quoteNearMarkupFen: fen.quoteNearMarkup ?? s.fee.quoteNearMarkupFen },
        tip: { maxPerCall: fen.maxPerCall!, maxPerOrder: fen.maxPerOrder! },
        packing: { enabled: s.packing.enabled, perItemFen: fen.packingPerItem! },
        pickup: fresh.pickup,   // 自取在「到店自取设置」页单独编辑（PO 2026-09-11），这里同样不能用页面缓存覆盖
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

  /**
   * 预计送达试算——**与服务端 estimateMinutesRange 同一套公式**，改这里必须同时改那边。
   *
   * 顾客看到的分钟数 = 出餐 + 路上，其中「出餐」按呼叫方式分两种：
   *   手动呼叫（自动呼叫延迟 = 0）：备餐 + 呼叫到取货  —— 保守按**串行**算，
   *     因为什么时候点「呼叫骑手」取决于店员，最可能是菜装好了才点。
   *   自动呼叫：max(备餐, 延迟 + 呼叫到取货) —— 骑手赶来与备餐**并行**，取更晚的那个。
   * 摆在设置页上，是为了让店主改备餐时长时立刻看到顾客那一栏会变成什么。
   */
  const etaParts = (km: number, prep: number) => {
    const ride = Math.round((km / s.riderSpeedKmh) * 60)
    const pickup = s.autoCallDelayMin > 0
      ? Math.max(prep, s.autoCallDelayMin + s.callToPickupMin)
      : prep + s.callToPickupMin
    return { ride, pickup, total: pickup + ride }
  }

  // 按距离档试算
  const sample = (km: number) => {
    const baseFee = toFen(money.baseFee) ?? 0, perKm = toFen(money.perKmFee) ?? 0
    if (km > s.radiusKm) return '超出配送范围'
    return `¥${toYuan(baseFee + Math.max(0, Math.ceil(km - s.fee.baseKm)) * perKm)}`
  }
  // 两处分段列表的校验：任一处有错，保存键置灰并提示。错误就地标红在那一行。
  // 营业时段自 Task 5 起在独立页编辑，这里不再校验。
  const peakErrs = validateRanges(s.peak.windows)
  const tierErrs = tiers.map((t) => (t.minAmountFen < 0 || !Number.isFinite(t.minAmountFen)) ? '满额要填' : (!(t.maxKm > 0)) ? '公里数要大于 0' : undefined)
  const formErrors = peakErrs.some(Boolean) ? '高峰时段有错误，请先改正' : tierErrs.some(Boolean) ? '阶梯免运费有错误，请先改正'
    : ''
  const fmtRanges = (rows: { start: string; end: string }[]) => sortRanges(rows).map((h) => `${h.start}–${h.end}`).join('、')

  return (
    <div className="space-y-4 max-w-3xl" onChangeCapture={() => setDirty(true)}>
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-800">同城配送设置</h3>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setPauseOpen(true)}><PauseCircle className="w-4 h-4" />暂停 / 休业</Button>
          <Button size="sm" loading={saving} onClick={() => handleSave(!s.enabled)}>{s.enabled ? '关闭同城配送' : '开启同城配送'}</Button>
        </div>
      </div>
      {pauseStateLines({ paused: s.paused, pickupPaused: s.pickup.paused, holiday: s.holiday, pickupEnabled: s.pickup.enabled }).map((l) => (
        <div key={l.key} className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">{l.text}</div>
      ))}
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
          <Field label="运费怎么算"
            hint="按实时报价：顾客输完地址时本来就会向运力方查一次道路距离，同一次调用带回各家报价，取最便宜那家（也正是呼叫第一级会呼的那家）加上加价收顾客。查价超时或失败时自动退回下面那张固定表。">
            <select className={inputCls} value={s.fee.mode}
              onChange={(e) => patch({ fee: { ...s.fee, mode: e.target.value as 'TABLE' | 'QUOTE' } })}>
              <option value="QUOTE">按实时报价 + 加价（推荐）</option>
              <option value="TABLE">只用下面的固定表</option>
            </select>
          </Field>
          {s.fee.mode === 'QUOTE' && (
            <>
              <Field label="加价 · 远单（元）"
                hint="收顾客的钱 = 最低报价 + 这个数。呼叫第一级接得掉时，它就是这一单的毛利。2026-09-06 实测：1.11 km 最低 ¥5.83、8.94 km 最低 ¥16.23">
                <input className={inputCls} inputMode="decimal" value={money.quoteMarkup}
                  onChange={(e) => setMoney({ ...money, quoteMarkup: e.target.value })} /></Field>
              <Field label="近单分界（km）" hint="道路距离在此以内算近单，用下面那档加价。0 = 不分档，一律用远单加价">
                <input className={inputCls} type="number" step="0.5" min={0} max={50} value={s.fee.quoteNearKm}
                  onChange={(e) => patch({ fee: { ...s.fee, quoteNearKm: Number(e.target.value) } })} /></Field>
              <Field label="加价 · 近单（元）"
                hint="近单绝对运费低，按远单同样加价相当于在旧价上涨四成，怕吓走最核心的近距离顾客；但也不能退回旧的固定 ¥6——按 80% 第一级接单率算那是每单亏 ¥0.17。">
                <input className={inputCls} inputMode="decimal" value={money.quoteNearMarkup}
                  onChange={(e) => setMoney({ ...money, quoteNearMarkup: e.target.value })} /></Field>
              <Field label="运费向上取整到（元）" hint="0 = 不取整。取 0.5 时 ¥8.33 会收 ¥8.50——只往上取，不会少收">
                <input className={inputCls} inputMode="decimal" value={money.roundTo}
                  onChange={(e) => setMoney({ ...money, roundTo: e.target.value })} /></Field>
            </>
          )}
          <Field label="基础运费（元）" hint={s.fee.mode === 'QUOTE' ? '仅在查价失败时兜底使用' : undefined}><input className={inputCls} inputMode="decimal" value={money.baseFee} onChange={(e) => setMoney({ ...money, baseFee: e.target.value })} /></Field>
          <Field label="基础公里数" hint="不超过此距离只收基础运费">
            <input className={inputCls} type="number" step="0.5" min={0} value={s.fee.baseKm} onChange={(e) => patch({ fee: { ...s.fee, baseKm: Number(e.target.value) } })} /></Field>
          <Field label="超出每公里加价（元）"><input className={inputCls} inputMode="decimal" value={money.perKmFee} onChange={(e) => setMoney({ ...money, perKmFee: e.target.value })} /></Field>
          {/* 一行「满 X 元·免 Y km」四个控件在单格里放不下（Chrome 里 km 会被挤出框），占两格 */}
          <div className="sm:col-span-2"><Field label="阶梯满额免运费"
            hint="跑得越远要求点得越多。按券前商品小计判，取所有达标档里公里数最大的那一档。">
            <RowList rows={tiers} onChange={setTiers}
              blank={() => ({ minAmountFen: 0, maxKm: 0 })} errors={tierErrs} addLabel="再加一档"
              emptyHint="留空 = 关闭满额免运费"
              render={(row, set) => (
                <>
                  <span className="text-sm text-gray-500 shrink-0">满</span>
                  <input className={`${inputCls} !w-20 !px-2 shrink-0`} type="number" min={0} step={1}
                    value={row.minAmountFen ? row.minAmountFen / 100 : ''} placeholder="元"
                    onChange={(e) => set({ minAmountFen: Math.round(Number(e.target.value || 0) * 100) })} />
                  <span className="text-sm text-gray-500 shrink-0">元·免</span>
                  <input className={`${inputCls} !w-[4.5rem] !px-2 shrink-0`} type="number" min={0.5} step={0.5}
                    value={row.maxKm || ''} placeholder="公里"
                    onChange={(e) => set({ maxKm: Number(e.target.value || 0) })} />
                  <span className="text-sm text-gray-500 shrink-0">km</span>
                </>
              )} />
            {tiers.length > 0 && !tierErrs.some(Boolean) && (
              <p className="mt-1 text-xs text-gray-500">
                {[...tiers].sort((a, b) => a.maxKm - b.maxKm).map((t) => `满 ${t.minAmountFen / 100} 元 ${t.maxKm} 公里内免`).join('；')}
              </p>
            )}
          </Field></div>
          <Field label="起送金额（元）" hint="0 = 无门槛"><input className={inputCls} inputMode="decimal" value={money.minOrderAmount} onChange={(e) => setMoney({ ...money, minOrderAmount: e.target.value })} /></Field>
        </div>
        <div className="rounded-md bg-gray-50 border border-gray-200 p-3">
          <p className="text-xs font-medium text-gray-600 mb-1.5">
            {s.fee.mode === 'QUOTE' ? '固定表按距离试算（仅查价失败时才会用到，不含满额免）' : '按距离试算（不含满额免）'}
          </p>
          <ul className="text-xs text-gray-600 space-y-1">
            <li>1 km → {sample(1)}</li><li>3 km → {sample(3)}</li><li>5 km → {sample(5)}</li><li>{s.radiusKm + 1} km → {sample(s.radiusKm + 1)}</li>
          </ul>
        </div>
        {/* 预计送达试算：把三段拆开写出来，改备餐时长时能立刻看到顾客那一栏变成什么 */}
        <div className="rounded-md bg-gray-50 border border-gray-200 p-3">
          <p className="text-xs font-medium text-gray-600 mb-1.5">
            结算页「大概多久送到」试算 ——{' '}
            {s.autoCallDelayMin > 0
              ? `已开自动呼叫（接单后 ${s.autoCallDelayMin} 分），骑手赶来与备餐并行，取两者较晚的`
              : '当前是手动呼叫，按「备餐 → 呼叫 → 骑手到店 → 送」串行保守估算'}
          </p>
          <ul className="text-xs text-gray-600 space-y-1">
            {[1, 3, 5].map((km) => {
              const flat = etaParts(km, s.prepMinutes)
              const peak = etaParts(km, s.peak.prepMaxMinutes)
              return (
                <li key={km}>
                  {km} km → 平时 <b>{flat.total} 分</b>
                  <span className="text-gray-400">
                    （出餐 {flat.pickup} + 路上 {flat.ride}）
                  </span>
                  {s.peak.windows.length > 0 && <> · 高峰 <b>{peak.total} 分</b></>}
                </li>
              )
            })}
          </ul>
          <p className="text-[11px] text-gray-400 mt-1.5 leading-relaxed">
            计时从<b>店员接单</b>起算，不含顾客下单到接单那一段（结算页已写明这一点）。
            骑手取货之后，顾客端会改用骑手实时位置重算，不再用这个估算。
          </p>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">打包费</h3>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="packingEnabled"
            checked={s.packing.enabled}
            onChange={(e) => patch({ packing: { ...s.packing, enabled: e.target.checked } })}
            className="rounded"
          />
          <label htmlFor="packingEnabled" className="text-sm text-gray-700">收取打包费（关闭 = 整店暂不收，商品上的设置保留）</label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="默认每份打包费（元）">
            <input className={inputCls} inputMode="decimal" value={money.packingPerItem}
              onChange={(e) => setMoney({ ...money, packingPerItem: e.target.value })} disabled={!s.packing.enabled} />
          </Field>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">营业与履约</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="营业时段（全店统一）" hint="外送、自取、来单催单、小程序「关于」页共用">
            <p className="text-sm text-gray-800 py-2">
              {s.businessHours.length ? fmtRanges(s.businessHours) : '未设置（全天不营业）'}
            </p>
            <Link to="/settings/hours" className="text-xs text-blue-600 underline">去「营业时间」页修改</Link>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="备餐时长（分）" hint="从点「接单」开始算，不含顾客下单到接单那一段"><input className={inputCls} type="number" min={0} value={s.prepMinutes} onChange={(e) => patch({ prepMinutes: Number(e.target.value) })} /></Field>
            <Field label="骑行均速（km/h）"><input className={inputCls} type="number" min={5} value={s.riderSpeedKmh} onChange={(e) => patch({ riderSpeedKmh: Number(e.target.value) })} /></Field>
            <Field label="呼叫到骑手取货（分钟）"
              hint={s.autoCallDelayMin > 0
                ? `自动呼叫已开：骑手在接单后第 ${s.autoCallDelayMin} 分钟被呼，赶来与备餐并行，预计送达取两者较晚的那个。`
                : '当前是手动呼叫：什么时候呼取决于店员，预计送达按「备餐 + 这个数」保守串行计算。想把预计时间压下来，把下面的「自动呼叫延迟」打开更有效。'}>
              <input className={inputCls} type="number" min={0} max={60} value={s.callToPickupMin}
                onChange={(e) => patch({ callToPickupMin: Number(e.target.value) })} /></Field>
            <Field label="接单后可取消（分）" hint="顾客申请取消的窗口"><input className={inputCls} type="number" min={0} max={30} value={s.acceptGraceMin} onChange={(e) => patch({ acceptGraceMin: Number(e.target.value) })} /></Field>
            <Field label="接单后自动呼叫（分）" hint="0 = 手动呼叫；须 ≥ 可取消窗口"><input className={inputCls} type="number" min={0} max={15} value={s.autoCallDelayMin} onChange={(e) => patch({ autoCallDelayMin: Number(e.target.value) })} /></Field>
            <Field label="单次最多件数"><input className={inputCls} type="number" min={1} value={s.limits.maxItems} onChange={(e) => patch({ limits: { ...s.limits, maxItems: Number(e.target.value) } })} /></Field>
            <Field label="单次最大重量（kg）"><input className={inputCls} type="number" step="0.5" min={0.5} value={s.limits.maxWeightKg} onChange={(e) => patch({ limits: { ...s.limits, maxWeightKg: Number(e.target.value) } })} /></Field>
          </div>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-2">
        <h3 className="font-medium text-gray-800">休业</h3>
        <p className="text-xs text-gray-500">节假日/装修整店停：外送与自取一起停，邮寄不受影响。到日期自动恢复，也可提前结束。</p>
        {holidayActive(s.holiday, todayKey())
          ? <p className="text-sm text-amber-800">休业中：{s.holiday!.reason || '休业'}（{s.holiday!.until ? `${s.holiday!.until.slice(5)} 后恢复` : '手动恢复'}）——在右上角「暂停 / 休业」里结束。</p>
          : <p className="text-sm text-gray-600">当前正常营业。要休业请点右上角「暂停 / 休业」→「休业至某日」。</p>}
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">高峰时段</h3>
        <p className="text-xs text-gray-500">
          高峰期出餐排队，备餐比平时慢。这里设的时长只在高峰时段生效，平时仍用上面的「备餐时长」——
          用高峰的数去报全天的单，平时那些单会被报得离谱地晚。
          顾客在结算页看到的是区间（如「约 35–40 分钟送达」）；接单时落库的预计送达取<b>上界</b>，
          报晚了顾客早收到是惊喜，报早了是投诉。
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="高峰时段" hint="这几段里备餐按下面的高峰时长算；留空 = 全天不分高峰">
            <RowList rows={s.peak.windows} onChange={(rows) => patch({ peak: { ...s.peak, windows: rows } })}
              blank={() => ({ start: '', end: '' })} errors={peakErrs} addLabel="再加一段"
              emptyHint="留空 = 全天不分高峰"
              render={(row, set) => <TimeRangeRow row={row} set={set} cls={inputCls} />} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="高峰备餐最短（分）">
              <input className={inputCls} type="number" min={0} value={s.peak.prepMinMinutes}
                onChange={(e) => patch({ peak: { ...s.peak, prepMinMinutes: Number(e.target.value) } })} /></Field>
            <Field label="高峰备餐最长（分）" hint="预计送达按这个算">
              <input className={inputCls} type="number" min={0} value={s.peak.prepMaxMinutes}
                onChange={(e) => patch({ peak: { ...s.peak, prepMaxMinutes: Number(e.target.value) } })} /></Field>
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
          <Field label="「普通配送」第一次呼谁"
            hint="两级阶梯的第一级。工作台弹窗只有「普通配送」和「极速配送（只呼闪送）」两个选项，这里定的是普通配送第一次怎么呼。并呼几家就同时冻结几笔预扣，只有中标那家最终扣款。">
            <select className={inputCls} value={s.callStrategy.mode}
              onChange={(e) => patch({ callStrategy: { ...s.callStrategy, mode: e.target.value as 'SOLO_LOWEST' | 'CHEAPEST_N' | 'ALL' } })}>
              <option value="SOLO_LOWEST">只呼最低价那一家（推荐）</option>
              <option value="CHEAPEST_N">并呼最便宜的几家</option>
              {/* ALL（并呼全部）已从选项里去掉（PO 2026-09-12）；库里若仍是 ALL，保留显示，免得一进页面就被静默改掉 */}
              {s.callStrategy.mode === 'ALL' && <option value="ALL">并呼全部运力（旧设置，建议改掉）</option>}
            </select>
          </Field>
          <Field label="第二级并呼最便宜的几家"
            hint="第一级没人接时升到这一级。按首单那组报价：1 家约冻 ¥16、3 家约冻 ¥52、7 家约冻 ¥75。家数越多抢单越快，但占用的余额也越多">
            <input className={inputCls} type="number" min={1} max={7} value={s.callStrategy.cheapestN}
              onChange={(e) => patch({ callStrategy: { ...s.callStrategy, cheapestN: Number(e.target.value) } })} /></Field>
          <Field label="每一级等几分钟"
            hint="一家没人接 → 等这么久 → 并呼最便宜几家 → 再等这么久 → 不再加人，提醒店员处理。极速配送（只呼闪送）没人接同样会升到并呼几家。0 = 不自动升级。调度器每分钟跑一轮，实际会在设定值到 +1 分钟之间发生">
            <input className={inputCls} type="number" min={0} max={30} value={s.callStrategy.escalateAfterMin}
              onChange={(e) => patch({ callStrategy: { ...s.callStrategy, escalateAfterMin: Number(e.target.value) } })} /></Field>
          <Field label="商品默认净重（克）" hint="商品未填净重时用"><input className={inputCls} type="number" min={50} value={s.kd100.defaultItemWeightG} onChange={(e) => patch({ kd100: { ...s.kd100, defaultItemWeightG: Number(e.target.value) } })} /></Field>
          <Field label="小费单次上限（元）"><input className={inputCls} inputMode="decimal" value={money.maxPerCall} onChange={(e) => setMoney({ ...money, maxPerCall: e.target.value })} /></Field>
          <Field label="小费单笔订单累计上限（元）"><input className={inputCls} inputMode="decimal" value={money.maxPerOrder} onChange={(e) => setMoney({ ...money, maxPerOrder: e.target.value })} /></Field>
        </div>
      </section>

      <div className="flex justify-end">
        {formErrors && <span className="text-xs text-red-600 self-center mr-2">{formErrors}</span>}
        <Button loading={saving} disabled={!!formErrors} onClick={() => handleSave()}>{saving ? '保存中...' : '保存'}</Button>
      </div>

      {pauseOpen && (
        <PauseScopeDialog
          state={{ paused: s.paused, pickupPaused: s.pickup.paused, holiday: s.holiday, pickupEnabled: s.pickup.enabled }}
          onClose={() => setPauseOpen(false)}
          onDone={async (msg) => {
            setPauseOpen(false)
            toast.success(msg)
            try { hydrate(await getLocalSettings()) } catch { toast.error('刷新设置失败，请手动刷新页面') }
          }}
        />
      )}
    </div>
  )
}
