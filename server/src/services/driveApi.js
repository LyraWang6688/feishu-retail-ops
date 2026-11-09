'use strict';

/**
 * 飞书云盘（Drive）访问层 —— 2026-11-10 为「货品样例图 → 云盘」新增（业务负责人）。
 *
 * 为什么单独一层（不塞进 `v1BitableGateway`）：
 *   · 网关负责的是"**业务表**（多维表格记录）的读写"；云盘文件的下载/上传是**另一类资源**；
 *   · 单文件 ≤800 行的棘轮（`scripts/check-file-size.mjs`）—— 网关本来已接近上限。
 *   ⇒ 网关在构造器里挂一个 `this.drive = createDriveApi(this.client)`，业务 service 调 `gateway.drive.*`。
 *
 * 只封装官方 SDK 的四个接口，**不做任何业务判断**（文件夹 token / 命名 / 覆盖策略都在调用方 config）：
 *   · 下载素材：`drive.media.download`（GET `drive/v1/medias/{file_token}/download`）
 *   · 上传文件：`drive.file.uploadAll`（POST `drive/v1/files/upload_all`，`parent_type=explorer`）
 *   · 列目录：  `drive.file.list`（GET `drive/v1/files?folder_token=…`）
 *   · 删文件：  `drive.file.delete`（DELETE `drive/v1/files/{file_token}?type=file`）
 *
 * ⚠️ 官方限制（上传类接口）：**5 QPS / 10000 次每天，且不支持并发调用**（并发会回 1061045）
 *    ⇒ 调用方必须**串行**使用本层。
 */

/**
 * @param {object} client `@larksuiteoapi/node-sdk` 的 Client 实例（与网关共用同一个）
 */
const createDriveApi = (client) => {
  if (!client) throw new Error('createDriveApi 需要 lark client');

  /** 结构化应答的失败判定：`code !== 0` ⇒ 明确被拒（可判定"没写"；结果未知的异常不在此列）。 */
  const assertOk = (response, operation) => {
    if (response && typeof response.code === 'number' && response.code !== 0) {
      const error = new Error(`${operation} 失败: ${response.msg || 'unknown'} (Code: ${response.code})`);
      error.driveRejected = true;
      error.driveCode = response.code;
      error.larkData = { code: response.code, msg: response.msg, log_id: response.log_id };
      throw error;
    }
  };

  /** 下载一个素材（多维表格附件里的 `file_token`）为 Buffer。 */
  const downloadMedia = async (fileToken, operation = 'download media') => {
    const token = String(fileToken ?? '').trim();
    if (!token) throw new Error(`${operation} 缺少 file_token`);
    const response = await client.drive.media.download({ path: { file_token: token } });
    if (!response || typeof response.getReadableStream !== 'function') {
      throw new Error(`${operation} 失败：未拿到文件流`);
    }
    const chunks = [];
    for await (const chunk of response.getReadableStream()) chunks.push(Buffer.from(chunk));
    if (!chunks.length) throw new Error(`${operation} 失败：素材内容为空`);
    return Buffer.concat(chunks);
  };

  /** 上传一个文件到云盘文件夹，返回云盘文件的 `file_token`。 */
  const uploadDriveFile = async ({ folderToken, fileName, content, operation = 'upload drive file' } = {}) => {
    const parent = String(folderToken ?? '').trim();
    const name = String(fileName ?? '').trim();
    if (!parent) throw new Error(`${operation} 缺少 folder_token`);
    if (!name) throw new Error(`${operation} 缺少文件名`);
    if (!Buffer.isBuffer(content) || !content.length) throw new Error(`${operation} 缺少文件内容`);
    const response = await client.drive.file.uploadAll({
      data: {
        file_name: name,
        parent_type: 'explorer',
        parent_node: parent,
        size: content.length,
        file: content,
      },
    });
    assertOk(response, operation);
    const token = response?.file_token || response?.data?.file_token || response?.data?.data?.file_token;
    if (!token) throw new Error(`${operation} 成功但未返回 file_token`);
    return token;
  };

  /** 列出一个云盘文件夹里的文件（**只当前层级**；返回 `{ token, name, type }[]`）。 */
  const listDriveFolder = async (folderToken, operation = 'list drive folder') => {
    const parent = String(folderToken ?? '').trim();
    if (!parent) throw new Error(`${operation} 缺少 folder_token`);
    const response = await client.drive.file.list({ params: { folder_token: parent, page_size: 200 } });
    assertOk(response, operation);
    return (response?.data?.files || []).map((file) => ({
      token: file?.token,
      name: file?.name,
      type: file?.type,
    }));
  };

  /** 删除一个云盘文件（同名覆盖时先删旧文件；进回收站，不是硬删）。 */
  const deleteDriveFile = async (fileToken, operation = 'delete drive file') => {
    const token = String(fileToken ?? '').trim();
    if (!token) throw new Error(`${operation} 缺少 file_token`);
    const response = await client.drive.file.delete({ params: { type: 'file' }, path: { file_token: token } });
    assertOk(response, operation);
    return { token };
  };

  return { downloadMedia, uploadDriveFile, listDriveFolder, deleteDriveFile };
};

module.exports = { createDriveApi };
