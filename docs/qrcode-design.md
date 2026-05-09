# 商品包装二维码设计文档

## 一、设计目标

商品包装上印刷小程序码，用户用微信"扫一扫"后直接进入该商品的小程序详情页，实现线下顾客的线上复购转化。

---

## 二、技术方案选择

微信小程序码有两种生成方式：

| 方式 | 接口 | 适用场景 | 参数限制 |
|------|------|----------|----------|
| wxacode.get | getwxacode | path 可以包含完整路径参数 | path 不超过128字节 |
| wxacode.getUnlimited | getwxacodeunlimit | 支持大量 scene 参数，适合商品级别 | scene 不超过32字节 |

**第一版选择：`getwxacodeunlimit`**

理由：
- 每个商品对应一个固定 scene，SKU 数量未来可能超过 `getwxacode` 的限制。
- `getwxacodeunlimit` 支持上线前也能使用（需要设置正式版或体验版）。
- scene 参数简洁，方便后续扩展。

---

## 三、Scene 参数设计

### 3.1 第一版 Scene 格式

```
p_{productId}
```

示例：
- 商品 ID 为 1 → scene = `p_1`
- 商品 ID 为 10001 → scene = `p_10001`

### 3.2 Scene 解析规则

| 前缀 | 含义 | 示例 |
|------|------|------|
| p_ | 商品包装二维码 | p_1001 |

后续扩展（第一版不实现）：

| 前缀 | 含义 | 示例 |
|------|------|------|
| c_{channel} | 渠道二维码 | c_store1_1001 |
| b_{batch} | 批次二维码 | b_20240101_1001 |

### 3.3 小程序端 Scene 解析

小程序扫码进入时，通过 `onLoad` 的 `options.scene` 接收参数（URL decode 后处理）：

```javascript
// pages/product/detail.js
Page({
  onLoad(options) {
    let productId = null

    if (options.id) {
      // 正常商品详情页跳转
      productId = options.id
    } else if (options.scene) {
      // 扫码进入
      const scene = decodeURIComponent(options.scene)
      // 解析 p_{productId}
      const match = scene.match(/^p_(\d+)$/)
      if (match) {
        productId = match[1]
        // 记录扫码日志
        this.recordScanLog(scene, 'package')
      }
    }

    if (productId) {
      this.loadProduct(productId)
    }
  },

  async recordScanLog(scene, source) {
    try {
      await request({
        url: '/api/scan-logs',
        method: 'POST',
        data: { scene, source },
        // 不强制要求登录，失败静默处理
      })
    } catch (e) {
      console.warn('扫码日志记录失败', e)
    }
  }
})
```

---

## 四、后台生成二维码流程

### 4.1 生成步骤

```
管理员点击"生成二维码"
    │
    ▼
POST /api/admin/products/:id/qrcode
    │
    ├─ 1. 查询商品（验证存在且未删除）
    │
    ├─ 2. 生成 scene 参数
    │       scene = `p_${product.id}`
    │
    ├─ 3. 调用微信接口获取小程序码图片
    │       调用：POST https://api.weixin.qq.com/wxa/getwxacodeunlimit
    │       参数：
    │         - scene: "p_1001"
    │         - page: "pages/product/detail"   ← 商品详情页路径
    │         - width: 280                      ← 二维码尺寸（像素）
    │         - is_hyaline: true                ← 透明背景
    │       返回：图片二进制流（PNG）
    │
    ├─ 4. 上传图片到腾讯云 COS
    │       路径：qrcodes/product_{id}_{timestamp}.png
    │       返回：公开访问 URL
    │
    ├─ 5. 更新数据库
    │       products.qr_scene = "p_1001"
    │       products.qr_code_url = "https://cos.../product_1001.png"
    │       products.qr_generated_at = NOW()
    │
    └─ 6. 返回二维码 URL 给前端
          {
            "qrCodeUrl": "https://cos.../product_1001.png",
            "qrScene": "p_1001",
            "qrGeneratedAt": "2024-01-01T10:00:00Z"
          }
```

### 4.2 微信接口调用细节

```javascript
async function generateProductQrCode(productId) {
  // 1. 获取微信 access_token（有效期 2 小时，需要缓存）
  const accessToken = await getWechatAccessToken()

  // 2. 调用生成接口
  const scene = `p_${productId}`
  const response = await axios.post(
    `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${accessToken}`,
    {
      scene,
      page: 'pages/product/detail',  // 小程序商品详情页路径
      width: 280,
      is_hyaline: true,
      env_version: 'release',  // release=正式版, trial=体验版, develop=开发版
    },
    { responseType: 'arraybuffer' }  // 返回图片二进制
  )

  // 检查返回是否为图片（微信错误时返回 JSON）
  const contentType = response.headers['content-type']
  if (!contentType.includes('image')) {
    const error = JSON.parse(Buffer.from(response.data).toString())
    throw new Error(`微信生成二维码失败: ${error.errcode} ${error.errmsg}`)
  }

  // 3. 上传到 COS
  const fileName = `qrcodes/product_${productId}_${Date.now()}.png`
  const cosUrl = await uploadToCos(fileName, response.data, 'image/png')

  return { scene, cosUrl }
}
```

### 4.3 access_token 缓存

微信 access_token 有效期 7200 秒（2小时），需要缓存：

```javascript
// 简单内存缓存（生产环境建议使用 Redis）
let accessTokenCache = { token: null, expiresAt: 0 }

async function getWechatAccessToken() {
  if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt) {
    return accessTokenCache.token
  }
  const res = await axios.get(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WX_APP_ID}&secret=${WX_APP_SECRET}`
  )
  accessTokenCache = {
    token: res.data.access_token,
    expiresAt: Date.now() + (res.data.expires_in - 300) * 1000  // 提前5分钟刷新
  }
  return accessTokenCache.token
}
```

---

## 五、扫码日志设计

### 5.1 扫码日志表（scan_logs）

```sql
CREATE TABLE scan_logs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  product_id  INT NOT NULL COMMENT '商品ID',
  user_id     INT NULL COMMENT '用户ID（未登录则为空）',
  openid      VARCHAR(64) NULL COMMENT '微信openid',
  scene       VARCHAR(64) NOT NULL COMMENT '扫码scene参数',
  source      VARCHAR(32) DEFAULT 'package' COMMENT '来源',
  ip          VARCHAR(45) NULL COMMENT '请求IP（预留）',
  user_agent  VARCHAR(255) NULL COMMENT 'UA（预留）',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_product_id (product_id),
  INDEX idx_openid (openid),
  INDEX idx_created_at (created_at)
);
```

### 5.2 扫码日志 API

```
POST /api/scan-logs
（不强制要求登录，有 JWT 则记录用户信息）

Request Body:
{
  "scene": "p_1001",
  "source": "package"
}

处理逻辑：
1. 从 scene 解析 productId
2. 验证商品存在
3. 记录日志（无论是否登录）
4. 返回空 data
```

### 5.3 日志用途

第一版仅记录，不做统计展示。后续可扩展：
- 扫码次数统计（按商品、按时间）
- 扫码转化率（扫码后下单的比例）
- 扫码后下单金额
- 不同渠道效果对比

---

## 六、后台管理功能

### 6.1 商品管理页二维码功能

在后台商品列表和商品编辑页中，增加：

- **生成二维码**按钮：调用 POST /api/admin/products/:id/qrcode
- **查看二维码**：展示二维码图片（img 标签）
- **下载二维码**：下载 PNG 图片到本地，用于送印刷厂

### 6.2 下载二维码实现

```javascript
// 后台管理系统（React）
function downloadQrCode(productName, qrCodeUrl) {
  const link = document.createElement('a')
  link.href = qrCodeUrl
  link.download = `qrcode_${productName}.png`
  link.click()
}
```

注意：需要 COS Bucket 允许 `Content-Disposition: attachment` 或前端通过 canvas 转 blob 下载。

---

## 七、印刷注意事项（非技术，供参考）

1. 二维码图片建议导出 300dpi 以上分辨率（生成时 width 参数设置 430px 以上）。
2. 二维码周围留白（Quiet Zone）不少于 4 个模块宽度。
3. 印刷前需要用真实微信扫码验证跳转是否正确。
4. 建议在二维码旁边添加文字："微信扫码，再次购买"。
5. 小程序码生成时 env_version 需要设置为 `release`（正式版），确保正式上线后扫码可用。

---

## 八、后续扩展方向（第一版不实现）

| 功能 | 说明 |
|------|------|
| 渠道二维码 | 不同渠道（促销活动、合作门店）生成不同 scene，统计各渠道效果 |
| 批次二维码 | 按生产批次生成，实现精确追踪 |
| 扫码统计面板 | 后台展示扫码数、转化率、下单金额 |
| 二维码失效管理 | 商品下架时标记二维码失效，扫码后提示商品暂时下架 |
| 批量生成下载 | 一次性下载所有商品二维码（ZIP 压缩包） |
