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

# 安装 coscli（用于备份上传 COS）—— 生产已装于 /usr/local/bin/coscli
# curl -fsSL -o coscli https://cosbrowser.cloud.tencent.com/software/coscli/coscli-linux
# chmod +x coscli && sudo mv coscli /usr/local/bin/
# 凭证读 ~/.cos.yaml（coscli config init 生成，密钥在文件里是加密存储的）
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
├── food-shop/                  # 整个 monorepo（git clone，deploy.sh 自动拉取更新）
│   ├── apps/server/            # 后端（dist/、prisma/、.env、keys/、uploads/）
│   ├── apps/admin/             # 管理端源码（deploy.sh 构建后 rsync 到下方）
│   └── scripts/                # deploy.sh / backup.sh / nginx.conf
│
├── food-shop-admin/dist/       # 管理端静态产物（nginx root，deploy.sh 自动发布）
└── backups/                    # pre-deploy/（迁移前备份）+ daily/（每日备份）
```

---

## 四、生产环境变量（.env）

在服务器上手动创建 `/www/food-shop/apps/server/.env`，**不要提交到 git**：

```env
# 数据库
DATABASE_URL="mysql://foodshop_user:strong-password-here@localhost:3306/food_shop"

# JWT（使用强随机密钥，建议 64 字符以上）
JWT_SECRET="your-64-char-random-user-jwt-secret"
JWT_EXPIRES_IN="7d"
ADMIN_JWT_SECRET="your-64-char-random-admin-jwt-secret"
ADMIN_JWT_EXPIRES_IN="30d"

# 微信小程序
WECHAT_APP_ID="wx开头的AppID"
WECHAT_APP_SECRET="小程序AppSecret"
WECHAT_LOGIN_MOCK=false

# 微信支付
WECHAT_PAY_MOCK=false
WECHAT_MCH_ID="商户号"
WECHAT_PAY_SERIAL_NO="商户证书序列号"
WECHAT_PAY_PRIVATE_KEY_PATH="/www/food-shop/apps/server/keys/apiclient_key.pem"
WECHAT_PAY_API_V3_KEY="32字节APIv3密钥"
WECHAT_PAY_NOTIFY_URL="https://api.yourdomain.com/api/wechat/pay/notify"
# 退款回调留空自动派生为 .../refund-notify
WECHAT_PAY_REFUND_NOTIFY_URL=""
# 回调验签材料二选一（商户平台 → API 安全 查看模式）：
WECHAT_PAY_PUBLIC_KEY_PATH="/www/food-shop/apps/server/keys/pub_key.pem"
WECHAT_PAY_PUBLIC_KEY_ID="PUB_KEY_ID_xxx"
# WECHAT_PAY_PLATFORM_CERT_PATH="/www/food-shop/apps/server/keys/wechatpay_cert.pem"
WECHAT_PAY_CERT_AUTO_DOWNLOAD="true"

# 腾讯云 COS —— 生产必填，未配置服务拒绝启动（图片全部走 COS）
# 桶已创建：afu-images-1342627167（上海 ap-shanghai，公有读私有写，单 AZ，默认告警已开）
# 密钥请用 CAM 子用户（编程访问），策略仅授权该桶，勿用主账号密钥
COS_SECRET_ID="子账号 SecretId"
COS_SECRET_KEY="子账号 SecretKey"
COS_BUCKET="afu-images-1342627167"
COS_REGION="ap-shanghai"
COS_BASE_URL=""   # 留空即用 https://afu-images-1342627167.cos.ap-shanghai.myqcloud.com

# 服务器
PORT=3000
NODE_ENV="production"

# Mock 开关（生产全部关闭，config.ts 启动校验会强制拦截 true）
WECHAT_QRCODE_MOCK=false

# 新订单微信推送（可选，推荐企微群机器人）
ORDER_NOTIFY_WECOM_WEBHOOK=""
ORDER_NOTIFY_PUSHPLUS_TOKEN=""
ORDER_NOTIFY_PUSHPLUS_TOPIC=""

# 系统告警（500 / 进程崩溃 / 支付金额不符 / 退款失败），留空回退到上面的订单群
SYSTEM_ALERT_WECOM_WEBHOOK=""
```

> **首次配置 COS 后的存量图片迁移**（只需做一次）：
> ```bash
> cd /www/food-shop/apps/server
> npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/migrate-uploads-to-cos.ts --dry-run \
>     --old-prefix https://api.yuegui-hotel.online/uploads/
> # 看输出无误后去掉 --dry-run 实跑，并保留报告
> npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/migrate-uploads-to-cos.ts \
>     --old-prefix https://api.yuegui-hotel.online/uploads/ --report /www/backups/migrate-cos-report.json
> ```
> 脚本先上传再改库、可重复执行；跑完后 nginx 的 `/uploads/` 与 `express.static` 保留一个部署周期做兜底，之后可删。

### 安全修改生产 .env

生产 `.env` 不要手动 vim —— 漏引号、键名写错、写出重复键（dotenv 只认最后一条，症状极难排查）都很常见。用配套脚本：

```bash
# 写入密钥类（输入不回显，不进 shell 历史、不出现在 ps 里）
bash /www/food-shop/scripts/set-env.sh WECHAT_PAY_API_V3_KEY
bash /www/food-shop/scripts/set-env.sh COS_SECRET_ID
bash /www/food-shop/scripts/set-env.sh COS_SECRET_KEY

# 非敏感值可回显方便核对
bash /www/food-shop/scripts/set-env.sh WECHAT_PAY_PUBLIC_KEY_ID --show

# 体检：只列键与是否已填，并检查重复键
bash /www/food-shop/scripts/set-env.sh --list
```

每次写入自动备份为 `.env.bak-<时间戳>`；改完需 `pm2 restart food-shop-server` 才生效。

### 微信支付私钥存放

```bash
mkdir -p /www/food-shop/apps/server/keys
chmod 700 /www/food-shop/apps/server/keys
# 将商户私钥上传到服务器（apiclient_key.pem）
# 将验签材料上传：微信支付公钥 pub_key.pem（新商户）或 平台证书 wechatpay_cert.pem（老商户）
chmod 600 /www/food-shop/apps/server/keys/*.pem
```

---

## 五、首次部署

```bash
# 1. 克隆代码
git clone <repo-url> /www/food-shop

# 2. 创建生产 .env（见上一节）与支付证书目录
nano /www/food-shop/apps/server/.env

# 3. 一键部署（含依赖安装、迁移前备份、编译、迁移、seed、admin 发布、PM2、健康检查）
bash /www/food-shop/scripts/deploy.sh --seed
# 默认管理员账号：admin / admin123456，上线前务必修改密码

# 4. 设置开机自启
pm2 startup   # 按提示执行输出的命令
pm2 save
```

---

## 六、后续更新部署

```bash
bash /www/food-shop/scripts/deploy.sh
```

deploy.sh 会自动完成：**预检（生产环境缺 COS 配置会在动服务之前就中止）** → git 拉取 → 安装依赖 → **迁移前备份数据库** → prisma generate → 编译 → 迁移（失败给出恢复命令）→ admin 构建发布 → PM2 热重载 → **pm2-logrotate 安装/配置（幂等）** → Nginx reload → 健康检查（含 DB 探活），并在结尾打印代码回滚与数据库恢复命令。

> ⚠️ 首次部署本版本前，务必先在 `apps/server/.env` 填好 `COS_SECRET_ID/KEY/BUCKET/REGION`，否则预检会直接拒绝部署（这是有意的：新版图片上传只走 COS，配置缺失时启动即失败）。

---

## 七、Nginx 配置

```bash
# 复制配置模板
cp /www/food-shop/scripts/nginx.conf /etc/nginx/conf.d/food-shop.conf

# 编辑：替换 yourdomain.com 和证书路径
nano /etc/nginx/conf.d/food-shop.conf

# 验证并重载
nginx -t && nginx -s reload
```

模板要点：
- `location /api/wechat/pay/` 单独反代且不限流、不缓冲 body——同时覆盖支付回调 `/notify` 与退款回调 `/refund-notify`（**升级到自动退款后必须是这个前缀**，老配置只写了 `/notify`）
- `location /uploads/` 存量本地图片过渡期直出；COS 迁移完成一个部署周期后可删

---

## 八、数据库备份

**已在生产配置完成（2026-09-02）**，无需重复操作，以下为说明与排障参考。

数据库密码与告警 webhook 由脚本自动从 `apps/server/.env` 读取（`DATABASE_URL` / `SYSTEM_ALERT_WECOM_WEBHOOK` → 回退 `ORDER_NOTIFY_WECOM_WEBHOOK`），**crontab 里不出现任何密钥**：

```bash
# 手动执行一次
COS_BUCKET=yuegui-booking-backup-1342627167 COS_REGION=ap-shanghai COS_BACKUP_PATH=food-shop \
  /www/food-shop/scripts/backup.sh

# 已装的 cron（每日 02:00，与酒店项目的 03:00 / 23:00 任务错开）
0 2 * * * COS_BUCKET=yuegui-booking-backup-1342627167 COS_REGION=ap-shanghai COS_BACKUP_PATH=food-shop /www/food-shop/scripts/backup.sh >> /var/log/food-shop-backup.log 2>&1
```

关于备份目的地与 coscli：

- **coscli 已安装**在 `/usr/local/bin/coscli`（v0.20.0，腾讯云官方 linux 版）。注意该版本 **`cp` 没有 `--region` 参数**，脚本改用 `-e cos.<region>.myqcloud.com`。
- 备份写入**私有**桶 `yuegui-booking-backup-1342627167` 的 `food-shop/` 前缀（与酒店项目的 `production/` `sandbox/` 隔离）。**切勿指向图片桶 `afu-images-*`，那是公有读的。**
- 服务器 `~/.cos.yaml` 里的子账号密钥**有写入权限但无删除权限**——这是有意的安全设计（备份不可被脚本或攻击者删除）。因此 **COS 端的过期清理必须用控制台「生命周期规则」**，脚本删不了。
- 本地保留 7 天（`LOCAL_KEEP_DAYS`），目录 `/www/backups/daily`。

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

完整的提审材料、平台侧设置（类目/隐私保护指引/域名）、审核备注模板与常见打回对策见 **[miniapp-release-checklist.md](miniapp-release-checklist.md)**。

---

## 十一、本地开发 vs 生产对照

| 配置项 | 本地开发 | 生产 |
|--------|----------|------|
| `WECHAT_LOGIN_MOCK` | `true` | `false` |
| `WECHAT_PAY_MOCK` | `true` | `false` |
| `WECHAT_QRCODE_MOCK` | `true` | `false` |
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

# 日志轮转状态（deploy.sh 已自动装 pm2-logrotate：20M × 14 份，每日 0 点）
pm2 conf pm2-logrotate
```

---

## 十三、监控与告警

采用「外部拨测 + 服务内告警 + 日志轮转 + 备份摘要」的轻量组合，零新服务、零费用。

### 13.1 外部拨测（UptimeRobot，免费版 50 个监控 / 5 分钟）

1. 注册 [uptimerobot.com](https://uptimerobot.com)
2. **Add New Monitor** 三个：

| 类型 | URL | Keyword（Alert when keyword **not exists**） | 说明 |
|---|---|---|---|
| HTTP(s) – Keyword | `https://api.yuegui-hotel.online/health` | `"status":"ok"` | 后端进程 + MySQL 探活（DB 挂了返回 503 `degraded`） |
| HTTP(s) – Keyword | `https://admin.yuegui-hotel.online/` | `阿福` | 后台静态站 + HTTPS 证书 |
| HTTP(s) | `https://api.yuegui-hotel.online/api/categories` | — | 业务接口可用 |

3. **Alert Contacts**：邮件（免费）+ Webhook 推企微群：
   - Type = Webhook，URL 填企微机器人地址，POST Value (JSON)：
     `{"msgtype":"text","text":{"content":"【UptimeRobot】*monitorFriendlyName* *alertTypeFriendlyName*\n*monitorURL*\n*alertDetails*"}}`
   - 勾 "Send as JSON"
4. **演练**：服务器执行 `pm2 stop food-shop-server`，10 分钟内应收到 Down 告警；`pm2 start food-shop-server` 后收到 Up。

### 13.2 服务内告警（推企微群，`SYSTEM_ALERT_WECOM_WEBHOOK`）

| 触发 | 位置 | 限频 |
|---|---|---|
| 接口未捕获异常（HTTP 500） | `middlewares/error.ts` | 同路由 5 分钟一次 |
| `unhandledRejection`（只告警不退出） | `app.ts` | 5 分钟一次 |
| `uncaughtException`（告警后 1.5s 退出，PM2 自动重启） | `app.ts` | 5 分钟一次 |
| 生产启动打点（短时间频繁收到 = 重启风暴） | `app.ts` | 1 分钟一次 |
| 支付回调金额与订单不符 | `routes/wechat-notify.ts` | 每订单一次 |
| 退款发起失败 / 退款异常 / 退款关闭 / 退款回调金额不符 | `services/refund.ts` | 每退款单一次 |

被限频抑制的次数会附在下一条同类告警里。未配置任何 webhook 时退化为 `console.error`（pm2 日志可查）。

### 13.2b 通知通道自检

配完 `ORDER_NOTIFY_*` / `SYSTEM_ALERT_WECOM_WEBHOOK` 后，用自检脚本验证**真的能推到店员手机上**：

```bash
node /www/food-shop/apps/server/scripts/check-notify.mjs
```

会往订单群和告警群各发一条标注「测试」的消息。**不能只看 HTTP 200** —— 企微机器人 key 无效时照样返回 200，真正的结果在响应体 `errcode`（93000 = key 无效），脚本已经按 errcode 判定。

三个人工确认项（脚本验不了）：店员手机确实收到、群没设免打扰、`pm2 restart food-shop-server` 已执行让服务读到新值。

### 13.3 对象存储（COS）

账号 APPID `1342627167`，三个桶均在上海 `ap-shanghai`，已按 `app` / `env` / `usage` 三个标签分类便于分账：

| 桶 | 访问 | app | env | usage | 说明 |
|---|---|---|---|---|---|
| `afu-images-1342627167` | 公有读私有写 | afu-liangcai | prod | images | 本项目商品/Banner 图片，单 AZ，默认流量告警已开 |
| `yuegui-booking-backup-1342627167` | 私有 | yuegui-hotel | prod | backup | 酒店预订备份（另有原标签「预定信息=1」）|
| `yuegui-room-service-sandbox-1342627167` | 公有读 | yuegui-hotel | sandbox | sandbox | 客房配送沙箱（另有原标签「客房配送=2」）|

图片桶的成本护栏：控制台「默认告警」已开（1 分钟外网下行 >5000MB 触发）。如需进一步防盗刷，可在桶的「安全管理 → 防盗链」配 Referer 白名单——**注意小程序请求不带 Referer，必须勾选「允许空 Referer」，否则图片全裂**。

### 13.4 日志与磁盘

- `deploy.sh` 每次部署自动确保 `pm2-logrotate`：单文件 20M、保留 14 份、gzip、每日 0 点轮转
- nginx 日志由系统 logrotate 管理（Ubuntu 默认每日）
- 备份脚本每日凌晨 2 点跑，成功/失败都会推企微（见第八节 `ALERT_WEBHOOK`）
- 磁盘水位：轻量服务器建议每月 `df -h` 看一眼；备份目录只保留 7 天

### 13.5 上线后看什么

| 频率 | 看哪里 |
|---|---|
| 每天 | 企微「新订单」群有单就说明链路活着；告警群安静 |
| 每周 | UptimeRobot 可用率 ≥ 99.5%；`pm2 logs --err --lines 200` 无重复报错 |
| 每月 | 备份文件能从 COS 拉下来并解压；`df -h`；商户平台对账 |
