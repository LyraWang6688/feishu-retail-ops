# Pull Request

> 填完再提交。带 ⭐ 的两条是**必答**：说不清就说明这个改动还没有想清楚（规则见
> [工程分层与文件大小门禁](../docs/engineering-layering-and-file-size-2026-10-18.md)）。

## 变更摘要

<!-- 一句话说清「改了什么、为什么改」。关联任务号（task-xx / issue #xx）写在这里。 -->

## ⭐ 必答 1：这个新逻辑为什么放在这个文件？

<!--
  答清楚三件事：
  1) 它属于哪一层（入口 plan/steps / config 规则 / 小模块写入 / facade 编排）？
  2) 为什么不能落到已有模块，或者为什么必须新建模块？
  3) 如果这是一个「大 service」，本次新增的是编排还是业务规则？（业务规则应进小模块）
-->

## ⭐ 必答 2：本 PR 是否让某个文件净增 > 100 行？

<!--
  - 是 → 写清拆分计划（拆成哪几个模块、各自职责、什么时候做）；CI 的「净增 > 100 行」会直接红。
  - 否 → 写「否」并附 `cd server && node scripts/check-file-size.mjs`（= `pnpm run size:check`）的输出摘要。
  - 存量超限文件（在 size-baseline.json 里）任何增长都会红；缩小它请顺手跑 --update-baseline 把基线降下来。
-->

## 自证（贴命令与输出摘要）

- [ ] `cd server && node scripts/check-file-size.mjs` ⇒ 0 红（等价 `pnpm run size:check`）
- [ ] `cd server && pnpm test` ⇒ 0 挂（涉及真实 Base 的用例另跑 `pnpm run test:realbase`）
- 红 / 绿证据：

```text
（贴关键输出；如果是门禁类改动，贴「故意改坏 ⇒ 红 ⇒ 还原 ⇒ 绿」的演示）
```

## 边界

- [ ] 只改了本任务相关的文件（没有顺手改别人 worktree / 业务无关文件）
- [ ] 没有部署（部署必须拿到业务负责人当次明确命令；本 PR 只到「可合并」为止）
- [ ] 字段 / 表结构有变化时，已同步 `v1BitableSchema` 并跑过对应 `v1:schema-check:*`
