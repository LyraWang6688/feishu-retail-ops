'use strict';

/**
 * ⭐⭐ 2026-10-17（业务负责人选的方案 A）：把"五处扫一扫"登记表里两个**只登记、没接线**的参数
 *   变成**真配置** —— 改配置即改行为：
 *     · `returnsToRealm=false` ⇒ 扫完**不回**本领域（地址 / 303 回跳都不带 `from=<领域>`）
 *     · `keepDraft=false`     ⇒ 扫完回来**不带之前的数据**（先清该领域旧草稿）
 *   ＋ 领域条第 5 格文案收敛成**单真源**（`scanEntries.texts.realmBarLabel`）。
 * ⚠️ 默认三个领域都是 `true` ⇒ 线上行为与改前**逐字节相同**（`salesRealmScan` 的 508,287 字节尺子仍绿）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');

const { SCAN_ENTRIES, SCAN_PLACES } = require('../src/config/scanEntries');
const { REALM_SCAN, realmEntryParams, realmScanUrlFor } = require('../src/config/realmScan');
const { SCAN_PAGE } = require('../src/config/scanPage');

test('领域条第 5 格文案：唯一真源 = 五处登记表（scanPage 不再写死一份）', () => {
  assert.equal(SCAN_PAGE.realmBar.scanLabel, SCAN_ENTRIES.texts.realmBarLabel,
    'scanPage.realmBar.scanLabel 必须等于登记表里的 realmBarLabel（单真源）');
  const scanPage = read('config/scanPage.js');
  assert.equal(/scanLabel:\s*'扫一扫'/.test(scanPage), false,
    'scanPage 不许再写死 `scanLabel: \'扫一扫\'`（改文案只改登记表）');
  assert.match(scanPage, /SCAN_ENTRIES/, 'scanPage 必须从登记表取文案');
});

test('三个「再加一单」的 returnsToRealm / keepDraft 来自登记表（默认 true）', () => {
  for (const realm of ['sales', 'replenish', 'purchase_return']) {
    const place = SCAN_PLACES.find((item) => item.realm === realm);
    assert.ok(place, `登记表里必须有 ${realm} 这一处`);
    assert.equal(realmEntryParams(realm).returnsToRealm, true, `${realm} 默认回本领域`);
    assert.equal(realmEntryParams(realm).keepDraft, true, `${realm} 默认带草稿`);
  }
  assert.equal(REALM_SCAN.realmEntries.sales.returnsToRealm, true, '运行期配置也读到了登记表');
});

test('改配置即改行为：returnsToRealm=false ⇒ 扫完地址里不带 from=<领域>', () => {
  const base = 'https://hm.bamamei.online/r/rec123';
  const keep = realmScanUrlFor({ scanned: 'rec123', realm: 'sales', origin: 'https://hm.bamamei.online' });
  assert.ok(keep.includes('from=sales'), '默认（true）⇒ 落点带 from=<领域>');
  const injected = {
    ...REALM_SCAN,
    realmEntries: { ...REALM_SCAN.realmEntries, sales: { returnsToRealm: false, keepDraft: true } },
  };
  const off = realmScanUrlFor({ scanned: 'rec123', realm: 'sales', origin: 'https://hm.bamamei.online', config: injected });
  assert.equal(off.includes('from='), false, 'returnsToRealm=false ⇒ 地址里不带 from');
  const full = realmScanUrlFor({ scanned: base, realm: 'sales', config: injected });
  assert.equal(full, base, '完整网址原样返回（不改路径、不加 from）');
  assert.equal(realmEntryParams('sales', injected).returnsToRealm, false, '参数确实来自配置');
});

test('A 套 / 客户端都接线了（源码哨兵：塞回"只登记不读"⇒ 红）', () => {
  const routes = read('routes/scanPage/index.js');
  assert.match(routes, /realmEntryParams\(/, '路由必须读登记参数（不再只看开关）');
  assert.match(routes, /entry\.returnsToRealm === false/, '303 回跳必须按 returnsToRealm 分支');
  assert.match(routes, /withoutRealmQuery\(/, 'returnsToRealm=false 时必须去掉 from=<领域>');
  assert.match(routes, /clearDraftForScanIfNeeded\(/, 'keepDraft=false 时必须有"清旧草稿"的接线');
  assert.match(routes, /realmScanTriggered\(req, realm\)\) await clearDraftForScanIfNeeded/, '只在"扫完回来"那一发清草稿');
  const client = read('views/scanRealmScan.js');
  assert.match(client, /appendRealm/, '客户端落点必须读 appendRealm');
  for (const relative of ['views/scanPage/paymentBlock.js', 'views/scanPage/multiItemBlock.js']) {
    assert.match(read(relative), /appendRealm:/, `${relative} 必须把 appendRealm 传给客户端`);
  }
});
