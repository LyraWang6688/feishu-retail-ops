'use strict';

/**
 * salesEntryReadOnlyFields.test.js —— 「金额核对」（**type 19 · Lookup · 只读**）的登记与**写白名单**哨兵
 *
 * 她的原话（2026-10-16 逐字）：
 * > 「我加了一个在**销售主表**里面加了一个**查找引用字段**。它是多维表格的**自动字段**，
 * >  叫做「**金额核对**」，是为了**判断你的累计金额有没有填对**。」
 *
 * ## 为什么要这份判据（Lead 裁决 Ⓐ ✓）
 * 本仓的"**可写字段集**"**就是** `v1BitableSchema.tables.salesEntry.fields` 的**键名本身** ——
 * 逐字证据（`services/salesStatusWriter.js:16`）：
 * > `// 允许写的语义键（= v1BitableSchema.tables.salesEntry.fields 里的键名）。`
 * 而 type **19**（ui `Lookup`）是**只读**的 ✗ ⇒ 若把「金额核对」登记进 `fields`，
 * 就等于**把它变成"可写"** ⇒ 哪条路径按白名单整表写 ⇒ **写 Lookup ⇒ 飞书报错** ✗
 * ⇒ **裁决 Ⓐ**：只进**显式只读清单**（`salesEntry.readOnlyFields`），**`fields` 一个字不加** ✓
 *
 * ⚠️ 只读：本文件**不写任何表**（纯读 config + 源码）✓
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverRoot = path.resolve(__dirname, '..');
const readSrc = (...parts) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');
const { V1_BITABLE_SCHEMA } = require(path.join(serverRoot, 'src', 'config', 'v1BitableSchema.js'));

const SALES_ENTRY = V1_BITABLE_SCHEMA.tables.salesEntry;
const READ_ONLY_KEY = 'amountCheck';
const READ_ONLY_NAME = '金额核对';

/** 检测器（纯函数 ⇒ 可用坏样本单独验它**不空跑** ✓）：
 *  给一份 table 定义，返回它"**把只读字段登记成了可写**"的问题清单。 */
const writableLeaks = (table = {}) => {
  const problems = [];
  const fields = table.fields || {};
  if (Object.prototype.hasOwnProperty.call(fields, READ_ONLY_KEY)) {
    problems.push(`${READ_ONLY_KEY} 出现在 \`fields\`（= 写白名单）里`);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (String(value) === READ_ONLY_NAME) problems.push(`fields.${key} = 「${READ_ONLY_NAME}」（只读字段不许进写白名单 ✗）`);
  }
  return problems;
};

test('AC-RO1 🔴 写白名单（`salesEntry.fields`）里**没有**「金额核对」（塞进去 ⇒ 红 ✓）', () => {
  // 正向：现状必须干净
  assert.deepEqual(writableLeaks(SALES_ENTRY), [],
    `🔴 \`salesEntry.fields\` 是**写白名单**（见 \`salesStatusWriter.js:16\` 逐字）—— 「${READ_ONLY_NAME}」是 type 19 Lookup（**只读**），
     登记进它 = 变成"可写" ⇒ 写入会报错 ✗。它只许出现在 \`salesEntry.readOnlyFields\` ✓`);
  assert.equal(READ_ONLY_KEY in (SALES_ENTRY.fields || {}), false, '`fields` 里不许有 `amountCheck` 键 ✗');
});

test('AC-RO2 🔴 只读清单里**有**它，且标注 type 19 / Lookup / 不可写（删登记 ⇒ 红 ✓）', () => {
  const registry = SALES_ENTRY.readOnlyFields || {};
  const entry = registry[READ_ONLY_KEY];
  assert.ok(entry, `🔴 \`salesEntry.readOnlyFields.${READ_ONLY_KEY}\` 必须存在（她加的那一列要有登记 ✓）`);
  assert.equal(entry.name, READ_ONLY_NAME, '列名逐字「金额核对」✓');
  assert.equal(entry.type, 19, 'type 必须是 **19**（查找引用）✓');
  assert.equal(entry.uiType, 'Lookup', 'ui_type 必须是 `Lookup` ✓');
  assert.equal(entry.writable, false, '🔴 必须显式 `writable: false`（代码不写它 ✓）');
});

test('AC-RO3 🔴 源码级：写侧**不认识**它（任何写入路径的字段集都不含 Lookup 类键 ✓）', () => {
  const writer = readSrc('src', 'services', 'salesStatusWriter.js');
  assert.match(writer, /salesEntry\.fields/, '写白名单的来源必须仍是 `salesEntry.fields`（本判据的前提 ✓）');
  assert.equal(/readOnlyFields/.test(writer), false,
    '🔴 写侧**不许**读 `readOnlyFields`（只读清单不是写白名单 ✓）');
  assert.equal(writer.includes(READ_ONLY_NAME), false,
    `🔴 写侧**不许**出现「${READ_ONLY_NAME}」（出现 ⇒ 有路径在碰只读字段 ✗）`);
  // 全仓：schema 的**其它**语义键里也不许混进 Lookup 类登记
  const schema = readSrc('src', 'config', 'v1BitableSchema.js');
  const leaks = [...schema.matchAll(/uiType:\s*'Lookup'[^}]*writable:\s*true/g)];
  assert.deepEqual(leaks, [], '🔴 全仓不许有"Lookup 且可写"的登记 ✗');
});

test('AC-RO4 ⭐ 探针：检测器**真能红**（证明 AC-RO1 不是空跑 ✓）', () => {
  assert.deepEqual(writableLeaks({ fields: { orderNo: '销售单号' } }), [], '干净输入 ⇒ 不误报 ✓');
  assert.deepEqual(writableLeaks({ fields: { orderNo: '销售单号', amountCheck: '金额核对' } }).length, 2,
    '塞进 `fields`（键名 + 值名）⇒ **必须**报红 ✓');
  assert.deepEqual(writableLeaks({ fields: { amountCheck2: READ_ONLY_NAME } }), [
    `fields.amountCheck2 = 「${READ_ONLY_NAME}」（只读字段不许进写白名单 ✗）`,
  ], '换个键名塞同一个列名 ⇒ **也必须**报红 ✓');
});
