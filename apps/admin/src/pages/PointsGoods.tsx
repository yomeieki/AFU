/**
 * 随单赠品（积分加购商品）管理。
 *
 * 「随单赠品」= 顾客在结算页用积分加购、跟着付费订单一起履约的商品，不是单独的 0 元兑换单。
 * 服务端见 apps/server/src/routes/admin/points-goods.ts，本页的校验范围与它的 zod schema 对齐，
 * 免得店主填了才被打回。
 */
import { useEffect, useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import {
  getPointsGoods,
  createPointsGood,
  updatePointsGood,
  deletePointsGood,
  getMemberSettings,
  getProducts,
} from '../api/admin'
import Button from '../components/ui/Button'
import Modal from '../components/ui/Modal'
import Pagination from '../components/ui/Pagination'
import Table from '../components/ui/Table'
import { toast } from '../components/ui/Toast'
import { confirmDialog } from '../components/ui/ConfirmDialog'
import { CHANNEL_LABEL, type Channel, type OnOff, type PointsGood, type Product, type ProductSku } from '../types'

const inputCls =
  'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'

// 商品当前状态。ON 以外的三种在顾客侧都是隐形的（loadCheckoutOptions 会过滤掉），
// 不显式标红店主永远不知道自己配的赠品其实没人看得见。
// ⚠️ 键是 `Product.status` 的原值 `ON_SHELF`/`OFF_SHELF`，不是赠品自身开关的 `ON`/`OFF`。
// 写成后者时 tsc 拦不住（类型曾经就是错的），运行期直接 `undefined.cls` 整页白屏。
const PRODUCT_STATUS: Record<PointsGood['productStatus'], { label: string; cls: string; invisible: boolean }> = {
  ON_SHELF: { label: '在架', cls: 'bg-green-50 text-green-700 border-green-200', invisible: false },
  OFF_SHELF: { label: '已下架', cls: 'bg-amber-50 text-amber-700 border-amber-300', invisible: true },
  DELETED: { label: '已删除', cls: 'bg-red-50 text-red-700 border-red-300', invisible: true },
  MISSING: { label: '商品缺失', cls: 'bg-red-50 text-red-700 border-red-300', invisible: true },
}
/** 查不到就给一个能显示的回落值：一个没见过的状态字面量不该让整页崩掉 */
const productStatusOf = (v: PointsGood['productStatus']) =>
  PRODUCT_STATUS[v] ?? { label: v, cls: 'bg-gray-100 text-gray-600 border-gray-300', invisible: true }
const INVISIBLE_HINT = '顾客端不会显示这条赠品'

/** 合法整数 → number；空/非法/越界 → undefined（交给调用方报错） */
function parseIntIn(input: string, min: number, max: number): number | undefined {
  const v = input.trim()
  if (!/^-?\d+$/.test(v)) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) return undefined
  return n
}

const skuCount = (p: Product | null) => p?.skus?.length ?? 0
const goodTitle = (g: PointsGood) => g.productName ?? `商品 #${g.productId}`
const channelLabel = (c: string | null) => (c ? (CHANNEL_LABEL[c as Channel] ?? c) : '—')

interface FormState {
  pointsCost: string
  perOrderLimit: string
  stockLimit: string
  sortOrder: string
  status: OnOff
}
const emptyForm: FormState = { pointsCost: '', perOrderLimit: '1', stockLimit: '', sortOrder: '0', status: 'ON' }

const Thumb = ({ src, size }: { src: string | null; size: string }) =>
  src ? (
    <img src={src} alt="" className={`${size} rounded object-cover bg-gray-100 shrink-0`} />
  ) : (
    <span className={`${size} rounded bg-gray-100 shrink-0 inline-block`} />
  )

/** 启用/停用开关。定义在组件外，避免每次渲染都换一个组件类型把 DOM 拆了重建 */
const StatusSwitch = ({
  on,
  disabled,
  big = false,
  onClick,
}: {
  on: boolean
  disabled: boolean
  big?: boolean
  onClick: () => void
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    role="switch"
    aria-checked={on}
    title={on ? '点击停用' : '点击启用'}
    className={`relative inline-flex ${big ? 'h-6 w-11' : 'h-5 w-9'} shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
      on ? 'bg-green-500' : 'bg-gray-300'
    }`}
  >
    <span
      className={`inline-block ${big ? 'h-5 w-5' : 'h-4 w-4'} rounded-full bg-white shadow transform transition-transform ${
        on ? (big ? 'translate-x-5' : 'translate-x-4') : 'translate-x-0.5'
      }`}
    />
  </button>
)

/**
 * 积分价旁边的等值消费提示 —— 店主定价时唯一的参照物。
 * 积分价放到后台可调之后，没有这条提示就只能凭感觉填数字，很容易定出离谱的回报率。
 * earnRatePerYuan 取不到时只显示积分数、不显示估算（编一个默认值只会误导定价）。
 */
function PointsValueHint({
  pointsCost,
  earnRate,
  unitPriceFen,
}: {
  pointsCost: number | undefined
  earnRate: number | null
  unitPriceFen: number | null
}) {
  if (earnRate === null || !(earnRate > 0)) {
    return (
      <p className="mt-1 text-xs text-gray-400">
        取不到「每消费 1 元得多少分」，无法估算等值消费金额（会员设置里配好后这里会自动出现）
      </p>
    )
  }
  if (pointsCost === undefined || pointsCost <= 0) {
    return <p className="mt-1 text-xs text-gray-400">填入积分价后这里显示等值消费金额</p>
  }
  const yuan = pointsCost / earnRate
  const rate = unitPriceFen !== null && yuan > 0 ? ((unitPriceFen / 100) / yuan) * 100 : null
  const high = rate !== null && rate > 30
  return (
    <p className={`mt-1 text-xs ${high ? 'text-amber-600' : 'text-gray-500'}`}>
      ≈ 消费 ¥{yuan.toFixed(2)} 可得
      {rate !== null ? ` · 回报率 ${rate.toFixed(rate >= 10 ? 0 : 1)}%` : null}
      {rate === null ? <span className="text-gray-400">（商品售价未知，算不出回报率）</span> : null}
      {high ? <span className="block">回报率偏高，确认是否有意为之</span> : null}
    </p>
  )
}

export default function PointsGoods() {
  const [list, setList] = useState<PointsGood[]>([])
  const [loading, setLoading] = useState(true)
  // 没有 catch 的话接口一挂就渲染「暂无赠品」，店主会以为配置被清空了
  const [loadFailed, setLoadFailed] = useState(false)
  // 每消费 1 元得多少分；null = 没取到，此时不显示任何估算
  const [earnRate, setEarnRate] = useState<number | null>(null)
  const [filterChannel, setFilterChannel] = useState<Channel | ''>('')
  const [filterStatus, setFilterStatus] = useState<OnOff | ''>('')
  const [page, setPage] = useState(1)
  const pageSize = 20

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<PointsGood | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [togglingId, setTogglingId] = useState<number | null>(null)

  // 新建：内联的商品选择（本页是唯一用处，不抽通用组件）
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<Product[]>([])
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState<Product | null>(null)
  const [pickedSku, setPickedSku] = useState<ProductSku | null>(null)
  const searchSeq = useRef(0)

  /** 编辑态的商品售价：列表接口直接给（`unitPrice`），不用回查商品列表 */
  const [editPrice, setEditPrice] = useState<number | null>(null)

  const load = () => {
    setLoading(true)
    setLoadFailed(false)
    getPointsGoods()
      .then(setList)
      .catch(() => {
        setLoadFailed(true)
        toast.error('赠品列表加载失败，请刷新重试')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    getMemberSettings()
      .then((s) => setEarnRate(s.points.earnRatePerYuan))
      .catch(() => setEarnRate(null))
  }, [])

  // 已配置过的 (商品, 规格) —— 服务端会拦重复，这里先标出来，省得店主选完才被打回
  const configuredKeys = new Set(list.map((g) => `${g.productId}:${g.skuId ?? ''}`))
  const filteredGoods = list.filter((good) =>
    (!filterChannel || good.productChannel === filterChannel) &&
    (!filterStatus || good.status === filterStatus)
  )
  const pageGoods = filteredGoods.slice((page - 1) * pageSize, page * pageSize)

  const runSearch = (kw: string) => {
    const seq = ++searchSeq.current
    setSearching(true)
    getProducts({ keyword: kw.trim() || undefined, pageSize: 20 })
      .then((res) => {
        if (seq !== searchSeq.current) return // 打字快时旧请求后到，别覆盖新结果
        setResults(res.data.data.list)
      })
      .catch(() => {
        if (seq !== searchSeq.current) return
        setResults([])
        toast.error('商品搜索失败，请重试')
      })
      .finally(() => {
        if (seq === searchSeq.current) setSearching(false)
      })
  }

  // 新建弹窗开着且还没选商品时，关键词变化后延迟搜索
  useEffect(() => {
    if (!showModal || editing || picked) return
    const t = setTimeout(() => runSearch(keyword), 300)
    return () => clearTimeout(t)
  }, [keyword, showModal, editing, picked]) // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm)
    setError('')
    setKeyword('')
    setResults([])
    setPicked(null)
    setPickedSku(null)
    setEditPrice(null)
    setShowModal(true)
  }

  const openEdit = (g: PointsGood) => {
    setEditing(g)
    setForm({
      pointsCost: String(g.pointsCost),
      perOrderLimit: String(g.perOrderLimit),
      stockLimit: g.stockLimit === null ? '' : String(g.stockLimit),
      sortOrder: String(g.sortOrder),
      status: g.status,
    })
    setError('')
    setPicked(null)
    setPickedSku(null)
    // 售价随列表一起来（服务端联查时 select 了 price，SKU 分支取 sku.price）。
    // 商品已删除时服务端给 null，提示会自动降级成「只有等值消费、没有回报率」。
    setEditPrice(g.unitPrice)
    setShowModal(true)
  }

  const pickProduct = (p: Product) => {
    setPicked(p)
    // 只有一个规格就直接替店主选掉
    setPickedSku(skuCount(p) === 1 ? (p.skus?.[0] ?? null) : null)
    setError('')
  }

  const unitPriceFen = editing
    ? editPrice
    : picked
      ? skuCount(picked) > 0
        ? (pickedSku?.price ?? null)
        : picked.price
      : null

  const handleSave = async () => {
    const pointsCost = parseIntIn(form.pointsCost, 1, 100000000)
    if (pointsCost === undefined) {
      setError('积分价请填 1 ~ 100000000 的整数')
      return
    }
    const perOrderLimit = parseIntIn(form.perOrderLimit, 1, 99)
    if (perOrderLimit === undefined) {
      setError('每单限购请填 1 ~ 99 的整数')
      return
    }
    const sortOrder = form.sortOrder.trim() === '' ? 0 : parseIntIn(form.sortOrder, -9999, 9999)
    if (sortOrder === undefined) {
      setError('排序请填 -9999 ~ 9999 的整数')
      return
    }
    const stockLimit = form.stockLimit.trim() === '' ? null : parseIntIn(form.stockLimit, 1, 1000000)
    if (stockLimit === undefined) {
      setError('总量请留空（不限）或填 1 ~ 1000000 的整数')
      return
    }

    let skuId: number | null = null
    if (!editing) {
      if (!picked) {
        setError('请先选择商品')
        return
      }
      if (skuCount(picked) > 0) {
        if (!pickedSku) {
          setError('该商品有规格，请选择具体规格')
          return
        }
        if (!pickedSku.id) {
          setError('该规格缺少 ID，请刷新页面后重试')
          return
        }
        skuId = pickedSku.id
      }
    }

    setError('')
    setSaving(true)
    try {
      if (editing) {
        await updatePointsGood(editing.id, { pointsCost, perOrderLimit, stockLimit, sortOrder, status: form.status })
        toast.success('已保存')
      } else {
        await createPointsGood({
          productId: picked!.id,
          skuId,
          pointsCost,
          perOrderLimit,
          stockLimit,
          sortOrder,
          status: form.status,
        })
        toast.success('已新增赠品')
      }
      setShowModal(false)
      load()
    } catch (err) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '操作失败')
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (g: PointsGood) => {
    const next: OnOff = g.status === 'ON' ? 'OFF' : 'ON'
    setTogglingId(g.id)
    try {
      await updatePointsGood(g.id, { status: next })
      // PUT 只返回 PointsGood 本体（没有 productName 等联查字段），不能整行覆盖，只打这一个字段
      setList((prev) => prev.map((x) => (x.id === g.id ? { ...x, status: next } : x)))
      toast.success(next === 'ON' ? '已启用' : '已停用')
    } catch (err) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '操作失败')
    } finally {
      setTogglingId(null)
    }
  }

  const handleDelete = async (g: PointsGood) => {
    const ok = await confirmDialog({
      title: `删除赠品「${goodTitle(g)}${g.specText ? ` ${g.specText}` : ''}」？`,
      content:
        '删除只是撤掉这条配置，已经下单的赠品不受影响，历史订单照常显示。删除后顾客在结算页不能再用积分加购这件商品。',
      danger: true,
      confirmText: '删除',
    })
    if (!ok) return
    try {
      await deletePointsGood(g.id)
      toast.success('已删除')
      load()
    } catch (err) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '删除失败')
    }
  }

  const pointsCostNum = parseIntIn(form.pointsCost, 1, 100000000)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-700">随单赠品</p>
          <p className="text-xs text-gray-500 mt-0.5">
            顾客在结算页用积分加购、跟着付费订单一起送出；不是单独的 0 元兑换单。
          </p>
        </div>
        <Button onClick={openCreate} className="shrink-0">
          <Plus className="w-4 h-4" />
          新增赠品
        </Button>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">渠道</label>
          <select value={filterChannel} onChange={(e) => { setFilterChannel(e.target.value as Channel | ''); setPage(1) }} className="border border-gray-300 rounded-md px-3 py-1.5 text-sm">
            <option value="">全部</option>
            <option value="EXPRESS">全国邮寄</option>
            <option value="LOCAL">同城配送</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">状态</label>
          <select value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value as OnOff | ''); setPage(1) }} className="border border-gray-300 rounded-md px-3 py-1.5 text-sm">
            <option value="">全部</option>
            <option value="ON">启用</option>
            <option value="OFF">停用</option>
          </select>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-card overflow-hidden">
        {loadFailed ? (
          <div className="py-10 flex flex-col items-center gap-3 text-sm text-red-600">
            <span>赠品列表加载失败，当前显示的不是真实数据</span>
            <Button size="sm" variant="secondary" onClick={load}>
              重试
            </Button>
          </div>
        ) : (
          <Table
            columns={8}
            loading={loading}
            isEmpty={pageGoods.length === 0}
            emptyText="还没有配置随单赠品"
            head={
              <tr>
                <th className="text-left px-4 py-3">商品</th>
                <th className="text-left px-4 py-3">渠道</th>
                <th className="text-right px-4 py-3">积分价</th>
                <th className="text-right px-4 py-3">每单限购</th>
                <th className="text-right px-4 py-3">总量</th>
                <th className="text-left px-4 py-3">商品状态</th>
                <th className="text-right px-4 py-3">状态</th>
                <th className="text-right px-4 py-3">操作</th>
              </tr>
            }
            mobileCards={
              <>
                {pageGoods.map((g) => {
                  const ps = productStatusOf(g.productStatus)
                  return (
                    <div key={g.id} className="border border-gray-100 rounded-lg p-3 flex gap-3">
                      <Thumb src={g.productImage} size="w-12 h-12" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium text-gray-800 truncate">{goodTitle(g)}</p>
                          <StatusSwitch
                            on={g.status === 'ON'}
                            disabled={togglingId === g.id}
                            big
                            onClick={() => handleToggle(g)}
                          />
                        </div>
                        {g.specText && <p className="text-xs text-gray-500 mt-0.5 truncate">{g.specText}</p>}
                        <p className="text-xs text-gray-500 mt-1">
                          <span className="text-brand-600 font-semibold">{g.pointsCost} 分</span>
                          {`　每单 ${g.perOrderLimit} 件`}
                          {`　总量 ${g.stockLimit === null ? '不限' : `${g.issuedCount}/${g.stockLimit}`}`}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
                            {channelLabel(g.productChannel)}
                          </span>
                          <span className={`px-1.5 py-0.5 rounded border text-xs ${ps.cls}`}>{ps.label}</span>
                          {ps.invisible && <span className="text-xs text-red-600">{INVISIBLE_HINT}</span>}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                          <button onClick={() => openEdit(g)} className="text-blue-500">
                            编辑
                          </button>
                          <button
                            onClick={() => handleToggle(g)}
                            disabled={togglingId === g.id}
                            className="text-gray-600 disabled:opacity-40"
                          >
                            {g.status === 'ON' ? '停用' : '启用'}
                          </button>
                          <button onClick={() => handleDelete(g)} className="text-red-500">
                            删除
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </>
            }
          >
            {pageGoods.map((g) => {
              const ps = productStatusOf(g.productStatus)
              return (
                <tr key={g.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Thumb src={g.productImage} size="w-10 h-10" />
                      <div className="min-w-0">
                        <p className="text-gray-800 truncate">{goodTitle(g)}</p>
                        {g.specText && <p className="text-xs text-gray-500 truncate">{g.specText}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{channelLabel(g.productChannel)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-brand-600">{g.pointsCost}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{g.perOrderLimit}</td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {g.stockLimit === null ? '不限' : `${g.issuedCount}/${g.stockLimit}`}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full border text-xs whitespace-nowrap ${ps.cls}`}>
                      {ps.label}
                    </span>
                    {ps.invisible && <p className="mt-1 text-xs text-red-600">{INVISIBLE_HINT}</p>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <StatusSwitch
                      on={g.status === 'ON'}
                      disabled={togglingId === g.id}
                      onClick={() => handleToggle(g)}
                    />
                  </td>
                  <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                    <button onClick={() => openEdit(g)} className="text-blue-500 hover:text-blue-700">
                      编辑
                    </button>
                    <button
                      onClick={() => handleToggle(g)}
                      disabled={togglingId === g.id}
                      className="text-gray-600 hover:text-gray-800 disabled:opacity-40"
                    >
                      {g.status === 'ON' ? '停用' : '启用'}
                    </button>
                    <button onClick={() => handleDelete(g)} className="text-red-500 hover:text-red-700">
                      删除
                    </button>
                  </td>
                </tr>
              )
            })}
        </Table>
        )}
        {!loading && !loadFailed && <Pagination page={page} total={filteredGoods.length} pageSize={pageSize} onChange={setPage} />}
      </div>

      {showModal && (
        <Modal
          title={editing ? '编辑赠品' : '新增赠品'}
          onClose={() => setShowModal(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setShowModal(false)}>
                取消
              </Button>
              <Button loading={saving} onClick={handleSave}>
                {saving ? '保存中...' : '保存'}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            {/* ── 商品：新建时选，编辑时只读 ────────────────────────────── */}
            {editing ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">商品</label>
                <div className="flex items-center gap-3 border border-gray-200 bg-gray-50 rounded-md px-3 py-2">
                  <Thumb src={editing.productImage} size="w-10 h-10" />
                  <div className="min-w-0">
                    <p className="text-sm text-gray-800 truncate">{goodTitle(editing)}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {editing.specText ?? '无规格'} · {channelLabel(editing.productChannel)}
                    </p>
                  </div>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  商品与规格建后不可改（改了就是换了一件商品）。要换商品请删掉这条重新建。
                </p>
              </div>
            ) : picked ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">商品</label>
                <div className="flex items-center gap-3 border border-gray-200 rounded-md px-3 py-2">
                  <Thumb src={picked.coverImage} size="w-10 h-10" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-800 truncate">{picked.name}</p>
                    <p className="text-xs text-gray-500 truncate">
                      ¥{(picked.price / 100).toFixed(2)} · {channelLabel(picked.channel)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    onClick={() => {
                      setPicked(null)
                      setPickedSku(null)
                    }}
                  >
                    重选
                  </Button>
                </div>

                {skuCount(picked) > 0 && (
                  <div className="mt-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">规格 *</label>
                    <div className="flex flex-wrap gap-2">
                      {(picked.skus ?? []).map((s) => {
                        const dup = configuredKeys.has(`${picked.id}:${s.id ?? ''}`)
                        const on = pickedSku?.id === s.id
                        return (
                          <button
                            key={s.id ?? s.specText}
                            type="button"
                            onClick={() => setPickedSku(s)}
                            className={`px-2.5 py-1.5 rounded-md border text-xs ${
                              on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-gray-300 text-gray-700'
                            }`}
                          >
                            {s.specText} · ¥{(s.price / 100).toFixed(2)}
                            {dup && <span className="ml-1 text-amber-600">已配置</span>}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">选择商品 *</label>
                <div className="relative">
                  <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && runSearch(keyword)}
                    placeholder="搜索商品名称"
                    className={`${inputCls} pl-9`}
                  />
                </div>
                <div className="mt-2 border border-gray-200 rounded-md divide-y divide-gray-100 max-h-64 overflow-y-auto">
                  {searching ? (
                    <p className="px-3 py-6 text-center text-sm text-gray-400">搜索中...</p>
                  ) : results.length === 0 ? (
                    <p className="px-3 py-6 text-center text-sm text-gray-400">没有匹配的商品</p>
                  ) : (
                    results.map((p) => {
                      const dup = skuCount(p) === 0 && configuredKeys.has(`${p.id}:`)
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => pickProduct(p)}
                          className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-50"
                        >
                          <Thumb src={p.coverImage} size="w-9 h-9" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-gray-800 truncate">
                              {p.name}
                              {skuCount(p) > 0 && (
                                <span className="ml-1.5 px-1.5 py-0.5 rounded text-xs bg-brand-50 text-brand-600">
                                  {skuCount(p)} 规格
                                </span>
                              )}
                              {dup && <span className="ml-1.5 text-xs text-amber-600">已配置</span>}
                            </p>
                            <p className="text-xs text-gray-500 truncate">
                              ¥{(p.price / 100).toFixed(2)} · {channelLabel(p.channel)} ·{' '}
                              {p.status === 'ON_SHELF' ? '在架' : '已下架'}
                            </p>
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-500">赠品渠道跟着商品走，选定后不能单独改。</p>
              </div>
            )}

            {/* ── 参数 ────────────────────────────────────────────────── */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">积分价 *</label>
              <input
                type="number"
                min={1}
                max={100000000}
                value={form.pointsCost}
                onChange={(e) => setForm({ ...form, pointsCost: e.target.value })}
                placeholder="加购一件要花多少积分"
                className={inputCls}
              />
              <PointsValueHint pointsCost={pointsCostNum} earnRate={earnRate} unitPriceFen={unitPriceFen} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">每单限购</label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={form.perOrderLimit}
                  onChange={(e) => setForm({ ...form, perOrderLimit: e.target.value })}
                  className={inputCls}
                />
                <p className="mt-1 text-xs text-gray-500">一张订单里最多加购几件（1 ~ 99）</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">总量</label>
                <input
                  type="number"
                  min={1}
                  max={1000000}
                  value={form.stockLimit}
                  onChange={(e) => setForm({ ...form, stockLimit: e.target.value })}
                  placeholder="留空 = 不限"
                  className={inputCls}
                />
                <p className="mt-1 text-xs text-gray-500">
                  {editing ? `累计上限，已送出 ${editing.issuedCount} 件；留空 = 不限` : '累计送出上限，留空 = 不限'}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">排序</label>
                <input
                  type="number"
                  min={-9999}
                  max={9999}
                  value={form.sortOrder}
                  onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                  className={inputCls}
                />
                <p className="mt-1 text-xs text-gray-500">数字小的排前面</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as OnOff })}
                  className={inputCls}
                >
                  <option value="ON">启用</option>
                  <option value="OFF">停用</option>
                </select>
                <p className="mt-1 text-xs text-gray-500">停用后顾客结算页不再显示这条赠品</p>
              </div>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        </Modal>
      )}
    </div>
  )
}
