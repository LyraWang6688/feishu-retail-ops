'use strict';

/**
 * 测试专用预加载：给 **17 张表**都塞一个**测试用** tableId。
 *
 * 为什么需要它（2026-10-17，业务负责人指令）：
 *   「代码里 15 个兜底默认值**可以删除了，统统从环境变量读**」
 *   ⇒ `v1BitableSchema` 现在**没有任何硬编码 tableId**（17 张全部 `getEnv('FEISHU_V1_*_TABLE_ID')`）。
 *   ⇒ 单测进程不加载 `.env` ⇒ 若这里不补，任何引用 schema 的用例都会拿到**空串**
 *     （`v1BitableGateway` 会当场抛「未配置 table_id」）。
 *
 * 🔴 只给**测试**用：生产/本地跑服务靠各自 `.env`（见 `.env.example`）。
 * 🔴 值刻意用 `tbl_test_*`（**不是**生产 id）：万一有测试意外走到"真请求"也不会打到生产表。
 * ⭐ 已有环境变量时不覆盖（`if (!process.env[key])`）⇒ 用例自己显式设的值仍然生效。
 *
 * 由 `package.json` 的 test 脚本通过 `--require` 预加载（已实测 Node 20 / 24 都会传到测试子进程）。
 */
/**
 * ⚠️ **刻意不包含** `FEISHU_V1_ACCESSORY_TABLE_ID` / `FEISHU_V1_SIZE_TABLE_ID`：
 *   这两张在本次改动**之前就没有兜底**（测试进程里一直是**空串**，服务会因此跳过读它们）——
 *   很多既有判据的"读表次数"就是按这个形状钉的。塞上值会凭空多出读 → 一堆**假红**。
 *   需要它们的用例自己显式设（既有做法：`orderThreeStates` 等在假网关里覆盖 tableId）。
 */
const TEST_TABLE_IDS = Object.freeze({
  FEISHU_V1_PRODUCT_TABLE_ID: 'tbl_test_product',
  FEISHU_V1_COLOR_TABLE_ID: 'tbl_test_color',
  FEISHU_V1_CATEGORY_TABLE_ID: 'tbl_test_category',
  FEISHU_V1_BEHAVIOR_TABLE_ID: 'tbl_test_behavior',
  FEISHU_V1_GROUP_BUY_VOUCHER_TABLE_ID: 'tbl_test_group_buy_voucher',
  FEISHU_V1_PAYMENT_METHOD_TABLE_ID: 'tbl_test_payment_method',
  FEISHU_V1_SUPPLIER_TABLE_ID: 'tbl_test_supplier',
  FEISHU_V1_SALES_ENTRY_TABLE_ID: 'tbl_test_sales_entry',
  FEISHU_V1_SALES_DETAIL_TABLE_ID: 'tbl_test_sales_detail',
  FEISHU_V1_PAYMENT_RECORD_TABLE_ID: 'tbl_test_payment_record',
  FEISHU_V1_PAYMENT_DETAIL_TABLE_ID: 'tbl_test_payment_detail',
  FEISHU_V1_PURCHASE_REQUEST_TABLE_ID: 'tbl_test_purchase_request',
  FEISHU_V1_PURCHASE_ORDER_BATCH_TABLE_ID: 'tbl_test_purchase_order_batch',
  FEISHU_V1_INVENTORY_LEDGER_TABLE_ID: 'tbl_test_inventory_ledger',
  FEISHU_V1_LIVE_INVENTORY_TABLE_ID: 'tbl_test_live_inventory',
});

for (const [key, value] of Object.entries(TEST_TABLE_IDS)) {
  if (!process.env[key]) process.env[key] = value;
}

module.exports = { TEST_TABLE_IDS };
