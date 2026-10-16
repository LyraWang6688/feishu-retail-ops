'use strict';

/**
 * ⭐⭐ 2026-10-16：**生产「销售主表」新增「总金额」列 → 同步代码 + 接进写入**。
 *
 * 业务负责人的原话（逐字，Lead 转述，逐字照抄）：
 *   「我在**销售主表**里面加了一个**货币字段**，叫做「**总金额**」。
 *    这个就是用来记录我们「**一单多货**」时需要判断的**累计金额**，也是**它的写入地方**。」
 *
 * 她给的**只读核对**（项目 SDK `appTableField.list`，**生产**表 —— 本机没有生产凭证，
 * 这一条我核不到生产，如实标注）：名字 =「总金额」· `type=2`（数字）·
 * `property={"currency_code":"CNY","formatter":"0"}`。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**测试名 = AC**）
 *
 *  AC-TA0 **schema 同步**：「总金额」**逐字**映射在 `salesEntry` 上（`totalAmount`）；
 *         `salesDetail` **没有**这个键（它是**整单**级的一列，不是明细级）。
 *  AC-TA1 **多行（3 件，含券调整过的行 + 少付）**：总金额 = **各行实收之和**（按分相加，
 *         不用浮点比）；且与「还差多少钱」**自洽** —— `总金额 − 收款合计 = 差额（未收款那条）`。
 *  AC-TA1b **券**：行金额已被入口（`voucherPaymentService`）按"面值 − 结算款"调过 ⇒
 *         总金额**跟着调后的行金额走**（本层不认识券，口径天然一致 —— 不是巧合，是同一个 `totalCents`）。
 *  AC-TA2 **有行没填「实收金额」⇒ 一个字都不写**（那一格留空，**绝不写 0** ✗）＋ 如实记 skip 日志；
 *         ⚠️ 既有行为一个字不变（明细照建、赠品照写）。
 *  AC-TA3 **零 / 负值**：既有校验照旧当场拦住（人话）⇒ **总金额一个字都没写**（没有任何一次 PATCH 带它）。
 *  AC-TA4 **同一笔写库**：总金额与**赠品同在一条 PATCH** 里 ⇒ **不新增一次请求** ✗。
 *  AC-TA5 **重试幂等**：同一单跑两次 ⇒ 总金额值相同、明细不重复、那条【未收款】不重复挂。
 *  AC-TA6 **单货品（N=1）也写**（建议 + 依据见下面那一条测试的注释）。
 *  AC-TA7 **反向哨兵（源码）**：写入那一段**必须逐字在位**（删掉 ⇒ 红），
 *         并且**全仓只有一处**写 `totalAmount`（两处各写会漂移）。
 *  AC-TA8 **成对迁移**：`amountsKnown` 的来源从"两处各算一遍"收敛成一处
 *         （改前逐字 → 改后逐字 → 依据 = 只许有一个来源），且既有 `owed` 判据一字不动。
 * ─────────────────────────────────────────────────────────────────────────
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_ta_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'ta_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { SalesStatusWriter } = require('../src/services/salesStatusWriter');

const SERVICE_PATH = path.join(__dirname, '../src/services/salesOrderService.js');
const SRC = path.join(__dirname, '../src');

const F = (table, key) => V1_BITABLE_SCHEMA.tables[table].fields[key];
const TOTAL = F('salesEntry', 'totalAmount');
const GIFT = F('salesEntry', 'gift');
const ORDER_NO = F('salesEntry', 'orderNo');
const DETAIL_AMOUNT = F('salesDetail', 'actualAmount');

/** 语义键 → 物理列名（照**真网关**：没有映射就抛「未配置语义字段」）。 */
const physicalOf = (tableKey, values) => {
  const fields = V1_BITABLE_SCHEMA.tables[tableKey].fields;
  const out = {};
  for (const [semantic, value] of Object.entries(values || {})) {
    const name = fields[semantic];
    if (!name) throw new Error(`${tableKey} 未配置语义字段: ${semantic}`);
    if (value !== undefined) out[name] = value;
  }
  return out;
};

const MASTER = () => ({ record_id: 'se_1', fields: { [ORDER_NO]: 'XSD-20261016-0001', [GIFT]: '' } });

const makeGateway = ({ master = MASTER(), trades = [] } = {}) => {
  const tables = { salesEntry: [master], salesDetail: [], paymentRecord: [] };
  const writes = [];
  let sequence = 0;
  return {
    tables, writes, trades,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => [...(tables[key] || [])],
    listByFilter: async () => [],
    findOneByText: async () => null,
    get: async (key, id) => (tables[key] || []).find((row) => row.record_id === id) || null,
    create: async (key, values) => {
      const fields = physicalOf(key, values);
      const record = { record_id: `${key}_${++sequence}`, fields };
      tables[key] = [...(tables[key] || []), record];
      writes.push({ op: 'create', table: key, fields });
      return { recordId: record.record_id, record };
    },
    update: async (key, id, values) => {
      const fields = physicalOf(key, values);
      const record = (tables[key] || []).find((row) => row.record_id === id);
      if (record) Object.assign(record.fields, fields);
      writes.push({ op: 'update', table: key, record_id: id, fields });
      return record;
    },
    delete: async () => { throw new Error('本用例不测删除'); },
    /** 带「总金额」这一列的每一次 PATCH（物理列名 —— 写错键名这里就看不见/当场抛）。 */
    totalPatches: () => writes.filter((write) => write.op === 'update' && write.table === 'salesEntry'
      && Object.prototype.hasOwnProperty.call(write.fields || {}, TOTAL)),
    /** 带「赠品」这一列的每一次 PATCH。 */
    giftPatches: () => writes.filter((write) => write.op === 'update' && write.table === 'salesEntry'
      && Object.prototype.hasOwnProperty.call(write.fields || {}, GIFT)),
    masterFields: () => tables.salesEntry[0].fields,
    detailAmounts: () => (tables.salesDetail || []).map((row) => row.fields[DETAIL_AMOUNT]),
  };
};

/** 一条最小 happy path 的 `confirm`（收款 / 进度 / 尺码 / 货品都是替身）。 */
const runConfirm = async (gateway, {
  items, payments = [], owed = undefined, knownRecordIds = undefined,
} = {}) => {
  const service = new SalesOrderService({
    gateway,
    validateTables: undefined,
    references: {
      resolveProduct: async () => ({ recordId: 'prod_1' }),
      resolveSalesTradeType: async () => ({ recordId: 'bh_cash' }),
    },
    payments: {
      recordInitialBatch: async (_salesEntryRecordId, rows, options = {}) => {
        gateway.lastPayments = rows;
        const known = (options && options.knownRecordIds) || [];
        return rows.map((row, index) => {
          // 幂等：给了 `knownRecordIds` 就复用那一条（照既有协议的语义）⇒ 重试不重复挂。
          const recordId = known[index] || `pay_${index + 1}`;
          if (!gateway.tables.paymentRecord.some((item) => item.record_id === recordId)) {
            gateway.tables.paymentRecord.push({
              record_id: recordId,
              fields: { 收款金额: row.amount, 收款状态: row.status || '已收款' },
            });
          }
          return recordId;
        });
      },
    },
    progress: { sync: async () => undefined },
    sizeReferences: { resolveByNumber: async (number) => ({ recordId: `size_${number}` }) },
    status: new SalesStatusWriter({ gateway }),
  });
  return service.confirm({
    salesEntryRecordId: 'se_1',
    items,
    payments,
    ...(owed === undefined ? {} : { owed }),
    ...(knownRecordIds === undefined ? {} : { knownRecordIds }),
    operatorOpenId: 'ou_ta',
  }, { correlation: {} });
};

const shoe = (size, actualAmount) => ({
  kind: 'shoe', productRecordId: 'prod_1', size, quantity: 1, actualAmount,
});

/** 元 → 分（**不用浮点比金额**：0.1 + 0.2 ≠ 0.3 那类误差会假红）。 */
const toCents = (value) => Math.round(Number(value) * 100);

// 源码扫描的两个小工具（照 `v1SchemaProductionSync2026_10_09.test.js` 的既有写法）：
// 「改前逐字」在注释里是**引文**，不该被当成代码 ⇒ 一律先剥注释再扫。
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:])\/\/.*$/gm, '$1');

/** 取 `fromIndex` 之后**第一个花括号对象字面量**的原文（花括号配对，不靠固定窗口截断）。 */
const objectLiteralAfter = (source, fromIndex) => {
  const start = source.indexOf('{', fromIndex);
  if (start < 0) return '';
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return '';
};

const walkSrc = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (entry.name === 'node_modules' || entry.name === 'data') return [];
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walkSrc(full) : (entry.name.endsWith('.js') ? [full] : []);
});

// ═══════════════════════════════════════════════════════════════════════════

test('AC-TA0 schema：「总金额」逐字映射在**销售主表**上；明细那侧没有它', () => {
  assert.equal(TOTAL, '总金额', '字段名必须**逐字**是她给的那个（她 2026-10-16：「叫做「总金额」」）');
  assert.equal(V1_BITABLE_SCHEMA.tables.salesDetail.fields.totalAmount, undefined,
    '「总金额」是**整单**级的一列（累计金额）⇒ 明细那侧不许有同名映射（会写错地方）');
  // 同一个字段名不许在别的表上再映射一次（撞车 = 写错表）。
  const elsewhere = Object.entries(V1_BITABLE_SCHEMA.tables)
    .filter(([key, table]) => key !== 'salesEntry'
      && Object.values(table.fields || {}).includes('总金额'))
    .map(([key]) => key);
  assert.deepEqual(elsewhere, [], `「总金额」只属于销售主表（实际还出现在：${elsewhere.join('、')}）`);
});

test('AC-TA1 多行 3 件（券调过的行 + 少付）⇒ 总金额 = 各行实收之和，且与「还差多少钱」自洽', async () => {
  const gateway = makeGateway();
  const result = await runConfirm(gateway, {
    // 第 1 行是**券调过**的净额（入口已按"面值 − 结算款"调过，见 AC-TA1b）；
    // 第 3 行带小数 ⇒ 顺便钉住"按分相加、不拿浮点比"。
    items: [shoe(38, 200), shoe(39, 100.1), shoe(40, 70.66)],
    // 少付：她只收到 300（差额 70.76 由业务层自动补一条【未收款】）。
    payments: [{ amount: 100, method: '微信', operatorOpenId: 'ou_ta' },
      { amount: 200, method: '现金', operatorOpenId: 'ou_ta' }],
  });
  const expectedTotalCents = 20000 + 10010 + 7066; // = 370.76（按**分**相加，不拿浮点比）
  assert.equal(gateway.totalPatches().length, 1, '总金额必须被写**一次**');
  assert.equal(toCents(gateway.masterFields()[TOTAL]), expectedTotalCents,
    '总金额 = 各行实收之和（按分）');
  // 自洽：总金额 − 收款合计 = 那条【未收款】的金额（「还差多少钱」只有这一个算法）。
  const owedRow = gateway.lastPayments.find((row) => row.status === '未收款');
  assert.ok(owedRow, '少付 ⇒ 自动补一条【未收款】（她 2026-10-16 裁的 A）');
  assert.equal(expectedTotalCents - 30000, toCents(owedRow.amount),
    '总金额 − 收款合计 必须等于那条【未收款】的金额（口径自洽，不许两套算法）');
  assert.equal(gateway.detailAmounts().length, 3, '三行明细照旧各写各的实收金额');
  assert.ok(result.detailRecordIds.length === 3);
});

test('AC-TA1b 券：行金额被入口调小后，总金额跟着调后的行金额走（同一个 `totalCents`）', async () => {
  // 券那两个数**不归这一层管**（`voucherPaymentService` 在入口就把行金额换成净额、
  // 把收款行的金额换成【平台结算款】）。这一条钉的是：本层**不重新发明口径**，
  // 累计就取"这一层的行金额之和" ⇒ 券的口径天然一致。
  const gateway = makeGateway();
  await runConfirm(gateway, {
    items: [shoe(38, 294), shoe(39, 100)], // 294 = 300 − (面值 100 − 结算款 94)
    payments: [{ amount: 94, method: '抖音团购券', operatorOpenId: 'ou_ta' },
      { amount: 300, method: '微信', operatorOpenId: 'ou_ta' }],
  });
  assert.equal(toCents(gateway.masterFields()[TOTAL]), 39400,
    '总金额 = 294 + 100（调后的行金额，不是原价 400）');
  assert.equal(gateway.totalPatches().length, 1);
});

test('AC-TA2 有行没填「实收金额」⇒ **一个字都不写**（留空，绝不写 0）＋ 如实记 skip', async () => {
  // `utils/logger` 的 `logWarn` 最终走 `console.warn`（`writeLog` 在**调用时**解引用全局 console）
  // ⇒ 截 `console.warn` 是唯一能看到"它到底记没记"的口子（`salesOrderService` 在模块加载时
  // 就解构了 `logWarn`，改模块属性看不到）。
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (line) => { lines.push(String(line)); };
  try {
    const gateway = makeGateway();
    await runConfirm(gateway, {
      // 第 2 行她没填（方案甲：空 ⇒ 那一列不写）⇒ 累计**不可知** ⇒ 不编。
      items: [shoe(38, 200), { kind: 'shoe', productRecordId: 'prod_1', size: 39, quantity: 1 }],
      payments: [{ amount: 200, method: '微信', operatorOpenId: 'ou_ta' }],
    });
    assert.equal(gateway.totalPatches().length, 0,
      '有行没填实收金额 ⇒ 总金额这一列**一次都不许写**（写 0 就是错账 ✗）');
    assert.equal(Object.prototype.hasOwnProperty.call(gateway.masterFields(), TOTAL), false,
      '那一格必须**留空**（不是 0）');
    // ⚠️ 既有行为一个字不变：赠品照写、明细照建。
    assert.equal(gateway.giftPatches().length, 1, '赠品那一次 PATCH 照旧（这次改动没碰它）');
    assert.equal(gateway.detailAmounts().length, 2, '两行明细照建（没填的那行不写金额列）');
    assert.deepEqual(gateway.detailAmounts(), [200, undefined]);
    // 如实记录（不是静默跳过）。
    const skipped = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((entry) => entry && entry.event === 'sales.entry.total_amount.skipped');
    assert.equal(skipped.length, 1, '必须记一条 `sales.entry.total_amount.skipped`（可排查）');
    assert.equal(skipped[0].reason, 'line_amount_missing');
    // 写成功那一路也留一条（可排查：她能看到这一格里到底写进去多少）。
    const written = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((entry) => entry && entry.event === 'sales.entry.total_amount.written');
    assert.equal(written.length, 0, '这一单没算出来 ⇒ 不该有"written"那条');
  } finally {
    console.warn = originalWarn;
  }
});

test('AC-TA3 零 / 负值 ⇒ 既有校验照旧拦住 ＋ 总金额一个字都没写', async () => {
  for (const bad of [0, -1]) {
    const gateway = makeGateway();
    await assert.rejects(
      () => runConfirm(gateway, { items: [shoe(38, 200), shoe(39, bad)], payments: [] }),
      /实收金额必须大于 0|非负的两位小数金额/,
      `${bad} 必须照旧被既有的「填了就必须 > 0」拦下（人话），不许放宽`,
    );
    assert.equal(gateway.totalPatches().length, 0, `拦下时总金额一个字都不许写（bad=${bad}）`);
    assert.equal(Object.prototype.hasOwnProperty.call(gateway.masterFields(), TOTAL), false);
    assert.equal(gateway.detailAmounts().length, 0, '拦下时一条明细都不许落库');
  }
});

test('AC-TA4 同一笔写库：总金额与赠品在**同一条 PATCH** 里 ⇒ 不新增一次请求', async () => {
  const gateway = makeGateway();
  await runConfirm(gateway, { items: [shoe(38, 199)], payments: [{ amount: 199, method: '微信' }] });
  const totalPatch = gateway.totalPatches()[0];
  const giftPatch = gateway.giftPatches()[0];
  assert.ok(totalPatch && giftPatch);
  assert.equal(totalPatch.record_id, giftPatch.record_id);
  assert.equal(totalPatch.fields[TOTAL], 199);
  assert.equal(totalPatch.fields[GIFT], '', '同一次 PATCH 里赠品照旧写着（空串也写，既有语义不变）');
  // 一共只有一条 PATCH 同时带这两列（"两处各写"会变成两条）。
  const both = gateway.writes.filter((write) => write.op === 'update' && write.table === 'salesEntry'
    && Object.prototype.hasOwnProperty.call(write.fields || {}, TOTAL)
    && Object.prototype.hasOwnProperty.call(write.fields || {}, GIFT));
  assert.equal(both.length, 1, '总金额必须挂在赠品那一次 PATCH 上（不新增请求 ✗）');
});

test('AC-TA5 重试幂等：同一单跑两次 ⇒ 总金额值相同、明细不重复、【未收款】不重复', async () => {
  const gateway = makeGateway();
  const input = {
    items: [shoe(38, 300), shoe(39, 100)],
    payments: [{ amount: 100, method: '微信', operatorOpenId: 'ou_ta' }],
  };
  const first = await runConfirm(gateway, input);
  const firstTotal = gateway.masterFields()[TOTAL];
  const retry = await runConfirm(gateway, {
    ...input,
    knownRecordIds: { details: first.detailRecordIds, payments: first.paymentRecordIds },
  });
  assert.equal(gateway.masterFields()[TOTAL], firstTotal, '重试不许把总金额改成别的值');
  assert.equal(firstTotal, 400);
  assert.equal(gateway.tables.salesDetail.length, 2, '明细不重复');
  assert.equal(gateway.tables.paymentRecord.length, 2, '收款不重复（1 笔真收 + 1 条未收款）');
  assert.deepEqual(retry.detailRecordIds, first.detailRecordIds);
});

test('AC-TA6 单货品（N=1）**也写** —— 建议 + 依据', async () => {
  // 【建议】写。依据（逐条）：
  //   ① 她的口径说的是「累计金额」= 该单**所有行**实收之和 —— 它是一个**和**，
  //      N=1 时那个和就是这一行的实收，定义上没有"不适用"这一档；她**没有**给 N=1 划例外。
  //   ② 写入点是**唯一出口** `_confirm`（群聊 / 扫码 / 工作台 / 一单多货都经它）。
  //      为一个 N<2 的判据在这里分叉，是本仓一贯禁止的"按情形分支"（配置先行 / 不许散落 if）✗；
  //      而且分叉出来的效果是"这一列**有时空着**"，她**分不清**"空"是"没算"还是"不适用"
  //      —— 正是 AGENTS 反复点名的静默空列。
  //   ③ 数据风险为零：N=1 时的值就是**那一行**的实收金额（与「实收金额逐行」自洽），不是猜测。
  //   ⚠️ 如果她要"N=1 留空"，那是一行分支 + 一条配置的事；**这属于"不许自己定"那一类**，
  //      已如实写进回报请 Lead 与她确认（本刀按"写"落地，因为它**不可能写错值**）。
  const gateway = makeGateway();
  await runConfirm(gateway, { items: [shoe(38, 250)], payments: [{ amount: 250, method: '微信' }] });
  assert.equal(gateway.totalPatches().length, 1, 'N=1 也写（同一个出口，不分叉）');
  assert.equal(gateway.masterFields()[TOTAL], 250);
  assert.deepEqual(gateway.detailAmounts(), [250], '这一行的实收金额照旧逐行写');
});

test('AC-TA7 反向哨兵（源码）：写入段落在位；全仓只有一处写 `totalAmount`', () => {
  const source = fs.readFileSync(SERVICE_PATH, 'utf8');
  // 删掉写入 ⇒ 这一条 + AC-TA1/4/5/6 一起红。
  assert.ok(source.includes('...(orderAmountsKnown ? { totalAmount: totalCents / 100 } : {}),'),
    '总金额的写入行必须逐字在位（去掉它 ⇒ 这一列永远空着，静默失效）');
  assert.ok(source.includes("logWarn('sales.entry.total_amount.skipped'"),
    '有行缺金额时必须**如实记一条**（不许静默跳过）');
  // 单写入点：全仓 `src/**` 里，只有**一处** `gateway.create/update('salesEntry', …, {…})`
  // 的载荷里带 `totalAmount`（两处各写 = 会漂移）。⚠️ 只认**写入载荷里的键**：
  // 全仓别处也有一个叫 `totalAmount` 的**局部变量 / 返回形状**（券结算 / 待处理单推送），
  // 那些与飞书列无关 ⇒ 不按名字扫全仓（否则会假红）。
  const writers = [];
  for (const file of walkSrc(SRC)) {
    const codeOnly = stripComments(fs.readFileSync(file, 'utf8'));
    for (const call of codeOnly.matchAll(/gateway\.(?:create|update)\(\s*'salesEntry'/g)) {
      const body = objectLiteralAfter(codeOnly, call.index + call[0].length);
      if (/\btotalAmount\s*:/.test(body)) writers.push(path.relative(SRC, file));
    }
  }
  assert.deepEqual(writers, ['services/salesOrderService.js'],
    `「总金额」只许有一个写入点（多了会漂移）：${writers.join('、')}`);
});

test('AC-TA8 成对迁移：`amountsKnown` 收敛成**一个来源**（既有 `owed` 判据一字不动）', () => {
  const source = stripComments(fs.readFileSync(SERVICE_PATH, 'utf8'));
  // 改前逐字（两处各算一遍）：出现在「差额」那一段
  //   `      const amountsKnown = expected.every((item) => item.amountKnown);`
  // 改后逐字：那一段改成引用（下面这一行必须逐字在位）。
  assert.ok(source.includes('const amountsKnown = orderAmountsKnown;'),
    '「差额」那一段必须复用**同一个**判断（改后逐字）');
  assert.equal((source.match(/expected\.every\(\(item\) => item\.amountKnown\)/g) || []).length, 1,
    '`expected.every(...amountKnown)` 只许出现一次（改前是两次 ⇒ 两个来源会漂移）');
  assert.ok(source.includes('const orderAmountsKnown = expected.every((item) => item.amountKnown);'),
    '唯一那个来源必须在「总金额」那一段');
  // 既有判据一字不动（不许因为这次改动放宽/删掉任何一条）。
  assert.ok(source.includes('const outstandingCents = totalCents - paidCents;'),
    '差额算法照旧 = `totalCents - paidCents`（本次一个字节都没动它）');
  assert.ok(source.includes('(amountsKnown ? outstandingCents : 0)'),
    '「累计不可知 ⇒ 不编差额」那一支照旧');
  assert.ok(source.includes('const owedCents = statedOwedCents > 0'),
    '她 2026-10-16 裁的「少付 ⇒ 自动记未收款」那一支照旧');
});
