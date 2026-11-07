# 销售扫码草稿 ↔ 工作台「草稿单」联动（task-11，2026-10-29）

> 业务口径：扫码销售页上「本单已加 N 双、还没点提交」的那份东西是**本地中间态**，
> 工作台草稿箱**只读它、只清它**，**不写数据库 / 不写飞书 Base**。
> 另外（同日）「成功页整件退场、提交回执统一 toast」是**另一张卡**（`docs/submit-toast-unified-2026-10-29.md`），本卡不碰。

分支：`feat/scan-draft-order-box`（基于 `origin/main` `dd499d46`；不合并、不部署，等 review）。

---

## 一、数据从哪来（一份都不新造）

| 事实 | 依据 |
| --- | --- |
| 草稿唯一存储 = `server/data/scan_sessions/*.json` | `services/scanSessionService.js`（会话 id = `scan_session_<sha256(会话键)前16位>`） |
| 会话键 = `<openId>`（旧页面）或 `<openId>\|page\|<页面token>`（2026-10-18 起 per-page） | `routes/scanPage/pageToken.js` 的 `SESSION_KEY_SEPARATOR`；会话记录里的 `open_id` 字段就是这个键 |
| 已提交成功的单不出现在草稿箱 | `completeSale` 清空 `sale.lines` ⇒ 服务端"没有货行就不是草稿"天然过滤（判据反向钉住：AC-DB2） |
| 写中（半截提交）的草稿不能乱动 | 有 `master_record_id` / `order_no` / `detail_ids` / `payment_ids` / `submitPending` ⇒ 清掉会丢"主表已建"进度 ⇒ 重复建单 |

## 二、三种状态（全部由既有字段推出，不新造业务状态）

| 状态 | 判据 | 继续编辑 | 清空 |
| --- | --- | --- | --- |
| `draft` 未提交 | 有货行、无写库进度、未过期 | ✅ | ✅ |
| `in_flight` 写入未完成 | 有写库进度（或 `sale.status=submitted` 但仍有货行） | ❌ | ❌ |
| `expired` 已过期 | `expires_at` 过了 | ❌（过期后 revive 会按 24h `staleDraftMs` 静默丢行 ⇒ 给入口会误导） | ✅ |

## 三、接口（挂在既有 `requireWorkbenchAccess` 之后，不新开鉴权）

| 接口 | 行为 |
| --- | --- |
| `GET /api/workbench/sales/drafts` | 只列**当前登录用户**的、有货的草稿；返回 `draft_id`（会话 id）/ 状态 / 单号 / 货品×尺码 / 数量 / 总金额 / 最后更新（上海时间）/ `resumable` / `clearable` / `corrupt_count` |
| `POST /api/workbench/sales/drafts/clear` `{draftId}` | 只清**本地**那一份（复用 `sessions.clearSale`）；别人的 ⇒ 404（不泄露）；写中的 ⇒ 400 `draft_in_flight` |
| `GET /api/workbench/sales/drafts/:draftId/resume` | **浏览器直接导航**：下发该草稿**自己的** `scan_page_id` cookie（旧会话则清 cookie）→ 302 到 `/r/<首行货品记录ID>?from=sales` ⇒ 扫码页渲染**同一份**「本单 N 双」；token **不进 URL** |

**永不返回**：`open_id` / 会话键 / 页面 token / `master_record_id` —— `draft_id` 用会话 id（openId 的 sha256 前 16 位）；日志同样只记 `draft_id`。

## 四、代码落点

| 文件 | 作用 |
| --- | --- |
| `server/src/config/scanDraftBox.js`（新） | 开关 / 上限 / 三种状态的能力（可续/可清）/ 文案 / 错误码 —— **配置先行**（`SCAN_DRAFT_BOX_*`） |
| `server/src/utils/pageSessionKey.js`（新） | `openId\|page\|token` 会话键的**唯一解析处**（工作台与扫码页同一把尺子） |
| `server/src/services/scanDraftBoxService.js`（新） | 读模型（容错读目录 / 按人隔离 / 三态 / 金额·上海时间）+ 清空 + resume 目标 |
| `server/src/routes/workbenchSalesDrafts.js`（新） | 三条接口（express router；不装鉴权、不碰 Base） |
| `server/src/routes/workbench/sales.js` | 只加 1 处挂载（`options.scanSessions` 可注入） |
| `server/public/workbench/config/orders.js` | 草稿箱文案 + 接口（`ORDERS_DRAFTS` / `ORDERS_DRAFT_API`）；草稿单卡的 tag 改成「本地草稿」 |
| `server/public/workbench/features/orders/index.js` | 草稿箱三种态（加载/失败/空/有数据）+ 两张卡的【继续编辑】【清空】 |

## 五、验收（AC，先写后做）

- **AC-DB1** 列表只列"我的、有货、未提交"，字段齐全；别人的 / 空会话 / 已提交不出现；**不泄露身份与内部 id**。
- **AC-DB2** ⭐ 已提交成功的草稿不再出现（反向钉住 `completeSale` 清 lines 这件事）。
- **AC-DB3** 清空只清本地那一份：`lines` 清空，`completed[]` / 补货块 / 退货块一个字节不动；不新建存储。
- **AC-DB4** 写中的草稿：清空 400 拒绝、继续编辑也不给（清掉会丢进度 ⇒ 重复建单）。
- **AC-DB5** 过期草稿：只可清空、不可继续编辑。
- **AC-DB6** 按人隔离：拿别人的 draft_id ⇒ 404（与"不存在"同一个回答）。
- **AC-DB7** 坏 JSON 不许打崩整张草稿箱：只计数（`corrupt_count`）、**不删文件**、与"空列表"可区分。
- **AC-DB8** 继续编辑回同一份：目标 `/r/<记录ID>?from=sales`；per-page 会话取回 token、旧会话为空串。
- **AC-DR1…DR4**（路由层）：接口形状 / 清空 404·400 / resume 302+Set-Cookie / **鉴权继承 + 零 Base**（源码哨兵）。

## 六、证据（本地，2026-10-29）

```bash
cd server
node --require ./test/support/table-id-env.js --test --test-concurrency=1 test/*.test.js
# ℹ tests 2273 · pass 2272 · fail 0
node scripts/check-file-size.mjs            # 绿：0 条违规
node scripts/observability-events.mjs --check  # ✅ 457 事件最新
node test/e2e/draft-box-chrome.cjs          # 真实 Express + 本机 Google Chrome
```

Chrome（390×844 @2x，真点）：
1. 销售 → 订单列表 → 草稿单：**只列我自己的 2 份**（别人的 1 份 / 已提交 1 份 / 坏文件 1 份都不出现；坏文件只显示"有 1 份…已跳过"）
2. 【继续编辑】→ `/r/rec_draft_e2e?from=sales`，页面「本单：2 双」与草稿一致，`scan_page_id` cookie = 该草稿自己的 token ⇒ **同一份，没新建**
3. 【清空】→ 列表立刻只剩 1 份；磁盘上那份 `lines=[]`；**另一份草稿 2 行一个字节没动**；会话文件数不变（不新建/不删除）

- 截图：`reports/draft-box/{draft-list,draft-resume,draft-cleared}.png`
- 机器可读：`reports/draft-box/evidence.json`

## 七、没做 / 边界

- **不部署、不合并**（等 review）。
- 草稿箱只管**销售**草稿；补货/退货的本地暂存不在本卡（它们各自的入口仍按既有流程）。
- `POST /api/workbench/sales/retry` 与 per-page 会话的身份错位是**既有缺口**（本卡不修，已报 Lead 单开卡）。
- "草稿箱里清空"不与"扫码页上的清空本单"共用前端入口，但**共用同一个服务端清理方法**（`sessions.clearSale`）。
