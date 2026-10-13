'use strict';

/**
 * ⭐ 2026-10-13（她：「现在还是太慢，**加载到中间一直白屏**」）—— **骨架屏**的验收标准。
 *
 * 真测（本机真进程 + 真 session + 真测试 Base）：`product_ms 1969` + `sizes_ms 768` +
 * `inventory_ms 1410`（+ 未归属 ~1s）⇒ 取数要 4~6 秒，而这段是**服务端整页渲染**
 * ⇒ 读数据回来之前整页是白的 ✗。
 * 骨架屏的意义：**先出一屏**（不读任何表）⇒ 她点开就有东西看 ✓。
 *
 * AC：
 *   AC-SK1 **绝不空白**：扫到的那串 / 货号 / 颜色 + 尺码区 + 「正在读取…」都在
 *   AC-SK2 ⭐ **整页只有一段脚本**（哨兵 `scanAcceptSelfServe` / `labelPrintScanEntry` /
 *          `scanPrintFeedback` 那套口径不变 ✗）—— 填充逻辑必须写在**同一段**里
 *   AC-SK3 纯函数、**同步**返回、**不读任何表**（渲染层不碰 gateway ⇒ 这一屏才"立刻"）
 *   AC-SK4 文案**配置先行**（改 `config/scanPage.js` 的文案 ⇒ 页面跟着变 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { renderScanSkeleton } = require('../src/views/scanPageRenderer');
const { SCAN_PAGE } = require('../src/config/scanPage');

const VIEW = { number: 'X7303|绿色|A' };

test('AC-SK1 骨架屏绝不空白：货号 / 颜色 / 尺码区 + 「正在读取…」都在', () => {
  const html = renderScanSkeleton(VIEW);
  assert.match(html, /X7303/, '货号要看得见');
  assert.match(html, /绿色/, '颜色要看得见');
  assert.match(html, /尺码/, '尺码区要有占位');
  assert.ok(html.includes(SCAN_PAGE.texts.skeletonLoading), '要有那句"正在读取…"（不许空白 ✗）');
  assert.match(html, /data-view="scan-skeleton"/, '留一个可被脚本填充的容器');
  assert.match(html, /aria-busy="true"/, '无障碍：这一屏还在读');
  assert.equal(html.includes('undefined'), false, '不许把 undefined 画到页面上');
});

test('AC-SK2 ⭐ 整页**只有一段脚本**（填充逻辑写在同一段里）', () => {
  const html = renderScanSkeleton(VIEW);
  assert.equal((html.match(/<script/g) || []).length, 1, '整页只允许一段 <script>');
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.match(html, /fetch\(/, '填充靠这一类只读请求');
  assert.match(html, /\?data=1/, '填的是同一个地址的只读数据出口');
});

test('AC-SK3 纯函数 + 同步 + 不读任何表（所以这一屏"立刻"能出）', () => {
  // 渲染层拿不到 gateway（签名里没有）⇒ 结构上不可能在读表上等
  assert.equal(renderScanSkeleton.length <= 2, true);
  const html = renderScanSkeleton(VIEW);
  assert.equal(typeof html, 'string');
  assert.match(html, /^<!doctype html>/, '整页 HTML');
});

test('AC-SK4 文案配置先行：改配置就改页面', () => {
  const html = renderScanSkeleton(VIEW, { texts: { ...SCAN_PAGE.texts, skeletonLoading: '马上就好…' } });
  assert.match(html, /马上就好…/, '文案来自 config（不许写死在渲染层）');
  assert.equal(html.includes(SCAN_PAGE.texts.skeletonLoading), false);
});
