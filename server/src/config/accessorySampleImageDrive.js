'use strict';

/**
 * 「其他配品.样例图」→ 配品云盘 自动同步（2026-11-19）。
 *
 * 与货品样例图云盘同步并列：
 *   · 只处理新增（record_added）；
 *   · 有样例图且「同步云盘」未勾 ⇒ 上传；成功后勾「同步云盘」；
 *   · 存量由「同步样例图」按钮统一补齐。
 *
 * 目标、覆盖策略、操作文案来自 config/driveSync.js；
 * 本文件只放配品自己的字段 / 命名 / 触发动作。
 */
const { readInt } = require('./envValue');
const { DRIVE_SYNC } = require('./driveSync');

const DESTINATION = DRIVE_SYNC.destinations.accessorySampleImages;

const NAMING = Object.freeze({
  fallbackExtension: '.jpg',
  illegalChars: Object.freeze(['/', '\\', ':', '*', '?', '"', '<', '>', '|']),
  replacement: '_',
  maxLength: 120,
});

const CONFIG = Object.freeze({
  folder: Object.freeze({
    token: DESTINATION.folderToken,
    parentType: DESTINATION.parentType || DRIVE_SYNC.parentType,
    displayUrl: DESTINATION.folderUrl,
  }),
  events: Object.freeze({
    created: Object.freeze(['record_added']),
    updated: Object.freeze([]),
  }),
  fields: Object.freeze({
    sampleImage: 'sampleImage',
    synced: 'sampleImageSynced',
    name: 'name',
    category: 'category',
  }),
  naming: NAMING,
  overwrite: DESTINATION.overwrite,
  maxImages: DESTINATION.maxFiles,
  operations: DESTINATION.operations,
  owner: DESTINATION.owner,
  readRetry: Object.freeze({
    maxRetries: readInt(process.env, 'ACCESSORY_SAMPLE_IMAGE_DRIVE_READ_RETRIES', 4, { min: 0, max: 10 }),
    baseDelayMs: readInt(process.env, 'ACCESSORY_SAMPLE_IMAGE_DRIVE_READ_RETRY_MS', 1500, { min: 0, max: 60000 }),
  }),
  backfill: Object.freeze({
    maxRecords: readInt(process.env, 'ACCESSORY_SAMPLE_IMAGE_DRIVE_BACKFILL_MAX', 0, { min: 0, max: 10000 }),
  }),
});

/** 配品文件名：种类_名称 + 原图片扩展名（种类防止跨种类同名撞文件）。 */
const buildFileName = ({ name, category, sourceName, naming = NAMING }) => {
  const { sanitizeFileName, extensionOf } = require('../services/sampleImageDriveService');
  const base = [category, name].map((value) => String(value || '').trim()).filter(Boolean).join('_');
  if (!base) return '';
  return `${sanitizeFileName(base, naming)}${extensionOf(sourceName, naming)}`;
};

module.exports = { ACCESSORY_SAMPLE_IMAGE_DRIVE: CONFIG, buildAccessoryFileName: buildFileName };
