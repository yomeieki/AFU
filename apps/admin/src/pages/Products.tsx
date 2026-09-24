import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Search, Download, QrCode, GripVertical, ArrowUp, ArrowDown } from 'lucide-react'
import { getProducts, getCategories, createProduct, updateProduct, deleteProduct, generateQrCode, batchGenerateQrCodes, batchProductStatus, getLocalSettings, updateCategory, reorderCategoryProducts } from '../api/admin'
import ImageUploader from '../components/ImageUploader'
import { CenterAction } from '../components/BusinessCenter'
import SpecEditor, { type SkuRow } from '../components/SpecEditor'
import Button from '../components/ui/Button'
import Modal from '../components/ui/Modal'
import Table from '../components/ui/Table'
import Pagination from '../components/ui/Pagination'
import ChannelTabs from '../components/ui/ChannelTabs'
import { CHANNEL_LABEL, type Product, type Category, type SpecDimension, type Channel, type ProductSortMode } from '../types'
import { toast } from '../components/ui/Toast'
import QRCodeLib from 'qrcode'
import { confirmDialog } from '../components/ui/ConfirmDialog'
import { fmtDateTime } from '../utils/time'
import { readChannel } from '../navigation'
import { moveItem, moveAdjacent } from '../utils/reorder'
import { stockAlertLabel } from '../utils/stock-alert'

const emptyForm = {
  categoryId: 0,
  name: '',
  subtitle: '',
  coverImage: '',
  imageUrls: [] as string[],
  price: '',
  originalPrice: '',
  stock: 0,
  unit: '份',
  weight: '',
  shelfLife: '',
  storageMethod: '',
  deliveryInfo: '',
  description: '',
  netWeightG: '',
  packingFeeFen: '',
  status: 'ON_SHELF' as 'ON_SHELF' | 'OFF_SHELF',
  isRecommended: 0,
}

export default function Products() {
  const [searchParams, setSearchParams] = useSearchParams()
  const channel = readChannel(searchParams)
  const [list, setList] = useState<Product[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [categories, setCategories] = useState<Category[]>([])
  const channelCategories = categories.filter((c) => c.channel === channel)
  const [filterCategoryId, setFilterCategoryId] = useState('')
  const [filterKeyword, setFilterKeyword] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  // 已生效的筛选（点「搜索」/ 首次加载 / 切渠道时才更新）——排序控件只看这份，不看上面三个
  // 输入态，否则切了分类但还没点搜索时控件就会拿旧列表数据误判（常见路径：误报「超过 200
  // 道，暂不支持拖拽」；个别情况下还能真拖出跨分类 ids 被服务端 40001 挡回）。
  const [applied, setApplied] = useState({ categoryId: '', keyword: '', status: '' })
  // 分类内排序区：只在「已生效的筛选选定了某个分类、关键词为空、状态为全部」时启用——
  // 保存接口要求 ids 是该分类的全集，列表不是全集时拖拽保存必被服务端判为非法（2026-09-17 分类内排序设计 §5）。
  const sortCategory = applied.categoryId ? channelCategories.find((c) => String(c.id) === applied.categoryId) : undefined
  const sortActive = !!sortCategory && !applied.keyword && !applied.status
  const sortModeSales = sortActive && sortCategory!.productSortMode === 'SALES_30D'
  const [sortModeSaving, setSortModeSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [specDims, setSpecDims] = useState<SpecDimension[]>([])
  const [skuRows, setSkuRows] = useState<SkuRow[]>([])
  const hasSkus = specDims.length > 0 && skuRows.length > 0
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [generatingQrId, setGeneratingQrId] = useState<number | null>(null)
  const [qrModal, setQrModal] = useState<Product | null>(null)
  // 没有 catch 的话接口一挂就渲染「暂无商品」，店主会以为商品库被清空了
  const [loadFailed, setLoadFailed] = useState(false)
  // 商品编辑页「打包费」提示要显示全店默认值；取不到就只写「全店默认」
  const [defaultPackingFen, setDefaultPackingFen] = useState<number | null>(null)
  const packingHint = defaultPackingFen != null
    ? `留空 = 跟随全店默认 ¥${(defaultPackingFen / 100).toFixed(2)}；填 0 = 这道菜不收`
    : '留空 = 跟随全店默认；填 0 = 这道菜不收'

  const setChannel = (next: Channel) => {
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous)
      params.set('channel', next)
      return params
    }, { replace: true })
  }

  // 排序区一页取完该分类全集（拖拽保存要求 ids 是全集）；其余情形维持原分页（20/页）。
  const effectivePageSize = sortActive ? 200 : pageSize
  const load = (p = page) => {
    // 本次请求实际用的筛选，同时落成「已生效的筛选」——排序控件之后只认这份，不认输入态。
    const next = { categoryId: filterCategoryId, keyword: filterKeyword, status: filterStatus }
    setApplied(next)
    const nextSortCategory = next.categoryId ? channelCategories.find((c) => String(c.id) === next.categoryId) : undefined
    const nextSortActive = !!nextSortCategory && !next.keyword && !next.status
    const nextPageSize = nextSortActive ? 200 : pageSize
    setLoading(true)
    setLoadFailed(false)
    getProducts({
      page: p,
      pageSize: nextPageSize,
      categoryId: next.categoryId ? Number(next.categoryId) : undefined,
      keyword: next.keyword || undefined,
      status: next.status || undefined,
      channel,
    })
      .then((res) => {
        setList(res.data.data.list)
        setTotal(res.data.data.total)
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false))
  }
  // 该分类商品超过一页取完的上限（200）：拖拽保存做不到「一次改全集」，禁用排序控件、只提示。
  const sortOverLimit = sortActive && total > list.length

  useEffect(() => {
    getCategories().then((res) => setCategories(res.data.data))
    getLocalSettings().then((s) => setDefaultPackingFen(s.packing.perItemFen)).catch(() => {})
  }, [])

  useEffect(() => { load() }, [page]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setFilterCategoryId(''); setPage(1); load(1) }, [channel]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    setPage(1)
    load(1)
  }

  // 切排序方式：select 的 value 直接绑定 sortCategory.productSortMode（来自 categories 状态），
  // 失败时不改 categories，select 自然回到切换前的值——不需要额外的「回退」代码。
  const handleSortModeChange = async (next: ProductSortMode) => {
    if (!sortCategory) return
    setSortModeSaving(true)
    try {
      await updateCategory(sortCategory.id, { productSortMode: next })
      setCategories((cs) => cs.map((c) => (c.id === sortCategory.id ? { ...c, productSortMode: next } : c)))
      toast.success('已切换，顾客端立刻生效')
      load(1)
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '切换失败'
      )
    } finally {
      setSortModeSaving(false)
    }
  }

  // 拖拽/上下移共用的保存：先乐观更新本地顺序，失败则回滚。next 与 list 同一引用（越界/同位）时不发请求。
  const applyOrder = async (next: Product[]) => {
    if (!sortCategory || next === list) return
    const prev = list
    setList(next)
    try {
      await reorderCategoryProducts(sortCategory.id, next.map((p) => p.id))
      toast.success('顺序已保存')
    } catch (err: unknown) {
      setList(prev)
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败，已恢复原顺序'
      )
    }
  }

  const manualDragActive = sortActive && !sortModeSales && !sortOverLimit
  // 后台列表经 sortProducts 排过，推荐菜必然连续排在最前——数开头连续 isRecommended 的行数
  // 即置顶区长度。置顶行恒在最前、不参与拖拽；非置顶行最多也只能拖到置顶区之后。
  let pinnedCount = 0
  while (pinnedCount < list.length && list[pinnedCount].isRecommended === 1) pinnedCount++
  // ↑↓ 按钮的 title：置顶行（含紧邻置顶区、上移会被挡住的第一条非置顶行）说明「为什么点不动」，
  // 其余情况维持原「按销量自动排序」提示或普通的「上移/下移」。
  const pinnedMoveTip = '推荐菜固定在整个列表最前，不参与排序'
  const moveUpTitle = (idx: number) =>
    sortModeSales ? '当前按销量自动排序，如需手动请切回手动排序' : idx <= pinnedCount ? pinnedMoveTip : '上移'
  const moveDownTitle = (idx: number) =>
    sortModeSales ? '当前按销量自动排序，如需手动请切回手动排序' : idx < pinnedCount ? pinnedMoveTip : '下移'
  const dragIndexRef = useRef<number | null>(null)
  const handleRowDragStart = (index: number) => { dragIndexRef.current = index }
  const handleRowDrop = (index: number) => {
    const from = dragIndexRef.current
    dragIndexRef.current = null
    if (from == null) return
    applyOrder(moveItem(list, from, Math.max(index, pinnedCount)))
  }

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm)
    setSpecDims([])
    setSkuRows([])
    setError('')
    setShowModal(true)
  }

  const openEdit = (p: Product) => {
    setEditing(p)
    setForm({
      categoryId: p.categoryId,
      name: p.name,
      subtitle: p.subtitle ?? '',
      coverImage: p.coverImage ?? '',
      imageUrls: p.images?.map((img) => img.imageUrl) ?? [],
      price: (p.price / 100).toString(),
      originalPrice: p.originalPrice ? (p.originalPrice / 100).toString() : '',
      stock: p.stock,
      unit: p.unit,
      weight: p.weight ?? '',
      shelfLife: p.shelfLife ?? '',
      storageMethod: p.storageMethod ?? '',
      deliveryInfo: p.deliveryInfo ?? '',
      description: p.description ?? '',
      netWeightG: p.netWeightG?.toString() ?? '',
      packingFeeFen: p.packingFeeFen != null ? (p.packingFeeFen / 100).toString() : '',
      status: p.status,
      isRecommended: p.isRecommended,
    })
    setSpecDims(p.specDimensions ?? [])
    setSkuRows(
      (p.skus ?? []).map((s) => ({
        id: s.id,
        specValues: s.specValues,
        price: (s.price / 100).toString(),
        originalPrice: s.originalPrice ? (s.originalPrice / 100).toString() : '',
        stock: s.stock,
      }))
    )
    setError('')
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.categoryId) { setError('请选择分类'); return }
    if (!form.name.trim()) { setError('请输入商品名称'); return }
    if (!hasSkus && !form.price) { setError('请输入价格'); return }
    if (specDims.length > 0) {
      if (specDims.some((d) => !d.name.trim())) { setError('请填写规格维度名'); return }
      if (skuRows.length === 0) { setError('请为规格维度添加规格值'); return }
      if (skuRows.some((r) => !r.price || parseFloat(r.price) <= 0)) { setError('请填写所有规格组合的价格'); return }
    }
    setSaving(true)
    setError('')
    try {
      const skusPayload = hasSkus
        ? skuRows.map((r, i) => ({
            ...(r.id ? { id: r.id } : {}),
            specText: r.specValues.join('/'),
            specValues: r.specValues,
            price: Math.round(parseFloat(r.price) * 100),
            originalPrice: r.originalPrice ? Math.round(parseFloat(r.originalPrice) * 100) : null,
            stock: r.stock,
            sortOrder: i,
          }))
        : []
      // 有规格时商品级价格/库存由服务端按 SKU 汇总，这里传占位聚合值以过 schema 校验
      const price = hasSkus
        ? Math.min(...skusPayload.map((s) => s.price))
        : Math.round(parseFloat(form.price) * 100)
      const stock = hasSkus ? skusPayload.reduce((sum, s) => sum + s.stock, 0) : form.stock

      const payload = {
        categoryId: Number(form.categoryId),
        name: form.name,
        subtitle: form.subtitle || null,
        coverImage: form.coverImage || null,
        imageUrls: form.imageUrls,
        price,
        originalPrice: form.originalPrice ? Math.round(parseFloat(form.originalPrice) * 100) : null,
        stock,
        unit: form.unit,
        weight: form.weight || null,
        shelfLife: form.shelfLife || null,
        storageMethod: form.storageMethod || null,
        deliveryInfo: form.deliveryInfo || null,
        description: form.description || null,
        netWeightG: form.netWeightG ? Number(form.netWeightG) : null,
        packingFeeFen: form.packingFeeFen.trim() === '' ? null : Math.round(parseFloat(form.packingFeeFen) * 100),
        status: form.status,
        isRecommended: form.isRecommended,
        specDimensions: specDims.length > 0 ? specDims : null,
        skus: skusPayload,
      }
      if (editing) {
        await updateProduct(editing.id, payload)
      } else {
        await createProduct(payload)
      }
      setShowModal(false)
      load()
    } catch (err: unknown) {
      setError(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '操作失败'
      )
    } finally {
      setSaving(false)
    }
  }

  // 上下架一键开关（可逆高频操作，不弹确认；局部更新不整页刷新）
  const handleToggleStatus = async (p: Product) => {
    const next = p.status === 'ON_SHELF' ? 'OFF_SHELF' : 'ON_SHELF'
    try {
      await updateProduct(p.id, { status: next })
      setList((ls) => ls.map((it) => (it.id === p.id ? { ...it, status: next } : it)))
      toast.success(next === 'ON_SHELF' ? `「${p.name}」已上架` : `「${p.name}」已下架`)
    } catch {
      toast.error('操作失败')
    }
  }

  // 库存快改（仅无规格商品；有 SKU 商品的 product.stock=sum(sku.stock)，须在编辑里改各规格）
  const [stockModal, setStockModal] = useState<Product | null>(null)
  const [stockValue, setStockValue] = useState(0)
  const openStockModal = (p: Product) => {
    if ((p.skus?.length ?? 0) > 0) {
      toast.info('多规格商品请在「编辑」或「库存预警」页改各规格库存')
      return
    }
    setStockModal(p)
    setStockValue(p.stock)
  }
  const handleStockSave = async () => {
    if (!stockModal) return
    const v = Math.max(0, Math.floor(stockValue))
    try {
      await updateProduct(stockModal.id, { stock: v })
      setList((ls) => ls.map((it) => (it.id === stockModal.id ? { ...it, stock: v } : it)))
      toast.success('库存已更新')
      setStockModal(null)
    } catch {
      toast.error('更新失败')
    }
  }

  const handleDelete = async (p: Product) => {
    if (!(await confirmDialog({ title: '删除商品', content: `确认删除商品「${p.name}」？`, danger: true }))) return
    try {
      await deleteProduct(p.id)
      toast.success('已删除')
      load()
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '删除失败'
      )
    }
  }

  const handleGenerateQr = async (p: Product) => {
    if (!(await confirmDialog({ title: '生成二维码', content: `为「${p.name}」生成二维码？${p.qrCodeUrl ? '（将覆盖已有二维码）' : ''}` }))) return
    setGeneratingQrId(p.id)
    try {
      await generateQrCode(p.id)
      load()
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '生成失败'
      )
    } finally {
      setGeneratingQrId(null)
    }
  }

  const isMockUrl = (url: string | null) => !url || url.startsWith('mock://')

  // mock 模式：把 scene 渲染成占位二维码（扫出的是文本 p_<id>，非真实小程序码）
  const mockCanvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    if (qrModal && isMockUrl(qrModal.qrCodeUrl) && qrModal.qrScene && mockCanvasRef.current) {
      QRCodeLib.toCanvas(mockCanvasRef.current, qrModal.qrScene, { width: 160, margin: 1 }).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrModal])

  const triggerDownload = (url: string, filename: string) => {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleDownloadQr = async (p: Product) => {
    const filename = `qrcode-p_${p.id}.png`
    try {
      if (!isMockUrl(p.qrCodeUrl)) {
        const resp = await fetch(p.qrCodeUrl!)
        const blob = await resp.blob()
        triggerDownload(URL.createObjectURL(blob), filename)
      } else if (mockCanvasRef.current) {
        mockCanvasRef.current.toBlob((blob) => {
          if (blob) triggerDownload(URL.createObjectURL(blob), filename)
        })
      }
    } catch {
      toast.error('下载失败')
    }
  }

  const handleBatchStatus = async (status: 'ON_SHELF' | 'OFF_SHELF') => {
    const catId = filterCategoryId ? Number(filterCategoryId) : undefined
    const catName = catId ? categories.find((c) => c.id === catId)?.name : undefined
    const channelLabel = CHANNEL_LABEL[channel]
    const scope = catName ? `「${channelLabel}」分类「${catName}」下` : `「${channelLabel}」下`
    const action = status === 'ON_SHELF' ? '上架（开档）' : '下架（收档）'
    const ok = await confirmDialog({
      title: `批量${action}`,
      // 开档完全可逆（收档即回滚）且是每天的高频操作，不该用「不可撤销」吓人；
      // 收档才需要把真实后果说清楚。
      content:
        status === 'OFF_SHELF'
          ? `将${scope}的所有商品${action}，顾客将立即看不到这些商品，确认继续？`
          : `将${scope}的所有商品${action}，确认继续？`,
      danger: status === 'OFF_SHELF',
    })
    if (!ok) return
    try {
      const res = await batchProductStatus(status, catId, channel)
      toast.success(`已${action} ${res.data.data.updated} 个商品`)
      load()
    } catch {
      toast.error('操作失败')
    }
  }

  const [batchGenerating, setBatchGenerating] = useState(false)
  const handleBatchQr = async () => {
    const ok = await confirmDialog({
      title: '批量生成二维码',
      content: '将为所有暂无二维码的上架商品生成二维码，确认继续？',
    })
    if (!ok) return
    setBatchGenerating(true)
    try {
      const res = await batchGenerateQrCodes()
      const { generated, failed } = res.data.data
      toast.success(`已生成 ${generated} 个${failed.length ? `，失败 ${failed.length} 个` : ''}`)
      load()
    } catch {
      toast.error('批量生成失败')
    } finally {
      setBatchGenerating(false)
    }
  }

  return (
    <div className="space-y-4">
      <CenterAction>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4" />
          新增商品
        </Button>
      </CenterAction>

      <ChannelTabs value={channel} onChange={setChannel} />

      <div className="bg-white rounded-lg shadow-sm p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">分类</label>
          <select
            value={filterCategoryId}
            onChange={(e) => setFilterCategoryId(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm"
          >
            <option value="">全部</option>
            {channelCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">关键词</label>
          <input
            value={filterKeyword}
            onChange={(e) => setFilterKeyword(e.target.value)}
            placeholder="搜索商品名称"
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-40"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">状态</label>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm"
          >
            <option value="">全部</option>
            <option value="ON_SHELF">上架</option>
            <option value="OFF_SHELF">下架</option>
          </select>
        </div>
        {sortActive && sortCategory && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">排序方式</label>
            <select
              value={sortCategory.productSortMode}
              disabled={sortModeSaving}
              onChange={(e) => handleSortModeChange(e.target.value as ProductSortMode)}
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
            >
              <option value="MANUAL">手动排序</option>
              <option value="SALES_30D">按近 30 天销量</option>
            </select>
            {sortModeSales && (
              <p className="text-xs text-gray-400 mt-1">当前按销量自动排序，如需手动请切回手动排序</p>
            )}
            {sortOverLimit && (
              <p className="text-xs text-amber-600 mt-1">本分类商品超过 200 道，暂不支持拖拽</p>
            )}
          </div>
        )}
        <Button variant="secondary" size="sm" onClick={handleSearch}>
          <Search className="w-4 h-4" />
          搜索
        </Button>
        <Button variant="secondary" size="sm" loading={batchGenerating} onClick={handleBatchQr}>
          <QrCode className="w-4 h-4" />
          批量生成二维码
        </Button>
        <Button variant="secondary" size="sm" onClick={() => handleBatchStatus('ON_SHELF')}>
          一键开档
        </Button>
        <Button variant="secondary" size="sm" onClick={() => handleBatchStatus('OFF_SHELF')}>
          一键收档
        </Button>
      </div>

      <div className="bg-white rounded-lg shadow-card overflow-hidden">
        {loadFailed ? (
          <div className="py-10 flex flex-col items-center gap-3 text-sm text-red-600">
            <span>商品列表加载失败，当前显示的不是真实数据</span>
            <Button size="sm" variant="secondary" onClick={() => load()}>重试</Button>
          </div>
        ) : (
        <Table
          columns={sortActive ? 9 : 8}
          loading={loading}
          isEmpty={list.length === 0}
          emptyText="暂无商品"
          head={
            <tr>
              {/* 固定宽度：这一列要容纳「推荐·置顶」徽标或拖拽把手，宽度按徽标撑满算，
                  避免同分类下有/无置顶商品切换、或换分类时列宽跟着跳动。 */}
              {sortActive && <th className="w-24 px-2 py-3" />}
              <th className="text-left px-4 py-3">商品名称</th>
              <th className="text-left px-4 py-3">分类</th>
              <th className="text-right px-4 py-3">价格</th>
              <th className="text-right px-4 py-3">库存</th>
              <th className="text-right px-4 py-3">{sortModeSales ? '近 30 天销量' : '销量'}</th>
              <th className="text-right px-4 py-3">状态</th>
              <th className="text-right px-4 py-3">二维码</th>
              <th className="text-right px-4 py-3">操作</th>
            </tr>
          }
          mobileCards={
            <>
              {list.map((p, idx) => (
                <div key={p.id} className="border border-gray-100 rounded-lg p-3 flex gap-3">
                  {p.coverImage ? (
                    <img src={p.coverImage} alt="" className="w-12 h-12 rounded object-cover bg-gray-100 shrink-0" />
                  ) : (
                    <span className="w-12 h-12 rounded bg-gray-100 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-gray-800 truncate">
                        {p.name}
                        {(p.skus?.length ?? 0) > 0 && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded text-xs bg-brand-50 text-brand-600">
                            {p.skus!.length} 规格
                          </span>
                        )}
                        {stockAlertLabel(p.stockAlert ?? { out: 0, low: 0 }, (p.skus?.length ?? 0) > 0) && (
                          <span
                            className={`ml-1.5 px-1.5 py-0.5 rounded text-xs ${
                              (p.stockAlert?.out ?? 0) > 0 ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'
                            }`}
                          >
                            {stockAlertLabel(p.stockAlert ?? { out: 0, low: 0 }, (p.skus?.length ?? 0) > 0)}
                          </span>
                        )}
                      </p>
                      <button
                        onClick={() => handleToggleStatus(p)}
                        role="switch"
                        aria-checked={p.status === 'ON_SHELF'}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                          p.status === 'ON_SHELF' ? 'bg-green-500' : 'bg-gray-300'
                        }`}
                      >
                        <span
                          className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ${
                            p.status === 'ON_SHELF' ? 'translate-x-5' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      <span className="text-brand-600 font-semibold">
                        ¥{((p.skus?.length ? Math.min(...p.skus.map((sk) => sk.price)) : p.price) / 100).toFixed(2)}
                      </span>
                      {'　'}
                      <button
                        onClick={() => openStockModal(p)}
                        className={`underline decoration-dotted underline-offset-2 ${
                          (p.stockAlert?.out ?? 0) > 0
                            ? 'text-red-500 font-semibold'
                            : (p.stockAlert?.low ?? 0) > 0
                              ? 'text-amber-600 font-semibold'
                              : ''
                        }`}
                      >
                        库存 {p.stock}
                        {(p.skus?.length ?? 0) > 0 && <span className="text-gray-400">(规格)</span>}
                      </button>
                      {`　已售 ${p.salesCount}`}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                      <button onClick={() => openEdit(p)} className="text-blue-500">编辑</button>
                      <button
                        onClick={() => handleGenerateQr(p)}
                        disabled={generatingQrId === p.id}
                        className="text-purple-500 disabled:opacity-40"
                      >
                        {generatingQrId === p.id ? '生成中...' : '生成二维码'}
                      </button>
                      {p.qrCodeUrl && (
                        <button onClick={() => setQrModal(p)} className="text-indigo-500">查看</button>
                      )}
                      <button onClick={() => handleDelete(p)} className="text-red-500">删除</button>
                      {sortActive && (
                        <>
                          {idx < pinnedCount && (
                            <span
                              title={pinnedMoveTip}
                              className="inline-block px-1.5 py-0.5 rounded text-xs bg-amber-50 text-amber-600 whitespace-nowrap"
                            >
                              推荐·置顶
                            </span>
                          )}
                          <button
                            onClick={() => applyOrder(moveAdjacent(list, idx, -1))}
                            disabled={!manualDragActive || idx <= pinnedCount}
                            title={moveUpTitle(idx)}
                            className="text-gray-500 disabled:opacity-30"
                          >
                            ↑
                          </button>
                          <button
                            onClick={() => applyOrder(moveAdjacent(list, idx, 1))}
                            disabled={!manualDragActive || idx < pinnedCount || idx === list.length - 1}
                            title={moveDownTitle(idx)}
                            className="text-gray-500 disabled:opacity-30"
                          >
                            ↓
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </>
          }
        >
          {list.map((p, idx) => (
            <tr
              key={p.id}
              className="hover:bg-gray-50"
              draggable={manualDragActive && idx >= pinnedCount}
              onDragStart={manualDragActive && idx >= pinnedCount ? () => handleRowDragStart(idx) : undefined}
              onDragOver={manualDragActive ? (e) => e.preventDefault() : undefined}
              onDrop={manualDragActive ? () => handleRowDrop(idx) : undefined}
            >
              {sortActive && (
                <td className="px-2 py-3 text-center">
                  {idx < pinnedCount ? (
                    <span
                      title="勾了推荐的菜固定在整个列表最前，不参与拖拽"
                      className="inline-block px-1.5 py-0.5 rounded text-xs bg-amber-50 text-amber-600 whitespace-nowrap"
                    >
                      推荐·置顶
                    </span>
                  ) : (
                    <span title={sortModeSales ? '当前按销量自动排序，如需手动请切回手动排序' : '拖拽调整顺序'}>
                      <GripVertical
                        className={`w-4 h-4 inline-block ${manualDragActive ? 'text-gray-400 cursor-grab' : 'text-gray-200'}`}
                      />
                    </span>
                  )}
                </td>
              )}
              <td className="px-4 py-3 text-gray-800">
                {p.name}
                {(p.skus?.length ?? 0) > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded text-xs bg-brand-50 text-brand-600">
                    {p.skus!.length} 规格
                  </span>
                )}
                {stockAlertLabel(p.stockAlert ?? { out: 0, low: 0 }, (p.skus?.length ?? 0) > 0) && (
                  <span
                    className={`ml-1.5 px-1.5 py-0.5 rounded text-xs ${
                      (p.stockAlert?.out ?? 0) > 0 ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'
                    }`}
                  >
                    {stockAlertLabel(p.stockAlert ?? { out: 0, low: 0 }, (p.skus?.length ?? 0) > 0)}
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-gray-500">{p.category?.name}</td>
              <td className="px-4 py-3 text-right font-semibold text-brand-600">
                {(() => {
                  const skus = p.skus ?? []
                  if (skus.length === 0) return `¥${(p.price / 100).toFixed(2)}`
                  const min = Math.min(...skus.map((s) => s.price))
                  const max = Math.max(...skus.map((s) => s.price))
                  return min === max
                    ? `¥${(min / 100).toFixed(2)}`
                    : `¥${(min / 100).toFixed(2)}~${(max / 100).toFixed(2)}`
                })()}
              </td>
              <td className="px-4 py-3 text-right">
                <button
                  onClick={() => openStockModal(p)}
                  className={`hover:text-brand-600 underline decoration-dotted underline-offset-2 ${
                    (p.stockAlert?.out ?? 0) > 0
                      ? 'text-red-500 font-semibold'
                      : (p.stockAlert?.low ?? 0) > 0
                        ? 'text-amber-600 font-semibold'
                        : 'text-gray-700'
                  }`}
                  title={(p.skus?.length ?? 0) > 0 ? '多规格商品在编辑中改库存' : '点击修改库存'}
                >
                  {p.stock}
                  {(p.skus?.length ?? 0) > 0 && <span className="ml-0.5 text-xs text-gray-400">规</span>}
                </button>
              </td>
              <td className="px-4 py-3 text-right text-gray-600">{sortModeSales ? (p.sales30d ?? 0) : p.salesCount}</td>
              <td className="px-4 py-3 text-right">
                <button
                  onClick={() => handleToggleStatus(p)}
                  role="switch"
                  aria-checked={p.status === 'ON_SHELF'}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    p.status === 'ON_SHELF' ? 'bg-green-500' : 'bg-gray-300'
                  }`}
                  title={p.status === 'ON_SHELF' ? '点击下架' : '点击上架'}
                >
                  <span
                    className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                      p.status === 'ON_SHELF' ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </td>
              <td className="px-4 py-3 text-right">
                <span className={`px-2 py-0.5 rounded-full text-xs ${p.qrCodeUrl ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-400'}`}>
                  {p.qrCodeUrl ? '已生成' : '未生成'}
                </span>
              </td>
              <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                {sortActive && (
                  <>
                    <button
                      onClick={() => applyOrder(moveAdjacent(list, idx, -1))}
                      disabled={!manualDragActive || idx <= pinnedCount}
                      title={moveUpTitle(idx)}
                      className="text-gray-500 hover:text-gray-700 disabled:opacity-30"
                    >
                      <ArrowUp className="w-3.5 h-3.5 inline" />
                    </button>
                    <button
                      onClick={() => applyOrder(moveAdjacent(list, idx, 1))}
                      disabled={!manualDragActive || idx < pinnedCount || idx === list.length - 1}
                      title={moveDownTitle(idx)}
                      className="text-gray-500 hover:text-gray-700 disabled:opacity-30"
                    >
                      <ArrowDown className="w-3.5 h-3.5 inline" />
                    </button>
                  </>
                )}
                <button onClick={() => openEdit(p)} className="text-blue-500 hover:text-blue-700">编辑</button>
                <button
                  onClick={() => handleGenerateQr(p)}
                  disabled={generatingQrId === p.id}
                  className="text-purple-500 hover:text-purple-700 disabled:opacity-40"
                >
                  {generatingQrId === p.id ? '生成中...' : '生成二维码'}
                </button>
                {p.qrCodeUrl && (
                  <button onClick={() => setQrModal(p)} className="text-indigo-500 hover:text-indigo-700">查看</button>
                )}
                <button onClick={() => handleDelete(p)} className="text-red-500 hover:text-red-700">删除</button>
              </td>
            </tr>
          ))}
        </Table>
        )}
        {!loading && !loadFailed && (
          <Pagination page={page} total={total} pageSize={effectivePageSize} onChange={setPage} />
        )}
      </div>

      {/* 新增/编辑弹窗 */}
      {showModal && (
        <Modal
          title={editing ? '编辑商品' : '新增商品'}
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">分类 *</label>
                  <select
                    value={form.categoryId}
                    onChange={(e) => setForm({ ...form, categoryId: Number(e.target.value) })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  >
                    <option value={0}>请选择</option>
                    {channelCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">单位</label>
                  <input
                    value={form.unit}
                    onChange={(e) => setForm({ ...form, unit: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">净重（克）</label>
                  <input type="number" min={1} value={form.netWeightG}
                    onChange={(e) => setForm({ ...form, netWeightG: e.target.value })}
                    placeholder="同城配送按重量呼叫骑手，空=用默认值"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm" />
                </div>
                {channel === 'LOCAL' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">打包费（元）</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={form.packingFeeFen}
                    onChange={(e) => setForm({ ...form, packingFeeFen: e.target.value })}
                    placeholder={packingHint}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                  <p className="text-xs text-gray-400 mt-1">{packingHint}</p>
                </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">商品名称 *</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">副标题</label>
                <input
                  value={form.subtitle}
                  onChange={(e) => setForm({ ...form, subtitle: e.target.value })}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">封面图</label>
                <ImageUploader
                  value={form.coverImage}
                  onChange={(url) => setForm({ ...form, coverImage: url })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">商品多图（详情轮播，最多 9 张）</label>
                <ImageUploader
                  mode="multi"
                  value={form.imageUrls}
                  onChange={(urls) => setForm({ ...form, imageUrls: urls })}
                />
              </div>
              <SpecEditor
                dimensions={specDims}
                skuRows={skuRows}
                onChange={(dims, rows) => { setSpecDims(dims); setSkuRows(rows) }}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    售价（元）{hasSkus ? '' : '*'}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={hasSkus ? '' : form.price}
                    disabled={hasSkus}
                    onChange={(e) => setForm({ ...form, price: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:bg-gray-100 disabled:text-gray-400"
                    placeholder={hasSkus ? '由规格自动取最低价' : '如 29.90'}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">原价（元）</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.originalPrice}
                    onChange={(e) => setForm({ ...form, originalPrice: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                    placeholder="可选"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">库存</label>
                  <input
                    type="number"
                    min="0"
                    value={hasSkus ? skuRows.reduce((sum, r) => sum + r.stock, 0) : form.stock}
                    disabled={hasSkus}
                    onChange={(e) => setForm({ ...form, stock: Number(e.target.value) })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:bg-gray-100 disabled:text-gray-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as 'ON_SHELF' | 'OFF_SHELF' })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  >
                    <option value="ON_SHELF">上架</option>
                    <option value="OFF_SHELF">下架</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">规格/重量</label>
                  <input
                    value={form.weight}
                    onChange={(e) => setForm({ ...form, weight: e.target.value })}
                    placeholder="如 500g/袋"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">保质期</label>
                  <input
                    value={form.shelfLife}
                    onChange={(e) => setForm({ ...form, shelfLife: e.target.value })}
                    placeholder="如 冷藏 3 天"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">储存方式</label>
                  <input
                    value={form.storageMethod}
                    onChange={(e) => setForm({ ...form, storageMethod: e.target.value })}
                    placeholder="如 0-4℃ 冷藏"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">所属渠道</label>
                  <div className="px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-md text-gray-600">
                    {CHANNEL_LABEL[categories.find((c) => c.id === form.categoryId)?.channel ?? channel]}（随分类）
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">配送说明</label>
                <textarea
                  value={form.deliveryInfo}
                  onChange={(e) => setForm({ ...form, deliveryInfo: e.target.value })}
                  rows={2}
                  placeholder="如 同城当日达，快递次日达"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">商品详情</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={4}
                  placeholder="商品详细介绍"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isRecommended"
                  checked={form.isRecommended === 1}
                  onChange={(e) => setForm({ ...form, isRecommended: e.target.checked ? 1 : 0 })}
                  className="rounded"
                />
                <label htmlFor="isRecommended" className="text-sm text-gray-700">推荐商品</label>
              </div>
          </div>
          {error && <p className="text-red-500 text-sm mt-3">{error}</p>}
        </Modal>
      )}

      {/* 库存快改弹窗 */}
      {stockModal && (
        <Modal
          title={`修改库存 · ${stockModal.name}`}
          width="sm"
          onClose={() => setStockModal(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setStockModal(null)}>取消</Button>
              <Button onClick={handleStockSave}>保存</Button>
            </>
          }
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setStockValue((v) => Math.max(0, v - 10))}>-10</Button>
              <Button variant="secondary" size="sm" onClick={() => setStockValue((v) => Math.max(0, v - 1))}>-1</Button>
              <input
                type="number"
                min={0}
                value={stockValue}
                onChange={(e) => setStockValue(Number(e.target.value) || 0)}
                className="flex-1 min-w-0 border border-gray-300 rounded-md px-3 py-2 text-center text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
              <Button variant="secondary" size="sm" onClick={() => setStockValue((v) => v + 1)}>+1</Button>
              <Button variant="secondary" size="sm" onClick={() => setStockValue((v) => v + 10)}>+10</Button>
            </div>
            <p className="text-xs text-gray-400">当前库存 {stockModal.stock}，保存后立即生效</p>
          </div>
        </Modal>
      )}

      {/* 二维码查看弹窗 */}
      {qrModal && (
        <Modal
          title="二维码信息"
          width="sm"
          onClose={() => setQrModal(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setQrModal(null)}>
                关闭
              </Button>
              <Button onClick={() => handleDownloadQr(qrModal)}>
                <Download className="w-4 h-4" />
                下载图片
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">商品</span>
                <span className="text-gray-800 font-medium">{qrModal.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Scene</span>
                <span className="text-gray-800 font-mono">{qrModal.qrScene}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">生成时间</span>
                <span className="text-gray-600">
                  {fmtDateTime(qrModal.qrGeneratedAt, '-')}
                </span>
              </div>
            </div>
            <div className="bg-gray-50 rounded-md p-3">
              <p className="text-xs text-gray-500 mb-1">二维码 URL</p>
              <p className="text-xs text-gray-700 break-all font-mono">{qrModal.qrCodeUrl}</p>
            </div>
            {qrModal.qrCodeUrl && !isMockUrl(qrModal.qrCodeUrl) && (
              <img
                src={qrModal.qrCodeUrl}
                alt="二维码"
                className="w-40 h-40 mx-auto border border-gray-200 rounded"
              />
            )}
            {isMockUrl(qrModal.qrCodeUrl) && (
              <>
                <canvas ref={mockCanvasRef} className="mx-auto block border border-gray-200 rounded" />
                <p className="text-xs text-amber-600 bg-amber-50 rounded p-2">
                  开发占位码（扫描结果为文本 {qrModal.qrScene}，非小程序码）。接入真实微信配置后此处将显示可扫描进入小程序的官方小程序码。
                </p>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
