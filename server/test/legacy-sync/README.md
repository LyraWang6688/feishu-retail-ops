# 旧同步销售链路测试（已退役，不参与 `test/*.test.js`）

这些用例断言的是**已删除的同步销售链路**：

- 货品页提交时同步建销售主表
- 资金页提交后同步写明细/收款/库存并渲染成功页
- `masterOnly` / `oneShot` / `deferFunds` 等旧写计划参数
- 旧成功页与旧销售首页回跳

2026-10-27 起销售只走异步链路（`salesAsyncWorker`），上述行为已不存在，因此这些文件从默认测试入口移出，保留作历史对照。

新链路的覆盖在：

- `test/salesPayload.test.js`
- `test/salesOrderNoCache.test.js`
- `test/salesAsyncWorker.test.js`
- `test/scanSubmitNoNativeFallback.test.js`
- 浏览器 E2E：测试 Base 手工验收记录（见交付说明）

⚠️ 不应把它们直接恢复进默认入口；若要恢复，必须先按异步链路重写断言。
