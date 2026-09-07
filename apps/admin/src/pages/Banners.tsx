import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import {
  getBanners,
  createBanner,
  updateBanner,
  updateBannerStatus,
  deleteBanner,
  getProducts,
} from '../api/admin'
import type { Banner, Product } from '../types'
import Button from '../components/ui/Button'
import { CenterAction } from '../components/BusinessCenter'
import Modal from '../components/ui/Modal'
import Table from '../components/ui/Table'
import ImageUploader from '../components/ImageUploader'
import { toast } from '../components/ui/Toast'
import { confirmDialog } from '../components/ui/ConfirmDialog'

interface FormState {
  title: string
  imageUrl: string
  linkType: 'none' | 'product'
  productId: number | null
  sortOrder: number
  status: number
}

const EMPTY_FORM: FormState = {
  title: '',
  imageUrl: '',
  linkType: 'none',
  productId: null,
  sortOrder: 0,
  status: 1,
}

export default function Banners() {
  const [list, setList] = useState<Banner[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Banner | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  // 没有 catch 的话接口一挂就渲染「暂无 Banner」，店主会以为轮播真的被清空了
  const [loadFailed, setLoadFailed] = useState(false)

  const load = () => {
    setLoading(true)
    setLoadFailed(false)
    getBanners()
      .then((res) => setList(res.data.data))
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    // 商品下拉（跳转商品用）
    getProducts({ page: 1, pageSize: 100 }).then((res) => setProducts(res.data.data.list))
  }, [])

  const openEdit = (b: Banner | 'new') => {
    setEditing(b)
    setForm(
      b === 'new'
        ? EMPTY_FORM
        : {
            title: b.title ?? '',
            imageUrl: b.imageUrl,
            linkType: b.linkType,
            productId: b.productId,
            sortOrder: b.sortOrder,
            status: b.status,
          }
    )
  }

  const handleSave = async () => {
    if (!form.imageUrl) {
      toast.error('请上传 Banner 图片')
      return
    }
    if (form.linkType === 'product' && !form.productId) {
      toast.error('请选择跳转商品')
      return
    }
    setSaving(true)
    try {
      const payload = {
        title: form.title.trim() || null,
        imageUrl: form.imageUrl,
        linkType: form.linkType,
        productId: form.linkType === 'product' ? form.productId : null,
        sortOrder: form.sortOrder,
        status: form.status,
      }
      if (editing === 'new') {
        await createBanner(payload)
      } else if (editing) {
        await updateBanner(editing.id, payload)
      }
      toast.success('已保存')
      setEditing(null)
      load()
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败'
      )
    } finally {
      setSaving(false)
    }
  }

  const handleToggleStatus = async (b: Banner) => {
    try {
      await updateBannerStatus(b.id, b.status === 1 ? 0 : 1)
      load()
    } catch {
      toast.error('操作失败')
    }
  }

  const handleDelete = async (b: Banner) => {
    if (!(await confirmDialog({ title: '删除 Banner', content: `确认删除「${b.title ?? '未命名'}」？`, danger: true }))) return
    try {
      await deleteBanner(b.id)
      toast.success('已删除')
      load()
    } catch {
      toast.error('删除失败')
    }
  }

  const productName = (id: number | null) => products.find((p) => p.id === id)?.name ?? (id ? `#${id}` : '-')

  const rowActions = (b: Banner) => (
    <>
      <button onClick={() => openEdit(b)} className="text-brand-500 hover:text-brand-700">编辑</button>
      <button onClick={() => handleToggleStatus(b)} className="text-blue-500 hover:text-blue-700">
        {b.status === 1 ? '下架' : '上架'}
      </button>
      <button onClick={() => handleDelete(b)} className="text-red-500 hover:text-red-700">删除</button>
    </>
  )

  return (
    <div className="space-y-4">
      <CenterAction>
        <Button onClick={() => openEdit('new')}>
          <Plus className="w-4 h-4" />
          新增 Banner
        </Button>
      </CenterAction>

      <div className="bg-white rounded-lg shadow-card overflow-hidden">
        {loadFailed ? (
          <div className="py-10 flex flex-col items-center gap-3 text-sm text-red-600">
            <span>轮播列表加载失败，当前显示的不是真实数据</span>
            <Button size="sm" variant="secondary" onClick={load}>重试</Button>
          </div>
        ) : (
        <Table
          columns={6}
          loading={loading}
          isEmpty={list.length === 0}
          emptyText="暂无 Banner，点击右上角新增"
          head={
            <tr>
              <th className="text-left px-4 py-3">图片</th>
              <th className="text-left px-4 py-3">标题</th>
              <th className="text-left px-4 py-3">跳转</th>
              <th className="text-right px-4 py-3">排序</th>
              <th className="text-right px-4 py-3">状态</th>
              <th className="text-right px-4 py-3">操作</th>
            </tr>
          }
          mobileCards={
            <>
              {list.map((b) => (
                <div key={b.id} className="border border-gray-100 rounded-lg p-3 flex gap-3">
                  <img src={b.imageUrl} alt="" className="w-20 h-12 object-cover rounded bg-gray-100 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-gray-800 truncate">{b.title ?? '未命名'}</p>
                      <span className={`text-xs ${b.status === 1 ? 'text-green-600' : 'text-gray-400'}`}>
                        {b.status === 1 ? '上架' : '下架'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {b.linkType === 'product' ? `跳转：${productName(b.productId)}` : '无跳转'}　排序 {b.sortOrder}
                    </p>
                    <div className="mt-2 flex gap-3 text-sm">{rowActions(b)}</div>
                  </div>
                </div>
              ))}
            </>
          }
        >
          {list.map((b) => (
            <tr key={b.id} className="hover:bg-gray-50">
              <td className="px-4 py-2">
                <img src={b.imageUrl} alt="" className="w-24 h-12 object-cover rounded bg-gray-100" />
              </td>
              <td className="px-4 py-3 text-gray-800">{b.title ?? '-'}</td>
              <td className="px-4 py-3 text-gray-600">
                {b.linkType === 'product' ? productName(b.productId) : '无'}
              </td>
              <td className="px-4 py-3 text-right text-gray-600">{b.sortOrder}</td>
              <td className="px-4 py-3 text-right">
                <span className={`inline-block px-2 py-0.5 rounded-full text-xs ${
                  b.status === 1 ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'
                }`}>
                  {b.status === 1 ? '上架' : '下架'}
                </span>
              </td>
              <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">{rowActions(b)}</td>
            </tr>
          ))}
        </Table>
        )}
      </div>

      {editing && (
        <Modal
          title={editing === 'new' ? '新增 Banner' : '编辑 Banner'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setEditing(null)}>取消</Button>
              <Button loading={saving} onClick={handleSave}>保存</Button>
            </>
          }
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Banner 图片 *</label>
              <ImageUploader value={form.imageUrl} aspect={2.5} onChange={(url) => setForm({ ...form, imageUrl: url })} />
              <p className="text-xs text-gray-400 mt-1">任意尺寸照片均可，上传后按 5:2（750×300）裁剪，首页轮播即按此比例铺满显示。</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">标题</label>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="可选，用于后台辨识"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">跳转类型</label>
                <select
                  value={form.linkType}
                  onChange={(e) => setForm({ ...form, linkType: e.target.value as 'none' | 'product' })}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                >
                  <option value="none">无跳转</option>
                  <option value="product">商品详情</option>
                </select>
              </div>
              {form.linkType === 'product' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">跳转商品 *</label>
                  <select
                    value={form.productId ?? ''}
                    onChange={(e) => setForm({ ...form, productId: e.target.value ? Number(e.target.value) : null })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  >
                    <option value="">请选择商品</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">排序（小在前）</label>
                <input
                  type="number"
                  value={form.sortOrder}
                  onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) || 0 })}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: Number(e.target.value) })}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                >
                  <option value={1}>上架</option>
                  <option value={0}>下架</option>
                </select>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
