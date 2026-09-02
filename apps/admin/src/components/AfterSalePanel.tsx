import { useEffect, useState } from 'react'
import { Phone, RefreshCw } from 'lucide-react'
import { getAfterSales, rejectAfterSale } from '../api/admin'
import { toast } from './ui/Toast'
import Button from './ui/Button'
import Modal from './ui/Modal'
import Pagination from './ui/Pagination'
import StatusBadge from './ui/StatusBadge'
import EmptyState from './ui/EmptyState'
import RefundDialog from './RefundDialog'
import { AFTER_SALE_STATUS_LABEL, type AfterSale, type AfterSaleStatus } from '../types'

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'PENDING', label: '待处理' },
  { value: 'APPROVED', label: '退款中' },
  { value: 'DONE', label: '已退款' },
  { value: 'REJECTED', label: '已拒绝' },
  { value: '', label: '全部' },
]

const STATUS_CLS: Record<AfterSaleStatus, string> = {
  PENDING: 'bg-red-50 text-red-600',
  APPROVED: 'bg-blue-50 text-blue-600',
  DONE: 'bg-green-50 text-green-600',
  REJECTED: 'bg-gray-100 text-gray-500',
}

function yuan(fen: number) {
  return (fen / 100).toFixed(2)
}

/**
 * 售后 Tab：顾客在小程序提交的售后申请。店员「同意并退款」（走 RefundDialog 双重确认，金额自填）或「拒绝」（须写回复）。
 */
export default function AfterSalePanel({ onChanged }: { onChanged?: () => void }) {
  const [status, setStatus] = useState('PENDING')
  const [list, setList] = useState<AfterSale[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [loading, setLoading] = useState(true)
  const [approveTarget, setApproveTarget] = useState<AfterSale | null>(null)
  const [rejectTarget, setRejectTarget] = useState<AfterSale | null>(null)
  const [rejectReply, setRejectReply] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)

  const load = (p = page) => {
    setLoading(true)
    getAfterSales({ page: p, pageSize, status: status || undefined })
      .then((res) => {
        setList(res.data.data.list)
        setTotal(res.data.data.total)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [page, status]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleReject = async () => {
    if (!rejectTarget || !rejectReply.trim()) return
    setRejecting(true)
    try {
      await rejectAfterSale(rejectTarget.id, rejectReply.trim())
      toast.success('已拒绝并回复顾客')
      setRejectTarget(null)
      setRejectReply('')
      load()
      onChanged?.()
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '操作失败')
    } finally {
      setRejecting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-lg shadow-card px-3 py-2 flex items-center gap-2 overflow-x-auto">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => { setPage(1); setStatus(f.value) }}
            className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap ${
              status === f.value ? 'bg-brand-50 text-brand-600 font-medium' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            {f.label}
          </button>
        ))}
        <button onClick={() => load()} className="ml-auto text-gray-400 hover:text-gray-600" title="刷新" aria-label="刷新">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-card overflow-hidden">
        {loading ? (
          <div className="p-3 space-y-3">
            {[...Array(3)].map((_, i) => <div key={i} className="h-24 bg-gray-100 rounded-lg animate-pulse" />)}
          </div>
        ) : list.length === 0 ? (
          <EmptyState text={status === 'PENDING' ? '没有待处理的售后申请' : '暂无售后记录'} />
        ) : (
          <div className="divide-y divide-gray-100">
            {list.map((a) => (
              <div key={a.id} className="p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_CLS[a.status]}`}>{AFTER_SALE_STATUS_LABEL[a.status]}</span>
                  <span className="font-medium text-gray-800">{a.reasonLabel}</span>
                  <span className="font-mono text-xs text-gray-500">{a.orderNo}</span>
                  <StatusBadge status={a.order.status} />
                  <span className="ml-auto text-xs text-gray-400">{new Date(a.createdAt).toLocaleString('zh-CN')}</span>
                </div>
                <div className="text-sm text-gray-700 flex flex-wrap gap-x-4 gap-y-1">
                  <span>
                    {a.order.receiverName}{' '}
                    <a href={`tel:${a.order.receiverPhone}`} className="text-brand-600 inline-flex items-center gap-0.5">
                      <Phone className="w-3.5 h-3.5" />{a.order.receiverPhone}
                    </a>
                  </span>
                  <span>实付 ¥{yuan(a.order.actualAmount)}</span>
                  {a.order.refundedAmount > 0 && <span>已退 ¥{yuan(a.order.refundedAmount)}</span>}
                  <span className="text-red-600">可退 ¥{yuan(a.remainingRefundable)}</span>
                </div>
                <p className="text-xs text-gray-500">
                  {a.order.items.map((it) => `${it.productName}${it.specText ? `[${it.specText}]` : ''}×${it.quantity}`).join('，')}
                  {a.order.shipment?.expressNo && `　物流：${a.order.shipment.expressCompany} ${a.order.shipment.expressNo}`}
                </p>
                {a.description && <p className="text-sm text-gray-800 bg-gray-50 rounded-md px-3 py-2">顾客说明：{a.description}</p>}
                {a.images.length > 0 && (
                  <div className="flex gap-2">
                    {a.images.map((url, i) => (
                      <button key={i} type="button" onClick={() => setPreview(url)} className="w-16 h-16 rounded-md overflow-hidden border border-gray-200">
                        <img src={url} alt="" className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
                {a.reply && <p className="text-xs text-gray-600">店员回复：{a.reply}{a.handledBy && `（${a.handledBy}）`}</p>}
                {a.status === 'PENDING' && (
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" variant="danger" onClick={() => setApproveTarget(a)} disabled={a.remainingRefundable <= 0}>
                      同意并退款
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => { setRejectTarget(a); setRejectReply('') }}>
                      拒绝
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {!loading && <Pagination page={page} total={total} pageSize={pageSize} onChange={setPage} />}
      </div>

      {approveTarget && (
        <RefundDialog
          afterSaleId={approveTarget.id}
          order={{
            id: approveTarget.order.id,
            orderNo: approveTarget.orderNo,
            status: approveTarget.order.status,
            actualAmount: approveTarget.order.actualAmount,
            refundedAmount: approveTarget.order.refundedAmount,
            remainingRefundable: approveTarget.remainingRefundable,
            receiverName: approveTarget.order.receiverName,
            receiverPhone: approveTarget.order.receiverPhone,
            latestRefund: null,
          }}
          onClose={() => setApproveTarget(null)}
          onDone={() => {
            setApproveTarget(null)
            load()
            onChanged?.()
          }}
        />
      )}

      {rejectTarget && (
        <Modal
          title="拒绝售后申请"
          width="sm"
          onClose={() => setRejectTarget(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRejectTarget(null)} disabled={rejecting}>取消</Button>
              <Button variant="danger" onClick={handleReject} loading={rejecting} disabled={!rejectReply.trim()}>确认拒绝</Button>
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-sm text-gray-600">订单 <span className="font-mono">{rejectTarget.orderNo}</span>，原因「{rejectTarget.reasonLabel}」。请填写拒绝理由，顾客将在订单页看到。</p>
            <textarea
              value={rejectReply}
              maxLength={255}
              rows={3}
              autoFocus
              onChange={(e) => setRejectReply(e.target.value)}
              placeholder="如：照片中商品完好，未见破损；如有疑问请电话联系我们"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
          </div>
        </Modal>
      )}

      {preview && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <img src={preview} alt="" className="max-w-full max-h-full rounded-md" />
        </div>
      )}
    </div>
  )
}
