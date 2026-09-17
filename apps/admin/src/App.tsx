import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/auth'
import Layout from './components/Layout'
import Login from './pages/Login'
import WebviewLogin from './pages/WebviewLogin'
import Dashboard from './pages/Dashboard'
import Categories from './pages/Categories'
import Products from './pages/Products'
import Orders from './pages/Orders'
import Users from './pages/Users'
import ScanStats from './pages/ScanStats'
import Banners from './pages/Banners'
import SystemStatus from './pages/SystemStatus'
import ShopSettings from './pages/ShopSettings'
import LocalSettings from './pages/LocalSettings'
import PickupSettings from './pages/PickupSettings'
import PromotionSettings from './pages/PromotionSettings'
import BusinessHoursSettings from './pages/BusinessHoursSettings'
import LocalOrders from './pages/LocalOrders'
import PrinterSettings from './pages/PrinterSettings'
import Coupons from './pages/Coupons'
import PointsGoods from './pages/PointsGoods'
import PromotionCenter from './pages/PromotionCenter'
import SystemCenter from './pages/SystemCenter'
import MemberSettings from './pages/MemberSettings'
import Workbench from './pages/Workbench'
import CatalogCenter from './pages/CatalogCenter'
import OrderCenter from './pages/OrderCenter'
import SettingsCenter from './pages/SettingsCenter'
import LegacyRedirect from './components/LegacyRedirect'
import { UnsavedSettingsProvider } from './components/UnsavedSettings'
import { ToastHost } from './components/ui/Toast'
import { ConfirmDialogHost } from './components/ui/ConfirmDialog'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token)
  return token ? <>{children}</> : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastHost />
      <ConfirmDialogHost />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/m" element={<WebviewLogin />} />
        {/* 工作台是店员的全屏落地页：在 RequireAuth 内、Layout 外，不吃侧栏 */}
        <Route
          path="/workbench"
          element={
            <RequireAuth>
              <Workbench />
            </RequireAuth>
          }
        />
        <Route
          path="/"
          element={
            <RequireAuth>
              <UnsavedSettingsProvider>
                <Layout />
              </UnsavedSettingsProvider>
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="catalog" element={<CatalogCenter />}>
            <Route index element={<LegacyRedirect />} />
            <Route path="products" element={<Products />} />
            <Route path="categories" element={<Categories />} />
          </Route>
          <Route path="orders" element={<OrderCenter />}>
            <Route index element={<LegacyRedirect />} />
            <Route path="local" element={<LocalOrders />} />
            <Route path="express" element={<Orders />} />
          </Route>
          <Route path="settings" element={<SettingsCenter />}>
            <Route index element={<LegacyRedirect />} />
            <Route path="express" element={<ShopSettings />} />
            <Route path="local" element={<LocalSettings />} />
            <Route path="pickup" element={<PickupSettings />} />
            <Route path="hours" element={<BusinessHoursSettings />} />
          </Route>
          <Route path="products" element={<LegacyRedirect />} />
          <Route path="categories" element={<LegacyRedirect />} />
          <Route path="local/orders" element={<LegacyRedirect />} />
          <Route path="coupons" element={<LegacyRedirect />} />
          <Route path="points-goods" element={<LegacyRedirect />} />
          <Route path="member-settings" element={<LegacyRedirect />} />
          {/* 「会员营销」整个中心已并入推广运营，它自己和三个子页都得还能落地 */}
          <Route path="membership" element={<LegacyRedirect />} />
          <Route path="membership/coupons" element={<LegacyRedirect />} />
          <Route path="membership/points-goods" element={<LegacyRedirect />} />
          <Route path="membership/settings" element={<LegacyRedirect />} />
          {/* 满减活动从 /settings/promotion 挪到 /promotion/discount */}
          <Route path="settings/promotion" element={<LegacyRedirect />} />
          <Route path="users" element={<Users />} />
          <Route path="promotion" element={<PromotionCenter />}>
            <Route index element={<LegacyRedirect />} />
            <Route path="coupons" element={<Coupons />} />
            <Route path="discount" element={<PromotionSettings />} />
            <Route path="points-goods" element={<PointsGoods />} />
            <Route path="banners" element={<Banners />} />
            <Route path="member" element={<MemberSettings />} />
            {/* 扫码统计：店主决定先收起入口（navigation.ts 的 centerTabs.promotion 里没有它），
                页面与路由都留着，直接输地址仍可访问，要恢复只需把页签加回去。 */}
            <Route path="scan-stats" element={<ScanStats />} />
          </Route>
          <Route path="banners" element={<LegacyRedirect />} />
          <Route path="scan-stats" element={<LegacyRedirect />} />
          <Route path="shop-settings" element={<LegacyRedirect />} />
          <Route path="local/settings" element={<LegacyRedirect />} />
          {/* 打印机放默认子页：店员点进「系统维护」几乎总是为了打印机，不是看系统状态。
              代价是旧书签 /system 会落到打印机页——规格 §12 里写明了这一条。 */}
          <Route path="system" element={<SystemCenter />}>
            <Route index element={<LegacyRedirect />} />
            <Route path="printer" element={<PrinterSettings />} />
            <Route path="status" element={<SystemStatus />} />
          </Route>
          <Route path="printer-settings" element={<LegacyRedirect />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
