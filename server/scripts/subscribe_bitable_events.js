/**
 * 订阅多维表格记录变更事件
 * 用法：node scripts/subscribe_bitable_events.js
 *
 * 订阅后，当多维表格里的记录发生新增/修改/删除时，
 * 飞书会向配置的事件回调地址（/api/lark/events）推送事件。
 *
 * 注意：本脚本只使用 Node.js 内置模块，不需要额外安装依赖。
 */

const https = require('https');

const BASE_TOKEN = 'QrXlbwXMLaJ2TNsxSfFcIA3rnwh'; // 进销存管理多维表格

function httpsPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(data);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ raw: body });
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function getTenantAccessToken(appId, appSecret) {
  const result = await httpsPost(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: appId, app_secret: appSecret },
  );
  if (result.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败: ${result.msg} (code: ${result.code})`);
  }
  return result.tenant_access_token;
}

async function subscribeBitableEvents(tenantAccessToken, fileToken) {
  const result = await httpsPost(
    `https://open.feishu.cn/open-apis/drive/v1/files/${fileToken}/subscribe?file_type=bitable`,
    {},
    { Authorization: `Bearer ${tenantAccessToken}` },
  );
  return result;
}

async function main() {
  const appId = process.env.LARK_AGENT_APP_ID;
  const appSecret = process.env.LARK_AGENT_APP_SECRET;

  if (!appId || !appSecret) {
    console.error('错误：请先配置环境变量 LARK_AGENT_APP_ID 和 LARK_AGENT_APP_SECRET');
    console.error('这些变量通常在 PM2 的生态文件或 .env 文件中配置');
    process.exit(1);
  }

  console.log(`正在订阅多维表格事件，base_token: ${BASE_TOKEN}...`);

  try {
    const token = await getTenantAccessToken(appId, appSecret);
    console.log('✅ 获取 tenant_access_token 成功');

    const result = await subscribeBitableEvents(token, BASE_TOKEN);

    if (result.code === 0) {
      console.log('✅ 订阅成功！');
      console.log('多维表格的记录变更事件将会推送到 /api/lark/events');
      console.log('');
      console.log('接下来可以：');
      console.log('1. 在多维表格里新增一条记录，测试事件是否正常推送');
      console.log('2. 查看日志：pm2 logs box2bitable-server --lines 50');
      console.log('3. 确认日志里出现 lark.bitable.record_changed 条目');
    } else {
      console.error('❌ 订阅失败:', result.msg);
      console.error('错误码:', result.code);
      if (result.code === 1069603) {
        console.error('');
        console.error('排查建议：');
        console.error('1. 应用需要有云文档管理权限（docs:event:subscribe 或 drive:drive）');
        console.error('2. 需要在多维表格页面右上角「...」→「更多」→「添加文档应用」');
        console.error('   把你的飞书应用添加为文档应用（需要先开通至少一个云文档或多维表格的 API 权限）');
      }
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ 订阅过程出错:', error.message);
    process.exit(1);
  }
}

main();
