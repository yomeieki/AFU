module.exports = {
  apps: [
    {
      name: 'food-shop-server',
      script: 'dist/app.js',
      cwd: '/www/food-shop/apps/server',
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        // 进程内 config.ts 已经无条件把 TZ 钉成 Asia/Shanghai（见 utils/timezone.ts），这里是
        // 第二道保险：换服务器/系统默认时区变化时，PM2 注入的这个值先兜一层。
        TZ: 'Asia/Shanghai',
      },
      error_file: '/var/log/pm2/food-shop-server-error.log',
      out_file: '/var/log/pm2/food-shop-server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '512M',
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
    },
  ],
}
