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
import LocalOrders from './pages/LocalOrders'
import PrinterSettings from './pages/PrinterSettings'
import Coupons from './pages/Coupons'
import PointsGoods from './pages/PointsGoods'
import MemberSettings from './pages/MemberSettings'
import Workbench from './pages/Workbench'
import CatalogCenter from './pages/CatalogCenter'
import OrderCenter from './pages/OrderCenter'
import MembershipCenter from './pages/MembershipCenter'
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
            <Route index element={<Navigate to="products" replace />} />
            <Route path="products" element={<Products />} />
            <Route path="categories" element={<Categories />} />
          </Route>
          <Route path="orders" element={<OrderCenter />}>
            <Route index element={<LegacyRedirect />} />
            <Route path="local" element={<LocalOrders />} />
            <Route path="express" element={<Orders />} />
          </Route>
          <Route path="membership" element={<MembershipCenter />}>
            <Route index element={<Navigate to="coupons" replace />} />
            <Route path="coupons" element={<Coupons />} />
            <Route path="points-goods" element={<PointsGoods />} />
            <Route path="settings" element={<MemberSettings />} />
          </Route>
          <Route path="settings" element={<SettingsCenter />}>
            <Route index element={<Navigate to="express" replace />} />
            <Route path="express" element={<ShopSettings />} />
            <Route path="local" element={<LocalSettings />} />
          </Route>
          <Route path="products" element={<LegacyRedirect />} />
          <Route path="categories" element={<LegacyRedirect />} />
          <Route path="local/orders" element={<LegacyRedirect />} />
          <Route path="coupons" element={<LegacyRedirect />} />
          <Route path="points-goods" element={<LegacyRedirect />} />
          <Route path="member-settings" element={<LegacyRedirect />} />
          <Route path="users" element={<Users />} />
          <Route path="scan-stats" element={<ScanStats />} />
          <Route path="banners" element={<Banners />} />
          <Route path="shop-settings" element={<LegacyRedirect />} />
          <Route path="local/settings" element={<LegacyRedirect />} />
          <Route path="printer-settings" element={<PrinterSettings />} />
          <Route path="system" element={<SystemStatus />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
