# 测试 Base「收款方式管理」补「团购券管理」列 —— 留档（2026-10-16）

> 任务来源：解开券机制（#704 已合）的**真机端到端验收** —— 它卡在**测试 Base 缺这一列** ✗
> 她的规则（逐字）：「**测试 Base …… 可以随便写，不用问她**」✓ ⇒ 测试 Base 就是拿来造的 ✓
> 对应脚本：`server/scripts/test-base-add-voucher-column.mjs`（**只从 env 读凭证** ✗ 不硬编码 ✓ · **不用飞书 CLI** ✓ 走官方 SDK）

## 1. 生产真表那列的属性 —— ⚠️ **本机核不了**（如实）
- **本机 `.env` 按 AGENTS §8 刻意不放生产凭证** ⇒ **生产 Base 在本机物理上够不着** ✓（这正是那条纪律的目的）
- ⇒ 本文件**照抄** Lead 给的**只读核对结果**（来源标注 ✓ 不是我自己核的）：
  · 名字 `团购券管理` · type `21`（关联字段）· `property.table_id = tblz2kM1CIGkcWsM`
- 🔴 **我没有试图获取生产凭证** ✓（红线）

## 2. 测试 Base **建列前**的只读回读（项目代码 / SDK，`--check-only` ⇒ 0 写入 ✓）
```
✓ 闸门通过：FEISHU_TARGET_ENV=test · app_token = 授权测试 Base ✓
· 目标表（收款方式管理）tableId = tblNg7yInC6pNLJR
[info]: [ 'client ready' ]
· 回读（建之前）：共 3 列；**没有**「团购券管理」✗
```
⇒ **确认：测试 Base 确实缺这一列** ✓（这也正是两份 PR 如实标的那条 D1 ✓）

## 3. 建列尝试 ⇒ **失败**（如实贴错误 ✓ 不假装成功 ✗）
```
飞书回 400 · code 1254092 · DuplexLinkFieldPropertyError
log_id: 20261016063651152A54EBDEB71E17C472
method_id: 6965347212289376258
```
- 我提交的 `property` 只有 `{ table_id: 'tblz2kM1CIGkcWsM' }` ⇒ **双向关联（duplex link）还需要更多字段** ✗
- ⇒ **列没有建成**；**再回读仍是 3 列、仍没有「团购券管理」** ✗（独立进程复读，证据同上 ✓）
- **下一步（建议）**：拿**生产真表那一列的完整 `property`**（`appTableField.list` 的**原样返回**）来建 ——
  ⚠️ 那一步**需要在能读生产的机器上**做（服务器 / 或让业务负责人贴那一列的 `property` 全文 ✓），
  **本机够不着生产** ✗ ⇒ 因此**这一步我做不了**，如实交接 ✓

## 4. 闸门（防生产）—— 代码行（`server/scripts/test-base-add-voucher-column.mjs`）
```js
if (targetEnv !== 'test') fail(...)                      // ① 环境标记必须是 test
if (!testBase) fail(...)                                 // ② 取不到授权测试 Base ⇒ 拒绝
if (appToken !== testBase) fail(...)                     // ③ ⭐ 不等于授权测试 Base ⇒ 拒绝（保守闸门）
if (forbidden.includes(appToken)) fail(...)              // ④ 命中禁写清单（生产）⇒ 拒绝
if (!forbidden.length) say('⚠️ warn：禁写清单空转…')      // ⑤ 没配清单 ⇒ **如实 warn**（不是只写注释 ✓）
```
✅ **实测有效**：不带 env 直接跑 ⇒ 第 ① 条当场拒绝 ✓（见运行记录）
⚠️ 本机 `.env` 没有 `FEISHU_V1_FORBIDDEN_APP_TOKENS`（AGENTS §8 刻意如此）⇒ 第 ④ 条**空转**，
但 第 ③ 条（**必须等于授权测试 Base**）是**实拦** ✓ —— 两道合起来仍拦住"写生产" ✓

## 5. 券的真机 e2e —— **没跑**（如实）
- 前置（测试 Base 有那一列）**没满足**（第 3 节）⇒ e2e **不成立** ✗
- ⇒ 需要：① 先按第 3 节的建议把列建成 ② 再跑券的端到端（`scanMoneyPageTwoStepVerify` / 券相关那条）
- 🔴 **不伪造**、不把"没跑"写成"通过" ✗

## 6. 未做项（如实）
- ① 生产那列的属性：**本机核不了**（无生产凭证，按纪律 ✓）⇒ 用 Lead 给的记录
- ③ 建列：**失败**（`DuplexLinkFieldPropertyError`）⇒ **列仍未建成**
- ⑤ e2e：**没跑**（前置未满足）
- ⚠️ 本刀**没有**碰 `server/src/**` ✓ · **没碰生产** ✓ · 未部署 ✓ · 未用飞书 CLI ✓
