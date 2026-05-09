module.exports = {
  apps: [
    {
      name: 'food-shop-server',
      script: 'dist/app.js',
      cwd: '/www/food-shop-server',
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
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
