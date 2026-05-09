import client from './client'
import type { ApiResponse, PaginatedData, Category, Product, Order, Stats, QrCodeResult } from '../types'

// Auth
export const login = (username: string, password: string) =>
  client.post<ApiResponse<{ token: string; admin: { id: number; username: string; role: string } }>>(
    '/admin/login',
    { username, password }
  )

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

export const createProduct = (data: Partial<Product>) =>
  client.post<ApiResponse<Product>>('/admin/products', data)

export const updateProduct = (id: number, data: Partial<Product>) =>
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
