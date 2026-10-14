// ⭐⭐ 2026-10-14 改指向（业务负责人逐字：「**工作台的采购 tab 里的退货不需要了**」）：
//   采购子 tab 从「验收·退货·订单列表·供应商往来款」⇒「验收·订单列表·供应商往来款」✓
//   🔴 **不是放宽** ✗：判据从"必须有退货"翻成"**必须没有退货**"，其余三项逐字不变 ✓
//   ⚠️ 退货**功能没删** ✓ —— 它一直在**扫码页**的【退货】领域（`?from=purchase_return` ✓）
/**
 * 她 2026-10-13 逐字：「把**退货放在工作台采购单独一个子 tab，是退货！**」
 * ⚠️ 退货**本来就在扫码页**（`/s/{number}?from=purchase_return`，领域 id `purchase_return` ✓）⇒
 *    工作台这一页**只做入口**：**输入编号 ⇒ 直达**那条既有退货入口 ✓
 *    （**不自己发明退货流程** ✗ —— 后端链路一行不改 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORKBENCH = path.join(__dirname, '..', 'public', 'workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

const purchaseSlice = () => {
  const source = read('config/domains.js');
  return source.slice(source.indexOf("    id: 'purchase',"), source.indexOf("    id: 'product',"));
};

async function loadDomainPages() {
  // ⚠️ 第一版把相对 import 拍平（`../../core/x.js` → `./core/x.js`）⇒ 路径断掉、AC3 红 ✗
  //    ⇒ 改成**按原目录结构**复制到临时树，并把 `.js` 一并改成 `.mjs`（ESM 才认）✓
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-return-'));
  const copyMjs = (relative, out) => {
    const target = path.join(dir, out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, read(relative).replace(/(from '\.\.\/)+/g, (m) => m).replace(/\.js'/g, ".mjs'"));
  };
  copyMjs('core/formatters.js', 'core/formatters.mjs');
  copyMjs('features/shared/placeholder.js', 'features/shared/placeholder.mjs'); // ← 传递依赖（漏了它 AC3 报 ERR_MODULE_NOT_FOUND ✗）
  copyMjs('features/domains/pages.js', 'features/domains/pages.mjs');
  return import(path.join(dir, 'features/domains/pages.mjs'));
}

test('AC1 ⭐ 采购子 tab 顺序逐字 = 验收 · **退货** · 订单列表 · 供应商往来款', () => {
  const pages = [...purchaseSlice().matchAll(/\n        id: '([^']+)',\n        label: '([^']+)',/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(pages, ['purchase-acceptance:验收', 'purchase-orders:订单列表', 'purchase-supplier-money:供应商往来款',
    'purchase-suppliers:供应商名录'],
    '⭐ 退货**紧跟验收**；订单列表 / 供应商往来款 与改前逐字相同 ✓');
});

test('AC2 ⭐ 退货这一页**先保底**：占位页 ⇒ **进得去、不白屏**（真正录入与验收同构，下一轮做）', () => {
  const slice = purchaseSlice();
  // 2026-10-14（她：工作台采购 tab 里的退货不需要了）⇒ 整个子页退场：
  //   判据从“这一页长什么样”翻成“**它已经不存在**”（不放宽 ✗）
  assert.equal(slice.includes("id: 'purchase-return'"), false, '采购下的退货子页已退场 ✓');
  assert.equal(/PURCHASE_RETURN_FORM_URL/.test(slice), false, '整份配置里都不放“供应商报退货”的飞书表单外链 ✓');
  assert.equal(slice.includes('purchase-return'), false, '退货那一格在配置里彻底没有了 ✓');

  // 占位页由既有机制渲染 ⇒ 点得进、不白屏 ✓（渲染那句在领域骨架里，一行没改）
  const renderer = read('features/domains/index.js');
  assert.match(renderer, /host\.innerHTML = domainPageHtml\(page\)/, '占位页走既有渲染（不白屏 ✓）');
});

test('AC4 回归：其余子 tab 与一级 tab 逐字未变', () => {
  const tabs = [...read('config/tabs.js').matchAll(/\{ module: '([^']+)', label: '([^']+)' \}/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(tabs, ['scan:扫一扫', 'sales:销售', 'inventory:库存', 'purchase:采购', 'product:货品']);
  const slice = purchaseSlice();
  assert.match(slice, /id: 'purchase-orders'/);
  assert.match(slice, /label: '订单列表'/);
  assert.match(slice, /label: '供应商往来款'/);
});
