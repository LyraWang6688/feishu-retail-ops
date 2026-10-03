const path = require('path');
const fs = require('fs');

// 上传目录仍被 app.js 的定期清理任务使用，因此保留。
//
// 这里原先还导出一个基于 multer 的 `upload` 中间件，用于接收图片上传。
// 那条链路属于已退役的微信小程序入口：V1 的图片识别由多维表格记录变更事件驱动，
// 机器人不接收图片，该中间件从未挂载到任何路由上，也没有任何测试引用它。
// multer 依赖因此被移除——它当时带来 22 条 Dependabot 高危告警，
// 而与之对应的代码永远不会执行。
const uploadDir = process.env.VERCEL
  ? path.join('/tmp', 'uploads')
  : path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

module.exports = {
  uploadDir,
};
