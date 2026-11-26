'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('配品样例图上传：大图先压缩；413 有专用人话（2026-11-26）', () => {
  const shared = read('features/shared/imageCompress.js');
  assert.match(shared, /export async function compressImageFile/);
  assert.ok(shared.includes('maxEdge'), '最长边限制');
  assert.ok(shared.includes('toBlob'), '用 canvas 压成 JPEG');

  const page = read('features/domains/accessoryConfig.js');
  assert.ok(page.includes("from '../shared/imageCompress.js'"), '复用压缩工具');
  assert.ok(page.includes('await compressImageFile(file)'), '上传前先压缩');
  assert.ok(page.includes('error?.status === 413'), '413 单独提示');

  const texts = read('config/accessoryConfig.js');
  assert.match(texts, /uploadTooLarge/, '图片太大的人话');
});
