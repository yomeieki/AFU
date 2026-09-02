# 微信支付上线配置手册

> 写给店铺运营者/非开发人员。跟着做即可让小程序从「模拟支付」切换到「真实微信支付」。
> 完成后打开 **管理后台 → 系统状态**,「微信支付」组全部变绿即为配置成功。

## 一、前置条件

| 条件 | 说明 |
|---|---|
| 营业执照 | 微信支付商户号申请必需 |
| 已认证的小程序 | AppID 见微信公众平台 → 设置 → 账号信息 |
| 服务器已部署 + HTTPS 域名 | 支付回调必须是公网 HTTPS 地址,本地电脑收不到 |

## 二、申请微信支付商户号

1. 打开 [pay.weixin.qq.com](https://pay.weixin.qq.com) → 接入微信支付 → 选「小程序」场景
2. 按引导提交营业执照、法人身份证、结算银行卡,等待审核(一般 1-3 个工作日)
3. 审核通过后登录商户平台,记下 **商户号(mch_id)**
4. 商户平台 → 产品中心 → AppID 账号管理 → **关联你的小程序 AppID**

## 三、获取密钥与证书(商户平台 → 账户中心 → API 安全)

| 要拿到的东西 | 操作 | 对应 .env 变量 |
|---|---|---|
| APIv3 密钥 | 「设置 APIv3 密钥」自己设一串 32 位字符,**设完自己存好,平台不再显示** | `WECHAT_PAY_API_V3_KEY` |
| 商户 API 证书 | 「申请 API 证书」按引导用证书工具生成,下载得到 `apiclient_key.pem` 等文件 | 把 `apiclient_key.pem` 上传到服务器,路径填入 `WECHAT_PAY_PRIVATE_KEY_PATH` |
| 证书序列号 | 证书列表页可直接复制 | `WECHAT_PAY_SERIAL_NO` |
| **回调验签材料(二选一,看 API 安全页显示哪种)** | | |
| ↳ 微信支付公钥(2024 年起新商户默认) | 「微信支付公钥」→ 下载 `pub_key.pem`,同页复制「公钥 ID」(PUB_KEY_ID_ 开头) | `WECHAT_PAY_PUBLIC_KEY_PATH` + `WECHAT_PAY_PUBLIC_KEY_ID` |
| ↳ 平台证书(老商户) | 用官方 CertificateDownloader 工具下载(需要上面的私钥和 APIv3 密钥) | `WECHAT_PAY_PLATFORM_CERT_PATH`(证书轮换时服务会自动拉取新证书) |

> 两种都没配时,生产环境会**拒绝所有支付/退款回调**(支付成功但订单一直待付款)。系统状态页「回调验签」组会告诉你当前识别到哪种。

## 四、逐项填写 .env(服务器上 apps/server/.env)

```bash
# 小程序
WECHAT_APP_ID="wx开头的小程序AppID"
WECHAT_APP_SECRET="小程序密钥(公众平台→开发→开发设置)"

# 微信支付
WECHAT_MCH_ID="商户号"
WECHAT_PAY_API_V3_KEY="32位APIv3密钥"
WECHAT_PAY_SERIAL_NO="商户证书序列号"
WECHAT_PAY_PRIVATE_KEY_PATH="/www/food-shop/apps/server/keys/apiclient_key.pem"
WECHAT_PAY_NOTIFY_URL="https://api.yuegui-hotel.online/api/wechat/pay/notify"
# 退款回调可不填,自动派生为 .../api/wechat/pay/refund-notify

# 验签材料二选一(见第三节)
WECHAT_PAY_PUBLIC_KEY_PATH="/www/food-shop/apps/server/keys/pub_key.pem"
WECHAT_PAY_PUBLIC_KEY_ID="PUB_KEY_ID_xxxxxxxxxx"
# WECHAT_PAY_PLATFORM_CERT_PATH="/www/food-shop/apps/server/keys/platform_cert.pem"

# 关闭全部 Mock(生产环境若为 true 服务会拒绝启动)
WECHAT_LOGIN_MOCK=false
WECHAT_PAY_MOCK=false
WECHAT_QRCODE_MOCK=false
```

改完执行重启(部署脚本或 `pm2 restart` / `systemctl restart`)。

## 五、验证

1. **系统状态页**:管理后台 → 系统状态 →「微信支付」与「回调验签」两组全绿、顶部横幅显示"支付配置就绪"
2. **一分钱实测(支付)**:把某个商品价格临时改为 ¥0.01 → 用真机小程序下单支付 → 确认:
   - 手机弹出真实微信支付并扣款成功
   - 后台订单几秒内变为「待接单」(说明支付回调 + 验签打通)
   - 企微群/PushPlus 收到新订单推送(若已配置)
3. **一分钱实测(退款)**:后台该订单点「退款」→ 第一步填原因 → 第二步**手动输入 0.01** → 确认:
   - 后台提示「已发起退款」或「已退款」
   - 几秒内订单变为「已退款」(退款回调打通);企微收到「退款已到账」
   - 顾客微信收到退款到账通知,小程序订单详情显示「已退款」
4. 测完把商品价格改回来

## 六、常见报错对照

| 现象 | 原因 | 处理 |
|---|---|---|
| 系统状态页「商户私钥文件」灰 | 路径写错或文件没传到服务器 | 核对 `WECHAT_PAY_PRIVATE_KEY_PATH` 与文件实际位置 |
| 下单报「服务配置错误」 | 某个支付变量缺失 | 看系统状态页哪项灰,补上重启 |
| 支付成功但订单一直「待付款」 | 回调没打通:域名/HTTPS/路径错,或平台证书未配 | 核对 `WECHAT_PAY_NOTIFY_URL` 可公网访问;查服务日志 `[wechat-notify]` |
| 日志出现 AMOUNT MISMATCH | 回调金额与订单不符(异常情况) | 人工核对该笔订单,勿手动改状态 |
| 商户平台报「AppID 未关联」 | 商户号没绑定小程序 | 商户平台 → AppID 账号管理里关联 |
| 日志 `[wechat-notify] 验签失败: 未配置微信支付公钥` | 商户是公钥模式但只配了平台证书(或反之) | 按第三节下载对应材料填对变量 |
| 日志 `验签失败: 未找到对应序列号的平台证书` | 平台证书已轮换且自动拉取失败 | 检查商户私钥/APIv3 密钥是否正确;或重新下载证书 |
| 后台退款报 `NOT_ENOUGH` | 商户号可用余额不足(T+1 结算后资金已划走) | 商户平台 → 交易中心 → 充值到「运营账户」后重试 |
| 后台退款报 `FREQUENCY_LIMITED` | 同一订单短时间重复退款请求 | 稍后点「重试退款」 |
| 后台退款报 `ORDER_NOT_EXIST` / `PARAM_ERROR` | 订单是模拟支付或 out_trade_no 缺失 | 该单只能「手动标记完成」 |
| 退款一直「微信处理中」 | 退款回调没到(nginx 未放行 `/api/wechat/pay/` 或验签失败) | 查日志 `[wechat-refund-notify]`;确认商户平台退款已成功后可「手动标记完成」 |
| 企微收到「退款异常」 | 用户微信账户异常/银行卡注销等,微信无法原路退回 | 商户平台 → 交易中心 → 退款管理 手动处理 |

## 七、后续升级(可选)

- **一键自动退款(已实现 ✅ 2026-09)**:
  - 后台「退款」直接调用微信退款 API(v3 /refund/domestic/refunds),全额原路退回,不再需要去商户平台手动操作
  - **双重确认防手滑**:第一次弹窗展示订单号/金额/收货人并填退款原因 → 第二次红色危险弹窗**要求手动输入退款金额**,输入与订单实付一致才允许点击「确认退款」;服务端再校验一次金额
  - 退款结果由微信退款回调自动写状态(退款中 → 已退款),失败/异常自动告警到企微群;保留「手动标记完成」兜底回调丢失的情况
  - 同一订单同时只能有一笔进行中的退款(数据库唯一约束),双击/两人同时操作不会退两次


- **小程序内直达后台**:域名备案+HTTPS 完成后,在小程序管理后台配置「业务域名」,即可把「商家管理」入口从复制链接升级为 web-view 内嵌打开(代码已预留,联系开发调整)
- 手机将后台「添加到主屏幕」即可像 App 一样使用(iOS Safari 分享菜单 / 安卓浏览器菜单)
