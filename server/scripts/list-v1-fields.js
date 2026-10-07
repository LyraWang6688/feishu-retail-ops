#!/usr/bin/env node
/**
 * 只读字段探测器：把某张 V1 表的**真实字段元数据**打出来（字段名 / 类型 / ui_type）。
 *
 * 为什么要有它：
 *   · 「这个字段是不是飞书自动字段」不能靠猜、也不能靠文档——只能读真表的字段元数据。
 *     自动字段（创建时间 / 修改时间 / 自动编号 / 创建人 …）在 API 里的 `type` 是固定的
 *     1001~1005 一档，`ui_type` 会是 CreatedTime / ModifiedTime / AutoNumber / …；
 *     人工填的日期字段是 `type: 5` + `ui_type: 'DateTime'`。两者的区别就在这里。
 *   · 按纪律**不许用飞书 CLI**：本脚本走的是项目自己的 gateway
 *     （`V1BitableGateway.listFields` → 官方 SDK `bitable.appTableField.list`），
 *     app_token / table_id 一律从项目配置读，不硬编码任何 token。
 *
 * ⚠️ **只读**：本脚本只调 `appTableField.list`，不创建 / 不更新 / 不删除任何东西。
 * ⚠️ 不打印任何 secret / token 值，只打印"有没有配"和字段元数据。
 *
 * 用法：
 *   node server/scripts/list-v1-fields.js purchaseOrderBatch
 *   node server/scripts/list-v1-fields.js purchaseOrderBatch purchaseInbound
 *   # 只关心某个字段名时，加上 --field=确认状态 会额外打一行结论
 *
 * 在本机跑 = 读本机 .env 指向的 Base（按纪律：本机只有测试 Base）。
 * 要读生产 Base，在**服务器上**跑同一个脚本（服务器有生产凭证）。
 */

const path = require('node:path');

// ⚠️ dotenv 必须在任何业务模块之前加载：schema 里的 tableId 是模块级求值，
// 晚一步 require 就会在空环境里定稿（2026-10-06 线上事故的根因，见 src/app.js 注释）。
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const lark = require('@larksuiteoapi/node-sdk');
const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

// 飞书字段 type → 人话。1001 以上是**飞书自动字段**，代码写不进去（也不该写）。
const AUTO_TYPES = Object.freeze({
  1001: 'CreatedTime（飞书自动：创建时间）',
  1002: 'ModifiedTime（飞书自动：最后更新时间）',
  1003: 'CreatedUser（飞书自动：创建人）',
  1004: 'ModifiedUser（飞书自动：修改人）',
  1005: 'AutoNumber（飞书自动：自动编号）',
});

const fieldKind = (field) => {
  const auto = AUTO_TYPES[field.type];
  if (auto) return auto;
  return `${field.ui_type || `type:${field.type}`}`;
};

const main = async () => {
  const argv = process.argv.slice(2);
  const fieldFilter = (argv.find((item) => item.startsWith('--field=')) || '').split('=')[1] || '';
  const tableKeys = argv.filter((item) => !item.startsWith('--'));
  if (!tableKeys.length) {
    console.error('用法: node server/scripts/list-v1-fields.js <tableKey> [tableKey...] [--field=字段名]');
    console.error(`可用的 tableKey: ${Object.keys(V1_BITABLE_SCHEMA.tables).join(', ')}`);
    process.exit(1);
  }

  const missing = ['LARK_AGENT_APP_ID', 'LARK_AGENT_APP_SECRET'].filter((key) => !process.env[key]);
  // 只报"有没有"，绝不打印值。
  if (missing.length) {
    console.error(`缺少飞书应用凭证: ${missing.join(', ')}（只报名字，不打印值）`);
    process.exit(1);
  }
  const hasAppToken = Boolean(String(process.env.FEISHU_V1_BITABLE_APP_TOKEN || '').trim());
  console.log(JSON.stringify({
    env_file: path.join(__dirname, '../../.env'),
    agent_app_id_configured: true,
    bitable_app_token_from_env: hasAppToken,
  }));

  // SDK 默认 logger 会把请求配置（含 app secret）打出来，这里全部静音。
  const { appId, appSecret } = getLarkAgentCredentials();
  const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const gateway = new V1BitableGateway({ client: new lark.Client({ appId, appSecret, logger }) });

  let exitCode = 0;
  for (const tableKey of tableKeys) {
    const table = gateway.table(tableKey);
    const fields = await gateway.listFields(tableKey, { refresh: true });
    console.log(`\n=== ${tableKey}  ${table.tableName}  table_id=${table.tableId}  字段数=${fields.length} ===`);
    for (const field of fields) {
      const auto = Boolean(AUTO_TYPES[field.type]);
      console.log([
        auto ? 'AUTO' : '    ',
        String(field.field_name),
        '|', fieldKind(field),
        `| field_id=${field.field_id}`,
        field.is_primary ? '| 主字段' : '',
        field.is_hidden ? '| 隐藏' : '',
        auto ? '| 代码不可写、也不该写' : '',
      ].filter(Boolean).join(' '));
      if (fieldFilter && field.field_name === fieldFilter) {
        console.log(`      ⚠️ 结论「${fieldFilter}」: ${auto
          ? '是飞书自动字段 —— 代码不写它'
          : `不是自动字段（${fieldKind(field)}）—— 代码必须显式写，或者先停下来问业务负责人`}`);
        if (!auto) exitCode = 2;
      }
    }
  }
  process.exit(exitCode);
};

main().catch((error) => {
  console.error(`读取字段失败: ${error.message}`);
  process.exit(1);
});
