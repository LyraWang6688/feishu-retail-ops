
---

## 追加（2026-10-16 16:0x · 核实后：这两个也是**重复** ✗）

| worktree | 它的活 | main 里的真值（**核到原样代码** ✓） | 判定 |
| --- | --- | --- | --- |
| `inv-special` | 库存表排除"没货的特殊码"（挪到折叠区） | ✅ `views/scanPageRenderer.js:1863-1869` **已经是** `foldedSizes` ⇒ `rows.filter(!foldedSizes.has(...))` ⇒ `specialFactsHtml(foldedInventory…)` | **已实现** |
| `speed2` | 过滤公式抽成唯一实现 | ✅ `services/bitableFilterFormula.js` **存在** ＋ main 里过滤公式只有那一处拼 | **已实现** |

⚠️ 我上一轮曾判这两个"没做" —— **那是我查错了路径** ✗（我去 `utils/` 找 `speed2` 的文件 ✗；去库存服务找 `inv-special` ✗ 而它在渲染层 ✓）。
本次按"**读 main 的原样代码**"复核后更正 ✓。
