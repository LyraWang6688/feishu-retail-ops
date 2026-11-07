'use strict';

/**
 * ⭐⭐ task-11：**工作台「草稿单」= 销售扫码页留下的本地中间态**（只读 / 清空，**零业务表**）。
 *
 * 口径（业务负责人）：
 *   · 草稿**唯一存储** = 扫码页的 `data/scan_sessions/`（本用例用临时目录真跑 `scanSessionService`）；
 *   · 工作台草稿箱**只读它、只清它**，**不写数据库 / 不写飞书 Base**；
 *   · 按**人**隔离；已提交成功的单**不再出现**；过期 / 捡坏文件有明确的状态与提示。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AC（先写后做）：
 *  AC-DB1 列表只列"我的、有货、未提交"的会话：单号 / 货品 / 数量 / 总金额 / 最后更新 / 状态都在；
 *         别人的、空会话、已提交的都不出现。
 *  AC-DB2 ⭐ **已提交成功的草稿不再出现**（`completeSale` 清 lines ⇒ 天然过滤）—— 反向钉住，
 *         以后谁改 `completeSale`/`clearSale` 让 lines 留着，本用例红。
 *  AC-DB3 清空**只清本地那一份**：lines 清空，`completed[]` / 补货块 / 退货块**一个字节不动**。
 *  AC-DB4 **写中的草稿**（有 master_record_id / 单号 / 待提交资金入参）：`clear` 400 拒绝、`resume` 也不给。
 *  AC-DB5 **过期**草稿：只可清空、不可继续编辑（过期后 revive 会按 staleDraftMs 丢行 ⇒ 给了入口反而误导）。
 *  AC-DB6 **按人隔离**：拿别人的 draft_id ⇒ 404（与"不存在"同一个回答，不泄露别人有没有草稿）。
 *  AC-DB7 **坏 JSON 不许打崩整张草稿箱**：坏文件只计数（`corrupt_count`），好草稿照列，
 *         **不删任何文件**；"空列表"与"有坏文件"能区分。
 *  AC-DB8 **继续编辑回同一份**：目标 `/r/<首行货品记录ID>?from=sales`；
 *         页面 token 会话能取回 token（交给路由写 cookie）、旧会话取回空串（不编）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createScanSessionService } = require('../src/services/scanSessionService');
const { createScanDraftBoxService } = require('../src/services/scanDraftBoxService');

const OPEN_ID = 'ou_draft_box_owner';
const OTHER_ID = 'ou_draft_box_other';

const lineOf = (size, amount, recordId = 'rec_1') => ({
  kind: 'shoe', number: 'K1|黑色|A', item_no: 'K1', color: '黑色',
  product_record_id: recordId, size, trade_type_code: 'SALE_PREPAID', amount: String(amount), gift: '',
});

const withBox = async (run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-box-'));
  const sessions = createScanSessionService({ dir });
  try {
    return await run({ dir, sessions });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** 摆一份"她正在攒的本单"（真会话文件；只写本地临时目录）。 */
const seedDraft = async (sessions, openId, { lines = [lineOf(41, 200)], sessionKey = openId, sale = {} } = {}) => {
  const session = await sessions.ensure(sessionKey);
  await sessions.store.update(session.session_id, (current) => ({
    sale: {
      ...(current.sale || {}),
      status: 'draft',
      lines,
      ...sale,
    },
  }));
  return sessions.get(sessionKey);
};

test('AC-DB1 ⭐ 列表：只列"我的、有货、未提交"的，字段齐全（单号/货品/数量/金额/时间/状态）', async () => {
  await withBox(async ({ sessions }) => {
    await seedDraft(sessions, OPEN_ID, { lines: [lineOf(41, 200), lineOf(42, 150.5)] });
    // 别人的
    await seedDraft(sessions, OTHER_ID, { lines: [lineOf(40, 999)] });
    // 空会话（扫了一眼，什么都没加）
    await sessions.ensure('ou_draft_box_empty');
    const box = createScanDraftBoxService({ sessions });

    const result = await box.list({ openId: OPEN_ID });
    assert.equal(result.enabled, true);
    assert.equal(result.drafts.length, 1, '只列"我的、有货"的那一份');
    assert.equal(result.total, 1);
    assert.equal(result.corrupt_count, 0);
    const [draft] = result.drafts;
    assert.match(draft.draft_id, /^scan_session_[a-f0-9]{16}$/, 'draft_id = 会话 id（openId 的 hash，不含 openId）');
    assert.equal(draft.status_code, 'draft');
    assert.equal(draft.resumable, true, '普通草稿可继续编辑');
    assert.equal(draft.clearable, true);
    assert.equal(draft.order_no, '', '还没提交 ⇒ 没有单号（页面显示"还没生成单号"）');
    assert.equal(draft.line_count, 2);
    assert.equal(draft.items.length, 2);
    assert.deepEqual(draft.items[0], {
      kind: 'shoe', kind_label: '鞋', item_no: 'K1', color: '黑色', size: '41', amount: 200,
    });
    assert.equal(draft.total_amount, 350.5, '总金额 = 各行金额之和（分累加，无浮点尾巴）');
    assert.match(draft.updated_at_text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '最后更新按上海时间给文本');
    // 不返回身份/内部进度
    const json = JSON.stringify(result);
    assert.equal(json.includes(OPEN_ID), false, '**不返回 open_id**');
    assert.equal(json.includes('master_record_id'), false, '**不返回 master_record_id**');
    assert.equal(json.includes('|page|'), false, '**不返回会话键/页面 token**');
  });
});

test('AC-DB2 ⭐⭐ 已提交成功的草稿不再出现（completeSale 清 lines ⇒ 天然过滤 · 反向钉住）', async () => {
  await withBox(async ({ sessions }) => {
    const session = await seedDraft(sessions, OPEN_ID);
    const box = createScanDraftBoxService({ sessions });
    assert.equal((await box.list({ openId: OPEN_ID })).drafts.length, 1, '提交前：在草稿箱里');

    // 走**真实**的成功出口（与扫码页提交成功后同一条）
    await sessions.completeSale(OPEN_ID, {
      key: session.sale.key, result: { order_no: 'XSD-20261029-0001', detail_count: 1 },
    });

    const after = await box.list({ openId: OPEN_ID });
    assert.equal(after.drafts.length, 0, '提交成功后**不再出现在草稿箱**（这就是"已完成单不回来"的判据）');
    // 反向确认判据来源：lines 真的被清空了（谁让 lines 留着 ⇒ 本用例红）
    const raw = await sessions.get(OPEN_ID);
    assert.deepEqual(raw.sale.lines, [], '成功出口必须清空本单（AC-DB2 的根）');
    assert.equal(raw.sale.status, 'submitted');
    assert.equal(raw.sale.completed.length >= 1, true, '留档还在（幂等回查用，草稿箱不读它）');
  });
});

test('AC-DB3 ⭐ 清空只清本地那一份：lines 清空，completed / 补货块 / 退货块一个字节不动', async () => {
  await withBox(async ({ sessions, dir }) => {
    const seeded = await seedDraft(sessions, OPEN_ID, {
      lines: [lineOf(41, 200)],
      sale: { completed: [{ key: 'scan_sale:x:0', order_no: 'XSD-OLD-1' }] },
    });
    // 摆一份补货/退货的进度（草稿箱**不许**碰）
    await sessions.store.update(seeded.session_id, (current) => ({
      replenish: { ...(current.replenish || {}), last_error: 'keep me' },
      purchaseReturn: { ...(current.purchaseReturn || {}), last_error: 'keep me too' },
    }));
    const before = await sessions.get(OPEN_ID);
    const box = createScanDraftBoxService({ sessions });

    const result = await box.clear({ openId: OPEN_ID, draftId: seeded.session_id });
    assert.equal(result.cleared, true);
    assert.equal(result.line_count, 1);

    const after = await sessions.get(OPEN_ID);
    assert.deepEqual(after.sale.lines, [], '本单清空 ✓');
    assert.deepEqual(after.sale.completed, before.sale.completed, 'completed[]（幂等回查）**不许动**');
    assert.equal(after.replenish.last_error, 'keep me', '补货那一块不许动');
    assert.equal(after.purchaseReturn.last_error, 'keep me too', '退货那一块不许动');
    assert.equal(after.sale.status, 'draft');
    // 清空之后它就不在草稿箱里了
    assert.equal((await box.list({ openId: OPEN_ID })).drafts.length, 0);
    // 只动了会话目录里的文件（没有别的存储被动过：目录里仍只有 1 份会话）
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.json')).length, 1,
      '草稿箱不新建任何存储（还是那一份会话文件）');
  });
});

test('AC-DB4 ⭐⭐ 写中的草稿：清空 400 拒绝、继续编辑也不给（清掉会丢"主表已建"的进度 ⇒ 重复建单）', async () => {
  await withBox(async ({ sessions }) => {
    const seeded = await seedDraft(sessions, OPEN_ID, {
      lines: [lineOf(41, 200)],
      sale: { master_record_id: 'rec_master_1', order_no: 'XSD-20261029-0002', detail_ids: ['rec_d1'] },
    });
    const box = createScanDraftBoxService({ sessions });
    const [draft] = (await box.list({ openId: OPEN_ID })).drafts;
    assert.equal(draft.status_code, 'in_flight');
    assert.equal(draft.clearable, false);
    assert.equal(draft.resumable, false);
    await assert.rejects(() => box.clear({ openId: OPEN_ID, draftId: seeded.session_id }),
      (error) => error.statusCode === 400 && error.code === 'draft_in_flight');
    await assert.rejects(() => box.resumeTarget({ openId: OPEN_ID, draftId: seeded.session_id }),
      (error) => error.statusCode === 400);
    // 原样还在（拒绝时一个字节都不动）
    const raw = await sessions.get(OPEN_ID);
    assert.equal(raw.sale.master_record_id, 'rec_master_1');
    assert.equal(raw.sale.lines.length, 1);
  });
});

test('AC-DB5 ⭐ 过期草稿：只可清空、不可继续编辑（过期后接着录会静默丢行 ⇒ 不给入口）', async () => {
  await withBox(async ({ sessions }) => {
    const seeded = await seedDraft(sessions, OPEN_ID);
    await sessions.store.update(seeded.session_id, { expires_at: new Date(Date.now() - 60_000).toISOString() });
    const box = createScanDraftBoxService({ sessions });
    const [draft] = (await box.list({ openId: OPEN_ID })).drafts;
    assert.equal(draft.status_code, 'expired');
    assert.equal(draft.clearable, true, '过期 ⇒ 可以清空');
    assert.equal(draft.resumable, false, '过期 ⇒ **不给继续编辑**');
    await assert.rejects(() => box.resumeTarget({ openId: OPEN_ID, draftId: seeded.session_id }),
      (error) => error.statusCode === 400 && error.code === 'draft_expired');
    await box.clear({ openId: OPEN_ID, draftId: seeded.session_id });
    assert.equal((await box.list({ openId: OPEN_ID })).drafts.length, 0);
  });
});

test('AC-DB6 ⭐ 按人隔离：拿别人的 draft_id ⇒ 404（与"不存在"同一个回答，不泄露别人有没有草稿）', async () => {
  await withBox(async ({ sessions }) => {
    const other = await seedDraft(sessions, OTHER_ID);
    const box = createScanDraftBoxService({ sessions });
    await assert.rejects(() => box.clear({ openId: OPEN_ID, draftId: other.session_id }),
      (error) => error.statusCode === 404 && error.code === 'draft_not_found');
    await assert.rejects(() => box.resumeTarget({ openId: OPEN_ID, draftId: other.session_id }),
      (error) => error.statusCode === 404);
    assert.equal((await box.list({ openId: OPEN_ID })).drafts.length, 0);
    // 别人的还在（没被顺手清掉）
    assert.equal((await sessions.get(OTHER_ID)).sale.lines.length, 1);
  });
});

test('AC-DB7 ⭐ 坏 JSON 不许打崩整张草稿箱：只计数、不删文件；"空列表"与"有坏文件"能区分', async () => {
  await withBox(async ({ sessions, dir }) => {
    await seedDraft(sessions, OPEN_ID);
    fs.writeFileSync(path.join(dir, 'scan_session_broken00000000.json'), '{not json', 'utf8');
    const box = createScanDraftBoxService({ sessions });

    const result = await box.list({ openId: OPEN_ID });
    assert.equal(result.drafts.length, 1, '好草稿照列（坏文件不许把整张箱打崩）');
    assert.equal(result.corrupt_count, 1, '坏文件只计数');
    assert.equal((await box.list({ openId: 'ou_nobody' })).corrupt_count, 1,
      '没有草稿的人也能看到"有坏文件"这条提示（与"空列表"区分开）');
    assert.equal((await box.list({ openId: 'ou_nobody' })).drafts.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'scan_session_broken00000000.json')), true,
      '**不删文件**（解析不了的归属不可知，不能替别人删）');
  });
});

test('AC-DB8 ⭐ 继续编辑回**同一份**：目标 /r/<首行记录ID>?from=sales；页面 token 能取回、旧会话为空串', async () => {
  await withBox(async ({ sessions }) => {
    // ① 旧页面会话（纯 openId）
    const legacy = await seedDraft(sessions, OPEN_ID, { lines: [lineOf(41, 200, 'rec_legacy')] });
    // ② 2026-10-18 起的 per-page 会话（openId|page|token）
    const token = 'a'.repeat(32);
    const key = `${OPEN_ID}|page|${token}`;
    const paged = await seedDraft(sessions, key, { lines: [lineOf(42, 300, 'rec_paged')] });
    const box = createScanDraftBoxService({ sessions });

    const legacyTarget = await box.resumeTarget({ openId: OPEN_ID, draftId: legacy.session_id });
    assert.equal(legacyTarget.target_path, '/r/rec_legacy?from=sales');
    assert.equal(legacyTarget.page_token, '', '旧会话没有页面 token（路由会清掉 cookie ⇒ 回落 openId 会话 ✓）');

    const pagedTarget = await box.resumeTarget({ openId: OPEN_ID, draftId: paged.session_id });
    assert.equal(pagedTarget.target_path, '/r/rec_paged?from=sales');
    assert.equal(pagedTarget.page_token, token, 'per-page 会话要把 token 交回路由写 cookie（同一份草稿 ✓）');

    // ③ 两份都在同一个人的草稿箱里（按页隔离 ≠ 看不到）
    assert.equal((await box.list({ openId: OPEN_ID })).drafts.length, 2);
    // ④ 不返回 token 给列表接口（只有 resume 这一层给路由）
    assert.equal(JSON.stringify(await box.list({ openId: OPEN_ID })).includes(token), false);
  });
});
