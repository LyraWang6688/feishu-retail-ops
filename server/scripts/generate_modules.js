const fs = require('fs');
const path = require('path');

const readManifest = () => {
  const manifestPath = path.resolve(__dirname, '../../config/module-manifest.json');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw);
};

const stringifyJs = (value) => {
  return JSON.stringify(value, null, 2);
};

const buildServerModules = (manifest) => {
  const out = {};
  const order = manifest.order || [];
  const modules = manifest.modules || {};
  order.forEach((key) => {
    const def = modules[key];
    if (!def) return;
    out[key] = {
      key: def.key,
      label: def.label,
      writeMode: def.writeMode,
      fields: def.fields || {},
      // ⚠️ 原先这里还有 recognition（图片识别的提示词配置）。2026-10-05 拍照识别
      // 链路退场后它没有任何读取点，所以从 manifest 与本文件一起删除——
      // 留着会生成一个空的 recognition 键，让人以为还有一组识别配置要维护。
      sync: def.sync || {},
    };
  });
  return out;
};

const writeModuleFile = (filePath, modules) => {
  const content = `const MODULES = ${stringifyJs(modules)};\n\nmodule.exports = { MODULES };\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

const buildModuleFileContent = (modules) => {
  return `const MODULES = ${stringifyJs(modules)};\n\nmodule.exports = { MODULES };\n`;
};

const getOutputPaths = () => ({
  server: path.resolve(__dirname, '../src/config/modules.shared.js'),
});

const main = () => {
  const manifest = readManifest();
  const serverModules = buildServerModules(manifest);
  const outputPaths = getOutputPaths();

  writeModuleFile(outputPaths.server, serverModules);
};

if (require.main === module) {
  main();
}

module.exports = {
  buildModuleFileContent,
  buildServerModules,
  getOutputPaths,
  main,
  readManifest,
};
