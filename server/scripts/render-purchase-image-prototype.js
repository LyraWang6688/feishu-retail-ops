#!/usr/bin/env node
/**
 * 出两张**示例图**（采购单 + 退货单），给业务负责人看"改完长什么样"。
 *
 * ⚠️ 为什么单独一个脚本、而不是"谁临时 P 一张图"：
 *   示例图必须**走项目自己的渲染代码**（`renderPurchaseRequestPng`）——这样
 *   **示例图 == 她实际会收到的图**。自己 P 图只能骗自己：真跑起来排版一变就不对了。
 *   脚本留在这儿，口径一改就能一条命令重出（见下面的用法）。
 *
 * 用法（在 `server/` 下）：
 *   node scripts/render-purchase-image-prototype.mjs
 *   node scripts/render-purchase-image-prototype.mjs --out /tmp/proto
 *
 * 输出（默认）：
 *   docs/prototypes/purchase-order-2026-10-07.png   采购单
 *   docs/prototypes/purchase-return-2026-10-07.png  退货单
 *
 * ⚠️ 明细是**排版示例数据**（照业务负责人截图里的口径：供应商「三星」、报货批次 202610071、
 *   合计 13 双），**不是**她生产表里的真实记录 —— 按 `AGENTS.md` 第 10 条，
 *   编的数据要跟她说一声、让她核合理性。报告里已写明这一点。
 */
const fs = require('node:fs');
const path = require('node:path');
const { renderPurchaseRequestPng, TITLE, RETURN_TITLE } = require('../src/services/purchaseRequestImageService');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'docs', 'prototypes');

// 报货日期固定成她截图里那天：示例图要**可复现**（换一天跑不该长出另一个日期）。
const REPORT_DATE = new Date('2026-10-07T02:00:00Z'); // = 2026/10/07 10:00（上海 +08）

const SUPPLIER = '三星';
const BATCH_NO = '202610071';

// 采购单示例：两个货号 / 三个颜色行，合计 4 + 3 + 6 = 13 双。
const PURCHASE_ITEMS = [
  { item_no: '8230', color: '黑色', size: 38, quantity: 1 },
  { item_no: '8230', color: '黑色', size: 40, quantity: 1 },
  { item_no: '8230', color: '黑色', size: 41, quantity: 2 },
  { item_no: '8230', color: '棕色', size: 39, quantity: 1 },
  { item_no: '8230', color: '棕色', size: 40, quantity: 2 },
  { item_no: '6152-3', color: '黑色', size: 37, quantity: 2 },
  { item_no: '6152-3', color: '黑色', size: 39, quantity: 1 },
  { item_no: '6152-3', color: '黑色', size: 41, quantity: 3 },
];

// 退货单示例：退货通常就一两个尺码，合计 3 双（排版与采购单**同一套**，只换标题）。
const RETURN_ITEMS = [
  { item_no: '8230', color: '黑色', size: 39, quantity: 1 },
  { item_no: '8230', color: '黑色', size: 40, quantity: 1 },
  { item_no: '8230', color: '黑色', size: 41, quantity: 1 },
];

const totalPairsOf = (items) => items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);

const main = async () => {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex >= 0 && process.argv[outIndex + 1] ? process.argv[outIndex + 1] : DEFAULT_OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  const jobs = [
    { file: 'purchase-order-2026-10-07.png', title: TITLE, items: PURCHASE_ITEMS },
    { file: 'purchase-return-2026-10-07.png', title: RETURN_TITLE, items: RETURN_ITEMS },
  ];

  for (const job of jobs) {
    // 走**项目自己的渲染器**（配置里的标题文案、排版、副标题口径一个都不绕过）。
    const png = await renderPurchaseRequestPng({
      supplierName: SUPPLIER,
      batchNo: BATCH_NO,
      items: job.items,
      title: job.title,
      generatedAt: REPORT_DATE,
    });
    const target = path.join(outDir, job.file);
    fs.writeFileSync(target, png);
    console.log(`${target}  ${job.title}  供应商=${SUPPLIER}  合计=${totalPairsOf(job.items)} 双  ${png.length} bytes`);
  }
};

main().catch((error) => {
  console.error(`示例图生成失败：${error.message}`);
  process.exitCode = 1;
});
