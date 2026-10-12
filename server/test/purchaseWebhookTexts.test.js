/**
 * 文案抽 config 的**逐字对照** + ⭐**服务级端到端**（2026-10-12 技术债批次）。
 * 期望值**自动取自改前的服务原文**（非手抄）；端到端直接 require 服务、调真方法、断言整句逐字（不碰 HTTP/会话）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config/purchaseWebhookTexts.js');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService.js');

test('AC1 ⭐ 本片文案**逐字不变**（期望值取自改前原文）', () => {
  // ⚠️ 带参的 2 条（:1711 报货批次号 / :1713 toast）在**生成时已逐字节比对**（0 不匹配）；
  //    这里只钉它们**是填参函数**（整句对照会受样本值往返影响，不写死整句）。
  assert.equal(typeof config.purchaseMessage.m2, 'function', ':1711 带参那条是填参函数');
  assert.equal(typeof config.purchaseToast.m1, 'function', ':1713 带参那条是填参函数');
  assert.equal(config.purchaseMessage.m1, '采购申请已生成', '原行 :1711 逐字不变');
  assert.equal(config.arrivalToast.m1, '这一批已入库', '原行 :1764 逐字不变');
  assert.equal(config.inventoryToast.m1, '采购已入库，库存已更新', '原行 :1926 逐字不变');
  assert.equal(config.inventoryToast.m2, '采购入库已确认', '原行 :1926 逐字不变');
});

test('AC2 ⭐⭐ 服务级端到端：真方法产出的整句与改前逐字一致（不碰 HTTP/会话）', async () => {
  // `confirmArrivalLocked` 开头就是"已经入过库"的早返回 ⇒ 不需要网关/网络，天然可端到端
  const instance = Object.create(PurchaseWebhookService.prototype);
  const result = await instance.confirmArrivalLocked('task-e2e-1', { status: 'posted' }, 'ou_e2e');
  assert.equal(result.toast.content, config.arrivalToast.m1, '返回的整句 === config 里的常量');
  assert.equal(result.toast.content, '这一批已入库', '并且 === 改前原文');
});

test('AC3 结构哨兵：三元两条各留一个 key + config 零逻辑', () => {
  assert.equal(typeof config.inventoryToast.m1, 'string');
  assert.equal(typeof config.inventoryToast.m2, 'string');
  assert.notEqual(config.inventoryToast.m1, config.inventoryToast.m2);
  const text = fs.readFileSync(path.join(__dirname, '../src/config/purchaseWebhookTexts.js'), 'utf8');
  assert.equal(/\bif\s*\(|\bswitch\s*\(/.test(text), false, 'config 零逻辑');
});

test('AC4 ⭐⭐ 参数契约：config 的入参名 == 服务调用处传的键名（这条就是为 batch_no 那个真 bug 补的）', () => {
  const cfgText = fs.readFileSync(path.join(__dirname, '../src/config/purchaseWebhookTexts.js'), 'utf8');
  const svcText = fs.readFileSync(path.join(__dirname, '../src/services/purchaseWebhookService.js'), 'utf8');
  // config：`m2: ({ plan, requestIds }) => ...`
  const sigs = new Map();
  for (const m of cfgText.matchAll(/(\w+):\s*\(\{\s*([^}]*)\}\s*\)\s*=>/g)) sigs.set(m[1], m[2].split(',').map((x) => x.trim()).filter(Boolean).sort());
  assert.ok(sigs.size >= 2, 'config 里应有填参函数');
  // 服务：`<组>.m2({ plan, requestIds })`
  const calls = [...svcText.matchAll(/(\w+)\.(m\d+)\(\{\s*([^}]*)\}/g)];
  assert.ok(calls.length >= 2, '服务里应有填参调用');
  for (const [, , key, args] of calls) {
    const passed = args.split(',').map((x) => x.trim()).filter(Boolean).sort();
    assert.deepEqual(passed, sigs.get(key), `${key} 的入参名必须与 config 签名**完全一致**（多传/少传都是 bug：会 ReferenceError）`);
  }
  // ⚠️ 反例回归：绝不允许把 `plan.batch_no` 拆成 `batch_no` 这种"半截标识符"
  for (const [, params] of sigs) {
    assert.equal(params.some((p) => ['batch_no', 'length'].includes(p)), false, '签名里不许出现半截标识符（batch_no / length）');
  }
});

test('AC5 ⭐⭐ 运行时：那句带参文案**真的用到了 `plan.batch_no`**（这次炸的就是它）', () => {
  const plan = { batch_no: 'CGD-20261012-0007' };
  const requestIds = ['rec-a', 'rec-b', 'rec-c'];
  const m2 = config.purchaseMessage.m2({ plan, requestIds });
  assert.ok(m2.includes(plan.batch_no), `整句里必须出现真实批次号：${m2}`);
  assert.equal(m2, `报货批次号：${plan.batch_no}；共 ${requestIds.length} 条明细已写入。`, '整句逐字');
  const toast = config.purchaseToast.m1({ plan, requestIds });
  assert.ok(toast.includes(plan.batch_no), `toast 里必须出现真实批次号：${toast}`);
  assert.equal(toast, `采购申请已生成：${plan.batch_no}（共${requestIds.length}条明细）`, '整句逐字');
  // ⚠️ 这条路（报货建单）的**整链运行时**覆盖在 `purchaseDetailId.test.js` 的 AC-ID2/3/4
  //    —— 它们正是被 `ReferenceError: batch_no is not defined` 打红的三个；修复后转绿。
});
