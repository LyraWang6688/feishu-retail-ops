// 回归测试：app.js 必须**先把 .env 灌进 process.env，再 require 任何业务模块**。
//
// 【为什么要有这个用例】2026-10-06 线上事故的根因就是这条顺序被破坏：
//   #88 在 app.js 最上面加了 `require('./services/secondDeliveryService')`，
//   而 `dotenv.config(...)` 留在第 19 行。于是 require 链
//     secondDeliveryService → v1BitableGateway → config/v1BitableSchema
//   在 **dotenv 之前**就跑完了。v1BitableSchema 里的
//     `tableId: getEnv('FEISHU_V1_SIZE_TABLE_ID')`
//   是**模块级对象字面量里的求值**：require 那一刻取一次，之后就永远是那个值、
//   **再也不重算**（同一份 schema 里 `appToken` 写成 getter，所以只有它没事）。
//   坏在 schema 里唯二**没有硬编码兜底**的表正好是「尺码管理」和「其他配品」，
//   于是它们的 tableId 被冻结成空串 → 请求打到 `.../tables//records`
//   → 飞书回 404 `404 page not found` → 采购退货核对整条链路静默失败，
//   而其它表因为有默认值照常工作，现象看起来"只有某一个功能坏了"。
//
// 【这个用例测的是"顺序"本身，不是某一个表 ID】
//   · 用 stub 顶掉 dotenv.config：CI 上没有 .env，而**绝不允许**为了测试
//     在仓库根目录写一个 .env（会覆盖/污染真实配置，属于红线）。
//   · stub 记录两件事：被调用时传的 path、以及那一刻 v1BitableSchema
//     是否**已经在 require 缓存里**——后者就是顺序的直接证据。
//   · 最后断言没有兜底的那两张表真的取到了 fixture 里的值。
//
// 修好之前（schema 先被 require）：schemaLoadedAlready=true 且 tableId='' → 红。
// 修好之后（先 dotenv 再 require）：schemaLoadedAlready=false 且 tableId 有值 → 绿。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const APP_PATH = require.resolve('../src/app.js');
const SCHEMA_PATH = require.resolve('../src/config/v1BitableSchema');

// 假装这就是仓库根目录那份 .env 的内容。
// 注意：只放**必须由 .env 提供**的值，不要放"有硬编码兜底"的表 ID——
// 那些即使 .env 没加载也能取到值，放进来会掩盖顺序问题。
const FIXTURE_ENV = {
  // app.js 在 require 阶段就会 new LarkMvpService → 取飞书凭证，缺了会当场抛错。
  // 这两项和本用例要钉的顺序无关，只是让 app.js 能被 require 进来。
  LARK_AGENT_APP_ID: 'cli_fixture_dotenv_order',
  LARK_AGENT_APP_SECRET: 'secret_fixture_dotenv_order',
  // 受测目标：schema 里唯二没有默认值的 tableId。
  FEISHU_V1_SIZE_TABLE_ID: 'tbl_fixture_size',
  FEISHU_V1_ACCESSORY_TABLE_ID: 'tbl_fixture_accessory',
};

test('app.js 必须在 require 任何业务模块之前把 .env 灌进 process.env', () => {
  const saved = new Map(Object.keys(FIXTURE_ENV).map((key) => [key, process.env[key]]));
  const configCalls = [];
  const dotenv = require('dotenv');
  const originalConfig = dotenv.config;

  // 先把这几项从当前进程环境里清掉。否则"shell 里本来就有"会让用例失去意义：
  // dotenv 默认不覆盖已存在的变量，schema 照样能取到非空值，红绿都测不出来。
  for (const key of saved.keys()) delete process.env[key];

  dotenv.config = (options = {}) => {
    configCalls.push({
      path: options.path,
      // 顺序证据：dotenv 被调用的这一刻，schema 模块是否**已经**被 require 过了。
      schemaLoadedAlready: Boolean(require.cache[SCHEMA_PATH]),
    });
    const parsed = {};
    for (const [key, value] of Object.entries(FIXTURE_ENV)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        parsed[key] = value;
      }
    }
    return { parsed };
  };

  try {
    require(APP_PATH);
  } finally {
    // app.js 已经用完 dotenv，立刻还原，避免影响本进程里后续代码。
    dotenv.config = originalConfig;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  // ① 顺序：dotenv.config 必须被调用，而且第一次调用时 schema 还没进 require 缓存。
  assert.ok(configCalls.length >= 1, 'app.js 应当调用 dotenv.config（它是 .env 的唯一加载点）');
  assert.equal(
    configCalls[0].schemaLoadedAlready,
    false,
    'dotenv.config 执行时 v1BitableSchema 已经被 require 了：'
    + 'schema 的 tableId 是模块级求值、之后永不重算，没有兜底的表会永久拿到空串',
  );
  // .env 必须是仓库根目录那一份，别悄悄换位置。
  assert.equal(path.resolve(configCalls[0].path), path.resolve(__dirname, '../../.env'));

  // ② 结果：没有硬编码兜底的两张表真的取到了 .env 里的值。
  const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
  assert.equal(V1_BITABLE_SCHEMA.tables.sizeManagement.tableId, FIXTURE_ENV.FEISHU_V1_SIZE_TABLE_ID);
  assert.equal(V1_BITABLE_SCHEMA.tables.accessory.tableId, FIXTURE_ENV.FEISHU_V1_ACCESSORY_TABLE_ID);

  // ③ 顺手排"第二颗雷"：只要 fixture 覆盖了所有**没有默认值**的变量，
  //    就不该再有任何一张表留下空 tableId。将来有人新增一张表却忘了兜底，
  //    或者忘了把这里补全，都会在 CI 上直接红，而不是等到线上 404。
  for (const [key, table] of Object.entries(V1_BITABLE_SCHEMA.tables)) {
    assert.notEqual(
      String(table.tableId || '').trim(),
      '',
      `表「${table.tableName}」(${key}) 的 tableId 为空：它既没有硬编码默认值，`
      + '也没有在 fixture 里提供对应的 FEISHU_V1_*_TABLE_ID',
    );
  }
});
