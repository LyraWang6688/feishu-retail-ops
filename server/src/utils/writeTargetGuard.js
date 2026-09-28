// 会写多维表格的独立脚本必须经过这里。线上服务（app.js，由 PM2 启动）
// 写入生产是它的职责，不经过本护栏；脚本是人在终端里手动跑的，
// 一旦 .env 指错 Base，写下去就没有回头路，所以默认拒绝写生产。
const PRODUCTION_APP_TOKEN = 'QrXlbwXMLaJ2TNsxSfFcIA3rnwh';

const assertWritableBase = ({ appToken, env = process.env, scriptName = 'script' } = {}) => {
  const token = String(appToken || '').trim();
  if (!token) {
    throw new Error(`${scriptName}：没有配置目标 Base（FEISHU_V1_BITABLE_APP_TOKEN），拒绝运行`);
  }
  if (token === PRODUCTION_APP_TOKEN && String(env.FEISHU_ALLOW_PRODUCTION_WRITE).toLowerCase() !== 'true') {
    throw new Error(
      `${scriptName}：目标是生产 Base，已拒绝写入。` +
      '确需写入生产，请显式设置 FEISHU_ALLOW_PRODUCTION_WRITE=true 后重试。',
    );
  }
  return token;
};

module.exports = { PRODUCTION_APP_TOKEN, assertWritableBase };
