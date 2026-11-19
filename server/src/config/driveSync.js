'use strict';

/**
 * 云盘同步的**统一目标配置**（2026-11-19）。
 *
 * 之前两条链路各自维护 folder token / 操作文案：
 *   · 样例图：config/sampleImageDrive.js
 *   · 供应单据：config/supplyDocumentSync.js
 * 现在云盘目标、覆盖策略、所有者、操作名集中在这里；
 * 业务触发 / 表字段 / 命名规则仍留在各自 config。
 *
 * ⚠️ 这里只放**目标与通用策略**，不放业务判断。
 * ⚠️ 云盘 folder token 不打印、不写日志。
 */
const { readInt, readString } = require('./envValue');

const OPERATIONS = Object.freeze({
  download: '下载云盘同步文件',
  list: '列出云盘文件夹',
  delete: '删除云盘同名旧文件',
  upload: '上传文件到云盘',
  transfer: '转移云盘文件所有者',
});

const sampleImageOperations = Object.freeze({
  download: '下载样例图素材',
  list: '列出云盘文件夹',
  delete: '删除云盘同名旧文件',
  upload: '上传样例图到云盘',
  transfer: '转移云盘文件所有者',
});

const supplyDocumentOperations = Object.freeze({
  download: '下载供应单据',
  list: '列供应单据目录',
  delete: '覆盖同名供应单据',
  upload: '上传供应单据',
});

const DESTINATIONS = Object.freeze({
  sampleImages: Object.freeze({
    folderToken: readString(process.env, 'SAMPLE_IMAGE_DRIVE_FOLDER_TOKEN', 'NIxifKs4ulS5uudlGP2cKtDBnkd'),
    folderUrl: readString(
      process.env,
      'SAMPLE_IMAGE_DRIVE_FOLDER_URL',
      'https://scnzoiwpgxik.feishu.cn/drive/folder/NIxifKs4ulS5uudlGP2cKtDBnkd',
    ),
    parentType: 'explorer',
    overwrite: readString(process.env, 'SAMPLE_IMAGE_DRIVE_OVERWRITE', 'replace'),
    maxFiles: readInt(process.env, 'SAMPLE_IMAGE_DRIVE_MAX_IMAGES', 10, { min: 0, max: 100 }),
    owner: Object.freeze({
      openId: readString(process.env, 'SAMPLE_IMAGE_DRIVE_OWNER_OPEN_ID', ''),
      email: readString(process.env, 'SAMPLE_IMAGE_DRIVE_OWNER_EMAIL', ''),
    }),
    operations: sampleImageOperations,
  }),

  supplyDocuments: Object.freeze({
    rootFolderToken: readString(process.env, 'SUPPLY_DOCUMENT_DRIVE_ROOT_FOLDER_TOKEN', 'GeE2fZVzUliEz3dNFaKcDgGynig'),
    our: Object.freeze({
      folderToken: readString(process.env, 'SUPPLY_DOCUMENT_DRIVE_OUR_FOLDER_TOKEN', 'QXT9fkXkClKicndPJWOcigOFnDg'),
      folderUrl: readString(process.env, 'SUPPLY_DOCUMENT_DRIVE_OUR_FOLDER_URL', ''),
    }),
    counterparty: Object.freeze({
      folderToken: readString(process.env, 'SUPPLY_DOCUMENT_DRIVE_COUNTERPARTY_FOLDER_TOKEN', 'DwRdfewUvlwdurdd6oBcM6ttnvv'),
      folderUrl: readString(process.env, 'SUPPLY_DOCUMENT_DRIVE_COUNTERPARTY_FOLDER_URL', ''),
    }),
    parentType: 'explorer',
    overwrite: readString(process.env, 'SUPPLY_DOCUMENT_DRIVE_OVERWRITE', 'replace'),
    operations: supplyDocumentOperations,
  }),
});

const DRIVE_SYNC = Object.freeze({
  parentType: 'explorer',
  operations: OPERATIONS,
  destinations: DESTINATIONS,
});

module.exports = {
  DRIVE_SYNC,
  DESTINATIONS,
  OPERATIONS,
  sampleImageOperations,
  supplyDocumentOperations,
};
