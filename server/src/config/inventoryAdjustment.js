/**
 * 人工库存调整（工作台「常用功能 → 库存手工调整」）的可配参数。
 *
 * 为什么单独放一个配置模块：这些是**阈值**，不是逻辑。原来说好「阈值 / 开关 /
 * 字段映射 / 行为编码一律可配」（AGENTS.md「配置先行」），所以批量上限与并发
 * 不写死在 service 里 —— 她要一次调整更多双、或者要更慢更稳，只改这里。
 */

// 一次「换季调整（按品类批量）」最多提交多少个货号×尺码目标。
// 上限的作用是：一个请求最多能碰多少条库存，出问题时影响面可控。
const INVENTORY_ADJUSTMENT_MAX_TARGETS = 200;

// 批量提交时同时在跑的库存操作数。
// 同一个「货号|尺码|状态」在 InventoryService 里本来就有串行队列（runForStock），
// 所以并发不会让同一双鞋被两条通路同时改；这里的并发只影响不同货号之间的速度。
const INVENTORY_ADJUSTMENT_BATCH_CONCURRENCY = 5;

module.exports = {
  INVENTORY_ADJUSTMENT_MAX_TARGETS,
  INVENTORY_ADJUSTMENT_BATCH_CONCURRENCY,
};
