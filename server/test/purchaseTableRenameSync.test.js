const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { PURCHASE_ARRIVAL_STATUS_FIELD_KEY } = require('../src/config/purchaseArrivalStatus');

// ⭐ 业务负责人 2026-10-07 在生产表做了两件事，代码必须同步（AGENTS.md：
//   「我这边在生产表里面做的任何更改，你都要改」）：
//   ① 两张表改名：「供应商对接」→「信息填写」、「单据信息」→「具体信息」；
//   ② 「具体信息」删了「到货状态」「采购申请单」两列；「报货批次」新增
//      「到货状态」「单据」「采购行为」三列（其中「采购行为」她说不用管）。
//
// ⚠️ 闸门（v1:schema-check）按 **tableId** 校验字段名、**不校验表名** ——
//    表改名它拦不住，所以只能靠这里（与用户可见文案）自己同步。

const SERVER_ROOT = path.join(__dirname, '..');

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

test('A1 schema 表名 = 信息填写 / 具体信息（改名的同步点之一）', () => {
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseReport.tableName, '信息填写');
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseRequest.tableName, '具体信息');
  // 别的表名不受影响
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.tableName, '报货批次');
});

test('B1/B3 字段映射同步：具体信息删两列、报货批次加两列、采购行为不映射', () => {
  const request = V1_BITABLE_SCHEMA.tables.purchaseRequest.fields;
  // ⚠️ 这两行删掉是"两个都删"的一半：映射 + 写入点（写入点在代码里，见下一条用例）
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'arrivalStatus'), false,
    '「具体信息.到货状态」已被她从生产表删除 → 映射必须删');
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'attachment'), false,
    '「具体信息.采购申请单」已被她从生产表删除 → 映射必须删');

  const batch = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;
  assert.equal(batch.arrivalStatus, '到货状态');
  assert.equal(batch[PURCHASE_ARRIVAL_STATUS_FIELD_KEY], '到货状态', '到货状态的语义键与配置里声明的一致');
  assert.equal(batch.document, '单据');
  // 🔴 她说「报货批次里面的采购行为你不用管」⇒ 不映射（不映射就自然读不到、写不了）
  assert.equal(Object.prototype.hasOwnProperty.call(batch, 'behavior'), false,
    '「报货批次.采购行为」不读不写不映射');

  // 供应商（9 点推送【采购】区要显示的那一列）：只读投影
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseReport.fields.supplier, '供应商');
});

test('B2 已删列**全仓不再有写入/读取点**：附件只会写「报货批次.单据」', () => {
  const files = walk(path.join(SERVER_ROOT, 'src')).filter((file) => file.endsWith('.js'));
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([^:])\/\/.*$/gm, '$1');
    // 「具体信息」那一列已经不存在了：任何 update/create 里再出现 attachment 语义键都是回归
    if (/\battachment:\s*\[/.test(codeOnly) || /fields\.attachment\b/.test(codeOnly)) {
      offenders.push(`${path.relative(SERVER_ROOT, file)}: attachment 写入/读取`);
    }
    if (/purchaseRequest'?,?\s*\{[^}]*arrivalStatus/.test(codeOnly)) {
      offenders.push(`${path.relative(SERVER_ROOT, file)}: 往「具体信息」写到货状态`);
    }
  }
  assert.deepEqual(offenders, [], `已删除的列不许再被写/读：${offenders.join('；')}`);
});

test('A2 旧表名不再出现在用户可见文案与代码里（历史沿革注释除外）', () => {
  const roots = [path.join(SERVER_ROOT, 'src'), path.join(SERVER_ROOT, 'public')];
  const files = roots.flatMap((root) => walk(root)).filter((file) => /\.(js|html|css|json)$/.test(file));
  const offenders = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!line.includes('供应商对接') && !line.includes('单据信息')) return;
      // 「表名沿革：「供应商报货」→（2026-10-05）「供应商对接」→…」这类**历史记录**允许保留
      //（它写的就是"以前叫什么"，删掉反而让下一次改名的人不知道沿革）。
      if (/沿革|原[「]?(供应商对接|单据信息)/.test(line)) return;
      offenders.push(`${path.relative(SERVER_ROOT, file)}:${index + 1} ${line.trim().slice(0, 60)}`);
    });
  }
  assert.deepEqual(offenders, [], `旧表名必须同步成新名：\n${offenders.join('\n')}`);
});
