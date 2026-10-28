# 尺码现行口径（男 / 女 · 普通码 / 特殊码）— 2026-10-28

> 本文件是**现行口径**，用于给历史文档做校正入口；**唯一真源仍是代码**
> `server/src/config/scanPage.js` 的 `SIZE_SEGMENTS.ranges`。改范围只改那一处。

## 一、现行值（2026-10-18 起，未再变）

| 类别 | 可录范围 `enterable` | 普通码 `normal` / `default` | 特殊码 `special` |
| --- | --- | --- | --- |
| **A 男鞋** | **38–48** | **38–44** | **45、46、47、48** |
| **B 女鞋** | **34–43** | **36–40** | **34、35、41、42、43** |

- `normal` / `default` 是**区间两端**（如 `[36,40]`），`default` 是 `normal` 的兼容别名；
- `special` 是**离散码清单**（不是区间，不能用 expandRange 展开）；
- `enterable` = `normal ∪ special`（由测试钉住，见 `test/scanSizeRangeSingleSource.test.js`）；
- 分类**按编号第 3 段类别**（A/B）算：`41` 对女是特殊码、对男是普通码；`43` 同理。

## 二、运行时的区别（代码实际行为）

```text
缺货基准 = 可录范围 enterable − 有货
缺货 ∩ 特殊码 ⇒ 收进「特殊码」折叠块（默认收起）
缺货 ∩ 普通码 ⇒ 正常显示（预订/缺码行）
有货的特殊码 ⇒ 照常显示（不折叠）
补货默认勾选 ⇒ 只有「缺货 ∩ 普通码」才默认勾；特殊码永不默认勾
```

要点：

1. **普通码 / 特殊码不是库存状态**，只是展示分类；特殊码也可以有货；
2. 缺货基准是**可录范围**（含特殊码），不是普通码；
3. 当前运行时分组用 `special` + `enterable`；`normal` 主要用于业务定义、测试与
   采购「上新」默认采购量（普通码默认 1 双 / 特殊码默认 0）；
4. 旧文档里的 `36–41` / `38–45` / `[34,35,42,43]` / `[46,47,48]` 都是 2026-10-18 之前的旧值。

## 三、代码入口

- 配置：`server/src/config/scanPage.js` → `SIZE_SEGMENTS`
- 派生（只读同一对象，不复制数字）：
  - `server/src/config/scanStockPolicy.js`（`normalSizesOf` / `specialSizesOf` / `enterableSizesOf`）
  - `server/src/services/scanPageService.js`（`sizesForCategory` / `enterableScopeOf`）
  - `server/src/views/scanPageRealm.js`（`specialSizesOfView` / 折叠分组）
- 现行缺码/折叠逻辑：`scanPageService.js` 用 `enterableScopeOf`，`scanPageRealm.js` 用
  `specialSizesOf` + `missing` 分组；旧 `normalScopeOf` / `loadSizeScope` 已删除（2026-10-28 收口）。

## 四、历史文档

`docs/size-range-special-sizes-2026-10-13.md`、`docs/special-size-fold-and-enterable-base-2026-10-14.md`、
`docs/scan-stock-policy-2026-10-16.md`、`docs/special-size-and-return-amount-2026-10-14.md`
都写过旧值/旧流程（例如 36–41、38–45、采购明细出现过才展示）；**以本文件与代码为准** ✗。
