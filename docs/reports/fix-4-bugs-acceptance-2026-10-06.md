# 4 个 P0/P1 BUG 的验收标准（先写口径，再改代码）

> 2026-10-06 · 分支 `fix/p0-p1-thread-after-sales-bugs` · worktree `.local/wt-fix4-bugs`
> 纪律：先写「按她的口径应该怎样」→ 再改 → 逐条对照。

## BUG 1【P0】售后走消息入口 100% 失败

- **她的口径**：她说「退一双 1682 香槟 38码，钱退现金」→ 机器人**出售后确认卡片**（退货），
  绝不能说「销售文字解析失败」。
- **根因**：`parseSalesText` 里赠品归并那段直接读 `normalized.items.length`；售后意图时
  `normalizeAfterSalesResult` 返回的对象**没有 items**（售后契约刻意不装销售字段）→ TypeError。
- **验收标准**：
  1. `normalizeSalesResult({intent:'return',...})` 返回对象**本来就没有 items**（契约如此）；
  2. `parseSalesText` 对售后意图**不再抛** `Cannot read properties of undefined (reading 'length')`；
  3. 赠品归并**只对 sale 生效**（配置/意图驱动，不是靠 items 存不存在兜）；
  4. 销售（单双 + 赠品）行为**一个字不变**。

## BUG 2【P0】「收到微信 X」另存一笔已收款，待收款没被翻转

- **她的口径（逐字）**：「**未收款变为已收款，并且有收款时间**」。
- **场景**：某单有一条 `未收款 75`；她在话题里说「收到微信 75」。
- **验收标准**：
  1. 那条 `未收款 75` → **同一条记录**变成 `已收款`，写 `交易方式=微信`、`收款时间=now`、`交易方向=收入`；
  2. **不新建**第二条收款明细；收款明细**没有残留的「未收款」**；
  3. 金额与占位记录不等 / 多条占位 → **不猜**，大声拒绝（与工作台「补记收款」同口径）；
  4. 旧单**没有**占位记录时仍**新增**收款（工作台契约：`docs/workbench-query-contract.md`
     「新订单有未收款记录时更新原记录；旧订单无占位记录时仍新增收款」）→ 现有测试不回归。

## BUG 3【P0】「已完毕」/「成交」→ 机器人完全静默

- **她的口径（逐字，见 `docs/e2e-sales-status-method.md`）**：
  「话题里说『已完毕/成交』→ **未履约→履约 · 待收→已收 · 有收款时间**」。
  —— 这两件事**同时**发生，等于点那张「成交」按钮。
- **验收标准**：
  1. `classify('成交')` / `classify('已完毕')` / `classify('完毕')` / `classify('搞定')` / `classify('好了')`
     **不再返回 `none`**；且入口闸门因此放行（不静默、不零远端调用）；
  2. 判定为「整单完成」后走 `SecondDeliveryService`（**成交只有这一处实现**）：
     补收款（翻未收款）+ 交付（写已交付 + 扣库存）；
  3. 词表**留在配置** `config/salesProgressIntake.js`（配置先行，改词不碰逻辑）；
  4. 「好了，收到微信 500」这类**带更具体线索**的话仍按收款处理（口头语不降级成整单完成）。

## BUG 4【P1】售后没有被限定在话题那一笔销售上

- **她的口径**：「**同一笔的售后，绝不跨单去捞**」。
- **根因**：`afterSalesFlowService` 传了 `salesEntryRecordId`，`SaleLookupService.findCandidates`
  的签名里没有它 → 静默忽略 → 仍按「货号+颜色」在全表捞。
- **验收标准**：
  1. `findCandidates({ salesEntryRecordId: X })` 只返回挂在 `X` 上的销售明细；
     传空时行为**与改动前逐字相同**；
  2. 参数名统一为 `salesEntryRecordId`（当前代码里唯一的写法；调用方与测试桩都这么传）；
  3. **不弄坏** PR #162 的 `sendCardToTask`（本 service 的渠道感知出口）。
