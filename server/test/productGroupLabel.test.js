'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLabelPrintService } = require('../src/services/labelPrintService');

const GROUP_ID = 'rec_group_1';
const MEMBER_A = 'rec_member_a';
const MEMBER_B = 'rec_member_b';

const fakeGateway = {
  async get(table, id) {
    if (table !== 'productGroup' || id !== GROUP_ID) return null;
    return {
      record_id: GROUP_ID,
      fields: {
        货品组: 'JXN9573',
        关联货品: [{ record_ids: [MEMBER_A, MEMBER_B] }],
        单价: 320,
        颜色: [{ text: '黑色' }],
      },
    };
  },
  async getBatch(table, ids) {
    assert.equal(table, 'product');
    return ids.map((id) => ({ record_id: id, fields: { 编号: id === MEMBER_A ? '9573-28|黑色|女' : '9573-45|黑色|女' } }));
  },
  async listByFilter(table, filter) {
    assert.equal(table, 'liveInventory');
    if (filter.includes(MEMBER_A)) {
      return [
        { fields: { 库存键: '9573-28|黑色|女|35', 尺码: '35', 所属状态: '门盒' } },
        { fields: { 库存键: '9573-28|黑色|女|36', 尺码: '36', 所属状态: '门盒' } },
      ];
    }
    if (filter.includes(MEMBER_B)) {
      return [{ fields: { 库存键: '9573-45|黑色|女|38', 尺码: '38', 所属状态: '样品' } }];
    }
    return [];
  },
};

test('货品组标签：组公式颜色/单价 + 成员库存尺码汇总 + /g 二维码', async () => {
  const service = createLabelPrintService(fakeGateway);
  const data = await service.labelForGroup(GROUP_ID);
  assert.equal(data.labels.length, 1);
  const label = data.labels[0];
  assert.equal(label.number, 'JXN9573');
  assert.equal(label.color, '黑色');
  assert.equal(label.price, 320);
  assert.equal(label.total_qty, 3);
  assert.deepEqual(label.sizes.map((item) => item.size + 'x' + item.qty), ['35x1', '36x1', '38x1']);
  assert.equal(label.scan_url, 'https://hm.bamamei.online/g/' + GROUP_ID);
  assert.equal(data.qr.url_template, 'https://hm.bamamei.online/g/{groupId}');
  assert.ok(label.qr_svg.includes('<svg'));
  assert.equal(label.print_time, undefined, '打印时间由队列渲染时统一写入');
});
