/**
 * 骨架第 1 步（她 2026-10-13：「**先把骨架搭好**」）：
 * 采购子 tab 第一个 = **验收**（名字逐字 ✓），**其余子 tab 顺序一个字不动** ✓；
 * 空页可进可出、**不白屏** ✓（用既有 `kind: 'placeholder'` ⇒ 不新造机制 ✓）。
 * ⚠️ 本步**只做骨架**：未到货批次列表 / 逐双录入 / 提交在**下一步**接（她 ①②③ 未定 ⇒ 先别做 ✗）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKBENCH = path.join(__dirname, '..', 'public', 'workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** ⚠️ 切片必须**止于下一个领域**（第一版切到文件尾 ⇒ 把货品子 tab 也算进来了 ✗ 被自己的 AC 抓到） */
const purchaseSlice = () => {
  const source = read('config/domains.js');
  return source.slice(source.indexOf("    id: 'purchase',"), source.indexOf("    id: 'product',"));
};

test('AC1 ⭐ 采购子 tab 第一个 = 「验收」（逐字）；其余子 tab 顺序不变', () => {
  const source = read('config/domains.js');
  const pages = [...purchaseSlice().matchAll(/\n        id: '([^']+)',\n        label: '([^']+)',/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(pages, ['purchase-acceptance:验收', 'purchase-orders:订单列表', 'purchase-supplier-money:供应商往来款'],
    '⭐ 验收第一个；订单列表 · 供应商往来款 顺序与名字不变 ✓');
  assert.equal(source.includes("label: '验收到货'") || source.includes("label: '到货验收'"), false, '名字必须是「验收」两个字');
});

test('AC2 ⭐ 壳子用**既有** placeholder 机制（可进可出、不白屏；不自造渲染）', () => {
  const purchase = purchaseSlice();
  const first = purchase.slice(purchase.indexOf("id: 'purchase-acceptance'"), purchase.indexOf("id: 'purchase-orders'"));
  assert.match(first, /kind: 'placeholder'/, '骨架用既有 placeholder（渲染不动、不白屏 ✓）');
  const renderer = read('features/domains/index.js');
  assert.match(renderer, /host\.innerHTML = domainPageHtml\(page\)/, 'placeholder 仍走既有 domainPageHtml（没有为骨架新造机制）');
});
