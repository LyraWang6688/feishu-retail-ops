# 修：预付单的「选颜色」链路没生效（真机 B26002-52，2026-10-07）

> 业务负责人口径（逐字，2026-10-07）：
> 「用户**不用在销售原话里面说颜色**，我们拿到这个货号之后，会去货品信息里面找，
>  **看能不能确定一个唯一值。如果不能确定唯一值，就给到选消息卡片的这样一个流程**」
> 「既然现货是有的，那为什么预付没有呢？」

## 1. 真机事实（2026-10-07，生产，逐条核过）

1. 她说：「`B26002-52 37 码，定金微信交了 100 元，下次欠 128 元`」（**没说颜色**）
2. 「货品信息」里 `B26002-52` **有两条**（两个颜色）：

   | record_id | 编号 | 颜色 |
   | --- | --- | --- |
   | `rec28eceOYVkYe` | `B26002-52\|巧克力\|B` | 巧克力 |
   | `rec28ece5rVS2G` | `B26002-52\|黑色\|B` | 黑色 |

3. 解析正确：`trade_type=预付` · `payments=[{100,微信}]` · `agreed_total=228` · `owed=128` ·
   `missing_fields=[]` → 出确认卡片 → 她点确认 → 入账成功
4. 🔴 **入账后「销售明细」那一行没有「编号」（商品关联）**；草稿里也是
   `product_record_id:''` · `color:''`，并且**没有** `needs_color` / `color_options`
   ⇒ 她**连颜色都没得选**。
5. 对照：**现货**会走 `choose_sale_color`（卡片让她选颜色）；**预付**这次什么都没给。

## 2. 验收标准（**先写，再动手**；逐条 = 测试用例名）

`server/test/salesPrepaidColorResolution.test.js`（**本文件不注入假 `references`**，
走真实 `V1ReferenceResolver` + 真实 `V1PostingService`）：

| # | 场景 | 应当是什么样 |
| --- | --- | --- |
| ① | 预付 + 多颜色（她没说颜色） | item 带 `needs_color:true` + `color_options`（**不猜**，`product_record_id` 留空）；卡片出现「请选择颜色」+ `choose_sale_color`；未选颜色**不许入账**；选完 `product_record_id` 落定；**入账后销售明细「编号」非空** |
| ② | 预付 + 单颜色 | 直接 `product_record_id` 非空、`color` 非空；**不多出**选颜色步骤（与现货一致） |
| ③ | 预付 + 货号不存在 | **不许编记录**（`product_record_id` 空、无候选）；真实解析器**仍然拒绝**（不许静默通过） |
| ④ | 现货 + 多颜色 | 与改动前**逐字一致**（`deepEqual` 整件明细），候选仍来自**实时库存（B）** |
| ⑤ | 未付 + 多颜色 | 同上（B 覆盖 A） |
| ⑥ | 现货 + 缺货 | item 上**既没有颜色也没有候选**（B 说了算，既有行为不变） |
| ⑦ | 解析 A 的调用方式 | 必须带 `this`（把方法摘下来调用会丢 `this`） |

## 3. 根因（**确切结论**，不是"可能"）

**代码位置**：`server/src/services/larkMvpService.js` 的 `resolveProductInfoForSale`（解析 A）。

```js
const resolveProduct = this.references?.resolveProduct;   // ← 把方法从对象上「摘下来」
...
const found = await resolveProduct({ itemNo, matchMode: 'sales' });   // ← this 丢了
```

`resolveProduct` 是 **`V1ReferenceResolver` 的原型方法**，它第一行就访问 `this.gateway`。
摘下来调用时 `this === undefined`（class body 是严格模式）⇒

```
TypeError: Cannot read properties of undefined (reading 'gateway')
```

⇒ 被同一个函数里的 `try/catch`（"尽力而为、绝不抛错"）**吞成 `{}`**
⇒ 解析 A **永远空手回来** ⇒

- **预付**（按 `config/salesTradeTypePolicy` 不跑 B）⇒ 既没有颜色、也没有候选 ⇒ 真机现象；
- **现货 / 未付** 看不出来，因为颜色与候选由 B（实时库存）提供 ⇒ 一直是好的。

**真机日志逐字**（本地复现出来的同一条）：

```json
{"ts":"2026-10-07T09:48:17.527Z","level":"warn","event":"lark.sales.product_info.resolve_failed",
 "item_no":"26002-52","error":"Cannot read properties of undefined (reading 'gateway')"}
```

**为什么既有测试全绿、真机却坏**：`server/test/larkMvpService.test.js` 注入的是**假替身**
`productInfoResolver(products)`（一个箭头函数，不用 `this`）——
它绕过了真实 resolver 的 `this` 绑定，所以这条 bug 在测试里**看不见**。
本文件因此**不注入替身**，走真实 `V1ReferenceResolver`。

**为什么"明细没有编号"**：入账时 `SalesOrderService._confirm` 用同一件明细再解析一次
（`this.references.resolveProduct({ ...item, matchMode:'sales' })`）。
颜色没定 ⇒ 多颜色货号解析不出唯一 `recordId` ⇒ `linkRecordId` 为空
⇒ `relation(undefined)` = `undefined` ⇒ 写「销售明细」时**「编号」这一列根本没写**。

## 4. 修法（关键 diff）

1. **带 `this` 调用**（根因，1 行）：

   ```diff
   -    const resolveProduct = this.references?.resolveProduct;
   -    if (!itemNo || typeof resolveProduct !== 'function') return {};
   +    if (!itemNo || typeof this.references?.resolveProduct !== 'function') return {};
        try {
   -      const found = await resolveProduct({ itemNo, matchMode: 'sales' });
   +      const found = await this.references.resolveProduct({ itemNo, matchMode: 'sales' });
   ```

2. **候选的展示串与 B / `items.push` 同口径（货号 + 颜色）**：
   resolver 回的 `number` 是**归一化过的「编号」**（小写、去分隔符），
   当卡片上的货品标签会显示成 `b2600252黑色b`。改成 `${货号}${颜色}`
   （与 B 的候选、与 `product_number` 的既有语义一致）。
   ⚠️ 这段映射从加上那天起**就没真正跑过**（A 一直空手回来），是修好 A 之后必须一起看的。

3. **现货 / 未付 的结论一律以 B 为准**（保证"一字不变"）：
   把 `productRecordId / color / colorOptions` 三项**无条件**用 B 的结论赋值
   （缺货时 B 三项都是空的 ⇒ 与改动前一字不差；有货时 B 整体替换 A 的候选，不叠加）。
   同时**去掉两处 A 的回填** `availability.productRecordId || productRecordId` /
   `availability.color || color`：它们在改动前是**死代码**
   （A 只会返回 `{}`），修好 A 之后会变成活的 ⇒ 会悄悄改掉现货 / 未付 的行为。

**没有动**：交付 / 扣库存 / 入账写入逻辑一个字节都没改（预付仍是「未交付」，既有口径）。

## 5. 证据（先红后绿）

- 改前（新文件、真实链路）：`fail 4 / pass 2`（两条"逐字一致"用例本来就该绿）；
  失败信息逐字见 PR 描述 / 本轮汇报。
- 改后：`pass 7 / fail 0`。
- 全量 `node --test --test-concurrency=1` 连跑 2 次：`fail 0`。

## 6. 边界与遗留

- **「货号不存在」那条判据（挡在确认之前）不在本文**：由
  `fix/sales-product-registration-guard`（`config/salesProductRegistration.js` +
  `larkMvpService.productRegistrationFrom`）负责。本文只保证 A **不编记录、不静默**。
  ⚠️ 两条改动**都碰 `larkMvpService.js`**（不同 hunk，但 B 分支那段与它的插入点相邻），
  合并顺序由 Lead 定；本文的用例③**刻意不钉**"要不要在确认前拦"，
  以免与那条判据打架。
- 本文的用例把「现货 / 未付 逐字一致」钉成了 `deepEqual` 整件明细：
  以后谁再动这两个解析的产物，会当场红。

## 7. ⚠️ 与 `docs/ab-color-first-design-2026-10-07.md`（PR #225，已进 main）的口径关系

那份文档（业务负责人 2026-10-07 拍板，逐字）**进一步定了 A / B 的职责**：

> 「**A 一定要有选颜色的机制**……**如果有多个颜色，一定要让用户去选择**……
>  拿到这个确定性的信息之后**再去跑 B**。B 应该是**拿着 A 环节用户选的那个颜色**，
>  然后再去找库存……三个类型都是要这样走的，只不过对于预付来说，它不会再走 B 了」

它同时明确了一个**有意的行为变化**：「货号有多个颜色、但那个尺码只有其中一色有货」这种情况，
旧行为（B 按货号+尺码唯一定位 → 直接给到正确颜色、**不问**）要改成**先问用户选颜色**。

**本文这个 PR 做了什么、没做什么**（口径边界，必须写清楚）：

- ✅ **是 #225 口径的必要前提**：它第 2 条「多颜色必须让用户选颜色」在解析 A 坏掉时
  **根本不可能生效**（A 永远空手回来）—— 本文修的正是这个。
- ⚠️ **没做**「B 只拿 A 定下来的颜色查库存」那一半：本文按本次任务的明确要求
  「现货 / 未付 行为一字不变（继续由 B 提供候选；B 的结果仍然可以覆盖 A 的）」实现，
  所以现货 / 未付 多颜色时 **B 一跑就整体替换 A 的候选** —— 这正是 #225 要改掉的"旧行为"。
- ⚠️ **后续 delta**（建议另开一条：它要改「选完颜色之后再查库存」这条交互，属于另一条链路）：
  现货 / 未付 多颜色货号在**未选颜色**时不许被 B 收窄；选完颜色后再（或用已选的颜色）去查库存，
  缺货才拦。
  ⚠️ 届时**本文用例 ④⑤（现货 / 未付 多颜色 = B 覆盖 A、逐字一致）必然变红**：
  它们就是"旧行为"的哨兵，要**有意改掉**，不是放宽。
