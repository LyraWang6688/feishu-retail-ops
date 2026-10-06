#!/usr/bin/env node
/**
 * ws-subscribe.cjs —— 让「**测试应用**」订阅**当前 .env 指向的那张多维表格**的变更事件。
 *
 * ⚠️ 凭证只认测试应用 `LARK_TEST_APP_ID` / `LARK_TEST_APP_SECRET`（与 ws-listen.mjs 同一口径：
 *    生产应用走 webhook，本地测试脚本一律用测试应用）：
 *   · 缺任何一个直接报错退出，**不设 `LARK_AGENT_*` 回退**；
 *   · app_id 等于生产应用 `LARK_AGENT_APP_ID` 时拒绝执行（只与环境变量比较，不硬编码生产 app_id）；
 *   · 只打印 app_id（不是密钥），**绝不打印 secret**。
 *
 * 为什么单独一步：飞书的「表记录变更事件」（drive.file.bitable_record_changed_v1）不是
 * 配了事件订阅就会推的，还要应用**订阅到具体这张表**：
 *   POST /open-apis/drive/v1/files/{file_token}/subscribe?file_type=bitable
 * 没订阅这一步，无论 webhook 还是长连接，一条事件都收不到
 * （现象就是"表里有变更，但系统什么反应都没有"）。
 *
 * 所需权限（应用身份）：docs:event:subscribe（或 drive:drive / docs:doc / sheets:spreadsheet）。
 * 权限不足时飞书直接回 99991672，并把缺哪个 scope 写在 msg 里——照着开通即可。
 *
 * 用法：
 *   node scripts/ws-subscribe.cjs --env-file <主工作区 .env>
 *
 * ⚠️ 只对 `.env` 指向的 Base 生效；脚本内置闸门，**指向生产 Base 时直接拒绝执行**。
 *    只改"事件推给谁"，不写任何表数据；要撤销用同一个接口的 unsubscribe。
 */

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : '';
};
for (const item of [
  { path: path.join(repoRoot, '.env'), override: false },
  { path: flag('env-file'), override: false },
  { path: path.join(repoRoot, '.env.local'), override: true },
]) {
  if (item.path && fs.existsSync(item.path)) dotenv.config({ path: item.path, override: item.override, quiet: true });
}

const lark = require('@larksuiteoapi/node-sdk');

const PROD_APP_TOKEN = 'QrXlbwXMLaJ2TNsxSfFcIA3rnwh';
const fileToken = String(process.env.FEISHU_V1_BITABLE_APP_TOKEN || '').trim();
if (!fileToken) { console.error('缺少 FEISHU_V1_BITABLE_APP_TOKEN'); process.exit(1); }
if (fileToken === PROD_APP_TOKEN) { console.error('拒绝执行：目标 Base 是生产 Base'); process.exit(1); }

// ── 凭证：只认「测试应用」，绝不碰生产应用 ────────────────────────────────────
// （上面的生产 Base 闸门原样保留；这里管的是"用哪个应用去订阅"，两件事互不影响。）
const testAppId = String(process.env.LARK_TEST_APP_ID || '').trim();
const testAppSecret = String(process.env.LARK_TEST_APP_SECRET || '').trim();
if (!testAppId || !testAppSecret) {
  const missing = [!testAppId && 'LARK_TEST_APP_ID', !testAppSecret && 'LARK_TEST_APP_SECRET'].filter(Boolean);
  console.error(`❌ 缺少测试应用凭证：${missing.join('、')}`);
  console.error('   本地测试脚本只允许用测试应用，不会回退到 LARK_AGENT_*（生产应用，生产走 webhook）。');
  process.exit(1);
}
const productionAppId = String(process.env.LARK_AGENT_APP_ID || '').trim();
if (productionAppId && testAppId === productionAppId) {
  console.error('❌ 拒绝执行：LARK_TEST_APP_ID 与生产应用 LARK_AGENT_APP_ID 相同——禁止用生产应用连长连接。');
  process.exit(1);
}

(async () => {
  // app_id 不是密钥，可以打印；**secret 绝不打印**。
  console.log(`应用：测试应用（LARK_TEST_APP_ID）app_id=${testAppId}  file_token=${fileToken}（app_secret 不打印）`);
  const client = new lark.Client({ appId: testAppId, appSecret: testAppSecret });
  const res = await client.drive.v1.file.subscribe({ path: { file_token: fileToken }, params: { file_type: 'bitable' } });
  console.log('订阅结果：', JSON.stringify(res));
  if (res?.code === 0) console.log('✅ 已订阅这张表的变更事件');
})().catch((error) => {
  const data = error?.response?.data;
  console.error('订阅失败：', data ? JSON.stringify(data).slice(0, 800) : error.message);
  process.exit(1);
});
