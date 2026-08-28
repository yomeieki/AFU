export interface ApiResponse<T = unknown> {
  code: number
  message: string
  data: T
}

export interface PaginatedData<T> {
  list: T[]
  total: number
  page: number
  pageSize: number
}

export interface Category {
  id: number
  name: string
  iconUrl: string | null
  sortOrder: number
  status: number
  createdAt: string
  _count?: { products: number }
}

export interface SpecDimension {
  name: string
  values: string[]
}

export interface ProductSku {
  id?: number
  specText: string
  specValues: string[]
  price: number
  originalPrice: number | null
  stock: number
  sortOrder: number
}

export interface Product {
  id: number
  categoryId: number
  name: string
  subtitle: string | null
  coverImage: string | null
  price: number
  originalPrice: number | null
  stock: number
  unit: string
  weight: string | null
  shelfLife: string | null
  storageMethod: string | null
  deliveryInfo: string | null
  description: string | null
  status: 'ON_SHELF' | 'OFF_SHELF'
  deliveryType: string
  isRecommended: number
  salesCount: number
  qrScene: string | null
  qrCodeUrl: string | null
  qrGeneratedAt: string | null
  deletedAt: string | null
  createdAt: string
  category?: { id: number; name: string }
  images?: { imageUrl: string }[]
  specDimensions?: SpecDimension[] | null
  skus?: ProductSku[]
}

export interface QrCodeResult {
  qrCodeUrl: string | null
  qrScene: string | null
  qrGeneratedAt: string | null
}

export interface OrderItem {
  productName: string
  productImage: string | null
  specText?: string | null
  quantity: number
  productPrice: number
  subtotal: number
}

export type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'PREPARING' | 'SHIPPED' | 'COMPLETED' | 'CANCELLED' | 'REFUNDING' | 'REFUNDED'

export interface Shipment {
  id: number
  orderId: number
  expressCompany: string | null
  expressNo: string | null
  shippedAt: string | null
  remark: string | null
}

export interface Order {
  id: number
  orderNo: string
  status: OrderStatus
  totalAmount: number
  shippingFee: number
  actualAmount: number
  deliveryType: string
  receiverName: string
  receiverPhone: string
  receiverFullAddress: string
  remark?: string | null
  paidAt: string | null
  createdAt: string
  items: OrderItem[]
  shipment?: Shipment | null
}

export interface AdminUser {
  id: number
  openid: string
  nickname: string | null
  avatarUrl: string | null
  phone: string | null
  status: number
  lastLoginAt: string | null
  createdAt: string
  orderCount: number
}

export interface UserOrder {
  id: number
  orderNo: string
  status: OrderStatus
  actualAmount: number
  createdAt: string
  items: { productName: string; quantity: number }[]
}

export interface Stats {
  today: {
    orderCount: number
    salesAmount: number
  }
  total: {
    orderCount: number
    productCount: number
    categoryCount: number
  }
  hotProducts: {
    id: number
    name: string
    coverImage: string | null
    salesCount: number
    price: number
  }[]
}

// 扫码统计
export interface ScanSummary {
  totalScans: number
  uniqueOpenids: number
  todayScans: number
  conversion: { scans: number; orders: number; rate: number | null }
}

export interface ScanTrendPoint {
  date: string
  scans: number
  uniqueOpenids: number
}

export interface ScanProductRow {
  productId: number
  productName: string
  scans: number
  orders: number
  conversionRate: number | null
}

export interface SalesTrendPoint {
  date: string
  orderCount: number
  salesAmount: number
}

// Banner
export interface Banner {
  id: number
  title: string | null
  imageUrl: string
  linkType: 'none' | 'product'
  productId: number | null
  sortOrder: number
  status: number
  createdAt: string
  updatedAt: string
}
