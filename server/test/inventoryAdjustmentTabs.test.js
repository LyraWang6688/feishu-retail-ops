/**
 * 「库存 → 手工调整」页的子 tab 形状（2026-11-09 业务负责人）：
 *   「增加一个子 tab，为状态调整，核心是样品和门盒的调整，先占位一下」
 *
 * 本文件是**反向哨兵**：
 *   · 三个子 tab 顺序/名字/面板 id 固定（塞回两个 / 改错 id ⇒ 红）；
 *   · 「状态调整」**这一屏只占位**：有「待建设」标记 + 「样品 ↔ 门盒」，
 *     但**没有任何输入 / 提交按钮 / 写接口**（先占位，不是偷偷接个半成品接口 ✗）。
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const PAGE = path.join(__dirname, '../public/workbench/features/inventory/adjustment.js');
const CONFIG = path.join(__dirname, '../public/workbench/config/inventoryAdjustment.js');
const source = () => fs.readFileSync(PAGE, 'utf8');
const configSource = () => fs.readFileSync(CONFIG, 'utf8');

test('AC-IA1 三个子 tab 由配置驱动：状态调整 / 盘点调整 / 换季调整（状态调整排最左）', () => {
  const cfg = configSource();
  assert.deepEqual([...cfg.matchAll(/id: '([^']+)', label: '([^']+)'/g)].map(([, id, label]) => ({ id, label })),
    [{ id: 'adjust-state', label: '状态调整' }, { id: 'adjust-count', label: '盘点调整' }, { id: 'adjust-season', label: '换季调整' }]);
  assert.ok(source().includes("INVENTORY_ADJUSTMENT_TABS.map"), '页面必须按配置渲染子 tab');
  assert.equal(/data-subtab="adjust-/.test(source()), false, '页面里不许再写死子 tab 按钮');
});

test('AC-IA2 「状态调整」= 占位（样品 ↔ 门盒 + 待建设），没有任何输入 / 提交 / 写接口', () => {
  const html = source();
  const start = html.indexOf('id="adjust-state-subpanel"');
  assert.notEqual(start, -1, '必须有「状态调整」的面板');
  const panel = html.slice(start, html.indexOf('</section>`;', start));
  assert.ok(panel.includes('inline-placeholder'), '占位用统一占位样式');
  assert.ok(panel.includes('样品') && panel.includes('门盒'), '写清这一屏的核心：样品 ↔ 门盒');
  assert.ok(panel.includes('待建设'), '占位就写「待建设」（与其它占位页同一口径）');
  assert.equal(/<(input|select|textarea|button)\b/.test(panel), false, '占位屏不许有任何输入/按钮');
  assert.equal(/data-action=/.test(panel), false, '占位屏没有提交动作');
  assert.equal(/adjustments\//.test(panel), false, '占位屏不发任何接口（先占位，不是半成品写接口）');
});
