import axios from 'axios'

const client = axios.create({
  baseURL: '/api',
  timeout: 10000,
})

client.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

client.interceptors.response.use(
  (res) => res,
  (err) => {
    // /m 是小程序 web-view 免登录入口：换码失败要在页内提示「回小程序重进」，不能跳到账号密码页
    if (err.response?.status === 401 && window.location.pathname !== '/m') {
      localStorage.removeItem('admin_token')
      localStorage.removeItem('admin_info')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default client
