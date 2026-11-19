/**
 * 供应单据自动同步配置（2026-11-18 业务负责人定稿）。
 *
 * 报货 + 已到货：我方单据 → 供应单据/我方；对方单据 → 供应单据/对方
 * 退货：        我方单据 → 供应单据/我方
 * 同步成功后由后端勾选采购主表「单据同步」。
 */
const { DRIVE_SYNC } = require('./driveSync');

const DESTINATION = DRIVE_SYNC.destinations.supplyDocuments;

module.exports = Object.freeze({
  rootFolderToken: DESTINATION.rootFolderToken,
  folders: Object.freeze({
    our: DESTINATION.our.folderToken,
    counterparty: DESTINATION.counterparty.folderToken,
  }),
  fields: Object.freeze({
    behavior: '发生行为',
    status: '到货状态',
    myDocuments: '我方单据',
    counterpartyDocuments: '对方单据',
    documentSync: '单据同步',
    supplier: '供应商',
    batchNo: '报货批次号',
  }),
  behavior: Object.freeze({ purchase: '报货', return: '退货' }),
  arrivedStatus: '已到货',
  texts: Object.freeze({
    unknownDate: '未标日期',
    unknownSupplier: '未标注供应商',
    unknownBehavior: '未标行为',
  }),
  operations: DESTINATION.operations,
});
