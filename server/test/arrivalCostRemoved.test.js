'use strict';

/**
 * ⭐⭐ 2026-10-17（业务负责人选 A）：「到货单已经不用了」，成本链路是退场残留 ⇒ **整条删干净**。
 *
 * 事实依据：`task.recognized` 在生产 `src/` 里**没有写入点**（拍照识别 / 到货对话解析均已退场），
 *   ⇒ `buildArrivalCostPlan([])` 恒空 ⇒ 成本写入分支不可达；但它仍带着"读失败被当成空成本"的覆盖风险。
 *
 * 本哨兵钉住：
 *   ① `arrivalCostPolicy.js` 与成本写入符号**彻底不存在**（塞回即红）；
 *   ② **建档 / 验收** 这两件仍然活着（不许误删）；
 *   ③ 「货品.成本」的 **schema 映射保留**（该列还在，业务侧手工维护；只是代码不再写它）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(SERVER_ROOT, relative), 'utf8');

test('成本写入链路已彻底删除（塞回即红）', () => {
  assert.equal(fs.existsSync(path.join(SERVER_ROOT, 'src', 'services', 'arrivalCostPolicy.js')), false,
    '⛔ arrivalCostPolicy.js 已删除（到货单价格识别退场 ⇒ 成本规则无输入）');
  const webhook = read('src/services/purchaseWebhookService.js');
  for (const dead of ['applyArrivalCost', 'buildArrivalCostPlan', 'isBlankCost', 'costValueOf',
    'arrivalCostPlan', 'costWritten', 'costApplied', 'cost_written_count']) {
    assert.equal(webhook.includes(dead), false, `⛔ 成本符号 ${dead} 不许再出现在 purchaseWebhookService`);
  }
  assert.equal(/values\.cost\s*=/.test(webhook), false, '⛔ 建档不许再写货品「成本」字段（已删除该写入点）');
});

test('建档 / 验收仍然活着（删成本不许误伤）', () => {
  const webhook = read('src/services/purchaseWebhookService.js');
  assert.match(webhook, /async ensureArrivalProducts\(/, '⛔ 建档入口必须还在');
  assert.match(webhook, /async ensureArrivalProduct\(/, '⛔ 单条建档必须还在');
  assert.match(webhook, /async confirmArrival\(/, '⛔ 到货确认（加库存）必须还在');
  assert.match(webhook, /inventory\.applyPurchase\(/, '⛔ 加库存调用必须还在');
});

test('「货品.成本」的 schema 映射保留（列还在，只是代码不写）', () => {
  const schema = read('src/config/v1BitableSchema.js');
  assert.match(schema, /cost:\s*'成本'/, '「货品.成本」列仍在真表 ⇒ 映射保留（供读取/手工维护）');
});
