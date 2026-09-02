# 小程序上架前完整准备 — 实施计划

## Context

「丹桂阿福凉菜」微信小程序商城已生产部署(api/admin.yuegui-hotel.online,PM2+nginx+MySQL),外部 gate 全部通过:小程序 ICP 备案 ✅、食品经营许可证 ✅、服务类目 ✅、微信支付商户号已开通(API 密钥/证书待用户在商户平台配置)。

代码侧距离提审还差:品牌名仍是「食品商城」、无隐私政策/用户协议/客服/分享入口、支付回调只支持「平台证书」验签(2024 起新商户默认「微信支付公钥」,现状会导致回调全部验签失败)、退款是纯人工登记、图片存本地盘、零监控告警。

本轮目标:**除首页水墨封面落地外,把上架前所有事项一次做完并验证**。用户已拍板的决策:

| 决策 | 结论 |
|---|---|
| 小程序名称/导航标题 | 「阿福凉菜」(admin 后台 3 处同步) |
| 客服 | 只做拨打电话 `wx.makePhoneCall`,不做微信客服 |
| 协议文案 | 我起草,主体信息(公司名/地址/电话/执照号)留【待填】 |
| 隐私合规 | 轻量声明式(协议页+入口+下单声明行),**不开 `__usePrivacyCheck__`**(项目不调用任何微信隐私接口) |
| 支付验签 | 平台证书 + 微信支付公钥双模式,按 `Wechatpay-Serial` 头自动判别 |
| 一键自动退款 | 按 docs/payment-setup.md §七定稿:微信退款 API 全额直退 + 双重确认(第二次须手输金额与实付一致)+ 回调自动写状态 + 失败告警;保留人工「标记完成」兜底 |
| COS | 腾讯云,已有桶(备份在用);**存量图片全部搬 COS 并改写 DB URL** |
| 监控 | 轻量组合:UptimeRobot 拨测 /health(加 DB 探活)+ 服务内告警推企微 + pm2-logrotate + 备份告警;不自建服务 |

边界:商户平台配置(APIv3 密钥、API 证书下载、公钥下载)涉及凭证,**由用户本人在浏览器操作**,我提供逐步指引并在配好后跑验证。

---

## 实施顺序与 commit 切分

```
W4a notify 公共层 + /health + 进程钩子        ← 无依赖,最先
  └→ W2a 验签双模式 + 回调公共解析 + config 纳管
       └→ W2b Refund 表 + 退款 API + 退款端点 + 退款回调 + mock
            └→ W2c admin RefundDialog + SystemStatus
W3 COS(服务/上传/迁移脚本/Banner 列宽)          ← 独立,可穿插
W1 品牌名/协议页/关于页/客服/分享/报错/预览台      ← 独立
W4b pm2-logrotate + backup 告警 + 监控文档
W5 文档(提审清单 + 更新 4 份现有文档 + .env.example)
W6 验证脚本 + 逐层验证
```

Commit(按序 10 个):`feat(server): notify 公共层+health 探活+进程告警` → `feat(pay): 回调验签双模式` → `feat(pay): 一键自动退款` → `feat(admin): 退款双重确认+系统状态` → `feat(upload): 迁 COS+迁移脚本` → `chore(brand): 阿福凉菜` → `feat(miniapp): 关于/协议/客服/分享/报错` → `ops: logrotate+备份告警` → `docs: 提审清单+文档更新` → `test: e2e.sh+验签自测`。另:计划定稿后复制一份到 `docs/superpowers/specs/2026-09-02-miniapp-launch-prep-design.md` 随 W5 提交。

---

## W1 小程序上架整改

**品牌名**(7 处):`apps/miniapp/app.json:50`、`pages/index/index.json:2`、`apps/miniapp/project.config.json:30`、`apps/admin/index.html:13`(+ apple-mobile-web-app-title)、`apps/admin/public/manifest.webmanifest:2-3`、`apps/admin/src/components/Layout.tsx:66`、`apps/admin/src/pages/Login.tsx:47`。

**新建 `apps/miniapp/config/shop.js`**(集中店铺信息,CommonJS 同 config/index.js 风格):`name/slogan/companyName/phone/address/businessHours/licenseNo/foodLicenseNo/contactEmail/legalUpdatedAt`,待填项写 `【待填】`。**新建 `config/legal.js`**:`{ agreement, privacy }`,每份 `{ title, updatedAt, sections:[{heading, paragraphs[]}] }`,文案引用 shop.js 字段。

**新页面**(四件套,遵循 `.page` 根/`var(--xxx)`/ES5 约定,**手动加进 app.json pages**):
- `pages/legal/index?type=agreement|privacy`:onLoad 按 type 取 legal.js 文档 + `wx.setNavigationBarTitle`;`.legal-p{font-size:26rpx;line-height:1.7;color:var(--text-2)}`。
- `pages/about/index`:店名/slogan 卡 → 联系我们(电话 tap→makePhoneCall;地址 tap→setClipboardData;营业时间)→ 资质信息(公司名/统一社会信用代码/食品经营许可证编号)→ 协议与政策两个 menu-item → 版本号。`.menu-*` 样式从 `pages/user/index.wxss:82-160` 复制(不在 app.wxss)。

隐私政策必须覆盖(对应代码真实行为):微信 openid(wx.login)、昵称头像(如授权)、收货人姓名/手机/地址(手填,用于配送)、订单与微信支付交易号/退款记录、购物车、扫码来源记录(scan_logs)、设备与日志(IP/时间)、第三方共享(微信支付、腾讯云服务器/COS、快递)、境内存储与保存期限(订单≥3 年)、用户权利(地址自删/注销拨客服电话)、未成年人、更新方式、联系方式。

**入口与交互**:
- `pages/user/index.wxml:52-56` 菜单加「联系商家」(icon-phone → makePhoneCall)、「关于我们」(icon-info → navigateTo about);index.js 加两个方法。
- `pages/order/detail.wxml:126-136` action-bar 对 PAID/PREPARING/SHIPPED/REFUNDING 加「联系商家」按钮(呼应后端 42204「请电话联系商家」)。
- `pages/order/confirm.wxml:88-98` bottom-bar 改 column:上方 `.agree-row`「提交订单即表示同意《用户协议》《隐私政策》」(可点跳 legal),下方 `.bottom-main` 包原总价+按钮;`confirm.wxss:158` `.spacer` 140→190rpx。
- 新图标:`scripts/svg-src/icon-phone.svg`、`icon-info.svg`(viewBox 24,stroke #e5441e,只用 path/circle)→ `node scripts/svg-to-datauri.mjs icon-phone.svg icon-info.svg` → 粘进 `app.wxss:184-208`。

**分享**:`pages/index/index.js` 加 `onShareAppMessage(){return {title:'阿福凉菜 · 每日现做新鲜凉菜', path:'/pages/index/index'}}`;`pages/product/detail.js` 返回 `{title: p.name, path:'/pages/product/detail?id='+p.id+'&source=share', imageUrl: p.coverImage}`(source 已透传 recordScanLog,扫码统计自动区分)。其他页不加。

**`utils/request.js` 报错映射**:`body.code===50001` →「系统开小差了,请稍后再试」;statusCode 429/502/503/504 →「服务繁忙,请稍后再试」;fail 分支 errMsg 含 timeout →「网络超时,请检查网络」;其余保留后端 message;auth 自动重登逻辑不动。

**预览台同步**(`tools/miniapp-preview`):`serve.mjs` PAGE_WXSS 加 about/legal;新建 `pages/about.html`、`pages/legal.html`(照 user.html 模板);更新镜像 `user.html`/`order-confirm.html`/`order-detail.html`;`index.html` PAGES 加两项;README 页数 10→12。

---

## W2 支付验签双模式 + 一键自动退款

### W2a 验签双模式(新建 `apps/server/src/services/wechat-pay-verify.ts`,重构 `routes/wechat-notify.ts`)

新 env:`WECHAT_PAY_PUBLIC_KEY_PATH`、`WECHAT_PAY_PUBLIC_KEY_ID`(PUB_KEY_ID_…,可选校验)、`WECHAT_PAY_CERT_AUTO_DOWNLOAD`(默认 true)、`WECHAT_PAY_REFUND_NOTIFY_URL`(空则由 NOTIFY_URL 把 `/notify` 替换为 `/refund-notify` 派生)。

```ts
export async function verifyWechatNotify(headers, rawBody): Promise<{ok:true}|{ok:false; reason:string}>
export function getVerifyStatus(): { publicKeySet; platformCertSet; mode:'public-key'|'platform-cert'|'both'|'none' }
```
- 取 `wechatpay-timestamp/nonce/signature/serial` 四头,缺失→fail;时间戳偏差 >5 分钟→fail(防重放)。
- serial 以 `PUB_KEY_ID_` 开头 → 读公钥 PEM(模块级缓存);若配了 PUBLIC_KEY_ID 且不等 → fail。
- 否则平台证书:内存 `Map<serial, pem>`;未命中→读 PLATFORM_CERT_PATH 用 `crypto.X509Certificate(pem).serialNumber`(统一大写)登记;仍未命中且 AUTO_DOWNLOAD≠false → `GET /v3/certificates`(用现有 `generateWxPayAuthorization('GET', url, '')` 签名),每条 `encrypt_certificate` 用现有 `decryptNotifyResource` 解出 PEM 入 Map,12h 过期,并发下载单例 Promise 去重。
- 复用现有 `verifyNotifySignature`(对 X509 与 PUBLIC KEY PEM 都可用)。
- 开发环境跳过验签规则收紧:仅当 `!isProduction && 公钥与证书都未配` 才跳过并 warn。
- `wechat-pay.ts` 的 `readPrivateKey` 改模块级缓存。

`wechat-notify.ts` 抽公共 `parseNotify<T>(req,res,expectedEvents[])`(验签→JSON→事件过滤→解密→JSON),`wechatPayNotifyHandler` 改用它,新增 `wechatRefundNotifyHandler`。`AmountMismatchError/replyOk/replyFail` 复用。

挂载:`app.ts:28` 下加 `app.post('/api/wechat/pay/refund-notify', express.text({type:'*/*'}), wechatRefundNotifyHandler)`(必须在 express.json 之前)。**nginx** `scripts/nginx.conf:57` `location /api/wechat/pay/notify` → `location /api/wechat/pay/`(前缀覆盖两条回调,保留 `proxy_request_buffering off`)。

`config.ts` envSchema 纳管(全部 optional,不改变 `validatePayConfig` 懒校验):`WECHAT_APP_ID/SECRET, WECHAT_MCH_ID, WECHAT_PAY_*(含新 4 个), ORDER_NOTIFY_*, SYSTEM_ALERT_WECOM_WEBHOOK, COS_*`;导出 `config.wechatPay / config.notify / config.cos`。生产且非 mock 但公钥与证书都未配 → 仅 warn 不阻断(商户配置可能晚于部署)。

### W2b Refund 表 + 退款 API + 端点 + 回调

**`prisma/schema.prisma` 新增 `model Refund`**(迁移 `20260902100000_add_refund`,沿用手写时间戳命名):
```
id, orderId(FK→orders), orderNo VarChar(32), outTradeNo? VarChar(64),
outRefundNo VarChar(64) @unique      // refund_<orderId>_<ts>,微信侧幂等键
wxRefundId? VarChar(64) @unique
amount Int, totalAmount Int          // 分;本轮只做全额
status VarChar(16)                   // PENDING/PROCESSING/SUCCESS/ABNORMAL/CLOSED/FAILED
mode VarChar(16)                     // MOCK/WECHAT
reason? VarChar(80)                  // 微信 reason 上限 80
operator? VarChar(64)
activeOrderId Int? @unique           // 并发防线:活跃态=orderId,终态 FAILED/CLOSED 置 NULL(MySQL 唯一索引允许多 NULL)
channel?, errorCode?, errorMessage? VarChar(255), wxResponseData? Text, wxNotifyData? Text,
successTime?, createdAt, updatedAt
@@index([orderId]) @@index([status]) @@map("refunds")
```
`Order` 加 `refunds Refund[]`。

**`services/wechat-pay.ts` 新增**:
```ts
export interface RefundParams { outTradeNo; outRefundNo; amount; total; reason?; notifyUrl }
export interface RefundResult { refund_id; out_refund_no; status:'SUCCESS'|'CLOSED'|'PROCESSING'|'ABNORMAL'; channel?; success_time?; amount:{refund;total} }
export async function createRefund(p): Promise<RefundResult>   // POST /v3/refund/domestic/refunds,照 createJsapiOrder:63-83 fetch 形态
export function getRefundNotifyUrl(): string
export class WechatRefundError extends Error { code; httpStatus }
```
请求体:`{ out_trade_no, out_refund_no, reason, notify_url, amount:{refund,total,currency:'CNY'} }`。

**`routes/admin/orders.ts` POST `/:id/refund` 改造**,zod `{ amount: int positive, reason?: max 80 }`:
1. 加载 order(items, payment, refunds);404。
2. **`amount !== order.actualAmount` → AppError 42206「退款金额与订单实付不一致」**(服务端二次校验)。
3. 允许状态 PAID/PREPARING/SHIPPED(登记+执行),或 REFUNDING(用户自助取消/上次失败重试)且 refunds 无活跃记录,否则 42205「已有退款处理中」。
4. payment 须存在且 SUCCESS;非 mock 下 `paymentType==='MOCK'` 或缺 outTradeNo → 42207。
5. 事务 A(纯 DB):非 REFUNDING 时 `order.updateMany({where:{id, status:{in:[PAID,PREPARING,SHIPPED]}}, data:{status:'REFUNDING', cancelledAt, cancelReason}})` count===0 → 42204「订单状态已变化,请刷新」;原状态≠SHIPPED 则 `rollbackOrderStock`(REFUNDING 分支不再回滚,用户取消路径已回滚);`refund.create({outRefundNo, amount, totalAmount, status:'PENDING', mode, activeOrderId:id, operator})`,捕获 P2002 → 42205。
6. mock 分支(`config.mock.pay`):事务 B 直接 refund→SUCCESS、order→REFUNDED(refundedAt)、payment.status→REFUNDED;返回 `{order, refund, mode:'mock'}`。
7. 真实分支:`validatePayConfig()` → `createRefund()`;成功 → `refund.update({wxRefundId, status, channel, wxResponseData})`,若 status==='SUCCESS' 立即走 `finalizeRefundSuccess()`(与回调共用);失败 → `refund.update({status:'FAILED', activeOrderId:null, errorCode, errorMessage})` + `notifySystemAlert('微信退款发起失败',…)`,订单留 REFUNDING,抛 AppError 50201(502)。

POST `/:id/refund-complete`(人工兜底)保留,改 `updateMany where {id,status:'REFUNDING'}` 判 count;活跃 Refund 标 SUCCESS(operator 'manual'),payment→REFUNDED。

GET `/admin/orders` 列表 select 加 `refunds:{orderBy createdAt desc, take 1, select:{id,status,outRefundNo,amount,errorMessage,mode,createdAt}}` → 响应映射 `latestRefund`。

**`wechatRefundNotifyHandler`**:`parseNotify(['REFUND.SUCCESS','REFUND.ABNORMAL','REFUND.CLOSED'])`;`refund=findUnique({outRefundNo})` 无→记 error+replyOk;`status==='SUCCESS'`→replyOk(幂等);`amount.refund !== refund.amount`→AMOUNT MISMATCH+告警+replyFail;SUCCESS→事务 `finalizeRefundSuccess`(refund SUCCESS/wxRefundId/successTime/wxNotifyData;`order.updateMany where status REFUNDING → REFUNDED`;payment REFUNDED)+`notifyRefundResult`;ABNORMAL→refund ABNORMAL(activeOrderId 保留)+告警「需到商户平台手动处理」;CLOSED→refund CLOSED、activeOrderId null+告警;DB 异常 replyFail。

`services/order-notify.ts`:`notifyRefundRequest:81` 文案改「请在后台订单管理→退款标签点击「发起退款」,款项原路退回」;新增 `notifyRefundResult(order, refund, status)`。

### W2c admin

**新建 `apps/admin/src/components/RefundDialog.tsx`**(专用组件,不扩展 ConfirmDialog——它是 string-content 的全局单例,塞表单会破坏契约;`Orders.tsx:118-146` 发货 Modal 已是本项目表单弹窗惯例):
- Props `{ order, onClose, onDone }`;state `step:1|2, reason, amountInput, error, submitting`。
- Step 1:灰底摘要(订单号/实付/收货人电话/状态,SHIPPED 提示不回滚库存)+ 原因 input(maxLength 80)→「下一步」。
- Step 2(危险):红字标题「确认退款 ¥xx.xx」+「款项原路退回买家微信,不可撤销」;input placeholder「请输入退款金额(元)以确认」;`/^\d+(\.\d{1,2})?$/ && Math.round(parseFloat(v)*100)===order.actualAmount` 才 enable 红色确认按钮;「上一步」;提交 `refundOrder(order.id,{amount:order.actualAmount, reason})`;成功 toast(mock「已退款」/真实「已发起退款,微信处理中」);失败错误显示在弹窗内保持打开。
- `Modal.tsx` 加 `closeOnOverlay?: boolean`(默认 true),step 2 传 false 且跳过 Esc。
- `api/admin.ts`:`registerRefund` → `refundOrder(id, {amount, reason?})`;`types.ts` 加 `RefundStatus`、`RefundSummary`、`Order.latestRefund?`。
- `Orders.tsx` 按钮(移动卡片 :250-255 与桌面 :335-350 两处同步):PAID/PREPARING/SHIPPED→「退款」;REFUNDING 且无活跃/FAILED/CLOSED→「发起退款」或「重试退款」+「手动标记完成」;PENDING/PROCESSING→灰字「微信处理中」+「手动标记完成」;ABNORMAL→红字「退款异常」+「手动标记完成」;展示 `latestRefund.errorMessage`。手动完成 confirmDialog 文案改为「仅在确认商户平台已退款成功而系统未收到回调时使用」。

**`routes/admin/system.ts` + `pages/SystemStatus.tsx`**:pay 加 `refundNotifyUrlSet, publicKeySet, publicKeyIdSet, verifyMode, certAutoDownload`;新增 `cos:{secretIdSet,secretKeySet,bucketSet,regionSet,baseUrlSet,enabled}`;notify 加 `systemAlertWecomSet`。前端分组「回调验签」(公钥/平台证书二选一即绿)、「图片存储 COS」。

---

## W3 uploads 迁腾讯云 COS

- `apps/server/package.json` 加 `cos-nodejs-sdk-v5`。
- **新建 `services/cos.ts`**:`isCosEnabled()`(5 个 COS_* 全非空)、`buildObjectKey(prefix, ext)` → `uploads/YYYYMM/<ts>-<hex6><ext>`、`putObject(key, buffer, contentType): Promise<url>`(CacheControl public max-age 30d)、`headObject(key)`、`publicUrl(key)`;`COS_BASE_URL` 空则默认 `https://<bucket>.cos.<region>.myqcloud.com`。客户端单例。
- **`routes/admin/upload.ts`**:`multer.memoryStorage()`,limits/fileFilter 不变;`isCosEnabled()` → putObject,否则(仅非生产)回退现有本地写盘。**config.ts:生产未配 COS_* → 启动 exit(1)**(部署前先填 .env)。`services/qrcode.ts:29` TODO 留注释指向 cos.ts,不实现。
- **`Banner.imageUrl` VarChar(255)→500**:迁移 `20260902110000_widen_banner_image_url`;`routes/admin/banners.ts:11` zod max 500。
- **迁移脚本 `apps/server/scripts/migrate-uploads-to-cos.ts`**(`npx ts-node --compiler-options '{"module":"CommonJS"}'`,同 seed 方式,不进 tsc include):`--dry-run`、`--old-prefix`(可多个,缺省 `${PUBLIC_BASE_URL}/uploads/`)、`--report`。算法:①扫 `apps/server/uploads/` 文件,key `uploads/<原名>`,headObject 存在 skip 否则 putObject(并发 5),统计 uploaded/skipped/failed;②`failed>0` 则不改 DB 并 exit 1;③七个 (表,列) `users.avatar_url / categories.icon_url / products.cover_image / products.qr_code_url / product_images.image_url / order_items.product_image / banners.image_url` 对每个 oldPrefix:dry-run `SELECT COUNT(*) WHERE c LIKE CONCAT(?, '%')`,实跑 `UPDATE t SET c=REPLACE(c,?,?) WHERE c LIKE CONCAT(?, '%')`(表名列名常量白名单,值参数化);④孤儿检查:DB 里引用但磁盘不存在的文件名列 `missingFiles[]`;⑤JSON 报告。幂等:重跑全 skip/0 行;先上传后改 DB,任意时刻 URL 可达。
- **过渡**:本轮保留 `app.ts:34 express.static`、`nginx.conf:39-43 /uploads/ alias`、`backup.sh` uploads tar,加注释「迁移完成后下线」;观察≥1 部署周期后单独 commit 删除。
- 桶:公有读私有写;公众平台 downloadFile 合法域名加 COS 域名;`docs/architecture.md:192` 改实际域名。

---

## W4 监控告警

### W4a(最先做)
- **`app.ts:36-38` /health**:`Promise.race([prisma.$queryRaw\`SELECT 1\`, 3s timeout])`,成功 200 `{status:'ok',db:'ok'}`,失败 503 `{status:'degraded',db:'fail'}`,不带细节。deploy.sh 现有 `curl -sf` 对 503 自动判失败。
- **新建 `services/notify.ts`**:`postJson`(从 order-notify 迁出并导出)、`sendWecomMarkdown(webhook, content)`、`notifySystemAlert(title, lines[], {key?, windowMs?})`:webhook 取 `SYSTEM_ALERT_WECOM_WEBHOOK ?? ORDER_NOTIFY_WECOM_WEBHOOK`,都无则 console.error;限频 `Map<key, lastSentAt>` 同 key 5 分钟一次,被抑制计数下次附「期间抑制 N 次」,Map>500 清理;前缀「【阿福凉菜-告警】env 时间」。`order-notify.ts` 改 import。
- **`middlewares/error.ts:38`** 500 分支前 `notifySystemAlert('接口 500', [method url, err.name: message, stack 第二行], {key:'500:'+method+':'+route})`。
- **`app.ts` listen 前进程钩子**:`unhandledRejection` → 告警不退出;`uncaughtException` → 告警后 `setTimeout(()=>process.exit(1), 1500)` 交 PM2 重启;生产启动成功发一条「服务启动」(key 'boot')便于发现重启风暴。

### W4b
- **`scripts/deploy.sh`** [8/9] 后加幂等步骤:`pm2 install pm2-logrotate`(未装时)+ `pm2 set pm2-logrotate:max_size 20M / retain 14 / compress true / rotateInterval '0 0 * * *'`。
- **`scripts/backup.sh`**:新变量 `ALERT_WEBHOOK`;`alert()` curl 企微 text;`trap ERR` 带 `CURRENT_STEP`;COS 上传失败分支 alert;结尾成功摘要(DB/uploads 大小、COS ok/skip、本地保留份数)。
- **UptimeRobot 步骤写进 deployment.md**:监控 `https://api.yuegui-hotel.online/health`(5 min,Keyword `"status":"ok"`)、`admin.…/`(Keyword 阿福)、`api…/api/categories`;告警联系人邮件 + Webhook→企微;演练 `pm2 stop` 10 分钟内收到告警。

env 新增:`SYSTEM_ALERT_WECOM_WEBHOOK`(可空回退),backup.sh `ALERT_WEBHOOK`。

---

## W5 文档

**新建 `docs/miniapp-release-checklist.md`**:①主体与资质准备(与 shop.js/协议【待填】逐项对照表);②公众平台基础设置(名称「阿福凉菜」/头像/简介/类目与许可证/服务器域名 request+uploadFile=api 域、downloadFile=COS 域/业务域名可后置);③**用户隐私保护指引逐项怎么勾**(收货地址✓配送、手机号✓手填非 getPhoneNumber、剪贴板✓about 页复制地址、昵称头像视实际、不启用 __usePrivacyCheck__ 说明、隐私政策链接=小程序内页面截图);④代码侧自检(isDev=false、AppID、协议入口、分享、无 mock);⑤提审表单(版本描述、测试说明「微信授权登录无需账号」、功能截图、审核备注含支付/退款政策/客服电话);⑥常见打回与对策(类目资质、缺协议、支付不可用、诱导分享、客服缺失、名称含「商城」);⑦上线首日(UptimeRobot/企微推送/一分钱下单+退款/备份 cron/系统状态全绿/COS 图片 200);⑧回滚预案。

**更新**:`docs/payment-setup.md`(§三 公钥 vs 平台证书获取步骤;§四 新 env;§五 一分钱退款验证;§六 退款错误码 NOT_ENOUGH/FREQUENCY_LIMITED;§七 标记已实现)、`docs/deployment.md`(env 增补、uploads→COS、nginx `/api/wechat/pay/` 与 `/uploads/` 过渡、backup ALERT_WEBHOOK、**新增 §十三 监控与告警**、发布引用 checklist)、`docs/staff-guide.md §四` 退款流程改两步确认、`docs/api.md` 退款端点/回调、`docs/architecture.md:192`、`.env.example` 全部新变量。

---

## W6 验证

**零错误标准**:`cd apps/server && npx prisma generate && npx tsc --noEmit && npm run build`;`cd apps/admin && npx tsc --noEmit && npm run build`;`node --check` 遍历 miniapp 新增/改动 js;`bash -n scripts/*.sh`。

**本机 mock 全链路 `scripts/e2e.sh`**(bash+curl+jq,长期保留,`BASE=http://localhost:3100`,后端以 `PORT=3100 WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true` 启动):/health db ok → admin 登录 → 上传 1×1 png 返回 URL HEAD 200 → 用户 mock 登录 → 地址/加购/下单/mock 支付 PAID → accept PREPARING → refund 错金额 42206 → 正确金额 REFUNDED + Refund SUCCESS → 第二单用户自助 cancel→REFUNDING→admin refund→REFUNDED → 并发两次 refund 一成一败(42204/42205)→ pending-count / system/status 字段存在 → 清理。

**验签/退款回调脱机自测 `apps/server/scripts/selftest-wechat-notify.ts`**:`generateKeyPairSync('rsa',2048)` 造假「微信」密钥对写 scratchpad,env 指向公钥(`PUB_KEY_ID_TEST`)+32 位 APIv3 key;AES-256-GCM 加密一份 REFUND.SUCCESS resource,签 `${ts}\n${nonce}\n${body}\n`;断言 verify ok / 篡改 body fail / serial 不匹配 fail / 时间戳 -10min fail;平台证书模式用 openssl 自签 X509 再验一次。集成版:server 起 3100 加载该 env,预插 PENDING Refund,curl 带四头 POST `/api/wechat/pay/refund-notify` → SUCCESS 且订单 REFUNDED;重放仍 SUCCESS(幂等);金额改小 → FAIL。

**COS 本机**:`.env` 填真桶凭据 → admin 上传返回 COS URL 浏览器 200 + Content-Type 正确;`migrate-uploads-to-cos.ts --dry-run` 打印计划;本地 DB 造几条 `http://localhost:3100/uploads/x.png` 后实跑 → 前缀替换 + 报告 → 重跑全 skip。无凭据:回退本地盘且 `system/status.cos.enabled=false`。

**admin 浏览器实测**(preview_start admin):退款弹窗两步(金额不匹配按钮 disabled、遮罩不关闭、错误在弹窗内)、REFUNDING 各子状态按钮、手动完成兜底、系统状态新分组、图片上传预览、品牌名 3 处、375px 卡片按钮。

**预览台截图**(`npm run preview:miniapp`):我的页新菜单、关于我们、协议页两种 type、下单页协议行不遮挡、订单详情联系商家按钮、导航标题。

**生产与真实支付/退款(用户配好商户号后,我协助)**:用户按 payment-setup.md 在商户平台设 APIv3 密钥/申请 API 证书/下载公钥或平台证书并上传服务器、填 .env(含 COS_*、SYSTEM_ALERT_WECOM_WEBHOOK)→ deploy → 服务器跑迁移脚本 dry-run/实跑 → 系统状态页全绿 → 真机:登录/下单/一分钱 `wx.requestPayment` 支付 → 企微收到新订单 → 后台两步退款 → 回调写 REFUNDED → 小程序显示已退款 → 企微收到退款结果 → 分享卡片/拨号/协议页真机排版 → UptimeRobot 停服演练 → 备份 cron 手动跑收到摘要。

---

## 风险与注意
- nginx location 必须改前缀,否则退款回调落到 `/api/` 通用块被限流。
- 生产 deploy 前必须先配 COS_*,否则启动校验拒绝(设计如此,写进 deployment.md 醒目位置)。
- `Refund.activeOrderId` 唯一约束是防重复退款核心,不为部分退款放宽。
- X509 serial 比较统一大写。
- 服务器 .env 里已有的生产密码(scratchpad 记录)与本轮无关,不动。
