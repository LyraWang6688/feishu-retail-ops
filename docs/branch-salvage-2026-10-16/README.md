# A 档 worktree 留档（2026-10-16 · 业务负责人点头"先把 A 档的给删除吧"）

> **为什么留档**：她 2026-10-16 追问「这么多未提交，是不是一些功能你重复做了呢」⇒ 我核出 16 个有未合提交的
> ⇒ 其中 **7 个是「重复 / 已被取代」**（功能都已在 main ✓）⇒ 她点头 **先删 A 档** ✓
> 🔴 按本仓规矩（`docs/worktree-cleanup-rule-2026-10-16.md` 第 4 条）：**清之前先把 diff 留档** ✓ **绝不无声丢代码** ✗

## 这 7 个是什么 · 为什么判"重复/被取代"

| worktree | 它的活 | main 里的对应 | 判定 |
| --- | --- | --- | --- |
| `replenish-trim` | 补货页三处 ＋ 尺码清单「一行 3 组」 | **已合**（那三处已上线，她截图验过 ✓） | 重复 |
| `replenish-e` | 补货特殊尺码默认不勾 ＋ 按钮文案「生成报货订单」 | **被取代**（她后来把按钮定成「补货」✓） | 被取代 |
| `skipmin` | 成功页统一极简 ＋ 资金页三处提示全删 | **已合**（已上线 ✓） | 重复 |
| `voucher` | 券三条口径（差额按面值/明细按结算款/待平台结算） | **已合**（已上线 ✓） | 重复 |
| `vcol` | 测试 Base 补「团购券管理」列脚本 | **已合**（含改名修 CI ✓） | 重复 |
| `scan-accept-speed` | 验收分阶段耗时打点 | **大概重复**（落点日志＋打点已合 ✓） | 大概重复 |
| `scan-accessory` | 六格顺序（销售·补货·库存/标签·上新·配品）＋配品页 | **旧方案**（她后来定的是五格：…＋扫一扫 ✓） | 旧方案 |

## 每个的 patch 在同目录下（`<worktree>.patch`）—— 万一将来要回看，这里能查到 ✓

---

## ⚠️ 2026-10-16 一条如实记录：B 档 5 个 patch **未能入库**（我的操作失误 ✗）

- **事实**：B 档那 5 个（`skelretry` / `rowseize` / `qr-batch` / `texts-webhook2` / `pay-legacy`）的 worktree 与分支
  已按她"可以清掉"删掉 ✓；但承载"5 份 patch 留档"的那个 PR（#743）**在合并前冲突** ✗，
  而我修冲突时**误用 `push -f` 把它覆盖成了 main** ✗ ⇒ ⭐ **这 5 份 patch 没能入库** ✗
- **影响面（如实）**：**丢的是"冗余存档"，不是代码** ✓ —— 这 5 个分支的改动**逐个核过**：
  `skelretry` / `rowseize` / `qr-batch` / `texts-webhook2` 的功能**都已在 main** ✓；`pay-legacy` 是**废稿** ✓
  ⇒ 所以**没有任何未合并的功能因此丢失** ✓
- **A 档 7 份 patch 不受影响** ✓（#742 已合 ✓ 在 `docs/branch-salvage-2026-10-16/` 里 ✓）
- **教训（已写进 `docs/worktree-cleanup-rule-2026-10-16.md` 的思路）**：🔴 **修冲突时一律 `merge`，不许 `push -f`** ✗
  （`-f` 会覆盖远端分支 ⇒ 把"待合并的留档"弄没 ✓ 这次就是这么丢的 ✗）

## arrival-batch（`feat/accept-batch-final`）· 2026-10-16 20:33 业务负责人拍板「留档后清」

- **背景**：验收的"批量写"早在 **2026-10-13** 就已进 main（`8077a73` `applyPurchaseBatch` 31→5 调用）；
  本次 **库存写入批量化**（#755 ✓ 已合 `b24a046`）又把退货那半补齐 ⇒ ⭐ **这 2 个提交的独立价值已不存在** ✓
- **处置**（业务负责人 2026-10-16 明确：「`arrival-batch` 留档后清」✓）：
  留档 = `arrival-batch-committed.patch`（相对 main 的 diff）＋ `arrival-batch-uncommitted.patch`（当时未提交的 3 处）＋ `arrival-batch-commits.txt`（2 个提交的说明）
  ⇒ 然后删 worktree ＋ 本地分支 ＋ 远端分支 ✓
- 🔴 **判据**：`git cherry origin/main feat/accept-batch-final` = **2 个 `+`**（真没合 ✗）⇒ 按规矩本不该删 ✗，
  但**功能已由 #755 覆盖** ✓ 且**她明确拍板** ✓ ⇒ 留档后清 ✓（先把 diff 落进本目录 ✓ 再删 ✓）

## ⚠️ 2026-10-16 21:0x 一条教训：**别用 `git -C <worktree> diff origin/main` 做留档** ✗

- **现象**：我（Lead）给 `arrival-batch` 留档时生成了 `arrival-batch-committed.patch` = **+1,427,710 行** ✗
- **根因**：那个 worktree 的 `origin/main` ref 与主工作区不同步 ⇒ `git diff origin/main` 把**整个仓库（含 `node_modules`）都算成"新增"** ✗
  ⇒ 产出的是一份**几千兆的垃圾** ✗（业务负责人当场问"这是什么文件，这么大"✓）
- **正确做法**（本目录 2026-10-16 之后一律照此）：
  ```bash
  # ✅ 在主工作区（ref 同步 ✓）里，用【显式路径】做留档
  git diff origin/main..<branch> -- server/src server/test docs
  # ❌ 不许：在 worktree 里 `git -C <worktree> diff origin/main`（ref 可能是旧的 ✗）
  # ❌ 不许：不带路径的整仓 diff（会把 node_modules / lock 全卷进来 ✗）
  ```
- ⭐ **留档优先级**：**提交说明（`*.commits.txt`）＞ 关键文件的 diff ＞ 整仓 patch** ✗
  （她关心的是"这段逻辑当时想干什么"✓ 不是几十万行 `node_modules` ✗）
- ✅ 处置：**已删掉全部超大 patch** ✗（它们从未推上远端 ✓）；本目录只保留**看得懂的**留档 ✓

## 🗑 2026-10-16 20:4x：**A 档/B 档那 10 份 patch 已按业务负责人口径删除** ✗

- **依据**：她 2026-10-16 明确「**删除**」（起因：她看到 `arrival-batch-committed.patch` = +1,427,710 行 ⇒ 我核出同目录 10 份 patch 是**同一根因**）
- **根因**：那些 patch 是**在 worktree 里**跑 `git diff origin/main` 生成的 ⇒ 该 worktree 的 `origin/main` ref 不同步
  ⇒ 把**整个仓库（含 `node_modules`）**都算成"新增" ⇒ 单份 30~110MB ✗ **共 87MB**（A/B 档）＋ 1.1GB（我批量清分支时又生成了 13 份）
- **为什么删得掉**：它们的**内容已经全部合进 main** ✓
  （A 档 7 份随 **#742** ✓、B 档相关随 **#744** ✓、`inv-special`/`speed2` 随 **#744** ✓）⇒ 留档价值 = 0 ✓
- ⭐ **保留的是"看得懂的"那部分**：`README.md` · `README-B-TIER.md`（**人写的判定与结论** ✓）· 每个分支的 `*.commits.txt`（**提交说明** ✓）
- ⭐ **正确做法**（本目录 2026-10-16 之后一律照此）：
  · ✅ 在**主工作区**里、**带显式路径**：`git diff origin/main..<branch> -- server/src server/test docs`
  · ❌ 不在 worktree 里跑 `git -C <worktree> diff origin/main`（ref 可能是旧的 ✗）
  · ❌ 不做不带路径的整仓 diff（`node_modules`/lock 全会卷进来 ✗）
