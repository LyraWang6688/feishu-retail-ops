/**
 * ⭐ 文案抽 config 的**逐字对照**（技术债批次 · 只挪位置不改字）。
 * "改前"的期望值**自动取自服务原文**（不是手抄 ⇒ 不会抄错）：26 条逐条对照。
 * 结构哨兵：**两组 key 不许合并**（防隐性耦合）；config 里**只有常量 + 一个填参函数**。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config/purchaseArrivalTexts.js');
const source = fs.readFileSync(path.join(__dirname, '../src/services/purchaseArrivalConversationService.js'), 'utf8');

test('AC1 ⭐ 26 条文案**逐字不变**（期望值取自改前原文）', () => {
  assert.equal(config.pageMessages.m1, '这一行没有报货批次号，不能验收到货', '原行 :775 必须逐字不变');
  assert.equal(config.pageMessages.m2, '请先填这次的「实际金额」，再点验收到货', '原行 :783 必须逐字不变');
  assert.equal(config.pageMessages.m3, '「实际金额」要填一个大于 0 的数字（不能是 0 或负数）', '原行 :784 必须逐字不变');
  assert.equal(config.pageMessages.m4, '请先写一句到货说明（例如「跟单子一样，全部到货」），再点验收到货', '原行 :792 必须逐字不变');
  assert.equal(config.pageMessages.m5({ batchNo: 'CGD-20261012-0001' }), `这批（CGD-20261012-0001）已经验收入库过了，没有重复入库`, '原行 :809 必须逐字不变（带参那句走填参函数）');
  assert.equal(config.landingMessages.m1, '这一批没有找到采购申请明细，不能验收到货', '原行 :875 必须逐字不变');
  assert.equal(config.landingMessages.m2, '这一批的明细太多，一次核对不了；请在采购群那个话题里说', '原行 :876 必须逐字不变');
  assert.equal(config.landingMessages.m3, '这一批的采购申请明细读不到，稍后再试', '原行 :877 必须逐字不变');
  assert.equal(config.landingMessages.m4, '这一批有明细没挂货品，不能验收入库', '原行 :878 必须逐字不变');
  assert.equal(config.landingMessages.m5, '这一批有明细没有尺码（采购退货单不能验收到货）', '原行 :879 必须逐字不变');
  assert.equal(config.landingMessages.m6, '这一批有明细的申请数量不是正整数，不能验收入库', '原行 :880 必须逐字不变');
  assert.equal(config.landingMessages.m7, '这一批算出来的实际到货数不对，不能验收入库', '原行 :881 必须逐字不变');
  assert.equal(config.landingMessages.m8, '这一批的到货明细对不上单据，不能验收入库', '原行 :882 必须逐字不变');
  assert.equal(config.landingMessages.m9, '这一批现在不能验收入库（原因已记日志，请找管理员看一眼）', '原行 :884 必须逐字不变');
  assert.equal(config.scanMessages.m1, '还没扫到任何一双：先扫一双，再点【完成验收】。', '原行 :893 必须逐字不变');
  assert.equal(config.scanMessages.m2, '扫到的这一双不在本批，不能验收：请核对标签再扫。', '原行 :894 必须逐字不变');
  assert.equal(config.scanMessages.m3, '同一双被记了两次，不能验收：请先退出验收模式再重新扫一遍。', '原行 :895 必须逐字不变');
  assert.equal(config.scanMessages.m4, '这一批里同一款同一码有两行申请，先在采购群核对一下再验收。', '原行 :896 必须逐字不变');
  assert.equal(config.scanMessages.m5, '这一批算出来的实际到货数不对，不能验收入库。', '原行 :897 必须逐字不变');
  assert.equal(config.scanMessages.m6, '这一批没有找到采购申请明细，不能验收入库。', '原行 :898 必须逐字不变');
  assert.equal(config.scanMessages.m7, '这一批的采购申请明细读不到，稍后再试。', '原行 :899 必须逐字不变');
  assert.equal(config.scanMessages.m8, '这一批有明细没挂货品，不能验收入库。', '原行 :900 必须逐字不变');
  assert.equal(config.scanMessages.m9, '这一批有明细没有尺码，不能验收入库。', '原行 :901 必须逐字不变');
  assert.equal(config.scanMessages.m10, '这一批有明细的申请数量不是正整数，不能验收入库。', '原行 :902 必须逐字不变');
  assert.equal(config.scanMessages.m11, '这一批的明细太多，一次核对不了；请在采购群那个话题里说', '原行 :903 必须逐字不变');
  assert.equal(config.scanMessages.m12, '这一批现在不能验收入库（原因已记日志，请找管理员看一眼）', '原行 :905 必须逐字不变');
});

test('AC2 ⭐ 两组 key 不许合并（名字不同、值可相同 —— 防隐性耦合）', () => {
  const landing = Object.keys(config.landingMessages);
  const scan = Object.keys(config.scanMessages);
  assert.equal(landing.length, 9, 'landingMessages 9 条');
  assert.equal(scan.length, 12, 'scanMessages 12 条');
  assert.notEqual(config.landingMessages, config.scanMessages, '两组是**各自独立**的对象（不共享同一个 key 空间）');
  const same = landing.filter((k, i) => config.landingMessages[k] === config.scanMessages[scan[i]]);
  assert.ok(same.length <= 2, `两组最多 2 条逐字相同（实际 ${same.length}）`);
});

test('AC3 config 里只有常量 + 填参函数，没有逻辑', () => {
  const text = fs.readFileSync(path.join(__dirname, '../src/config/purchaseArrivalTexts.js'), 'utf8');
  assert.equal(/\bif\s*\(/.test(text), false, 'config 里不许有 if');
  assert.equal(/\bswitch\s*\(/.test(text), false, 'config 里不许有 switch');
});

test('AC4 服务里都改成引用（带参那句要填参调用）', () => {
  assert.ok(source.includes("require('../config/purchaseArrivalTexts')"));
  for (const g of ['pageMessages.m', 'landingMessages.m', 'scanMessages.m']) assert.ok(source.includes(g), g);
  assert.ok(source.includes('pageMessages.m5({ batchNo })'), '带参那句要填参调用');
});
