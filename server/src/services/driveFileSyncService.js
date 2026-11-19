'use strict';

/**
 * 云盘文件同步的**唯一底层实现**（2026-11-19 统一）。
 *
 * 业务 service 只决定：
 *   · 同步哪张附件、去哪个 folder、叫什么名字、失败后是否勾状态；
 * 本文件统一负责：
 *   · 列 folder → 同名覆盖（只删同名）→ 下载附件 → 上传 → 可选转移所有者。
 *
 * ⚠️ 飞书云盘上传 5 QPS / 不支持并发 ⇒ 所有实例共享同一个模块级串行队列；
 *    样例图与供应单据同时跑也不会叠加并发。
 */
const { DRIVE_SYNC } = require('../config/driveSync');
const { extraOfAttachment } = require('./driveApi');

let queueTail = Promise.resolve();

/** 全局串行：前一个任务结束（成功或失败）才跑下一个。 */
const runDriveSerial = (work) => {
  const run = queueTail.then(work, work);
  queueTail = run.then(() => undefined, () => undefined);
  return run;
};

const sameNameFiles = (files, fileName, onlyFiles = true) => (Array.isArray(files) ? files : [])
  .filter((item) => item && (!onlyFiles || item.type === 'file') && item.name === fileName);

/**
 * @param {object} options
 * @param {object} options.gateway V1BitableGateway（只使用 gateway.drive）
 * @param {object} [options.operations] 操作名文案（默认 driveSync 通用文案）
 * @param {string} [options.overwrite] replace / skip
 * @param {{openId?:string,email?:string}} [options.owner] 可选：上传后转移所有者
 */
const createDriveFileSyncService = ({
  gateway, operations = DRIVE_SYNC.operations, overwrite = 'replace', owner = null,
} = {}) => {
  const drive = gateway?.drive || null;

  const requireDrive = () => {
    if (!drive) throw new Error('gateway.drive 未挂载，无法同步云盘文件');
    return drive;
  };

  const listFolder = (folderToken, ops = operations) => runDriveSerial(async () => {
    const api = requireDrive();
    const files = await api.listDriveFolder(folderToken, ops.list);
    return Array.isArray(files) ? files : [];
  });

  /**
   * 同步一个附件到云盘。
   *
   * @param {object} input
   * @param {{file_token:string,name?:string,tmp_url?:string,url?:string,type?:string}} input.attachment
   * @param {string} input.folderToken
   * @param {string} input.fileName
   * @param {Array} [input.existingFiles] 调用方已列出 folder 时可传入，避免每个文件重复 list
   * @param {object} [input.operations]
   * @param {string} [input.overwrite]
   * @param {object} [input.owner]
   * @returns {Promise<{fileName:string,fileToken?:string,overwritten:number,ownerTransferred:boolean,skipped?:string}>}
   */
  const syncAttachment = async ({
    attachment, folderToken, fileName, existingFiles = null, onlyFiles = true,
    operations: ops = operations, overwrite: overwriteMode = overwrite, owner: ownerMode = owner,
  } = {}) => runDriveSerial(async () => {
    const api = requireDrive();
    const token = String(attachment?.file_token || attachment?.fileToken || '').trim();
    if (!token) throw new Error('云盘同步缺少附件 file_token');
    if (!String(fileName || '').trim()) throw new Error('云盘同步缺少文件名');

    const files = Array.isArray(existingFiles)
      ? existingFiles
      : await api.listDriveFolder(folderToken, ops.list);
    const sameName = sameNameFiles(files, fileName, onlyFiles);

    if (sameName.length && overwriteMode !== 'replace') {
      return { fileName, overwritten: 0, ownerTransferred: false, skipped: 'name_exists' };
    }

    for (const item of sameName) {
      await api.deleteDriveFile(item.token, ops.delete);
    }

    const content = await api.downloadMedia(token, ops.download, {
      // 供应单据的 attachmentList 已把 tmp_url 里的 extra 抽出来；样例图则直接带 tmp_url。
      extra: String(attachment?.extra || extraOfAttachment(attachment) || '').trim(),
    });
    const fileToken = await api.uploadDriveFile({ folderToken, fileName, content, operation: ops.upload });

    let ownerTransferred = false;
    if (String(ownerMode?.openId || '').trim() || String(ownerMode?.email || '').trim()) {
      await api.transferFileOwner(fileToken, { owner: ownerMode, operation: ops.transfer });
      ownerTransferred = true;
    }

    return { fileName, fileToken, overwritten: sameName.length, ownerTransferred };
  });

  return { listFolder, syncAttachment, runSerial: runDriveSerial };
};

module.exports = { createDriveFileSyncService, runDriveSerial };
