'use strict';

/**
 * 售后链路关联字段：**只认 `{ record_ids }`**（issue #1074 的售后条线收窄）。
 *
 * AC-SL1 真实形状（listAll/get，SingleLink 18 / DuplexLink 21 同形）⇒ 解析出 id。
 * AC-SL2 空关联（没有 record_ids 键）⇒ []（不是"猜"）。
 * AC-SL3 无证据形状（{id} / {record_id} / {recordId} / 裸字符串 / link_record_ids）⇒ 一律 []，
 *        不再"顺手兼容"。
 * AC-SL4 源码哨兵：售后链路只 import 严格版，不再用全局 `linkedRecordIds`。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { salesLinkRecordIds } = require('../src/services/afterSalesLinkIds');

const realCell = (id) => ([{
  record_ids: [id], table_id: 'tblX', text: 'XSD-20261108-0005', text_arr: ['XSD-20261108-0005'], type: 'text',
}]);

test('AC-SL1 真实形状（record_ids）⇒ 解析出 id；数组/嵌套也认', () => {
  assert.deepEqual(salesLinkRecordIds(realCell('rec_1')), ['rec_1']);
  assert.deepEqual(salesLinkRecordIds([realCell('rec_1'), realCell('rec_2')]), ['rec_1', 'rec_2']);
  assert.deepEqual(salesLinkRecordIds([]), []);
  assert.deepEqual(salesLinkRecordIds(null), []);
});

test('AC-SL2 空关联（只有 table_id/text_arr/type）⇒ []', () => {
  assert.deepEqual(salesLinkRecordIds([{ table_id: 'tblX', text_arr: [], type: 'text' }]), []);
});

test('AC-SL3 无证据形状 ⇒ 一律 []（删掉的兜底不再生效）', () => {
  for (const value of [
    [{ id: 'rec_1' }],
    [{ record_id: 'rec_1' }],
    [{ recordId: 'rec_1' }],
    ['rec_1'],
    [{ link_record_ids: ['rec_1'] }],
  ]) {
    assert.deepEqual(salesLinkRecordIds(value), [], `不许再兼容：${JSON.stringify(value)}`);
  }
});

test('AC-SL4 源码哨兵：售后链路只用严格版（不再 import 全局 linkedRecordIds）', () => {
  for (const file of ['afterSalesScanService.js', 'afterSalesReturnService.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', file), 'utf8');
    assert.match(source, /salesLinkRecordIds/, `${file} 必须用严格版`);
    assert.doesNotMatch(source, /linkedRecordIds/, `${file} 不许再用全局 permissive 版`);
  }
});
