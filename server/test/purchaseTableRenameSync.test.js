const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { PURCHASE_ARRIVAL_STATUS_FIELD_KEY } = require('../src/config/purchaseArrivalStatus');

// ⭐ 业务负责人 2026-10-07 在生产表做了这些事，代码必须同步（AGENTS.md：
//   「我这边在生产表里面做的任何更改，你都要改」）：
//   ① 两张表改名：「供应商对接」→「信息填写」、「单据信息」→「具体信息」；
//   ② 「具体信息」删了「到货状态」「采购申请单」两列；「报货批次」新增
//      「到货状态」「单据」「采购行为」三列（其中「采购行为」她说不用管）；
//   ③ ⭐ 同日**又**改了第三张：「采购到货」→**「到货验收」**（tableId 不变），
//      并把这张表上的**「图片」整列删掉** —— schema 的 `images: '图片'` 映射必须跟着删。
//      （部署闸门对着生产报红的就是这一行：「“采购到货”缺少 V1 字段: 图片」。）
//
// ⚠️ 闸门（v1:schema-check）按 **tableId** 校验字段名、**不校验表名** ——
//    表改名它拦不住，所以只能靠这里（与用户可见文案）自己同步。

const SERVER_ROOT = path.join(__dirname, '..');

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

test('A1 schema 表名 = 信息填写 / 具体信息（改名的同步点之一）', () => {
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseReport.tableName, '信息填写');
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseRequest.tableName, '具体信息');
  // 别的表名不受影响
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.tableName, '报货批次');
});

test('B1/B3 字段映射同步：具体信息删两列、报货批次加两列、采购行为不映射', () => {
  const request = V1_BITABLE_SCHEMA.tables.purchaseRequest.fields;
  // ⚠️ 这两行删掉是"两个都删"的一半：映射 + 写入点（写入点在代码里，见下一条用例）
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'arrivalStatus'), false,
    '「具体信息.到货状态」已被她从生产表删除 → 映射必须删');
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'attachment'), false,
    '「具体信息.采购申请单」已被她从生产表删除 → 映射必须删');

  const batch = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;
  assert.equal(batch.arrivalStatus, '到货状态');
  assert.equal(batch[PURCHASE_ARRIVAL_STATUS_FIELD_KEY], '到货状态', '到货状态的语义键与配置里声明的一致');
  assert.equal(batch.document, '单据');
  // 🔴 她说「报货批次里面的采购行为你不用管」⇒ 不映射（不映射就自然读不到、写不了）
  assert.equal(Object.prototype.hasOwnProperty.call(batch, 'behavior'), false,
    '「报货批次.采购行为」不读不写不映射');

  // 供应商（9 点推送【采购】区要显示的那一列）：只读投影
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseReport.fields.supplier, '供应商');
});

test('B2 已删列**全仓不再有写入/读取点**：附件只会写「报货批次.单据」', () => {
  const files = walk(path.join(SERVER_ROOT, 'src')).filter((file) => file.endsWith('.js'));
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([^:])\/\/.*$/gm, '$1');
    // 「具体信息」那一列已经不存在了：任何 update/create 里再出现 attachment 语义键都是回归
    if (/\battachment:\s*\[/.test(codeOnly) || /fields\.attachment\b/.test(codeOnly)) {
      offenders.push(`${path.relative(SERVER_ROOT, file)}: attachment 写入/读取`);
    }
    if (/purchaseRequest'?,?\s*\{[^}]*arrivalStatus/.test(codeOnly)) {
      offenders.push(`${path.relative(SERVER_ROOT, file)}: 往「具体信息」写到货状态`);
    }
  }
  assert.deepEqual(offenders, [], `已删除的列不许再被写/读：${offenders.join('；')}`);
});

test('A2 旧表名不再出现在用户可见文案与代码里（历史沿革注释除外）', () => {
  const roots = [path.join(SERVER_ROOT, 'src'), path.join(SERVER_ROOT, 'public')];
  const files = roots.flatMap((root) => walk(root)).filter((file) => /\.(js|html|css|json)$/.test(file));
  const offenders = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!line.includes('供应商对接') && !line.includes('单据信息')) return;
      // 「表名沿革：「供应商报货」→（2026-10-05）「供应商对接」→…」这类**历史记录**允许保留
      //（它写的就是"以前叫什么"，删掉反而让下一次改名的人不知道沿革）。
      if (/沿革|原[「]?(供应商对接|单据信息)/.test(line)) return;
      offenders.push(`${path.relative(SERVER_ROOT, file)}:${index + 1} ${line.trim().slice(0, 60)}`);
    });
  }
  assert.deepEqual(offenders, [], `旧表名必须同步成新名：\n${offenders.join('\n')}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 第三张改动（2026-10-07 晚）：「采购到货」→「到货验收」+ 删「图片」列
// ═══════════════════════════════════════════════════════════════════════════

test('A3 schema 表名 = 到货验收（tableId 不变）· 其余四张采购表名一个都没动', () => {
  const arrival = V1_BITABLE_SCHEMA.tables.purchaseArrival;
  assert.equal(arrival.tableName, '到货验收', '「采购到货」已在生产改名「到货验收」');
  assert.ok(arrival.tableId, 'tableId 不许为空');
  // 改名**不许动** tableId（动它就是把数据指到别的表去）。
  // ⚠️ 本机 .env 指向测试 Base 时 tableId 会被环境变量覆盖，所以核的是**默认值那一行**。
  const schemaSource = fs.readFileSync(path.join(SERVER_ROOT, 'src/config/v1BitableSchema.js'), 'utf8');
  assert.match(
    schemaSource,
    /tableId: getEnv\('FEISHU_V1_PURCHASE_ARRIVAL_TABLE_ID', 'tblvLOXKESNTbZ7v'\)/,
    'tableId 的默认值必须还是生产真表那个 tblvLOXKESNTbZ7v',
  );

  // 其余四张：**没漂的不许动**（这次只改「到货验收」一张的表名）
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseReport.tableName, '信息填写');
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseRequest.tableName, '具体信息');
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.tableName, '报货批次');
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseInbound.tableName, '采购入库');
});

test('B4 「到货验收.图片」列已删：映射删除，且没有换个语义键把它映射回来', () => {
  const fields = V1_BITABLE_SCHEMA.tables.purchaseArrival.fields;
  assert.equal(
    Object.prototype.hasOwnProperty.call(fields, 'images'), false,
    '「图片」整列已被她从生产表删除 → images 映射必须删（闸门红的就是它）',
  );
  const mappedNames = Object.values(fields);
  assert.equal(mappedNames.includes('图片'), false, '不许换个语义键把「图片」映射回来');
  assert.equal(mappedNames.includes('鞋盒图片'), false, '「鞋盒图片」是更早一版的名字，同样不许出现');
  // 剩下的 5 个映射 = 生产真表那 7 列里的业务列（到货日 / 报货批次号 / 验收人 / 确认状态 / 验收原话）
  assert.deepEqual(fields, {
    arrivalAt: '到货日',
    batch: '报货批次号',
    inspector: '验收人',
    confirmStatus: '确认状态',
    acceptanceText: '验收原话',
  });
});

test('B5 已删列的读写点全清：全仓不再读/写「到货验收.图片」（去注释后扫描）', () => {
  const roots = [path.join(SERVER_ROOT, 'src'), path.join(SERVER_ROOT, 'public')];
  const files = roots.flatMap((root) => walk(root)).filter((file) => /\.(js|html)$/.test(file));
  const offenders = [];
  for (const file of files) {
    const codeOnly = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([^:])\/\/.*$/gm, '$1');
    const rel = path.relative(SERVER_ROOT, file);
    // 读：`purchaseArrival.fields.images`（唯一的读点原在 purchaseQueryService）
    if (/fields\.images\b/.test(codeOnly)) offenders.push(`${rel}: 读 fields.images`);
    // 写：`images: [...]`（附件值），或往 purchaseArrival 里塞 images 语义键
    if (/\bimages\s*:\s*\[/.test(codeOnly)) offenders.push(`${rel}: 往 images 写附件`);
    // 投影/渲染：image_count（列没了还留着它 ⇒ 永远显示 0，误导）
    if (/\bimage_count\b/.test(codeOnly)) offenders.push(`${rel}: 还在用 image_count`);
  }
  assert.deepEqual(offenders, [], `已删除的列不许再被读/写：${offenders.join('；')}`);
});

test('B6 ⭐ 同名不同物**不许被误删**：采购申请 PNG 出图器 `this.images.render` 还在', () => {
  // `purchaseWebhookService.this.images` 是「明细 → PNG」的出图渲染器，
  // 名字里带 images，但**跟「到货验收.图片」那个附件列毫无关系**。清读写点时极易误删。
  const source = fs.readFileSync(path.join(SERVER_ROOT, 'src/services/purchaseWebhookService.js'), 'utf8');
  assert.match(source, /this\.images = options\.images \|\| \{ render: renderPurchaseRequestPng \}/,
    '出图渲染器的默认实现必须还在');
  assert.match(source, /await this\.images\.render\(/, '出图的调用点必须还在');
});

test('B7 工作台采购页：表名文案同步成「到货验收」· 并且不再有「图片数」列', () => {
  const rel = 'public/workbench/features/purchase/index.js';
  const source = fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
  assert.match(source, /到货验收情况/, '子标签要跟着表名走（AGENTS.md：表改名同步用户可见文案）');
  assert.match(source, /没有匹配的到货验收记录/);
  // ⚠️ 去注释后再核"旧东西不许再出现"：**注释里要留着沿革**
  //（"原先这里有一列「图片数」…已删"），扫注释会把那段说明本身当成违规。
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
  assert.equal(codeOnly.includes('采购到货情况'), false);
  assert.equal(codeOnly.includes('没有匹配的采购到货记录'), false);
  assert.equal(codeOnly.includes('图片数'), false, '列都被删了，这一列留着只会永远显示 0');
  assert.equal(codeOnly.includes('image_count'), false);
});
