'use strict';

/** 工作台路由源码聚合：父 router + routes/workbench/*.js 子 router。
 *  拆分后仍让"源码哨兵"能读到完整路由代码；断言本身不改。 */
const fs = require('node:fs');
const path = require('node:path');

const ROUTES_DIR = path.join(__dirname, '../../src/routes');
const readWorkbenchRoutes = () => {
  const files = [path.join(ROUTES_DIR, 'workbench.js')];
  const sub = path.join(ROUTES_DIR, 'workbench');
  if (fs.existsSync(sub)) {
    for (const name of fs.readdirSync(sub).filter((file) => file.endsWith('.js')).sort()) {
      files.push(path.join(sub, name));
    }
  }
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
};

module.exports = readWorkbenchRoutes;
