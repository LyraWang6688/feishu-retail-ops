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
