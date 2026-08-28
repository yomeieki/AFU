const isDev = true // set to false for production

module.exports = {
  baseURL: isDev ? 'http://localhost:3100/api' : 'https://api.yuegui-hotel.online/api',
  // 手机版管理后台地址（商家入口用；dev 为本机局域网 IP，手机需与电脑同一 Wi-Fi）
  adminUrl: isDev ? 'http://192.168.151.109:5173' : 'https://admin.yuegui-hotel.online',
}
