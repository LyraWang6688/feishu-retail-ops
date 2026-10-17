# ④ 支「17 个被删 test()」逐条分类 ＋ 成对迁移台账（2026-10-17）

> 基线：分支 `chore/no-switch-34`（worktree `.local/switch-34`）· 对照 `main` = `b7c598b8`
> 性质：**只读核对 ＋ 补台账**。判据**不删 / 不 skip / 不放宽**（AGENTS.md §4 红线）。
> 结论先行：**10 条 test() 全部是「行为判据迁移」，0 条是「开关时代删得对」的纯删除**；
> 另有 7 行是**被删 test 体内的 `.test()` 正则断言**，不是独立用例（见 §1 口径）。

---

## 1. 「17」是怎么来的（口径先对齐）

| 计数方式 | 数量 |
|---|---|
| **`test()` 声明被删** | **10** |
| 被删 test 体内的 `.test()` 正则断言行 | **7** |
| 宽松 grep（`^-.*\b(test\|it)\s*\(`）合计 | **17** |

⇒ **分类对象是 10 条 `test()`**；那 7 行是它们**体内**的断言，随所属用例一起迁移，不单独分类。

复现命令：
```bash
cd .local/switch-34
git diff main...HEAD | grep -cE '^-.*\b(test|it)\s*\('          # 17
git diff main...HEAD -- 'server/test/*.js' | grep -E '^-\s*test\(' | wc -l   # 10
```

---

## 2. 分类总表（10 条）

> **迁移类型**：`反向哨兵` = 钉"开关不许回来"；`正向钉` = 钉"永远开"的新行为；`混合` = 两者都有。
> **「删得对」列** = 该用例里**只对开关本身有意义**的断言（开关不存在后无对象可测）——这部分**正确删除**，不是判据被放宽。

| # | 旧用例（`main:行`） | 新用例（HEAD:行） | 迁移类型 | 「删得对」的部分 | 依据 |
|---|---|---|---|---|---|
| 1 | `AC-MSG1` `saleMoneySplitGoodsHalf.test.js:232` | 同文件 `:232` | 混合 | `readFlag` 语义逐条（`''`/`'false'`/`'0'` ⇒ 关、认不出 ⇒ 抛） | 她 2026-10-16 22:5x |
| 2 | `AC-MSW1` `saleMoneySplitWire.test.js:37` | 同文件 `:39` | 混合 | 「闸门必须是 `=== true`」＋「缺省 `false`」 | 同上 |
| 3 | `AC-MSW3` `saleMoneySplitWire.test.js:60` | 同文件 `:72` | **方向反转** | 「`.env.example` **必须登记**该键」⇒ 反转为「**必须已删**」 | 同上 |
| 4 | `AC-MS-P2` `scanSuccessPageMinimal.test.js:97` | 同文件 `:98` | 正向钉 | 「开关关着 ⇒ **老样子**（回跳链接 / refresh / 原句）都还在」 | 同上 |
| 5 | `AC-MS-P3` `scanSuccessPageMinimal.test.js:111` | 同文件 `:122`（＋新增 `P3b:142`） | 反向哨兵 | `readFlag(env, 'SCAN_SUCCESS_PAGE_MINIMAL_ENABLED', false)` 那条断言 | 同上 |
| 6 | `AC-SP0` `successPageFourChains.test.js:117` | 同文件 `:121` | 正向钉 | `assert.equal(SCAN_SUCCESS_PAGE.minimalEnabled, true)` | 同上 |
| 7 | `AC-SP3` `successPageFourChains.test.js:260` | 同文件 `:267` | 反向哨兵 | 「空串 = 关」这类 `readFlag` 语义 | 同上 |
| 8 | `AC-REG2` `successPageZeroRegression.test.js:46` | 同文件 `:59` | 反向哨兵 | `minimalEnabled === false`（缺省关） | 同上 |
| 9 | `AC-REG1` `successPageZeroRegression.test.js:53` | 同文件 `:73` | 正向钉 | 「**开关关着**」这个前置条件本身 | 同上 ＋ 她 23:5x「那我肯定能看到这个单号呀」 |
| 10 | `AC-REG3` `successPageZeroRegression.test.js:71` | 同文件 `:89` | 正向钉（探针） | 「**开关开着**」这个对照臂 | 同上 |

**统计**：反向哨兵 4 · 正向钉 4 · 混合 2 · 方向反转 1（#3 计入反向哨兵家族）· 纯删除 **0**。

---

## 3. 逐条「改前逐字 → 改后逐字 → 依据」

> 以下引文均来自 HEAD 代码里的成对迁移注释（已逐条实读）；**未改动任何判据**。

### #1 AC-MSG1 · `saleMoneySplitGoodsHalf.test.js:232`
- **改前逐字**：`test('AC-MSG1 ⭐ 开关 \`SCAN_MONEY_SPLIT_ENABLED\`：**缺省 false** ＋ **显式布尔** ＋ 调用时读', …)`
- **改后逐字**：`test('AC-MSG1 ⭐⭐ 反向哨兵：**没有开关了**（货/钱分离永远开 ✓）＋ 会话标记逐字', …)`
  钉：配置源码里**无**开关名 / `ENABLED_ENV_KEY` / `readFlag`；`resolveSaleMoneySplitConfig()` 里**没有** `enabled`；**塞同名 env 也无效**；会话标记 `goods_created` 与 `pending`/`created` **不同**且不随 env 变。
- **依据**：业务负责人 2026-10-16 22:5x 逐字「**把新功能都上了，不需要开关。**」（`docs/no-switch-rule-2026-10-16.md`）

### #2 AC-MSW1 · `saleMoneySplitWire.test.js:39`
- **改前逐字**：`test('AC-MSW1 ⭐ 开关关着 ⇒ 一个字节都不走新路（缺省 false ＋ 闸门必须是 \`=== true\`）', …)`
- **改后逐字**：`test('AC-MSW1 ⭐⭐ 反向哨兵：**没有开关了**（货/钱分离永远开 · 老分支删净 ✓）', …)`
  钉：配置里无开关名/变量名/`readFlag`；**路由里 `resolveSaleMoneySplitConfig` 一个都不剩**（闸门与配置入口都删净）；且 `deferFunds: true` 那段**照旧要走**。
- **依据**：同上。⚠️ 迁移注释里写明「锚点成对迁移」——改前锚闸门那行，改后锚 `deferFunds: true`。

### #3 AC-MSW3 · `saleMoneySplitWire.test.js:72`（**方向反转**）
- **改前逐字**：`assert.ok(/^SCAN_MONEY_SPLIT_ENABLED=false$/m.test(env), '`.env.example` 必须登记 …')`
- **改后逐字**：`assert.equal(new RegExp('^' + SWITCH_NAME + '=', 'm').test(env), false, '🔴 `.env.example` 里那一行必须已删 …')`
- **依据**：同上。⚠️ 同注释写明：**线上 `.env` 那几行不动**（部署之外的事）。

### #4 AC-MS-P2 · `scanSuccessPageMinimal.test.js:98`
- **改前逐字**：`test('AC-MS-P2 ⭐⭐ 零回归：开关关着（缺省）⇒ 成功页形状逐字不变', …)`
  （渲染两路逐字相同 ＋ 断言「那颗链接 / refresh / 她给的原句**都还在**」）
- **改后逐字**：`test('AC-MS-P2 ⭐⭐ 迁移后：**成功页永远极简**（没有开关 ✓ 只剩一条路 ✓）', …)`
  钉：默认渲染 ＝ 显式配极简（**逐字**）；零链接 / 零跳转 / 零 button；统一那一句；**塞哨兵正文后页面逐字不变**（原句不再决定这一页）。
- **依据**：同上。注释明确「**强度不降**：仍是整页逐字 ＋ 行为断言」。

### #5 AC-MS-P3 · `scanSuccessPageMinimal.test.js:122`
- **改前逐字**：`assert.ok(/readFlag\(env, 'SCAN_SUCCESS_PAGE_MINIMAL_ENABLED', false\)/.test(src), '开关必须是 readFlag …')`
- **改后逐字**：`test('AC-MS-P3 ⭐⭐ 反向哨兵：**没有开关了**（开关名/`readFlag` 回来即红 ✓）＋ 禁 `||` 兜底', …)`
  ＋ 新增 `AC-MS-P3b ⭐⭐ 正向钉：**没有任何开关也能生效**（极简覆盖值永远返回 ✓）`
- **依据**：同上。

### #6 AC-SP0 · `successPageFourChains.test.js:121`
- **改前逐字**：`test('AC-SP0 ⭐ 前置：开关读到 env=true（否则下面全是空跑 ✗）', …)`（`assert.equal(SCAN_SUCCESS_PAGE.minimalEnabled, true)`）
- **改后逐字**：`test('AC-SP0 ⭐ 前置：**开关已退场**，成功页不靠 env 也永远极简（否则下面全是空跑 ✗）', …)`
- **依据**：同上。

### #7 AC-SP3 · `successPageFourChains.test.js:267`
- **改前逐字**：`test('AC-SP3 🔴 开关 = 显式布尔（`readFlag`）：空串 = 关 · 源码里**不许** `||` 兜底', …)`
- **改后逐字**：`test('AC-SP3 ⭐⭐ 反向哨兵：**开关已退场**（成功页永远极简）＋ 源码里**不许** `||` 兜底', …)`
  钉：开关名不许回、**禁 `||` 兜底继续成立**、极简覆盖值**永远返回**。
- **依据**：同上。
- ⚠️ **同名不同义**：`test/larkJsapiSign.test.js:63` 也有一个 `AC-SP3`（ticket/TTL 缓存）。两处**不同文件、不同义**，本次未改名（改动会波及既有判据）；**登记为低危观察项**。

### #8 AC-REG2 · `successPageZeroRegression.test.js:59`
- **改前逐字**：`test('AC-REG2 ⭐ 缺省 = **关**（没设 env ⇒ `minimalEnabled === false`）', …)`
- **改后逐字**：`test('AC-REG2 ⭐⭐ 反向哨兵：**开关已退场**（配置里不许再有它 ✓）', …)`
- **依据**：同上。

### #9 AC-REG1 · `successPageZeroRegression.test.js:73`
- **改前逐字**：`test('AC-REG1 ⭐⭐ 开关关着 ⇒ 三条链成功页**与改前逐字节一致**（全字节 sha256 ✓）', …)`
  基线：`sha256 = 82858f52…` / `108,615` 字节。
- **改后逐字**：`test('AC-REG1 ⭐⭐ 成功页**永远极简** ⇒ 三条链**逐字节**（全字节 sha256 ✓）＋ **零 offender**', …)`
  基线：**两次留痕** —— ① 删开关 ⇒ `530a91fb…` / `107,528` 字节；② 成功页多一行单号 ⇒ **`10b943e3…` / `107,618` 字节（+90 字节）**。
- **依据**：① 同上（22:5x 不需要开关）；② 她 2026-10-16 23:5x 逐字「**那我肯定能看到这个单号呀**」。
- ⚠️ 纪律：**只有"她看到的样子"变了才动基线**；sha **与**字节数**两个都还在钉**，未换弱形式。

### #10 AC-REG3 · `successPageZeroRegression.test.js:89`
- **改前逐字**：`test('AC-REG3 ⭐ 探针：开关**开着** ⇒ 同一个 sha **必须不同** ＋ 零 offender（AC-REG1 不是空跑 ✓）', …)`
- **改后逐字**：`test('AC-REG3 ⭐⭐ 探针：**没有任何开关**也照样极简（老那几样"要她跳走"的东西被清掉 ✓）', …)`
  钉：**不传任何 `successPage`** ⇒ 已极简；"显式配"路与默认路**逐字节相同**（只剩一条路）；**非成功页不套用**极简。
- **依据**：同上。

---

## 4. 那 7 行 `.test()` 正则断言（随所属用例迁移，不单独分类）

| # | 被删行（断言） | 所属用例 |
|---|---|---|
| 1 | `assert.ok(/resolveSaleMoneySplitConfig\(\)\.enabled === true[\s\S]{0,600}?deferFunds: true/.test(text), …)` | AC-MSW1 |
| 2 | `assert.ok(/readFlag\(env, ENABLED_ENV_KEY, false\)/.test(cfg), '缺省必须是 `false` ✗')` | AC-MSW1 |
| 3 | `assert.ok(/enabled === true/.test(wireBlock()), '闸门必须是**显式** `=== true` …')` | AC-MSW1 |
| 4 | `assert.ok(/^SCAN_MONEY_SPLIT_ENABLED=false$/m.test(env), …)` | AC-MSW3 |
| 5 | `assert.equal(/您的提交已成功\|明细：\d+ 双\|接着扫下一款/.test(doneHtml), false, …)` | AC-MS-P2 |
| 6 | `assert.ok(/readFlag\(env, 'SCAN_SUCCESS_PAGE_MINIMAL_ENABLED', false\)/.test(src), …)` | AC-MS-P3 |
| 7 | `assert.equal(/\|\|/.test(line), false, '🔴 禁 `\|\|` 兜底 …')` | AC-SP3 |

**判定**：全部随所属用例**成对迁移**（新用例里都能找到对应/更强的新钉法），**没有一条是"悄悄消失"**。

---

## 5. 强度核验（有没有悄悄放宽）

| 用例 | 迁移后最硬的钉子 | 判定 |
|---|---|---|
| AC-MSG1 | 源码级禁开关名/变量名/`readFlag` ＋ 塞 env 无效 ＋ 标记互异 | 不降 |
| AC-MSW1 | 路由**整文件**不许出现配置入口 ＋ `deferFunds` 段照跑 | 不降（比原来更宽扫） |
| AC-MSW3 | `.env.example` 反向断言 | 等价（方向反转） |
| AC-MS-P2 | **两路渲染逐字相等** ＋ 哨兵正文不影响 ＋ 零链接/按钮 | 不降 |
| AC-MS-P3 | 反向哨兵 ＋ `||` 禁令 ＋ 新增 `P3b` 正向钉 | 不降（新增一条） |
| AC-SP0 | 前置改成"开关已退场"，未弱化 | 不降 |
| AC-SP3 | 反向哨兵 ＋ `||` 禁令 ＋ 覆盖值永远返回 | 不降 |
| AC-REG1 | **全字节 sha256 ＋ 字节数** 双钉 ＋ 零 offender | 不降（基线换值有台账） |
| AC-REG2 | 配置里不许有 `minimalEnabled` | 不降 |
| AC-REG3 | 探针：默认路 ≡ 显式路；非成功页不套用 | 不降 |

---

## 6. 观察项（不阻塞，只登记）

1. **`AC-SP3` 编号在两个文件里代表两件事**（成功页开关 vs JSAPI ticket 缓存）。同文件内不冲突，但跨文件检索会混。改名会波及既有判据 ⇒ **本次不动**，建议后续单独一刀。
2. **AC-REG1 的基线下调过一次、再变动一次**（删开关、加单号），两处都留了「改前逐字 → 改后逐字 → 依据」；符合 `docs/frozen-sha-pin-rule-2026-10-16.md` 的"台账式哨兵"要求。
3. 本文件只做**核对与记账**，未改任何判据、未改任何 `src/**`。

---

*登记：`docs/README.md` §1 现行事实。*
