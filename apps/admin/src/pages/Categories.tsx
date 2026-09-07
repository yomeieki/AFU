import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { getCategories, createCategory, updateCategory, deleteCategory } from '../api/admin'
import ImageUploader from '../components/ImageUploader'
import Button from '../components/ui/Button'
import Modal from '../components/ui/Modal'
import Table from '../components/ui/Table'
import ChannelTabs from '../components/ui/ChannelTabs'
import type { Category, Channel } from '../types'
import { toast } from '../components/ui/Toast'
import { confirmDialog } from '../components/ui/ConfirmDialog'
import { readChannel } from '../navigation'

const emptyForm = { name: '', iconUrl: '', sortOrder: 0, status: 1, channel: 'EXPRESS' as Channel }

export default function Categories() {
  const [searchParams, setSearchParams] = useSearchParams()
  const channel = readChannel(searchParams)
  const [list, setList] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Category | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // 没有 catch 的话接口一挂就渲染「暂无分类」，店主会当成真的没有分类
  const [loadFailed, setLoadFailed] = useState(false)

  const setChannel = (next: Channel) => {
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous)
      params.set('channel', next)
      return params
    }, { replace: true })
  }

  const load = () => {
    setLoading(true)
    setLoadFailed(false)
    getCategories(channel)
      .then((res) => setList(res.data.data))
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [channel]) // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => {
    setEditing(null)
    setForm({ ...emptyForm, channel })
    setError('')
    setShowModal(true)
  }

  const openEdit = (cat: Category) => {
    setEditing(cat)
    setForm({ name: cat.name, iconUrl: cat.iconUrl ?? '', sortOrder: cat.sortOrder, status: cat.status, channel: cat.channel })
    setError('')
    setShowModal(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      const payload = { ...form, iconUrl: form.iconUrl || null }
      const channelChanged = !!editing && editing.channel !== form.channel
      if (editing) {
        await updateCategory(editing.id, payload)
      } else {
        await createCategory(payload)
      }
      setShowModal(false)
      if (channelChanged) toast.success('已迁移渠道')
      load()
    } catch (err: unknown) {
      setError(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '操作失败'
      )
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (cat: Category) => {
    if (!(await confirmDialog({ title: '删除分类', content: `确认删除分类「${cat.name}」？`, danger: true }))) return
    try {
      await deleteCategory(cat.id)
      toast.success('已删除')
      load()
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '删除失败'
      )
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4" />
          新增分类
        </Button>
      </div>

      <ChannelTabs value={channel} onChange={setChannel} />

      <div className="bg-white rounded-lg shadow-card overflow-hidden overflow-x-auto">
        {loadFailed ? (
          <div className="py-10 flex flex-col items-center gap-3 text-sm text-red-600">
            <span>分类列表加载失败，当前显示的不是真实数据</span>
            <Button size="sm" variant="secondary" onClick={load}>重试</Button>
          </div>
        ) : (
        <Table
          columns={6}
          loading={loading}
          isEmpty={list.length === 0}
          emptyText="暂无分类"
          head={
            <tr>
              <th className="text-left px-4 py-3">ID</th>
              <th className="text-left px-4 py-3">名称</th>
              <th className="text-right px-4 py-3">排序</th>
              <th className="text-right px-4 py-3">状态</th>
              <th className="text-right px-4 py-3">商品数</th>
              <th className="text-right px-4 py-3">操作</th>
            </tr>
          }
        >
          {list.map((cat) => (
            <tr key={cat.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-gray-500">{cat.id}</td>
              <td className="px-4 py-3 text-gray-800">{cat.name}</td>
              <td className="px-4 py-3 text-right text-gray-600">{cat.sortOrder}</td>
              <td className="px-4 py-3 text-right">
                <span className={`px-2 py-0.5 rounded-full text-xs ${cat.status === 1 ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'}`}>
                  {cat.status === 1 ? '启用' : '禁用'}
                </span>
              </td>
              <td className="px-4 py-3 text-right text-gray-600">{cat._count?.products ?? 0}</td>
              <td className="px-4 py-3 text-right space-x-3">
                <button onClick={() => openEdit(cat)} className="text-blue-500 hover:text-blue-700">编辑</button>
                <button onClick={() => handleDelete(cat)} className="text-red-500 hover:text-red-700">删除</button>
              </td>
            </tr>
          ))}
        </Table>
        )}
      </div>

      {showModal && (
        <Modal
          title={editing ? '编辑分类' : '新增分类'}
          width="sm"
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
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">名称 *</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">图标</label>
                <ImageUploader
                  value={form.iconUrl}
                  onChange={(url) => setForm({ ...form, iconUrl: url })}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">排序</label>
                  <input
                    type="number"
                    value={form.sortOrder}
                    onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: Number(e.target.value) })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  >
                    <option value={1}>启用</option>
                    <option value={0}>禁用</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">渠道</label>
                  <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as Channel })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm">
                    <option value="EXPRESS">全国邮寄</option>
                    <option value="LOCAL">同城配送</option>
                  </select>
                  {editing && (editing._count?.products ?? 0) > 0 && editing.channel !== form.channel && (
                    <p className="mt-1 text-xs text-amber-600">改渠道会把该分类下 {editing._count?.products} 个商品一起迁到新渠道，并清空顾客购物车里的这些商品</p>
                  )}
                </div>
              </div>
          </div>
          {error && <p className="text-red-500 text-sm mt-3">{error}</p>}
        </Modal>
      )}
    </div>
  )
}
