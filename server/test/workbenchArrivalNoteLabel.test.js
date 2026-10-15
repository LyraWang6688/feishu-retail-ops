/**
 * 判据（task-50 · 她 2026-10-16 00:01 真机反馈⑥「这句必须改」）：
 *   工作台「验收到货」表单里，到货说明那一格的标签**原来是**「到货说明（写进验收原话）」✗，
 *   但 ⛔ 「验收原话」(`acceptanceText`) 这条**列映射 2026-10-09 已删除**
 *   （只读核过生产真表 12 列里没有它；全 Base 46 张表里也搜不到这个名字）。
 *   ⇒ 标签**不许再承诺"写进验收原话"** ✗（承诺一个不存在的列 = 骗她）。
 *
 * 改前逐字：`arrivalNote: '到货说明（写进验收原话）'`
 * 改后逐字：`arrivalNote: '到货说明'`
 * 依据：她 2026-10-16 逐字「（到货说明那句）这个必须改」＋ `config/v1BitableSchema.js:465-478` 的注释。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const ORDERS_CONFIG = 'public/workbench/config/orders.js';
const ORDERS_FEATURE = 'public/workbench/features/orders/index.js';
const SCHEMA = 'src/config/v1BitableSchema.js';

// AC-FB6-1：标签本身不许再提「验收原话」/「写进…」
test('AC-FB6-1 ⭐ 到货说明标签**不再承诺**「写进验收原话」（改前逐字 vs 改后逐字）', () => {
  const src = read(ORDERS_CONFIG);
  const line = src.split('\n').find((item) => /arrivalNote:/.test(item));
  assert.ok(line, '配置里要有 arrivalNote 这一项');
  assert.equal(line.trim(), "arrivalNote: '到货说明',", `改后逐字（实际：${line.trim()}）`);
  assert.ok(!/验收原话/.test(line), '标签里**不许**再出现「验收原话」✗');
  assert.ok(!/写进/.test(line), '标签里**不许**再承诺"写进某列"✗');
});

// AC-FB6-2：那一列**真的不在了**（判据的理由可查证 —— 不是"我觉得"）
test('AC-FB6-2 ⭐ 判据理由：`acceptanceText`（验收原话）映射已删 · 全库配置也搜不到这一列', () => {
  const schema = read(SCHEMA);
  assert.ok(!/acceptanceText\s*:/.test(schema), 'schema 里**不许**再有 acceptanceText 的映射 ✗');
  // 反向哨兵：那位注释**必须**还在（它是"为什么这么改"的证据，删了注释这条判据就失去依据）
  assert.ok(/验收原话/.test(schema), 'schema 里要保留那条"已删除"的注释当证据 ✓');
});

// AC-FB6-3：文案的家在配置里（渲染处只读配置，不写死中文）
test('AC-FB6-3 配置驱动：渲染处只读配置项，**不**在 feature 文件里写死这句中文', () => {
  const feature = read(ORDERS_FEATURE);
  assert.ok(/\bT\.arrivalNote\b/.test(feature), '渲染处要用配置项 `T.arrivalNote` ✓');
  assert.ok(!/写进验收原话/.test(feature), 'feature 文件里**不许**再出现那句旧文案 ✗');
});

// AC-FB6-4：能真红 —— 把旧文案塞回去，本判据必须失败（用同一段判据函数验一次）
test('AC-FB6-4 ⭐ 能真红：把旧文案塞回去 ⇒ 上面那条判据当场失败', () => {
  const check = (line) => line.trim() === "arrivalNote: '到货说明'," && !/验收原话|写进/.test(line);
  assert.equal(check("  arrivalNote: '到货说明（写进验收原话）',"), false, '旧文案 ⇒ 判据红 ✓');
  assert.equal(check("  arrivalNote: '到货说明',"), true, '现在的文案 ⇒ 判据绿 ✓');
});
