'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DRIVE_SYNC, DESTINATIONS } = require('../src/config/driveSync');
const { SAMPLE_IMAGE_DRIVE } = require('../src/config/sampleImageDrive');
const SUPPLY = require('../src/config/supplyDocumentSync');

test('云盘统一配置：样例图与供应单据共用同一目标注册表', () => {
  assert.equal(SAMPLE_IMAGE_DRIVE.folder.token, DESTINATIONS.sampleImages.folderToken);
  assert.equal(SAMPLE_IMAGE_DRIVE.overwrite, DESTINATIONS.sampleImages.overwrite);
  assert.equal(SAMPLE_IMAGE_DRIVE.maxImages, DESTINATIONS.sampleImages.maxFiles);
  assert.deepEqual(SAMPLE_IMAGE_DRIVE.owner, DESTINATIONS.sampleImages.owner);
  assert.equal(SUPPLY.folders.our, DESTINATIONS.supplyDocuments.our.folderToken);
  assert.equal(SUPPLY.folders.counterparty, DESTINATIONS.supplyDocuments.counterparty.folderToken);
  assert.equal(SUPPLY.operations.upload, DESTINATIONS.supplyDocuments.operations.upload);
  assert.equal(DRIVE_SYNC.parentType, 'explorer');
  assert.ok(DESTINATIONS.sampleImages.operations);
  assert.ok(DESTINATIONS.supplyDocuments.operations);
});
