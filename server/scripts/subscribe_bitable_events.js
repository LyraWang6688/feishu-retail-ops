/**
 * 订阅多维表格记录变更事件
 * 用法：node scripts/subscribe_bitable_events.js
 *
 * 订阅后，当多维表格里的记录发生新增/修改/删除时，
 * 飞书会向配置的事件回调地址（/api/lark/events）推送事件。
 */

const axios = require('axios');

const BASE_TOKEN = 'QrXlbwXMLaJ2TNsxSfFcIA3rnwh'; // 进销存管理多维表格

async function getTenantAccessToken(appId, appSecret) {
  const response = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: appId, app_secret: appSecret },
  );
  if (response.data.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败: ${response.data.msg}`);
  }
  return response.data.tenant_access_token;
}

async function subscribeBitableEvents(tenantAccessToken, fileToken) {
  const response = await axios.post(
    `https://open.feishu.cn/open-apis/drive/v1/files/${fileToken}/subscribe?file_type=bitable`,
    {},
    {
      headers: { Authorization: `Bearer ${tenantAccessToken}` },
    },
  );
  return response.data;
}

async function main() {
  const appId = process.env.LARK_AGENT_APP_ID;
  const appSecret = process.env.LARK_AGENT_APP_SECRET;

  if (!appId || !appSecret) {
    console.error('错误：请先配置环境变量 LARK_AGENT_APP_ID 和 LARK_AGENT_APP_SECRET');
    process.exit(1);
  }

  console.log(`正在订阅多维表格事件，base_token: ${BASE_TOKEN}...`);

  try {
    const token = await getTenantAccessToken(appId, appSecret);
    const result = await subscribeBitableEvents(token, BASE_TOKEN);

    if (result.code === 0) {
      console.log('✅ 订阅成功！');
      console.log('多维表格的记录变更事件将会推送到 /api/lark/events');
    } else {
      console.error('❌ 订阅失败:', result.msg);
      console.error('错误码:', result.code);
      if (result.code === 1069603) {
        console.error('\n排查建议：');
        console.error('1. 应用需要有云文档管理权限');
        console.error('2. 需要在多维表格页面右上角「...」→「更多」→「添加文档应用」，把应用添加为文档应用');
      }
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ 订阅过程出错:', error.message);
    process.exit(1);
  }
}

main();
