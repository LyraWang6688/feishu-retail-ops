# 扫码页重构方案：先拆 scanWriteService，再拆 scanPage/index.js

> 2026-11-08 制定。对应 issue：[#952](https://github.com/LyraWang6688/feishu-retail-ops/issues/952)。
>
> 本文只记录拆分方案，不代表代码已拆；当前只做设计与后续施工约束。

## 1. 现状

```text
server/src/routes/scanPage/index.js
  总行数：约 1785
  其中注释：约 890
  实际代码：约 838

server/src/services/scanWriteService.js
  总行数：约 1731
  其中注释：约 579
  实际代码：约 1104
```

行数不是唯一问题。真正的问题是：

- `scanPage/index.js` 里闭包共享上下文多，页面渲染、鉴权、路由、action 分发混在一起；
- `scanWriteService.js` 一个工厂同时承担销售、补货、采购退货、草稿、结算、幂等；
- 改一处容易碰别的链路，review 成本和测试成本都高；
- 新人/AI 很难快速判断某段逻辑属于哪个域。

已有的部分拆分：

```text
routes/scanPage/handlers/   已有 salesSubmit / payment / purchase / smallActions
routes/scanPage/flowHelpers.js / pageToken.js / responses.js / renderContext.js
services/scanWriteService.js 仍是大工厂
```

## 2. 目标形态

### 2.1 路由

```text
routes/scanPage/index.js        < 400 行
routes/scanPage/middleware/
  auth.js                       扫码登录重定向、白名单
  pageContext.js                openId、sessionId、scanTarget、backTarget
  pageToken.js                  保留/薄封装
routes/scanPage/pages/
  recordPage.js                 GET /r/:id
  realmPage.js                  GET /s 等领域入口
routes/scanPage/actionDispatch.js POST action 分发
routes/scanPage/handlers/
  salesSubmit.js / payment.js / purchase.js / smallActions.js
```

`index.js` 最后只保留：

```js
router.use(auth)
router.use(pageToken)
router.get(...)
router.post(...)
```

### 2.2 写库服务

```text
services/scanWriteService.js    < 200 行：只做组合与对外 API
services/scanWrite/
  helpers.js                    schema 字段、金额、幂等键、fail
  session.js                    addSaleLine / saveDraftLines / clearDraft
  sales.js                      submitSale + 金额结算
  replenish.js                  submitReplenish
  purchaseReturn.js             submitPurchaseReturn
```

对外 API 一个字不变：

```js
{
  sessions,
  addSaleLine,
  clearDraft,
  saveDraftLines,
  submitSale,
  submitReplenish,
  submitPurchaseReturn,
  ...
}
```

## 3. 拆分顺序

### 第 1 步：公共工具

先搬不依赖闭包的纯函数：

```text
fieldOf
positiveAmount
toCents
moneyText
amountMismatchMessage
positiveInteger
amountList
sessionKeyOf
```

落到：

```text
services/scanWrite/helpers.js
```

风险最低，测试只需保证 import 路径和函数行为不变。

### 第 2 步：草稿/会话

把：

```text
addSaleLine
clearDraft
saveDraftLines
```

搬到：

```text
services/scanWrite/session.js
```

依赖注入：

```js
createScanWriteSession({
  queue,
  sessions,
  config,
  logInfo,
});
```

`scanWriteService.js` 只负责组装 `sessions` 对象与对外暴露。

### 第 3 步：销售提交

把：

```text
submitSale
结算校验
销售主表/明细/收款/库存编排
```

搬到：

```text
services/scanWrite/sales.js
```

`amountMismatchMessage`、`positiveAmount` 等从 helpers 引入。

这一步最关键，因为 `submitSale` 很长。原则：

```text
只搬函数，不改逻辑
不改返回结构
不改幂等键
不改日志事件名/字段
```

### 第 4 步：补货 / 采购退货

分别搬到：

```text
services/scanWrite/replenish.js
services/scanWrite/purchaseReturn.js
```

这三个域互不依赖，拆完 `scanWriteService.js` 只剩组合。

### 第 5 步：再拆路由

按职责搬：

```text
middleware/auth.js
middleware/pageContext.js
pages/recordPage.js
pages/realmPage.js
actionDispatch.js
```

`index.js` 最后只保留中间件注册和路由表。

## 4. 依赖与约束

### 4.1 不改行为

每一步都是 **move-only**：

```text
逻辑不改
字段名不改
返回结构不改
幂等键不改
日志事件名/字段不改
```

### 4.2 依赖注入

不要在模块里直接 require 大工厂：

```js
// 反例
const scanWriteService = require('../scanWriteService');

// 正例
createScanWriteSales({ queue, sessions, salesAsync, config, logInfo });
```

### 4.3 上下文对象

`scanPage/index.js` 的闭包上下文先抽成显式对象：

```js
createPageContext({ req, openId, sessionKey, config });
```

避免把闭包一起搬走导致隐式依赖。

### 4.4 源码哨兵

仓库里有测试通过源码路径/调用点数做守门。拆文件后：

```text
同步更新测试中的路径
不放宽判据
不删反向哨兵
```

## 5. 测试策略

每一步都按“行为不变”做：

```text
1. 先跑现有全量测试，记录基线
2. 搬一个模块
3. 跑全量 + e2e
4. 跑真实测试 Base 的销售/补货/退货关键链路
5. 对比日志事件和返回结构
```

重点回归：

```text
销售：一单一双 / 一单多双 / 分笔支付 / 金额不等拦截
补货：提交 / 幂等
退货：提交 / 库存回门盒
验收：扫码验收 / 工作台验收
会话：加货 / 清空 / 刷新恢复
```

## 6. 风险

```text
scanPage/index.js 大量闭包共享上下文
→ 先抽 createXxxContext()，不要直接剪切

scanWriteService 里 queue / sessions / salesAsync 互相引用
→ 依赖注入，不要全局变量

源码哨兵会数调用点
→ 拆文件后同步更新测试

大文件 gate
→ 拆完文件要同步 size baseline，不能为了过门禁放宽规则
```

## 7. 节奏

```text
先拆 scanWriteService
→ 再拆 scanPage/index.js
→ 一次只拆一个域
→ 每个 PR 独立可回滚
```

不要在真实端到端测试期间动；不要和业务功能 PR 混在一起。

## 8. 验收标准

```text
1. scanWriteService.js < 200 行，只做 facade 组合
2. services/scanWrite/ 下按域拆分，单文件职责单一
3. scanPage/index.js < 400 行，只做中间件 + 路由注册 + 分发
4. 对外 API 不变
5. 全量测试 + e2e 通过
6. 真实测试 Base 销售/补货/退货/验收回归通过
7. 日志事件名/字段不变
8. size baseline 同步且不放宽
```

## 9. 非目标

- 不改业务逻辑；
- 不改表结构；
- 不改 UI；
- 不部署；
- 不在本重构里顺带修 bug。
