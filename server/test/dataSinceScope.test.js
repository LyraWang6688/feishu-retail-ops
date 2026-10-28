require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
/**
 * ⭐⭐ 2026-10-14「**数据从 20261015 开始**」＋「**存量行不用管，就看增量**」的**回归锁**。
 *
 * 口径（业务负责人逐字，真源 = `src/config/dataSince.js` 文件头）：
 *   · **受**：凡是"**自动挑出来**提醒 / 列出来"的 ⇒ 只看 `DATA_SINCE`（含）之后；
 *   · 🔴 **故意不受**：她**当下正在做的那一单** —— 扫码页的提交 / 交付 ·
 *     工作台的**单笔**补记收款 / 交付并扣库存 · 群里她**点名**的那一单 ·
 *     「未完成，可点重试」她**点重试那一刻**。
 *     ⇒ 那几条路**必须照旧能办**（**哪怕那一单是 10-15 之前的存量**）：她点了就办 ✓
 *       —— 她被"数据起点"拦住 = 最坏的一种 bug（她的活干不下去了）。
 *
 * 本文件把"故意不受"锁成**两层**：
 *   ① **判据只在三条路上**（那三条各自的验收判据在
 *      `pendingPushCandidateCaliber` / `secondDeliveryService` / `voucherSettlement` 三个文件里：
 *      **注入 10-14 与 10-15 两行 ⇒ 只有 10-15 被挑出来**）；
 *   ② **单笔动作那几条路**：
 *      · **源码级**：它们的源码里**不许出现**这个判据（谁哪天顺手加一道"存量不许办"的闸门
 *        ⇒ 这里立刻红，而不是等她在真机上被拦住）；
 *      · **行为级**：拿一张 **2026-10-01 的老单**走**真实项目代码**的
 *        **交付**（工作台单笔交付与扫码交付共用 `SalesDeliveryService.deliver`）与
 *        **点「成交」那一刻**（`SecondDeliveryService.confirm`）⇒ 照旧放行、该写的照写。
 *   ⚠️ 「扫码提交 / 点重试那一刻」的真行为要靠扫码会话 + 路由才跑得起来（那两条的用例在
 *      `scan*` 系列文件里，不在本文件的写作用域）—— 这里用**源码级**锁覆盖它们：
 *      `routes/scanPage.js` 与 `services/scanWriteService.js` 都在下面那张表里。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { SecondDeliveryService } = require('../src/services/secondDeliveryService');

// ── ① 源码级回归锁：单笔动作那几条路不许引用"数据起点" ─────────────────────────
// ⚠️ 判据只有一处实现（`config/dataSince.js`）—— 这几条路**一个引用都不该有**。
const CUTOFF_REFERENCE = /dataSince|isOnOrAfterSince|DATA_SINCE/;

test('回归锁（源码）：她当下正在做的那一单那几条路**零引用**数据起点判据', () => {
  const files = [
    // 扫码：提交 / 支付 / 交付 / 「未完成，可点重试」她点重试那一刻
    'src/routes/scanPage.js',
    // 扫码那半的写库（同一把 `submitKey` 的重试也在它身上）
    'src/services/scanWriteService.js',
    // 交付 + 扣库存（**工作台单笔交付**与**扫码交付**共用这一条）
    'src/services/salesDeliveryService.js',
    // ⚠️ 2026-10-28：`salesThreadProgressService.js`（群话题进展推进）已随群入口/卡片整体删除
    //   ⇒ 它不在"零引用"名单里了（文件都不存在）。判据的本意不变：下面这些**还在跑**的路
    //   一个都不许引用数据起点判据。
    // 补记收款 / 「确认到账」那一刻的写库
    'src/services/paymentService.js',
    // 工作台**单笔**操作的入口
    'src/routes/workbench.js',
    // 销售单本身的写库（扫码建单 / 工作台补写都经它）
    'src/services/salesOrderService.js',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, CUTOFF_REFERENCE,
      `${file} 里出现了「数据起点」判据 —— 她**当下正在做的那一单**不许被它拦住 ✗`
      + '（口径真源见 src/config/dataSince.js 文件头）');
  }
});

// ── ② 行为级回归锁：一张 2026-10-01 的**老单** ─────────────────────────────────
// 与 `test/salesStatusDimensionGates.test.js` 同一套替身写法（语义键 → 真表列名）。
const STALE_SOLD_AT = Date.parse('2026-10-01T10:00:00+08:00'); // 数据起点**之前** = 存量

const applyFields = (tableKey, values) => Object.fromEntries(Object.entries(values).map(([semantic, value]) => {
  const name = V1_BITABLE_SCHEMA.tables[tableKey].fields[semantic];
  if (!name) throw new Error(`${tableKey}: unknown field ${semantic}`);
  return [name, value];
}));

const gatewayFor = (seed = {}) => {
  const records = new Map(Object.entries(seed)
    .map(([key, rows]) => [key, rows.map((row) => ({ record_id: row.record_id, fields: { ...row.fields } }))]));
  let sequence = 0;
  const gateway = {
    records,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id) || null,
    create: async (key, values) => {
      const recordId = `rec_${key}_${++sequence}`;
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields: applyFields(key, values) });
      return { recordId };
    },
    update: async (key, id, values) => {
      const record = await gateway.get(key, id);
      if (!record) throw new Error(`${key} ${id} 不存在`);
      Object.assign(record.fields, applyFields(key, values));
      return record;
    },
  };
  return gateway;
};

const storeStub = () => ({ get: async () => null, create: async () => {}, update: async () => {} });

const staleOrderSeed = () => ({
  salesEntry: [{ record_id: 'o1', fields: { 写入状态: '成功', 销售单号: 'XSD-STALE-1' } }],
  salesDetail: [{ record_id: 'd1', fields: {
    销售单号: ['o1'], 编号: ['p1'], 尺码: ['size_38'], 履约状态: '未交付', 实收金额: 100,
    销售日: STALE_SOLD_AT,
  } }],
  sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
  product: [{ record_id: 'p1', fields: { 编号: 'P1' } }],
});

test('回归锁（行为）：2026-10-01 的老单**照旧能交付**（工作台单笔 / 扫码交付同一条路）', async () => {
  const gateway = gatewayFor(staleOrderSeed());
  const statusWrites = [];
  const service = new SalesDeliveryService({
    gateway,
    // 尺码那一步不在本锁的范围：注入桩件让它跑完。
    sizeReferences: { resolveLinkedCell: async () => ({ recordId: 'size_38', size: 38 }) },
    inventory: { applySale: async () => ({ ledgerRecordId: 'led_1' }), getSaleResult: async () => null },
    progress: { sync: async () => ({ fulfillmentStatus: '已交付' }) },
    status: { write: async (...args) => { statusWrites.push(args); } },
  });

  const result = await service.deliver({ salesEntryRecordId: 'o1', detailRecordIds: ['d1'] });

  assert.deepEqual(result.failures, [], '老单交付**一条失败都没有**（没有被"数据起点"拦下）');
  assert.equal(result.fulfillmentStatus, '已交付');
  assert.equal(result.deliveredQuantity, 1);
  // 该写的照写：这一单的「履约状态」真的落成已交付、库存状态也写了。
  const detailFields = V1_BITABLE_SCHEMA.tables.salesDetail.fields;
  assert.equal((await gateway.get('salesDetail', 'd1')).fields[detailFields.fulfillmentStatus], '已交付');
  assert.equal(statusWrites.length, 1, '「库存状态」照常写一次');
});

test('回归锁（行为）：2026-10-01 的老单点「成交」那一刻**照旧放行**（不被数据起点拦）', async () => {
  // 这一单没有任何待收款 / 未交付明细 ⇒ 正常结果是 `alreadyCompleted`（走完了、不用写账）。
  // 若哪天有人把"数据起点"接进这条单笔路，它会先被拦下（报"尚未确认入账"之类的闸门错）⇒ 这条就红。
  const service = new SecondDeliveryService({
    gateway: gatewayFor({
      salesEntry: [{ record_id: 'o1', fields: {
        写入状态: '成功', 销售单号: 'XSD-STALE-1', 录单日: STALE_SOLD_AT,
      } }],
    }),
    store: storeStub(),
    client: {},
  });
  const result = await service.confirm({ salesEntryRecordId: 'o1', method: '微信' });
  assert.equal(result.alreadyCompleted, true, '老单照旧能点：这一步走完了（不是被起点拦下）');
});
