# 货品完善：搜索框按「货品信息全量」搜（2026-11-17）

> 业务口径：货品完善默认还是按缺失信息分组展示；**只有搜索框**的范围放宽到货品信息全量，
> 因为她搜索是为了修改已有货品，货品可能已经完善（不缺任何信息）。

## 行为

- 进入「货品完善」：默认仍调用 /api/workbench/products/completion，按缺失信息分组 + 分页；
- 在搜索框输入货号：
  - 继续调用 /api/workbench/products/completion?q=…（全量货品，按货号模糊匹配）；
  - 不再限制在「待完善」列表里；
  - 隐藏默认分组 tabs/list，显示搜索结果；
  - 结果卡片可打开货品记录去修改；
- 清空搜索框：恢复默认的缺失信息分组视图。

## 不复用

- 不使用 /products/incomplete?q：那个接口只返回待完善货品，会漏掉已经完善的货品；
- 默认分组仍走 /products/completion，不改变原有逻辑。

## 测试

- server/test/productProfilePage.test.js：搜索框存在、使用 PRODUCT_PROFILE_API.search、默认仍用 completion；
- 全量测试、file-size、observability-events 绿。
