# 架构设计文档

## 一、整体架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户端                                     │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │              微信小程序 (miniapp)                         │   │
│   │  WXML / WXSS / JavaScript                               │   │
│   │  wx.login → openid → JWT                               │   │
│   │  wx.request → 后端 API                                  │   │
│   │  wx.requestPayment → 微信支付                           │   │
│   └────────────────────────┬────────────────────────────────┘   │
└────────────────────────────│────────────────────────────────────┘
                             │ HTTPS RESTful API
┌────────────────────────────│────────────────────────────────────┐
│                    后台管理员端                                    │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │         后台管理系统 (admin)                              │   │
│   │   React + Vite + TypeScript + Tailwind CSS              │   │
│   │   管理员登录 / 商品 / 订单 / 用户 / 统计                  │   │
│   └────────────────────────┬────────────────────────────────┘   │
└────────────────────────────│────────────────────────────────────┘
                             │ HTTPS RESTful API
┌────────────────────────────▼────────────────────────────────────┐
│                    腾讯云服务器 (CVM)                             │
│                                                                   │
│   ┌──────────────┐    ┌──────────────────────────────────────┐  │
│   │    Nginx     │    │         后端服务 (server)             │  │
│   │              │───▶│   Node.js + Express + Prisma ORM     │  │
│   │  反向代理     │    │   JWT 认证 / RESTful API             │  │
│   │  HTTPS 终止  │    │   PM2 进程管理                       │  │
│   │  静态资源     │    └──────────────┬───────────────────────┘  │
│   └──────────────┘                   │                           │
│                                      │                           │
│   ┌──────────────────────────────────▼────────────────────────┐ │
│   │                   MySQL / PostgreSQL                       │ │
│   │   users / admins / categories / products / orders ...     │ │
│   │   定期备份到 COS                                           │ │
│   └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                             │
                    ┌────────┴────────┐
                    │                 │
          ┌─────────▼──────┐  ┌──────▼──────────┐
          │  腾讯云 COS    │  │   微信支付服务器  │
          │  商品图片       │  │   JSAPI 下单     │
          │  二维码图片     │  │   回调 notify    │
          └────────────────┘  └─────────────────┘
```

## 二、各模块职责

### 2.1 微信小程序 (apps/miniapp)

- 用户界面：首页、商品浏览、购物车、订单、地址、个人中心
- 微信登录：wx.login 获取 code → 后端换取 openid → 返回 JWT
- 数据请求：wx.request 调用后端 RESTful API，携带 JWT
- 支付：wx.requestPayment 调用微信支付（第二阶段）
- 扫码：解析 scene 参数，跳转商品详情页

### 2.2 后端服务 (apps/server)

- 认证：微信登录换 openid、JWT 签发与验证
- 业务逻辑：商品、分类、购物车、订单、地址、支付、统计
- 金额计算：所有金额在后端根据数据库价格计算，前端不可传价格
- 支付：mock payment 接口 + 微信支付 JSAPI 预留接口 + notify 回调
- 二维码：调用微信接口生成小程序码，上传到 COS，保存 URL
- 文件上传：商品图片上传到腾讯云 COS
- 管理员接口：独立的 /api/admin/* 路由，需要管理员 JWT

### 2.3 后台管理系统 (apps/admin)

- SPA：React + Vite，构建后由 Nginx 托管静态文件
- 管理员登录：账号密码 → 获取管理员 JWT
- 商品管理：CRUD + 图片上传 + 上下架 + 二维码生成/下载
- 订单管理：查看 + 状态变更 + 发货
- 用户管理：查看用户列表和订单历史
- 统计：调用 /api/admin/stats

### 2.4 数据库

- 类型：MySQL 8.0（或 PostgreSQL 14+）
- ORM：Prisma
- 部署：腾讯云 CVM 本地实例，或腾讯云 TencentDB
- 备份：定期 mysqldump / pg_dump，备份文件上传到 COS

### 2.5 腾讯云 COS

- 用途：商品图片、分类图标、商品二维码图片存储
- 访问：后端通过 COS SDK 上传，返回公开访问 URL
- 域名：COS Bucket 绑定自定义域名（HTTPS）

### 2.6 微信支付

- 方式：JSAPI 支付（需要 openid）
- 流程：后端创建预支付订单 → 前端调用 wx.requestPayment → 微信回调 notify
- 第一阶段：mock payment，跳过真实支付接口

## 三、目录结构

```
food-shop/
├── apps/
│   ├── miniapp/                 # 微信小程序
│   │   ├── pages/               # 页面
│   │   ├── components/          # 组件
│   │   ├── utils/               # 工具函数（request 封装、auth 等）
│   │   ├── store/               # 全局状态（购物车等）
│   │   ├── app.js
│   │   ├── app.json
│   │   └── app.wxss
│   │
│   ├── admin/                   # 后台管理系统
│   │   ├── src/
│   │   │   ├── pages/           # 页面（登录、商品、订单、用户、统计）
│   │   │   ├── components/      # 通用组件
│   │   │   ├── api/             # API 调用封装
│   │   │   ├── store/           # 状态管理（Zustand 或 Context）
│   │   │   └── utils/
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   └── server/                  # 后端服务
│       ├── src/
│       │   ├── routes/          # 路由（auth, products, orders, admin, ...）
│       │   ├── controllers/     # 控制器
│       │   ├── middlewares/     # 中间件（auth, error, upload）
│       │   ├── services/        # 业务逻辑
│       │   ├── utils/           # 工具（jwt, wechat, cos, payment）
│       │   └── app.ts           # Express 入口
│       ├── prisma/
│       │   ├── schema.prisma    # 数据库 schema
│       │   └── seed.ts          # 初始化数据
│       └── package.json
│
├── packages/
│   └── shared/                  # 共享类型定义（可选）
│       └── types/
│
├── docs/                        # 项目文档
├── scripts/                     # 部署、备份脚本
├── .env.example                 # 环境变量模板
├── README.md
└── package.json                 # monorepo 根配置
```

## 四、部署结构

### 4.1 腾讯云 CVM 服务器

```
/www/
├── food-shop-server/            # 后端 Node.js 服务（PM2 管理）
│   ├── dist/                    # 编译后的 JS
│   ├── prisma/
│   ├── .env                     # 生产环境变量（不入 git）
│   └── ecosystem.config.js      # PM2 配置
│
└── food-shop-admin/             # 后台管理前端静态文件
    └── dist/                    # Vite 构建产物
```

### 4.2 Nginx 配置说明

```
# 后端 API
server {
    listen 443 ssl;
    server_name api.yourdomain.com;
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
    }
}

# 后台管理系统
server {
    listen 443 ssl;
    server_name admin.yourdomain.com;
    root /www/food-shop-admin/dist;
    try_files $uri $uri/ /index.html;
}
```

### 4.3 小程序合法域名配置

在微信公众平台 → 小程序 → 开发设置 → 服务器域名中配置：

- request 合法域名：`https://api.yuegui-hotel.online`
- uploadFile 合法域名：`https://api.yuegui-hotel.online`
- downloadFile 合法域名：COS 访问域名（`.env` 的 `COS_BASE_URL`，未配置时为 `https://<bucket>.cos.<region>.myqcloud.com`）

### 4.4 环境变量（.env.example）

```env
# 数据库
DATABASE_URL="mysql://user:password@localhost:3306/food_shop"

# JWT
JWT_SECRET="your-jwt-secret"
JWT_EXPIRES_IN="7d"
ADMIN_JWT_SECRET="your-admin-jwt-secret"

# 微信小程序
WX_APP_ID="your-wx-app-id"
WX_APP_SECRET="your-wx-app-secret"

# 微信支付（第二阶段）
WX_PAY_MCH_ID=""
WX_PAY_API_KEY_V3=""
WX_PAY_SERIAL_NO=""
WX_PAY_PRIVATE_KEY_PATH=""
WX_PAY_NOTIFY_URL="https://api.yourdomain.com/api/payments/wechat/notify"

# 腾讯云 COS
COS_SECRET_ID="your-cos-secret-id"
COS_SECRET_KEY="your-cos-secret-key"
COS_BUCKET="your-bucket-name"
COS_REGION="ap-guangzhou"
COS_BASE_URL="https://your-cos-domain.com"

# 服务器
PORT=3000
NODE_ENV="production"
```

## 五、关键技术决策

| 决策点 | 选择 | 原因 |
|--------|------|------|
| 小程序框架 | 微信原生 | 无需额外学习成本，兼容性最好 |
| 后端框架 | Express | 轻量、生态成熟、适合 MVP |
| ORM | Prisma | 类型安全、schema 即文档、迁移方便 |
| 数据库 | MySQL 8.0 | 国内普及度高，腾讯云支持好 |
| 金额存储 | INT（分） | 避免浮点数精度问题 |
| 图片存储 | 腾讯云 COS | 与服务器同区域，访问速度快 |
| 进程管理 | PM2 | 支持自动重启、集群模式、日志管理 |
| 前端构建 | Vite | 构建速度快，现代化工具链 |
