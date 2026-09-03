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
        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="categories" element={<Categories />} />
          <Route path="products" element={<Products />} />
          <Route path="orders" element={<Orders />} />
          <Route path="users" element={<Users />} />
          <Route path="scan-stats" element={<ScanStats />} />
          <Route path="banners" element={<Banners />} />
          <Route path="shop-settings" element={<ShopSettings />} />
          <Route path="system" element={<SystemStatus />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
