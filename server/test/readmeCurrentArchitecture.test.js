'use strict';

/**
 * ⭐⭐ 2026-10-17（业务负责人逐字）：「现在信息录入到系统里就是**扫一扫填写前端 UI 表单**或者
 *   **填写多维表格表单**，其余方式目前没有了」＋「首页 README 还在描述私聊和模型解析…」。
 *
 * 本用例 = **README 与现行架构的一致性哨兵**（她问过的那两个问题就钉在这里）：
 *   ① 根 README 不许再把「私聊 / 豆包 / 自然语言解析 / 采购到货表」当成现行事实；
 *   ② 必须写明现行两种录入入口，并指向文档索引；
 *   ③ 已退场文档必须真的在 `docs/archive/` 里（不是只写一句"已归档"）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

test('README 描述的是现行架构：入口 = 扫一扫 UI 表单 + 多维表格表单（旧入口不许再当现状）', () => {
  const readme = read('README.md');
  // ① 现行入口必须写清
  assert.ok(readme.includes('扫一扫'), 'README 必须写明「扫一扫」是现行录入入口');
  assert.ok(readme.includes('多维表格表单'), 'README 必须写明「多维表格表单」是现行录入入口');
  assert.ok(readme.includes('docs/README.md'), 'README 必须指向文档索引');
  // ② 已退场的入口 / 模型解析不许再被描述成现行
  // ⚠️ README 可以写"历史入口已退场（私聊/群聊…）"；禁的是**把旧入口/旧模型当成现行**的措辞。
  for (const banned of ['销售私聊录入', '飞书私聊接收', '豆包大模型', '豆包 (Doubao)', '自然语言解析', '「采购到货」表']) {
    assert.equal(readme.includes(banned), false, `README 不许再把「${banned}」当成现行事实（她 2026-10-17 已明确过去式）`);
  }
  // ③ 历史入口必须被明确标成"已退场"，而不是删得无痕
  assert.ok(/退场|已删除|退役/.test(readme), 'README 要说明历史入口已退场（否则读者会以为从没存在过）');
});

test('已退场文档真的归档了（不是只在索引里写一句）', () => {
  for (const gone of ['prd.md', 'tech-arch.md', 'technical.md', 'project-progress.md']) {
    assert.equal(exists(`docs/${gone}`), false, `微信小程序时期的 ${gone} 已删除（历史留档见 archive/legacy-wechat-retirement.md）`);
  }
  for (const archived of [
    'ai-parsing-removal-2026-10-16.md',
    'draft-save-resume-plan-2026-10-16.md',
    'draft-save-resume-s3-2026-10-16.md',
    'private-chat-removal-2026-10-07.md',
    'architecture-audit-2026-10-15.md',
  ]) {
    assert.ok(exists(`docs/archive/${archived}`), `已退场 / 过程稿文档必须在 docs/archive/：${archived}`);
    assert.equal(exists(`docs/${archived}`), false, `不许在 docs/ 顶层再留一份：${archived}`);
  }
  const index = read('docs/archive/ARCHIVED-2026-10-17.md');
  assert.ok(index.includes('ai-parsing-removal-2026-10-16.md'), '归档索引要列出已归档文档');
  assert.ok(index.includes('当前架构'), '归档索引要说明"不代表当前架构"');
});
