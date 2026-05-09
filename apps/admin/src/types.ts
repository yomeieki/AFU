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
  deletedAt: string | null
  createdAt: string
  category?: { id: number; name: string }
}

export interface OrderItem {
  productName: string
  productImage: string | null
  quantity: number
  productPrice: number
  subtotal: number
}

export type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'SHIPPED' | 'COMPLETED' | 'CANCELLED' | 'REFUNDED'

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
  paidAt: string | null
  createdAt: string
  items: OrderItem[]
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
