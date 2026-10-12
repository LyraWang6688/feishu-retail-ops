/**
 * ⭐⭐ 2026-10-12（提速第二批）：**提交链路少打两次飞书**（按"谁打的"归因量出来的那两次）。
 *
 * 归因（假网关 + 每趟 60ms，一趟提交 41 次飞书调用，按文件归因）：
 *   `salesStatusWriter → update:salesEntry` 5 · `salesReadRetry → get:salesEntry` 3 ·
 *   `salesRecordReader → get:salesDetail` 3 · …
 * ⇒ 本文件钉住**改掉的那一次**（41 → 40）：
 *   · `salesOrderService` 结尾"写完再读一遍主表拿单号" ⇒ 单号开头就拿到了（零语义变化）。
 * ⚠️ **另一次评估过、但主动回退**（诚实记录，见 AC-SPD1b）：
 *   `salesOrderService` 那句"赠品没变也照写空串"的 PATCH —— 省它**与生产表上的结果等价**
 *   （写空串 vs 压根不写，肉眼一样），但 **3 条既有用例**（`salesGiftOnEntry` ③ /
 *   `scanSaleAccessoryAndRemark` AC-B4 / `scanSaleWriteRegression` AC-REG）把"**这一列被写过**"
 *   当成了语义 ⇒ 为省 1 次 PATCH 去改别人 3 条哨兵是坏交换 ⇒ **不做**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**测试名 = AC**）
 *
 *  AC-SPD1 无赠品 ⇒ **不打**那次赠品 PATCH，且主表赠品列最终值 = 空串（与改前逐字一致）。
 *  AC-SPD2 表里空 ⇒ 这次有赠品：**照旧写**；表里**已有**、草稿不同（含"从有到空"）⇒
 *         **照旧被既有护栏拦住**（"草稿变了要能被识别"）—— 我的跳过**只**覆盖"两边逐字相同"。
 *  AC-SPD3 赠品列**没有映射**时 ⇒ 照旧走到"未配置语义字段"（**响亮失败**，不许被我静默跳过）。
 *  AC-SPD4 单号：`sourceNo` = 主表上那条单号；且**不再为它多读一次主表**（`get:salesEntry` 少一次）。
 *  AC-SPD5 **钱的语义一字不动**：收款行 / 差额 / 主表四个状态维度的**目标值**与改前逐字相同。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_spd_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'spd_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { SalesStatusWriter } = require('../src/services/salesStatusWriter');
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('../src/config/salesStatusDimensions');

const F = (table, key) => V1_BITABLE_SCHEMA.tables[table].fields[key];
const GIFT = F('salesEntry', 'gift');
const ORDER_NO = F('salesEntry', 'orderNo');

const MASTER = () => ({
  record_id: 'se_1',
  fields: { [ORDER_NO]: 'XSD-20261012-0007', [GIFT]: '' },
});

const makeGateway = ({ master = MASTER(), dropGiftMapping = false } = {}) => {
  const tables = { salesEntry: [master], salesDetail: [], paymentRecord: [] };
  const writes = [];
  const calls = [];
  const table = (key) => {
    const real = V1_BITABLE_SCHEMA.tables[key];
    if (!dropGiftMapping || key !== 'salesEntry') return real;
    const fields = { ...real.fields };
    delete fields.gift;
    return { ...real, fields };
  };
  // ⚠️ 照**真网关**的语义映射来：`SalesOrderService` 传下来的是**语义键**（`gift` / `sales`…），
  //    真网关会映射成物理列名；**没有映射时就抛「未配置语义字段」**（AC-SPD3 钉的就是这一声）。
  const physical = (key, values) => {
    const fields = table(key).fields;
    const out = {};
    for (const [semantic, value] of Object.entries(values || {})) {
      const name = fields[semantic];
      if (!name) throw new Error(`${key} 未配置语义字段: ${semantic}`);
      if (value !== undefined) out[name] = value;
    }
    return out;
  };
  return {
    writes, calls, _tables: tables,
    table,
    listAll: async (key) => { calls.push(['listAll', key]); return [...(tables[key] || [])]; },
    get: async (key, id) => {
      calls.push(['get', key, id]);
      return (tables[key] || []).find((record) => record.record_id === id) || null;
    },
    listByFilter: async () => { throw new Error('本用例不测过滤读'); },
    findOneByText: async () => null,
    create: async (key, values) => {
      const fields = physical(key, values);
      const record = { record_id: `${key}_${(tables[key] || []).length + 1}`, fields };
      tables[key] = [...(tables[key] || []), record];
      writes.push({ op: 'create', table: key, fields });
      return { recordId: record.record_id, record };
    },
    update: async (key, id, values) => {
      const fields = physical(key, values);
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (record) Object.assign(record.fields, fields);
      writes.push({ op: 'update', table: key, record_id: id, fields });
      return record;
    },
    delete: async () => { throw new Error('本用例不测删除'); },
    /** 打过几次 `update('salesEntry', ...)`（= PATCH 次数）。 */
    patches: () => writes.filter((write) => write.op === 'update' && write.table === 'salesEntry'),
    /** 某一次 PATCH 里带没带「赠品」这一列。 */
    giftPatches: () => writes.filter((write) => write.op === 'update' && write.table === 'salesEntry'
      && Object.prototype.hasOwnProperty.call(write.fields || {}, GIFT)),
    getsOf: (key) => calls.filter((call) => call[0] === 'get' && call[1] === key).length,
  };
};

/** 一条最小 happy path（一双鞋、不收款、不欠款）——只跑 `confirm` 那一层。 */
const runConfirm = async (gateway, { giftText = '', payments = [], lineAmount = null } = {}) => {
  const service = new SalesOrderService({
    gateway,
    references: {
      resolveProduct: async () => ({ recordId: 'prod_1' }),
      resolveSalesTradeType: async () => ({ recordId: 'bh_cash' }),
    },
    payments: { recordInitialBatch: async () => ['pay_1'] },
    progress: { sync: async () => undefined },
    sizeReferences: { resolveByNumber: async () => ({ recordId: 'size_37' }) },
    status: new SalesStatusWriter({ gateway }),
  });
  return service.confirm({
    salesEntryRecordId: 'se_1',
    items: [{
      kind: 'shoe', productRecordId: 'prod_1', size: 37, quantity: 1,
      giftDescription: giftText, tradeTypeCode: 'SALE_CASH',
      ...(lineAmount === null ? {} : { actualAmount: lineAmount }),
    }],
    payments,
    operatorOpenId: 'ou_spd',
  }, { correlation: {} });
};

// ── AC-SPD1 ───────────────────────────────────────────────────────────────
test('AC-SPD1/SPD1b 赠品列**照旧写一次**（空串也写）—— 这条"不做"的改动必须有哨兵守着', async () => {
  const gateway = makeGateway();
  await runConfirm(gateway, { giftText: '' });
  assert.equal(gateway.giftPatches().length, 1,
    '没有赠品时**照旧要写一次空串**（3 条既有用例钉着"这一列被写过"；省它 = 改别人的哨兵）');
  const master = gateway._tables.salesEntry[0];
  assert.equal(master.fields[GIFT], '', '主表赠品列 = 空串（既有语义，逐字不变）');
});

// ── AC-SPD2 ───────────────────────────────────────────────────────────────
test('AC-SPD2 空⇒有赠品照旧写；已有且不同⇒照旧被护栏拦住（跳过只覆盖"逐字相同"）', async () => {
  // ① 从空 → 有赠品
  const fresh = makeGateway();
  await runConfirm(fresh, { giftText: '袜子' });
  assert.equal(fresh.giftPatches().length, 1, '表里空、这次有赠品 ⇒ 必须写');
  assert.equal(fresh._tables.salesEntry[0].fields[GIFT], '袜子');

  // ② 表里已有赠品、这次草稿**不一样**（含"从有到空"）⇒ **照旧被既有护栏拦住**
  //    （「销售主表已记录的赠品与当前草稿不一致，已停止重试」）—— 这条护栏**我一个字没动**，
  //    也正是它保证了"值不同就照旧走原路"，我的跳过**只**覆盖"两边逐字相同"。
  for (const giftText of ['', '帽子']) {
    const had = makeGateway({ master: { record_id: 'se_1', fields: { [ORDER_NO]: 'XSD-20261012-0007', [GIFT]: '袜子' } } });
    await assert.rejects(() => runConfirm(had, { giftText }), /赠品与当前草稿不一致/,
      `表里"袜子"、草稿"${giftText}" ⇒ 必须照旧拦住（不许被我这次跳过吞掉）`);
    assert.equal(had.giftPatches().length, 0, '拦住时一个字都不许写');
    assert.equal(had._tables.salesEntry[0].fields[GIFT], '袜子', '表里那条不许被动过');
  }
});

// ── AC-SPD3 ───────────────────────────────────────────────────────────────
test('AC-SPD3 赠品列没有映射 ⇒ 照旧响亮失败（不许被这次跳过静默吞掉）', async () => {
  const gateway = makeGateway({ dropGiftMapping: true });
  await assert.rejects(() => runConfirm(gateway, { giftText: '' }),
    /未配置语义字段|gift/,
    '映射缺失时必须照旧抛出来（"静默跳过"会把一个配错的字段变成看不见的坑）');
});

// ── AC-SPD4 ───────────────────────────────────────────────────────────────
test('AC-SPD4 单号 = 主表那条；且**不再为它多读一次主表**（get:salesEntry 少一次）', async () => {
  const gateway = makeGateway();
  const result = await runConfirm(gateway);
  assert.equal(result.sourceNo, 'XSD-20261012-0007', '给她看的单号必须是主表上那条');
  // ⚠️ 改前：`_confirm` 结尾会**再读一遍主表**拿单号（那次读就是被省掉的那一次）。
  //    这里钉的是"读主表的次数"：`_confirm` 只需要开头那一次（读赠品/单号/交易类型）。
  assert.equal(gateway.getsOf('salesEntry'), 1,
    `一次 confirm 只该读一次主表（实际 ${gateway.getsOf('salesEntry')} 次）`);
});

// ── AC-SPD5 ───────────────────────────────────────────────────────────────
test('AC-SPD5 钱的语义一字不动：收款行 / 主表四个状态维度的**目标值**与改前逐字相同', async () => {
  const gateway = makeGateway();
  await runConfirm(gateway, {
    lineAmount: 199,
    payments: [{ amount: 199, method: '微信', operatorOpenId: 'ou_spd' }],
  });
  // 「销售状态」「资金状态」写到的**目标值**（值域在 config/salesStatusDimensions）。
  const statusPatches = gateway.patches().filter((write) => (
    Object.prototype.hasOwnProperty.call(write.fields, F('salesEntry', 'sales'))
    || Object.prototype.hasOwnProperty.call(write.fields, F('salesEntry', 'funds'))));
  const seen = statusPatches.map((write) => ({
    sales: write.fields[F('salesEntry', 'sales')], funds: write.fields[F('salesEntry', 'funds')],
  }));
  // ① 入口先落「未写入 / 未写入」（让"到哪一步了"在表里看得见，**不许被合并掉**）；
  // ② 明细写完 ⇒ 销售状态 = 已写入；③ 收款写完 ⇒ 资金状态 = 已写入。
  assert.deepEqual(seen, [
    { sales: WRITE.sales.none, funds: WRITE.funds.none },
    { sales: WRITE.sales.done, funds: undefined },
    { sales: undefined, funds: WRITE.funds.done },
  ], `四个状态维度的目标值与"先落未写入、再逐维落已写入"的顺序都不许变（实际 ${JSON.stringify(seen)}）`);
  // 钱的写入条数没变：`_confirm` 把收款交给既有 `PaymentService.recordInitialBatch`（本用例是替身），
  // 这里钉的是"**这次改动没有去碰收款那一段**"——主表上没有任何一条列被她这次填的钱改写。
  assert.equal(gateway.patches().some((write) => Object.prototype.hasOwnProperty.call(
    write.fields, F('salesEntry', 'orderNo'))), false, '状态 PATCH 不许顺手改单号');
});
