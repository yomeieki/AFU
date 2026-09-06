import { useEffect, useState } from 'react'
import Modal from './ui/Modal'
import Button from './ui/Button'
import { toast } from './ui/Toast'
import { getCouponTemplates, issueUserCoupon } from '../api/admin'
import type { CouponTemplate } from '../types'

interface Props {
  userId: number
  /** 显示给店员看的「发给谁」，订单页传收货人名，用户页传昵称或 openid 尾号 */
  userLabel: string
  /** 从订单页/售后面板打开时预填的订单号，落到券的 sourceRef */
  defaultOrderNo?: string
  onClose: () => void
  /** 发成功后由父组件刷新自己的数据（列表行的可用券数、券记录弹窗等） */
  onDone: () => void
}

// 会原样写进券记录的 remark 里，属于店内口径（M3 D3 默认）。
// 「其他」走手填——预设吃不下的情形一定存在，不留出口店员就会硬套一个不准的。
const REMARK_PRESETS = ['少发补偿', '品质问题', '配送延误', '其他'] as const
type RemarkPreset = (typeof REMARK_PRESETS)[number]

const yuan = (fen: number) => (fen / 100).toFixed(2)

const CHANNEL_LABEL: Record<string, string> = { ALL: '通用', LOCAL: '仅同城', EXPRESS: '仅邮寄' }

/**
 * 定向发券（赔偿券）双步确认。
 *
 * 为什么要两步：这个端点**凭空造出真金白银**，且不消耗任何库存——ADMIN 券没有 totalLimit
 * 这道防线，点错一次就是白送一张券出去，事后只能靠券记录追。照 `RefundDialog` 的形状做：
 * 第一步选与填，第二步复述「给谁、发什么、多少钱、什么时候过期」再确认。
 *
 * 与退款那个弹窗的区别：这里**不要求重新手输金额**。退款是从账上划钱出去、金额由店员任填，
 * 输错一位就是几百块；发券的面额是模板定死的、不可编辑，复述一遍足够挡住误点，
 * 再加一道抄写只会让店员养成机械抄写的习惯，反而稀释了退款那一处的仪式感。
 */
export default function IssueCouponModal({ userId, userLabel, defaultOrderNo, onClose, onDone }: Props) {
  const [step, setStep] = useState<1 | 2>(1)
  const [templates, setTemplates] = useState<CouponTemplate[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [templateId, setTemplateId] = useState<number | null>(null)
  const [preset, setPreset] = useState<RemarkPreset | ''>('')
  const [customRemark, setCustomRemark] = useState('')
  const [orderNo, setOrderNo] = useState(defaultOrderNo ?? '')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 只列 ADMIN 且 ON 的模板：服务端也只认这一种（POINTS/CAMPAIGN 带 totalLimit 语义，
  // 从这条路发会绕开 issuedCount 那道并发防线），前端先筛掉免得店员选了才被拒。
  useEffect(() => {
    getCouponTemplates({ source: 'ADMIN', status: 'ON' })
      .then(setTemplates)
      .catch(() => {
        setLoadFailed(true)
        toast.error('券模板加载失败，请关闭重试')
      })
  }, [])

  const selected = templates?.find((t) => t.id === templateId) ?? null
  const remark = preset === '其他' ? customRemark.trim() : preset
  const remarkOk = preset !== '' && (preset !== '其他' || customRemark.trim().length > 0)
  const canNext = selected !== null && remarkOk

  const handleSubmit = async () => {
    if (!selected || !remarkOk || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const coupon = await issueUserCoupon(userId, {
        templateId: selected.id,
        remark,
        orderNo: orderNo.trim() || undefined,
      })
      toast.success(`已发券 ${coupon.code}`)
      onDone()
      onClose()
    } catch (err: unknown) {
      // 服务端的拒绝理由都是店员能自己修的（模板被停用、订单号不属于该用户），原样显示；
      // 回到第一步是因为要改的东西都在第一步。
      setError(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '发券失败，请稍后重试'
      )
      setStep(1)
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'

  if (step === 2 && selected) {
    return (
      <Modal
        title="确认发放这张券？"
        onClose={onClose}
        width="sm"
        closeOnOverlay={false}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setStep(1)} disabled={submitting}>
              返回修改
            </Button>
            <Button variant="danger" onClick={handleSubmit} loading={submitting}>
              确认发放
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          <div className="rounded-md bg-red-50 border border-red-200 p-3 text-red-700 space-y-1">
            <p>
              给 <span className="font-semibold">{userLabel}</span> 发放
            </p>
            <p className="text-base font-semibold">
              {selected.name} · ¥{yuan(selected.amount)}
              {selected.threshold > 0 ? `（满 ¥${yuan(selected.threshold)} 可用）` : '（无门槛）'}
            </p>
            <p>
              {CHANNEL_LABEL[selected.channel] ?? selected.channel} · 领取后 {selected.validDays} 天内有效
            </p>
          </div>
          <p className="text-gray-600">
            备注：<span className="text-gray-900">{remark}</span>
          </p>
          {orderNo.trim() && (
            <p className="text-gray-600">
              关联订单：<span className="text-gray-900">{orderNo.trim()}</span>
            </p>
          )}
          <p className="text-xs text-gray-500">券一旦发出无法撤回，只能等它自然过期。</p>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title={`发放优惠券 — ${userLabel}`}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => setStep(2)} disabled={!canNext}>
            下一步
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-600">{error}</div>}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">选择券模板</label>
          {loadFailed ? (
            <p className="text-sm text-red-600">券模板加载失败，请关闭弹窗重试。</p>
          ) : templates === null ? (
            <p className="text-sm text-gray-500">加载中...</p>
          ) : templates.length === 0 ? (
            // 空态要说清楚去哪建，否则店员只会看到一个空框
            <p className="text-sm text-gray-500">
              还没有「手动发放」类型的券模板。请先到「优惠券」页新建一个来源为「手动发放」的模板。
            </p>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTemplateId(t.id)}
                  className={`w-full text-left rounded-md border px-3 py-2 transition-colors ${
                    templateId === t.id
                      ? 'bg-brand-50 border-brand-400'
                      : 'bg-white border-gray-300 hover:border-gray-400'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-gray-900">{t.name}</span>
                    <span className="text-brand-600 font-semibold whitespace-nowrap">¥{yuan(t.amount)}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {t.threshold > 0 ? `满 ¥${yuan(t.threshold)} 可用` : '无门槛'} ·{' '}
                    {CHANNEL_LABEL[t.channel] ?? t.channel} · {t.validDays} 天有效
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            发放原因<span className="text-red-500">*</span>
            <span className="ml-1 text-xs font-normal text-gray-400">（只在后台可见，顾客看不到）</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {REMARK_PRESETS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setPreset(r)}
                className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                  preset === r
                    ? 'bg-brand-50 border-brand-400 text-brand-600 font-medium'
                    : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          {preset === '其他' && (
            <input
              value={customRemark}
              maxLength={255}
              autoFocus
              onChange={(e) => setCustomRemark(e.target.value)}
              placeholder="请填写发放原因"
              className={`${inputCls} mt-2`}
            />
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            关联订单号<span className="ml-1 text-xs font-normal text-gray-400">（选填，为哪一单补偿）</span>
          </label>
          <input
            value={orderNo}
            maxLength={64}
            onChange={(e) => setOrderNo(e.target.value)}
            placeholder="ORD…"
            className={inputCls}
          />
          <p className="mt-1 text-xs text-gray-400">必须是这位顾客自己的订单，填错会被拒绝。</p>
        </div>
      </div>
    </Modal>
  )
}
