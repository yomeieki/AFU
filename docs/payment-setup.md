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
| 平台证书 | 用官方 CertificateDownloader 工具下载(需要上面的私钥和 APIv3 密钥) | 路径填入 `WECHAT_PAY_PLATFORM_CERT_PATH`(生产必须,否则回调一律拒绝) |

## 四、逐项填写 .env(服务器上 apps/server/.env)

```bash
# 小程序
WECHAT_APP_ID="wx开头的小程序AppID"
WECHAT_APP_SECRET="小程序密钥(公众平台→开发→开发设置)"

# 微信支付
WECHAT_MCH_ID="商户号"
WECHAT_PAY_API_V3_KEY="32位APIv3密钥"
WECHAT_PAY_SERIAL_NO="商户证书序列号"
WECHAT_PAY_PRIVATE_KEY_PATH="/srv/food-shop/certs/apiclient_key.pem"
WECHAT_PAY_PLATFORM_CERT_PATH="/srv/food-shop/certs/platform_cert.pem"
WECHAT_PAY_NOTIFY_URL="https://api.你的域名.com/api/wechat/pay/notify"

# 关闭全部 Mock(生产环境若为 true 服务会拒绝启动)
WECHAT_LOGIN_MOCK=false
WECHAT_PAY_MOCK=false
WECHAT_QRCODE_MOCK=false
```

改完执行重启(部署脚本或 `pm2 restart` / `systemctl restart`)。

## 五、验证

1. **系统状态页**:管理后台 → 系统状态 →「微信支付」7 项全绿、顶部横幅显示"支付配置就绪"
2. **一分钱实测**:把某个商品价格临时改为 ¥0.01 → 用真机小程序下单支付 → 确认:
   - 手机弹出真实微信支付并扣款成功
   - 后台订单几秒内变为「待接单」(说明回调打通)
   - 企微群/PushPlus 收到新订单推送(若已配置)
3. 测完把商品价格改回来,给测试订单做退款(商户平台可手动退)

## 六、常见报错对照

| 现象 | 原因 | 处理 |
|---|---|---|
| 系统状态页「商户私钥文件」灰 | 路径写错或文件没传到服务器 | 核对 `WECHAT_PAY_PRIVATE_KEY_PATH` 与文件实际位置 |
| 下单报「服务配置错误」 | 某个支付变量缺失 | 看系统状态页哪项灰,补上重启 |
| 支付成功但订单一直「待付款」 | 回调没打通:域名/HTTPS/路径错,或平台证书未配 | 核对 `WECHAT_PAY_NOTIFY_URL` 可公网访问;查服务日志 `[wechat-notify]` |
| 日志出现 AMOUNT MISMATCH | 回调金额与订单不符(异常情况) | 人工核对该笔订单,勿手动改状态 |
| 商户平台报「AppID 未关联」 | 商户号没绑定小程序 | 商户平台 → AppID 账号管理里关联 |

## 七、后续升级(可选)

- **小程序内直达后台**:域名备案+HTTPS 完成后,在小程序管理后台配置「业务域名」,即可把「商家管理」入口从复制链接升级为 web-view 内嵌打开(代码已预留,联系开发调整)
- 手机将后台「添加到主屏幕」即可像 App 一样使用(iOS Safari 分享菜单 / 安卓浏览器菜单)
