#!/usr/bin/env node
/**
 * ⭐⭐ 2026-10-13（事故尾巴）：**半截提交**修复命令 —— 账写了、草稿没清 ✗
 *
 * 现场：会话 `…44bd9863896a41e8` 的 `sale` = `status=draft` + `order_no=XSD-…` + `lines=1`，
 *   而 `completed[]` 里**已经登记了这一笔** ⇒ 服务重启把"清草稿"那半打断了 ✓
 *   ⇒ 她之后每次扫码都看到"本单已加 1 双"✗，且**再提交有重复下单风险** ✗
 *
 * 用法（**默认 dry-run：只记日志、一个字都不动** ✗）：
 *   node scripts/scan-repair-interrupted.js                # 干跑（安全 ✓）
 *   node scripts/scan-repair-interrupted.js --write        # 真清（**只清草稿那半** ✗ 不重写账 ✓）
 *   node scripts/scan-repair-interrupted.js --dir=/path    # 指定会话目录（自测用 ✓）
 *
 * ⚠️ 判据保守：**拿不准 ⇒ 只记日志**（`draft_order_no_not_in_completed` 可能只是"正在提交中" ✓）
 * ⚠️ 处置 = 只清本单草稿（`clearSale` ✓）；**已提交的明细/收款/库存/到货一个字都不动** ✗
 */
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { logInfo, logWarn } = require('../src/utils/logger');

const args = process.argv.slice(2);
const write = args.includes('--write');
const dirArg = (args.find((item) => item.startsWith('--dir=')) || '').split('=')[1];

(async () => {
  const sessions = createScanSessionService({ config: SCAN_WRITE, ...(dirArg ? { dir: dirArg } : {}) });
  const interrupted = await sessions.findInterruptedSales();
  const uncertain = await sessions.findUncertainInFlightSales();

  for (const item of uncertain) {
    logWarn(SCAN_WRITE.events.interruptedDetected, { ...item, action: 'logged_only' });
  }
  for (const item of interrupted) {
    logInfo(SCAN_WRITE.events.interruptedDetected, { ...item, action: write ? 'clearing' : 'dry_run' });
    if (write) {
      await sessions.clearInterruptedSale(item.openId);
      logInfo(SCAN_WRITE.events.interruptedCleared, { ...item, action: 'draft_cleared' });
    }
  }
  console.log(JSON.stringify({
    dry_run: !write, interrupted: interrupted.length, uncertain: uncertain.length,
    hint: write ? 'cleared drafts only (accounts untouched)' : 'no change (add --write to clear drafts)',
  }));
})().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
