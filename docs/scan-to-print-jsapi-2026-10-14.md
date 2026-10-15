# 「扫码打印」= 扫完**直接打印这一张**（2026-10-14 晚 · 业务负责人选了 ⓐ）

> 她逐字：「要 A」——即「飞书 JSAPI 扫码 ⇒ **扫了二维码之后就直接打印这个二维码**」。

## 一、⭐ 要的效果
```
她在工作台「货品 → 标签打印」点【📷 扫码打印】⇒ 弹**飞书原生扫一扫**（JSAPI，不是跳外链 ✗）
  ⇒ 扫到某张标签的二维码（内容 = `https://hm.bamamei.online/r/{记录ID}` ✓ 真源：`buildLabelScanUrl`）
  ⇒ ⭐ **立刻把那一张排进既有的打印队列**（店里那台电脑出纸 ✓）⇒ 页面上给一句明确结果 ✓
```

## 二、要新建的两块（**都是既有能力之上接一层** ✓ 不另起一套 ✗）
| # | 要做的 | 复用/约束 |
|---|---|---|
| 1 | ⭐ **服务端 JSAPI 签名接口**：`access_token → jsapi_ticket → signature` | 用**既有** app 凭证（服务端 env ✓）· **不写死任何密钥** ✗ · 带上 `appId` `timestamp` `nonceStr` `url` ✓ · **缓存 ticket**（**以飞书回的 `expire_in` 为准**，见文末"坑 ②"） |
| 2 | ⭐ **客户端**：在那一页 `h5sdk.config(...)` ⇒ 调 **扫一扫** ⇒ 拿到扫到的字符串 | 需要**配 H5 可信域名**（飞书后台 ✓ 变更是**运维动作** ⇒ 我会先报你一声 ✗） |
| 3 | ⭐ **按"扫到的那一张"打印**：把 `record_id`（从 URL 里解出来 ✓）传给打印队列 | 打印队列现有 filters = `keyword/category/size/state` ✗ ⇒ **加一条"按记录 ID 精确一张"** ✓（配置先行 ✓ 不改既有 filters 语义 ✗） |
| 4 | 结果如实 | 成功 ⇒ 「已提交打印（这一张）」✓ · 失败/离线 ⇒ **人话**（既有文案 ✓）**不假成功** ✗ |

## 三、AC（先写先红）
- **AC-SP1** ⭐ 有一个**签名接口**：返回 `appId/timestamp/nonceStr/signature` ✓（**响应里不含任何密钥** ✗）
- **AC-SP2** ⭐ 签名**算得对**：同一入参下，服务端自校验通过 ✓（用假 ticket 注入 ⇒ **能真红** ✓）
- **AC-SP3** ⭐ **ticket 缓存**：2 小时内多次调用 ⇒ 只向飞书取一次 ✓（可配 ✓）
- **AC-SP4** ⭐ 扫到的字符串 ⇒ **解析出记录 ID** ✓（`/r/{id}` ✓；**不是**这个形状 ⇒ 人话拒绝 ✓ 不猜 ✗）
- **AC-SP5** ⭐ 按记录 ID ⇒ **只排这一张**（不多打 ✗ 队列 job 的 label 数 = 1 ✓）
- **AC-SP6** ⭐ **复用同一个队列**（源码哨兵：**不新开打印接口** ✗ · 走 `/api/workbench/label-print/jobs` ✓）
- **AC-SP7** 页面：点【扫码打印】⇒ **弹扫一扫**（JSAPI ✓ 不是跳外链 ✗）· 扫完 ⇒ **立刻出结果** ✓
      （她点下去**必须有即时反馈** ✓ 不许"点了没反应" ✗）
- **AC-SP8** 失败如实：没配 H5 可信域名 / 签名失败 / 队列离线 ⇒ **人话** ✓ **不当成功** ✗
- **AC-SP9** ≥44px ✓ 文案走配置 ✓ 工作台"不许说明书文字"守门保持绿 ✓
- **AC-SP10** 🔴 旧入口**不回归**：单个打印的「选择编号打印」＋「批量打印」照旧 ✓

## 四、写作用域（实现时）
- `server/src/routes/workbench.js`（**新**：`GET /api/workbench/lark/jsapi-signature` 一类 ⇒ 走既有鉴权闸门 ✓）
- `server/src/services/larkJsapiService.js`（**新**：access_token / jsapi_ticket / 签名 / 缓存 ⇒ 配置先行 ✓）
- `server/src/config/larkJsapi.js`（**新**：缓存时长 / 接口路径 / 文案键 ✓）
- `server/src/services/labelPrintService.js`（**加**：按记录 ID 精确一张 ⇒ **不动**既有 filters 语义 ✗）
- `server/public/workbench/features/labels/*`（客户端：`h5sdk.config` + 扫码 + 提交队列 ✓）
- 测试：`server/test/larkJsapiSign.test.js` + `server/test/scanToPrint.test.js`（**新** ✓）
- 🔴 **不碰**：打印队列既有接口语义 ✗ · 标签内容/尺寸/方向 ✗ · 电脑侧设备令牌接口 ✗

## 五、⚠️ 需要你/运维配合的一步（我会提前报你 ✓）
- 飞书开发者后台 ⇒ 网页应用 ⇒ **H5 可信域名** 里要有 `hm.bamamei.online` ✓（原本是"极易漏"的一步 ✓）
- ⚠️ 我**不会**去改后台配置 ✗ —— 到时我会把"要加哪一条、在哪个页面"写成一小步给你 ✓

## 六、实施落点（2026-10-14 夜 · 子代理 `label-scan-print` 落地 · **实施后补记**）

> 口径不变（她的 ⓐ + 她 2026-10-12 的二维码口径），下面只记"实际落在哪"与**与上面计划的偏差**。

| 要做的事 | 实际落点 |
|---|---|
| 签名接口 | `server/src/routes/workbench.js` 新增 `GET /lark/jsapi-signature`（挂在**既有** `requireWorkbenchAccess` 之后；响应 = `appId/timestamp/nonceStr/signature/url/jssdkUrl/jsApiList`，**无任何密钥**）；服务用既有 `services/larkJsapiService.js`（**单例复用** ⇒ ticket 缓存有效） |
| JSSDK 地址 | `server/src/config/larkJsapi.js` 新增 `jssdkUrl`（`LARK_JSAPI_JSSDK_URL` 可覆盖；默认 `…/lark/op/h5-js-sdk-1.5.22.js`）——**随签名响应下发**，页面不抄第二份 |
| 扫到的字符串 ⇒ 记录 ID | `server/src/services/labelPrintService.js` 新增 `parseLabelScanUrl`（**与 `buildLabelScanUrl` 一对反函数**；形状唯一真源仍是 `config/tagQrCode.js` 的 `SCAN_URL`） |
| 按记录 ID 精确一张 | `labelPrintService.labelForRecord(recordId)`（只读 `gateway.get('product', id)` 一条 → 编号 → 走**既有** `listLabels` → 精确筛到那一张）；`labelPrintQueueService.normalizeRequest/requestKeyOf/buildArtifact` **并列新增** `recordId` 一种 `single`（既有 `number` 语义一字未改） |
| 排进**既有**队列 | 页面 `POST /api/workbench/label-print/jobs`（**不新开打印接口** ✗）；`scan` = 扫到的字符串，解析在**服务端**做 |
| 页面 | 新增 `server/public/workbench/features/labels/scan-print.js`（`h5sdk.config` → `ready` → `tt.scanCode` → 提交；`runWriteAction` 保证"点了立刻置灰 + 换文案"）；挂在标签打印页（`features/labels/index.js`）＋ 入口那一格改成 `/workbench/label-print.html?scan=1`（进页面自动弹一次） |
| 文案 / 44px | `config/labelPrint.js#SCAN_PRINT.texts`（含旧码"重打新标签"的可操作人话）；`.scan-print-bar .btn { min-height: 44px }` |

### ⭐ 与上面计划的一处**偏差**（Lead 2026-10-14 夜裁决 ⓐ，依据在文件里）

- 计划第 3 行写的是"把 `record_id` 传给打印队列"，但当时 `buildLabelScanUrl(number)` 产出的是
  **`/s/{编号}`**（旧格式）⇒ 与 AC-SP4「扫到的内容 = `/r/{记录ID}`」自相矛盾。
- ⇒ 裁决：**把标签二维码改成 `/r/{记录 ID}`**（走 `SCAN_URL.recordIdTemplate`，record_id 取
  **接口读到的那一条**「货品信息」）；依据 = 她 2026-10-12 逐字「**新二维码一律
  `https://hm.bamamei.online/r/{recordId}`**（旧贴纸**重打**；`/s/{编号}` 路径保留但不再加功能）」＋
  「**不需要保持兼容**」（`docs/qr-record-id-and-js-2026-10-12.md`）。
- 影响：`labelPrintService` 的 `scan_url` 形状变了（拿不到记录 ID 时**退回 `/s/{编号}`** +
  `missing_qr_record_id` 计数 + warn ⇒ **不静默丢码**）；钉 `/s/` 的哨兵**成对翻新**（每条都写了
  "改前逐字 → 改后逐字 → 依据"）。
- **旧贴纸的实际影响**：扫到 `/s/…` ⇒ **人话拒绝**（"这是旧版二维码……请重新打印一张新标签再扫"），
  按她的口径**重打**即可。

### 🔴 运维那一步（**不是代码**）
- 飞书开发者后台 ⇒ 网页应用 ⇒ **安全设置 → H5 可信域名** 必须有 **`hm.bamamei.online`**
  （缺了的现象 = 页面点了没反应 / `h5sdk.config` 失败 ⇒ 我们有**人话**兜底，但功能不可用）。
- 本机/服务器**不需要**新增任何密钥：签名用的仍是 `LARK_AGENT_APP_ID` / `LARK_AGENT_APP_SECRET`。

---

## 🔴🔴 2026-10-15 真机排查：上线后"扫码打印点了没反应"的两个坑（**都已修**）

> 这一节是**当天真机事故的完整复盘**：现象 → 怎么定位 → 根因 → 修法 → 证据。
> 记它的价值在于：**飞书的报错信息会把我们带偏**，而正确的排查路径是可复用的。

### 现象
她在手机飞书点「货品 → 标签打印 → 去扫码打印」⇒ **相机不弹、页面只有一行小字**、服务端**一条日志都没有**。

### 怎么定位（这条路径很有用，值得复用）
1. **先让"看不见的失败"看得见**：给三步（`config` / `ready` / `scanCode`）**都加超时**
   ＋ 失败时**上报一条只读诊断**（`POST /api/workbench/labels/scan-report`，只 `logInfo`、不写业务表）
   ⇒ 客户端那一刻的 `phase`（精确子步骤）＋ 原因码＋ **飞书回的原始内容 `raw`** 才有地方落
   （⚠️ 手机上**开不了控制台**，这是唯一能拿到证据的口子）。
2. **`raw` 一击命中**：飞书客户端原生层回的其实**不是**空对象，而是
   ```json
   {"errno":"2601002","errorMessage":"signature is expired",
    "errString":"Authentication failed. signature is expired (error code: 333444)","errorCode":"333444"}
   ```
   （⚠️ 它**同时带 `errMsg`/`message` 的场合也有** —— 所以诊断要**既取已知字段、也把整个对象序列化**。）
3. **拿错误码 curl 官方文档**（**不用网搜**）：
   `https://open.feishu.cn/document/uYjL24iN/uAjMuAjMuAjM/errno.md?lang=zh-CN`
   ⇒ `333444 = 签名过期（签名有效期 10 分钟）`、`333443 = 签名重复`、`333445 = JSAPI 未授权`。
4. **再 curl 那篇参数文档**（错误码那页里有链接）：
   `https://open.feishu.cn/document/uYjL24iN/uQjMuQjMuQjM/authentication/h5sdkconfig.md?lang=zh-CN`

### 坑 ①（**真凶**）：`timestamp` 必须是**毫秒**
官方《h5sdk.config》参数表逐字：

> `timestamp` | long | 是 | 生成签名的**毫秒级**时间戳

我们改前用的是 **`Math.floor(now() / 1000)`（秒）** ⇒ 飞书按**毫秒**解读 ⇒ 时间落在 **1970 年**
⇒ 每次都判 **`333444 签名过期`** ✗。

⚠️ **为什么它极难查**：**服务器时钟零偏移、URL 正确、appId 与 access_token 同源、sha1 算法正确**
—— 四项排查项（官方 333441 那串）**全都过关**，错的只是**单位**。
⇒ **看到"过期/时间类"报错，先怀疑单位（秒 / 毫秒），再怀疑时钟。**

⚠️ 另一条同样重要：**签名串里用的 `timestamp` 必须与 `config` 里发出去的值是同一个**
（官方 333441 排查项逐字）⇒ 改单位时**两处一起改**，否则会从 `333444` 变成 `333441`。

**修法**：`larkJsapiService.signatureFor` 里 `const timestamp = now();`（毫秒）。

### 坑 ②（顺手挖出的同类隐患）：`jsapi_ticket` 的 TTL **不能写死**
线上实测飞书回的是 **`expire_in: 3844` 秒（≈64 分钟）**，而代码里写死 **110 分钟**
⇒ **后 46 分钟里算出来的签名都建在已过期的 ticket 上**（同样会被判过期）✗。

**修法**：TTL = **`expire_in − 5 分钟`**；飞书没回该字段才退回配置值（`LARK_JSAPI_TICKET_TTL_MS`）。

### 已排除的嫌疑（都留了证据，免得下次重走）
| 嫌疑 | 排除依据 |
|---|---|
| 服务器时钟偏移 | 服务器 `date -u` 与飞书 HTTP `Date` 头**逐秒一致**（`08:46:17Z` / `08:46:17Z`） |
| 我们算的签名不对 | 线上实测：`timestamp` = 当前时间、`url` 与页面 `location.href` 一致、`appId` 与取 token 同源 |
| URL 带了 `?scan=1` | 她按指引**用不带查询串**的页面重试 ⇒ **照样失败**（错误码一模一样） |
| H5 可信域名 / `jsApiList` | 域名早在白名单里；`jsApiList` 含 `scanCode`（`333445` 才对应用错 API，我们没有这个码） |
| JSSDK 版本 / API 名 | 把官方 SDK 源码拉下来核过：`scanCode` 是**正确**的 API 名，且 SDK 里**没有** `signature is expired` ⇒ 是**客户端原生层**判的 |

### 修完的真机证据（**端到端**）
```
17:11:34  label_print.job.enqueued   job_id=99f84def…  标签 T202-8|米色|B（1 张）
17:11:34  label_print.scan.report    {ok:true, phase:"done", reason:"enqueued"}
17:11:35  label_print.job.claimed    device_id="store-pc"
17:11:35  label_print.job.done       device_id="store-pc"  queue_ms=890
```

### ⚠️ 这条链路的**端限制**（官方文档）
`tt.scanCode` 支持**小程序**与**网页应用**；网页应用 **Android / iOS 需飞书 V3.44.0+**，
**PC 端「X」不支持** ⇒ **电脑飞书里永远扫不了**，别在那儿试。
