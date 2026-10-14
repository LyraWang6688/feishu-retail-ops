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
| 1 | ⭐ **服务端 JSAPI 签名接口**：`access_token → jsapi_ticket → signature` | 用**既有** app 凭证（服务端 env ✓）· **不写死任何密钥** ✗ · 带上 `appId` `timestamp` `nonceStr` `url` ✓ · **缓存 ticket**（有效期 2h ✓ 可配 ✓） |
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
