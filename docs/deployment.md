# 部署文档

## 一、前提条件

在开始部署前，确认以下资源已就绪：

| 资源 | 说明 |
|------|------|
| 腾讯云 CVM | Ubuntu 22.04 LTS，1核2GB 起 |
| 域名 + ICP 备案 | `api.yourdomain.com`、`admin.yourdomain.com` |
| SSL 证书 | 腾讯云免费 DV 证书或 Let's Encrypt（certbot） |
| 小程序 AppID/AppSecret | 微信公众平台 → 开发管理 → 开发设置 |
| 微信支付商户号 | 微信支付商户平台，API v3 密钥 + 商户私钥 |
| 腾讯云 COS Bucket | 同区域，配置公读私写，绑定自定义域名 |

---

## 二、服务器环境初始化（首次）

```bash
# 更新系统
apt update && apt upgrade -y

# 安装 Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 安装 MySQL 8.0
apt install -y mysql-server
mysql_secure_installation  # 按提示设置 root 密码

# 安装 Nginx
apt install -y nginx
systemctl enable nginx

# 安装 PM2
npm install -g pm2

# 安装 coscli（用于备份上传 COS）
# https://cloud.tencent.com/document/product/436/63143
wget -O /usr/local/bin/coscli https://github.com/tencentyun/coscli/releases/latest/download/coscli-linux
chmod +x /usr/local/bin/coscli
coscli config init  # 填入 COS 密钥
```

### 创建数据库用户

```sql
-- 以 root 登录 MySQL
CREATE DATABASE food_shop CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'foodshop_user'@'localhost' IDENTIFIED BY 'strong-password-here';
GRANT ALL PRIVILEGES ON food_shop.* TO 'foodshop_user'@'localhost';
FLUSH PRIVILEGES;
```

---

## 三、部署目录结构

```
/www/
├── food-shop-server/       # 后端（git clone 或 scp 上传）
│   ├── dist/               # tsc 编译产物（npm run build 后）
│   ├── prisma/
│   ├── .env                # 生产环境变量（手动创建，不入 git）
│   ├── ecosystem.config.js
│   └── package.json
│
└── food-shop-admin/
    └── dist/               # Vite 构建产物（本地 build 后上传）
```

---

## 四、生产环境变量（.env）

在服务器上手动创建 `/www/food-shop-server/.env`，**不要提交到 git**：

```env
# 数据库
DATABASE_URL="mysql://foodshop_user:strong-password-here@localhost:3306/food_shop"

# JWT（使用强随机密钥，建议 64 字符以上）
JWT_SECRET="your-64-char-random-user-jwt-secret"
JWT_EXPIRES_IN="7d"
ADMIN_JWT_SECRET="your-64-char-random-admin-jwt-secret"
ADMIN_JWT_EXPIRES_IN="24h"

# 微信小程序
WECHAT_APP_ID="wx开头的AppID"
WECHAT_APP_SECRET="小程序AppSecret"
WECHAT_LOGIN_MOCK=false

# 微信支付
WECHAT_PAY_MOCK=false
WECHAT_MCH_ID="商户号"
WECHAT_PAY_SERIAL_NO="商户证书序列号"
WECHAT_PAY_PRIVATE_KEY_PATH="/www/food-shop-server/keys/apiclient_key.pem"
WECHAT_PAY_API_V3_KEY="32字节APIv3密钥"
WECHAT_PAY_NOTIFY_URL="https://api.yourdomain.com/api/wechat/pay/notify"
WECHAT_PAY_PLATFORM_CERT_PATH="/www/food-shop-server/keys/wechatpay_cert.pem"

# 腾讯云 COS
COS_SECRET_ID="your-cos-secret-id"
COS_SECRET_KEY="your-cos-secret-key"
COS_BUCKET="your-bucket-ap-region"
COS_REGION="ap-guangzhou"
COS_BASE_URL="https://your-cos-domain.com"

# 服务器
PORT=3000
NODE_ENV="production"

# Mock 开关（生产全部关闭）
MOCK_PAYMENT_ENABLED=false
WECHAT_QRCODE_MOCK=false
```

### 微信支付私钥存放

```bash
mkdir -p /www/food-shop-server/keys
chmod 700 /www/food-shop-server/keys
# 将商户私钥上传到服务器（apiclient_key.pem）
# 将微信支付平台证书上传（wechatpay_cert.pem）
chmod 600 /www/food-shop-server/keys/*.pem
```

---

## 五、首次部署

```bash
# 1. 克隆代码
git clone <repo-url> /www/food-shop-server
cd /www/food-shop-server/apps/server

# 2. 安装依赖
npm install --omit=dev

# 3. 编译
npm run build

# 4. 数据库迁移（首次：部署所有迁移）
npm run db:migrate:deploy

# 5. 导入初始数据（只在首次执行）
npm run db:seed
# 默认管理员账号：admin / admin123456，上线前务必修改密码

# 6. 启动后端服务
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup  # 按提示执行输出的命令，设置开机自启

# 7. 部署后台前端
# 在本地机器执行：
cd apps/admin && npm run build
scp -r dist/ user@your-server:/www/food-shop-admin/dist/
```

---

## 六、后续更新部署

```bash
cd /www/food-shop-server
git pull origin main
bash scripts/deploy.sh
```

deploy.sh 会自动完成：安装依赖 → 编译 → 数据库迁移 → PM2 热重载 → Nginx reload → 健康检查。

---

## 七、Nginx 配置

```bash
# 复制配置模板
cp /www/food-shop-server/scripts/nginx.conf /etc/nginx/conf.d/food-shop.conf

# 编辑：替换 yourdomain.com 和证书路径
nano /etc/nginx/conf.d/food-shop.conf

# 验证并重载
nginx -t && nginx -s reload
```

---

## 八、数据库备份

```bash
# 设置环境变量后手动执行
export DB_PASS="strong-password-here"
export COS_BUCKET="your-bucket"
export COS_REGION="ap-guangzhou"
bash /www/food-shop-server/scripts/backup.sh

# 设置每日凌晨 2 点自动备份
crontab -e
# 加入：
0 2 * * * DB_PASS=xxx COS_BUCKET=xxx COS_REGION=ap-guangzhou bash /www/food-shop-server/scripts/backup.sh >> /var/log/food-shop-backup.log 2>&1
```

---

## 九、回滚方案

### 代码回滚

```bash
# 查看提交历史
git log --oneline -10

# 回滚到指定 commit
git checkout <commit-hash>
bash scripts/deploy.sh  # 重新编译 + 重启
```

### 数据库回滚

Prisma 不支持自动回滚迁移。操作方式：

1. **从备份恢复**（破坏性，需停服）：
   ```bash
   pm2 stop food-shop-server
   mysql -u root -p food_shop < /backup/food_shop_YYYYMMDD_HHMMSS.sql
   pm2 start food-shop-server
   ```

2. **手动撤销迁移列**（非破坏性，适合新增列回滚）：
   ```sql
   ALTER TABLE payments DROP COLUMN out_trade_no;
   DELETE FROM _prisma_migrations WHERE migration_name = '20260509160000_add_payment_out_trade_no';
   ```
   然后将代码回滚到不依赖该列的版本。

---

## 十、小程序发布

```
微信开发者工具 → 上传代码 → 微信公众平台 → 版本管理 → 提审 → 发布
```

发布前检查：
- [ ] `apps/miniapp/utils/request.js` 中 `BASE_URL` 指向 `https://api.yourdomain.com`
- [ ] 微信公众平台 → 开发设置 → 服务器域名已配置 `api.yourdomain.com`
- [ ] 小程序 AppID 和后端 `WECHAT_APP_ID` 一致
- [ ] `WECHAT_LOGIN_MOCK=false` 且 AppSecret 正确

---

## 十一、本地开发 vs 生产对照

| 配置项 | 本地开发 | 生产 |
|--------|----------|------|
| `WECHAT_LOGIN_MOCK` | `true` | `false` |
| `WECHAT_PAY_MOCK` | `true` | `false` |
| `WECHAT_QRCODE_MOCK` | `true` | `false` |
| `MOCK_PAYMENT_ENABLED` | `true` | `false` |
| `NODE_ENV` | `development` | `production` |
| 微信支付回调 | 无法收到（localhost 非公网） | 必须公网 HTTPS |
| 数据库迁移 | `prisma migrate dev` | `prisma migrate deploy` |

---

## 十二、常用运维命令

```bash
# 查看服务状态
pm2 status

# 查看实时日志
pm2 logs food-shop-server

# 查看错误日志
pm2 logs food-shop-server --err

# 重启服务
pm2 restart food-shop-server

# 查看 Nginx 访问日志
tail -f /var/log/nginx/access.log

# 查看 Nginx 错误日志
tail -f /var/log/nginx/error.log
```
