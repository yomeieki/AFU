# 同城配送整改 —— 交接说明（给执行方案的那个会话）

> **你要执行的方案**：`docs/superpowers/plans/2026-09-06-local-delivery-remediation.md`
> **配套实测数据**：`docs/local-delivery-run-log.md`（生产首单全部原始数据，方案里的每个数字都出自它）
> **店主视角操作手册**：`docs/local-delivery-golive-manual.md`
>
> 这份说明是**给你的前置条件与踩坑清单**，不是方案本身。**动手前整份读完。**
> 它记录的都是 2026-09-06 这一天真金白银踩出来的，不是推测。

---

## 0. 现在是什么状态（先建立坐标）

同城配送 **2026-09-06 当天上线并跑通了生产首单**（真钱、真骑手、真顾客收货）。
所以**你面对的不是一个待开发的功能，而是一个正在给真实顾客用、并且正在赔钱的功能**。

| 项 | 值 |
|---|---|
| 生产版本 | **`806c2a3`** |
| 同城总开关 | **已开启**（`enabled: true`）——顾客现在就能下单 |
| 会员积分开关 | 关闭（另一个会话在推进，别碰） |
| 同城商品 | 凉拌牛肉 ¥25 / 凉拌三丝 ¥15，库存 10，**无图** |
| 配送半径 | **10 km**（默认 5，店主改的） |
| 运费参数 | `baseFee ¥6 / baseKm 3 / perKmFee ¥2.5 / freeThreshold ¥99 / minOrderAmount ¥40 / riderSpeedKmh 15` |
| 营业时段 | 09:00–20:00（`Asia/Shanghai`） |
| 首单 | `ORD20260906918208`(id=19) / 配送单 `D19-1` / 已 `COMPLETED` |

**⚠️ 每一次「呼叫骑手」都是真钱**，且骑手费**不可退**（商品钱和运费可以原路退回）。
首单实付骑手 ¥23.32。测试策略改动时优先用 mock（见 §5），真机单必须店主在场且事先说清花多少。

---

## 1. 硬约束（违反会造成实际损害）

1. **禁止 `git push`。** GitHub 账号已挂起，本地仓库是唯一真相。
   生产部署走 `git bundle` 搬运（§3）。
2. **绝不打印、绝不传输任何密钥的值。** 只说键名与「有/无」「几位」。
   要写 `.env` 用项目自己的 `scripts/set-env.sh`（它会备份 + 去重 + `chmod 600`）。
   需要把一个从 API 取到的值写进 `.env` 时，用管道让它**不经过你的上下文**：
   ```bash
   node -e '...只 console.log 那个值...' | bash /www/food-shop/scripts/set-env.sh KEY_NAME
   ```
   ⚠️ 值末尾**必须有换行**（用 `console.log` 不要用 `process.stdout.write`）：
   `set-env.sh` 里是 `read`，无换行时在 EOF 返回非 0，被 `set -e` 直接掐掉，报错还很难看懂。
3. **生产写操作需要店主逐次授权。** 部署、改 `.env`、改设置、改库，动手前先说清「要做什么、影响什么、怎么回滚」，
   拿到明确同意再执行。只读查询（`SELECT` / `nginx -T` / `pm2 list` / 免费查价）不需要。
4. **模型分工**（店主定的铁律，见记忆 `workflow-model-tiering`）：
   产出**事实**用 `sonnet`（摸代码、列状态机）/ `haiku`（grep 式清点）；
   产出**判断**用 `opus`（复核、对抗验证）；产出**方案**用 `fable`。
   ⚠️ 写 Workflow 脚本时**不传 `model` 不是「用默认档」，而是「继承会话模型」**——漏写不报错、不提示。
   自检：数一遍 `agent(` 的个数，再数一遍 `model:` 的个数，**两个数必须相等**。

---

## 2. 生产环境事实

```
主机   162.14.114.95（腾讯云 CVM），ssh 用户 ubuntu，有免密 sudo
仓库   /www/food-shop
env    /www/food-shop/apps/server/.env
PM2    food-shop-server，**单实例 fork**
MySQL  sudo mysql（socket 认证 root），库名 food_shop
后台   /www/food-shop-admin/dist（deploy.sh 会重建）
域名   api.yuegui-hotel.online（顾客端 + 回调）/ admin.yuegui-hotel.online
```

- **单实例 fork 很重要**：熔断状态是**进程内存**（`services/delivery/circuit.ts`），
  重启即复位；定时任务不会重复跑。如果哪天改成 cluster，这两条都会坏。
- `~/.ssh/config` 里的 `oracle`（140.83.54.60）**不是**生产机，别去那台找 `.env`。

### ⚠️ 数据库时间是 UTC，而 MySQL 的 `NOW()` 是 CST

实测：`NOW() = 20:25:39` 而 `UTC_TIMESTAMP() = 12:25:39`。
**Prisma 往 `DATETIME` 列写 UTC 墙钟**，所以你 `SELECT` 出来的时间要 **+8 小时**才是本地时间。
（方案 §7.1 要把生产 MySQL 全局时区钉成 `+00:00` 来消除这个不一致。）

排查现场时别被这个坑到——首单的 `created_at` 是 `11:59`，实际发生在 **19:59**。

---

## 3. 部署流程（照抄，别自己发明）

生产机**拉不到远端**（`git ls-remote` 会报 `could not read Username for 'https://github.com'`）。
完整流程在 `docs/deployment.md` 的「⚠️ 前置：生产机拉不到远端」小节。要点：

```bash
# ⓪ 取生产当前 SHA（别凭记忆填）
ssh ubuntu@162.14.114.95 'cd /www/food-shop && git rev-parse HEAD'

# ① 确认能增量 + 看有没有迁移（有迁移风险完全不同）
git merge-base --is-ancestor <生产SHA> HEAD
git diff --name-only <生产SHA>..HEAD -- apps/server/prisma/

# ② 打包，分支名带日期，不要复用固定名
BR=deploy-$(date +%Y%m%d-%H%M)
git branch -f "${BR}" HEAD
git bundle create /tmp/afu.bundle <生产SHA>.."${BR}"
git bundle verify /tmp/afu.bundle

# ③ 传（deploy.sh 一并传：生产上那份可能是旧版、不支持 DEPLOY_REF）
scp /tmp/afu.bundle scripts/deploy.sh ubuntu@162.14.114.95:/home/ubuntu/

# ④ 生产：先看未提交改动，再 fetch 进独立 ref（不动 HEAD）
ssh ubuntu@162.14.114.95 "cd /www/food-shop && git status --porcelain -uno"
#   实测长期只有 package-lock.json 的 libc 字段差异，抹掉无害，但每次都要看一眼
REFSPEC="${BR}:refs/heads/${BR}"
ssh ubuntu@162.14.114.95 "cd /www/food-shop && git fetch /home/ubuntu/afu.bundle '$REFSPEC'"

# ⑤ 部署。**从 /home/ubuntu/deploy.sh 跑，不要从仓库里跑**
ssh ubuntu@162.14.114.95 'DEPLOY_REF=<sha> bash /home/ubuntu/deploy.sh'
```

三个必须知道的原因：

- **从仓库外执行 `deploy.sh`**：脚本第 2 步会 `git reset --hard`，把正在执行的脚本文件本身换掉；
  另外生产上那份是部署前那一版，**旧版没有 `DEPLOY_REF`**。
- **zsh 会吃掉 git 引用**：`$BR:refs/...` 里的 `:r`、`$B:apps/...` 里的 `:a` 会被当成参数修饰符，
  报「couldn't find remote ref」或路径被拼歪。**统一写 `${BR}` 花括号**。两个都实测踩过。
- **分支名带日期**：生产侧 `git fetch <bundle> X:refs/heads/X` 在 X 已存在且新旧不是快进关系时会失败
  （回滚之后再往前推就是这种情况）。

回滚：`DEPLOY_REF=<上一版sha> bash /home/ubuntu/deploy.sh`。
方案里的迁移是 additive，旧代码不读新列，所以代码回滚不需要回滚数据库。

### 改了 `apps/miniapp/**` 还要多一步

**微信开发者工具读的是主仓 `/Users/yumingyi/food-shop` 的磁盘，不读任何 worktree。**
在 worktree 里改完只提交是不够的，店主重新上传体验版会传的还是旧代码（实测踩过）。

```bash
git -C /Users/yumingyi/food-shop merge --ff-only <你的分支>
```
**快进前先看那边的 `git status --short`**——主仓 checkout 里可能有别的会话在途的活。
服务端改动没这个问题（生产用 bundle 搬，与主仓无关）。

---

## 4. 判断「改动到没到生产」的正确判据

**❌ 不能用 401/404 判。** `/api/member/*` 与 `/api/admin/*` 整个前缀都挂在鉴权中间件后面，
**一个根本不存在的路由也返回 401**。照它判，哪怕跑的是三个版本前的代码也会报「已上线」。

**✅ 能用的**：

```bash
# ① 生产跑的 commit
ssh ubuntu@162.14.114.95 'cd /www/food-shop && git log -1 --oneline'

# ② 编译产物里 grep 特征串（⚠️ dist 在 apps/server/dist/，仓库根的 dist/ 是空的）
ssh ubuntu@162.14.114.95 'grep -rl "<你这次新增的独特字符串>" /www/food-shop/apps/server/dist/'

# ③ 后台构建产物
ssh ubuntu@162.14.114.95 'grep -o "<新增的中文标签>" /www/food-shop-admin/dist/assets/index-*.js'
```

同类陷阱：**`/api/local/meta` 返回 200 ≠ 同城已开通**，`data.enabled` 才是开关。

---

## 5. 本地测试

```bash
# 服务端类型检查
npm run build:server        # = tsc
npm run build:admin         # = tsc && vite build

# e2e（用 mock provider，不打真实运力方）
BASE=http://localhost:3105 DB_NAME=food_shop_audit bash scripts/e2e.sh
```

- e2e **必须**用 `DB_NAME=food_shop_audit`，别打生产库也别打开发库。
- 新用例放 `scripts/e2e.d/NN-*.sh`。方案 §4.5 已经把 `50-call-strategy.sh` 的 7 个场景列好了。
- **`scripts/e2e.sh` §32 ③b 会随策略默认值变化而变红**（那段断言「不传 providers 时
  `calledProviders` = 设置里的默认列表」）。方案 §4.5 说了怎么改，别当成回归。
- 已知偶发红：60 秒 scheduler 心跳会打乱精确条数断言（记忆
  `e2e-background-scheduler-tick-flakes`）。红了先看是不是这个。
- ⚠️ **并行 agent 各自跑 `prisma generate` 会互相打断**（worktree 共用 Prisma client），
  **验证必须串行**（记忆 `worktrees-share-prisma-client`）。

### mock 与真实的分界（决定「本地绿了到底算不算绿」）

**共用真代码的部分**（本地绿 = 真的绿）：回调路由、验签、状态机、幂等去重、事务与订单联动、
错误码映射、熔断、超时→UNKNOWN、加小费封顶。

**不同的部分**（本地绿 ≠ 真的绿）：外呼（mock 是指令队列）、距离（mock 用直线×1.6）、
报价（mock 单家 ¥5）、taskId、取消费（mock 恒 ¥2）、**骑手位置（mock 恒返 null）**、
回调（本地是脚本自己 POST，不过 nginx、不过公网）。

`LOCAL_DELIVERY_PROVIDER_MOCK=true` 在 `NODE_ENV=production` 下会**直接拒绝启动**，
所以生产不可能误开 mock，`/kd100-mock/*` 控制面在生产也挂不上。

---

## 6. 这个模块特有的坑（都是实测踩出来的）

### 6.1 「参数错 → 30001 → 被 catch 吞掉」这个静默失败家族

**今天一天抓到两个同族的**，都是从上线起就坏、从来没人发现：

| bug | 表现 | 为什么没人发现 |
|---|---|---|
| `price()` 的 `callbackUrl` 写成空串 | `30001 回调地址格式错误`，**每次查价都失败** | `measureRoadDistanceM` 的 catch 退回「直线×1.7」估算，只把 `distanceSource` 标成 `ESTIMATED`；报价照样签发、订单照样能下 |
| `queryCourier` 传 `taskId` 而接口要 `orderId` | `30001 orderId不能为空`，**骑手位置从没成功过** | `orders.ts` 的 catch 吞成 `location:null`，页面只是不显示卡片、不报错 |

**两个都已修并部署。** 但这个模式要记住：**快递100 的参数错一律返 `30001`，
而 `_mapReturnCode` 把 30001 归成 `CONFIG`，上层多数地方有 catch 兜底 → 完全静默。**

**所以：任何一处调用快递100 的新代码，都要问一句「失败时谁会知道」。**
可以用 A/B 只变一个量来定位（这是今天两个 bug 都被钉死的方法）：

```bash
ssh ubuntu@162.14.114.95 'cd /www/food-shop/apps/server && node -' <<'EOF'
require('/www/food-shop/apps/server/dist/config.js')   // 触发 dotenv/config
// ⚠️ wechat-access-token.js 等模块直接读 process.env、不 import config，
//    单独 require 它们时 dotenv 从没跑过——先 require config.js
const { _sign, _buildOrderParam } = require('/www/food-shop/apps/server/dist/services/delivery/kd100.js')
// ... 自己拼 URLSearchParams({ method, key, sign, t, param }) POST 到
//     https://api.kuaidi100.com/bsamecity/order
EOF
```
`batchPrice`（查价）**免费、不下单、不落库**，是零成本探测手段，随便打。

### 6.2 快递100 的接口边界

- **没有主动查单接口**，也没有查费、查余额接口。我实打了 11 个方法名
  （`query` / `queryOrder` / `orderQuery` / `queryorder` / `getOrder` / `orderDetail` /
  `queryFee` / `bill` / `balance` / `queryBalance` / `account`），**全部返回「找不到该method」**。
  **别再试了。** 实扣金额只能店主在企业后台看，次月出账单，**账单异议只有 5 个工作日窗口**。
- **回调是唯一的事实来源**，且对方只重推 2 次、间隔 1 分钟，**推完就放弃**。
  所以任何让回调失败的原因都会造成「配送状态永久卡住且店员看不出来」。
- **`callbackUrl` 上限 50 字符**。当前最坏值 49（`https://api.yuegui-hotel.online/api/kd/D999999-99`），
  **只剩 1 个字符余量**。启动时（`config.ts`）和每次呼叫时（`orchestrator.ts`）各校验一次，
  超长会 `process.exit(1)` 或抛 42225，不会静默。但**别给域名加尾斜杠、别换更长的域名**。
- 验签密钥是**每张配送单独立的随机 salt**（`Delivery.callbackSalt`），不是 `KD100_SECRET`。
  它在管理端与顾客端的 select 白名单里都被**显式剔除**——加字段时别让 select 退化成整行 include。
- 自贡**只有 4 家运力有覆盖**：达达 / 蜂鸟 / 顺丰同城 / 闪送。
  配置里挂了 7 家，`meituantongcheng` / `uupaotui` / `gxdtongcheng` **不返报价**。
  （方案 §3.3 论证了摘掉它们没有收益，推荐不动。）

### 6.3 状态机的两条铁律

1. **状态推进一律 `updateMany({where:{id, status:<期望值}}) + 判 count===0`，不许 `findUnique` 后 `update`。**
   MySQL RR 快照读下 `findUnique` 在事务里**不加锁**，读到的可能是旧值。
   `services/refund.ts:344` 有这条规则的完整论述；今天上线的 `b6fd384` 修的就是三处漏网。
2. **回调侧还要加 `statusRank` 单调 + `status notIn TERMINAL`**（`callback.ts`），
   否则乱序迟到的回调会把状态往回拨。

### 6.4 `Delivery.activeOrderId` 唯一索引

**一张订单同时只允许一张在途配送单。** 所以「3 分钟无人接就升级并呼」**不可能是「追加呼叫」**，
只能「取消 D-1 → 新建 D-2」。方案 §4.3 已按此设计。并发呼叫靠这个索引的 P2002 挡住（→ 42228）。

### 6.5 应用层限流会静默丢回调

`middlewares/rate-limit.ts` 的 `kdCallbackLimiter` 被触发时**返回 200 且 body 是成功形状**，
快递100 会当 ack 成功、**不重推**。生产 120 次/分，本店量级碰不到，但改这块时要知道。

### 6.6 nginx

生产 `/etc/nginx/conf.d/food-shop.conf` 今天补上了 `location /api/kd/`（含**显式 `gzip off`**）。
- `deploy.sh` **只 `nginx -t` + `reload`，从不复制配置文件**——改配置是手工 `cp`/编辑。
- **模板 `scripts/nginx.conf` 不能直接 `cp` 覆盖生产**：模板限流 zone 名是 `api_limit`，
  生产用的是 `fs_api`，直接覆盖会 `nginx -t` 失败。按段落对照补。
- 那个 `gzip off` 是必须的：通用 `location /api/` 有 `gzip_types application/json`，
  实测同样带 `Accept-Encoding: gzip` 请求 `/api/products` 会返回 `content-encoding: gzip`。
  ack 被压 → 对方可能判失败 → 重推 3 次后放弃 → 状态卡死。

---

## 7. 订阅消息（别把配送通知挤掉）

**微信单次授权弹窗最多 3 个模板**（`apps/miniapp/utils/subscribe.js` 的 `slice(0,3)`），
服务端返回顺序是 `[付款, 发货, 退款, 配送]`（`services/subscribe-message.ts`）。

当前生效 **3 个**：发货 ✔ 退款 ✔ 配送 ✔，**付款故意不配**。

> ⚠️ **谁都不要去配 `WECHAT_TMPL_PAID`。** 配了就是 4 个，**排在最后的配送会被静默丢掉**。

微信「我的模板」里其实有 5 个（还有「商品送达通知」和「下单成功通知」），
两个都**故意没接**。别看到没引用就顺手接上。

另外：`send()` 是 fire-and-forget，模板 ID 或字段编号填错时**完全静默**——
顾客收不到、后台也不报错。改这块务必用真机验证。

---

## 8. 不要重做的事（今天已完成并验证）

| 事 | 证据 |
|---|---|
| 回调链路全通 | 首单 6 条事件（API 下单 + 回调 `0/100/230/310/520`）全部到位并正确推进状态 |
| nginx `/api/kd/` | 已补装，被真实流量验证；gzip 风险已实测证实并压住 |
| `price()` 的 `callbackUrl` | 已修（`26677a2`），生产实测拿回 4 家真实报价 |
| `queryCourier` 的 `orderId` | 已修（`806c2a3`），生产实测拿到真实骑手坐标 |
| 配送通知模板 | 已配并重启生效，生效模板数 = 3 |
| 支付回调并发守卫 | `b6fd384` 已随 `848ba0b` 上线 |
| `lbsType=2`（GCJ-02） | 首次验证通过——「用骑手位置自己算 ETA」这条路坐标系上可行 |
| 「实扣 = 中标运力报价」 | 后台四行与库里快照**四比四全中**，假设成立 |
| 并呼未中标方**不推 720** | 首单 7 家并呼、1 家中标、6 家落空，`delivery_events` 里没有任何 720。**样本 n=1，继续观察但不是待修 bug** |

---

## 9. 方案里最容易做错的两处

1. **改运费参数**（批次 0）：「同城设置」页的保存是**整包覆盖 PUT、无乐观锁**——
   两个人同时开着改，后保存的会把前一个人的冲掉。
   一人操作、改前刷新、改完再刷新回读。
   ⚠️ 营业时段那个 textarea 是**非受控**的（`defaultValue` + `onBlur`）：
   改完要先点别处让它失焦才会写回 state；而且保存后不会重渲染，**容易看着旧值以为改好了**。
   原值记在方案 §8 的风险表里，回滚就是改回去。
2. **改 tabBar**（批次 3）：方案**明确推荐不改**。`switchTab` 会销毁非 tabBar 页栈，
  封面已经因为这个踩过一次坑。而且同城购物车与邮寄购物车是分开的、tabBar 角标只统计邮寄车，
  所以「购物车」这个 tab 对同城单本身就是误导。若店主坚持要改，单独一批、单独验收。

---

## 10. 有疑问先读哪份

| 想知道 | 读 |
|---|---|
| 首单每一个数字的原始出处 | `docs/local-delivery-run-log.md` |
| 快递100 接口能力与限制 | `docs/research/2026-09-03-kuaidi100-same-city-api.md`（预扣规则那节已用实测更新） |
| 工作台该长什么样 | `docs/design/workbench-ui-spec.md`（**§6b 早就把「只呼最低价 + 3 分钟并呼」的 UI 画好了**，不用重新设计） |
| 状态机与订单联动 | `docs/order-flow.md` |
| 部署 | `docs/deployment.md` |
| 店员怎么操作 | `docs/staff-guide.md`（⚠️ 曾写过两个**不存在**的按钮，已修，但改它之前先跟代码对一遍） |
| 店主怎么操作 | `docs/local-delivery-golive-manual.md` |

**文档与代码不一致时，一律以代码为准，并顺手把文档改对。** 今天已经抓到三处漂移
（`staff-guide` 的两个假按钮、`deployment.md` 里「透传原始字节验签」这个错理由、
调研文档里悬了三天的「预扣规则待与客服确认」）。
