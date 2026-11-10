/**
 * 「货品信息 → 标签二维码」的**端到端自测**（走项目代码、真写**测试 Base**）。
 *
 * 证明 2026-11-11 定案后的两条约定真的生效（不是"看起来生效"）：
 *   ① **清空附件后触发新增事件 ⇒ 生成二维码并写回**（`handleTableChanges` + `record_added`）；
 *   ② **再触发一次 ⇒ 幂等跳过**（不重复上传 / 写回；与「编号」字段无关）。
 *
 * 用法（⚠️ **只写授权测试 Base**；`assertWritableBase` 会拦住生产）：
 *   cd server && FEISHU_TARGET_ENV=test node --env-file=../.env scripts/e2e-product-tag-qr.js
 */
// ⚠️ 本脚本原来不加载 `.env` ⇒ 裸跑会报"没配 Base"的假红；必须在 require 业务模块之前加载
//    （`v1BitableSchema` 的表 ID 是模块级求值）。
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { createTagQrCodeService, buildFileName, attachmentsOf } = require('../src/services/tagQrCodeService');
const { assertWritableBase } = require('../src/utils/writeTargetGuard');

const F = V1_BITABLE_SCHEMA.tables.product.fields;
const tableId = V1_BITABLE_SCHEMA.tables.product.tableId;
const appToken = process.env.FEISHU_V1_BITABLE_APP_TOKEN;
const say = (label, value) => console.log(`  ${label}：${typeof value === 'string' ? value : JSON.stringify(value)}`);
const namesOf = (record) => attachmentsOf(record?.fields?.[F.tagQrCode]).map((x) => x.name);

(async () => {
  assertWritableBase({ appToken, scriptName: 'e2e-tagqr' });
  if (!appToken || appToken !== process.env.FEISHU_V1_E2E_TEST_APP_TOKEN) {
    console.error('🔴 目标 Base 不是授权测试 Base ⇒ 拒绝写');
    process.exit(2);
  }
  const gateway = new V1BitableGateway();
  const client = gateway.client;
  const service = createTagQrCodeService({ gateway });

  // ① 测试 Base 补一列「标签二维码」（type 17 = 附件）——生产表有、测试 Base 之前没有
  if (!(await gateway.listFields('product')).some((f) => f.field_name === F.tagQrCode)) {
    await client.bitable.appTableField.create({
      path: { app_token: appToken, table_id: tableId },
      data: { field_name: F.tagQrCode, type: 17 },
    });
    say('① 已在测试 Base 新建字段', F.tagQrCode);
  } else {
    say('① 测试 Base 已有字段', F.tagQrCode);
  }

  // ② 挑一条真实记录，清空它的二维码（造出"要生成"的状态；测试数据不用删）
  const all = await gateway.listAll('product');
  if (!all.length) { console.error('🔴 测试 Base 里没有货品记录，无法自测'); process.exit(1); }
  const id = all[0].record_id;
  await client.bitable.appTableRecord.update({
    path: { app_token: appToken, table_id: tableId, record_id: id },
    data: { fields: { [F.tagQrCode]: [] } },
  });
  say('② 用这条真实记录', id);
  say('   已先清空二维码', `当前附件=[${namesOf(await gateway.get('product', id)).join(',')}]`);

  // ③ 事件路径 + 「新增」动作 ⇒ 生成并写回（内容/文件名只由 recordId 决定）
  const r1 = await service.handleTableChanges([{ record_id: id, action: 'record_added' }]);
  say('③ 事件路径(record_added) ⇒', r1.results[0]);
  const a1 = namesOf(await gateway.get('product', id));
  say('   写回后的附件', a1);
  say('   期望文件名', buildFileName(id));

  // ④ 再触发一次 ⇒ 幂等跳过（不重复上传 / 写回）
  const r2 = await service.handleTableChanges([{ record_id: id, action: 'record_edited' }]);
  say('④ 再触发一次(record_edited) ⇒', r2.results[0]);
  const a2 = namesOf(await gateway.get('product', id));
  say('   附件（应与③相同）', a2);

  const ok = r1.results[0]?.status === 'written' && a1[0] === buildFileName(id)
    && r2.results[0]?.status === 'skipped' && a2[0] === a1[0];
  console.log(`\n${ok ? '✅ 端到端成立：record_added ⇒ 生成；再触发 ⇒ 幂等跳过（与编号无关）' : '🔴 有一步不成立，见上'}`);
  process.exit(ok ? 0 : 1);
})().catch((error) => {
  console.error(`🔴 运行失败：${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
