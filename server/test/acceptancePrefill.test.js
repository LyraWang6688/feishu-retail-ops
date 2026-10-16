'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
const { rendererSource } = require('./support/rendererSource');

/**
 * ⭐⭐ 2026-10-14 晚（业务负责人逐字）：「/s/accept 这条路要彻底拆掉」
 *
 * 本文件原测扫码页那一屏的「明细预填 / 自定义尺码 / 未报货候选 / 成功页回列表」。
 * 那一屏**已退场** ⇒ 按老口径**改指向**：**逐条保留 AC 名** ✓
 * 断言 = 「**入口没了** ＋ **能力仍在**（服务级 / 工作台那条路）」✓ 依据：她的原话（上）
 * 能力现在在哪：`scanArrivalService`（start / addScan / finish / setActualRows ✓）＋
 *   工作台 `purchase/arrivals/detail` · `.../accept`（#534 ✓）· 逐条验收见
 *   `test/workbenchAcceptanceFull.test.js`（AC-AW10…AW17 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const ROUTES = read('../src/routes/scanPage.js');
const RENDERER = rendererSource();
const CONFIG = read('../src/config/scanPage.js');
const ARRIVAL = read('../src/services/scanArrivalService.js');
const WB_ROUTES = read('../src/routes/workbench.js');

const GONE = [
  [ROUTES, "router.get('/accept'", '扫码页 GET /accept'],
  [ROUTES, "router.post('/accept'", '扫码页 POST /accept'],
  [RENDERER, 'renderAcceptancePage', '验收那一屏的渲染函数'],
  [RENDERER, 'renderAcceptanceSelfServe', '无 batch 的自助落地页'],
];

test('AC-AP1 明细逐字预填 ⇒ 改钉「工作台那条只读明细」＋ 旧入口退场', () => {
  for (const [src, needle, label] of GONE) assert.equal(src.includes(needle), false, `${label} 已退场`);
  assert.match(WB_ROUTES, /purchase\/arrivals\/detail/, '工作台有只读明细入口');
  assert.match(ARRIVAL, /listPurchaseRequests/, '明细仍从既有只读查询来（不另起一套）');
});
test('AC-AP2/AP3/AP6 改数量 / 改 0 / 实际数量 ⇒ 改钉「服务里的行处理」仍在', () => {
  assert.match(ARRIVAL, /addScan/, '按行加（自定义/改数量那条路）仍在服务里');
  assert.match(ARRIVAL, /setActualRows/, '整张清单落会话的能力仍在');
  assert.equal(RENDERER.includes('accept-row-qty'), false, '那一屏的行输入已退场');
});
test('AC-AP4 ⭐ 自定义尺码 ⇒ 完成验收时计入库存 ⇒ 改钉「工作台那条 + applyPurchase」', () => {
  assert.match(WB_ROUTES, /purchase\/arrivals\/accept/, '工作台那条完成验收在');
  assert.match(ARRIVAL, /applyPurchase/, '加库存仍走既有 applyPurchase（绝不直连表）');
});
test('AC-AP9 多款批次不指明款 ⇒ 拒 + 人话（不猜）⇒ 改钉「服务如实拒绝」', () => {
  assert.match(ARRIVAL, /no_request_rows|duplicate_request_rows|acceptRowsUnreadableBody/, '服务端如实给人话');
});
test('AC-AP5 ⭐ 扫码加一款 ⇒ 出现在清单里 ⇒ 改钉「addScan 那条路」', () => {
  assert.match(ARRIVAL, /addScan/, 'addScan 仍在（扫码加一款）');
});
test('AC-AP7 没有采购明细的批次 ⇒ 仍能加（不崩）⇒ 改钉「服务给得出人话」', () => {
  assert.match(ARRIVAL, /no_request_rows/, '"没有明细"有专门的人话分支（不崩、不假成功）');
});
test('AC-AP8 回归：既有「加入本次验收」表单字段与文案 ⇒ 随屏退场（服务侧能力不减）', () => {
  assert.equal(RENDERER.includes('acceptAdd'), false, '那一屏的表单已退场');
  assert.match(ARRIVAL, /addScan/, '但"加一行"的能力仍在（工作台用同一条）');
});
test('AC-AP10/AP14/AP15 「没报货的尺码」候选 ⇒ 随屏退场；候选口径仍是配置一份', () => {
  assert.equal(RENDERER.includes('未报货'), false, '那一屏的候选区已退场');
  assert.match(CONFIG, /sizeSegments|enterable|special/, '尺码范围仍只有配置这一处');
});
test('AC-AP11/AP13 点一下加/取消 ⇒ 随屏退场（服务里同一条路仍在）', () => {
  assert.equal(ROUTES.includes("'/accept'"), false, '旧入口不在了');
  assert.match(ARRIVAL, /finish/, '完成验收仍在服务里（幂等同一把键）');
});
test('AC-AP12 ⭐ 点它就等于到货 ⇒ 计入库存 ⇒ 改钉「工作台 accept + applyPurchase」', () => {
  assert.match(WB_ROUTES, /purchase\/arrivals\/accept/, '工作台那条在');
  assert.match(ARRIVAL, /applyPurchase/, '加库存仍只经既有服务');
});
test('AC-AP16 候选口径只来自配置（不另发明、不读表）', () => {
  assert.match(CONFIG, /sizeSegments/, '只有配置这一处尺码范围');
  assert.equal(/尺码管理/.test(RENDERER), false, '渲染层不自己读"尺码管理"表');
});
test('AC-AH1/AC-AH2 成功页回列表（acceptHome）⇒ 随屏退场；工作台有自己的列表', () => {
  assert.equal(RENDERER.includes('acceptHome'), false, '那一屏的成功页已退场');
  assert.equal(CONFIG.includes('acceptanceLandingPath'), false, '那两条路径配置已退场');
  assert.match(WB_ROUTES, /purchase\/arrivals/, '工作台那条到货列表仍在（能力没丢）');
});
