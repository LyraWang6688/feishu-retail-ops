# 销售异步链路 · 可重放浏览器 E2E

## 跑法

```bash
cd server/e2e
npm install
export E2E_OPEN_ID=<测试操作人的 open_id>
npm test
```

依赖：

- 本机 Google Chrome
- 仓库根 `.env` 指向测试 Base
- 默认端口 `5052`，可用 `E2E_PORT` 改

## 覆盖

1. 一单一货·现货·单支付
2. 一现货一预定·多支付（微信 + 现金）
3. 资金页重复点击（同一单只建一次）

## 断言

- 提交后直接到 `/workbench/`
- 工作台出现 toast，含销售单号
- 主表/明细/收款/库存按真实链路写入
- 重复点击不重复建单
