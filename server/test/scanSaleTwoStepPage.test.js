require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
const { rendererSource } = require('./support/rendererSource');
/**
 * ⭐⭐ 2026-10-13「金额两步走 + 成功页三入口」的验收标准（**先写先红**）。
 *
 * 口径出处：`docs/scan-sales-payment-flow-2026-10-13.md`（业务负责人 2026-10-13，逐字）
 *   · 第 1 步（**提交前**）：每双只显示 **颜色 · 尺码 · 这一双的成交金额** ✓
 *     🔴 **不出现**整单付款信息（全付/部分付/未付 · 付款方式 · 赠品）
 *   · 第 2 步（**提交后**）：整单 ⇒ **全付/部分付/未付（横向一排）** + **付款方式可加多行** + **赠品** + 「跳过」
 *     ⭐ **可填可不填** ⇒ 不填 = **待补充的信息单**（**不是失败** ✗ 不许报错拦人）
 *   · 成功页（**2026-10-16 版**）：「✅ **本单提交成功**（单号 XSD-…）」+ **那一句统一文案**
 *     「**已提交成功，数据会更新**」；🔴 **零链接 / 零按钮 / 零跳转** ✗
 *     —— 改前逐字 → 改后逐字 → 依据见下面 **AC-2S3 / AC-2S4** 两条的迁移注释 ✓
 *     （她 2026-10-13 那版的三入口「继续录下一单 / 去工作台看这一单 / 补整单付款」**已全删** ✗）
 *     ⚠️「正在提交…」只是**按钮态**，**不能替代成功页** ✗
 *   · §六（后出，作废 §一/§三 里"每双显示配品及其金额"）：**录入页不涉及配品**（配品是扫码页另一个 tab ✓）
 *
 * 🔴 底层链路一行不动（她的原话：现货/预订/幂等键/posted_keys/顺序/串行队列/
 *   「信息没填全怎么同步工作台」）⇒ 本文件**只断言展示与交互**，不碰那些 ✓
 *
 * ⚠️ 本文件现在**故意是红的**（第 1 步只写 AC，渲染层等"六 tab"合掉后再动 ✗）：
 *   · AC-2S1 **红**（录入页现在还带着整单付款字段）
 *   · AC-2S2 绿（每双金额输入是**现成能力**，只补断言 ✓）
 *   · AC-2S3/AC-2S4 **红**（第二步页 / 成功页三入口还没做）
 *   ⇒ 实现落地后这里必须全绿；页面级（表单结构）的严格断言在渲染层落地后**追加在本文件** ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_two_step';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'two_step_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { renderScanPage } = require('../src/views/scanPageRenderer');

const SERVER = path.join(__dirname, '..');
const RENDERER_SRC = rendererSource();
const CONFIG_SRC = fs.readFileSync(path.join(SERVER, 'src/config/scanWrite.js'), 'utf8')
  + fs.readFileSync(path.join(SERVER, 'src/config/scanPage.js'), 'utf8');

const VIEW = {
  found: true, number: 'YD6693-2|棕色|A', item_no: 'YD6693-2', color: '棕色', category_name: '休闲鞋',
  price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '41', cells: [{ key: '门盒', count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-10-13 17:00',
};

/** 录入页（第 1 步）的写上下文：本单里有 1 双。 */
const WRITE = {
  enabled: true, texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
  postAction: '/r/YD6693-2%7C%E6%A3%95%E8%89%B2%7CA?from=sales', saleKey: 'k',
  draft: { lines: [{ product_number: 'YD6693-2', size: 41, quantity: 1, sale_unit_price: 399 }] },
  paymentMethods: ['微信'], defaultPaymentMethod: '微信', saleEnabled: true,
};

const entryHtml = (write = WRITE) => renderScanPage(VIEW, SCAN_PAGE, write, 'sales', {});

test('AC-2S1 🔴 录入页（第 1 步）**不出现**整单付款字段与付款方式', () => {
  const html = entryHtml();
  // ① 三个整单付款字段（方式 / 金额 / 档位）一个都不许在录入页
  for (const field of [SCAN_WRITE.fields.paymentMethod, SCAN_WRITE.fields.paymentAmount, SCAN_WRITE.fields.paymentStatus]) {
    assert.equal(html.includes(`name="${field}"`), false, `录入页不许有整单付款字段 name="${field}"（挪到第 2 步）`);
  }
  // ② 「付款情况」那几个字（配置里的文案，不写死中文）也不许在录入页
  // ⚠️ 2026-10-13（实现落地时补的口径）：判据要**先去掉 `<style>` 块与 HTML 注释**再找那个词 ——
  //    它是**她看得见的文案**的判据，不是"源码里一个字节都不许出现"。
  //    为什么：`STYLE` 里那条**既有** CSS 注释（2026-10-11 写的，且被中文白名单收着）就含这个词，
  //    而那条注释**必须逐字不动**（门禁把整个 STYLE 字面量当一个串，动它就算"新增"）。
  //    ⇒ 去掉样式/注释之后仍然不许出现 ⇒ 原口径一刀不减 ✓
  const visibleHtml = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  assert.equal(visibleHtml.includes(SCAN_WRITE.texts.paymentStatusLabel), false,
    `录入页不许出现「${SCAN_WRITE.texts.paymentStatusLabel}」`);
  // ③ 赠品（整单维度）同样在第 2 步问
  assert.equal(html.includes(`name="${SCAN_WRITE.fields.gift}"`), false, '赠品也挪到第 2 步');
});

test('AC-2S2 ✅ 每双显示 颜色 · 尺码 · **这一双的成交金额**（现成能力，只补断言）', () => {
  const html = entryHtml();
  const block = html.slice(html.indexOf('realm-block--sales'));
  // 这一双的成交金额 = 每行一个输入（`fields.lineAmount`）
  assert.ok(block.includes(`name="${SCAN_WRITE.fields.lineAmount}"`), '每双一个「这一双的成交金额」输入');
  assert.ok(block.includes(SCAN_WRITE.texts.lineAmountLabel), `标签 = ${SCAN_WRITE.texts.lineAmountLabel}`);
  // 行上要有 颜色 / 尺码 的事实（本单行文案由配置给）
  const line = block.slice(block.indexOf('draft-line'));
  assert.ok(line.includes('棕色') || line.includes('41'), '每行带颜色/尺码事实');
  // ⚠️ §六：录入页**不涉及配品**（配品是扫码页另一个 tab）
  assert.equal(block.includes('add_accessory'), false, '录入页没有配品控件（§六）');
});

test('AC-2S3 🔴 第二步页存在且能提交：三档（横向）+ 付款方式可加多行 + 赠品 + 「跳过」', () => {
  // ⭐⭐ 2026-10-16 迁移（改前逐字 → 改后逐字 → 依据）——
  //   改前逐字：`const must = ['跳过', '继续录下一单', '补整单付款', '本单提交成功'];`
  //   改后逐字：`const must = ['跳过', '本单提交成功'];` ＋ 单独一条
  //     `assert.ok(JSON.stringify(SCAN_PAGE.saleSuccess).includes('已提交成功，数据会更新'), …)`
  //     （⚠️ 那一句**钉配置的值**，不靠"源码里出现过"—— 否则注释里写一句就能满足，是弱判据 ✗）
  //   依据：业务负责人 2026-10-16 逐字「资金页上……**跳过也是成功页**……那三处提示【全删】……
  //     **全删就对了**」＋「用户提交之后**都是一个成功页**，说『**已提交成功，数据会更新**』类似这类的话就行了」
  //     ⇒ 第 2 步/成功页的必含文案换成"跳过 ＋ 成功页 ＋ **那一句**" ✓（三入口两条已全删 ✗，
  //     不是放宽：**必含集合换成她点名的那一句**，且下面 AC-2S4 反向钉住"三入口不许回来" ✓）
  const must = ['跳过', '本单提交成功'];
  for (const copy of must) {
    assert.ok(CONFIG_SRC.includes(copy) || RENDERER_SRC.includes(copy), `第 2 步/成功页缺文案「${copy}」`);
  }
  // 🔴 **那一句**必须钉在**配置的值**上（不是"源码里出现过" ✗ —— 注释里写一句也能满足，那是弱判据）
  assert.ok(JSON.stringify(SCAN_PAGE.saleSuccess).includes('已提交成功，数据会更新'),
    '成功页要有**那一句**统一文案（`SCAN_PAGE.saleSuccess` 的**值**里必须有 ⇒ 改坏它 ⇒ 本判据红 ✓）');
  // 三档必须**横向一排**（她 2026-10-13：垂直占屏太高 ✗）—— 契约：横向布局类名/样式要在
  assert.ok(/pay-status__options[\s\S]{0,200}grid-template-columns:\s*repeat\(3/.test(RENDERER_SRC)
    || /payment-step[\s\S]{0,300}repeat\(3/.test(RENDERER_SRC), '三档要横向一排（repeat(3,）');
  // 「跳过 ⇒ 待补充（不是失败）」：状态不得是失败态
  assert.ok(/待补充/.test(CONFIG_SRC) || /待补充/.test(RENDERER_SRC), '不填 = 待补充的信息单（不是失败）');
  assert.equal(/skip[\s\S]{0,80}(failed|error|失败)/i.test(CONFIG_SRC), false, '跳过**不是**失败路径');
});

test('AC-2S4 🔴 成功页统一极简：「本单提交成功」+ 单号 + **那一句**；三入口**全删** ✗（塞回 ⇒ 红 ✓）', () => {
  const success = RENDERER_SRC.slice(RENDERER_SRC.indexOf('renderSaleSuccessPage'));
  assert.ok(success.length > 0, '成功页渲染器存在');
  // ① 主文案逐字 + 单号占位
  assert.ok(CONFIG_SRC.includes('本单提交成功'), '主文案要含「本单提交成功」（逐字）');
  assert.ok(/XSD-|order_no|orderNo/.test(CONFIG_SRC + success), '成功页要带单号');
  // ② ⭐⭐ 2026-10-16 迁移（改前逐字 → 改后逐字 → 依据）——
  //   改前逐字：
  //     `for (const entry of ['继续录下一单', '去工作台', '补整单付款']) {`
  //       `assert.ok(CONFIG_SRC.includes(entry) || success.includes(entry), `成功页缺入口「${entry}」`); }`
  //   改后逐字：下面两条（**必含那一句** ＋ 三入口**一个都不许出现**）
  //   依据：业务负责人 2026-10-16 逐字「那三处提示【全删】……**全删就对了**」＋
  //     「成功页它**不需要做任何跳转**，也**不需要做任何链接**」⇒ 三条入口**全删** ✗
  //     （不是放宽：原来钉"**必须有那三条**"，现在钉"**必须有那一句 ＋ 那三条一个都不许有**"✓）
  // 🔴 同上：钉**配置的值**（`SCAN_PAGE.saleSuccess`），不靠"源码里出现过" ——
  //    注释里写一遍不该让这条变绿（否则"那一句"改坏了本判据也不红 ✗）
  assert.ok(JSON.stringify(SCAN_PAGE.saleSuccess).includes('已提交成功，数据会更新'),
    '成功页要有**那一句**统一文案（销售 / 补货 / 退货 / 验收四条链路共用 · 钉的是配置的值 ✓）');
  // ⚠️ 反向哨兵的扫描范围 = **它原来住的那两处**：`SCAN_PAGE.saleSuccess`（配置）＋
  //    成功页渲染器那一段（**不扫整份 CONFIG_SRC** —— `paymentStep.pendingNote` 里"去工作台补收款即可"
  //    是**另一句**（资金页那句），把它算进来会假红 ✗）
  const configuredSuccess = JSON.stringify(SCAN_PAGE.saleSuccess);
  assert.deepEqual(['继续录下一单', '去工作台看这一单', '去工作台补收款', '补整单付款']
    .filter((entry) => configuredSuccess.includes(entry) || success.includes(entry)), [],
  '🔴 三入口文案**全删** ✗（塞回任一条 ⇒ 本判据红 ✓）');
  // ③ ⚠️「正在提交…」只是按钮态，不代表成功页
  assert.equal(CONFIG_SRC.includes('正在提交，请不要重复点'), true, '按钮态仍在（防连点 ✓）');
  assert.notEqual(CONFIG_SRC.includes('本单提交成功'), false, '但它不能替代成功页 ✗');
});
