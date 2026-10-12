/**
 * 🔴 红线（业务负责人 2026-10-13 明确「必须加～」）：**标签上永远不许出现「成本」**。
 *
 * 背景：标签上只能有 —— 货号 · 颜色 · 单价 · 尺码（+数量）· 二维码（+可选品牌文字）。
 * 「成本」是**内部数据**（采购/建档写进「货品信息.成本」），**绝不能**印到标签上，
 * 也绝不能让标签这条链路去读「成本」那一列。
 *
 * 这个文件就是那条红线：谁以后不小心把成本加进标签（配置字段 / 渲染层 / 打印小助手）⇒ **测试直接红**。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { LABEL_PRINT } = require('../src/config/labelPrint');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const COST_PATTERN = /成本|cost/i;

/** 把源码里的注释去掉（避免"注释里提到成本"误伤；我们只查**真代码**）。 */
const stripComments = (source) => String(source || '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

/** 递归收集「对象里的键」与「字符串值」，用于查有没有 cost 这类字段。 */
const collect = (value, trail, out) => {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    out.values.push({ trail, value: String(value) });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, `${trail}[${index}]`, out));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.keys.push({ trail: `${trail}.${key}`, key });
      collect(inner, `${trail}.${key}`, out);
    }
  }
};

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('AC-COST1 标签配置里不许有「成本」这个字段（键名或取值都不许）', () => {
  const out = { keys: [], values: [] };
  collect(LABEL_PRINT, 'LABEL_PRINT', out);
  const badKey = out.keys.filter((item) => COST_PATTERN.test(item.key));
  const badValue = out.values.filter((item) => COST_PATTERN.test(item.value));
  assert.deepEqual(badKey.map((item) => item.trail), [], '标签配置里出现了「成本」字段键 ✗');
  assert.deepEqual(badValue.map((item) => `${item.trail}=${item.value}`), [], '标签配置里出现了「成本」字样 ✗');
  // ⭐ 字段开关清单必须**明确不含** cost（正面钉住"标签只印这几项"）
  assert.deepEqual(
    Object.keys(LABEL_PRINT.fields || {}).sort(),
    ['brand', 'category', 'color', 'footer', 'itemNo', 'price', 'qr', 'size', 'state'],
    '标签的字段开关清单变了 —— 如果是加了成本，请立刻删掉 ✗',
  );
});

test('AC-COST2 标签渲染链路（配置 + 服务 + 视图）不许读「成本」那一列', () => {
  const costColumn = V1_BITABLE_SCHEMA.tables.product.fields.cost; // 「成本」
  const files = [
    'src/config/labelPrint.js',
    'src/config/labelPrintQueue.js',
    'src/services/labelPrintService.js',
    'src/services/labelPrintArtifactService.js',
  ];
  for (const file of files) {
    const code = stripComments(read(file));
    assert.equal(COST_PATTERN.test(code), false, `${file} 的真代码里出现了「成本/cost」✗`);
    if (costColumn) {
      assert.equal(code.includes(costColumn), false, `${file} 引用了「${costColumn}」这一列 ✗（红色条款）`);
    }
  }
});

test('AC-COST3 打印小助手（print-helper）源码里不许有「成本」', () => {
  const dir = path.join(__dirname, '..', '..', 'print-helper');
  if (!fs.existsSync(dir)) return; // 本地没有该目录时跳过（CI 里有）
  const walk = (current) => fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (!/\.(js|mjs|cjs|json|md|html|bat)$/i.test(entry.name)) return [];
    return [full];
  });
  for (const file of walk(dir)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    assert.equal(COST_PATTERN.test(code), false, `print-helper/${path.relative(dir, file)} 里出现了「成本/cost」✗`);
  }
});
