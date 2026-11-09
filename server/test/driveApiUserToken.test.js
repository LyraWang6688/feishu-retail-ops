'use strict';

/**
 * 云盘层：传 `userAccessToken` 时用**点击人身份**调飞书（文件所有者 = 点击人）；
 * 不传则保持 tenant token（所有者 = 应用）。2026-11-10 业务负责人要求。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDriveApi } = require('../src/services/driveApi');

const makeClient = () => {
  const calls = { upload: [], list: [], del: [] };
  return {
    calls,
    drive: {
      file: {
        async uploadAll(payload, options) {
          calls.upload.push({ payload, options });
          return { code: 0, data: { file_token: 'ft_up' } };
        },
        async list(payload, options) {
          calls.list.push({ payload, options });
          return { code: 0, data: { files: [] } };
        },
        async delete(payload, options) {
          calls.del.push({ payload, options });
          return { code: 0 };
        },
      },
    },
  };
};

const hasUserTokenOption = (options) => {
  const larkOptions = options?.lark;
  if (!larkOptions || typeof larkOptions !== 'object') return false;
  return Object.getOwnPropertySymbols(larkOptions).length === 1;
};

test('AC-OT4 上传：传 userAccessToken ⇒ SDK options 带 withUserAccessToken（不传 ⇒ undefined）', async () => {
  const api = createDriveApi(makeClient());
  const client = makeClient();
  const withUser = createDriveApi(client);

  await withUser.uploadDriveFile({
    folderToken: 'folder', fileName: 'a.jpg', content: Buffer.from('x'), userAccessToken: 'ut_clicker',
  });
  const opts = client.calls.upload[0].options;
  assert.equal(hasUserTokenOption(opts), true, 'options.lark 里要带 user token（所有者 = 点击人）');

  const tenantClient = makeClient();
  await createDriveApi(tenantClient).uploadDriveFile({
    folderToken: 'folder', fileName: 'a.jpg', content: Buffer.from('x'),
  });
  assert.equal(tenantClient.calls.upload[0].options, undefined, '不传 token ⇒ 走 tenant（旧行为）');
  assert.ok(api, 'drive api 构造成功');
});

test('AC-OT5 列目录 / 删文件：同样支持 user token 透传', async () => {
  const client = makeClient();
  const api = createDriveApi(client);
  await api.listDriveFolder('folder', 'list', { userAccessToken: 'ut_clicker' });
  await api.deleteDriveFile('ft', 'delete', { userAccessToken: 'ut_clicker' });
  assert.equal(hasUserTokenOption(client.calls.list[0].options), true);
  assert.equal(hasUserTokenOption(client.calls.del[0].options), true);

  const tenantClient = makeClient();
  await createDriveApi(tenantClient).listDriveFolder('folder', 'list');
  await createDriveApi(tenantClient).deleteDriveFile('ft', 'delete');
  assert.equal(tenantClient.calls.list[0].options, undefined);
  assert.equal(tenantClient.calls.del[0].options, undefined);
});
