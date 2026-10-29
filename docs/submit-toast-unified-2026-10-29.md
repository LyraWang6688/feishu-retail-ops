# 提交成功回执统一成 toast，成功页整件退场（2026-10-29）

> 业务负责人当次口径（逐字）：
> 「**数据提交成功，后台自动写入**，统一都是这个」
> ＋「以后就没有成功页了」

分支：`feat/submit-toast-unified`（基于 `origin/main` `dd499d46`；不合并、不部署，等 review）。

---

## 一、改前事实（先核代码，不凭印象）

| 链路 | 异步写库 | 提交后的落点（改前） |
| --- | --- | --- |
| 销售（资金页 `payment_pay`） | ✅ `salesAsync.enqueue` | **303 回工作台 + `?toast=`**（`handlers/payment.js:108-115`，2026-10-27 那一刀） |
| 补货（`replenish`） | ✅ `schedulePurchaseWrite` | ❌ **整页成功页** `sendSuccess`（`handlers/purchase.js:104`） |
| 采购退货（`return_purchase`） | ✅ `schedulePurchaseWrite` | ❌ **整页成功页** `sendSuccess`（`handlers/purchase.js:200`） |
| 采购多货（补货/退货 多货） | ✅ `scheduleCustomRest` | ❌ **整页成功页** `sendSuccess`（`flowHelpers.js:100`） |

⇒ 「异步」四条链都已实现，**只有销售**改成了工作台 toast；其余三条仍回一张"极简成功页"（配置 `config/scanSuccessPage.js`，被 5 个逐字节哨兵钉着）。

## 二、改后口径（唯一）

**任何一条提交链成功收下之后**：

1. 服务端 **303** 回 `/workbench/`；
2. URL 带 `?toast=<统一文案>`（＋ `done=<单号>` 仅作排查关联，**不在页面上显示**）；
3. 工作台已有的 `public/workbench/shared/toast.js` 显示 **5 秒** toast；
4. **成功页不再存在**（渲染器、配置、回跳字段全部删除）。

统一文案（唯一真源）：`server/src/config/submitToast.js`

```
数据提交成功，后台自动写入
```

## 三、实现（配置先行 + 共用件）

| 文件 | 作用 |
| --- | --- |
| `server/src/config/submitToast.js`（新） | 文案 / 落点 / 参数名 / 单号参数名 / 文案上限 —— **全部可配**（`SUBMIT_TOAST_TEXT` 等，见 `.env.example`） |
| `server/src/utils/submitToast.js`（新） | `submitToastQuery` / `submitToastUrl` / `redirectWithSubmitToast`（303 + `no-store`）。**任何提交入口都能 import**，调用方不写中文、不拼 URL |
| `handlers/payment.js` | 资金的异步那一按 + 4 个成功分支 ⇒ 共用件 |
| `handlers/purchase.js` | 补货 / 采购退货 ⇒ 共用件 |
| `handlers/salesSubmit.js` | 资金页渲染抛错时的兜底 ⇒ 共用件（不再退回成功页） |
| `flowHelpers.js` | 采购多货 ⇒ 共用件；删除 `sendSuccess` 定义/导出 |
| `routes/scanPage/renderContext.js` | 删除 `successReturnFields`（成功页回跳字段） |
| `views/scanPage/index.js` | 删除 `renderSaleSuccessPage` 与成功页专属分支；`renderScanMessagePage` 只画人话结果页 |
| `src/config/scanSuccessPage.js` | **删除** |
| `src/config/scanPage.js` | 删除 `SUCCESS_RETURN`；`done` 参数名改读 `submitToast.noticeKey`（唯一真源） |

**安全/边界**：落点只允许站内相对路径（跨站 / `//host` / 反斜杠 / 绝对 URL ⇒ 回落 `/workbench/`）；
文案超长截断不报错；单号只进 `done`，**不进 toast 文案**（她要求统一那一句）。

## 四、验收标准（先写后做，逐条对照）

- **AC-ST1** 统一文案 = `数据提交成功，后台自动写入`，只在 `config/submitToast.js` 一处是字面量；前端 toast 读同一个 `toast` 参数。
- **AC-ST2** 共用件：`303` + 落点 `/workbench/` + `no-store`；单号只进 `done`；文案可配/截断；**落点不许出站**。
- **AC-ST3** 四条链的成功落点都调 `redirectWithSubmitToast`（源码点名 payment / purchase×2 / flowHelpers / salesSubmit）。
- **AC-ST4** 成功页整件退场（反向哨兵）：`config/scanSuccessPage.js` 不存在、视图层无 `renderSaleSuccessPage`、上下文无 `successReturnFields`、路由层无 `sendSuccess(` ⇒ **塞回即红**。
- **AC-ST5** 旧成功页那句（`SCAN_PAGE.saleSuccess.message`）**保留**给工作台「验收回执」用（那是另一个界面），但**不许**再当提交回执。
- 行为面：`test/purchaseAsyncAcceptance.test.js`（补货/退货）、`test/multiItemOrder*.test.js`（多货）、`test/scanSalePaymentStepPay.test.js`（销售）、`test/scanPurchaseReturn.test.js` 等改成断言 **303 + toast**（不再是 200 + 成功页 HTML）。

## 五、证据（本地，2026-10-29）

```bash
cd server
node --require ./test/support/table-id-env.js --test --test-concurrency=1 test/*.test.js
# ℹ tests 2236 · pass 2235 · fail 0
node scripts/check-file-size.mjs          # 绿：0 条违规
node scripts/observability-events.mjs --check  # ✅ 457 个事件，目录最新（本刀未新增事件名）
node test/e2e/submit-toast-chrome.cjs     # 真实 Express + 本机 Google Chrome（channel: chrome）
```

Chrome 四条链（每条都是**从扫码页上的原生表单真的提交** ⇒ 浏览器跟随 303 ⇒ 工作台 toast）：

| 链 | 落点 | toast |
| --- | --- | --- |
| 补货 | `/workbench/` | 数据提交成功，后台自动写入 |
| 采购退货 | `/workbench/` | 数据提交成功，后台自动写入 |
| 采购多货 | `/workbench/` | 数据提交成功，后台自动写入 |
| 销售（资金页异步那一按） | `/workbench/` | 数据提交成功，后台自动写入 |

- 截图：`reports/submit-toast/{replenish,purchase-return,multi-item,sales-payment}.png`（390×844 @2x）
- 机器可读证据：`reports/submit-toast/evidence.json`
- 服务端侧证：后台排程 2 次（补货/退货）· custom 1 次（多货，执行后引擎 `submitDraft` 真被调）· 销售异步入队 1 次。

## 六、没做的 / 边界

- **不部署、不合并**（等业务负责人当次指令）；本分支只等 review。
- 验收链路（工作台「验收到货」）的**回执文案**仍用 `SCAN_PAGE.saleSuccess.message`（那是工作台内的回执正文，不是提交页）；
  如果她也要统一成同一句，单开一刀（不动本轮范围）。
- 成功页退场后，**提交那一刻页面上不再显示单号**（她已明确「统一都是这个」——单号在订单列表里看）。
- 四条链的"异步写库失败可查/可重试"判据**一条没删**（`scan.*.background_failed` ＋ 会话 `last_error` 相关用例全绿）。
