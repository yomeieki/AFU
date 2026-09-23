import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import Modal from './ui/Modal'
import Button from './ui/Button'
import { toast } from './ui/Toast'
import { resolveAbnormalRefund } from '../api/admin'
import type { Order } from '../types'

interface Props {
  order: Pick<Order, 'id' | 'orderNo' | 'remainingRefundable' | 'latestRefund'>
  onClose: () => void
  onDone: () => void
}

function yuan(fen: number) {
  return (fen / 100).toFixed(2)
}

function parseYuan(input: string): number | null {
  const t = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  return Math.round(parseFloat(t) * 100)
}

/**
 * P1 人工出口（2026-09-23）：只对 latestRefund.status === 'ABNORMAL' 的订单可打开——店员已经在
 * 微信商户平台核实过这笔退款的真实结果，回来这里记录，落账走 finalizeRefundSuccess/markRefundClosed
 * 同一条路径（服务端保证）。结构照抄 RefundDialog 的两步确认，但不复用它——那个组件店主已决定不动。
 */
export default function ResolveAbnormalRefundModal({ order, onClose, onDone }: Props) {
  const refund = order.latestRefund
  const [step, setStep] = useState<1 | 2>(1)
  const [result, setResult] = useState<'SUCCESS' | 'CLOSED'>('SUCCESS')
  const [amountInput, setAmountInput] = useState(refund ? yuan(refund.amount) : '')
  const [note, setNote] = useState('')
  const [confirmInput, setConfirmInput] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (!refund) return null

  const amountFen = parseYuan(amountInput)
  // CLOSED（核实为未退款）不改金额：这里只是让店员再对一遍单号金额，输入框只读、锁定为记录金额。
  const amountValid = result === 'CLOSED' ? amountFen === refund.amount : amountFen !== null && amountFen > 0 && amountFen <= order.remainingRefundable
  const noteValid = note.trim().length >= 4
  const amountChanged = result === 'SUCCESS' && amountFen !== null && amountFen !== refund.amount
  const canNext = amountValid && noteValid
  const confirmMatches = amountValid && parseYuan(confirmInput) === amountFen

  const reasonText = refund.reconcileLastError || refund.errorMessage || '微信返回退款异常'

  const handleSubmit = async () => {
    if (!confirmMatches || amountFen === null || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await resolveAbnormalRefund(order.id, refund.id, { result, verifiedAmount: amountFen, note: note.trim() })
      toast.success('已按人工核实结果处理')
      onDone()
    } catch (err: unknown) {
      const serverMessage = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      setError(serverMessage ?? '提交失败，请重试')
      setStep(1)
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls = (bad: boolean, disabled = false) =>
    `w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
      disabled ? 'bg-gray-50 text-gray-400' : bad ? 'border-red-300 focus:ring-red-300' : 'border-gray-300 focus:ring-brand-400'
    }`

  if (step === 1) {
    return (
      <Modal
        title="已在商户平台核实"
        width="sm"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>取消</Button>
            <Button variant="danger" disabled={!canNext} onClick={() => { setConfirmInput(''); setError(''); setStep(2) }}>下一步</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="text-xs text-gray-500 space-y-1 bg-gray-50 rounded-md p-3">
            <p>订单号：<span className="font-mono">{order.orderNo}</span></p>
            <p>退款单号：<span className="font-mono">{refund.outRefundNo}</span></p>
            <p>记录金额：<span className="font-semibold text-gray-800">¥{yuan(refund.amount)}</span></p>
            <p className="text-red-500">异常原因：{reasonText}</p>
          </div>
          <p className="text-xs text-gray-600 bg-orange-50 text-orange-700 rounded-md p-3">
            请先在微信商户平台 → 交易中心 → 退款查询里按退款单号核对，再选择结果。
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">核实结果</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setResult('SUCCESS'); setAmountInput(yuan(refund.amount)) }}
                className={`flex-1 px-3 py-1.5 rounded-md text-sm border ${result === 'SUCCESS' ? 'bg-green-50 border-green-400 text-green-700 font-medium' : 'bg-white border-gray-300 text-gray-600'}`}
              >
                微信已退款成功 → 记为已退款
              </button>
              <button
                type="button"
                onClick={() => { setResult('CLOSED'); setAmountInput(yuan(refund.amount)) }}
                className={`flex-1 px-3 py-1.5 rounded-md text-sm border ${result === 'CLOSED' ? 'bg-blue-50 border-blue-400 text-blue-700 font-medium' : 'bg-white border-gray-300 text-gray-600'}`}
              >
                微信未退款 → 释放，可重新发起
              </button>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">实退金额（元）</label>
            <input
              value={amountInput}
              inputMode="decimal"
              disabled={result === 'CLOSED'}
              onChange={(e) => setAmountInput(e.target.value)}
              className={inputCls(!!amountInput && !amountValid, result === 'CLOSED')}
            />
            {result === 'SUCCESS' && amountChanged && (
              <p className="text-xs text-orange-600 mt-1">实退金额与记录不同，将按实退金额落账，说明会自动注明原记录金额</p>
            )}
            {amountInput && !amountValid && (
              <p className="text-xs text-red-500 mt-1">
                {result === 'CLOSED' ? '核实为未退款时金额须与记录一致' : amountFen === null ? '请输入正确的金额' : amountFen <= 0 ? '金额必须大于 0' : `不能超过可退余额 ¥${yuan(order.remainingRefundable)}`}
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">说明（必填，至少 4 个字）</label>
            <textarea
              value={note}
              maxLength={100}
              rows={2}
              onChange={(e) => setNote(e.target.value)}
              placeholder="如：商户平台退款单号 500xxxx 已核对，金额一致"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title="确认处理结果"
      width="sm"
      closeOnOverlay={false}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={() => setStep(1)} disabled={submitting}>上一步</Button>
          <Button variant="danger" onClick={handleSubmit} disabled={!confirmMatches} loading={submitting}>
            {submitting ? '提交中...' : '确认提交'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2 bg-red-50 text-red-700 rounded-md p-3 text-sm">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <p>
            {result === 'SUCCESS'
              ? <>确认后系统将按 <span className="font-semibold">¥{yuan(amountFen ?? 0)}</span> 记为已退款、扣回对应积分并通知顾客，<span className="font-semibold">此操作不可撤销</span>；若微信其实未退，会造成重复退款。</>
              : <>确认后系统将释放该退款占位，之后重新发起会再退一次钱；请确认商户平台确实没有这笔退款。</>}
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">再次输入金额（元）以确认</label>
          <input
            value={confirmInput}
            autoFocus
            inputMode="decimal"
            onChange={(e) => setConfirmInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
            placeholder={`请输入 ${yuan(amountFen ?? 0)}`}
            className={inputCls(!!confirmInput && !confirmMatches)}
          />
          {confirmInput && !confirmMatches && <p className="text-xs text-red-500 mt-1">与上一步填写的金额不一致</p>}
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  )
}
