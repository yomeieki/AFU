# food-shop 微信小程序食品商城

线下食品/熟食门店的微信小程序商城系统，支持商品浏览、在线下单、微信支付、包装二维码复购。

## 项目结构

```
food-shop/
├── apps/
│   ├── miniapp/        # 微信小程序（原生 WXML/WXSS/JS）
│   ├── admin/          # 后台管理系统（React + Vite + Tailwind）
│   └── server/         # 后端 API（Node.js + Express + Prisma）
├── packages/
│   └── shared/         # 共享类型（可选）
├── docs/               # 项目文档
├── scripts/            # 部署、备份脚本
├── .env.example        # 环境变量模板
└── README.md
```

## 文档索引

| 文档 | 说明 |
|------|------|
| [docs/requirement.md](docs/requirement.md) | 需求文档、MVP 功能范围 |
| [docs/architecture.md](docs/architecture.md) | 整体架构、部署结构 |
| [docs/database.md](docs/database.md) | 数据库表设计 |
| [docs/api.md](docs/api.md) | API 接口设计 |
| [docs/order-flow.md](docs/order-flow.md) | 订单流程、状态流转 |
| [docs/payment-design.md](docs/payment-design.md) | 支付设计（Mock + 微信支付） |
| [docs/qrcode-design.md](docs/qrcode-design.md) | 包装二维码设计 |
| [docs/design-system.md](docs/design-system.md) | 两端共享的视觉规范，样式改动的唯一事实源 |
| [docs/deployment.md](docs/deployment.md) | 生产部署指南 |
| [docs/payment-setup.md](docs/payment-setup.md) | 微信支付上线配置手册（写给运营者） |
| [docs/miniapp-release-checklist.md](docs/miniapp-release-checklist.md) | 小程序上架提审清单（写给运营者） |
| [docs/staff-guide.md](docs/staff-guide.md) | 店员日常操作手册 |

## 技术栈

- **小程序**：微信原生小程序（WXML/WXSS/JS）
- **后端**：Node.js + Express + Prisma ORM + MySQL
- **后台**：React + Vite + TypeScript + Tailwind CSS
- **存储**：腾讯云 COS
- **部署**：腾讯云 CVM + Nginx + PM2

## 本地开发启动

### 前置条件

- Node.js >= 18
- Docker Desktop（用于本地 MySQL）

### 第一步：启动本地 MySQL

```bash
# 在项目根目录执行
docker compose up -d food-shop-mysql

# 查看容器状态（Status 显示 healthy 后再继续）
docker compose ps

# 查看启动日志（可选）
docker compose logs -f food-shop-mysql
```

### 第二步：初始化数据库

```bash
cd apps/server

# 执行数据库迁移（首次运行）
npx prisma migrate dev --name init

# 导入初始数据（管理员账号 + 示例商品）
npm run db:seed
```

seed 完成后默认账号：`admin / admin123456`

### 第三步：启动后端服务

```bash
# 在 apps/server 目录下
npm run dev
# 服务运行在 http://localhost:3000
```

### 快速验证

```bash
# 健康检查
curl http://localhost:3000/health

# 获取商品分类
curl http://localhost:3000/api/categories

# 管理员登录
curl -X POST http://localhost:3000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123456"}'
```

### 后台管理和小程序

```bash
# 后台管理
cd apps/admin && npm install && npm run dev

# 小程序：使用微信开发者工具打开 apps/miniapp
```

### 停止 / 清理 Docker

```bash
# 停止容器（保留数据）
docker compose stop food-shop-mysql

# 停止并删除容器（保留数据卷）
docker compose down

# 彻底清除数据卷（慎用）
docker compose down -v
```

## 开发阶段

- [x] 阶段 0：项目文档
- [x] 阶段 1：后端基础（monorepo + Prisma + 基础 API）
- [x] 阶段 2：后台管理系统 MVP
- [x] 阶段 3：小程序商品浏览
- [x] 阶段 4：购物车、地址、订单
- [x] 阶段 5：Mock Payment
- [x] 阶段 6：商品包装二维码
- [x] 阶段 7：真实微信支付
- [ ] 阶段 8：部署上线（部署文档、脚本、迁移链已就绪，待服务器配置）
