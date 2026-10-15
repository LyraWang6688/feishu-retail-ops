#!/usr/bin/env node
/**
 * test-base-add-voucher-column.mjs —— 给**测试 Base** 的「收款方式管理」补上「团购券管理」那一列（**关联字段 type 21**）
 *
 * ## 为什么需要它
 * 券机制（#704 已合 ✓）的真机端到端**验收不了** —— 因为**测试 Base 缺这一列** ✗
 * （两份 PR 都如实标了：`docs/payment-method-voucher-link-2026-10-16.md` 的 D1 ✓）
 * 她的规则（逐字）：「**测试 Base …… 可以随便写，不用问她**」⇒ 测试 Base 就是拿来造的 ✓
 *
 * ## 🔴 闸门（照 `scripts/e2e-run.mjs` 的三条形状 ✓ 一条都不少）
 * 1. `FEISHU_TARGET_ENV` 必须是 `test`（否则拒绝运行 ✗）
 * 2. app_token **必须**等于 `FEISHU_V1_E2E_TEST_APP_TOKEN`（**业务负责人授权的、可写的测试 Base**）——
 *    取不到 / 不等于 ⇒ **拒绝运行** ✗（保守闸门：宁可跑不了，也不许写错 Base）
 * 3. app_token 命中**禁止写入清单**（`FEISHU_V1_FORBIDDEN_APP_TOKENS` / 单数 `FEISHU_V1_PROD_APP_TOKEN`，
 *    逗号分隔）⇒ **拒绝运行** ✗
 *    ⚠️ 本机 `.env` **刻意不放**生产 token（AGENTS §8「物理上够不着」）⇒ 这一条在本机是**空转**的：
 *       运行期会**如实打一条 warn** 说明这件事 ✓（不是只写在注释里 ✗）
 *
 * ## 用法
 * ```bash
 * node scripts/test-base-add-voucher-column.mjs --check-only   # **只读**：看有没有那一列（0 写入）
 * node scripts/test-base-add-voucher-column.mjs               # 缺则**建**（幂等；已存在则跳过）
 * ```
 * 🔴 **绝不硬编码任何 token**（全从 env 读 ✓）· 🔴 **不用飞书 CLI**（走官方 SDK ✓）· 🔴 **不碰 `src/**`** ✓
 *
 * ## 生产真表那列的属性（**来源**：业务负责人侧的**只读**核对结果，本机够不着生产 ✗）
 * · 名字 `团购券管理` · type `21`（关联字段）· `property.table_id = tblz2kM1CIGkcWsM`
 * ⚠️ 本脚本**不读生产**（本机没有生产凭证 ✓）⇒ 这行属性是**照抄已核结果**，由 `docs/test-base-voucher-column-2026-10-16.md` 留档 ✓
 */

import { createRequire } from 'node:module';
import lark from '@larksuiteoapi/node-sdk';

const require = createRequire(import.meta.url);
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema.js');

const VOUCHER_FIELD_NAME = '团购券管理';
const VOUCHER_FIELD_TYPE = 21;
const VOUCHER_LINK_TABLE_ID = 'tblz2kM1CIGkcWsM';
const CHECK_ONLY = process.argv.includes('--check-only');

const say = (message) => process.stdout.write(`${message}\n`);
const fail = (message) => { process.stderr.write(`✗ ${message}\n`); process.exit(1); };

/** 🔴 闸门（在**建 client 之前**跑完 —— 照 `e2e-run.mjs` F-6 的形状 ✓） */
const guard = () => {
  const testBase = String(process.env.FEISHU_V1_E2E_TEST_APP_TOKEN || '').trim();
  const appToken = String(process.env.FEISHU_V1_BITABLE_APP_TOKEN || '').trim();
  const targetEnv = String(process.env.FEISHU_TARGET_ENV || '').trim();
  const forbidden = String(
    process.env.FEISHU_V1_FORBIDDEN_APP_TOKENS || process.env.FEISHU_V1_PROD_APP_TOKEN || '',
  ).split(',').map((token) => token.trim()).filter(Boolean);

  if (targetEnv !== 'test') {
    fail(`FEISHU_TARGET_ENV 必须是 \`test\`（现在 ${targetEnv ? `是 \`${targetEnv}\`` : '未设置'}）—— 本脚本只写测试 Base，拒绝运行`);
  }
  if (!testBase) fail('缺少 `FEISHU_V1_E2E_TEST_APP_TOKEN`（授权可写的测试 Base），拒绝运行');
  if (!appToken) fail('缺少 `FEISHU_V1_BITABLE_APP_TOKEN`，拒绝运行');
  if (appToken !== testBase) {
    fail('app_token **不等于**授权可写的测试 Base —— 拒绝运行（宁可跑不了，也不许写错 Base ✗）');
  }
  if (forbidden.includes(appToken)) {
    fail('app_token 命中**禁止写入清单**（生产 Base）—— 本脚本只允许写测试 Base，已拒绝运行 ✗');
  }
  if (!forbidden.length) {
    say('⚠️ warn：本机没有配 `FEISHU_V1_FORBIDDEN_APP_TOKENS` / `FEISHU_V1_PROD_APP_TOKEN`（禁写清单**空转** ✓）——'
      + ' 按 AGENTS §8，本机**刻意不配**生产凭证（物理上够不着 ✓）；上面那条"不等于测试 Base 即拒绝"仍是**实拦** ✓');
  }
  say(`✓ 闸门通过：FEISHU_TARGET_ENV=${targetEnv} · app_token = 授权测试 Base ✓`);
  return { appToken };
};

const main = async () => {
  const { appToken } = guard();
  const appId = String(process.env.LARK_AGENT_APP_ID || '').trim();
  const appSecret = String(process.env.LARK_AGENT_APP_SECRET || '').trim();
  if (!appId || !appSecret) fail('缺少 `LARK_AGENT_APP_ID` / `LARK_AGENT_APP_SECRET`，拒绝运行');

  const tableId = V1_BITABLE_SCHEMA?.tables?.paymentMethods?.tableId
    || V1_BITABLE_SCHEMA?.tables?.paymentMethod?.tableId;
  if (!tableId) fail('从 `V1_BITABLE_SCHEMA` 取不到「收款方式管理」的 tableId，拒绝运行');
  say(`· 目标表（收款方式管理）tableId = ${tableId}`);

  const client = new lark.Client({ appId, appSecret });
  const list = async () => {
    const response = await client.bitable.appTableField.list({ path: { app_token: appToken, table_id: tableId }, params: { page_size: 200 } });
    return response?.data?.items || [];
  };

  const before = await list();
  const hit = before.find((field) => String(field.field_name) === VOUCHER_FIELD_NAME);
  say(`· 回读（建之前）：共 ${before.length} 列${hit ? `；已存在「${VOUCHER_FIELD_NAME}」✓` : `；**没有**「${VOUCHER_FIELD_NAME}」✗`}`);
  if (!CHECK_ONLY && !hit) {
    say(`· 开始建列：name=${VOUCHER_FIELD_NAME} type=${VOUCHER_FIELD_TYPE} property.table_id=${VOUCHER_LINK_TABLE_ID}`);
    await client.bitable.appTableField.create({
      path: { app_token: appToken, table_id: tableId },
      data: {
        field_name: VOUCHER_FIELD_NAME,
        type: VOUCHER_FIELD_TYPE,
        property: { table_id: VOUCHER_LINK_TABLE_ID },
      },
    });
    const after = await list();
    const now = after.find((field) => String(field.field_name) === VOUCHER_FIELD_NAME);
    if (!now) fail('建完后**回读不到**那一列 ⇒ 如实报失败（不假装成功 ✗）');
    say(`✓ 回读（建之后）：「${now.field_name}」 type=${now.type} property.table_id=${now.property?.table_id || '(未回)'}`);
  } else if (CHECK_ONLY) {
    say('（--check-only ⇒ **只读**，0 写入 ✓）');
  } else {
    say('· 已存在 ⇒ **跳过**（幂等 ✓，0 写入）');
  }
};

main().catch((error) => fail(`运行失败：${error?.message || error}`));
