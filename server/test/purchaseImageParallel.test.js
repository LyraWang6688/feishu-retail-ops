/**
 * ⭐ 2026-10-29（业务负责人批准 **A 方案·安全并行**）：
 *   「把『生成 PNG』提到写表同时开始；写表成功后立刻『上传/发群/回填附件』。」
 *
 * 判据（都能真红）：
 *   AC-IP1 `prepareSupplierImages` 只**渲染**：每组一份、多组**并行**、不发送/不回填/不写表；
 *   AC-IP2 `deliverSupplierImagesInner` 收到 `preparedImages` ⇒ **不再渲染**，仍按顺序发群 + 回填附件；
 *   AC-IP3 没有 `preparedImages`（渲染失败/老调用方）⇒ **逐字退化为现场渲染**（今天的行为）；
 *   AC-IP5 预渲染的图要带**货号/颜色**（2026-11-09 真机：群图没有货号）——
 *          plan.items 只有业务键 ⇒ 渲染前用 `task.draft.items` 按「货品+尺码」补展示字段；plan 已冻结的值不覆盖。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_purchase_image_parallel';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'purchase_image_parallel_secret';

const documentImages = require('../src/services/purchase/documentImages');
const { SUPPLIER_SPLIT } = require('../src/config/supplierSplit');

const PLAN = {
  version: 1,
  batch_no: 'CGD-20261029-9999',
  batch_key: 'purchase_batch:task_parallel_1',
  items: [
    { item_key: 't:0', product_record_id: 'recA', size: 39, quantity: 1, supplier_record_id: 'sup_1' },
    { item_key: 't:1', product_record_id: 'recB', size: 41, quantity: 2, supplier_record_id: 'sup_2' },
  ],
  supplier_groups: [
    { supplier_record_id: 'sup_1', supplier_key: 'sup_1', group_key: 'supplier_group:b1:sup_1', document_key: 'supplier_document:CGD-20261029-9999:sup_1', indexes: [0] },
    { supplier_record_id: 'sup_2', supplier_key: 'sup_2', group_key: 'supplier_group:b1:sup_2', document_key: 'supplier_document:CGD-20261029-9999:sup_2', indexes: [1] },
  ],
};

const GROUPS = [
  { key: 'sup_1', supplierRecordId: 'sup_1', items: [PLAN.items[0]], indexes: [0], groupKey: PLAN.supplier_groups[0].group_key, documentKey: PLAN.supplier_groups[0].document_key },
  { key: 'sup_2', supplierRecordId: 'sup_2', items: [PLAN.items[1]], indexes: [1], groupKey: PLAN.supplier_groups[1].group_key, documentKey: PLAN.supplier_groups[1].document_key },
];

/** 假 `this`：只实现这两步用到的口子（不碰真表、不 require 真客户端）。 */
const makeThis = ({ renderDelayMs = 0 } = {}) => {
  const calls = { render: [], sendImage: [], sendText: [], attachments: [] };
  const fake = {
    sandboxChatId: '',
    supplierSplit: SUPPLIER_SPLIT,
    store: { update: async () => ({}) },
    orderBatches: { findDocument: async () => null },
    batchLocator: { rememberGroupMessage: async () => ({}) },
    resolveSupplierName: async (id) => ({ sup_1: '一代千金', sup_2: '信踏' }[id] || ''),
    resolvePurchaseGroupTarget: () => ({ chatId: 'oc_test_group' }),
    supplierReportGroups: () => GROUPS,
    mentionOperatorText: (openId, text) => text,
    images: {
      render: async (input) => {
        calls.render.push(input);
        if (renderDelayMs) await new Promise((resolve) => setTimeout(resolve, renderDelayMs));
        return Buffer.from(`PNG:${input.supplierName}`);
      },
    },
    sendImage: async (chatId, png) => {
      calls.sendImage.push({ chatId, png: png.toString() });
      return { messageId: `om_img_${calls.sendImage.length}`, threadId: 'omt_1' };
    },
    sendText: async (chatId, text) => {
      calls.sendText.push({ chatId, text });
      return { messageId: `om_txt_${calls.sendText.length}`, threadId: 'omt_1' };
    },
    writeSupplierImageAttachment: async (options) => {
      calls.attachments.push(options);
      return { written: true, record_id: 'rec_batch', file_name: options.fileNameSuffix };
    },
  };
  return { fake, calls };
};

const task = { draft: { items: PLAN.items, operator_open_id: 'ou_test' } };

test('AC-IP1 prepareSupplierImages：每组渲染一份、**多组并行**、不发送/不回填/不写表', async () => {
  const { fake, calls } = makeThis({ renderDelayMs: 60 });
  const startedAt = Date.now();
  const prepared = await documentImages.prepareSupplierImages.call(fake, 'task_parallel_1', task, PLAN);
  const elapsed = Date.now() - startedAt;

  assert.ok(prepared instanceof Map);
  assert.equal(prepared.size, 2, '两个供应商组 ⇒ 两份 PNG');
  assert.equal(calls.render.length, 2, '每组各渲染一次');
  assert.deepEqual(calls.render.map((one) => one.supplierName).sort(), ['一代千金', '信踏']);
  assert.ok(elapsed < 110, `两组应**并行**渲染（各 60ms，实际 ${elapsed}ms；若串行会 ≥120ms）`);
  assert.equal(calls.sendImage.length, 0, '准备工作**绝不发送**');
  assert.equal(calls.sendText.length, 0);
  assert.equal(calls.attachments.length, 0, '准备工作**绝不回填附件**（回填需要批次 record_id，写表之后才做）');
  assert.equal(prepared.get(PLAN.supplier_groups[0].group_key).toString(), 'PNG:一代千金');
});

test('AC-IP5 预渲染图片带货号/颜色：从 draft.items 补（plan 已冻结的展示字段不覆盖）', async () => {
  const { fake, calls } = makeThis();
  // plan.items 是引擎冻结的**纯业务键** —— 没有 item_no / color（真机现场就是这样）
  assert.equal(PLAN.items[0].item_no, undefined);
  const plan = { ...PLAN, items: [{ ...PLAN.items[0] }, { ...PLAN.items[1], item_no: 'FROZEN_NO' }] };
  const draftTask = {
    draft: {
      items: [
        { product_record_id: 'recA', item_no: '86822', color: '黑色', number: '86822|黑色|男', entries: [{ size: 39, quantity: 1 }] },
        { product_record_id: 'recB', item_no: '832', color: '咖色', number: '832|咖色|女', size: 41, quantity: 2 },
      ],
    },
  };
  await documentImages.prepareSupplierImages.call(fake, 'task_parallel_no', draftTask, plan);
  const bySupplier = new Map(calls.render.map((one) => [one.supplierName, one.items[0]]));
  assert.equal(bySupplier.get('一代千金').item_no, '86822', 'plan 缺货号 ⇒ 从 draft 补');
  assert.equal(bySupplier.get('一代千金').color, '黑色');
  assert.equal(bySupplier.get('信踏').item_no, 'FROZEN_NO', 'plan 已冻结的货号优先（不被 draft 覆盖）');
});

test('AC-IP2 deliver 收到 preparedImages ⇒ 不再渲染，仍按顺序发群 + 回填附件', async () => {
  const { fake, calls } = makeThis();
  const prepared = new Map([
    [PLAN.supplier_groups[0].group_key, Buffer.from('PNG:一代千金')],
    [PLAN.supplier_groups[1].group_key, Buffer.from('PNG:信踏')],
  ]);
  const posting = { batch_no: PLAN.batch_no, batch_key: PLAN.batch_key, supplier_groups: PLAN.supplier_groups, request_ids: ['r1', 'r2'] };
  const result = await documentImages.deliverSupplierImagesInner.call(fake, 'task_parallel_1', task, posting, { preparedImages: prepared });

  assert.equal(calls.render.length, 0, '🔴 已经有渲染好的图 ⇒ 不许再渲染一遍（这就是省下的耗时）');
  assert.equal(calls.sendImage.length, 2);
  assert.deepEqual(calls.sendImage.map((one) => one.png).sort(), ['PNG:一代千金', 'PNG:信踏']);
  assert.equal(calls.sendText.length, 2, '每个供应商一条带 @ 的文字');
  assert.equal(calls.attachments.length, 2, '每组回填一张附件');
  assert.deepEqual(calls.attachments.map((one) => one.png.toString()).sort(), ['PNG:一代千金', 'PNG:信踏']);
  assert.deepEqual(result.sent.sort(), ['一代千金', '信踏']);
});

test('AC-IP3 没有 preparedImages（渲染失败/老调用方）⇒ 逐字退化为现场渲染', async () => {
  const { fake, calls } = makeThis();
  const posting = { batch_no: PLAN.batch_no, batch_key: PLAN.batch_key, supplier_groups: PLAN.supplier_groups, request_ids: ['r1', 'r2'] };
  const result = await documentImages.deliverSupplierImagesInner.call(fake, 'task_parallel_1', task, posting, {});
  assert.equal(calls.render.length, 2, '没有预渲染 ⇒ 现场渲染每组一次（行为与今天一致）');
  assert.equal(calls.sendImage.length, 2);
  assert.deepEqual(result.sent.sort(), ['一代千金', '信踏']);
});


test('AC-IP4 生产路径：采购文字走统一通知服务（text 格式 + 回复图片话题）', async () => {
  const { fake, calls } = makeThis();
  const notifications = [];
  fake.notificationService = {
    send: async (event, data, options) => {
      notifications.push({ event, data, options });
      return { ok: true, messageId: 'om_notice', threadId: 'omt_1' };
    },
  };
  const prepared = new Map([
    [PLAN.supplier_groups[0].group_key, Buffer.from('PNG:一代千金')],
    [PLAN.supplier_groups[1].group_key, Buffer.from('PNG:信踏')],
  ]);
  const posting = { batch_no: PLAN.batch_no, batch_key: PLAN.batch_key, supplier_groups: PLAN.supplier_groups, request_ids: ['r1'] };
  const result = await documentImages.deliverSupplierImagesInner.call(fake, 'task_parallel_1', task, posting, { preparedImages: prepared });
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].event, 'purchase_request_created');
  assert.match(notifications[0].data.text, /一代千金/);
  assert.equal(notifications[0].options.target.receiveIdType, 'chat_id');
  assert.equal(notifications[0].options.target.receiveId, 'oc_test_group');
  assert.equal(notifications[0].options.replyToMessageId, 'om_img_1');
  assert.equal(notifications[0].options.inThread, true);
  assert.equal(calls.sendText.length, 0, '生产路径不再走旧 sendText');
  assert.equal(result.sent.length, 2);
});
