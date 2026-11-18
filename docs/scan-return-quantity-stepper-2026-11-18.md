# 扫码退货：数量增减框（2026-11-18）

> 业务负责人：退货页需要按照采购、验收的模式，有数量的增减框。  
> 默认值确认：「A. 显示 0（明确表示不退）」。

## 行为

每个有库存的尺码一行：

```text
39 码   库存 1    −   0   +
41 码   库存 1    −   0   +
```

- 默认 **0**：不会一打开就默认退 1 双；
- `+`：0 → 1 → 当前库存上限；
- `−`：回到 0；到 0 后减号禁用；
- 0 / 空仍然表示“这一码不退”；
- 输入框字段名仍是 `return_qty_<尺码>`；
- 服务端校验、0/空跳过逻辑原样不动。

## 库存上限

- 有 `data-stock`：上限 = 该行当前可退库存；
- 库存取不到：不拿 0 当上限，按全局 `maxQuantity`，最终仍由服务端校验。

## 文件

- `server/src/views/scanPage/returnBlock.js`
- `server/src/views/scanPage/script.js`
- `server/src/views/scanPage/styles.js`
- `server/src/views/scanPage/layout.js`
- `server/src/views/scanPage/index.js`
- `server/test/fixtures/stockStateConsistency.golden.json`
- `server/test/scanReturnSizeList.test.js`

## 测试

- 默认 0；
- 减号初始禁用；
- 有 `data-return-step` 加减按钮；
- 脚本读 `data-stock` 上限；
- 原退货金额/数量/库存校验不变。
