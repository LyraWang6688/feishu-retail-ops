'use strict';

/**
 * 关联字段读取的源码哨兵（2026-11-17）：
 *   · 采购链路统一走 v1Gateway/cells.linkedRecordIds；
 *   · 不再各自写 linkedIdsOf / recordIdsOf 之类的宽容解析。
 *
 * ⚠️ 标签打印在 #1284 单独清理，等它合入后可把 labelPrintRequestLogService 加回这里。
 * 全仓其它域仍按 issue #1074 的节奏单独收窄。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCES = [
  'procurementPageData.js',
];

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', name), 'utf8');

test('关联字段读取：采购 / 配品销售统一走 linkedRecordIds，不再手写宽容解析', () => {
  for (const name of SOURCES) {
    const source = read(name);
    assert.match(source, /linkedRecordIds/, `${name} 必须使用统一读取 helper`);
    assert.equal(/const (linkedIdsOf|recordIdsOf)\s*=/.test(source), false, `${name} 又长回了自定义关联解析`);
    assert.equal(/value\.record_id\s*\|\|\s*value\.recordId\s*\|\|\s*value\.id/.test(source), false,
      `${name} 又长回了宽容 id fallback`);
  }
});
