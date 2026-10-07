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
// 第三张改动（2026-10-07 晚）：「采购到货」→「到货验收」→（**同日稍晚整表删除**）
//   业务负责人的口径（逐字）：
//     「我们到货验收数据表需要写入的点**变到了报货批次里面**……
//       也就是说，我们要把原来到货信息数据表里的落点改写到报货批次里面，
//       **「采购入库.采购到货批次」字段删除了，不需要了**」
//   她还把「采购到货批次」从「采购入库」里整列删掉了。
// ═══════════════════════════════════════════════════════════════════════════

test('A3 schema 里**不再有**「到货验收」表；到货落点搬到「报货批次」的两列上', () => {
  // ① 整段删除：Base 里已经没有任何名字含「到货」/「验收」的表（`tblvLOXKESNTbZ7v` 已不存在）。
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseArrival, undefined,
    '「到货验收」表已被业务负责人整个删除 ⇒ schema 里不许再有这一段');
  const schemaSource = fs.readFileSync(path.join(SERVER_ROOT, 'src/config/v1BitableSchema.js'), 'utf8');
  assert.equal(/FEISHU_V1_PURCHASE_ARRIVAL_TABLE_ID/.test(schemaSource), false,
    '那张表的 tableId 环境变量也没有读取点了');
  assert.equal(/tableName:\s*'到货验收'/.test(schemaSource), false, '不许换个位置把这张表映射回来');

  // ② 落点：验收原话 / 确认状态 两个语义键搬到「报货批次」。
  const batch = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;
  assert.equal(batch.acceptanceText, '验收原话');
  assert.equal(batch.confirmStatus, '确认状态');
  assert.equal(batch.arrivalStatus, '到货状态', '到货状态照旧（这一条本来就有）');

  // ③ ⚠️ 「到货日」「验收人」在真表上是**飞书自动字段**（更新时间 / 创建人）⇒ 不建映射、不写。
  //    只读需要时才会加，加的时候也要认清"它是自动的"——现在两处都不需要。
  assert.equal(Object.prototype.hasOwnProperty.call(batch, 'arrivalAt'), false,
    '「到货日」= 更新时间（自动）→ 不许建映射（代码也不许写）');
  assert.equal(Object.prototype.hasOwnProperty.call(batch, 'inspector'), false,
    '「验收人」= 创建人（自动）→ 不许建映射（代码也不许写）');
  assert.equal(Object.values(batch).includes('到货日'), false);
  assert.equal(Object.values(batch).includes('验收人'), false);

  // ④ 「采购入库」少了「采购到货批次」这一列。
  assert.equal(Object.prototype.hasOwnProperty.call(V1_BITABLE_SCHEMA.tables.purchaseInbound.fields, 'batch'), false,
    '「采购入库.采购到货批次」已被她整列删除 ⇒ 映射必须删');
  assert.equal(Object.values(V1_BITABLE_SCHEMA.tables.purchaseInbound.fields).includes('采购到货批次'), false);

  // ⑤ 其余三张：**没漂的不许动**（这次只动「到货验收」与「采购入库」各一列）。
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseReport.tableName, '信息填写');
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseRequest.tableName, '具体信息');
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.tableName, '报货批次');
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseInbound.tableName, '采购入库');
});

// ═══════════════════════════════════════════════════════════════════════════
// 第四次同步（2026-10-07 深夜）：「报货批次」的两个**自动时间列被改名**
//   · 「创建时间」→ **「报货日」**（类型没变：创建时间 `type=1001`，飞书自动）
//   · 「更新时间」→ **「到货日」**（类型没变：更新时间 `type=1002`，飞书自动）
//   业务负责人的口径：**只是名字变了**，两列还是飞书自动字段 —— 但 schema 里还按旧名
//   `'创建时间'` 找 ⇒ 生产部署闸门判红（`“报货批次”缺少 V1 字段: 创建时间`）。
//   ⚠️ 本次只改**字段名映射**（语义键 `createdAt` 原名不动）；自动时间列**代码一行都不写**。
// ═══════════════════════════════════════════════════════════════════════════

test('A4 schema 同步「创建时间」→「报货日」；两个自动时间列都没有写入点', () => {
  const batch = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;

  // ① 语义键名保持不变，只换物理列名。
  assert.equal(batch.createdAt, '报货日', '「创建时间」已被业务负责人改名为「报货日」');
  assert.equal(Object.values(batch).includes('创建时间'), false, '旧名不许再留在映射里');

  // ② ⚠️ 「到货日」= 改名后的「更新时间」（自动 `type=1002`）⇒ 仍**不建映射、不写**
  //    （与 A3③ / B4 同一条口径：时间字段一律交给飞书自动生成）。
  assert.equal(Object.prototype.hasOwnProperty.call(batch, 'updatedAt'), false,
    '「到货日」= 更新时间（自动）→ 不许建映射（代码也不许写）');
  assert.equal(Object.values(batch).includes('到货日'), false);

  // ③ ⭐ 守门：两个自动时间列的**物理名**在代码里一个都不许出现。
  //    写入只可能经两条路 —— 语义键（`createdAt`）或物理列名；两条都扫 = 钉住"没有写入点"。
  //    ⚠️ 去注释后再扫：注释里要留沿革（"原来叫创建时间"「到货日就是更新时间」）。
  const roots = [
    path.join(SERVER_ROOT, 'src'),
    path.join(SERVER_ROOT, 'public'),
    path.join(SERVER_ROOT, 'scripts'),
  ];
  const files = roots.flatMap((root) => walk(root)).filter((file) => /\.(js|html)$/.test(file));
  const SCHEMA_REL = 'src/config/v1BitableSchema.js';
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(SERVER_ROOT, file);
    const codeOnly = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([^:])\/\/.*$/gm, '$1');
    // 物理名：`「报货日」`只许留在 schema 的映射里；`「到货日」`任何地方都不许有映射/引用。
    if (rel !== SCHEMA_REL && /['"]报货日['"]/.test(codeOnly)) {
      offenders.push(`${rel}: 代码里出现「报货日」这个物理列名`);
    }
    if (/['"]到货日['"]/.test(codeOnly)) {
      offenders.push(`${rel}: 代码里出现「到货日」这个物理列名`);
    }
    if (/['"]创建时间['"]/.test(codeOnly)) {
      offenders.push(`${rel}: 旧名「创建时间」还留在代码里（时间列一律不映射）`);
    }
    // 语义键：`createdAt` 只许出现在 schema 定义文件里 —— 别处一出现就是"要碰这一列"。
    if (rel !== SCHEMA_REL && /\bcreatedAt\b/.test(codeOnly)) {
      offenders.push(`${rel}: 用了 createdAt 语义键（会写到自动时间列）`);
    }
  }
  assert.deepEqual(offenders, [], `自动时间列不许有读写点：\n${offenders.join('\n')}`);
});

test('B4 「到货验收.图片」的问题随表一起消失：全仓没有任何换名映射回来的痕迹', () => {
  // 表都删了，`images` / `鞋盒图片` 这些历史映射当然也不许在别处复活。
  const batchNames = Object.values(V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields);
  assert.equal(batchNames.includes('图片'), false, '不许把「图片」映射到「报货批次」');
  assert.equal(batchNames.includes('鞋盒图片'), false, '「鞋盒图片」是更早一版的名字，同样不许出现');
  const allNames = Object.values(V1_BITABLE_SCHEMA.tables)
    .flatMap((table) => Object.values(table.fields || {}));
  assert.equal(allNames.includes('到货日'), false, '「到货日」是自动字段，不许在任何表里建映射');
});

test('B5 「到货验收」表的读写点全清：全仓不再引用这个表键（去注释后扫描）', () => {
  const roots = [
    path.join(SERVER_ROOT, 'src'),
    path.join(SERVER_ROOT, 'public'),
    path.join(SERVER_ROOT, 'scripts'),
  ];
  const files = roots.flatMap((root) => walk(root)).filter((file) => /\.(js|html)$/.test(file));
  const offenders = [];
  for (const file of files) {
    const codeOnly = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([^:])\/\/.*$/gm, '$1');
    const rel = path.relative(SERVER_ROOT, file);
    // ⚠️ 只认**表键**与表 ID 配置，不认同名的 service / 卡片 / 配置模块
    //    （`purchaseArrivalConversationService` / `purchaseArrivalReconcileCard` /
    //      `purchaseArrivalStatus` / `purchaseArrivalIntake` 都还在，它们是"到货核对"这条链路的名字）。
    if (/'purchaseArrival'/.test(codeOnly)) offenders.push(`${rel}: 还在用 purchaseArrival 这个表键`);
    if (/tables\.purchaseArrival\b/.test(codeOnly)) offenders.push(`${rel}: 还在从 schema 取这张表`);
    if (/purchaseArrival\.fields\b/.test(codeOnly)) offenders.push(`${rel}: 还在读这张表的字段`);
    if (/FEISHU_V1_PURCHASE_ARRIVAL_TABLE_ID/.test(codeOnly)) offenders.push(`${rel}: 还在读这张表的环境变量`);
    if (/fields\.images\b/.test(codeOnly)) offenders.push(`${rel}: 读 fields.images`);
    if (/\bimages\s*:\s*\[/.test(codeOnly)) offenders.push(`${rel}: 往 images 写附件`);
    if (/\bimage_count\b/.test(codeOnly)) offenders.push(`${rel}: 还在用 image_count`);
  }
  assert.deepEqual(offenders, [], `已删除的表不许再被读/写：${offenders.join('；')}`);
});

test('B6 ⭐ 同名不同物**不许被误删**：采购申请 PNG 出图器 `this.images.render` 还在', () => {
  // `purchaseWebhookService.this.images` 是「明细 → PNG」的出图渲染器，
  // 名字里带 images，但**跟「到货验收.图片」那个附件列毫无关系**。清读写点时极易误删。
  const source = fs.readFileSync(path.join(SERVER_ROOT, 'src/services/purchaseWebhookService.js'), 'utf8');
  assert.match(source, /this\.images = options\.images \|\| \{ render: renderPurchaseRequestPng \}/,
    '出图渲染器的默认实现必须还在');
  assert.match(source, /await this\.images\.render\(/, '出图的调用点必须还在');
});

test('B7 工作台采购页：到货面板改读「报货批次」，列 = 到货状态 / 确认状态 / 验收原话', () => {
  const rel = 'public/workbench/features/purchase/index.js';
  const source = fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
  assert.match(source, /到货验收情况/, '子标签保留（这是"这一批到货了没有、核对确认了没有"的面板）');
  assert.match(source, /没有匹配的到货验收记录/);
  // 新列（到货信息的落点在批次行上）。
  assert.match(source, /验收原话/);
  assert.match(source, /到货状态/);
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
  // ⚠️ 不再显示「到货日」：批次行上那一列是飞书自动的**更新时间**，不是真的到货时刻
  //    （写附件等动作也会刷新它）——拿它当"到货日"展示会误导。
  assert.equal(codeOnly.includes('到货日'), false, '「到货日」是自动的更新时间 → 面板不展示它');
  // ⚠️ 「到货验收」那张表已被删除 ⇒ 那张**表单**的快捷入口也不许再留在页面上（点了打不开）。
  assert.equal(codeOnly.includes('登记到货与验收情况'), false, '被删表的表单入口要摘掉');
});

test('B8 工作台查询接口：到货面板的数据来自「报货批次」，不再有 purchaseArrival 读点', () => {
  const rel = 'src/services/purchaseQueryService.js';
  const source = fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
  assert.equal(/'purchaseArrival'/.test(codeOnly), false, 'listPurchaseArrivals 必须改读「报货批次」');
  assert.match(codeOnly, /gateway\.listAll\('purchaseOrderBatch'\)/);
  // 投影出来的新字段（前端就靠这三个 + 批次号）。
  for (const key of ['arrival_status', 'confirm_status', 'acceptance_text']) {
    assert.ok(codeOnly.includes(key), `投影里必须有 ${key}`);
  }
});
