/**
 * ⭐⭐ **领域内扫一扫**（业务负责人 2026-10-16 14:32 / 14:38 逐字）：
 *
 *   「和我们**四个领域在同一行的那个「扫一扫」**，它是一个**全局的扫一扫**，从这里扫可以
 *     **切换到全局**。但是我们在**补货、销售还有退货**这里「**再加一单**」的时候，
 *     它**实际上也是扫一扫**。不过这里的扫一扫，比方说是**点击了退货里面的扫码「再加一单」**，
 *     那扫完之后，就是**直接放到退货里面的货品**」
 *   ＋「**加一单改为这个领域的扫一扫，与全局扫一扫不同**」
 *
 * ⇒ 两种扫一扫**只有一处区别**（**不加第二套** ✗）：
 *   · 领域条那颗（`config/scanPage.js` 的 `SCAN_NEXT.applink`）= **全局**：扫完落**默认 / 记忆领域** ✓ 行为不变 ✗；
 *   · 补货 / **销售** / 退货 表单里那颗「＋ 再加一个货品」= **带【当前领域】上下文** ✓：
 *     ⭐⭐ 2026-10-16 21:1x **成对迁移（补上「销售」这一条）**：
 *       改前逐字：这一行只写「补货 / 退货」，且下面 `DEFAULT_REALM_CHAINS` 里**没有 `sales`**
 *         （当时那段注释自己写着：「**销售那一页的「加入本单」是另一套**（`session.sale.lines` ✓
 *           没有多货品草稿块）⇒ 这里没有 sales（如实，不是漏配 ✗）」）；
 *       改后逐字：**三个领域都在**（`sales: 'sales'` ＋ 这一行写全）。
 *       依据 = 业务负责人 **2026-10-16 21:1x 弹窗拍板「要，销售也弹扫码框」** ✓
 *         ＋ 同一天 14:32 她逐字「**补货 / 销售 / 退货**里那颗『＋ 再加一个货品』**实际上也是扫一扫**」✓。
 *       ⚠️ **销售那一套仍是它自己那一套** ✗：加货仍走既有 `action=add_line` ⇒ `addSaleLine`
 *         ⇒ `session.sale.lines`（本卡**不新造写入口** ✗）；本卡只补"加货成功之后接着扫"这一个动作 ✓。
 *     点一下 ⇒ 先把当前这一件存进**本领域**的本单草稿（复用既有 `multi_item_add` 那一路 ✓）
 *     ⇒ 再**在同一个领域页上**调起飞书**原生扫一扫**（复用既有 `services/larkJsapiService.js` 那套签名 ✓）
 *     ⇒ 扫到的那件**落回原领域**（`?from=<领域>` ✓ `views/scanPageRealm.js` 的 `resolveRealm` 读懂它 ✓）。
 *
 * 🔴 **三条边界（逐条做到）**：
 *   ① **不加第二套** ✗：扫码仍走既有 `larkJsapiService`（与工作台「扫码打印」同一套）＋
 *      本单暂存仍走既有 `routes/scanPage.js` 的 `readMultiItemPending` / `writeMultiItemPending` ✓；
 *   ② **配置先行** ✓：开关 / 触发参数 / 签名端点 / **领域 → 链路**映射 / 文案 全在这里 ——
 *      逻辑里**一个汉字、一个路径都不写死** ✗（渲染层与脚本都不许散写 ✗）；
 *   ③ **新行为挂显式开关**：**缺省开** ✓（业务负责人 2026-10-16 弹窗选「打开」；
 *      改配置即可关 ⇒ 配 `'false'` / 空串 = 关 ✓ `readFlag` 显式布尔，认不出的值当场抛 ✗ ——
 *      不是 `|| fallback` 那种"清空变量就关不掉"的形状 ✗）——
 *      **关着 = 页面与今天逐字节一致**（不发脚本、不发那个隐藏的配置块 ✓ `AC-ML5`）。
 *
 * ⚠️ **为什么单独一个文件**（不并进 `config/multiItemOrder.js` / `config/scanPage.js`）：
 *   这一份是"**领域页怎么调起飞书扫一扫**"的参数（扫码那一侧），而
 *   `multiItemOrder.js` 管的是"一单多货怎么落库"、`scanPage.js` 管的是"这一页长什么样" ——
 *   **一件一件事**（她定的模块化 ✓）。改扫码手段不该动落库那两份 ✓。
 */

const { readFlag, readInt, readString } = require('./envValue');
// 路径段的**唯一真源**仍是扫码页那一份（`/r` ✓ 这里只读它、不另写一份 ✗）
const { SCAN_PAGE } = require('./scanPage');

/**
 * 领域 id → `config/multiItemOrder.js` 的**链 id**。
 * 取值必须是 `views/scanPageRealm.js` 的领域 id（认不出的领域 ⇒ 页面上**不发**这个入口 ✓ 不猜 ✗）。
 *
 * ⭐⭐ 2026-10-16 21:1x **成对迁移（`sales` 这一格）**：
 *   改前逐字：
 *     ```
 *     // 🔴 只有**真有本单草稿的链**才在这里（补货 / 退货）—— 销售那一页的「加入本单」是**另一套**
 *     //   （`session.sale.lines` ✓ 没有多货品草稿块），所以这里**没有 sales** ✓（如实，不是漏配 ✗）。
 *     const DEFAULT_REALM_CHAINS = Object.freeze({
 *       replenish: 'replenish',
 *       purchase_return: 'return',
 *     });
 *     ```
 *   改后逐字：下面这一份（多一格 `sales: 'sales'`）＋ 这一段说明。
 *   依据 = 业务负责人 **2026-10-16 21:1x 弹窗拍板「要，销售也弹扫码框」** ✓
 *     ＋ 同一天 14:32 逐字「**补货 / 销售 / 退货**里那颗『＋ 再加一个货品』**实际上也是扫一扫**」✓。
 *   ⚠️ 链 id 取 **`sales`** —— 它是 `config/multiItemOrder.js` 的 `chains.sales`
 *     （**既有**那条纯描述链；`orderKeyPrefix` = 既有 `SCAN_SALE_KEY_PREFIX` ✓）——
 *     **不是我发明的名字** ✗，也不是新链路 ✓。
 *   ⚠️ **不是放宽**：认不出的领域照旧"不发这个入口"（不猜 ✗）；`SCAN_REALM_SCAN_CHAINS`
 *     一配就以它为准（缺省串只是把 `sales` 一起写上 ✓）。
 */
const DEFAULT_REALM_CHAINS = Object.freeze({
  replenish: 'replenish',
  purchase_return: 'return',
  sales: 'sales',
});

const resolveRealmChains = (env) => {
  // 形状：`replenish:replenish,purchase_return:return,sales:sales`
  //   （空串 = 没有领域能用 ⇒ 这个入口整块不发 ✓）
  // ⚠️ 缺省串与 `DEFAULT_REALM_CHAINS` **必须同一个集合**（两处不一致 ⇒ 配了空串时行为会与读代码的人以为的不同 ✗）。
  const raw = readString(env, 'SCAN_REALM_SCAN_CHAINS',
    'replenish:replenish,purchase_return:return,sales:sales');
  const out = {};
  for (const pair of String(raw || '').split(',')) {
    const [realm, chain] = String(pair || '').split(':').map((part) => String(part || '').trim());
    if (!realm || !chain) continue;
    out[realm] = chain;
  }
  return Object.freeze(Object.keys(out).length ? out : { ...DEFAULT_REALM_CHAINS });
};

/**
 * 解析一份配置（**每次调用都重新读 env** ⇒ 用例可以传不同的 env 验"改配置即改行为" ✓）。
 * @param {object} [env] 默认 `process.env`
 */
const createRealmScanConfig = (env = process.env) => Object.freeze({
  // 🔴 **总开关**：缺省 **开** ✓。
  //   依据 = **业务负责人 2026-10-16 弹窗选「打开」**（原话：「要不要现在打开？」⇒ 她选「打开」✓）——
  //   她的口径是「补货 / 销售 / 退货里那颗『＋ 再加一个货品』实际上也是扫一扫，在退货里点 ⇒
  //   扫完直接放到退货里的货品」（同一天 14:32 逐字 ✓）；全局那颗（领域条「扫一扫」）行为不变 ✗。
  //   ⚠️ **仍是 `readFlag` 显式布尔**（不是 `|| fallback` 那种关不掉的写法 ✗）：
  //     配 `'false'` / `'0'` / `'no'` / `'off'` ⇒ **关** ✓（**关得掉** ✓）；空串 = 关；
  //     认不出的值当场抛 ✗。**关着 = 页面与今天逐字节一致**（`AC-ML5` 那条 508,317 字节 ✓）。
  enabled: readFlag(env, 'SCAN_REALM_SCAN_ENABLED', true),
  // 「点完了接着扫」那个查询键：路由在**加货成功之后**303 回本页带上它，页面上的脚本才去调扫一扫。
  //   ⚠️ 只有它出现在 URL 上才会扫（**页面一加载就弹相机**那种 "点了没反应/乱弹" 的坑 ✗）。
  triggerQueryKey: readString(env, 'SCAN_REALM_SCAN_QUERY_KEY', 'scan'),
  triggerQueryValue: readString(env, 'SCAN_REALM_SCAN_QUERY_VALUE', '1'),
  // 飞书 JSAPI 签名端点（挂在本 router 下 ⇒ 复用既有一整道身份闸门 ✓ **不新开鉴权** ✗）。
  signaturePath: readString(env, 'SCAN_REALM_SCAN_SIGNATURE_PATH', '/lark/jsapi-signature'),
  // 扫完那件落回本领域用的查询键（**必须是 `resolveRealm` 读的那个**：`?from=` ✓ 不新造 ✗）。
  realmQueryKey: readString(env, 'SCAN_REALM_SCAN_REALM_QUERY_KEY', 'from'),
  // 「扫到的是**记录 ID / 编号**（不是完整网址）」时，用**哪一段路径**拼地址
  //   —— 默认直接读扫码页那一份（`SCAN_PAGE.route.recordBasePath` = `/r` ✓ **同一个真源** ✗ 不另写）。
  recordBasePath: readString(env, 'SCAN_REALM_SCAN_RECORD_BASE_PATH', SCAN_PAGE.route.recordBasePath),
  // 认不出来 / 空的扫码结果最多写进 URL 的长度（防异常长串进日志与 URL ✗）。
  maxScannedLength: readInt(env, 'SCAN_REALM_SCAN_MAX_LENGTH', 512, { min: 32, max: 4096 }),
  // 引入 JSSDK / config / ready / scanCode 各自的等待上限（**每一处都不许无限等** ✗ ——
  //   她最恨"点了没反应"；超时一律给人话 ✓）。
  sdkTimeoutMs: readInt(env, 'SCAN_REALM_SCAN_SDK_TIMEOUT_MS', 8000, { min: 500, max: 60000 }),
  scanTimeoutMs: readInt(env, 'SCAN_REALM_SCAN_TIMEOUT_MS', 120000, { min: 5000, max: 600000 }),
  // 领域 → 链（**三个领域各有各的本单草稿** ✓ 见上面 `DEFAULT_REALM_CHAINS`：
  //   补货 / 退货走多货品草稿，销售走它自己的 `session.sale.lines` —— **落点不同，入口同一个** ✓）。
  realms: resolveRealmChains(env),
  // 全部用户可见文案（渲染层 / 脚本都不许散写中文 ✗；脚本拿到的是**这一份的 JSON** ✓）。
  texts: Object.freeze({
    scanning: '正在打开飞书的「扫一扫」…扫下一个货品的标签，它就会加进这一单。',
    // 调不起扫一扫（电脑 / 普通浏览器 / 没装）⇒ **明说 + 给出路**，绝不留一个点了没反应的按钮 ✗
    noSdk: '这台设备调不起飞书扫一扫：请在飞书里打开这一页，再点一次「＋ 再加一个货品」。',
    cancelled: '取消了扫码：这一件没有加进来，可以再点一次。',
    failed: '扫码没有成功，请再点一次「＋ 再加一个货品」。',
    timeout: '飞书扫一扫没响应（超时了）：请退出这一页重进再试一次。',
    empty: '没有扫到内容：请对着货品标签上的二维码再扫一次。',
    // 只读上报失败时的那句人话（**上报失败不影响她** ✓ 但要说一句，不然日志里查不到 ✗）
    reportFailed: '（这次的扫码结果没报上来，工程师那边可能查不到）',
  }),
});

/** 默认那一份（进程级；跟 `process.env` 走）。 */
const REALM_SCAN = createRealmScanConfig();

/**
 * ⭐⭐ **扫到的那一件落回本领域** —— 把"扫到的那串"变成"这一领域那一页"的地址。
 *
 * 规则（**与全局那颗的唯一区别就是它**：`?from=<领域>`）：
 *   · 扫到的是**完整网址**（新二维码 = `https://hm.bamamei.online/r/{记录ID}` ✓）⇒
 *     只**追加 / 覆盖** `from=<领域>` 这一个查询键（路径与别的键**一个字不动** ✗）；
 *   · 扫到的是**记录 ID / 编号**（手输、某天别的码）⇒ 用**配置里那一段路径**
 *     （`recordBasePath` = `/r` ✓ **不写死** ✗）在当前域名下拼一个同源地址 ＋ `from=<领域>`；
 *   · 认不出来（空串 / 带空格或 `?` `#` 的怪串）⇒ **空串**（宁可不跳，也不乱跳 ✗）。
 *
 * 🔴 `from` 的**键名在配置里**（`realmQueryKey` ✓），读它的那一位是**既有**
 *   `views/scanPageRealm.js` 的 `resolveRealm`（**规则不在两边各写一份** ✗）。
 * 🔴 这一段逻辑**与浏览器里那一段逐字同一实现**（`views/scanRealmScan.js` 把它内联进页面 ✓）——
 *   所以这里能**在 Node 里直接测**（不必真机 ✓ 不必假 DOM ✓）。
 *
 * @param {object} input
 * @param {string} input.scanned 扫到的原始字符串
 * @param {string} input.realm 当前领域 id
 * @param {string} [input.origin] 当前页面来源（例：`https://hm.bamamei.online`）—— 只在"扫到的是 id"时用
 * @param {object} [input.config] 默认 `REALM_SCAN`（测试可注入 ✓）
 * @returns {string} 地址（认不出来 = 空串）
 */
const realmScanUrlFor = ({ scanned, realm, origin = '', config = REALM_SCAN } = {}) => {
  const key = String((config && config.realmQueryKey) || 'from');
  const wantedRealm = String(realm || '').trim();
  const raw = String(scanned || '').trim().slice(0, Number(config?.maxScannedLength) || 512);
  if (!raw || !wantedRealm) return '';
  const withRealm = (url) => {
    const text = String(url || '');
    if (!text) return '';
    const hashAt = text.indexOf('#');
    const head = hashAt >= 0 ? text.slice(0, hashAt) : text;
    const hash = hashAt >= 0 ? text.slice(hashAt) : '';
    const queryAt = head.indexOf('?');
    const base = queryAt >= 0 ? head.slice(0, queryAt) : head;
    const pairs = (queryAt >= 0 ? head.slice(queryAt + 1) : '')
      .split('&')
      .filter((part) => part && part.split('=')[0] !== key);
    pairs.push(`${key}=${encodeURIComponent(wantedRealm)}`);
    return `${base}?${pairs.join('&')}${hash}`;
  };
  // ① 完整网址（新二维码就是它）⇒ 只加/换一个查询键，**路径一个字不动** ✓
  if (/^https?:\/\//i.test(raw)) return withRealm(raw);
  // ② 记录 ID / 编号 ⇒ 用**配置里那一段路径**在本页域名下拼（**不写死** ✗）
  const mount = String((config && config.recordBasePath) || '').trim().replace(/\/+$/, '');
  const base = String(origin || '').trim().replace(/\/+$/, '');
  const id = raw.replace(/^\/+/, '');
  if (!mount || !base || !id || /[?#\s]/.test(id)) return '';
  return withRealm(`${base}${mount}/${encodeURIComponent(id)}`);
};

module.exports = {
  createRealmScanConfig,
  REALM_SCAN,
  DEFAULT_REALM_CHAINS,
  realmScanUrlFor,
};

