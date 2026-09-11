import { useEffect, useState } from 'react'
import { getExpressSettings, updateExpressSettings } from '../api/admin'
import type { ExpressSettings, RegionGroup } from '../types'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/Toast'
import { useUnsavedSettings } from '../components/UnsavedSettings'

const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
    {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
  </div>
)
const toYuan = (fen: number) => (fen / 100).toFixed(2)
/** 元字符串 → 分；非法返回 null（走正则不走 parseFloat，避免 0.29*100 的浮点坑） */
function toFen(input: string): number | null {
  const v = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null
  const [yuan, dec = ''] = v.split('.')
  return Number(yuan) * 100 + Number(dec.padEnd(2, '0'))
}
/** 服务端 40001 等业务校验错误的 message 是写给店员看的，不能吞掉换成「保存失败」（同 Workbench.tsx 的 apiMessage）*/
const apiMessage = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback

const COURIERS: { code: string; label: string }[] = [
  { code: 'jtexpress', label: '极兔' }, { code: 'yuantong', label: '圆通' }, { code: 'shentong', label: '申通' }, { code: 'yunda', label: '韵达' },
  { code: 'zhongtong', label: '中通' }, { code: 'jd', label: '京东' }, { code: 'debangkuaidi', label: '德邦' }, { code: 'ems', label: 'EMS' }, { code: 'shunfeng', label: '顺丰' },
]
const PROVINCES = [
  '北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省', '上海市', '江苏省', '浙江省', '安徽省', '福建省', '江西省',
  '山东省', '河南省', '湖北省', '湖南省', '广东省', '广西壮族自治区', '海南省', '重庆市', '四川省', '贵州省', '云南省', '西藏自治区', '陕西省', '甘肃省',
  '青海省', '宁夏回族自治区', '新疆维吾尔自治区', '香港特别行政区', '澳门特别行政区', '台湾省',
]
const OTHER = '其他'

/** 分组行的可编辑副本：金额用元字符串，省份用数组
 *  isOther 按加载时的组名锁定「其他」身份，之后就算店员改了输入框里的文字也不会失去保护——
 *  用当前 name === OTHER 判断会被「把其他组名改成『其他』」或「把『其他』改名」绕过 */
interface GroupForm { name: string; provinces: string[]; freeShipMin: string; tableFirst: string; tableOverPerKg: string; blocked: boolean; isOther: boolean }
interface MoneyForm { markup: string; roundTo: string; minOrder: string }

export default function ShopSettings() {
  const { setDirty } = useUnsavedSettings()
  const [s, setS] = useState<ExpressSettings | null>(null)
  const [groups, setGroups] = useState<GroupForm[]>([])
  const [money, setMoney] = useState<MoneyForm>({ markup: '0.00', roundTo: '0.50', minOrder: '0.00' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const fromServer = (v: ExpressSettings) => {
    setS(v)
    setGroups(v.regionGroups.map((g) => ({
      name: g.name,
      provinces: g.provinces,
      // 不寄送组的包邮线服务端不会用；但如果历史数据里 blocked=true 还留着 >0 的值，禁用态的输入框会原样显示它，
      // 使 buildPayload 的「已设为不寄送，不能再设包邮线」校验卡死店员——加载时就把它清成 0.00
      freeShipMin: g.blocked && g.freeShipMinFen > 0 ? '0.00' : toYuan(g.freeShipMinFen),
      tableFirst: toYuan(g.tableFirstFen),
      tableOverPerKg: toYuan(g.tableOverPerKgFen),
      blocked: g.blocked,
      isOther: g.name === OTHER,
    })))
    setMoney({ markup: toYuan(v.fee.markupFen), roundTo: toYuan(v.fee.roundToFen), minOrder: toYuan(v.minOrderAmountFen) })
    setDirty(false)
  }
  useEffect(() => {
    getExpressSettings().then(fromServer).catch(() => { toast.error('邮寄设置加载失败，请刷新') }).finally(() => setLoading(false))
  }, [])

  const patch = (p: Partial<ExpressSettings>) => setS((prev) => (prev ? { ...prev, ...p } : prev))
  const patchGroup = (i: number, p: Partial<GroupForm>) => setGroups((gs) => gs.map((g, j) => (j === i ? { ...g, ...p } : g)))
  const provinceOwner = (p: string, except: number) => groups.findIndex((g, j) => j !== except && g.provinces.includes(p))
  const toggleProvince = (i: number, p: string) => {
    const owner = provinceOwner(p, i)
    setGroups((gs) => gs.map((g, j) => {
      if (j === i) return { ...g, provinces: g.provinces.includes(p) ? g.provinces.filter((x) => x !== p) : [...g.provinces, p] }
      if (j === owner) return { ...g, provinces: g.provinces.filter((x) => x !== p) } // 一省只能属一组：从原组摘掉
      return g
    }))
    setDirty(true) // 走的是 button onClick，不会被外层 onChangeCapture 逮到，必须手动标脏
  }
  const addGroup = () => { setGroups((gs) => [...gs, { name: '', provinces: [], freeShipMin: '0.00', tableFirst: '12.00', tableOverPerKg: '3.00', blocked: false, isOther: false }]); setDirty(true) }
  const removeGroup = (i: number) => { if (groups[i].isOther) { toast.error('「其他」分组不能删除'); return } setGroups((gs) => gs.filter((_, j) => j !== i)); setDirty(true) }

  const buildPayload = (): ExpressSettings | null => {
    if (!s) return null
    const markup = toFen(money.markup), roundTo = toFen(money.roundTo), minOrder = toFen(money.minOrder)
    if (markup === null || roundTo === null || minOrder === null) { setError('额外加价 / 取整 / 起送金额请填金额，最多两位小数'); return null }
    const regionGroups: RegionGroup[] = []
    for (const g of groups) {
      const a = toFen(g.freeShipMin), b = toFen(g.tableFirst), c = toFen(g.tableOverPerKg)
      if (!g.name.trim()) { setError('分组名不能为空'); return null }
      // 「其他」是保留名：按加载时锁定的身份（isOther）判断，不是这一行——避免非「其他」组被改名成「其他」后混进去
      if (!g.isOther && g.name.trim() === OTHER) { setError('分组名「其他」是保留名，请换一个'); return null }
      if (a === null || b === null || c === null) { setError(`分组「${g.name}」的金额请填最多两位小数`); return null }
      if (g.blocked && a > 0) { setError(`分组「${g.name}」已设为不寄送，不能再设包邮线`); return null }
      regionGroups.push({ name: g.name.trim(), provinces: g.provinces, freeShipMinFen: a, tableFirstFen: b, tableOverPerKgFen: c, blocked: g.blocked })
    }
    if (!regionGroups.some((g) => g.name === OTHER)) { setError('必须保留名为「其他」的分组'); return null }
    if (s.pricingPool.length < 2) { setError('参与定价的快递至少勾选 2 家'); return null }
    // 与服务端 validateExpressSettings 一致：不按 mode 门控——TABLE 下这条也校验，
    // 店员能靠现在常显的「参与定价的快递」勾选区把家数补够，不会卡在隐藏控件上
    if (s.fee.minQuoteCount > s.pricingPool.length) { setError(`至少几家回价才用中位数（${s.fee.minQuoteCount}）不能超过参与定价的家数（${s.pricingPool.length}）`); return null }
    setError('')
    return { ...s, fee: { ...s.fee, markupFen: markup, roundToFen: roundTo }, minOrderAmountFen: minOrder, regionGroups }
  }
  const handleSave = async () => {
    const payload = buildPayload(); if (!payload) return
    setSaving(true)
    try { fromServer(await updateExpressSettings(payload)); toast.success('已保存，新下单立即按新规则计费') }
    catch (e) { setError(apiMessage(e, '保存失败')); toast.error(apiMessage(e, '保存失败')) }
    finally { setSaving(false) }
  }

  if (loading) return <div className="text-gray-500">加载中...</div>
  if (!s) return <div className="text-red-600">邮寄设置加载失败，请刷新</div>
  const isQuote = s.fee.mode === 'QUOTE'

  return (
    <div className="space-y-4 max-w-4xl" onChangeCapture={() => setDirty(true)}>
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
        <div>
          <h3 className="font-medium text-gray-800">运费怎么算</h3>
          <p className="text-xs text-gray-500 mt-0.5">顾客填完地址那一刻向快递100 查各家报价，取<strong>参与定价名单的中位数</strong>；查不到就用下面分组里的兜底表。包邮线与起送金额都按<strong>券前商品小计</strong>判。</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="运费口径">
            <select className={inputCls} value={s.fee.mode} onChange={(e) => patch({ fee: { ...s.fee, mode: e.target.value as 'QUOTE' | 'TABLE' } })}>
              <option value="QUOTE">按快递100 实时报价取中位数（推荐）</option>
              <option value="TABLE">只用分组兜底表</option>
            </select>
          </Field>
          <Field label="起送金额（元）" hint="0 = 无门槛"><input className={inputCls} inputMode="decimal" value={money.minOrder} onChange={(e) => setMoney({ ...money, minOrder: e.target.value })} /></Field>
          {isQuote && <>
            <Field label="额外加价（元）" hint="在中位数之上再加；0 = 不加"><input className={inputCls} inputMode="decimal" value={money.markup} onChange={(e) => setMoney({ ...money, markup: e.target.value })} /></Field>
            <Field label="向上取整到（元）" hint="0.5 时 ¥7.08 收 ¥7.50；0 = 不取整"><input className={inputCls} inputMode="decimal" value={money.roundTo} onChange={(e) => setMoney({ ...money, roundTo: e.target.value })} /></Field>
            <Field label="至少几家回价才用中位数" hint="不足就退回兜底表"><input className={inputCls} type="number" min={1} max={9} value={s.fee.minQuoteCount} onChange={(e) => patch({ fee: { ...s.fee, minQuoteCount: Number(e.target.value) } })} /></Field>
          </>}
        </div>
        <Field label="参与定价的快递" hint={isQuote ? '只影响「顾客付多少」；店员发货时仍能看到全部家的价。EMS 折后比标准价还贵、德邦超 2.5 kg 不报价，默认不勾' : 'TABLE 口径下暂不使用，但至少保留 2 家'}>
          <div className="flex flex-wrap gap-3">
            {COURIERS.map((c) => (
              <label key={c.code} className="inline-flex items-center gap-1 text-sm">
                <input type="checkbox" checked={s.pricingPool.includes(c.code)} onChange={(e) => patch({ pricingPool: e.target.checked ? [...s.pricingPool, c.code] : s.pricingPool.filter((x) => x !== c.code) })} />
                {c.label}
              </label>
            ))}
          </div>
        </Field>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
        <div>
          <h3 className="font-medium text-gray-800">重量</h3>
          <p className="text-xs text-gray-500 mt-0.5">重量 = 各商品净重 × 数量 + 每单包装。礼盒重量填在商品的「净重」里；泡沫箱、冰袋填在这里。</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="每单包装附加重量（克）" hint="泡沫箱 + 冰袋实称一次"><input className={inputCls} type="number" min={0} value={s.weight.packagingG} onChange={(e) => patch({ weight: { ...s.weight, packagingG: Number(e.target.value) } })} /></Field>
          <Field label="商品未填净重时按（克）"><input className={inputCls} type="number" min={1} value={s.weight.defaultItemG} onChange={(e) => patch({ weight: { ...s.weight, defaultItemG: Number(e.target.value) } })} /></Field>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium text-gray-800">地区分组</h3>
            <p className="text-xs text-gray-500 mt-0.5">一个省只能属于一个组，没勾的省自动落到「其他」。勾了「不寄送」的组，顾客选到该地址会被提示暂不支持。</p>
          </div>
          <Button onClick={addGroup}>+ 新增分组</Button>
        </div>
        {groups.map((g, i) => (
          <div key={i} className="rounded-md border border-gray-200 p-3 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 items-start">
              <Field label="组名"><input className={inputCls} value={g.name} disabled={g.isOther} onChange={(e) => patchGroup(i, { name: e.target.value })} /></Field>
              <Field label="满额包邮（元）" hint="0 = 不包邮"><input className={inputCls} inputMode="decimal" value={g.freeShipMin} disabled={g.blocked} onChange={(e) => patchGroup(i, { freeShipMin: e.target.value })} /></Field>
              <Field label="兜底首重价（元）"><input className={inputCls} inputMode="decimal" value={g.tableFirst} disabled={g.blocked} onChange={(e) => patchGroup(i, { tableFirst: e.target.value })} /></Field>
              <Field label="兜底续重/公斤（元）"><input className={inputCls} inputMode="decimal" value={g.tableOverPerKg} disabled={g.blocked} onChange={(e) => patchGroup(i, { tableOverPerKg: e.target.value })} /></Field>
              <div className="flex items-center gap-3 sm:pt-8">
                <label className="inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={g.blocked} disabled={g.isOther} onChange={(e) => patchGroup(i, { blocked: e.target.checked, freeShipMin: e.target.checked ? '0.00' : g.freeShipMin })} />不寄送</label>
                {!g.isOther && <button className="text-xs text-red-600" onClick={() => removeGroup(i)}>删除</button>}
              </div>
            </div>
            {!g.isOther && (
              <div className="flex flex-wrap gap-2">
                {PROVINCES.map((p) => {
                  const mine = g.provinces.includes(p); const owner = provinceOwner(p, i)
                  return (
                    <button key={p} type="button" onClick={() => toggleProvince(i, p)}
                      aria-pressed={mine}
                      aria-label={owner >= 0 && !mine ? `${p}（当前在「${groups[owner].name}」，点击移到本组）` : undefined}
                      className={`px-2 py-0.5 rounded text-xs border ${mine ? 'bg-brand-500 text-white border-brand-500' : owner >= 0 ? 'bg-gray-100 text-gray-400 border-gray-200' : 'bg-white text-gray-700 border-gray-300'}`}
                      title={owner >= 0 && !mine ? `当前在「${groups[owner].name}」` : ''}>{p.replace(/(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$/, '')}</button>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
        <h3 className="font-medium text-gray-800">顾客取消窗口</h3>
        <Field label="接单后顾客可申请取消（分钟）" hint="0 = 关闭；申请后由店员同意或驳回，同意即全额退款"><input className={inputCls} type="number" min={0} max={30} value={s.acceptGraceMin} onChange={(e) => patch({ acceptGraceMin: Number(e.target.value) })} /></Field>
      </div>

      {error && <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>}
      <div className="flex justify-end">
        <Button loading={saving} onClick={handleSave}>{saving ? '保存中...' : '保存'}</Button>
      </div>
    </div>
  )
}
