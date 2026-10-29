'use strict';

const { readFlag, readInt, readString } = require('./envValue');

/**
 * 工作台「销售 → 订单列表 → **草稿单**」的全部可配参数 —— **配置先行**。
 *
 * 业务口径（一句话）：
 *   扫码销售页上"本单已加 N 双、还没点提交"的那份东西 = **本地中间态**，
 *   它**只存在** `data/scan_sessions/`（`services/scanSessionService.js` 的存储）。
 *   工作台草稿箱**只读这一份、只清这一份**，**一个字都不写业务表 / 飞书 Base**。
 *
 * 🔴 为什么这些值不写进 `config/scanWrite.js`：
 *   · 那一份是**扫码入口**的写参数（能写什么 / 幂等键长什么样）；
 *   · 这一份是**工作台读侧**的参数（列什么 / 怎么显示 / 能不能清 / 能不能回到扫码页）；
 *   · 两份的"变"的节奏不同 ⇒ 分开，各自换值不用改对方的文件。
 *
 * ⚠️ 会话目录 / TTL 这些**不在这里抄第二份**：真源仍是 `config/scanWrite.js` 的 `SESSION`
 *   （草稿箱读的是同一个目录、同一个过期判据 ⇒ 两边永远一致）。
 */

/** 草稿箱本身。 */
const BOX = Object.freeze({
  // 显式布尔（`readFlag`：清空 / 写 false 就是**真关掉**，不做 `||` 兜底那种"关不掉"的写法）。
  enabled: readFlag(process.env, 'SCAN_DRAFT_BOX_ENABLED', true),
  // 一次最多列几份草稿（防"一个地址积累了几百份"把页面撑爆）。按"最后更新"倒序取前 N 份。
  maxDrafts: readInt(process.env, 'SCAN_DRAFT_BOX_MAX', 20, { min: 1, max: 200 }),
  // 草稿里的货品行最多显示几条（其余的用"还有 N 条"一句人话带过；**不截断数据**，只是不铺满屏）。
  maxItemLines: readInt(process.env, 'SCAN_DRAFT_BOX_ITEM_LINES', 3, { min: 1, max: 20 }),
  // 草稿回到扫码页时落在哪个领域（销售）。
  // ⚠️ 这是**扫码页的领域 id**（`views/scanPageRealm.js` 的 REALMS 里的 `sales`），
  //   不是"工作台的销售 tab"；把它做成配置是为了哪天领域 id 改了不用动逻辑。
  resumeRealm: readString(process.env, 'SCAN_DRAFT_BOX_RESUME_REALM', 'sales'),
});

/**
 * 草稿的**状态**（草稿箱里只显示这三类；**不新造业务状态** —— 它们都由既有字段推出来）。
 *
 *   · `draft`      —— 还没提交的"本单"（`sale.lines` 有货、没有写库进度）
 *   · `in_flight`  —— **上次写库没写完**（会话里已经有主表 record_id / 单号 / 待提交资金入参）
 *                     ⚠️ 这一类**既不能继续编辑、也不能清空**：
 *                        · 清空会把"已经建出来的主表进度"丢掉 ⇒ 再提交就是**两张单**（一笔货两条账 ✗）
 *                        · 继续编辑 = 让扫码页在她眼前这份草稿上加货（会复位写库进度，同样有重复建单面）
 *                     ⇒ 只如实显示「写入未完成」+ 指路（她本来就有工作台的"未完成，可点重试"入口）。
 *   · `expired`    —— 本地会话已过期（`expires_at` 过了）。
 *                     ⚠️ **只给清空、不给继续编辑**：过期后扫码页 `revive` 会保留行，
 *                       但超过 `staleDraftMs`（24h）又会**静默丢行** ⇒ 给了入口反而误导她。
 */
const STATUS = Object.freeze({
  draft: Object.freeze({
    code: 'draft',
    label: '未提交',
    tone: 'warning',
    resumable: true,
    clearable: true,
  }),
  inFlight: Object.freeze({
    code: 'in_flight',
    label: '写入未完成',
    tone: 'danger',
    resumable: false,
    clearable: false,
  }),
  expired: Object.freeze({
    code: 'expired',
    label: '已过期',
    tone: 'muted',
    resumable: false,
    clearable: true,
  }),
});

/** 货品行类型的人话（`line.kind` 来自既有 `config/sellableKinds`；认不出的不猜）。 */
const LINE_KINDS = Object.freeze({
  shoe: '鞋',
});

/** 用户可见文案（渲染层不写死句子；占位符 `{...}` 由渲染层 `fillText` 填）。 */
const TEXTS = Object.freeze({
  heading: '草稿单',
  loading: '正在读取草稿…',
  empty: '没有未提交的草稿',
  emptyHint: '在扫码页上「加入本单」、还没点提交的那一单会出现在这里。',
  failed: '草稿读取失败',
  // 损坏的本地草稿文件：**只给一条提示、不删文件**（解析不了的归属不可知 ⇒ 不能替别人删）。
  corrupt: '有 {count} 份本地草稿文件读不出来（不影响其它草稿，已跳过）',
  count: '{count} 份未提交的草稿',
  orderNo: '销售单号',
  noOrderNo: '还没生成单号',
  items: '货品',
  itemCount: '共 {count} 双',
  itemMore: '还有 {count} 条',
  total: '总金额',
  updatedAt: '最后更新',
  continueEdit: '继续编辑',
  clear: '清空',
  clearing: '正在清空…',
  clearDone: '已清空这份草稿（只清本地记录，没有动业务表）',
  clearConfirm: '清空这份草稿？本单里已加的东西会一起清掉，不会写业务表。',
  inFlightHint: '这单上次写到一半没写完：去订单列表找那一单点「重试」，别在这里清。',
  expiredHint: '这份草稿已过期（超过 {hours} 小时没动），只能清掉重扫。',
  noResumeTarget: '这份草稿里没有可打开的货品，先清掉重扫。',
  resumeFailed: '没能打开这份草稿，请回扫码页重新扫。',
  back: '← 返回订单列表',
});

/** 日志/接口的错误码（**页面文案另给**，错误码只给前端判断与日志）。 */
const CODES = Object.freeze({
  disabled: 'draft_box_disabled',
  notFound: 'draft_not_found',
  inFlight: 'draft_in_flight',
  expiredNotResumable: 'draft_expired',
  noResumeTarget: 'draft_without_product',
});

const SCAN_DRAFT_BOX = Object.freeze({
  box: BOX,
  status: STATUS,
  lineKinds: LINE_KINDS,
  texts: TEXTS,
  codes: CODES,
});

module.exports = { SCAN_DRAFT_BOX, DRAFT_BOX_STATUS: STATUS, DRAFT_BOX_TEXTS: TEXTS, DRAFT_BOX_CODES: CODES };
