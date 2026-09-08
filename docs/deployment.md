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
SYSTEM_ALERT_PUSHPLUS_TOKEN=""
```

### 同城配送相关变量（KD100 / 门店回调）

生产 `.env` 里另外需要这几项，`.env.example` 已给出模板：

```env
# 快递100 同城急送（企业版账号，key/secret 在快递100 企业管理后台申请）
KD100_KEY="快递100 分配的 key"
KD100_SECRET="快递100 分配的 secret"

# 回调 URL 拼接前缀，务必是不带尾斜杠的完整域名（下方「callbackUrl 长度预算」依赖这个值）
PUBLIC_BASE_URL="https://api.yourdomain.com"

# 本地开发/e2e 专用，生产绝不能出现 =true（见下）
# LOCAL_DELIVERY_PROVIDER_MOCK=true
```

- `KD100_KEY`/`KD100_SECRET`：不填时呼叫骑手会在请求发起前直接报错「Missing required env var」（`config.ts:validateKd100Config`）；mock 模式（`LOCAL_DELIVERY_PROVIDER_MOCK=true`）下不校验，因为呼叫骑手会走 mock 分支不打真实接口。
- `PUBLIC_BASE_URL`：拼进快递100 回调 URL（`{PUBLIC_BASE_URL}/api/kd/{deliveryNo}`），也是微信支付回调等其他外部回调 URL 的基础域名。**必须不带尾斜杠**，多一个 `/` 会让回调 URL 长度和路径都变样。
- `LOCAL_DELIVERY_PROVIDER_MOCK`：**生产环境这一项只要等于字符串 `"true"` 服务就会拒绝启动**（`config.ts` 生产环境校验，与 `WECHAT_PAY_MOCK` 等其他 mock 开关同一逻辑）。`.env.example` 里这一行已经注释掉，**不要整段复制 `.env.example` 到生产 `.env`**，逐项用下面的 `set-env.sh` 填。本地开发/e2e 才需要在启动命令里带这个变量为 `true`。
- 跑完整 `scripts/e2e.sh`（含邮寄 §59/§60）时，启动命令里还要带 `SCHEDULER_DISABLED=true`：后台 60s 心跳里的 `reconcileExpressUnknown` 会调用 mock provider 的 `detail()`，偷走 §59/§60 测试脚本自己排进 mock 指令队列的那一条，打乱精确计数断言（`.claude/launch.json` 的 `api-3100` 已经带上这个变量）。生产环境没有共享 mock 队列，不受影响，`SCHEDULER_DISABLED` 只是本地/e2e 才需要。

#### callbackUrl 长度预算（换域名前必看）

快递100 对回调 URL 硬性限长 50 字符，服务启动时会算一次最坏情况并校验（`config.ts` 里的 `worstKdCallbackUrl` 检查），生产环境超长直接 `process.exit(1)`：

| URL | 长度 |
|---|---|
| `{PUBLIC_BASE_URL}/api/kd/D123456-1`（生产当前实例） | 48 |
| `{PUBLIC_BASE_URL}/api/kd/D999999-99`（最坏情况：6 位订单号 + 2 位重呼序号） | **49**（上限 50，只剩 1 字符余量） |
| `{PUBLIC_BASE_URL}/api/kd/D9999999-999`（7 位订单号或 3 位序号） | 51 ✗ 会被启动校验拦住 |

推论：当前域名 `api.yourdomain.com` 这一段占多少字符，`PUBLIC_BASE_URL` 全长就顶多再留 1 个字符的余量给别的东西。**换任何更长的 API 域名之前，先把回调路径前缀从 `/api/kd/` 缩短**（例如改成 `/api/k/`，同时改 nginx 里对应的 `location` 与代码里生成回调 URL 的拼接处），否则新域名部署时服务会直接启动失败。订单号到七位（百万单）或重呼序号到三位（同一单重呼 100 次）也会顶破上限，但前者是很多年后才会遇到的规模、后者不会真的发生——两种情况都由启动校验和 `deliveryNo` 生成处的长度校验兜底，不会静默产生一条打不通的回调 URL。

> **已实测生产账号数值**：`api.yuegui-hotel.online`（本项目当前唯一实际生产域名）算出来的最坏回调 URL 正好是 49 字符——这不是巧合留出的宽裕余量,是刚好卡在临界值附近,**部署窗口里不要顺手给 `PUBLIC_BASE_URL` 加尾斜杠**（会变成 50 且路径会多一个 `/`）。

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

### 飞鹅云打印相关变量（H10）

生产 `.env` 里还需要飞鹅云打印开放平台的账号级密钥，`.env.example` 已给出模板，用 `set-env.sh` 逐项填（**不要**整段复制 `.env.example`，做法与上面 KD100 一致）：

```bash
bash /www/food-shop/scripts/set-env.sh FEIE_USER    # 输入不回显
bash /www/food-shop/scripts/set-env.sh FEIE_UKEY
bash /www/food-shop/scripts/set-env.sh FEIE_API_BASE --show   # 非敏感，可回显核对
```

```env
FEIE_USER="飞鹅开放平台账号"
FEIE_UKEY="飞鹅开放平台密钥"
# 国内站，2026-09-05 已用真机核实（SN 222601993）：api.feieyun.cn 返回 ret=0，
# 国际站 api.de.feieyun.com 对同一 SN 返回 ret=1002。本项目账号注册在国内站
# （后台 admin.feieyun.com），FEIE_API_BASE 必须是前者，不能抄网上教程常见的国际站地址。
FEIE_API_BASE="https://api.feieyun.cn"
```

- **懒校验，缺失不阻塞启动**：`config.ts:validateFeieConfig` 只在出票前才检查（与 KD100 同一模式，`PRINTER_PROVIDER_MOCK=true` 的 mock 模式下不校验）。这意味着**打印功能一旦在后台被打开，三个键缺任何一个，每一张票都会立刻变成 `CONFIG:MISSING_CONFIG` 并直接 `FAILED`**（不占重试次数），且被 `retryRecoveredPrinterJobs` 的 `lastError` 前缀过滤**永久排除在补打之外**——不是「打印慢」，是「这张票再也不会自动出」。
- **绑定打印机会先报错，但报错文案会误导**：`POST /admin/printers/bind` 在密钥缺失时返回 `42240`（「打印机未配置」），看起来像是打印机 SN/绑定密钥填错，实际是服务器 env 没填三个 `FEIE_*` 键——遇到 42240 先用上面的 `--list` 确认这三个键是否已填，再去查打印机侧的 SN/KEY。
- **站点选错也报错，但报错码相同**：`FEIE_API_BASE` 填成国际站 `api.de.feieyun.com`，账号密钥本身没错，但飞鹅认为「SN 与 USER 不匹配」，统一返回 `ret=1002`——现象和「SN 真的填错了」完全一样，唯一能分辨的办法是核对 `FEIE_API_BASE` 是否等于本项目实际注册的国内站地址。
- 打印机型号/联数（copies）/渠道/重复播报参数等运营设置在后台「打印机」页配置，不进 env（跟同城运费一样，改一次不该要重启服务）；打印机本身的 SN + 绑定密钥在绑定页录入，同样不进 env、不落库明文。

> **常见误解，需要在文档里明确否定一次**：打印机断电离线时，飞鹅云端会把已下发的票排进 `waiting` 队列，通电恢复后自动补吐（2026-09-05 真机实测：断电 31 秒判定离线，此时 `Open_printMsg` 仍返回 `ret=0`；通电 74 秒后在线，那张票自动打出）。**离线期间打印不会失败**，`CONFIG:MISSING_CONFIG` 是密钥缺失的错误，和打印机是否在线是两回事，不要把两类故障混着排查。

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

### ⚠️ 前置：生产机拉不到远端，代码必须用 git bundle 搬过去

上面这条命令里的 `git fetch` **在本项目从来没有成功过**。生产机的 remote 是私有仓库
`https://github.com/yomeieki/AFU.git`，机器上没有凭据，且 GitHub 账号已挂起：

```
$ git ls-remote --heads origin
fatal: could not read Username for 'https://github.com': No such device or address
```

所以「跑 deploy.sh 就能更新」这个说法是错的，必须先把提交搬上去。实测可行的做法
（2026-09-05 首次跑通，180 个提交 / 5.8MB）：

```bash
# ⓪ 先取生产当前 SHA（下面两处都要用它，别凭记忆填）
ssh ubuntu@162.14.114.95 'cd /www/food-shop && git rev-parse HEAD'

# ① 本地：打增量包。分支名带日期，**不要复用固定名**——
#    生产侧 `git fetch <bundle> X:refs/heads/X` 在 X 已存在且新旧不是快进关系时会失败
#    （回滚之后再往前推就是这种情况）。带日期的一次性名字规避掉整类问题。
BR=deploy-$(date +%Y%m%d-%H%M)
git branch -f "$BR" <要部署的 SHA>
git bundle create /tmp/afu.bundle <生产当前 SHA>.."$BR"
git bundle verify /tmp/afu.bundle          # 会列出前置提交，下面第 ③ 步要逐个验

# ② 传上去（deploy.sh 一并传：生产上那份可能是旧版，不支持 DEPLOY_REF）
scp /tmp/afu.bundle scripts/deploy.sh ubuntu@162.14.114.95:/home/ubuntu/

# ③ 生产：只 fetch 进一个独立 ref，不动 HEAD，确认无误再部署
ssh ubuntu@162.14.114.95
cd /www/food-shop
git status --porcelain -uno                  # 先看未提交改动！reset --hard 会抹掉（见下方要点）
git fetch /home/ubuntu/afu.bundle <上面那个 BR>:refs/heads/<上面那个 BR>

# ⚠️ 如果你在本地用 shell 变量拼这条命令，**必须写 ${BR} 不能写 $BR**：
#   zsh 会把 `$BR:refs/...` 里的 `:r` 当成参数修饰符（去扩展名）吃掉，
#   实际发出去的是 `deploy-xxxefs/heads/deploy-xxx`，报「couldn't find remote ref」。
#   2026-09-06 部署批次三时踩过。bash 没这个问题，但统一写花括号最省事：
#     REFSPEC="${BR}:refs/heads/${BR}"   然后 ssh ... "git fetch <bundle> '$REFSPEC'"
git log --oneline -1                        # HEAD 应仍是旧版
DEPLOY_REF=<要部署的 SHA> bash /home/ubuntu/deploy.sh
```

几个要点：

- **从 `/home/ubuntu/deploy.sh` 跑，不要从仓库里跑**。`deploy.sh` 第 2 步会
  `git reset --hard`，把正在执行的脚本文件本身换掉；从仓库外执行可以完全避开这个问题。
  另外生产上那份 `scripts/deploy.sh` 是部署前那一版，**旧版没有 `DEPLOY_REF`**。
- `git bundle verify` 列出的前置提交，生产机必须**全部**有，**在生产机上验**（本地当然全有，
  在本地跑等于没验）：
  ```bash
  ssh ubuntu@162.14.114.95 'cd /www/food-shop && for c in <verify 列出的每个 sha>; do
    git cat-file -e "$c^{commit}" 2>/dev/null && echo "✔ $c" || echo "✘ 缺 $c"; done'
  ```
  做增量包时前置通常就是生产当前 HEAD 及其合并基。
- 部署前查一次 `git status --porcelain -uno`：`reset --hard` 会抹掉已跟踪文件的未提交改动。
  本项目实测只有 `package-lock.json` 因 npm 版本差异有 `libc` 字段增删，抹掉无害；
  **但每次都要看一眼**，别默认它一定无害。

### ⚠️ 小程序改动：改完必须把 `main` 快进上去，否则开发者工具看不见

**微信开发者工具开在主仓 `/Users/yumingyi/food-shop`，不是任何 worktree。**
所以在 worktree 里改了 `apps/miniapp/**` 之后，只提交是不够的——工具读的是主仓的磁盘文件。

2026-09-06 实测的现场：修完 `app.json` 的 `scope.userLocation.desc` 超限问题并提交，
PO 重新上传体验版，**报的还是旧文案的 32 字**。原因就是主仓的 `main` 还停在上一个提交。

判据（一条命令看两边）：

```bash
for d in . /Users/yumingyi/food-shop; do
  python3 -c "import json;print('$d', len(json.load(open('$d/apps/miniapp/app.json'))['permission']['scope.userLocation']['desc']))"
done
```

两边不一致就 `git -C /Users/yumingyi/food-shop merge --ff-only <你的分支>`。
快进前先看一眼那边的 `git status --short`——那个 checkout 里可能有别人在途的活。

> 服务端改动没有这个问题（生产是 git bundle 搬过去的，与主仓无关）；
> **只有小程序**因为「工具直接读磁盘」而多这一步。

> 什么时候不需要这一套：GitHub 账号恢复、或生产机配好部署密钥之后，`git fetch` 才真正可用。
> 在那之前，任何写着「跑 deploy.sh 就行」的文档都是不完整的。

deploy.sh 会自动完成：**预检（生产环境缺 COS 配置会在动服务之前就中止）** → git 拉取 → 安装依赖 → **迁移前备份数据库** → prisma generate（先快照旧 Client）→ 编译到 `dist.next/` → 迁移（**失败：还原 `dist/` 与 Prisma Client 到部署前，打印三步恢复命令，不重启**；成功：换上 `dist.next/`）→ admin 构建发布 → PM2 热重载 → **pm2-logrotate 安装/配置（幂等）** → Nginx reload → 健康检查（含 DB 探活），并在结尾打印代码回滚与数据库恢复命令。

> 迁移失败时磁盘上仍是旧产物是刻意的：老进程虽然还在内存里跑，但 PM2 之后任何一次自发重启（`max_memory_restart`、机器重启）都会从磁盘重新加载；若 `dist/` 已是新代码就会拿新代码打老库，全站 500 而 `/health` 照样绿。

> ⚠️ 首次部署本版本前，务必先在 `apps/server/.env` 填好 `COS_SECRET_ID/KEY/BUCKET/REGION`，否则预检会直接拒绝部署（这是有意的：新版图片上传只走 COS，配置缺失时启动即失败）。

### 本次部署（含 `20260906000000_member_points_coupon`、`20260907000000_review_fixes` 两个迁移）前置清单

- [ ] **第 0 步，先于 `git bundle` 那一套**：`scripts/deploy.sh` 本轮改了迁移失败时的恢复指引，**必须把新版 `scripts/deploy.sh` 一起传到生产机 `/home/ubuntu/deploy.sh`**（`scp` 命令见上面「⚠️ 前置」小节的第 ② 步，已经包含这一步，不要漏）。生产机上跑的是部署前那一版旧脚本，这次改动不只是 B2（else 分支不再硬编码上一批次的表名，改成动态读迁移文件里的 `CREATE TABLE`），第二轮复核又发现旧脚本这版有两个自己的坑，都已在这版修掉：
  - **R1**：旧脚本在 `set -euo pipefail` 下，`grep -o 'CREATE TABLE ...' | sed | paste` 只要没命中就返回 1，会让整条恢复指引连同**备份文件路径**、**第 ③ 步清 `_prisma_migrations` 失败记录的命令**一起静默不打印，脚本当场退出——而本次两个迁移中 `20260907000000_review_fixes` 恰好一条 `CREATE TABLE` 都没有，触发这个坑是必然的。新脚本给这条探测管道加了 `|| true`。
  - **R2**：旧脚本只探测「最后一个迁移目录」（`ls | sort | tail -1`），但生产在跑的版本落后了不止一个迁移，本次会一次性应用 `20260906000000_member_points_coupon`（4 张新表）与 `20260907000000_review_fixes`（不建表）两个迁移——如果失败点落在 `20260906`，旧脚本探测「最后一个目录」（`20260907`）会读出空，误判「本次迁移不建表，跳过②」，实际上库里可能残留最多 4 张新表，下次部署会撞 1050 报错、Prisma 写入失败记录、永久 P3009。新脚本改成用 `_prisma_migrations` 里已成功完成的最大 `migration_name` 做下界，把本次全部 pending 的迁移文件都纳入 `CREATE TABLE` 探测范围；连不上数据库时不会瞎猜或打印任何硬编码表名，而是明确提示「探测不完整，需要人工核对」。
- [ ] 打印功能若要在本次部署后打开，先按上面「飞鹅云打印相关变量」一节用 `set-env.sh` 填好 `FEIE_USER`/`FEIE_UKEY`/`FEIE_API_BASE`（H10）；不打开打印开关则可以先跳过，等需要时再补。
- [ ] **本次迁移会不会建表、迁移失败时②要不要删表，取决于失败点具体落在哪个迁移里，不能预先断言**：`20260906000000_member_points_coupon` 建了 4 张表（`points_ledgers`/`coupon_templates`/`user_coupons`/`points_goods`），`20260907000000_review_fixes` 只有 `ALTER TABLE`。失败点若在前者，②要删这 4 张表；若前者已成功、失败点只在后者，②确实没有新表要删。新版 `scripts/deploy.sh`（配合上面第 0 步已修的 R1/R2）会在失败时动态探测并把正确结论打印出来——照着当时的实际输出做，不要照搬这份清单预判的结论。

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
- `location /api/kd/` 单独反代，**不限流 + `gzip off`**——快递100 配送单回调专用，必须存在的独立 `location`（**2026-09-06 补装到生产**，此前一直缺，回调都落在通用 `/api/` 上）。`/api/kd-express/` 与 `/api/kd/` 同配置，部署时一起加。

  ⚠️ **这一段的理由此前写错了**：原文说「回调请求需要透传原始字节做验签」——那是 `/api/wechat/pay/` 的理由，被照抄了过来。快递100 验签算的是 `MD5(param + 每单独立的 callbackSalt)`，`param` 取自 `express.urlencoded` 解析后的**表单字段值**（`services/delivery/kd100.ts` 的 `verifyAndParseCallback`），nginx 缓不缓冲都不改变它。所以模板里**故意没有** `proxy_request_buffering off`。

  真正的两条理由：
  1. **限流**：通用 `/api/` 有 `limit_req burst=20`。被 nginx 挡掉的回调**不会**被无限重推——快递100 只重推 2 次、间隔 1 分钟，推完就放弃，配送状态从此永久卡住，而店员看不出是回调丢了。（同一类风险还有应用层的 `kdCallbackLimiter`：它被触发时**返回 200 且 body 是成功形状**，对方会当 ack 成功，回调静默丢失，见 `middlewares/rate-limit.ts:146-153`。）
  2. **gzip**：通用 `/api/` 有 `gzip_types application/json`，而回调的 ack 应答正是 JSON；压过之后若对方不解压就会判 ack 失败并重推。2026-09-06 实测确认这条风险是真的：同样带 `Accept-Encoding: gzip` 请求 `/api/products` 会返回 `content-encoding: gzip`。模板里写的是**显式 `gzip off`**，而不是依赖「http 级恰好没设 `gzip_types`（默认只压 `text/html`）」这个巧合——那行注释哪天被人取消，回调就会静默地重新开始被压。

  **换域名/迁移服务器时把这段和 `/api/wechat/pay/` 一起原样复制过去，不要只复制 `location /api/` 那一条**。

- ⚠️ **模板不能直接 `cp` 覆盖生产**：模板里限流 zone 名是 `api_limit`，而生产 `/etc/nginx/conf.d/food-shop.conf` 用的是 `fs_api`（zone 在别处定义）。直接覆盖会 `nginx -t` 失败（这一条会响亮地失败，不会静默出错，但会让人以为模板坏了）。正确做法是**按段落对照着补**，补完 `nginx -t` 再 reload。

  验证这一段真的生效（不触发任何业务告警，用 GET，路由只收 POST）：
  ```bash
  sudo nginx -T | grep -A9 'location /api/kd/'
  # 应无 content-encoding：
  curl -s -D- -o /dev/null -H 'Accept-Encoding: gzip' https://api.yuegui-hotel.online/api/kd/D999999-99 | grep -i content-encoding
  # 对照组，应有 content-encoding: gzip：
  curl -s -D- -o /dev/null -H 'Accept-Encoding: gzip' https://api.yuegui-hotel.online/api/products | grep -i content-encoding
  ```
- `location /uploads/` 存量本地图片过渡期直出；COS 迁移完成一个部署周期后可删

### 部署后回调链路演练（curl，不依赖真实骑手触发）

新环境部署完、`.env` 填好 `KD100_KEY/SECRET`、`PUBLIC_BASE_URL` 之后，不用等真实呼叫一次骑手才能确认 `/api/kd/:deliveryNo` 这条回调链路通不通。`scripts/e2e.sh` 里的 `kd_cb` 辅助函数（约 761 行）演示了怎么手工构造一条合法签名的回调请求；把它简化成独立可执行的片段：

```bash
#!/bin/bash
# 用法：kd-callback-drill.sh <deliveryNo> <callbackSalt> [providerStatus] [statusDesc]
# callbackSalt 从数据库直接查（生产没有 mock 模式的 /kd100-mock/salt 端点可用，
# 那个端点只在 config.mock.delivery=true 时才挂载，生产严禁开 mock）：
#   mysql -uroot -p food_shop -e \
#     "SELECT delivery_no, callback_salt FROM deliveries WHERE delivery_no='D<orderId>-1'"
DELIVERY_NO="$1"; SALT="$2"; STATUS="${3:-100}"; DESC="${4:-演练:骑手已接单}"
PARAM=$(printf '{"taskId":"DRILL-TASK","status":"%s","statusDesc":"%s","updateTime":"%s","courierName":"演练骑手","courierMobile":"13900000000","kuaidicom":"drill"}' \
  "$STATUS" "$DESC" "$(date '+%Y-%m-%d %H:%M:%S')")
SIGN=$(printf '%s%s' "$PARAM" "$SALT" | md5sum | cut -d' ' -f1 | tr 'a-f' 'A-F')
curl -s -w '\nHTTP %{http_code}\n' -X POST "https://api.yourdomain.com/api/kd/${DELIVERY_NO}" \
  --data-urlencode "param=${PARAM}" \
  --data-urlencode "sign=${SIGN}" \
  --data-urlencode "taskId=DRILL-TASK"
```

预期：`HTTP 200` 且响应体 `{"result":true,...}`；再用 `GET /api/admin/local/orders/:id/delivery`（管理员 token）确认该订单的配送单状态确实推进了。**这条演练会真的改动一条真实（测试）配送单的状态**，只应该对着一笔专门造出来的测试订单跑，跑完按 `docs/ops-test-orders.md` 的收尾步骤清理，不要拿一笔真实顾客订单练手。

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
cd /www/food-shop && git log --oneline -10

# 回滚到指定 commit：必须用 DEPLOY_REF，脚本会跳过 fetch 并 reset 到该提交
DEPLOY_REF=<commit-hash> bash scripts/deploy.sh  # 重新编译 + 迁移（已应用的会跳过）+ 重启
```

> ⚠️ **不要**先 `git checkout <commit-hash>` / `git reset --hard <commit-hash>` 再裸跑 `bash scripts/deploy.sh`：脚本 [2/9] 会无条件 `reset --hard origin/main`，把刚回滚掉的版本原样装回去，等于没回滚（还会留下 detached HEAD）。每次部署结束脚本都会打印带 `DEPLOY_REF=<部署前 sha>` 的回滚命令，直接复制即可。

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

已配置（账号即注册邮箱，2026-09-03 建）：

| 类型 | URL | 判定 | 说明 |
|---|---|---|---|
| HTTP(s) | `https://api.yuegui-hotel.online/health` | Up 状态码仅 2xx/3xx | 后端进程 + MySQL 探活。DB 挂时该接口返回 **503 degraded**，直接判 Down，不需要额外的关键词 |
| Keyword | `https://admin.yuegui-hotel.online/` | `阿福凉菜` **不存在**即告警 | 后台静态站 + HTTPS 证书。用关键词而非纯 HTTP：构建产物坏掉时页面照样返 200 |
| Keyword | `https://api.yuegui-hotel.online/api/categories` | `"code":0` **不存在**即告警 | 业务接口。该接口出错时也返 200 但 `code` 非 0，只看状态码发现不了 |

关键词匹配的是**响应 HTML/JSON 源码**，不是渲染后的 DOM——单页应用要挑打包进 `index.html` 的静态文字（这里是 `<title>`）。

**告警渠道：邮件**。Webhook 已改为付费功能，所以无法把拨测告警转推到 PushPlus；免费的手机推送需装 UptimeRobot 的 iOS/Android App 并在 Integrations → Push notifications 里启用。

**演练**：`pm2 stop food-shop-server`，10 分钟内应收到 Down 邮件，`pm2 start` 后收到 Up。不停机的替代验证是监控详情页的 **Test Notification**（只验投递链路，不验探测逻辑）。

### 13.2 服务内告警

| 触发 | 位置 | 限频 |
|---|---|---|
| 接口未捕获异常（HTTP 500） | `middlewares/error.ts` | 同路由 5 分钟一次 |
| `unhandledRejection`（只告警不退出） | `app.ts` | 5 分钟一次 |
| `uncaughtException`（告警后 1.5s 退出，PM2 自动重启） | `app.ts` | 5 分钟一次 |
| 生产启动打点（短时间频繁收到 = 重启风暴） | `app.ts` | 1 分钟一次 |
| 支付回调金额与订单不符 | `routes/wechat-notify.ts` | 每订单一次 |
| 退款发起失败 / 退款异常 / 退款关闭 / 退款回调金额不符 | `services/refund.ts` | 每退款单一次 |

被限频抑制的次数会附在下一条同类告警里。

**投递到所有已配置的通道**，一个都没配时退化为 `console.error`（pm2 日志可查）：

| 通道 | env | 回退 | 收件人 |
|---|---|---|---|
| 企业微信群机器人 | `SYSTEM_ALERT_WECOM_WEBHOOK` | `ORDER_NOTIFY_WECOM_WEBHOOK` | 告警群 |
| PushPlus | `SYSTEM_ALERT_PUSHPLUS_TOKEN` | `ORDER_NOTIFY_PUSHPLUS_TOKEN` | **token 所属账号本人** |

PushPlus 告警**刻意不带 `topic`**：订单带群组编码推给全体店员，告警不带群组只推给老板本人。同一个 token 就能把两类消息分给两拨人，不必再申请第二个账号。`backup.sh` 的每日备份结果走同一套取值逻辑。

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
| `yuegui-booking-backup-1342627167` | 私有 | yuegui-hotel | prod | backup | 酒店预订备份（另有原标签「预定信息=1」）。本项目备份落在 `food-shop/` 前缀下，见下方生命周期规则 |
| `yuegui-room-service-sandbox-1342627167` | 公有读 | yuegui-hotel | sandbox | sandbox | 客房配送沙箱（另有原标签「客房配送=2」）|

图片桶的成本护栏：控制台「默认告警」已开（1 分钟外网下行 >5000MB 触发）。如需进一步防盗刷，可在桶的「安全管理 → 防盗链」配 Referer 白名单——**注意小程序请求不带 Referer，必须勾选「允许空 Referer」，否则图片全裂**。

备份桶的生命周期规则 **food-shop-backup-90d**（2026-09-03 建）：范围限定前缀 `food-shop/`，当前版本文件修改 90 天后删除，碎片创建 30 天后删除。

只作用于 `food-shop/` 是刻意的——同一个桶里 `production/`、`backups/`、`sandbox/` 属于酒店项目，不能被这条规则波及。保留 90 天而非 30 天：每日数据库备份只有 ~20KB，90 天累计不到 2MB，多留回旋余地几乎不花钱。

备份密钥（CAM 子用户）**没有 DeleteObject 权限**，所以过期清理只能靠桶的生命周期规则，不能靠脚本删——这也是故意的，防止密钥泄露后备份被一并抹掉。

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
