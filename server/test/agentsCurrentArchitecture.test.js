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

test('环境变量段：已无读取点的变量不许写成"当前核心/必须配"（塞回即红）', () => {
  const coreStart = source.indexOf('**当前 V1 核心（缺一不可）**');
  assert.ok(coreStart >= 0, 'AGENTS 必须有「当前 V1 核心」段');
  // 核心段 = 标题 ＋ 随后的 bullet 列表；到第一个空行（后面跟的是"无读取点"说明，不算核心）
  const blockEnd = source.indexOf('\n\n', coreStart + 10);
  const core = source.slice(coreStart, blockEnd > 0 ? blockEnd : source.length);
  for (const dead of ['TEXT_LLM', 'VISION_LLM', 'ARK_', 'PURCHASE_ARRIVAL_INTAKE_ENABLED']) {
    assert.equal(core.includes(dead), false,
      `⛔ 「当前 V1 核心」段里不许出现已无读取点的 ${dead}（塞回 ⇒ 红）`);
  }
  // 死变量只能以"无读取点"的形式出现（不是被当成开关/核心配置）
  for (const line of lines.filter((row) => row.includes('TEXT_LLM'))) {
    assert.match(line, /无运行期读取点|不要再配/, `⛔ TEXT_LLM 只能以"无读取点"说明出现：${line.trim().slice(0, 100)}`);
  }
  // 群聊/机器人/表情三个旧变量：不许再被描述成"必须显式配"的入口依赖
  assert.equal(source.includes('群聊采购链路（缺了不会报错'), false,
    '⛔ 不许再有「群聊采购链路（缺了不会报错…必须显式配）」这种入口依赖描述');
  for (const dead of ['LARK_BOT_OPEN_ID', 'LARK_ACK_REACTION']) {
    const line = lines.find((row) => row.trim().startsWith('- `' + dead + '`'));
    assert.ok(line, `AGENTS 必须说明 ${dead} 的现状`);
    assert.match(line, /无运行期读取点/, `⛔ ${dead} 必须明确标注"无运行期读取点"（塞回"必须配" ⇒ 红）`);
  }
  // HTTP 入口表：群聊/私聊不再是"处理"，而是静默拒绝
  const row = lines.find((line) => line.includes('`POST /api/lark/events`'));
  assert.ok(row, 'HTTP 入口表必须有 POST /api/lark/events 这一行');
  assert.match(row, /静默拒绝/, '⛔ 该行必须写明"群聊/私聊消息到达即静默拒绝"');
  assert.equal(row.includes('群聊 / 群话题**消息、卡片动作'), false,
    '⛔ 不许再把"群聊/群话题消息"写成被处理的入口（塞回 ⇒ 红）');
});
