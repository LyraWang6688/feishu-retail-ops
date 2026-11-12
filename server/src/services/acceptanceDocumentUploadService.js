'use strict';

/**
 * ⭐ 2026-11-12（业务负责人）：验收单图片上传 — 接收 Buffer，写临时文件 → 飞书素材库文件上传
 * → 返回 file_token。业务路由不直接碰文件系统（也满足 CodeQL 对路由文件访问的检查）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const safeFileName = (rawName = '', fallback = `acceptance-${Date.now()}.jpg`) => (
  path.basename(String(rawName || ''))
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
    .slice(-100) || fallback
);

/**
 * @param {{gateway:object, buffer:Buffer, fileName?:string, operation?:string}} input
 * @returns {Promise<string>} file_token
 */
const uploadAcceptanceDocument = async ({ gateway, buffer, fileName = '', operation = '' } = {}) => {
  if (!gateway || typeof gateway.uploadAttachment !== 'function') {
    throw new Error('上传验收单缺少 gateway.uploadAttachment');
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('验收单图片为空');
  const safeName = safeFileName(fileName);
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'acceptance-doc-'));
  const filePath = path.join(tmpDir, safeName);
  try {
    await fs.promises.writeFile(filePath, buffer);
    return await gateway.uploadAttachment(filePath, {
      parentType: 'bitable_image',
      operation,
    });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
};

module.exports = { uploadAcceptanceDocument, safeFileName };
