'use strict';

/**
 * ⭐⭐ 2026-10-17（业务负责人）：「到货单已经不用了」＋「货品建档的唯一路径就是工作台里的货品上新
 *   （多维表格表单外链，提交后自动生成二维码）」。
 *
 * ⇒ 到货链路里两段**没有任何现行入口**的代码整条删除：
 *   ① 成本写入（原 `arrivalCostPolicy.js`；输入 `task.recognized` 无生产写入点）；
 *   ② 新品建档（原 `ensureArrivalProducts / ensureArrivalProduct / ensureArrivalColor`；
 *      输入 `pending_creation` 唯一写入点就是固定 `[]`）。
 * 保留：`confirmArrival` 的**加库存 + 写报货批次**；「货品.成本」schema 映射（列还在，手工维护）。
 *
 * 本哨兵钉住：两段符号/文件彻底不存在（塞回即红）；加库存链路仍活着；成本映射保留。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(SERVER_ROOT, relative), 'utf8');

test('到货「成本 + 建档」两段死代码已彻底删除（塞回即红）', () => {
  assert.equal(fs.existsSync(path.join(SERVER_ROOT, 'src', 'services', 'arrivalCostPolicy.js')), false,
    '⛔ arrivalCostPolicy.js 已删除（到货单价格识别退场 ⇒ 成本规则无输入）');
  const webhook = read('src/services/purchaseWebhookService.js');
  for (const dead of [
    'applyArrivalCost', 'buildArrivalCostPlan', 'isBlankCost', 'costValueOf',
    'arrivalCostPlan', 'costWritten', 'costApplied', 'cost_written_count',
    'ensureArrivalProducts', 'ensureArrivalProduct', 'ensureArrivalColor',
    'creationQueue', 'buildArrivalCreationContext', 'persistArrivalCreation',
    'arrival_created_products', 'arrival_created_colors', 'created_products', 'pending_creation',
  ]) {
    assert.equal(webhook.includes(dead), false, `⛔ 死代码符号 ${dead} 不许再出现在 purchaseWebhookService`);
  }
  assert.equal(/values\.cost\s*=/.test(webhook), false, '⛔ 不许再写货品「成本」字段');
  // 全仓 src（**递归**）也不许再有这两个死链路的任一符号（避免换个文件/子目录复活）
  const src = path.join(SERVER_ROOT, 'src');
  const deadSymbols = [
    'arrivalCostPolicy', 'applyArrivalCost', 'buildArrivalCostPlan', 'isBlankCost', 'costValueOf',
    'ensureArrivalProducts', 'ensureArrivalProduct', 'ensureArrivalColor',
    'creationQueue', 'pending_creation',
  ];
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const symbol of deadSymbols) {
        if (text.includes(symbol)) hits.push(`${path.relative(src, full)}:${symbol}`);
      }
    }
  };
  walk(src);
  assert.deepEqual(hits, [], `⛔ src 里不许再有死链路符号：${hits.join(', ')}`);
});

test('加库存 / 验收仍然活着（删建档不许误伤）', () => {
  const webhook = read('src/services/purchaseWebhookService.js');
  assert.match(webhook, /async confirmArrival\(/, '⛔ 到货确认必须还在');
  assert.match(webhook, /inventory\.applyPurchase\(/, '⛔ 加库存调用必须还在');
  assert.match(webhook, /writeAcceptance/, '⛔ 写「报货批次」必须还在');
});

test('「货品.成本」schema 映射保留（列还在，只是代码不写）', () => {
  const schema = read('src/config/v1BitableSchema.js');
  assert.match(schema, /cost:\s*'成本'/, '「货品.成本」列仍在真表 ⇒ 映射保留（供读取/手工维护）');
});
