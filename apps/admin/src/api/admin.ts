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
export const getCategories = () =>
  client.get<ApiResponse<Category[]>>('/admin/categories')

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
}) => client.get<ApiResponse<PaginatedData<Order>>>('/admin/orders', { params })

export const getOrder = (id: number) =>
  client.get<ApiResponse<Order>>(`/admin/orders/${id}`)

export const acceptOrder = (id: number) =>
  client.post<ApiResponse<Order>>(`/admin/orders/${id}/accept`)

export const shipOrder = (id: number, data: { expressCompany: string; expressNo: string; remark?: string }) =>
  client.post<ApiResponse<{ shipment: Shipment; order: Order }>>(`/admin/orders/${id}/ship`, data)

// 退款：amount（分）可为部分或全额，服务端校验 0 < amount <= 可退余额
export const refundOrder = (id: number, data: { amount: number; reason?: string }) =>
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
export const approveAfterSale = (id: number, data: { amount: number; reply?: string }) =>
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
export const batchProductStatus = (status: 'ON_SHELF' | 'OFF_SHELF', categoryId?: number) =>
  client.post<ApiResponse<{ updated: number }>>('/admin/products/batch-status', {
    status,
    ...(categoryId ? { categoryId } : {}),
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
