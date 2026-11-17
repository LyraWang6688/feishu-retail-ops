'use strict';

/**
 * 云盘层：固定所有者（transfer_owner）—— 上传后把文件所有者转给指定的人。
 *
 * 2026-11-10 业务负责人：「我们把这些图片的所有者都硬编码为赵瑞玲吧」
 *   ⇒ 上传后调 `drive.permission.member.transferOwner`（type=file）把所有者转给她。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDriveApi, extraOfAttachment } = require('../src/services/driveApi');

const makeClient = () => {
  const calls = { upload: [], list: [], del: [], transfer: [], download: [] };
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
      media: {
        async download(payload) {
          calls.download.push(payload);
          return { getReadableStream: async function* () { yield Buffer.from('img'); } };
        },
      },
      permissionMember: {
        async transferOwner(payload, options) {
          calls.transfer.push({ payload, options });
          return { code: 0 };
        },
      },
    },
  };
};

test('AC-OT6 固定所有者：transferOwner 用 openid / email 都支持；缺 owner 当场抛（不静默）', async () => {
  const client = makeClient();
  const api = createDriveApi(client);
  await api.transferFileOwner('ft_1', { owner: { openId: 'ou_zhaoruiling' } });
  assert.equal(client.calls.transfer.length, 1);
  const payload = client.calls.transfer[0].payload;
  assert.deepEqual(payload.path, { token: 'ft_1' });
  assert.equal(payload.params.type, 'file');
  assert.equal(payload.params.need_notification, false);
  assert.deepEqual(payload.data, { member_type: 'openid', member_id: 'ou_zhaoruiling' });

  await api.transferFileOwner('ft_2', { owner: { email: 'zhaoruiling@example.com' } });
  assert.equal(client.calls.transfer[1].payload.data.member_type, 'email');

  await assert.rejects(() => api.transferFileOwner('ft_3', { owner: {} }), /缺少 owner/);
  await assert.rejects(() => api.transferFileOwner('', { owner: { openId: 'ou_x' } }), /缺少 file_token/);
});


test('AC-OT8 高级权限：下载素材带 extra（从附件 tmp_url 取）；不带时请求形状不变', async () => {
  const extra = '{"bitablePerm":{"tableId":"tbl9z4Oi8Vc57Kin","rev":5786}}';
  const tmpUrl = `https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=ft_1&extra=${encodeURIComponent(extra)}`;
  assert.equal(extraOfAttachment({ tmp_url: tmpUrl }), extra, 'tmp_url 里的 extra 要能解析出来');
  assert.equal(extraOfAttachment({}), '');

  const client = makeClient();
  const api = createDriveApi(client);
  const buf = await api.downloadMedia('ft_1', 'download', { extra });
  assert.equal(buf.toString(), 'img');
  assert.deepEqual(client.calls.download[0].path, { file_token: 'ft_1' });
  assert.equal(client.calls.download[0].params.extra, extra);

  await api.downloadMedia('ft_2', 'download');
  assert.equal(client.calls.download[1].params, undefined, '没有 extra 时不许凭空造 params');
});

test('AC-OT7 ⭐ 列目录必须翻页拉全（单页 200；云盘已 274 个文件，漏页会误判同名不存在）', async () => {
  const calls = [];
  const client = {
    drive: {
      file: {
        async list(payload) {
          calls.push(payload.params);
          if (!payload.params.page_token) {
            return { code: 0, data: {
              files: [{ token: 'f1', name: 'a.jpg', type: 'file' }],
              has_more: true, next_page_token: 'p2',
            } };
          }
          return { code: 0, data: {
            files: [{ token: 'f2', name: 'b.jpg', type: 'file' }],
            has_more: false,
          } };
        },
      },
    },
  };
  const files = await createDriveApi(client).listDriveFolder('folder', 'list');
  assert.deepEqual(files.map((f) => f.name), ['a.jpg', 'b.jpg'], '两页都要拿到');
  assert.equal(calls.length, 2, '第二页要带 page_token');
  assert.equal(calls[1].page_token, 'p2');
  assert.equal(calls[0].folder_token, 'folder');
});
