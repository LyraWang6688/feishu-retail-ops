// ⭐⭐ 2026-10-14 改指向（业务负责人逐字：「**工作台的采购 tab 里的退货不需要了**」）：
//   采购子 tab 从「验收·退货·订单列表·供应商往来款」⇒「验收·订单列表·供应商往来款」✓
//   🔴 **不是放宽** ✗：判据从"必须有退货"翻成"**必须没有退货**"，其余三项逐字不变 ✓
//   ⚠️ 退货**功能没删** ✓ —— 它一直在**扫码页**的【退货】领域（`?from=purchase_return` ✓）
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
  assert.deepEqual(pages, ['purchase-acceptance:验收', 'purchase-orders:订单列表', 'purchase-supplier-money:供应商往来款',
    'purchase-suppliers:供应商名录'],
    '⭐ 验收第一个（2026-10-13）；订单列表 · 供应商往来款 · 供应商名录（2026-10-14 加）逐字 ✓');
  assert.equal(source.includes("label: '验收到货'") || source.includes("label: '到货验收'"), false, '名字必须是「验收」两个字');
});

test('AC2 ⭐⭐ 「验收」挂的是**既有验收模块**（orders/purchase）—— 不新造页面、不新开接口 ✓', () => {
  const purchase = purchaseSlice();
  // 2026-10-14（她逐字）：「工作台的采购 tab 里的退货不需要了」⇒ 退货子页退场
  //   切片改为止于**下一个真实存在的子页**「订单列表」（原来止于退货；它没了 ✗）
  const first = purchase.slice(purchase.indexOf("id: 'purchase-acceptance'"), purchase.indexOf("id: 'purchase-orders'"));
  assert.match(first, /kind: 'orders'/, '走既有 orders 模块');
  assert.match(first, /mode: 'purchase'/, '采购模式的验收页（未到货优先 + 折叠已到货 + 验收到货表单）');
  assert.equal(/kind: 'placeholder'/.test(first), false, '已经不是占位骨架了（第 2 步把它接上了 ✓）');
  const renderer = read('features/domains/index.js');
  assert.match(renderer, /if \(page\.kind === 'orders'\) return void createOrdersModule\(\{ mode: page\.mode \}\)\.mount\(host\);/,
    '领域骨架仍走既有 kind:orders 分派（没为验收新造分支）');
  // 既有订单模块里就是那套验收 UI（四个哨兵仍在 ⇒ 我们只是"挂回去"，没改它）
  const orders = read('features/orders/index.js');
  for (const needle of ['data-action="verify-arrival"', 'data-field="arrival-amount"', 'data-field="arrival-note"', 'data-view="purchase-arrived"']) {
    assert.ok(orders.includes(needle), `既有验收 UI 少了 ${needle}`);
  }
});

test('AC3 ⭐⭐ 等价哨兵：验收**只有一处实现 + 一个接口** ⇒ 从工作台提交与从扫码页提交**不可能不同**', () => {
  // 思路：不是"跑两遍比过程"，而是证明**根本没有第二条路** ——
  //   ① 验收 UI 只有一处（`data-action="verify-arrival"` 只出现在 features/orders）
  //   ② 验收接口只有一个（`config/orders.js` 的 arrivalConfirm ⇒ 既有 `POST /purchase/arrivals/confirm`）
  //   ③ 这个接口的调用点只有一处
  // 两条入口（工作台「采购 → 验收」子 tab / 扫码页验收）挂的都是这同一处 UI、打的是同一个接口
  // ⇒ 写出的「到货状态=已到货 + 库存流水 + 实时库存」逐字相同 ✓（服务层一行没改 ✓）
  const root = WORKBENCH;
  const uiFiles = [];
  const apiUsers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.js$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      const rel = path.relative(root, full);
      if (text.includes('data-action="verify-arrival"')) uiFiles.push(rel);
      if (/arrivalConfirm/.test(text)) apiUsers.push(rel);
    }
  };
  walk(root);
  assert.deepEqual(uiFiles, ['features/orders/index.js'], '⭐ 验收 UI 只有一处实现（两条入口共用）');
  assert.deepEqual(apiUsers.sort(), ['config/orders.js', 'features/orders/index.js'], '⭐ 接口常量一处定义 + 一处使用');
  const ordersConfig = read('config/orders.js');
  assert.match(ordersConfig, /arrivalConfirm: '\/api\/workbench\/purchase\/arrivals\/confirm'/);
  // 服务层一行没改（本片只动配置与测试）：路由里那条写入链仍是既有三个服务
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/workbench.js'), 'utf8');
  for (const chain of ['WorkbenchPurchaseArrivalService', 'PurchaseArrivalConversationService', 'PurchaseWebhookService']) {
    assert.ok(route.includes(chain), `写入链仍是既有 ${chain}（没新写一套 ✗）`);
  }
});
