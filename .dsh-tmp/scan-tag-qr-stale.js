/**
 * 只读扫描：对「货品信息」全表统计「标签二维码」附件文件名 ≠ 当前编号应有文件名 的条数。
 * 走项目代码（V1BitableGateway.listAll + tagQrCodeService 的 buildFileName / attachmentsOf）。
 * 一个字都不写：只调 listAll（GET）。
 */
require('dotenv').config({ path: '/opt/box2bitable/.env' });
const { V1BitableGateway, textValue } = require('/opt/box2bitable/server/src/services/v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('/opt/box2bitable/server/src/config/v1BitableSchema');
const { buildFileName, attachmentsOf } = require('/opt/box2bitable/server/src/services/tagQrCodeService');

(async () => {
  const gateway = new V1BitableGateway();
  const F = V1_BITABLE_SCHEMA.tables.product.fields;
  const records = await gateway.listAll('product');
  const stale = [];
  const missing = [];
  const noNumber = [];
  const badName = []; // 有附件但 name 为空
  let ok = 0;
  for (const record of records) {
    const number = textValue(record?.fields?.[F.number]).trim();
    const existing = attachmentsOf(record?.fields?.[F.tagQrCode]);
    if (!number) { noNumber.push(record.record_id); continue; }
    const expected = buildFileName(number);
    if (!existing.length) {
      missing.push({ record_id: record.record_id, number });
      continue;
    }
    if (existing.some((item) => item.name === expected)) { ok += 1; continue; }
    if (existing.every((item) => !item.name)) badName.push(record.record_id);
    stale.push({
      record_id: record.record_id,
      number,
      expected_file_name: expected,
      existing_file_names: existing.map((item) => item.name),
    });
  }
  const report = {
    base: 'production (table_id ' + V1_BITABLE_SCHEMA.tables.product.tableId + ')',
    total_records: records.length,
    matching: ok,
    stale_count: stale.length,
    missing_attachment: missing.length,
    no_number: noNumber.length,
    attachment_without_name: badName.length,
    stale_first_10: stale.slice(0, 10),
    missing_first_10: missing.slice(0, 10),
    no_number_all: noNumber,
  };
  console.log('###SCAN_JSON###' + JSON.stringify(report));
})().catch((error) => {
  console.error('SCAN_FAILED ' + error.message);
  process.exit(1);
});
