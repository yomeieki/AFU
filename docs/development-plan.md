# 开发计划文档

## 一、总体时间规划

| 阶段 | 内容 | 预计工时 |
|------|------|----------|
| 阶段 0 | 项目文档和架构设计 | 已完成 |
| 阶段 1 | 初始化 monorepo 和后端基础 | 2-3 天 |
| 阶段 2 | 后台管理系统 MVP | 5-7 天 |
| 阶段 3 | 小程序商品浏览 | 3-4 天 |
| 阶段 4 | 购物车、地址、订单 | 4-5 天 |
| 阶段 5 | Mock Payment | 1-2 天 |
| 阶段 6 | 商品包装二维码 | 2-3 天 |
| 阶段 7 | 真实微信支付 | 3-4 天 |
| 阶段 8 | 部署上线 | 2-3 天 |

---

## 二、阶段 0：项目文档和架构设计（已完成）

### 交付物

- [x] docs/requirement.md
- [x] docs/architecture.md
- [x] docs/database.md
- [x] docs/api.md
- [x] docs/order-flow.md
- [x] docs/payment-design.md
- [x] docs/qrcode-design.md
- [x] docs/development-plan.md

---

## 三、阶段 1：初始化 monorepo 和后端基础

### 目标

搭建可运行的项目骨架，建立数据库连接，实现最基础的 API。

### 任务列表

#### 1.1 Monorepo 初始化
- [ ] 创建根目录 `food-shop/`
- [ ] 初始化根 `package.json`（使用 npm workspaces 或 pnpm workspaces）
- [ ] 创建 `apps/server/`、`apps/admin/`、`apps/miniapp/` 目录
- [ ] 创建 `packages/shared/` 目录（可选）
- [ ] 创建 `.env.example` 文件
- [ ] 创建 `.gitignore`（包含 .env、node_modules、dist）
- [ ] 初始化 git 仓库

#### 1.2 后端基础（apps/server）
- [ ] 初始化 Node.js + TypeScript 项目
- [ ] 安装依赖：express、prisma、@prisma/client、jsonwebtoken、bcryptjs、multer、dotenv
- [ ] 配置 TypeScript（tsconfig.json）
- [ ] 创建 Express app 入口（src/app.ts）
- [ ] 配置 CORS 中间件
- [ ] 配置错误处理中间件
- [ ] 配置统一响应格式

#### 1.3 Prisma 和数据库
- [ ] 安装并初始化 Prisma（`npx prisma init`）
- [ ] 编写完整的 `schema.prisma`（所有表）
- [ ] 执行 `prisma migrate dev` 创建数据库表
- [ ] 编写 `prisma/seed.ts`（初始化测试数据）：
  - 1 个管理员账号（admin / admin123）
  - 3-5 个商品分类（熟食、礼盒、预包装食品等）
  - 5-10 个示例商品
- [ ] 执行 `prisma db seed` 导入测试数据

#### 1.4 基础 API
- [ ] POST /api/admin/login（管理员登录）
- [ ] GET /api/categories（分类列表）
- [ ] GET /api/products（商品列表）
- [ ] GET /api/products/:id（商品详情）

#### 1.5 JWT 认证中间件
- [ ] `verifyUserToken` 中间件
- [ ] `verifyAdminToken` 中间件

### 完成标准

- 后端服务可以本地启动（`npm run dev`，端口 3000）
- 数据库表全部创建成功
- Seed 数据可以正常导入
- Postman 可以调通以上 4 个 API
- 管理员登录返回 JWT

---

## 四、阶段 2：后台管理系统 MVP

### 目标

实现一个可以用的后台，能完成商品管理和订单管理的核心功能。

### 任务列表

#### 2.1 后台前端初始化（apps/admin）
- [ ] 使用 Vite 创建 React + TypeScript 项目
- [ ] 安装依赖：tailwindcss、axios、react-router-dom、zustand（状态管理）
- [ ] 配置路由（React Router v6）
- [ ] 实现 axios 封装（统一错误处理、JWT 注入）
- [ ] 实现登录页和路由守卫

#### 2.2 后端补充（商品/分类 CRUD）
- [ ] GET/POST/PUT/DELETE /api/admin/categories
- [ ] GET/POST/PUT/DELETE /api/admin/products
- [ ] POST /api/admin/upload（图片上传到 COS 或本地临时目录）

#### 2.3 后台管理页面
- [ ] 登录页
- [ ] 侧边栏导航（分类管理、商品管理、订单管理、用户管理、统计）
- [ ] 商品分类管理页（表格 + 新增/编辑弹窗）
- [ ] 商品列表页（搜索、筛选、分页、上下架切换）
- [ ] 商品新增/编辑页（表单 + 图片上传 + 富文本描述）
- [ ] 订单列表页（状态筛选、搜索）
- [ ] 订单详情页（查看 + 发货操作）
- [ ] 用户列表页（查看）
- [ ] 统计首页（今日数据、热销商品）

#### 2.4 后端补充（订单/用户/统计）
- [ ] GET/GET/:id/PUT/:id/status/POST/:id/ship /api/admin/orders
- [ ] GET /api/admin/users
- [ ] GET /api/admin/stats

### 完成标准

- 管理员可以登录后台
- 可以完整地新增、编辑、删除商品分类
- 可以完整地新增、编辑、上下架商品，上传商品图片
- 可以查看订单列表，对订单执行发货操作（填写快递信息）
- 统计首页数据正确显示

---

## 五、阶段 3：小程序商品浏览

### 目标

用户可以浏览商品，实现小程序的核心展示功能。

### 任务列表

#### 3.1 小程序初始化（apps/miniapp）
- [ ] 微信开发者工具新建小程序项目（原生）
- [ ] 配置 `app.json`（页面路由、tabBar、网络请求域名）
- [ ] 封装 `wx.request`（统一 baseURL、错误处理、JWT 注入）
- [ ] 实现全局状态管理（购物车数量等）

#### 3.2 小程序页面（商品浏览）
- [ ] 首页（pages/index）
  - Banner 轮播图
  - 商品分类入口（图标 + 名称）
  - 推荐商品列表
- [ ] 商品列表页（pages/product/list）
  - 分类横向筛选条
  - 商品网格/列表布局
  - 下拉加载更多（分页）
- [ ] 商品详情页（pages/product/detail）
  - 商品图片轮播
  - 价格、名称、库存
  - 保质期、储存方式、配送说明
  - 商品详情（富文本渲染）
  - 底部固定操作栏（加入购物车 / 立即购买）
  - 解析 scene 参数（扫码进入）

### 完成标准

- 首页正常展示 Banner、分类、推荐商品
- 点击分类可以跳转到对应分类的商品列表
- 商品详情页所有信息正常展示
- 扫码进入商品详情页时正确加载对应商品

---

## 六、阶段 4：购物车、地址、订单

### 目标

实现完整的购买链路（购物车 → 地址 → 创建订单）。

### 任务列表

#### 4.1 后端 API
- [ ] GET/POST/PUT/DELETE /api/cart
- [ ] GET/POST/PUT/DELETE /api/addresses
- [ ] POST /api/orders（创建订单，含库存校验和金额计算）
- [ ] GET /api/orders（订单列表，支持状态筛选）
- [ ] GET /api/orders/:id（订单详情）
- [ ] PUT /api/orders/:id/confirm（确认收货）

#### 4.2 小程序页面
- [ ] 购物车页（pages/cart）
  - 商品列表（图片、名称、价格、数量）
  - 勾选/全选
  - 数量 +/-
  - 删除
  - 底部合计 + 结算按钮
- [ ] 地址列表页（pages/address/list）
  - 地址列表
  - 新增/编辑/删除/设为默认
- [ ] 地址编辑页（pages/address/edit）
  - 省市区选择器（使用微信内置选择器）
  - 详细地址输入
- [ ] 确认订单页（pages/order/confirm）
  - 收货地址展示/切换
  - 商品列表
  - 配送方式选择
  - 订单备注输入
  - 金额合计
  - 提交订单按钮
- [ ] 订单列表页（pages/order/list）
  - Tab 切换（全部/待付款/待发货/已发货/已完成/已取消）
  - 订单卡片（商品图、订单号、金额、状态、操作按钮）
- [ ] 订单详情页（pages/order/detail）
  - 订单状态
  - 商品信息
  - 收货地址
  - 物流信息（发货后展示）
  - 确认收货按钮（已发货状态）

### 完成标准

- 用户可以将商品加入购物车
- 用户可以管理收货地址
- 从购物车到确认订单页面数据正确展示
- 提交订单后生成订单记录，库存正确扣减
- 我的订单列表按状态正确分类展示
- 订单详情信息完整

---

## 七、阶段 5：Mock Payment

### 目标

打通完整的下单→支付→后台发货闭环，验证业务流程。

### 任务列表

#### 5.1 后端
- [ ] POST /api/payments/mock/success（Mock 支付接口）
- [ ] 环境变量控制开关（MOCK_PAYMENT_ENABLED）

#### 5.2 小程序
- [ ] 确认订单页提交后跳转到支付页（pages/pay）
- [ ] 支付页展示订单金额、订单号
- [ ] "模拟支付成功"按钮
- [ ] 调用 mock 支付接口 → 轮询订单状态 → 跳转支付成功页
- [ ] 支付成功页（pages/order/success）

### 完成标准

- 完整走通：浏览商品 → 加入购物车 → 创建订单 → Mock 支付 → 订单变为 PAID
- 后台能看到待发货订单
- 后台执行发货后订单变为 SHIPPED
- 小程序端订单状态实时更新

---

## 八、阶段 6：商品包装二维码

### 目标

支持商品包装印刷二维码，用户扫码可直接进入商品详情页。

### 任务列表

#### 6.1 后端
- [ ] POST /api/admin/products/:id/qrcode（生成小程序码）
- [ ] 集成微信生成小程序码接口（getwxacodeunlimit）
- [ ] 集成腾讯云 COS 上传
- [ ] access_token 缓存机制
- [ ] POST /api/scan-logs（记录扫码日志）

#### 6.2 后台管理
- [ ] 商品管理页增加"生成二维码"和"查看/下载二维码"功能

#### 6.3 小程序
- [ ] 商品详情页 onLoad 解析 scene 参数
- [ ] 扫码后调用 /api/scan-logs 记录日志

### 完成标准

- 后台可以为每个商品生成小程序码
- 二维码图片上传到 COS，URL 保存到数据库
- 后台可以查看和下载二维码
- 微信扫码后正确跳转到对应商品详情页
- 扫码日志正确记录

---

## 九、阶段 7：真实微信支付

### 前提条件（需要先准备）

- [ ] 微信支付商户号申请完成
- [ ] 商户 APIv3 密钥配置
- [ ] 商户私钥和证书下载
- [ ] 微信支付回调域名配置（需要正式 HTTPS 域名）

### 任务列表

#### 7.1 后端
- [ ] 集成微信支付 SDK（推荐使用 `wechatpay-node-v3`）
- [ ] POST /api/auth/wechat-login（获取 openid，完善登录流程）
- [ ] POST /api/payments/wechat/prepay（JSAPI 预下单）
- [ ] POST /api/payments/wechat/notify（支付回调 + 验签 + 幂等）
- [ ] 签名验证工具函数

#### 7.2 小程序
- [ ] 完善微信登录流程（保存 openid）
- [ ] 支付页调用 prepay 接口
- [ ] wx.requestPayment 调用
- [ ] 支付后轮询订单状态

### 完成标准

- 用户可以用真实微信支付完成下单
- 支付回调正确更新订单状态
- 重复回调幂等处理正确
- 金额核对不一致时拒绝处理并记录日志

---

## 十、阶段 8：部署上线

### 前提条件

- [ ] 腾讯云 CVM 服务器准备就绪
- [ ] 域名备案完成（ICP 备案）
- [ ] SSL 证书申请（HTTPS）
- [ ] 小程序审核通过
- [ ] 微信小程序合法域名配置

### 任务列表

#### 8.1 服务器环境配置
- [ ] 安装 Node.js（v18+）、npm/pnpm
- [ ] 安装 MySQL 8.0 / PostgreSQL 14
- [ ] 安装 Nginx
- [ ] 安装 PM2（`npm install -g pm2`）
- [ ] 配置防火墙（开放 80/443 端口）

#### 8.2 后端部署
- [ ] 上传代码到服务器（git clone 或 SCP）
- [ ] 配置生产环境 `.env` 文件
- [ ] 执行 `prisma migrate deploy`
- [ ] 执行 `prisma db seed`（初始化管理员账号）
- [ ] 编写 PM2 配置文件（ecosystem.config.js）
- [ ] 使用 PM2 启动服务（`pm2 start ecosystem.config.js`）
- [ ] 配置 PM2 开机自启（`pm2 startup`）

#### 8.3 前端部署
- [ ] 本地构建后台管理系统（`npm run build`）
- [ ] 上传 dist 到服务器
- [ ] 配置 Nginx 托管静态文件

#### 8.4 Nginx 配置
- [ ] 后端 API 反向代理（api.yourdomain.com）
- [ ] 后台管理系统静态托管（admin.yourdomain.com）
- [ ] SSL/HTTPS 配置
- [ ] Gzip 压缩
- [ ] 安全头（X-Frame-Options、X-Content-Type-Options）

#### 8.5 小程序上传
- [ ] 配置合法域名（微信公众平台）
- [ ] 上传代码到微信平台
- [ ] 提交审核
- [ ] 审核通过后发布

#### 8.6 数据库备份
- [ ] 编写自动备份脚本（mysqldump + 上传到 COS）
- [ ] 配置 crontab 定时执行（每日凌晨）

### 完成标准

- 后端 API HTTPS 可访问
- 后台管理系统 HTTPS 可访问
- 小程序正式版可正常使用
- 数据库自动备份运行正常
- PM2 监控服务运行状态正常

---

## 十一、建议开发顺序与注意事项

### 11.1 并行开发建议

阶段 2（后台管理）和阶段 3（小程序浏览）的后端 API 可以先做，前端部分可以并行开发。

### 11.2 关键卡点提前准备

| 卡点 | 需要提前准备 | 建议时机 |
|------|------------|----------|
| 微信小程序 AppID | 在微信公众平台注册小程序 | 阶段 1 开始前 |
| 腾讯云 COS | 开通 Bucket，获取密钥 | 阶段 2 前 |
| 域名备案 | 完成 ICP 备案 | 阶段 8 前（至少提前 20 天申请）|
| SSL 证书 | 申请 HTTPS 证书 | 阶段 8 前 |
| 微信支付商户号 | 申请微信支付 | 阶段 7 前（审核可能需要数周）|

### 11.3 开发环境 vs 生产环境

| 配置项 | 开发环境 | 生产环境 |
|--------|----------|----------|
| API 域名 | localhost:3000 | https://api.yourdomain.com |
| MOCK_PAYMENT_ENABLED | true | false（接入真实支付后） |
| 小程序 env_version | develop | release |
| 数据库 | 本地 MySQL | 腾讯云 MySQL |
| COS | 可用本地临时存储 | 腾讯云 COS |

### 11.4 代码质量要求

- 所有 Secret 通过 `.env` 管理，`.env` 不入 git
- 金额计算全部在后端，使用整数（分）
- 关键操作（创建订单、支付回调）使用数据库事务
- 错误统一通过 AppError 类抛出，统一错误处理中间件捕获
- 接口响应格式统一（code、message、data）
