import { useEffect, useState } from 'react'
import { Plus, Ticket } from 'lucide-react'
import {
  getCouponTemplates,
  createCouponTemplate,
  updateCouponTemplate,
  getCouponTemplateIssued,
} from '../api/admin'
import Button from '../components/ui/Button'
import Modal from '../components/ui/Modal'
import Table from '../components/ui/Table'
import Pagination from '../components/ui/Pagination'
import { toast } from '../components/ui/Toast'
import { confirmDialog } from '../components/ui/ConfirmDialog'
import type {
  CouponTemplate,
  CouponIssuedRow,
  CouponSource,
  CouponChannel,
  CouponStatus,
  OnOff,
} from '../types'

// ── 文案表 ────────────────────────────────────────────────────────────────
const SOURCE_LABEL: Record<CouponSource, string> = {
  ADMIN: '手动发放',
  POINTS: '积分兑换',
  CAMPAIGN: '领券中心',
  NEWCOMER: '新人礼',
}
// 每条发放路径「券是怎么到顾客手里的」，建模板时店主最需要看懂的就是这句
const SOURCE_HINT: Record<CouponSource, string> = {
  ADMIN: '店员在「用户管理」或「邮寄订单」页手动发给指定顾客。',
  POINTS: '顾客在小程序里用积分兑换，必须填「所需积分」。',
  CAMPAIGN: '顾客在「领券中心」自助领取，可以限总量和每人限领。',
  NEWCOMER: '需要在「会员设置」里选中这张模板，新用户注册时才会自动发。',
}
const COUPON_CHANNEL_LABEL: Record<CouponChannel, string> = {
  ALL: '通用',
  LOCAL: '仅同城',
  EXPRESS: '仅邮寄',
}
const COUPON_STATUS_LABEL: Record<CouponStatus, string> = {
  UNUSED: '未使用',
  USED: '已核销',
  EXPIRED: '已过期',
}
const COUPON_STATUS_CLS: Record<CouponStatus, string> = {
  UNUSED: 'bg-blue-50 text-blue-600',
  USED: 'bg-green-50 text-green-600',
  EXPIRED: 'bg-gray-100 text-gray-500',
}

// ── 金额与整数换算（元→分，见房规「金额」一节）─────────────────────────────
const toYuan = (fen: number) => (fen / 100).toFixed(2)
/** 元字符串 → 分。空串 / 非法输入返回 null，由调用方给出中文报错 */
function toFen(input: string): number | null {
  const v = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null
  const [yuan, dec = ''] = v.split('.')
  return Number(yuan) * 100 + Number(dec.padEnd(2, '0'))
}
/** 必填正整数：非法返回 null */
function toInt(input: string): number | null {
  const v = input.trim()
  return /^-?\d+$/.test(v) ? Number(v) : null
}
/** 可空整数：空串 = null（表示「不限」），非法 = undefined（交给校验报错） */
function toOptionalInt(input: string): number | null | undefined {
  const v = input.trim()
  if (!v) return null
  return /^\d+$/.test(v) ? Number(v) : undefined
}

const inputCls =
  'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const Field = ({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
    {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
  </div>
)

const emptyForm = {
  name: '',
  description: '',
  amount: '',
  threshold: '0',
  channel: 'ALL' as CouponChannel,
  source: 'ADMIN' as CouponSource,
  validDays: '30',
  pointsCost: '',
  totalLimit: '',
  perUserLimit: '',
  sortOrder: '0',
  status: 'ON' as OnOff,
}
type Form = typeof emptyForm

const ISSUED_PAGE_SIZE = 20

export default function Coupons() {
  const [list, setList] = useState<CouponTemplate[]>([])
  const [loading, setLoading] = useState(true)
  // 没有 catch 的话接口一挂就渲染「暂无券模板」，店主会以为券配置被清空了
  const [loadFailed, setLoadFailed] = useState(false)
  const [filterSource, setFilterSource] = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  const load = () => {
    setLoading(true)
    setLoadFailed(false)
    getCouponTemplates({ source: filterSource || undefined, status: filterStatus || undefined })
      .then(setList)
      .catch(() => {
        setLoadFailed(true)
        toast.error('券模板加载失败，请刷新重试')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [filterSource, filterStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 新建 / 编辑 ────────────────────────────────────────────────────────
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<CouponTemplate | null>(null)
  const [form, setForm] = useState<Form>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }))

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm)
    setError('')
    setShowModal(true)
  }

  const openEdit = (t: CouponTemplate) => {
    setEditing(t)
    setForm({
      name: t.name,
      description: t.description ?? '',
      amount: toYuan(t.amount),
      threshold: toYuan(t.threshold),
      channel: t.channel,
      source: t.source,
      validDays: String(t.validDays),
      pointsCost: t.pointsCost === null ? '' : String(t.pointsCost),
      totalLimit: t.totalLimit === null ? '' : String(t.totalLimit),
      perUserLimit: t.perUserLimit === null ? '' : String(t.perUserLimit),
      sortOrder: String(t.sortOrder),
      status: t.status,
    })
    setError('')
    setShowModal(true)
  }

  const handleSave = async () => {
    // 前端校验与服务端 baseSchema 逐条对齐（coupon-templates.ts），先在本地拦一遍
    const name = form.name.trim()
    if (!name) return setError('请填写券名')
    if (name.length > 64) return setError('券名最多 64 个字')
    const description = form.description.trim()
    if (description.length > 255) return setError('描述最多 255 个字')

    const amount = toFen(form.amount)
    if (amount === null) return setError('面额请填写数字（最多两位小数）')
    if (amount < 1) return setError('面额至少 1 分')
    if (amount > 100000) return setError('面额上限 ¥1000')

    const threshold = form.threshold.trim() === '' ? 0 : toFen(form.threshold)
    if (threshold === null) return setError('门槛请填写数字（最多两位小数）')
    if (threshold > 10000000) return setError('门槛上限 ¥100000')

    const validDays = toInt(form.validDays)
    if (validDays === null || validDays < 1 || validDays > 3650)
      return setError('有效天数请填 1 ~ 3650 之间的整数')

    const sortOrder = toInt(form.sortOrder)
    if (sortOrder === null || sortOrder < -9999 || sortOrder > 9999)
      return setError('排序请填 -9999 ~ 9999 之间的整数')

    const source = editing ? editing.source : form.source

    let pointsCost: number | null = null
    if (source === 'POINTS') {
      const v = toInt(form.pointsCost)
      // 服务端会以 40001「积分兑换券必须填写所需积分」拒掉，这里先说清楚
      if (v === null || v < 1 || v > 100000000)
        return setError('积分兑换券必须填写所需积分（1 ~ 100000000 的整数）')
      pointsCost = v
    }

    let totalLimit: number | null = null
    let perUserLimit: number | null = null
    if (source === 'CAMPAIGN') {
      const t = toOptionalInt(form.totalLimit)
      if (t === undefined || (t !== null && (t < 1 || t > 1000000)))
        return setError('发放总量请留空（不限）或填 1 ~ 1000000 的整数')
      const p = toOptionalInt(form.perUserLimit)
      if (p === undefined || (p !== null && (p < 1 || p > 1000)))
        return setError('每人限领请留空（不限）或填 1 ~ 1000 的整数')
      totalLimit = t
      perUserLimit = p
    }

    setSaving(true)
    setError('')
    try {
      // 只提交当前来源用得上的字段：别把另一条路径上已有的配置顺手清成 null
      const payload = {
        name,
        description: description || null,
        amount,
        threshold,
        channel: form.channel,
        validDays,
        sortOrder,
        status: form.status,
        ...(source === 'POINTS' ? { pointsCost } : {}),
        ...(source === 'CAMPAIGN' ? { totalLimit, perUserLimit } : {}),
      }
      if (editing) {
        // source 建后不可改，不进 payload（服务端 updateSchema 也没有这个字段）
        await updateCouponTemplate(editing.id, payload)
        toast.success('已保存')
      } else {
        await createCouponTemplate({ ...payload, source })
        toast.success('券模板已创建')
      }
      setShowModal(false)
      load()
    } catch (err) {
      setError(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '操作失败'
      )
    } finally {
      setSaving(false)
    }
  }

  // ── 停用 / 启用 ────────────────────────────────────────────────────────
  const handleToggleStatus = async (t: CouponTemplate) => {
    const turnOff = t.status === 'ON'
    // 正被设为新客券时，停用的后果比「不再发新券」重得多：**新注册的顾客从此一张券都收不到**，
    // 而且这个后果在券模板页上完全看不见（停用走的是券模板接口，它不知道会员设置的存在）。
    // 不阻止操作——店主可能就是想暂停发新客券；但必须在按下去之前说清楚。
    // （主流做法同此：有赞是引用保护、抖音是发放时明确提示「无发放权限」，都不是静默失效。）
    const newcomerWarn =
      turnOff && t.usedAsNewcomer
        ? '\n\n⚠️ 这张券正被「会员设置」选为新客券。停用后，新注册的顾客将收不到任何见面礼——请记得到「会员设置」换一张，或改选「不发新客券」。'
        : ''
    const ok = await confirmDialog({
      title: turnOff ? `停用「${t.name}」` : `启用「${t.name}」`,
      content: turnOff
        ? '停用只影响再发放：这张模板不再发出新券。已经发到顾客手里的券照常可用，不受影响。' + newcomerWarn
        : '启用后，这张模板会重新按它的发放路径发券。',
      danger: turnOff,
      confirmText: turnOff ? '停用' : '启用',
    })
    if (!ok) return
    const next: OnOff = turnOff ? 'OFF' : 'ON'
    try {
      await updateCouponTemplate(t.id, { status: next })
      setList((ls) => ls.map((it) => (it.id === t.id ? { ...it, status: next } : it)))
      toast.success(turnOff ? `「${t.name}」已停用` : `「${t.name}」已启用`)
    } catch (err) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '操作失败'
      )
    }
  }

  // ── 发放记录 ──────────────────────────────────────────────────────────
  const [issuedFor, setIssuedFor] = useState<CouponTemplate | null>(null)
  const [issuedRows, setIssuedRows] = useState<CouponIssuedRow[]>([])
  const [issuedTotal, setIssuedTotal] = useState(0)
  const [issuedPage, setIssuedPage] = useState(1)
  const [issuedLoading, setIssuedLoading] = useState(false)
  const [issuedFailed, setIssuedFailed] = useState(false)

  const openIssued = (t: CouponTemplate) => {
    setIssuedRows([])
    setIssuedTotal(0)
    setIssuedPage(1)
    setIssuedFor(t)
  }

  const loadIssued = (tpl: CouponTemplate, p: number) => {
    setIssuedLoading(true)
    setIssuedFailed(false)
    getCouponTemplateIssued(tpl.id, { page: p, pageSize: ISSUED_PAGE_SIZE })
      .then((d) => {
        setIssuedRows(d.list)
        setIssuedTotal(d.total)
      })
      .catch(() => {
        setIssuedFailed(true)
        toast.error('发放记录加载失败，请重试')
      })
      .finally(() => setIssuedLoading(false))
  }

  useEffect(() => {
    if (issuedFor) loadIssued(issuedFor, issuedPage)
  }, [issuedFor, issuedPage]) // eslint-disable-line react-hooks/exhaustive-deps

  // 「已发」一律用 issuedTotal（真实行数）：模板上的 issuedCount 只有 POINTS / CAMPAIGN
  // 两条自助路径会递增，ADMIN / NEWCOMER 模板上它永远是 0（见 types.ts 的注释）
  const issuedText = (t: CouponTemplate) =>
    t.source === 'CAMPAIGN' && t.totalLimit !== null
      ? `${t.issuedTotal}/${t.totalLimit}`
      : String(t.issuedTotal)

  const thresholdText = (t: CouponTemplate) => (t.threshold === 0 ? '无门槛' : `满 ¥${toYuan(t.threshold)}`)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-gray-800">券模板管理</h2>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4" />
          新建模板
        </Button>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">来源</label>
          <select
            value={filterSource}
            onChange={(e) => setFilterSource(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm"
          >
            <option value="">全部</option>
            <option value="ADMIN">ADMIN 手动发放</option>
            <option value="POINTS">POINTS 积分兑换</option>
            <option value="CAMPAIGN">CAMPAIGN 领券中心</option>
            <option value="NEWCOMER">NEWCOMER 新人礼</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">状态</label>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm"
          >
            <option value="">全部</option>
            <option value="ON">启用</option>
            <option value="OFF">停用</option>
          </select>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-card overflow-hidden">
        {loadFailed ? (
          <div className="py-10 flex flex-col items-center gap-3 text-sm text-red-600">
            <span>券模板加载失败，当前显示的不是真实数据</span>
            <Button size="sm" variant="secondary" onClick={load}>
              重试
            </Button>
          </div>
        ) : (
          <Table
            columns={10}
            loading={loading}
            isEmpty={list.length === 0}
            emptyText="暂无券模板"
            head={
              <tr>
                <th className="text-left px-4 py-3">名称</th>
                <th className="text-right px-4 py-3">面额</th>
                <th className="text-right px-4 py-3">门槛</th>
                <th className="text-left px-4 py-3">渠道</th>
                <th className="text-left px-4 py-3">来源</th>
                <th className="text-right px-4 py-3">有效期</th>
                <th className="text-right px-4 py-3">已发</th>
                <th className="text-right px-4 py-3">已用</th>
                <th className="text-right px-4 py-3">状态</th>
                <th className="text-right px-4 py-3">操作</th>
              </tr>
            }
            mobileCards={
              <>
                {list.map((t) => (
                  <div key={t.id} className="border border-gray-100 rounded-lg p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 break-all">
                          {t.name}
                          {t.usedAsNewcomer && (
                          <span className="ml-1.5 align-middle text-[10px] text-brand-600 bg-brand-50 border border-brand-200 rounded px-1 py-0.5 whitespace-nowrap" title="「会员设置」把这张券选为新客券。停用它，新注册的顾客将收不到见面礼">
                            新客券
                          </span>
                        )}
                        </p>
                        {t.description && (
                          <p className="text-xs text-gray-400 mt-0.5 break-all">{t.description}</p>
                        )}
                      </div>
                      <span
                        className={`shrink-0 px-2 py-0.5 rounded-full text-xs ${
                          t.status === 'ON' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {t.status === 'ON' ? '启用' : '停用'}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm">
                      <span className="text-brand-600 font-semibold">¥{toYuan(t.amount)}</span>
                      <span className="text-gray-500 text-xs">{`　${thresholdText(t)}　${t.validDays} 天`}</span>
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      {`${SOURCE_LABEL[t.source]} · ${COUPON_CHANNEL_LABEL[t.channel]}`}
                      {t.source === 'POINTS' && t.pointsCost !== null && `　${t.pointsCost} 积分`}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      {`已发 ${issuedText(t)}　已用 ${t.usedCount}`}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                      <button onClick={() => openEdit(t)} className="text-blue-500">
                        编辑
                      </button>
                      <button
                        onClick={() => handleToggleStatus(t)}
                        className={t.status === 'ON' ? 'text-red-500' : 'text-green-600'}
                      >
                        {t.status === 'ON' ? '停用' : '启用'}
                      </button>
                      <button onClick={() => openIssued(t)} className="text-indigo-500">
                        发放记录
                      </button>
                    </div>
                  </div>
                ))}
              </>
            }
          >
            {list.map((t) => (
              <tr key={t.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <div className="text-gray-800">
                    {t.name}
                    {t.usedAsNewcomer && (
                      <span className="ml-1.5 align-middle text-[10px] text-brand-600 bg-brand-50 border border-brand-200 rounded px-1 py-0.5 whitespace-nowrap" title="「会员设置」把这张券选为新客券。停用它，新注册的顾客将收不到见面礼">
                        新客券
                      </span>
                    )}
                  </div>
                  {t.description && <div className="text-xs text-gray-400 mt-0.5">{t.description}</div>}
                </td>
                <td className="px-4 py-3 text-right font-semibold text-brand-600 whitespace-nowrap">
                  ¥{toYuan(t.amount)}
                </td>
                <td className="px-4 py-3 text-right text-gray-600 whitespace-nowrap">{thresholdText(t)}</td>
                <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                  {COUPON_CHANNEL_LABEL[t.channel]}
                </td>
                <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                  {SOURCE_LABEL[t.source]}
                  {t.source === 'POINTS' && t.pointsCost !== null && (
                    <span className="ml-1 text-xs text-gray-400">{t.pointsCost} 分</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-gray-600 whitespace-nowrap">{t.validDays} 天</td>
                <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">{issuedText(t)}</td>
                <td className="px-4 py-3 text-right text-gray-700">{t.usedCount}</td>
                <td className="px-4 py-3 text-right">
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${
                      t.status === 'ON' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {t.status === 'ON' ? '启用' : '停用'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  <button onClick={() => openEdit(t)} className="text-blue-500 hover:text-blue-700">
                    编辑
                  </button>
                  <button
                    onClick={() => handleToggleStatus(t)}
                    className={
                      t.status === 'ON'
                        ? 'text-red-500 hover:text-red-700'
                        : 'text-green-600 hover:text-green-700'
                    }
                  >
                    {t.status === 'ON' ? '停用' : '启用'}
                  </button>
                  <button onClick={() => openIssued(t)} className="text-indigo-500 hover:text-indigo-700">
                    发放记录
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>

      {/* 新建 / 编辑弹窗 */}
      {showModal && (
        <Modal
          title={editing ? `编辑券模板 · ${editing.name}` : '新建券模板'}
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
            <Field label="券名 *">
              <input
                value={form.name}
                maxLength={64}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="如 满 50 减 5"
                className={inputCls}
              />
            </Field>
            <Field label="描述" hint="顾客在券列表里看到的补充说明，可留空">
              <input
                value={form.description}
                maxLength={255}
                onChange={(e) => set({ description: e.target.value })}
                className={inputCls}
              />
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="面额（元）*" hint="¥0.01 ~ ¥1000">
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={form.amount}
                  onChange={(e) => set({ amount: e.target.value })}
                  placeholder="如 5.00"
                  className={inputCls}
                />
              </Field>
              <Field label="门槛（元）" hint="填 0 = 无门槛">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.threshold}
                  onChange={(e) => set({ threshold: e.target.value })}
                  placeholder="如 50.00"
                  className={inputCls}
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="适用渠道">
                <select
                  value={form.channel}
                  onChange={(e) => set({ channel: e.target.value as CouponChannel })}
                  className={inputCls}
                >
                  <option value="ALL">通用（同城 + 邮寄）</option>
                  <option value="LOCAL">仅同城</option>
                  <option value="EXPRESS">仅邮寄</option>
                </select>
              </Field>
              <Field label="有效天数 *" hint="顾客领到后多少天过期，1 ~ 3650">
                <input
                  type="number"
                  min="1"
                  max="3650"
                  value={form.validDays}
                  onChange={(e) => set({ validDays: e.target.value })}
                  className={inputCls}
                />
              </Field>
            </div>

            <Field
              label="发放来源"
              hint={
                editing
                  ? '来源建后不可改：它决定这张模板走哪条发放路径，改了会让已发出去的券对不上。'
                  : SOURCE_HINT[form.source]
              }
            >
              {editing ? (
                <div className="px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-md text-gray-600">
                  {SOURCE_LABEL[editing.source]}（不可修改）
                </div>
              ) : (
                <select
                  value={form.source}
                  onChange={(e) => set({ source: e.target.value as CouponSource })}
                  className={inputCls}
                >
                  <option value="ADMIN">ADMIN 手动发放</option>
                  <option value="POINTS">POINTS 积分兑换</option>
                  <option value="CAMPAIGN">CAMPAIGN 领券中心</option>
                  <option value="NEWCOMER">NEWCOMER 新人礼</option>
                </select>
              )}
            </Field>

            {/* 按来源动态显隐：只显示这条发放路径真正用得上的字段 */}
            {(editing ? editing.source : form.source) === 'POINTS' && (
              <Field label="所需积分 *" hint="顾客兑这张券要花多少积分；不填服务端会直接拒绝">
                <input
                  type="number"
                  min="1"
                  value={form.pointsCost}
                  onChange={(e) => set({ pointsCost: e.target.value })}
                  placeholder="如 200"
                  className={inputCls}
                />
              </Field>
            )}

            {(editing ? editing.source : form.source) === 'CAMPAIGN' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="发放总量" hint="留空 = 不限量">
                  <input
                    type="number"
                    min="1"
                    value={form.totalLimit}
                    onChange={(e) => set({ totalLimit: e.target.value })}
                    placeholder="不限"
                    className={inputCls}
                  />
                </Field>
                <Field label="每人限领" hint="留空 = 不限">
                  <input
                    type="number"
                    min="1"
                    value={form.perUserLimit}
                    onChange={(e) => set({ perUserLimit: e.target.value })}
                    placeholder="不限"
                    className={inputCls}
                  />
                </Field>
              </div>
            )}

            {(editing ? editing.source : form.source) === 'NEWCOMER' && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded p-2">
                需要在「会员设置」里选中这张模板，新用户注册时才会自动发。
              </p>
            )}

            {(editing ? editing.source : form.source) === 'ADMIN' && (
              <p className="text-xs text-gray-600 bg-gray-50 rounded p-2">
                店员在「用户管理」或「邮寄订单」页手动发给指定顾客。
              </p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="排序" hint="数字小的排前面，默认 0">
                <input
                  type="number"
                  value={form.sortOrder}
                  onChange={(e) => set({ sortOrder: e.target.value })}
                  className={inputCls}
                />
              </Field>
              <Field label="状态" hint="停用只挡再发放，已发出的券照常可用">
                <select
                  value={form.status}
                  onChange={(e) => set({ status: e.target.value as OnOff })}
                  className={inputCls}
                >
                  <option value="ON">启用</option>
                  <option value="OFF">停用</option>
                </select>
              </Field>
            </div>
          </div>
          {error && <p className="text-red-500 text-sm mt-3">{error}</p>}
        </Modal>
      )}

      {/* 发放记录弹窗 */}
      {issuedFor && (
        <Modal
          title={`发放记录 · ${issuedFor.name}`}
          width="lg"
          onClose={() => setIssuedFor(null)}
          footer={
            <Button variant="secondary" onClick={() => setIssuedFor(null)}>
              关闭
            </Button>
          }
        >
          {issuedFailed ? (
            <div className="py-8 flex flex-col items-center gap-3 text-sm text-red-600">
              <span>发放记录加载失败</span>
              <Button size="sm" variant="secondary" onClick={() => loadIssued(issuedFor, issuedPage)}>
                重试
              </Button>
            </div>
          ) : (
            <>
              <p className="mb-3 text-xs text-gray-500 flex items-center gap-1">
                <Ticket className="w-3.5 h-3.5" />
                共发出 {issuedFor.issuedTotal} 张，已核销 {issuedFor.usedCount} 张
              </p>
              <div className="overflow-x-auto">
                <Table
                  columns={8}
                  loading={issuedLoading}
                  isEmpty={issuedRows.length === 0}
                  emptyText="这张模板还没发出过券"
                  head={
                    <tr>
                      <th className="text-left px-3 py-2">用户</th>
                      <th className="text-left px-3 py-2">券码</th>
                      <th className="text-left px-3 py-2">状态</th>
                      <th className="text-left px-3 py-2">来源</th>
                      <th className="text-left px-3 py-2">操作人</th>
                      <th className="text-left px-3 py-2">备注</th>
                      <th className="text-left px-3 py-2">关联订单</th>
                      <th className="text-left px-3 py-2">发放时间</th>
                    </tr>
                  }
                  mobileCards={
                    <>
                      {issuedRows.map((r) => (
                        <div key={r.id} className="border border-gray-100 rounded-lg p-3 text-xs">
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-sm text-gray-800">
                              {r.user.nickname ?? `用户#${r.user.id}`}
                            </span>
                            <span
                              className={`shrink-0 px-2 py-0.5 rounded-full ${COUPON_STATUS_CLS[r.status]}`}
                            >
                              {COUPON_STATUS_LABEL[r.status]}
                            </span>
                          </div>
                          <p className="mt-1 text-gray-500 font-mono break-all">{r.code}</p>
                          <p className="mt-1 text-gray-500">
                            {SOURCE_LABEL[r.source]}
                            {r.issuedBy && ` · ${r.issuedBy}`}
                          </p>
                          {r.remark && <p className="mt-1 text-gray-500 break-all">备注：{r.remark}</p>}
                          {r.sourceRef && (
                            <p className="mt-1 text-gray-500 break-all">关联订单：{r.sourceRef}</p>
                          )}
                          <p className="mt-1 text-gray-400">
                            {new Date(r.createdAt).toLocaleString()}
                          </p>
                        </div>
                      ))}
                    </>
                  }
                >
                  {issuedRows.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-800 whitespace-nowrap">
                        {r.user.nickname ?? `用户#${r.user.id}`}
                      </td>
                      <td className="px-3 py-2 text-gray-500 font-mono">{r.code}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${COUPON_STATUS_CLS[r.status]}`}
                        >
                          {COUPON_STATUS_LABEL[r.status]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                        {SOURCE_LABEL[r.source]}
                      </td>
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{r.issuedBy ?? '-'}</td>
                      <td className="px-3 py-2 text-gray-600">{r.remark ?? '-'}</td>
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{r.sourceRef ?? '-'}</td>
                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                        {new Date(r.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </Table>
              </div>
              {!issuedLoading && (
                <Pagination
                  page={issuedPage}
                  total={issuedTotal}
                  pageSize={ISSUED_PAGE_SIZE}
                  onChange={setIssuedPage}
                />
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
