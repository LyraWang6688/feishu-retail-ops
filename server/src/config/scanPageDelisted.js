'use strict';

/** 普通扫码遇到已下架货品时的人话与事件（不混进 scanPage 主配置，避免继续撑大存量文件）。 */
const SCAN_DELISTED = Object.freeze({
  title: '这个货品已下架',
  body: '不能用于新销售。如需售后，请从售后入口扫描。',
  logEvent: 'scan.page.record_delisted',
});

module.exports = { SCAN_DELISTED };
