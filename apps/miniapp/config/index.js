const isDev = true // set to false for production

module.exports = {
  baseURL: isDev ? 'http://localhost:3100/api' : 'https://api.yourdomain.com/api',
}
