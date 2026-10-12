/**
 * ⭐ 工作台两个**独立子页**的品牌行退场（业务负责人 **2026-10-12** 批准，batch① 的收尾）。
 *
 * 她的原话（batch①）：「把 title『邯美皮鞋数字经营工作台经营管理中心』去掉。移动端屏幕本来就小，
 * **去掉后能省出不少空间**」；Lead 转达的口径：
 *   · ⭐ 两个子页（`inventory-adjustment.html` / `label-print.html`）的 eyebrow
 *     「邯美数智经营工作台」**也一起收掉**（那是**同一个品牌行** ⇒ 同一次省空间）；
 *   · ⚠️ **各自的功能标题 h1 保留**（「库存手工调整」/「鞋盒标签打印」）——
 *     那是页面的功能标题，删了就没标题；
 *   · ⚠️ **不改功能**：登录行 / 独立页导航 / 页面宿主一个字节不动。
 *
 * 验收标准（**先写后做**）
 *   AC1 两个子页里**不再有**品牌行（`class="eyebrow"`）—— 品牌串也不再出现在**可见 markup** 里
 *       （`<title>` 是浏览器标签、不进页面、不占空间 ⇒ 不算"可见"）。
 *   AC2 两个子页各自的 **h1 逐字保留**。
 *   AC3 登录行**逐字保留**（两个子页各一条）。
 *   AC4 独立页骨架（`compact-header` / `standalone-nav` / 页面宿主）一个不少；页面还能开。
 *   AC5 仅剩的两处子页改动之外，主页面 `index.html` 仍是 batch① 的样子（标题串一个都没有）。
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 去掉 `<title>` 之后再判"可见 markup 里有没有这串"（浏览器标题不进页面）。 */
const withoutTitle = (html) => html.replace(/<title>[\s\S]*?<\/title>/g, '');

const PAGES = [
  { file: 'inventory-adjustment.html', h1: '库存手工调整' },
  { file: 'label-print.html', h1: '鞋盒标签打印' },
];
const BRAND = '邯美数智经营工作台';

test('AC1 两个独立子页不再有品牌行（eyebrow），可见 markup 里也没有品牌串', () => {
  for (const { file } of PAGES) {
    const html = read(file);
    assert.ok(!/class="eyebrow"/.test(html), `${file} 不许再留品牌行（.eyebrow）`);
    assert.ok(!withoutTitle(html).includes(BRAND),
      `${file} 的可见部分不许再出现「${BRAND}」`);
  }
});

test('AC2 两个子页各自的 h1（功能标题）逐字保留', () => {
  for (const { file, h1 } of PAGES) {
    const html = read(file);
    assert.ok(html.includes(`<h1>${h1}</h1>`), `${file} 的功能标题 h1 必须逐字保留：${h1}`);
  }
});

test('AC3 登录行逐字保留（两个子页各一条）', () => {
  for (const { file } of PAGES) {
    const html = read(file);
    assert.ok(html.includes('<span id="auth-status" class="muted">正在检查飞书登录状态…</span>'),
      `${file} 的登录状态行逐字保留`);
    assert.ok(html.includes('<button id="logout" class="btn btn-ghost hidden" type="button">退出登录</button>'),
      `${file} 的「退出登录」按钮逐字保留`);
    assert.ok(html.includes('<div class="auth">'), `${file} 的 .auth 那块仍在`);
  }
});

test('AC4 独立页骨架一个不少（compact-header / 独立页导航 / 页面宿主）', () => {
  for (const { file } of PAGES) {
    const html = read(file);
    assert.ok(html.includes('class="header compact-header"'), `${file} 的 header 骨架仍在`);
    assert.ok(html.includes('class="standalone-nav"'), `${file} 的独立页导航仍在`);
    assert.ok(/<a href="\/workbench\/">返回完整工作台<\/a>/.test(html), `${file} 仍能回工作台`);
    assert.ok(html.includes('id="standalone-host"'), `${file} 的页面宿主仍在`);
    assert.ok(html.includes('styles/tokens.css') && html.includes('styles/base.css'),
      `${file} 仍走同一套主题（颜色只在 tokens.css）`);
  }
});

test('AC5 主页面仍是 batch① 的样子：那串标题一个都没有', () => {
  const html = read('index.html');
  assert.ok(!html.includes('经营管理中心'));
  assert.ok(!html.includes(BRAND));
  assert.ok(html.includes('<title>邯美工作台</title>'));
});
