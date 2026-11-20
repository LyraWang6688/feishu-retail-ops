'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'workbench');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('采购页补货 / 上新不再渲染图例说明，卡片直接上移', () => {
  const config = read('config/procurement.js');
  const render = read('features/procurement/render.js');
  const replenish = read('features/procurement/replenish.js');
  const newProducts = read('features/procurement/newProducts.js');
  const css = read('procurement.css');

  assert.equal(/legends\s*:/.test(config), false, '图例配置已删除');
  assert.equal(/legendHtml/.test(render), false, '图例渲染函数已删除');
  assert.equal(/legendHtml/.test(replenish), false, '补货页不再调用图例');
  assert.equal(/legendHtml/.test(newProducts), false, '上新页不再调用图例');
  assert.equal(/\.pr-legend/.test(css), false, '图例样式已删除，不再留空白');
});
