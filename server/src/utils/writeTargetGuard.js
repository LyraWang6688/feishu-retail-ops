// 会写多维表格的独立脚本必须经过这里。线上服务（app.js，由 PM2 启动）
// 写入生产是它的职责，不经过本护栏；脚本是人在终端里手动跑的，
// 一旦 .env 指错 Base，写下去就没有回头路，所以默认拒绝写生产。
// 目标 Base 已不再有硬编码默认值，无法再靠比对某个固定值来判断生产，
// 因此改为要求显式声明目标环境：只有声明 test 才允许写，写生产必须显式开闸。
const assertWritableBase = ({ appToken, env = process.env, scriptName = 'script' } = {}) => {
  const token = String(appToken || '').trim();
  if (!token) {
    throw new Error(`${scriptName}：没有配置目标 Base（FEISHU_V1_BITABLE_APP_TOKEN），拒绝运行`);
  }
  if (String(env.FEISHU_TARGET_ENV || '').trim().toLowerCase() === 'test') return token;
  if (String(env.FEISHU_ALLOW_PRODUCTION_WRITE).trim().toLowerCase() === 'true') return token;
  throw new Error(
    `${scriptName}：未声明目标环境，已拒绝写入。` +
    '请显式设置 FEISHU_TARGET_ENV=test 后重试；确需写入生产，' +
    '请改为显式设置 FEISHU_ALLOW_PRODUCTION_WRITE=true。',
  );
};

module.exports = { assertWritableBase };
