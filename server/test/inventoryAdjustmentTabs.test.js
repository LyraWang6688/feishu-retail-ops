'use strict';

/** 库存 → 手工调整（2026-11-11 前端替换）：两张入口卡 + 直接扫一扫。 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const PAGE = path.join(__dirname, '../public/workbench/features/inventory/adjustment.js');
const CONFIG = path.join(__dirname, '../public/workbench/config/inventoryAdjustment.js');
const source = () => fs.readFileSync(PAGE, 'utf8');
const configSource = () => fs.readFileSync(CONFIG, 'utf8');

test('AC-IA1 两张入口卡由配置驱动：单双调整 / 批量调整', () => {
  const cfg = configSource();
  assert.deepEqual([...cfg.matchAll(/id: '([^']+)', icon: '([^']+)', label: '([^']+)'/g)].map(([, id, , label]) => ({ id, label })),
    [{ id: 'single', label: '单双调整' }, { id: 'batch', label: '批量调整' }]);
  assert.ok(source().includes('INVENTORY_MANUAL_CARDS.map'), '页面必须按配置渲染入口卡');
});

test('AC-IA2 单双调整直接调库存扫一扫，不再有中间页/三个按钮', () => {
  const html = source();
  assert.ok(html.includes("scanCodeRaw('inventory')"), '单双调整必须直接调库存扫一扫');
  assert.equal(html.includes('先扫这一双鞋的二维码'), false, '不再有中间说明页');
  assert.equal(html.includes('data-panel="status"'), false, '三个按钮已删除');
});

test('AC-IA3 批量调整只保留当季 / 库存两个入口，异常编号可跳到单双调整', () => {
  const html = source();
  assert.ok(html.includes('data-action="batch-check"'), '库存检查入口');
  assert.ok(html.includes('data-fix='), '异常编号必须有调整按钮');
  assert.ok(html.includes('data-manual="batch"'), '批量调整入口卡');
  assert.ok(html.includes('data-save'), '单双页有保存按钮');
  assert.ok(html.includes('data-action="season-toggle"'), '当季批量入口');
  assert.ok(html.includes('/label-print/jobs'), '保存后可打印');
});

test('AC-IA4 批量调整：品类与库存并行读取 + 轻量 toast 提示', () => {
  const src = source();
  assert.match(src, /Promise\.all\(\[categoriesPromise, loadRows\(\)\]\)/, '品类与库存必须并行');
  assert.ok(src.includes("showToast(INVENTORY_MANUAL_TEXTS.batchLoading, { sticky: true })"), '点击后立即提示读取中，并在数据读完后收起');
  assert.match(configSource(), /batchLoading: '正在读取品类和库存…'/, '提示文案在配置里');
});


test('AC-IA5 状态调整与当季调整独立：不看品类/当季，显示所有不满足一样品+其余门盒的编号', () => {
  const html = source();
  assert.equal(html.includes('selectedCategory'), false, '状态调整不再按品类过滤');
  assert.ok(html.includes("issueKey === 'empty'"), '状态为空也要报');
  assert.ok(html.includes("issueKey === 'missing'"), '没有样品要报');
  assert.ok(html.includes("issueKey === 'extra'"), '样品大于一双要报');
  assert.equal(html.includes('① 当季调整'), false, '板块标题不再带编号');
  assert.equal(html.includes('② 状态调整'), false, '板块标题不再带编号');
  assert.ok(html.includes('await loadRows(true)'), '当季调整后强制重新加载状态调整数据');
});


test('AC-IA6 状态调整按问题分组，可按问题筛选，货号之间有分割线', () => {
  const html = source();
  assert.ok(html.includes('data-field="status-filter"'), '问题类型筛选');
  assert.ok(html.includes('data-issue="' + '${escapeHtml(group.key)}' + '"'), '按问题分组');
  assert.ok(html.includes('violation-group-title'), '分组标题');
  assert.ok(html.includes('data-fix='), '每条货号仍有调整按钮');
  const css = fs.readFileSync(path.join(__dirname, '../public/workbench/features/domains/domains.css'), 'utf8');
  assert.match(css, /\.violation-list \.violation-card \+ \.violation-card/, '货号之间有分割线');
  const cfg = configSource();
  for (const key of ['statusFilterAll', 'statusIssueExtraGroup', 'statusIssueEmpty', 'statusIssueMissing', 'statusGroupCount']) {
    assert.ok(cfg.includes(`${key}:`), `配置缺少 ${key}`);
  }
});


test('AC-IA7 添加尺码后保留新行；删除行也不重置编辑器', () => {
  const src = source();
  assert.ok(src.includes("state.editorRows.push({ size: '', state: '门盒', quantity: 1 }); renderEditor();"), '添加尺码必须只重绘编辑器，不能重新从库存重建');
  assert.ok(src.includes('state.editorRows.splice(Number(btn.dataset.remove), 1);') && src.includes('      renderEditor();'), '删除后也只重绘编辑器');
  assert.ok(src.includes('function renderEditor()'), '有独立编辑器渲染函数');
  assert.ok(src.includes('state.editorRows = productRows(productId).map'), '只有进入单双调整时才从库存初始化');
});
