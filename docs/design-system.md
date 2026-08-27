# 设计规范（Design System）

两端（小程序 + admin 后台）共享的视觉规范，唯一事实源。落地形式：

- **miniapp**：`apps/miniapp/app.wxss` 中 `page {}` 的 CSS 变量 + 全局公共类（单位 rpx）
- **admin**：`apps/admin/tailwind.config.js` 的 `theme.extend`（`brand-*` 色阶、`shadow-card`）

风格定位：橙红食品电商风（延续 #e5441e），灰底白卡、圆角卡片、渐变主按钮。

## 品牌色阶

| Token | 值 | 用途 |
|---|---|---|
| brand-50 | `#fef4f0` | 极浅底（选中态背景、tag 底） |
| brand-100 | `#fde5dc` | 浅底 |
| brand-200 | `#fac9b8` | 描边、禁用态 |
| brand-300 | `#f6a288` | — |
| brand-400 | `#ef7150` | focus ring、hover |
| **brand-500** | **`#e5441e`** | **主色（按钮、价格、选中）** |
| brand-600 | `#c33514` | hover/active 加深 |
| brand-700 | `#a02b13` | — |
| brand-800 | `#802514` | — |
| brand-900 | `#6a2214` | — |

主渐变（banner / 主按钮）：`linear-gradient(135deg, #ff6a3d 0%, #e5441e 100%)`

## 中性色

| Token | 值 | 用途 |
|---|---|---|
| text-1 | `#1a1a1a` | 主文字、标题 |
| text-2 | `#666666` | 次要文字 |
| text-3 | `#999999` | 辅助/占位文字 |
| text-disabled | `#c8c9cc` | 禁用 |
| border | `#ebedf0` | 描边 |
| divider | `#f2f3f5` | 分隔线 |
| bg | `#f5f6f7` | 页面背景 |
| card | `#ffffff` | 卡片背景 |

## 功能色 & 订单状态色

| 状态 | 语义 | 主色 | 浅底 |
|---|---|---|---|
| PENDING_PAYMENT 待付款 | warning | `#ff9500` | `#fff7e8` |
| PAID 待发货 | info | `#3b82f6` | `#eff6ff` |
| SHIPPED 已发货 | cyan | `#0891b2` | `#ecfeff` |
| COMPLETED 已完成 | success | `#16a34a` | `#f0fdf4` |
| CANCELLED 已取消 | gray | `#9ca3af` | `#f3f4f6` |
| REFUNDED 已退款 | danger | `#ef4444` | `#fef2f2` |

通用功能色沿用同表：success `#16a34a` / warning `#ff9500` / danger `#ef4444` / info `#3b82f6`。

## 字号

- **miniapp（rpx）**：22（标签）/ 24（辅助）/ 26（次要）/ **28（正文基准）** / 30 / 32（卡片标题）/ 36（页面标题）/ 44（价格整数、大数字）
- **admin**：Tailwind 默认阶梯（text-xs ~ text-2xl），不自定义

### 价格三段式

`¥` 符号小号 + 整数部分大号 + 小数部分小号，统一 `font-weight: 700`、品牌色：

- miniapp：`.price-symbol`(24rpx) `.price-int`(40~44rpx) `.price-dec`(24rpx)
- admin：金额列 `font-semibold text-brand-600`

## 圆角

- **miniapp**：`--radius-sm` 8rpx（图片）/ `--radius-md` 12rpx（卡片）/ `--radius-lg` 16rpx（大卡）/ `--radius-xl` 24rpx（弹层顶部）/ 胶囊 999rpx（按钮）
- **admin**：沿用 `rounded-md` / `rounded-lg`，不新增

## 阴影

- miniapp 卡片：`0 2rpx 12rpx rgba(0,0,0,0.04)`
- admin：`shadow-card` = `0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04)`

## 间距

- miniapp：页面左右留白 24rpx；卡片内边距 24rpx；卡片间距 20rpx
- admin：主内容区 `p-6`；卡片 `p-4`/`p-6`

## 素材约定

- tabBar 图标：81×81 PNG（微信限制，不支持 SVG），`apps/miniapp/assets/tabbar/`，由 `scripts/gen-tabbar-icons.mjs` 生成，普通态 `#999999`、选中态 `#e5441e`
- 空态插画 / 占位图 / 行内小图标：base64 SVG data-uri 写在 wxss `background-image`，SVG 仅用 path/circle/rect（兼容性），源文件留档 `scripts/svg-src/`
- admin 图标：`lucide-react`，统一 `w-4 h-4`（表格操作）/ `w-5 h-5`（侧栏导航）
