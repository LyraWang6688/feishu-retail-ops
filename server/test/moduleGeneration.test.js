const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildModuleFileContent,
  buildServerModules,
  getOutputPaths,
  readManifest,
} = require('../scripts/generate_modules');

test('generated module config files match module manifest', () => {
  const manifest = readManifest();
  const outputPaths = getOutputPaths();

  const expectedServer = buildModuleFileContent(buildServerModules(manifest));

  assert.equal(
    fs.readFileSync(outputPaths.server, 'utf8'),
    expectedServer,
    'server/src/config/modules.shared.js is stale; run pnpm run generate:modules'
  );
});
