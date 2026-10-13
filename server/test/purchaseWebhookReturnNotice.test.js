/**
 * 采购退货告知抽 config（技术债批次 2026-10-12/13）：**整段照搬（保持 `+` 结构）** + 参数契约 + 服务级端到端。
 * 覆盖：兜底称谓 `'这个货品'` · 尺码碎片 `（${size} 码）` · 一双都没退掉那句 · 逐尺码缺货/剩货两句。
 * ⚠️ 不写死"整句开头"（开头那些字面量本轮**没抽**、将来可能变）⇒ 只钉**本轮抽走的那几处真的被用上**。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config/purchaseWebhookTexts.js');
const { buildPurchaseReturnNotice } = require('../src/services/purchaseWebhookService.js');
const source = fs.readFileSync(path.join(__dirname, '../src/services/purchaseWebhookService.js'), 'utf8');

test('AC1 常量与填参函数**逐字**', () => {
  assert.equal(config.returnNotice.unknownItem, '这个货品');
  assert.equal(config.returnNotice.sizeText({ size: 41 }), '（41 码）');
  for (const k of ['zeroTaken', 'shortfallLine', 'surplusLine']) {
    assert.equal(typeof config.returnNotice[k], 'function', `${k} 应是填参函数`);
  }
});

test('AC2 ⭐ 参数契约：config 形参名 === 调用点 key 名（含"函数当参数"）', () => {
  const cfg = fs.readFileSync(path.join(__dirname, '../src/config/purchaseWebhookTexts.js'), 'utf8');
  const sigs = new Map();
  for (const m of cfg.matchAll(/(\w+):\s*\(\{\s*([^}]*)\}\s*\)\s*=>/g)) {
    sigs.set(m[1], m[2].split(',').map((s) => s.trim()).filter(Boolean).sort());
  }
  for (const m of source.matchAll(/returnNotice\.(\w+)\(\{\s*([^}]*)\}/g)) {
    const passed = m[2].split(',').map((s) => s.trim()).filter(Boolean).sort();
    assert.deepEqual(passed, sigs.get(m[1]), `returnNotice.${m[1]} 入参名必须与签名完全一致`);
  }
  assert.ok(sigs.get('shortfallLine').includes('sizeText'), '⭐ 局部函数 sizeText 要当参数传进去');
});

test('AC3 ⭐⭐ 服务级端到端：真调纯函数，三轮输入断言各句（零网络）', () => {
  const short = buildPurchaseReturnNotice({ itemNo: 'XHB8095', color: '棕色',
    plan: { sizes: [{ size: 40, declared: 3, available: 1, taken: 1, shortfall: 2 }] } });
  assert.ok(short.includes('XHB8095棕色（40 码） 你说要退 3 双，实时库存里只有 1 双'), `缺货句：${short}`);
  assert.ok(short.includes('差的 2 双对不上。'), '中段逐字');

  const zero = buildPurchaseReturnNotice({ itemNo: '', color: '', plan: { sizes: [{ size: 40, declared: 2, available: 0 }] } });
  assert.ok(zero.includes('采购退货没处理：这个货品（40 码）在实时库存里一双都没有，'), `全没退句：${zero}`);

  const sur = buildPurchaseReturnNotice({ itemNo: 'X', color: '红',
    plan: { sizes: [{ size: 41, declared: 1, available: 5, taken: 1, surplus: 4 }] } });
  assert.ok(sur.includes('还剩 4 双没退（总数是 5 双）'), `剩货句：${sur}`);
  assert.ok(sur.includes('要一起退就把数量改成总数再提交一条～'), `剩货句结尾：${sur}`);
});

test('AC4 结构哨兵：`+` 拼接结构保留 + config 零逻辑', () => {
  const cfg = fs.readFileSync(path.join(__dirname, '../src/config/purchaseWebhookTexts.js'), 'utf8');
  const block = cfg.slice(cfg.indexOf('const returnNotice'), cfg.indexOf('module.exports'));
  assert.ok(/\+\s*'/.test(block), '整段照搬：字面量之间要保留 `+` 拼接结构');
  assert.equal(/\bif\s*\(|\bswitch\s*\(/.test(cfg), false, 'config 零逻辑');
});
