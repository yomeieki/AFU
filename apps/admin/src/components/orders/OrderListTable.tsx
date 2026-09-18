import { Fragment, ReactNode } from 'react'
import { ChevronRight, Copy, Phone } from 'lucide-react'
import Table from '../ui/Table'
import Button from '../ui/Button'
import StatusBadge from '../ui/StatusBadge'
import { AFTER_SALE_STATUS_LABEL } from '../../types'
import { fmtListTime } from '../../utils/time'
import { itemsSummary, channelTag, deliveryColumn } from '../../utils/order-list'
import { copyText } from './copyText'
import type { Order } from '../../types'

function yuan(fen: number) {
  return (fen / 100).toFixed(2)
}

const CHANNEL_TONE: Record<string, string> = {
  local: 'bg-orange-50 text-orange-700',
  pickup: 'bg-teal-50 text-teal-700',
  express: 'bg-blue-50 text-blue-700',
}

interface Props {
  list: Order[]
  loading: boolean
  loadFailed?: boolean
  emptyText: string
  now: Date
  onOpen: (o: Order) => void
  /** 传入则多一列/多一行「操作」按钮组；调用方自己 stopPropagation */
  renderActions?: (o: Order) => ReactNode
  /** 传入则「售后待处理/售后处理中」小标可点（跳售后页签），且卡片/表格都渲染；
   * 不传则退回不可点的 <span>（如同城列表本就没有售后处理入口） */
  onAfterSaleTag?: (o: Order) => void
  /** 传入则加载失败态多一个「重试」按钮 */
  onRetry?: () => void
}

/**
 * 两个订单列表（同城 / 邮寄）共用的表格 + 卡片。查账用列表点整行/整卡进详情页，
 * `renderActions` 承接各页原有的业务按钮（保留原顺序与行为，不在这里新增/删减）。
 * 三档列数：768–1023 六列、1024–1279 七列（操作在商品摘要下）、≥1280 有操作时八列。
 */
export default function OrderListTable({ list, loading, loadFailed, emptyText, now, onOpen, renderActions, onAfterSaleTag, onRetry }: Props) {
  if (loadFailed) {
    return (
      <div className="py-10 flex flex-col items-center gap-3 text-sm text-red-600">
        <span>订单列表加载失败，当前显示的不是真实数据</span>
        {onRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry}>重试</Button>
        )}
      </div>
    )
  }

  const columns = (renderActions ? 6 : 5) + 2 // 基础列 + 配送·取餐 <lg 隐藏、操作 <xl 隐藏，两列都仍计数 + 末尾箭头列

  const afterSaleTag = (o: Order) => {
    if (!o.afterSale || !['PENDING', 'APPROVED'].includes(o.afterSale.status)) return null
    const cls = `px-2 py-0.5 rounded-full text-xs whitespace-nowrap xl:whitespace-normal ${o.afterSale.status === 'PENDING' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`
    const text = `售后${AFTER_SALE_STATUS_LABEL[o.afterSale.status]}`
    if (!onAfterSaleTag) return <span className={cls}>{text}</span>
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onAfterSaleTag(o) }}
        className={`${cls} hover:opacity-80`}
      >
        {text}
      </button>
    )
  }

  return (
    <Table
      columns={columns}
      loading={loading}
      isEmpty={list.length === 0}
      emptyText={emptyText}
      head={
        <tr>
          <th className="text-left px-4 py-3">订单</th>
          <th className="text-left px-4 py-3">顾客</th>
          <th className="text-left px-4 py-3">商品</th>
          <th className="text-right px-4 py-3">实付</th>
          <th className="text-left px-4 py-3">状态</th>
          <th className="text-left px-4 py-3 hidden lg:table-cell">配送·取餐</th>
          {/* 配送·取餐 <lg 隐藏、操作 <xl 隐藏，两列都仍计数——loading 骨架行只是视觉占位，多一列不影响可读性 */}
          {renderActions && <th className="text-left px-4 py-3 hidden xl:table-cell">操作</th>}
          <th className="px-2 py-3" />
        </tr>
      }
      mobileCards={
        <>
          {list.map((o) => {
            const tag = channelTag(o.deliveryType)
            const [line1, line2] = deliveryColumn(o, now)
            return (
              <div key={o.id} onClick={() => onOpen(o)} className="border border-gray-100 rounded-lg p-3 cursor-pointer active:bg-gray-50">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <StatusBadge status={o.status} deliveryType={o.deliveryType} />
                  {afterSaleTag(o)}
                  <span className={`text-xs px-1.5 py-0.5 rounded ${CHANNEL_TONE[tag.tone]}`}>{tag.label}</span>
                  <span className="font-mono text-xs text-gray-500 truncate">{o.orderNo}</span>
                  {o.remark && <span className="text-[10px] text-orange-600 bg-orange-50 rounded px-1 shrink-0" title={o.remark}>备注</span>}
                  <span className="ml-auto text-xs text-gray-400 shrink-0">{fmtListTime(o.createdAt, now)}</span>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-800 truncate">
                    {o.receiverName}
                    <a href={`tel:${o.receiverPhone}`} onClick={(e) => e.stopPropagation()} className="ml-1.5 text-brand-600">{o.receiverPhone}</a>
                  </span>
                  <span className="text-base font-semibold text-brand-600 shrink-0">¥{yuan(o.actualAmount)}</span>
                </div>
                <p className="text-xs text-gray-500 truncate mt-1">{itemsSummary(o.items)}</p>
                <p className="text-xs text-gray-400 mt-1">
                  {line1}{line2 && ` · ${line2}`}
                  {o.refundedAmount > 0 && <span className="ml-2 text-red-500">已退 ¥{yuan(o.refundedAmount)}</span>}
                </p>
                {renderActions && (
                  <div onClick={(e) => e.stopPropagation()} className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
                    {renderActions(o)}
                  </div>
                )}
              </div>
            )
          })}
        </>
      }
    >
      {list.map((o) => {
        const tag = channelTag(o.deliveryType)
        const [line1, line2] = deliveryColumn(o, now)
        return (
          <Fragment key={o.id}>
            <tr className="hover:bg-brand-50/40 cursor-pointer" onClick={() => onOpen(o)}>
              <td className="px-4 py-3">
                <div className="font-mono text-gray-700">
                  {o.orderNo}
                  {o.remark && <span className="ml-1.5 text-[10px] text-orange-600 bg-orange-50 rounded px-1 whitespace-nowrap" title={o.remark}>备注</span>}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className={`text-xs px-1.5 py-0.5 rounded whitespace-nowrap shrink-0 ${CHANNEL_TONE[tag.tone]}`}>{tag.label}</span>
                  <span className="text-xs text-gray-400 whitespace-nowrap shrink-0">{fmtListTime(o.createdAt, now)}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-gray-800">
                <div>{o.receiverName}</div>
                <div className="mt-0.5 flex items-center gap-1 text-xs text-gray-500">
                  <a href={`tel:${o.receiverPhone}`} onClick={(e) => e.stopPropagation()} className="text-brand-600 inline-flex items-center gap-0.5 hover:underline">
                    <Phone className="w-3 h-3" />
                    {o.receiverPhone}
                  </a>
                  <button onClick={(e) => { e.stopPropagation(); copyText(o.receiverPhone) }} className="text-gray-400 hover:text-gray-600" title="复制手机号" aria-label="复制手机号">
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
              </td>
              <td className="px-4 py-3 text-gray-600 w-full max-w-0 xl:w-auto xl:max-w-none">
                <div className="truncate lg:max-w-[288px]">{itemsSummary(o.items)}</div>
                {renderActions && (
                  <div data-testid="order-row-actions" className="xl:hidden mt-1 flex flex-wrap gap-x-3 gap-y-1 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    {renderActions(o)}
                  </div>
                )}
              </td>
              <td className="px-4 py-3 text-right font-semibold text-brand-600">
                ¥{yuan(o.actualAmount)}
                {o.refundedAmount > 0 && <div className="text-xs font-normal text-red-500 whitespace-nowrap">已退 ¥{yuan(o.refundedAmount)}</div>}
              </td>
              <td className="px-4 py-3">
                <span className="inline-flex items-center gap-1.5 flex-wrap">
                  <StatusBadge status={o.status} deliveryType={o.deliveryType} />
                  {afterSaleTag(o)}
                </span>
              </td>
              <td className="px-4 py-3 hidden lg:table-cell text-xs text-gray-500 whitespace-nowrap xl:whitespace-normal">
                <div>{line1}</div>
                {line2 && <div className="text-gray-400">{line2}</div>}
              </td>
              {renderActions && (
                <td className="hidden xl:table-cell px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">{renderActions(o)}</div>
                </td>
              )}
              <td className="px-2 py-3 text-gray-300">
                <ChevronRight className="w-4 h-4" />
              </td>
            </tr>
          </Fragment>
        )
      })}
    </Table>
  )
}
