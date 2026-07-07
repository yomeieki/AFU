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
  orderNo?: string
}) => client.get<ApiResponse<PaginatedData<Order>>>('/admin/orders', { params })

export const getOrder = (id: number) =>
  client.get<ApiResponse<Order>>(`/admin/orders/${id}`)

export const shipOrder = (id: number, data: { expressCompany: string; expressNo: string; remark?: string }) =>
  client.post<ApiResponse<{ shipment: Shipment; order: Order }>>(`/admin/orders/${id}/ship`, data)

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
