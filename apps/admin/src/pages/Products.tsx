import { useEffect, useState } from 'react'
import { getProducts, getCategories, createProduct, updateProduct, deleteProduct, generateQrCode } from '../api/admin'
import ImageUploader from '../components/ImageUploader'
import type { Product, Category } from '../types'

const DELIVERY_TYPE_LABEL: Record<string, string> = {
  EXPRESS: '快递配送',
  LOCAL: '同城配送',
  PICKUP: '到店自提',
}

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
  deliveryType: 'EXPRESS',
  status: 'ON_SHELF' as 'ON_SHELF' | 'OFF_SHELF',
  isRecommended: 0,
}

export default function Products() {
  const [list, setList] = useState<Product[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [categories, setCategories] = useState<Category[]>([])
  const [filterCategoryId, setFilterCategoryId] = useState('')
  const [filterKeyword, setFilterKeyword] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [generatingQrId, setGeneratingQrId] = useState<number | null>(null)
  const [qrModal, setQrModal] = useState<Product | null>(null)

  const load = (p = page) => {
    setLoading(true)
    getProducts({
      page: p,
      pageSize,
      categoryId: filterCategoryId ? Number(filterCategoryId) : undefined,
      keyword: filterKeyword || undefined,
      status: filterStatus || undefined,
    })
      .then((res) => {
        setList(res.data.data.list)
        setTotal(res.data.data.total)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    getCategories().then((res) => setCategories(res.data.data))
  }, [])

  useEffect(() => { load() }, [page]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    setPage(1)
    load(1)
  }

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm)
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
      deliveryType: p.deliveryType || 'EXPRESS',
      status: p.status,
      isRecommended: p.isRecommended,
    })
    setError('')
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.categoryId) { setError('请选择分类'); return }
    if (!form.name.trim()) { setError('请输入商品名称'); return }
    if (!form.price) { setError('请输入价格'); return }
    setSaving(true)
    setError('')
    try {
      const payload = {
        categoryId: Number(form.categoryId),
        name: form.name,
        subtitle: form.subtitle || null,
        coverImage: form.coverImage || null,
        imageUrls: form.imageUrls,
        price: Math.round(parseFloat(form.price) * 100),
        originalPrice: form.originalPrice ? Math.round(parseFloat(form.originalPrice) * 100) : null,
        stock: form.stock,
        unit: form.unit,
        weight: form.weight || null,
        shelfLife: form.shelfLife || null,
        storageMethod: form.storageMethod || null,
        deliveryInfo: form.deliveryInfo || null,
        description: form.description || null,
        deliveryType: form.deliveryType,
        status: form.status,
        isRecommended: form.isRecommended,
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

  const handleDelete = async (p: Product) => {
    if (!confirm(`确认删除商品「${p.name}」？`)) return
    try {
      await deleteProduct(p.id)
      load()
    } catch (err: unknown) {
      alert(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '删除失败'
      )
    }
  }

  const handleGenerateQr = async (p: Product) => {
    if (!confirm(`为「${p.name}」生成二维码？${p.qrCodeUrl ? '（将覆盖已有二维码）' : ''}`)) return
    setGeneratingQrId(p.id)
    try {
      await generateQrCode(p.id)
      load()
    } catch (err: unknown) {
      alert(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '生成失败'
      )
    } finally {
      setGeneratingQrId(null)
    }
  }

  const totalPages = Math.ceil(total / pageSize)
  const isMockUrl = (url: string | null) => !url || url.startsWith('mock://')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-gray-800">商品管理</h2>
        <button
          onClick={openCreate}
          className="bg-orange-500 hover:bg-orange-600 text-white text-sm px-4 py-2 rounded-md transition-colors"
        >
          新增商品
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">分类</label>
          <select
            value={filterCategoryId}
            onChange={(e) => setFilterCategoryId(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm"
          >
            <option value="">全部</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
        <button
          onClick={handleSearch}
          className="bg-gray-800 hover:bg-gray-900 text-white text-sm px-4 py-1.5 rounded-md"
        >
          搜索
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-6 text-gray-500 text-sm">加载中...</div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-4 py-3">商品名称</th>
                  <th className="text-left px-4 py-3">分类</th>
                  <th className="text-right px-4 py-3">价格</th>
                  <th className="text-right px-4 py-3">库存</th>
                  <th className="text-right px-4 py-3">销量</th>
                  <th className="text-right px-4 py-3">状态</th>
                  <th className="text-right px-4 py-3">二维码</th>
                  <th className="text-right px-4 py-3">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-800">{p.name}</td>
                    <td className="px-4 py-3 text-gray-500">{p.category?.name}</td>
                    <td className="px-4 py-3 text-right text-gray-800">¥{(p.price / 100).toFixed(2)}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{p.stock}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{p.salesCount}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`px-2 py-0.5 rounded-full text-xs ${p.status === 'ON_SHELF' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {p.status === 'ON_SHELF' ? '上架' : '下架'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`px-2 py-0.5 rounded-full text-xs ${p.qrCodeUrl ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-400'}`}>
                        {p.qrCodeUrl ? '已生成' : '未生成'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right space-x-2">
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
              </tbody>
            </table>
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between text-sm text-gray-500">
              <span>共 {total} 条</span>
              <div className="flex gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                  className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
                >
                  上一页
                </button>
                <span className="px-3 py-1">{page} / {totalPages}</span>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                  className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 新增/编辑弹窗 */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 space-y-4 mx-4">
            <h3 className="text-lg font-semibold text-gray-800">{editing ? '编辑商品' : '新增商品'}</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">分类 *</label>
                  <select
                    value={form.categoryId}
                    onChange={(e) => setForm({ ...form, categoryId: Number(e.target.value) })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  >
                    <option value={0}>请选择</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">单位</label>
                  <input
                    value={form.unit}
                    onChange={(e) => setForm({ ...form, unit: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">商品名称 *</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">副标题</label>
                <input
                  value={form.subtitle}
                  onChange={(e) => setForm({ ...form, subtitle: e.target.value })}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
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
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">售价（元）*</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.price}
                    onChange={(e) => setForm({ ...form, price: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                    placeholder="如 29.90"
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
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                    placeholder="可选"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">库存</label>
                  <input
                    type="number"
                    min="0"
                    value={form.stock}
                    onChange={(e) => setForm({ ...form, stock: Number(e.target.value) })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as 'ON_SHELF' | 'OFF_SHELF' })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  >
                    <option value="ON_SHELF">上架</option>
                    <option value="OFF_SHELF">下架</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">规格/重量</label>
                  <input
                    value={form.weight}
                    onChange={(e) => setForm({ ...form, weight: e.target.value })}
                    placeholder="如 500g/袋"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">保质期</label>
                  <input
                    value={form.shelfLife}
                    onChange={(e) => setForm({ ...form, shelfLife: e.target.value })}
                    placeholder="如 冷藏 3 天"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">储存方式</label>
                  <input
                    value={form.storageMethod}
                    onChange={(e) => setForm({ ...form, storageMethod: e.target.value })}
                    placeholder="如 0-4℃ 冷藏"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">配送方式</label>
                  <select
                    value={form.deliveryType}
                    onChange={(e) => setForm({ ...form, deliveryType: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                  >
                    {Object.entries(DELIVERY_TYPE_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">配送说明</label>
                <textarea
                  value={form.deliveryInfo}
                  onChange={(e) => setForm({ ...form, deliveryInfo: e.target.value })}
                  rows={2}
                  placeholder="如 同城当日达，快递次日达"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">商品详情</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={4}
                  placeholder="商品详细介绍"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
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
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <div className="flex justify-end space-x-3 pt-2">
              <button
                onClick={() => setShowModal(false)}
                className="text-sm px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="text-sm px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-md disabled:opacity-50"
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 二维码查看弹窗 */}
      {qrModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6 space-y-4 mx-4">
            <h3 className="text-lg font-semibold text-gray-800">二维码信息</h3>
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
                  {qrModal.qrGeneratedAt ? new Date(qrModal.qrGeneratedAt).toLocaleString() : '-'}
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
              <p className="text-xs text-amber-600 bg-amber-50 rounded p-2">
                当前为 Mock 模式，接入真实微信配置后此处将显示可扫描的小程序码图片。
              </p>
            )}
            <div className="flex justify-end">
              <button
                onClick={() => setQrModal(null)}
                className="text-sm px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
