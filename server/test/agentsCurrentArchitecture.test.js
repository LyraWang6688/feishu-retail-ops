'use strict';

/**
 * ⭐⭐ 2026-10-17（业务负责人）：AGENTS.md 自相矛盾且与 README 冲突 ——
 *   上一轮某工具做"项目概述"时忠实复述了 AGENTS.md 里「当前 V1 的销售录入入口是飞书群聊机器人」
 *   这一句，于是输出了「基于飞书群聊…」✗。根因 = **AGENTS.md 的现状段没跟上入口演进**。
 *
 * 本用例 = **AGENTS.md 与现行架构的一致性哨兵**（与 `readmeCurrentArchitecture.test.js` 同款写法）：
 *   ① 前 10 行内必须能读到「扫一扫」和「多维表格表单」（AI 读前几行就拿到正确答案）；
 *   ② 不许再把群聊/私聊/语音/拍照识别当成现行入口；
 *   ③ 历史入口必须被明确标成"已退场 / 已删除"（不是删得无痕）；
 *   ④ 不许引用会漂移的具体行号（`origin/main 第 N–M 行` 那类）。
 * ⚠️ "能真红"：把「当前 V1 的销售录入入口是飞书群聊机器人」塞回 AGENTS.md ⇒ 本用例必红（已手工验过）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS = path.join(__dirname, '..', '..', 'AGENTS.md');
const source = fs.readFileSync(AGENTS, 'utf8');
const lines = source.split('\n');

test('AGENTS 前 10 行就写明现行入口（扫一扫 UI 表单 + 多维表格表单）', () => {
  const head = lines.slice(0, 10).join('\n');
  assert.ok(head.includes('扫一扫'), 'AGENTS 前 10 行必须出现「扫一扫」');
  assert.ok(head.includes('多维表格表单'), 'AGENTS 前 10 行必须出现「多维表格表单」');
  assert.match(source, /退场|已删除/, 'AGENTS 必须说明历史入口已退场 / 已删除');
});

test('AGENTS 不许再把群聊/私聊/语音/拍照识别当成现行入口（塞回即红）', () => {
  // ① 她点名的那句原话（上一轮工具就是被它带偏的）
  assert.equal(source.includes('当前 V1 的销售录入入口'), false,
    '⛔ AGENTS 不许再出现「当前 V1 的销售录入入口…」这种过时句（塞回 ⇒ 红）');
  // ② 任何"当前…入口是…群聊"的句式（按行判，避免误伤"历史入口"小节里的沿革叙述）
  for (const line of lines) {
    assert.equal(/当前[^。\n]{0,40}入口[^。\n]{0,20}群聊/.test(line), false,
      `⛔ 不许把群聊写成现行入口：${line.trim().slice(0, 80)}`);
    assert.equal(/群聊入口（\d{4}-\d{2}-\d{2} 起）/.test(line), false,
      `⛔ 不许再出现「群聊入口（某年某月某日起）」这种"现行"句式：${line.trim().slice(0, 80)}`);
  }
  // ③ 历史入口必须有独立的小节/明确标注（她选的处置：保留但标明已退场）
  assert.ok(source.includes('已退场入口'), 'AGENTS 必须有「已退场入口」小节/标注');
});

test('AGENTS 不许引用会漂移的具体行号（origin/main 第 N–M 行那类）', () => {
  assert.equal(/origin\/main\s*第/.test(source), false,
    '⛔ 不许写「origin/main 第 N–M 行」（行号会漂移；那段逻辑现在是拒绝分支）');
});
