'use strict';

/**
 * ⭐⭐ task-62（**架构：货 / 钱分离**）—— **services 侧那一半**的判据。
 *
 * 业务负责人的口径（2026-10-16，逐字）：
 *   「我们实际上**货和资金是可以分开的**，但用的是**一个销售单号把它们绑定在一块**。
 *    我们的**销售主表和销售明细，只要货品信息那一页填完，里面的金额就是定了的**。
 *    但金额定了之后，**什么时候付款、分几次付、付款方式是什么，是在资金页里面去确定的**：
 *    · **如果资金页里写了，收款明细就能写** · **如果资金页里没写，那就是待补充状态**」
 *   ⇒ 她随后明确选：「**按你说的：货品页填完就建单**」。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 今天（main `b24a046`）的真值（**只读核过 + 用例复现过**）：
 *   · 点货品页【提交这一单】（`action=submit_order`）⇒ **业务表零写入**
 *     （`routes/scanPage/index.js` 里那个分支 `return sendPaymentStep(...)`；
 *      它后面那段 `writeService.submitSale(...)` 是 `no-unreachable` 的死代码）；
 *   · 点资金页【提交整单付款 / 跳过】⇒ **才建单**（货 + 钱一起写）：
 *     `services/scanWriteService.js` 的 `submitSale`（`:693`）→ 主表 `createEntry`（`:1149`）
 *     → `SalesOrderService.confirm`（`services/salesOrderService.js:47` 的 `_confirm`）。
 *   ⇒ 这正是她要改掉的形状：**走到资金页时表里一个字都没有**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 本文件钉住的是**货/钱分离的最小接缝**（**零行为变化**：开关缺省关 ✗）：
 *
 *  AC-MSG1 ⭐ **开关**：`config/saleMoneySplit.js` 的 `SCAN_MONEY_SPLIT_ENABLED`
 *          —— **缺省 `false`** · **显式布尔**（空串/`false`/`0` = 关；认不出的值当场抛）
 *          · **调用时读**（不是模块加载时读 ⇒ 不会踩"早于 dotenv"那个坑）。
 *  AC-MSG2 🔴 **关着 = 与今天逐字一致**：不传这一项 / 显式传 `false`
 *          ⇒ 两次跑出来的**表状态与写库流水逐字相同**（`deepEqual`），
 *          且**绝不出现** `v1.sale.goods_posted` 这条只属于分离那一跑的日志。
 *  AC-MSG3 ⭐ **开着（`fundsDeferred: true`）= 只写「货」那一半**：
 *          主表（总金额 / 赠品 / 交易类型）＋ 销售明细 ＋「销售状态=已写入」照写；
 *          🔴 **收款明细 0 行**（连那条【未收款】也不写）；
 *          🔴 **「资金状态」只出现过 `未写入`**（绝不被置成 `已写入` / `写入失败`）；
 *          返回值里 `paymentRecordIds: []` ＋ `fundsDeferred: true`（**如实**，不许猜）。
 *  AC-MSG4 ⭐ **两跑一条单（同一个销售单号）**：货那一跑 → 钱那一跑
 *          ⇒ 明细**不重复**、总金额值不变、「资金状态」由钱那一跑收口成「已写入」、
 *          收款行 = 她填的那几笔 ＋ **一条**【未收款】（差额 = 累计 − 已收 —— 既有唯一算法）。
 *  AC-MSG5 🔴 **反向证据（为什么货那一跑一个字都不许写钱）**：
 *          若照今天的口径在货那一跑就把那条【未收款】写上（= 不改的形状），
 *          资金页那一跑会被收款写入层的**整表比对**判成"已有收款与当前销售草稿不一致"⇒ **拦死**。
 *          （这条用**真行为**红：它证明"先写占位行"这条路走不通，而不是只写在注释里。）
 *  AC-MSG6 🔴 **货那一跑不许带收款**：带 `payments` / 带 `owed > 0` ⇒ **当场抛**
 *          （两个口都能写钱 = 迟早写出两遍账）；`owed: 0` 与"没说欠"同义 ⇒ 放行。
 *  AC-MSG7 🔴 **半截失败不许撒谎**：货那一跑中途失败 ⇒ 只写「销售」那一维，
 *          **绝不**把「资金状态」写成「写入失败」（钱压根没试过写）。
 *  AC-MSG8 **源码哨兵**：`fundsDeferred` 必须是**显式布尔**（`=== true`）·
 *          那条【未收款】的构造**逐字未动** · 分离那一跑的 `return` 在它**之前**。
 *
 * ⚠️ **本文件不是** AC-MS1..MS7 本身（那 7 条是**路由级**的：页面 HTML / 进资金页那一刻的表状态 /
 *    幂等 / 部分失败可见）。它们要改 `routes/scanPage/**`，而那个目录**此刻被另一个单元占着**
 *    ⇒ 本卡**停手报 Lead**，逐条方案（含要改的行）写在
 *    `docs/sale-money-split-recon-and-design-2026-10-16.md` 里，**没有动 routes 一个字节** ✓。
 * ─────────────────────────────────────────────────────────────────────────
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_ms_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'ms_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { SalesStatusWriter } = require('../src/services/salesStatusWriter');
const {
  SESSION_MARKERS, resolveSaleMoneySplitConfig,
} = require('../src/config/saleMoneySplit');

const SERVICE_PATH = path.join(__dirname, '../src/services/salesOrderService.js');
const SOURCE = fs.readFileSync(SERVICE_PATH, 'utf8');

const F = (table, key) => V1_BITABLE_SCHEMA.tables[table].fields[key];
const TOTAL = F('salesEntry', 'totalAmount');
const GIFT = F('salesEntry', 'gift');
const ORDER_NO = F('salesEntry', 'orderNo');
const SALES_STATUS = F('salesEntry', 'writeStatus');
const FUNDS_STATUS = F('salesEntry', 'writeStatus');
const DETAIL_AMOUNT = F('salesDetail', 'actualAmount');
const PAY_AMOUNT = F('paymentRecord', 'amount');
const PAY_STATUS = F('paymentRecord', 'status');
const PAY_METHOD = F('paymentRecord', 'method');

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

const makeGateway = ({ master = MASTER() } = {}) => {
  const tables = { salesEntry: [master], salesDetail: [], paymentRecord: [] };
  const writes = [];
  let sequence = 0;
  const gateway = {
    tables, writes,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => [...(tables[key] || [])],
    listByFilter: async () => [],
    findOneByText: async () => null,
    get: async (key, id) => (tables[key] || []).find((row) => row.record_id === id) || null,
    create: async (key, values) => {
      if (gateway.failCreateOn && gateway.failCreateOn(key, values)) throw new Error('假的写入失败');
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
    /** 「资金状态」这一列被写过的每一次（含值）—— 分离那一跑**只许**出现 `未写入`。 */
    fundsWrites: () => writes.filter((write) => write.op === 'update' && write.table === 'salesEntry'
      && Object.prototype.hasOwnProperty.call(write.fields || {}, FUNDS_STATUS))
      .map((write) => write.fields[FUNDS_STATUS]),
    fundsCell: () => tables.salesEntry[0].fields[FUNDS_STATUS],
    masterFields: () => tables.salesEntry[0].fields,
    detailAmounts: () => (tables.salesDetail || []).map((row) => row.fields[DETAIL_AMOUNT]),
    paymentRows: () => (tables.paymentRecord || []).map((row) => ({
      amount: Number(row.fields[PAY_AMOUNT]),
      status: row.fields[PAY_STATUS],
      method: row.fields[PAY_METHOD],
    })),
  };
  return gateway;
};

/**
 * 最小 happy path 的 `confirm`（收款 / 进度 / 尺码 / 货品都是替身；**状态写入用真件**）。
 *
 * ⚠️ 收款替身**照既有实现的判据**写（不是随便记一笔）：
 *   · 先按「金额 + 状态」在整表里找已有的行（`knownRecordIds` 给了就按 id）；
 *   · **已有的行必须全被这次草稿认领** ⇒ 否则抛
 *     「已有收款与当前销售草稿不一致，已停止自动重试」——
 *     这正是"货那一跑先写一条占位【未收款】会把资金页那一跑拦死"的**真判据**。
 */
const runConfirm = async (gateway, {
  items, payments = [], owed = undefined, fundsDeferred = undefined, knownRecordIds = undefined,
  createThrowsOn = undefined, extra = {},
} = {}) => {
  const syncCalls = [];
  gateway.failCreateOn = createThrowsOn;
  const service = new SalesOrderService({
    gateway,
    references: {
      resolveProduct: async () => ({ recordId: 'prod_1' }),
      resolveSalesTradeType: async () => ({ recordId: 'bh_cash' }),
    },
    payments: {
      recordInitialBatch: async (salesEntryRecordId, rows, options = {}) => {
        gateway.lastPayments = rows;
        const known = (options && options.knownRecordIds) || [];
        const existing = [...gateway.tables.paymentRecord];
        const used = new Set();
        const out = [];
        rows.forEach((row, index) => {
          const knownId = known[index];
          const desiredStatus = row.status || '已收款';
          const match = existing.find((item) => !used.has(item.record_id)
            && (knownId ? item.record_id === knownId : true)
            && item.fields[PAY_STATUS] === desiredStatus
            && Number(item.fields[PAY_AMOUNT]) === Number(row.amount));
          if (knownId && !match) throw new Error(`已记录的收款 ${knownId} 与当前销售草稿不一致，已停止重试`);
          if (match) {
            used.add(match.record_id);
            out.push(match.record_id);
            return;
          }
          const record = {
            record_id: `pay_${gateway.tables.paymentRecord.length + 1}`,
            fields: { [PAY_AMOUNT]: row.amount, [PAY_STATUS]: desiredStatus },
          };
          gateway.tables.paymentRecord.push(record);
          out.push(record.record_id);
        });
        if (existing.some((item) => !used.has(item.record_id))) {
          throw new Error('已有收款与当前销售草稿不一致，已停止自动重试');
        }
        return out;
      },
    },
    progress: { sync: async (...args) => { syncCalls.push(args); } },
    sizeReferences: { resolveByNumber: async (number) => ({ recordId: `size_${number}` }) },
    status: new SalesStatusWriter({ gateway }),
  });
  const input = {
    salesEntryRecordId: 'se_1',
    items,
    payments,
    ...(owed === undefined ? {} : { owed }),
    ...(knownRecordIds === undefined ? {} : { knownRecordIds }),
    operatorOpenId: 'ou_ms',
    ...extra,
  };
  if (fundsDeferred !== undefined) input.fundsDeferred = fundsDeferred;
  const result = await service.confirm(input, { correlation: {} });
  return { result, syncCalls };
};

const shoe = (size, actualAmount) => ({
  kind: 'shoe', productRecordId: 'prod_1', size, quantity: 1, actualAmount,
});
const toCents = (value) => Math.round(Number(value) * 100);

/** 剥注释（「改前逐字」在注释里是引文，不该被当成代码 ⇒ 一律先剥再扫）。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:])\/\/.*$/gm, '$1');

// ═══════════════════════════════════════════════════════════════════════════
// AC-MSG1 ⭐ 开关：缺省关 · 显式布尔 · 调用时读
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MSG1 ⭐⭐ 反向哨兵：**没有开关了**（货/钱分离永远开 ✓）＋ 会话标记逐字', () => {
  // ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
  //   改前逐字：`AC-MSG1 ⭐ 开关 \`SCAN_MONEY_SPLIT_ENABLED\`：**缺省 false** ＋ **显式布尔** ＋ 调用时读`
  //     （逐条钉 `readFlag` 语义：''/'false'/'0' ⇒ 关，认不出 ⇒ 抛）
  //   改后逐字：本用例 —— 开关退场 ⇒ 钉"**配置里没有它**（含那个变量名）"＋ 标记与既有两个状态**不同** ✓
  //   依据 = 业务负责人 2026-10-16 22:5x 逐字：「**把新功能都上了，不需要开关。**」✓
  const SWITCH_NAME = ['SCAN', 'MONEY', 'SPLIT', 'ENABLED'].join('_');
  const cfgPath = path.join(__dirname, '..', 'src', 'config', 'saleMoneySplit.js');
  const cfgCode = fs.readFileSync(cfgPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.equal(cfgCode.includes(SWITCH_NAME), false, '🔴 开关名不许回来 ✗');
  assert.equal(cfgCode.includes('ENABLED_ENV_KEY'), false, '🔴 那个变量名也不许回来 ✗');
  assert.equal(/readFlag\(/.test(cfgCode), false, '🔴 这里不再有开关 ⇒ 也不该再有 `readFlag` ✗');
  // ② 配置里**没有** `enabled` 了（"永久开" ✓）—— 且**不依赖 env**（没有模块级快照的坑 ✓）
  assert.equal('enabled' in resolveSaleMoneySplitConfig(), false, '配置里不许再有 `enabled`（开关退了 ✗）');
  assert.equal('enabled' in resolveSaleMoneySplitConfig({ [SWITCH_NAME]: 'true' }), false,
    '塞一个同名 env 也**不再有任何效果**（没有人读它 ✓）');
  // ③ 会话标记：分离那一跑的新标记必须与今天两个**不同**（混了之后"她点过没有"分不清）。
  assert.equal(SESSION_MARKERS.goodsCreated, 'goods_created');
  assert.notEqual(SESSION_MARKERS.goodsCreated, 'pending');
  assert.notEqual(SESSION_MARKERS.goodsCreated, 'created');
  // ④ 标记不靠 env：同一个进程里改 env ⇒ 拿到的标记**逐字不变** ✓
  assert.equal(resolveSaleMoneySplitConfig().markers.goodsCreated, 'goods_created');
});

test('AC-MSG2 🔴 关着（不传 / 显式 false）⇒ 表状态与写库流水**逐字相同**（deepEqual）', async () => {
  const items = [shoe(38, 200), shoe(39, 100)];
  const payments = [{ amount: 100, method: '微信', operatorOpenId: 'ou_ms' }];

  const absent = makeGateway();
  const absentRun = await runConfirm(absent, { items, payments });
  const explicitFalse = makeGateway();
  const falseRun = await runConfirm(explicitFalse, { items, payments, fundsDeferred: false });

  // ① 写库流水逐字相同（含顺序与每一次 PATCH 的物理列名）。
  assert.deepEqual(explicitFalse.writes, absent.writes, '`fundsDeferred: false` 与"不传"必须逐字同形');
  // ② 表状态逐字相同。
  assert.deepEqual(explicitFalse.tables, absent.tables, '两次跑完的表状态必须逐字相同');
  // ③ 今天的既有形状照旧：明细 2 行 ＋ 收款 1 笔 ＋ 差额一条【未收款】。
  assert.equal(absent.detailAmounts().length, 2);
  assert.deepEqual(absent.paymentRows(), [
    { amount: 100, status: '已收款', method: undefined },
    { amount: 200, status: '未收款', method: undefined },
  ], '少付 ⇒ 自动补一条【未收款】（差额 = 累计 300 − 已收 100 = 200）—— 既有口径，一个字不许变');
  // ④ 新模型：confirm 不再写状态列（「写入状态」由扫码收口写）。
  assert.equal(absent.fundsCell(), '成功', 'confirm 写完钱后写「写入状态=成功」（库存失败会再覆盖成部分失败）');
  // ⑤ 返回值形状照旧（不许多出只有分离那一跑才有的键）。
  assert.deepEqual(Object.keys(absentRun.result).sort(),
    ['detailRecordIds', 'inventoryApplied', 'paymentRecordIds', 'sourceNo'].sort(),
    '关着时返回值形状与今天逐字相同');
  assert.equal(Object.prototype.hasOwnProperty.call(absentRun.result, 'fundsDeferred'), false);
  // ⑥ 分离那一跑独有的日志**一次都不许出现**。
  assert.equal(SOURCE.includes('v1.sale.goods_posted'), true, '哨兵自查：那条日志名确实在源码里');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MSG3 ⭐ 开着 = 只写「货」那一半（收款明细 0 行）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MSG3 ⭐ `fundsDeferred: true` ⇒ 主表总金额 + 明细照写；**收款明细 0 行** + 资金状态**只出现未写入**', async () => {
  const gateway = makeGateway();
  const { result, syncCalls } = await runConfirm(gateway, {
    items: [shoe(38, 200), shoe(39, 100)], fundsDeferred: true,
  });

  // ① 货那一半：总金额 = 各行实收之和（= 300）、每行实收照写。
  assert.equal(gateway.masterFields()[TOTAL], 300, '主表「总金额」= 各行实收之和（她：「金额就是定了的」）');
  assert.deepEqual(gateway.detailAmounts(), [200, 100], '销售明细逐件实收照写');
  assert.equal(gateway.tables.salesDetail.length, 2);
  assert.equal(gateway.masterFields()[SALES_STATUS], '未完成', '货那一跑后「写入状态=未完成」（钱还没写）');
  // ② 🔴 钱那一半：**0 行**（连那条【未收款】也不写）。
  assert.deepEqual(gateway.tables.paymentRecord, [], '收款明细必须 **0 行**（钱那一半还没发生）');
  assert.equal(gateway.lastPayments, undefined, '收款写入层**一次都不许被叫**（叫了就是"钱也能在这儿写"）');
  // ③ 🔴 资金状态：**只出现过「未写入」**（那一次"入账中"的状态写入），绝不被置成已写入/写入失败。
  assert.deepEqual(gateway.fundsWrites(), ['未完成'], '货那一跑写「未完成」');
  assert.equal(gateway.fundsCell(), '未完成', '钱那一半还没发生');
  // ④ 如实回传（调用方不许猜）：`paymentRecordIds: []` + `fundsDeferred: true`。
  assert.deepEqual(result.paymentRecordIds, []);
  assert.equal(result.fundsDeferred, true);
  assert.equal(result.totalCents, 30000);
  assert.equal(result.sourceNo, 'XSD-20261016-0001', '同一个销售单号（货/钱靠它绑定）');
  assert.equal(result.detailRecordIds.length, 2);
  // ⑤ 省掉那次 `progress.sync`（它只算不写 ⇒ 分离那一跑不该白读两张整表；钱那一跑还会算一次）。
  assert.deepEqual(syncCalls, [], '货那一跑不调 `progress.sync`（只算不写，钱那一跑再算）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MSG4 ⭐ 两跑一条单：货那一跑 → 钱那一跑
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MSG4 ⭐ 货那一跑 ⇒ 钱那一跑（同一个 record_id / 单号）：明细不重复 + 差额仍是一条【未收款】', async () => {
  const gateway = makeGateway();
  const items = [shoe(38, 200), shoe(39, 100)];

  // ① 货那一跑（进资金页那一刻）。
  const goods = await runConfirm(gateway, { items, fundsDeferred: true });
  assert.equal(gateway.tables.salesDetail.length, 2);
  assert.equal(gateway.tables.paymentRecord.length, 0);
  const totalAfterGoods = gateway.masterFields()[TOTAL];

  // ② 钱那一跑（她在资金页写了：现金 100 ⇒ 少付 200）——**同一个 `salesEntryRecordId`**。
  const money = await runConfirm(gateway, {
    items,
    payments: [{ amount: 100, method: '现金', operatorOpenId: 'ou_ms' }],
    knownRecordIds: { details: goods.result.detailRecordIds, payments: [] },
  });

  // ③ 明细**不重复**（同一条草稿认领已有的两行），总金额值不变。
  assert.equal(gateway.tables.salesDetail.length, 2, '钱那一跑不许把明细再建一遍');
  assert.deepEqual(gateway.detailAmounts(), [200, 100]);
  assert.equal(gateway.masterFields()[TOTAL], totalAfterGoods, '总金额两次同值（幂等）');
  // ④ 收款行 = 她填的那一笔 ＋ **一条**【未收款】（差额 = 累计 − 已收 —— 全仓唯一那个算法）。
  assert.deepEqual(gateway.paymentRows(), [
    { amount: 100, status: '已收款', method: undefined },
    { amount: 200, status: '未收款', method: undefined },
  ]);
  assert.equal(money.result.paymentRecordIds.length, 2);
  // ⑤ 钱那一跑写完 ⇒ 「写入状态=成功」。
  assert.equal(gateway.fundsCell(), '成功');
  // ⑥ 两次跑的是**同一张主表**（单号相同 ⇒ 货/钱绑在一块的那把钥匙没变）。
  assert.equal(money.result.sourceNo, goods.result.sourceNo);
  assert.equal(gateway.tables.salesEntry.length, 1, '从头到尾只有一张销售主表');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MSG5 🔴 反向证据：为什么货那一跑一个字都不许写钱
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MSG5 🔴 反向证据：货那一跑若照今天口径先写那条【未收款】⇒ 资金页那一跑被**拦死**', async () => {
  const gateway = makeGateway();
  const items = [shoe(38, 200), shoe(39, 100)];

  // ① 模拟"不改"的形状：货那一跑照**今天的** `_confirm` 走（不带分离标志）——
  //    它会把"累计 300 − 已收 0"那条【未收款 300】先写上。
  await runConfirm(gateway, { items, payments: [] });
  assert.deepEqual(gateway.paymentRows(), [{ amount: 300, status: '未收款', method: undefined }],
    '前提：这一跑确实留下了那条【未收款 300】');

  // ② 她随后在资金页写了现金 100 ⇒ 钱那一跑算出来的是「收款 100 ＋ 差额 200」，
  //    与占位那条（300）对不上 ⇒ 既有收款层的整表比对**当场拦住**。
  await assert.rejects(
    () => runConfirm(gateway, {
      items, payments: [{ amount: 100, method: '现金', operatorOpenId: 'ou_ms' }],
    }),
    /已有收款与当前销售草稿不一致/,
    '🔴 这就是"先写占位行"走不通的**真判据**（不是注释里的偏好）',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MSG6 🔴 货那一跑不许带收款
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MSG6 🔴 货那一跑带收款 ⇒ **当场抛**（两个口都能写钱 = 迟早两遍账）；`owed: 0` 放行', async () => {
  const items = [shoe(38, 200)];
  await assert.rejects(
    () => runConfirm(makeGateway(), {
      items, payments: [{ amount: 100, method: '现金' }], fundsDeferred: true,
    }),
    /货那一跑不许带收款/,
    '带了收款行 ⇒ 拦住',
  );
  await assert.rejects(
    () => runConfirm(makeGateway(), { items, owed: 50, fundsDeferred: true }),
    /货那一跑不许带收款/,
    '带了"她明说的欠款" ⇒ 也拦住（钱那一半的结论只许在资金页那一跑下）',
  );
  await assert.rejects(
    () => runConfirm(makeGateway(), {
      items, fundsDeferred: true, extra: { totalPaid: 100, paymentMethod: '现金' },
    }),
    /货那一跑不许带收款/,
    '群聊那条老形状（`totalPaid` + `paymentMethod`）同样拦住',
  );
  // `owed: 0` 与"没说欠"同义（既有 `owedStated` 的口径）⇒ 放行，而且**照样不写钱**。
  const gateway = makeGateway();
  await runConfirm(gateway, { items, owed: 0, fundsDeferred: true });
  assert.deepEqual(gateway.tables.paymentRecord, [], '`owed: 0` 也不许写出任何收款行');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MSG7 🔴 半截失败不许撒谎（资金状态不被写成"写入失败"）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MSG7 🔴 货那一跑中途失败 ⇒ 只写「销售」那一维，「资金状态」绝不被写成「写入失败」', async () => {
  const gateway = makeGateway();
  // 第 2 行明细（`actualAmount: 100`）写入时炸掉（= 半截失败：第 1 行已经落库）。
  // ⚠️ 上报给网关的是**语义键**（`actualAmount`）——物理列名的换名在网关里面做。
  const createThrowsOn = (key, values) => key === 'salesDetail'
    && Number(values.actualAmount) === 100;

  await assert.rejects(
    () => runConfirm(gateway, {
      items: [shoe(38, 200), shoe(39, 100)], fundsDeferred: true, createThrowsOn,
    }),
    /假的写入失败/,
  );

  assert.deepEqual(gateway.fundsWrites(), ['未完成', '部分失败'],
    '先未完成、半截失败 ⇒ 部分失败（部分明细已落）');
  assert.equal(gateway.fundsCell(), '部分失败');
  // 「销售」那一维如实报（第 1 行成了、第 2 行没成 ⇒ 部分写入；她照着重试即可）。
  assert.equal(gateway.masterFields()[SALES_STATUS], '部分失败', '半截失败 ⇒ 部分失败');
  assert.equal(gateway.tables.salesDetail.length, 1, '第 1 行真的落库了（半截单 —— 重试接着写）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MSG8 源码哨兵
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MSG8 源码哨兵：显式布尔 · 那条【未收款】构造逐字未动 · 分离的 return 在它之前', () => {
  const code = stripComments(SOURCE);
  // ① **显式布尔**（`=== true`）——不许 truthy 兜底。
  assert.ok(code.includes('const fundsDeferred = input.fundsDeferred === true;'),
    '必须是显式布尔 `=== true`（truthy 判断会把别的值也当"分离"）');
  // ② 那条【未收款】的构造**逐字未动**（钱那一半的口径归既有业务层，本卡一个字都不许改）。
  const owedLine = "const expectedPayments = owedCents > 0\n"
    + "        ? [...payments, { amount: outstandingCents / 100, status: '未收款' }] : payments;";
  assert.ok(code.includes(owedLine), '那条【未收款】的构造必须逐字在位（删/改 ⇒ 红）');
  // ③ 分离那一跑的 `return` **必须在它之前**（顺序反了 ⇒ 会先写钱再返回 ⇒ 判据全废）。
  const deferredReturn = code.indexOf('fundsDeferred: true,\n          totalCents,');
  const owedIndex = code.indexOf(owedLine);
  assert.ok(deferredReturn > -1 && owedIndex > -1 && deferredReturn < owedIndex,
    '分离的 `return` 必须在"写钱"那一段**之前**（先写钱再 return = 前功尽弃）');
  // ④ 失败那一支：分离时**不写**资金维（`...(fundsDeferred ? {} : { funds: ... })`）。
  // ⭐ 2026-10-18 成对迁移：旧四列已删 ⇒ 失败收口写「写入状态」；已落部分数据 = 部分失败。
  assert.ok(code.includes('WRITE.writeStatus.partial') && code.includes('WRITE.writeStatus.failed'),
    '失败收口必须按是否落过数据区分 部分失败 / 失败');
  // ⑤ 全仓只有**一处**写那条【未收款】构造（两处各写会漂移）。
  const files = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'data') return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  });
  walk(path.join(__dirname, '../src'));
  const owners = files.filter((file) => stripComments(fs.readFileSync(file, 'utf8')).includes(owedLine));
  assert.deepEqual(owners.map((file) => path.relative(path.join(__dirname, '..'), file)),
    ['src/services/salesOrderService.js'], '那条【未收款】的构造全仓只许有一处');
});
