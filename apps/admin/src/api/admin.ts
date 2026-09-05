import client from './client'
import type {
  ApiResponse,
  PaginatedData,
  Category,
  Product,
  Order,
  Stats,
  QrCodeResult,
  Shipment,
  AdminUser,
  UserOrder,
  ScanSummary,
  ScanTrendPoint,
  ScanProductRow,
  SalesTrendPoint,
  Banner,
  RefundSummary,
  AfterSale,
  ShippingSettings,
  Channel,
  LocalDeliverySettings,
  WorkbenchSnapshot,
  DeliveryInfo,
  DeliveryEventInfo,
  RejectReason,
  PrinterSettings,
  PrinterHealthEntry,
  PrintJob,
  PrinterEnqueueResult,
} from '../types'

// Auth
export const login = (username: string, password: string) =>
  client.post<
    ApiResponse<{
      token: string
      adminInfo: { id: number; username: string; name: string | null; role: string }
    }>
  >('/admin/login', { username, password })

// Stats
export const getStats = () => client.get<ApiResponse<Stats>>('/admin/stats')

// Categories
export const getCategories = (channel?: Channel) =>
  client.get<ApiResponse<Category[]>>('/admin/categories', { params: channel ? { channel } : undefined })

export const createCategory = (data: Partial<Category>) =>
  client.post<ApiResponse<Category>>('/admin/categories', data)

export const updateCategory = (id: number, data: Partial<Category>) =>
  client.put<ApiResponse<Category>>(`/admin/categories/${id}`, data)

export const deleteCategory = (id: number) =>
  client.delete<ApiResponse<null>>(`/admin/categories/${id}`)

// Products
export const getProducts = (params?: {
  page?: number
  pageSize?: number
  categoryId?: number
  keyword?: string
  status?: string
  channel?: Channel
}) => client.get<ApiResponse<PaginatedData<Product>>>('/admin/products', { params })

type ProductPayload = Partial<Omit<Product, 'images'>> & { imageUrls?: string[] }

export const createProduct = (data: ProductPayload) =>
  client.post<ApiResponse<Product>>('/admin/products', data)

export const updateProduct = (id: number, data: ProductPayload) =>
  client.put<ApiResponse<Product>>(`/admin/products/${id}`, data)

export const deleteProduct = (id: number) =>
  client.delete<ApiResponse<null>>(`/admin/products/${id}`)

export const generateQrCode = (id: number) =>
  client.post<ApiResponse<QrCodeResult>>(`/admin/products/${id}/qrcode`)

// Orders
export const getOrders = (params?: {
  page?: number
  pageSize?: number
  status?: string
  /** 订单号 / 收货人 / 手机号 模糊 */
  keyword?: string
  deliveryType?: 'EXPRESS' | 'LOCAL' | 'ALL'
}) => client.get<ApiResponse<PaginatedData<Order>>>('/admin/orders', { params })

export const getOrder = (id: number) =>
  client.get<ApiResponse<Order>>(`/admin/orders/${id}`)

export const acceptOrder = (id: number) =>
  client.post<ApiResponse<Order>>(`/admin/orders/${id}/accept`)

export const shipOrder = (id: number, data: { expressCompany: string; expressNo: string; remark?: string }) =>
  client.post<ApiResponse<{ shipment: Shipment; order: Order }>>(`/admin/orders/${id}/ship`, data)

// 退款：amount（分）可为部分或全额，服务端校验 0 < amount <= 可退余额
// idempotencyKey 可选：由服务端派生确定性 outRefundNo，重试落回同一笔退款；不传时行为不变（如 CancelAndRefundModal）
export const refundOrder = (id: number, data: { amount: number; reason?: string; idempotencyKey?: string }) =>
  client.post<ApiResponse<{ order: Order; refund: RefundSummary; mode: 'mock' | 'wechat'; isFull: boolean }>>(
    `/admin/orders/${id}/refund`,
    data
  )

// 商家标记完成（SHIPPED → COMPLETED）
export const completeOrder = (id: number) =>
  client.post<ApiResponse<Order>>(`/admin/orders/${id}/complete`)

// 售后
export const getAfterSales = (params?: { page?: number; pageSize?: number; status?: string }) =>
  client.get<ApiResponse<PaginatedData<AfterSale>>>('/admin/after-sales', { params })
// idempotencyKey 可选：与 refundOrder 同一套幂等机制
export const approveAfterSale = (id: number, data: { amount: number; reply?: string; idempotencyKey?: string }) =>
  client.post<ApiResponse<{ afterSale: AfterSale; refund: RefundSummary; mode: 'mock' | 'wechat' }>>(
    `/admin/after-sales/${id}/approve`,
    data
  )
export const rejectAfterSale = (id: number, reply: string) =>
  client.post<ApiResponse<AfterSale>>(`/admin/after-sales/${id}/reject`, { reply })

// 小程序 web-view 免登录：一次性 code 换 token
export const loginWithWebviewCode = (code: string) =>
  client.post<
    ApiResponse<{
      token: string
      adminInfo: { id: number; username: string; name: string | null; role: string }
    }>
  >('/admin/login/webview', { code })

export const completeRefund = (id: number) =>
  client.post<ApiResponse<Order>>(`/admin/orders/${id}/refund-complete`)

export const cancelOrder = (id: number) =>
  client.put<ApiResponse<Order>>(`/admin/orders/${id}/status`, { status: 'CANCELLED' })

// Users
export const getUsers = (params?: { page?: number; pageSize?: number; keyword?: string }) =>
  client.get<ApiResponse<PaginatedData<AdminUser>>>('/admin/users', { params })

export const getUserOrders = (userId: number, params?: { page?: number; pageSize?: number }) =>
  client.get<ApiResponse<PaginatedData<UserOrder>>>(`/admin/users/${userId}/orders`, { params })

// Upload
export const uploadImage = (file: File) => {
  const formData = new FormData()
  formData.append('file', file)
  return client.post<ApiResponse<{ url: string }>>('/admin/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}

// 待发货订单数（后台提醒轮询）
export const getPendingOrderCount = () =>
  client.get<
    ApiResponse<{
      count: number
      latestPaidAt: string | null
      refundingCount: number
      lowStockCount: number
      lowStockThreshold: number
      afterSaleCount: number
      localPendingCount: number
    }>
  >('/admin/orders/pending-count')

// 扫码统计
export interface ScanRangeParams {
  startDate?: string
  endDate?: string
}
export const getScanSummary = (params?: ScanRangeParams) =>
  client.get<ApiResponse<ScanSummary>>('/admin/scan-stats/summary', { params })
export const getScanTrend = (params?: ScanRangeParams) =>
  client.get<ApiResponse<{ list: ScanTrendPoint[] }>>('/admin/scan-stats/trend', { params })
export const getScanProducts = (params?: ScanRangeParams & { page?: number; pageSize?: number }) =>
  client.get<ApiResponse<{ list: ScanProductRow[]; total: number; page: number; pageSize: number }>>(
    '/admin/scan-stats/products',
    { params }
  )

// 销售趋势
export const getSalesTrend = (days: 7 | 30 = 7) =>
  client.get<ApiResponse<{ list: SalesTrendPoint[] }>>('/admin/stats/trend', { params: { days } })

// Banner 管理
export const getBanners = () => client.get<ApiResponse<Banner[]>>('/admin/banners')
export const createBanner = (data: Partial<Banner>) =>
  client.post<ApiResponse<Banner>>('/admin/banners', data)
export const updateBanner = (id: number, data: Partial<Banner>) =>
  client.put<ApiResponse<Banner>>(`/admin/banners/${id}`, data)
export const updateBannerStatus = (id: number, status: number) =>
  client.put<ApiResponse<Banner>>(`/admin/banners/${id}/status`, { status })
export const deleteBanner = (id: number) =>
  client.delete<ApiResponse<null>>(`/admin/banners/${id}`)

// 批量上/下架（开档/收档；categoryId 缺省 = 全部）
export const batchProductStatus = (status: 'ON_SHELF' | 'OFF_SHELF', categoryId?: number, channel?: Channel) =>
  client.post<ApiResponse<{ updated: number }>>('/admin/products/batch-status', {
    status,
    ...(categoryId ? { categoryId } : {}),
    ...(channel ? { channel } : {}),
  })

// 批量生成二维码（缺省 = 所有无码上架商品）
export const batchGenerateQrCodes = (ids?: number[]) =>
  client.post<ApiResponse<{ generated: number; failed: number[] }>>(
    '/admin/products/qrcode/batch',
    ids ? { ids } : {}
  )

// 店铺设置
export const getShippingSettings = () =>
  client.get<ApiResponse<ShippingSettings>>('/admin/settings/shipping').then((r) => r.data.data)

export const updateShippingSettings = (payload: ShippingSettings) =>
  client.put<ApiResponse<ShippingSettings>>('/admin/settings/shipping', payload).then((r) => r.data.data)

// 同城设置
export const getLocalSettings = () =>
  client.get<ApiResponse<LocalDeliverySettings>>('/admin/settings/local-delivery').then((r) => r.data.data)
export const updateLocalSettings = (payload: LocalDeliverySettings) =>
  client.put<ApiResponse<LocalDeliverySettings>>('/admin/settings/local-delivery', payload).then((r) => r.data.data)
export const patchStoreLocation = (latE6: number, lngE6: number) =>
  client.patch<ApiResponse<LocalDeliverySettings>>('/admin/settings/local-delivery/store-location', { latE6, lngE6 }).then((r) => r.data.data)
export const pauseLocal = (reason: string, until?: string) =>
  client.post<ApiResponse<LocalDeliverySettings>>('/admin/settings/local-delivery/pause', { reason, until }).then((r) => r.data.data)
export const resumeLocal = () =>
  client.delete<ApiResponse<LocalDeliverySettings>>('/admin/settings/local-delivery/pause').then((r) => r.data.data)

// 接单工作台
export const getWorkbenchSnapshot = (fresh = false) =>
  client.get<ApiResponse<WorkbenchSnapshot>>('/admin/workbench/snapshot', { params: fresh ? { fresh: 1 } : undefined })

// 同城订单——接单/呼叫/配送单操作
export const acceptLocalOrder = (id: number) => client.post<ApiResponse<Order>>(`/admin/local/orders/${id}/accept`)
export const acceptAndCallLocalOrder = (id: number) =>
  client.post<ApiResponse<{ accepted: boolean; deliveryNo: string; status: string }>>(`/admin/local/orders/${id}/accept-and-call`)
export const callRider = (id: number) =>
  client.post<ApiResponse<{ deliveryNo: string; status: string; quotedFeeFen: number | null }>>(`/admin/local/orders/${id}/call`)
export const getOrderDelivery = (id: number) =>
  client.get<ApiResponse<{ delivery: DeliveryInfo | null; events: DeliveryEventInfo[] }>>(`/admin/local/orders/${id}/delivery`)
export const precancelDelivery = (id: number) =>
  client.post<ApiResponse<{ cancelFeeFen: number | null }>>(`/admin/local/orders/${id}/delivery/precancel`)
export const cancelDelivery = (id: number, reason?: string) =>
  client.post<ApiResponse<{ cancelFeeFen: number | null }>>(`/admin/local/orders/${id}/delivery/cancel`, { reason })
export const addDeliveryTip = (id: number, amount: number) =>
  client.post<ApiResponse<{ tipFeeFen: number }>>(`/admin/local/orders/${id}/delivery/tip`, { amount })
export const selfDeliverOrder = (id: number, data: { name: string; phone: string }) =>
  client.post<ApiResponse<{ deliveryNo: string }>>(`/admin/local/orders/${id}/self-deliver`, data)
export const markOrderDelivered = (id: number) => client.post<ApiResponse<null>>(`/admin/local/orders/${id}/delivered`)
export const voidUnknownDelivery = (id: number) => client.post<ApiResponse<null>>(`/admin/local/orders/${id}/delivery/void`)

// 拒单（PENDING_PAYMENT/PAID/PREPARING 均可）
export const rejectOrder = (id: number, data: { reason: RejectReason; note?: string; soldOutProductIds?: number[] }) =>
  client.post<ApiResponse<{ refund: unknown; offShelfCount: number; cancelReason: string }>>(`/admin/orders/${id}/reject`, data)

// 快递100 余额熔断——手动恢复
export const resetKd100Circuit = () => client.post<ApiResponse<unknown>>('/admin/system/kd100-circuit/reset')

// 打印机（飞鹅云）。PUT 是整包覆盖——调用方必须先 getPrinterSettings() 拿完整对象、改字段后原样传回。
export const getPrinterSettings = () =>
  client.get<ApiResponse<PrinterSettings>>('/admin/settings/printer').then((r) => r.data.data)
export const updatePrinterSettings = (payload: PrinterSettings) =>
  client.put<ApiResponse<PrinterSettings>>('/admin/settings/printer', payload).then((r) => r.data.data)

// 绑定：key 只在这一次调用里使用，服务端不落库明文、不回显
export const bindPrinter = (data: { sn: string; key: string; name?: string }) =>
  client.post<ApiResponse<PrinterSettings>>('/admin/printers/bind', data).then((r) => r.data.data)
// 解绑：仅从本地设置移除，不调飞鹅侧解绑
export const unbindPrinter = (sn: string) =>
  client.delete<ApiResponse<PrinterSettings>>(`/admin/printers/${encodeURIComponent(sn)}`).then((r) => r.data.data)
export const testPrinter = (sn: string) =>
  client.post<ApiResponse<PrinterEnqueueResult>>(`/admin/printers/${encodeURIComponent(sn)}/test`).then((r) => r.data.data)
// 清空该机云端待打印队列（清空整个队列，不能按单删）
export const clearPrinterQueue = (sn: string) =>
  client.post<ApiResponse<{ ok: true }>>(`/admin/printers/${encodeURIComponent(sn)}/clear-queue`).then((r) => r.data.data)
export const getPrinterStatus = () =>
  client.get<ApiResponse<PrinterHealthEntry[]>>('/admin/printers/status').then((r) => r.data.data)

// 打印记录：不传 orderId 返回全局最近 20 条 + total；传 orderId 返回该单最多 50 条
export const getPrintJobs = (orderId?: number) =>
  client.get<ApiResponse<{ list: PrintJob[]; total: number }>>('/admin/print-jobs', { params: orderId ? { orderId } : undefined }).then((r) => r.data.data)
export const retryPrintJob = (id: number) =>
  client.post<ApiResponse<{ ok: true; status: string } | { ok: false; reason: string }>>(`/admin/print-jobs/${id}/retry`).then((r) => r.data.data)

// 订单卡「重打小票」
export const reprintOrder = (id: number) =>
  client.post<ApiResponse<PrinterEnqueueResult>>(`/admin/orders/${id}/reprint`).then((r) => r.data.data)
