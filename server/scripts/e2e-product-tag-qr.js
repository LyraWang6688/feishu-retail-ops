/**
 * 「货品信息 → 标签二维码」的**端到端自测**（作者 2026-10-12；走项目代码、真写**测试 Base**）。
 *
 * 证明业务负责人定的两条约定**真的生效**（不是"看起来生效"）：
 *   ① **新增货品 ⇒ 生成二维码并写回**（事件路径 `handleTableChanges` + `record_added`）；
 *   ② **改货号/颜色 ⇒ 编号变了 ⇒ 覆盖写回**（事件里公式列读不出 ⇒ 落第②层按编号判）；
 *   ③ **编号没变 ⇒ 不写**（幂等：不重复上传/写回）。
 *
 * 用法（⚠️ **只写授权测试 Base**；`assertWritableBase` 会拦住生产）：
 *   cd server && FEISHU_TARGET_ENV=test node --env-file=../.env scripts/e2e-product-tag-qr.js
 * ⚠️ 它会：给测试 Base 的「货品信息」补一列「标签二维码」（若没有）、挑一条**二维码为空**的真实
 *    记录来演示"新增路"、改它的货号（+E2E 后缀）、**跑完把货号改回去并让编码自愈**。
 *    测试数据不用删（AGENTS 第 1 条）。
 * ⚠️ **飞书公式列有延迟**：刚改完货号时记录里的「编号」可能还是旧值 —— 脚本会等它重算出来再触发
 *    （实测 1~10 秒）。这一条也是"为什么必须有每日兜底巡检"的真实理由之一。
 */
/* 端到端（**只写授权的测试 Base**）：新增 ⇒ 生成；改货号 ⇒ 更新；编号没变 ⇒ 不写 */
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1BitableGateway, textValue } = require('../src/services/v1BitableGateway');
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

  // ② 挑一条**二维码为空**的真实记录（"新增货品还没生成码"那一档）
  const all = await gateway.listAll('product');
  const target = all.find((item) => String(item.fields?.[F.number] || '').trim()
    && attachmentsOf(item.fields?.[F.tagQrCode]).length === 0);
  if (!target) { console.error('🔴 测试 Base 里没有"编号有值、二维码为空"的记录，无法演示新增路'); process.exit(1); }
  const id = target.record_id;
  const number1 = textValue(target.fields[F.number]).trim();
  say('② 用这条真实记录', `${id}（编号 ${number1}｜货号 ${target.fields[F.itemNo]}）`);
  say('   当前二维码', namesOf(target));

  // ③ 事件路径 + 「新增」动作 ⇒ 应生成并写回
  const r1 = await service.handleTableChanges([{ record_id: id, action: 'record_added' }]);
  say('③ 事件路径(record_added) ⇒', r1.results[0]);
  const a1 = namesOf(await gateway.get('product', id));
  say('   写回后的附件', a1);
  say('   期望文件名', buildFileName(number1));

  // ④ 改货号 ⇒ 编号变了；事件里公式列读不出（本用例不带字段值）⇒ 落第②层 ⇒ 覆盖
  const itemNo = String(target.fields[F.itemNo] || '').trim();
  const updated = await client.bitable.appTableRecord.update({
    path: { app_token: appToken, table_id: tableId, record_id: id },
    data: { fields: { [F.itemNo]: `${itemNo}E2E` } },
  });
  say('   改货号返回 code', `${updated?.code} ${updated?.msg || ''}`);
  // ⚠️ **飞书的公式列有延迟**：刚改完货号时，记录里的「编号」可能还是旧值
  //    （实测：改完 1 秒内读到的仍是旧编号；再过几秒才变）⇒ 这里等它算出来再触发。
  let number2 = number1;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
    // eslint-disable-next-line no-await-in-loop
    const now = await gateway.get('product', id);
    number2 = textValue(now.fields[F.number]).trim();
    if (number2 && number2 !== number1) break;
  }
  say('   改后货号', textValue((await gateway.get('product', id)).fields[F.itemNo]));
  say('   编号是否已重算', number2 !== number1 ? '是' : '⚠️ 30 秒内没重算（下面会如实体现）');
  say('④ 改货号后新编号', number2);
  const r2 = await service.handleTableChanges([{ record_id: id, action: 'record_edited' }]);
  say('   事件路径(record_edited) ⇒', r2.results[0]);
  const a2 = namesOf(await gateway.get('product', id));
  say('   写回后的附件', a2);
  say('   期望文件名', buildFileName(number2));

  // ⑤ 编号没变 ⇒ 幂等：不写
  const r3 = await service.handleTableChanges([{ record_id: id, action: 'record_edited' }]);
  say('⑤ 再触发一次（编号没变）⇒', r3.results[0]);
  const a3 = namesOf(await gateway.get('product', id));
  say('   附件（应与④相同）', a3);

  const ok = r1.results[0]?.status === 'written' && a1[0] === buildFileName(number1)
    && r2.results[0]?.status === 'written' && a2[0] === buildFileName(number2)
    && r3.results[0]?.status === 'skipped' && a3[0] === a2[0];
  // ⑥ 收尾：把货号改回去，并**再触发一次事件路径**让二维码自愈回原来的编号（测试数据复原）
  await client.bitable.appTableRecord.update({
    path: { app_token: appToken, table_id: tableId, record_id: id },
    data: { fields: { [F.itemNo]: itemNo } },
  });
  const restoreDeadline = Date.now() + 30000;
  while (Date.now() < restoreDeadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
    // eslint-disable-next-line no-await-in-loop
    const back = textValue((await gateway.get('product', id)).fields[F.number]).trim();
    if (back === number1) break;
  }
  const r4 = await service.handleTableChanges([{ record_id: id, action: 'record_edited' }]);
  const a4 = namesOf(await gateway.get('product', id));
  say('⑥ 收尾：货号改回后 ⇒', r4.results[0].status);
  say('   附件', a4);
  const restored = a4[0] === buildFileName(number1);

  console.log(`\n${ok ? '✅ 三条约定端到端成立：新增⇒生成 / 改货号⇒更新 / 编号没变⇒不写' : '🔴 有一步不成立，见上'}`);
  console.log(`${restored ? '✅ 测试数据已复原（货号与二维码都回到原值）' : '⚠️ 收尾没复原（下次跑会自愈）'}`);
  process.exit(ok ? 0 : 1);
})().catch((error) => { console.error('🔴 E2E 失败：', error.message); process.exit(1); });
