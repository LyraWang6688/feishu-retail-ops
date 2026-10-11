/**
 * 🔴🔴 扫码会话**过期后不能是死路** —— 真机 bug 的验收标准（业务负责人 2026-10-12 现场）。
 *
 * 现场（服务器日志，UTC）：
 * ```
 * 17:48:39Z GET  /8953|黑色|A → 200   17:49:15Z POST → **400**（本单已过期）
 * 17:49:44Z GET  → 200                17:51:18Z POST → **400**
 * 17:51:57Z GET  → 200                17:52:08Z POST → **400**
 * ```
 * 她的原话：「我刚才又提交了两个，但是它都是同样的提醒，**我应该怎么刷新呢？**」
 * ⇒ ⭐ **页面打得开（200）、一提交就 400，刷新/重扫都没用** —— 这不是"她用了旧页面"，
 *    是**过期会话没有退路**。
 *
 * 根因（先只读核过）：`services/scanWriteService.js` 的 `submitSale` 一开头就是
 * ```js
 * let current = await sessions.get(openId);
 * if (!current) current = await sessions.ensure(openId);
 * if (current.expired) return fail('session_expired');   // ← 过期就拒，从不续上
 * ```
 * 而 `scanSessionService.ensure()` **本来就会**在过期时新建一份（`addLine`/`clearSale` 都走它）
 * ⇒ 只有"提交"这一步被那条判据堵死；页面渲染走 `sessions.get()`（只读）⇒ 页面照旧 200。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-EX1 ⭐ **过期会话 + 提交 ⇒ 自动续上并成功**（她的草稿**不丢**）：造一份 `expires_at`
 *         已过、且本单里有 2 双的会话 ⇒ 提交 ⇒ **成单**（主表 1 条、明细 2 行），不再 400。
 *  AC-EX2 ⭐ **过期后页面下发的那把 key 仍然可用**：渲染页面拿到的 `submit_key` 直接 POST 提交
 *         ⇒ 成功（**不换 key** —— 换 key 会让她手上那一页连同草稿一起作废；续期 + 采纳她带来的
 *         key 才是既不 400 又不丢东西的那条路）。
 *  AC-EX3 ⭐ **TTL 默认 12 小时 + 可配**：`config/scanWrite.js` 的 `session.ttlMs` 默认 12h，
 *         `SCAN_SESSION_TTL_MS` 能改（她实测会挂 8 小时 ⇒ 原来的 6h 不够）。
 *  AC-EX4 **没过期的会话行为一字不变**：key 不变、加单继续累积、提交成功后键轮换到下一轮。
 *  AC-EX5 ⭐ **【清空本单】= 零 JS 的"重新开始这一单"**：过期会话点它 ⇒ 会话立刻可用，
 *         再加一双就能提交成功（她照"刷新"做了没用，得有个真能点的出口）。
 *  AC-EX6 🔴 **续上时不许重复建单**：过期会话里**已经落过** `master_record_id`（提交写到一半
 *         失败那种）⇒ 续上后提交必须**接着同一张主表**写，绝不再建一张（否则一笔货两条单）。
 *  AC-EX7 **过期且本单是空的 ⇒ 给人话**（「本单还没有明细…」），不是"过期，请刷新"那种死循环。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_expiry_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_expiry_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE, PAYMENT_STATUS } = require('../src/config/scanWrite');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const NUMBER = 'YD6693-2|黑色|A';

// ── 夹具（与 scanSaleE2E 同一套形状；只留这条链路要用的表）────────────────────
const F = (table, key) => {
  const name = V1_BITABLE_SCHEMA.tables[table].fields[key];
  if (!name) throw new Error(`schema 里没有 ${table}.${key}`);
  return name;
};
const seedTables = () => ({
  product: [{
    record_id: 'prod_a',
    fields: {
      [F('product', 'number')]: NUMBER,
      [F('product', 'itemNo')]: 'YD6693-2',
      [F('product', 'color')]: { text: '黑色', record_ids: ['color_black'] },
      [F('product', 'category')]: 'A',
      [F('product', 'price')]: 399,
      [F('product', 'supplier')]: ['sup_1'],
    },
  }],
  sizeManagement: [40, 41].map((size) => ({ record_id: `size_${size}`, fields: { [F('sizeManagement', 'size')]: size } })),
  liveInventory: [{
    record_id: 'live_a_40_box',
    fields: {
      [F('liveInventory', 'product')]: ['prod_a'],
      [F('liveInventory', 'size')]: ['size_40'],
      [F('liveInventory', 'state')]: '门盒',
      [F('liveInventory', 'stockKey')]: `${NUMBER}|40`,
    },
  }],
  inventoryLedger: [],
  behavior: [
    { record_id: 'bh_cash', fields: { [F('behavior', 'name')]: '现货', [F('behavior', 'code')]: 'SALE_CASH' } },
    { record_id: 'bh_prepaid', fields: { [F('behavior', 'name')]: '预定', [F('behavior', 'code')]: 'SALE_PREPAID' } },
    {
      record_id: 'bh_sale_decrease',
      fields: {
        [F('behavior', 'name')]: '销售减少',
        [F('behavior', 'code')]: 'STOCK_SALE_DECREASE',
        [F('behavior', 'stockDirection')]: '减少',
        [F('behavior', 'enabled')]: true,
      },
    },
  ],
  paymentMethod: [{ record_id: 'pm_wechat', fields: { [F('paymentMethod', 'name')]: '微信' } }],
  salesEntry: [],
  salesDetail: [],
  paymentRecord: [],
});

const fakeGateway = (tables = seedTables()) => {
  let sequence = 0;
  const physical = (tableKey, semanticValues) => {
    const table = V1_BITABLE_SCHEMA.tables[tableKey];
    const out = {};
    for (const [key, value] of Object.entries(semanticValues || {})) {
      const name = table.fields[key];
      if (!name) throw new Error(`“${table.tableName}”未配置语义字段: ${key}`);
      if (value !== undefined) out[name] = value;
    }
    return out;
  };
  return {
    _tables: tables,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => [...(tables[key] || [])],
    listByFilter: async () => { throw new Error('假网关不支持 filter'); },
    get: async (key, id) => (tables[key] || []).find((row) => row.record_id === id) || null,
    findOneByText: async (key, semanticKey, expected) => {
      const name = V1_BITABLE_SCHEMA.tables[key].fields[semanticKey];
      const target = String(expected ?? '').trim();
      return (tables[key] || []).find((row) => String(row.fields?.[name] ?? '').trim() === target) || null;
    },
    create: async (key, values) => {
      sequence += 1;
      const fields = physical(key, values);
      const record = { record_id: `${key}_${sequence}`, fields };
      tables[key] = [...(tables[key] || []), record];
      return { recordId: record.record_id, record };
    },
    update: async (key, id, values) => {
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (!record) throw new Error(`记录不存在: ${key}/${id}`);
      Object.assign(record.fields, physical(key, values));
      return record;
    },
    // 卖出一双 ⇒ 既有库存引擎会**删掉**「实时库存」那条记录；别的表一律不许删。
    delete: async (key, id) => {
      if (key !== 'liveInventory') throw new Error(`测试网关：扫码侧不许删 ${key}`);
      tables[key] = (tables[key] || []).filter((row) => row.record_id !== id);
      return { deleted: true };
    },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `scan-expiry-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/** 一套真链路；`clock` 可以往前拨（模拟"她挂了 8 小时"）。 */
const createHarness = (options = {}) => {
  const gateway = fakeGateway(options.tables || seedTables());
  const sessionDir = tempDir('session');
  const dirs = { sessionDir, inventoryDir: tempDir('inv'), replenishDir: tempDir('rep') };
  let clock = options.now ? options.now() : Date.now();
  const now = () => clock;
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir, now });
  const inventory = new InventoryService({
    gateway, store: new JsonTaskStore({ dir: dirs.inventoryDir, idField: 'operation_id' }),
  });
  const write = createScanWriteService({
    gateway, sessions, now,
    delivery: new SalesDeliveryService({ gateway, inventory }),
    purchase: {},
    purchaseStore: new JsonTaskStore({ dir: dirs.replenishDir, idField: 'task_id' }),
  });
  return {
    gateway, sessions, write, tables: gateway._tables,
    advance: (ms) => { clock += ms; },
    setClock: (value) => { clock = value; },
    cleanup: () => Object.values(dirs).forEach(rmDir),
  };
};

const addShoe = (h, openId, overrides = {}) => h.write.addSaleLine({
  openId, requestId: 'req_add', productRecordId: 'prod_a', number: NUMBER, itemNo: 'YD6693-2',
  color: '黑色', size: 40, inStock: true, ...overrides,
});
const entriesOf = (h, table) => h.tables[table] || [];
const rawSession = (h, openId) => h.sessions.store.get(h.sessions.idOf(openId));
/** 把会话的 `expires_at` 直接改到过去（= 她挂了很久那种形态）。 */
const expireSession = async (h, openId) => {
  // ⚠️ 直接把 `expires_at` 拨到**现在之前**（不是"比原值早一分钟"——TTL 现在是 12h，
  //    那样根本还没过期）。
  const past = new Date(Date.now() - 60_000).toISOString();
  await h.sessions.store.update(h.sessions.idOf(openId), { expires_at: past });
  const after = await h.sessions.get(openId);
  assert.equal(after.expired, true, '夹具前提：这一份会话现在**是过期的**');
  return after;
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-EX1 ⭐ 过期会话 + 提交 ⇒ 自动续上并成功（草稿不丢）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-EX1 ⭐ 过期会话 + 提交 ⇒ 自动续上并**成单**（她的 2 双不丢），不再 400', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_ex_1';
    await addShoe(h, openId, { size: 40 });        // 现货
    await addShoe(h, openId, { size: 41, inStock: false });   // 预订（店里没货）
    const key = (await h.sessions.get(openId)).sale.key;
    const expired = await expireSession(h, openId);
    assert.equal(expired.sale.lines.length, 2, '过期会话里那 2 双还在（夹具前提）');

    const result = await h.write.submitSale({
      openId, submitKey: key, paymentStatus: PAYMENT_STATUS.unpaid,
    });
    assert.equal(result.ok, true,
      `第1步：过期之后提交也必须成功（她真机卡的就是这一步）：${JSON.stringify(result)}`);
    assert.equal(result.code, undefined, '不再是 session_expired');
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '第2步：成了一张单');
    assert.equal(entriesOf(h, 'salesDetail').length, 2, '第2步：两双都在明细里（草稿没丢）');
    assert.match(result.order_no, /^XSD-\d{8}-\d{4}$/, '第3步：单号照旧自动生成');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-EX2 ⭐ 过期后页面下发的那把 key 仍然可用（不换 key）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-EX2 ⭐ 过期后页面下发的 key 仍然可用：拿页面那把 key 直接提交 ⇒ 成功', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_ex_2';
    await addShoe(h, openId, { size: 40 });
    await expireSession(h, openId);

    // 她那一页（过期会话）渲染出来的 key —— 与页面完全同一处取（`submitKeyFor`）
    const pageSession = await h.sessions.get(openId);
    const pageKey = h.sessions.submitKeyFor(openId, pageSession, 'sale');
    assert.equal(pageKey, pageSession.sale.key, '页面下发的就是这一份会话当前那一轮的键');

    const result = await h.write.submitSale({
      openId, submitKey: pageKey, paymentStatus: PAYMENT_STATUS.unpaid,
    });
    assert.equal(result.ok, true,
      `过期后页面那把 key 必须还能用（她不会再去复制一把新 key）：${JSON.stringify(result)}`);
    assert.equal(entriesOf(h, 'salesEntry').length, 1);
    // 续上之后：**同一把 key 没变**（换 key 会让她手上那一页连同草稿一起作废）
    const afterRevive = await h.sessions.get(openId);
    assert.equal(afterRevive.expired, false, '续上之后这一份会话不再是过期的');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-EX3 ⭐ TTL 默认 12 小时 + 可配
// ═══════════════════════════════════════════════════════════════════════════

test('AC-EX3 ⭐ 会话 TTL：默认 **12 小时**，`SCAN_SESSION_TTL_MS` 可配（她实测会挂 8 小时）', async () => {
  assert.equal(SCAN_WRITE.session.ttlMs, 12 * 60 * 60 * 1000,
    '默认 TTL 必须是 12 小时（改前 6 小时 —— 她挂 8 小时就过期了）');
  // 配置先行：环境变量能改（显式数值，不是 `||` 兜底那种关不掉的写法）
  const configPath = require.resolve('../src/config/scanWrite.js');
  const saved = { ttl: process.env.SCAN_SESSION_TTL_MS };
  try {
    process.env.SCAN_SESSION_TTL_MS = String(3 * 60 * 60 * 1000);
    delete require.cache[configPath];
    const reloaded = require('../src/config/scanWrite.js').SCAN_WRITE;
    assert.equal(reloaded.session.ttlMs, 3 * 60 * 60 * 1000, '环境变量能改它');
  } finally {
    if (saved.ttl === undefined) delete process.env.SCAN_SESSION_TTL_MS;
    else process.env.SCAN_SESSION_TTL_MS = saved.ttl;
    delete require.cache[configPath];
    require('../src/config/scanWrite.js');
  }
  // 会话文件的 `expires_at` 就是按 TTL 写的
  const h = createHarness();
  try {
    const before = Date.now();
    await addShoe(h, 'ou_ex_3');
    const raw = await rawSession(h, 'ou_ex_3');
    const ttl = Date.parse(raw.expires_at) - before;
    assert.ok(ttl > 11.9 * 60 * 60 * 1000 && ttl <= 12 * 60 * 60 * 1000 + 1000,
      `新建会话的 expires_at 应该 ≈ 12 小时后（实际 ${Math.round(ttl / 60000)} 分钟）`);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-EX4 没过期的会话行为一字不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC-EX4 没过期的会话行为**一字不变**：加单累积、提交后键轮换到下一轮', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_ex_4';
    await addShoe(h, openId);
    const before = await h.sessions.get(openId);
    assert.equal(before.expired, false);
    const key = before.sale.key;
    assert.match(key, /^scan_sale:scan_session_[0-9a-f]{16}:1$/, '第 1 轮的键');

    const added = await addShoe(h, openId, { size: 41, inStock: false });
    assert.equal(added.count, 2, '加单继续累积');

    const result = await h.write.submitSale({ openId, submitKey: key, paymentStatus: PAYMENT_STATUS.unpaid });
    assert.equal(result.ok, true, JSON.stringify(result));
    const after = await h.sessions.get(openId);
    assert.equal(after.sale.key, 'scan_sale:scan_session_' + after.session_id.replace('scan_session_', '') + ':2',
      '提交成功后键轮换到第 2 轮（既有行为不变）');
    assert.equal(after.sale.lines.length, 0, '本单归零');
    assert.equal(after.sale.completed.length, 1, '结果留档（连点两次用得上）');

    // 同一把 key 再点一次 ⇒ 还是"已经提交过了"，不写第二遍
    const again = await h.write.submitSale({ openId, submitKey: key, paymentStatus: PAYMENT_STATUS.unpaid });
    assert.equal(again.reused, true);
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '只写一次');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-EX5 ⭐ 【清空本单】= 零 JS 的"重新开始这一单"
// ═══════════════════════════════════════════════════════════════════════════

test('AC-EX5 ⭐【清空本单】是零 JS 的"重新开始这一单"：过期后点它 ⇒ 立刻能再加单、能提交', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_ex_5';
    await addShoe(h, openId);
    await expireSession(h, openId);

    const cleared = await h.write.clearDraft({ openId, requestId: 'req_clear' });
    assert.equal(cleared.ok, true, '清空本单要成功');
    const afterClear = await h.sessions.get(openId);
    assert.equal(afterClear.expired, false, '清空之后这一份会话**立刻可用**（不再过期）');
    assert.equal(afterClear.sale.lines.length, 0, '本单清空了');

    // 她接着扫一双、提交 ⇒ 成功
    const added = await addShoe(h, openId);
    assert.equal(added.ok, true);
    const key = (await h.sessions.get(openId)).sale.key;
    const result = await h.write.submitSale({ openId, submitKey: key, paymentStatus: PAYMENT_STATUS.unpaid });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(entriesOf(h, 'salesEntry').length, 1);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-EX6 🔴 续上时不许重复建单（提交写到一半失败那种）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-EX6 🔴 过期会话里已经落过 master_record_id ⇒ 续上后**接着同一张主表**写（不重复建单）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_ex_6';
    await addShoe(h, openId);
    // 造"提交写到一半失败"的形态：**主表已经建出来了**（订单号已分配），然后就过期了。
    // ⚠️ 刻意**不**造明细行：明细由既有业务层按草稿写，夹具硬塞一条反而会与草稿比对不一致
    //    （那测的就不是这条 AC 了）。
    const key = (await h.sessions.get(openId)).sale.key;
    const created = await h.gateway.create('salesEntry', {
      orderNo: 'XSD-20261012-9999', sender: [openId],
    });
    await h.sessions.saveSaleProgress(openId, {
      master_record_id: created.recordId,
      order_no: 'XSD-20261012-9999',
    });
    await expireSession(h, openId);

    const result = await h.write.submitSale({ openId, submitKey: key, paymentStatus: PAYMENT_STATUS.unpaid });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(entriesOf(h, 'salesEntry').length, 1,
      '🔴 必须接着那张已建的主表写 —— 过期续上**绝不许**再建一张（一笔货两条单）');
    assert.equal(result.sales_entry_record_id, created.recordId, '用的就是会话里落过的那张主表');
    assert.equal(result.order_no, 'XSD-20261012-9999');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-EX7 过期且本单是空的 ⇒ 给人话（不是"过期，请刷新"死循环）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-EX7 过期 + 本单是空的 ⇒ 人话是"本单还没有明细"，不是"过期、请刷新"', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_ex_7';
    await addShoe(h, openId);
    const key = (await h.sessions.get(openId)).sale.key;
    await h.write.clearDraft({ openId, requestId: 'req_clear' });   // 本单清空 ⇒ 0 双
    await expireSession(h, openId);

    const result = await h.write.submitSale({ openId, submitKey: key, paymentStatus: PAYMENT_STATUS.unpaid });
    assert.equal(result.ok, false, '没有明细当然成不了单');
    assert.equal(result.code, 'session_empty',
      '⚠️ 要指得出"能做的事"：本单还没有明细 ⇒ 先加入本单；**不许**再回"过期，请刷新这一页"'
      + '（她照那个做了三遍都没用 —— 那正是这次要修的坑）');
    assert.equal(entriesOf(h, 'salesEntry').length, 0);
  } finally { h.cleanup(); }
});
