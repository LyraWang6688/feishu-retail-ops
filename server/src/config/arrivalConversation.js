/**
 * 「采购到货：群话题对话式核对」的**行为配置**（开关 / 阈值 / 文案 / 编码）。
 *
 * 为什么单独一个配置文件（而不是把常量塞进 service）：
 *   AGENTS.md《底层工程原则》要求「阈值 / 开关 / 字段映射 / 行为编码一律可配」，
 *   换一个值不该改代码。这里放的就是那些值。
 *
 * ⚠️ 本文件只放**配置**，不放业务逻辑；三段差异的解析提示词在
 *   `services/doubaoService.js`（和销售录单、采购数量说明一样，提示词属于模型那一层的实现）。
 *
 * ⚠️ 与已退场的「拍照识别到货」**没有任何耦合**：
 *   不复用 `PURCHASE_ARRIVAL_INTAKE_ENABLED`（那个模块现在没有读取点、语义是"图片入口"），
 *   本流程用自己的开关，那条链路明天再退场也影响不到这里。
 */

// 卡片上的两个动作名。
//
// ⚠️ **刻意不复用**被删掉的 `confirm_purchase_arrival` / `cancel_purchase_arrival`：
//   线上可能还有历史到货卡片没点过，它们的 draft_id 指向的是旧任务；沿用同名动作
//   会让那些老卡片的点击落到这条新链路上（点一下就按旧任务入库），这是"复活残骸"。
//   另起名字之后，老卡片点了只会找不到分派，什么都不会发生（保持退场状态）。
const ARRIVAL_CONVERSATION_ACTIONS = Object.freeze({
  CONFIRM: 'confirm_arrival_reconcile',
  REJECT: 'reject_arrival_reconcile',
  // ⭐ 2026-10-08：卡片上那个「表单填写 + 提交」（业务负责人 2026-10-07 深夜定的口径）。
  //    与上面两个动作名同一个道理：**卡片渲染与分派共用这一份常量**，不会各写一份而慢慢写歪。
  //    它由表单容器里的提交按钮（`action_type: "form_submit"`）带回来，
  //    回调里还多一个 `form_value`（表单项 name → 值）。
  SUBMIT: 'submit_arrival_reconcile',
});

// ⭐⭐ 到货核对卡片上的「表单填写 + 提交」（业务负责人 2026-10-07 深夜定，逐字）：
//   「我们的消息卡片是否支持**输入一段文字**？……等到货之后，**请在卡片里填写实际到货情况**。
//    也就是给到用户卡片，**用户填写内容之后，再点击提交**。以这个来作为**触发后续的到货验收**」
//
// 🔴 官方硬约束（curl 实查，原文见 `docs/arrival-card-form-input-2026-10-08.md` 第 0 节）：
//   ① 输入框**必须**与按钮**一起内嵌进「表单容器」**（`tag:"form"`）—— 官方原文；
//   ② 表单容器**只能放在卡片根节点**下，不可被内嵌在其它组件内；
//   ③ 表单内每个交互组件都要有 `name`，且**在卡片全局内唯一**（否则飞书报 200530、数据发不出去）。
// ⚠️ 输入框只在飞书 **V6.8+** 有（表单容器 V6.6+）⇒ 低版本走 `fallback` 降级文案，
//    而且**「在话题里说话」那条老路必须一直留着**（见 `handleTopicMessage`）。
// ⚠️ 这里只放**结构参数与用户可见文案**：换文案 / 换 name / 换占位符都不用改代码。
const ARRIVAL_FORM_DEFAULTS = Object.freeze({
  // 表单容器的唯一标识（官方：同一张卡片内全局唯一）。
  containerName: 'arrival_reconcile_form',
  // 输入框：`name` 就是回调里 `form_value` 的**键**（官方示例 `"Input_lf4fmxwfrd9": "1234"`）。
  fieldName: 'actual_arrival',
  // 多行文本（官方 `input_type`：`multiline_text`；换行符在回调里以 `\n` 返回）。
  inputType: 'multiline_text',
  rows: 3,
  autoResize: true,
  maxRows: 6,
  maxLength: 1000,
  label: '实际到货情况',
  labelPosition: 'top',
  placeholder: '例：都到了 / XHB8095 黑 38 码少 2 双 / XHB8096 棕 39 码多 1 双',
  // 必填：前端会拦住空提交（提示"有必填项未填写"，**不会**发起回调）；
  // ⚠️ 服务端**仍然自己兜一层空值** —— 重放 / 模拟 / 降级都可能把空串送进来。
  required: true,
  // 低版本客户端（< V6.8）的降级文案。必须是**一句能指路的话**：
  // 老客户端输入框用不了，就照旧在话题里回一句 —— 那条入口一直在。
  fallbackText: '你的飞书版本太低（输入框需 V6.8 以上），直接在话题里回一句实际到货情况就行。',
  // 提交按钮：官方要求绑 `action_type: "form_submit"`，且 `name` 在卡片内全局唯一。
  submitLabel: '提交',
  submitButtonName: 'submit_arrival_reconcile',

  // ⭐⭐ 2026-10-08（业务负责人亲自批准）：「实际金额」—— 表单里**第二个**输入项。
  //   她的原话（逐字）：「**实际金额**：到货确认卡片……现在需要增加一个**单选/填写文本框**，
  //   让用户填写**这一次供应商的金额**，然后我们填到实际金额里面」；
  //   「**金额这个是必填的，必须让用户填，否则点不了按钮**」。
  //
  // 🔴 `amountInputType` 为什么是 `text`（curl 实查，不是猜的）：
  //   官方「输入框」组件文档的 `input_type` **只有三个取值**，**没有任何数字类型**：
  //     「input_type | 否 | String | text | 指定输入框的输入类型。默认为 text，即文本类型。
  //       支持以下枚举值：- text：普通文本 - multiline_text：多行文本…… - password：密码」
  //   出处（`.md?lang=zh-CN` 拿到的纯文本，2026-10-08 实查）：
  //     https://open.feishu.cn/document/feishu-cards/card-components/interactive-components/input.md?lang=zh-CN
  //   ⇒ 按"拿不准就用 `text` 并做服务端数字校验"办：**数字校验在服务端**
  //     （`PurchaseArrivalConversationService` 的金额闸门），不指望卡片能拦非数字。
  //
  // ⚠️ 与「实际到货情况」同一个硬约束：`name` 必填且**卡片全局唯一**（否则飞书 200530）
  //   ⇒ 它与 `fieldName` **必须不同**（默认值 `actual_amount` ≠ `actual_arrival`）。
  amountFieldName: 'actual_amount',
  amountInputType: 'text',
  amountMaxLength: 32,
  amountLabel: '实际金额',
  // 单位写进 placeholder：她说的"这一次供应商的金额"是**整批一个数**，不是每件一个。
  amountPlaceholder: '例：12800 或 12800.50（这一次供应商的金额）',
  // 必填**默认开**（她的口径："否则点不了按钮"）；
  // ⚠️ 官方 `required` 只是**前端**闸门 ⇒ 服务端必须自己再拒一次（见下面 `replies.amount*`）。
  amountRequired: true,
  amountFallbackText: '你的飞书版本太低（输入框需 V6.8 以上），请直接在话题里回一句：实际到货情况 + 这一次的金额。',
});

// 「群消息映射」里的批次类型。定位器只回答"是哪一批"，
// 但**采购申请单和采购退货单共用同一个群话题**（都走 deliverSupplierImages），
// 所以到货核对必须先认出这批单子是哪一种，否则会把退货话题当成到货核对、
// 甚至给退货批次建一条「采购到货」记录。
const ARRIVAL_BATCH_KINDS = Object.freeze({
  PURCHASE_REQUEST: 'purchase-request',
  PURCHASE_RETURN: 'purchase-return',
});

// 三段差异（业务负责人 2026-10-06 定的口径，**只有这三类**：
// 完全一样 / 实际比申请多 / 实际比申请少）。
// ⚠️ 刻意**没有**「实际为 0」这一类 —— 但那是"差异**类型**只有三类"，
//    **不等于**"算出来的**实际数量**不能是 0"。
// ⭐ 2026-10-07 她纠正（逐字）：「**如果这个尺码算下来为 0，那么就不用入库啊！**」
//    ⇒ `实际 = 0` 是**由「少」这条差异算出来的正常结果**（例：申请 1 双、她说少 1 双），
//      该行**不入库、但不阻断整单**；差异**类型**仍然只有下面这三个。
//    口径见 `docs/arrival-zero-arrived-rule-2026-10-07.md`。
const ARRIVAL_DIFF_TYPES = Object.freeze({
  SAME: 'same',
  MORE: 'more',
  LESS: 'less',
});

// ⭐ 「全到」类说法的**保守兜底词组表**（业务负责人 2026-10-07 批准修，逐字：「这个也可以做～」）。
//
// 【为什么有这一层】**真机 2026-10-07 21:52** 她自己在两个话题里各发了一句：
//   · 202610072 话题发「**都到了**」   → 模型 `same:true` → 出卡片 → 确认后入库 12 行 ✅
//   · 202610071 话题发「**都到货了**」 → 模型 `same:false` / `differences:[]`
//     → 撞上 `purchaseArrivalConversationService` 的 `hasArrivalContent` 判据
//     → `purchase.arrival.reconcile.no_arrival_content` → **不出卡片** ❌
//   两句话**意思完全一样**，只多了「货」两个字 ⇒ **说法差异导致的漏判**。
// ⇒ 两层一起上：① 提示词把这些说法显式列成等价（模型层，`services/doubaoService.js`）；
//   ② **这一层就是②：代码侧的兜底** —— 真机那次就是**模型没认出来**，
//      光改提示词挡不住第二次（模型不是确定性的）。
//      ⭐ 一句话：**这是为了兜住模型的漏判**，不是新业务规则。
//
// ⚠️ 这**不是**关键词匹配业务：它只在**模型什么都没给出来**（`same !== true` 且
//   `differences` 为空）时补一句"这是全到"，绝不覆盖模型给出的任何具体结论。
//
// 🔴 **绝不放宽"有具体内容"的情形**（判据一个字不动，只让"全到"的说法被认出来）：
//   · 只有**整句**（去空白/标点后）能被下面这些词**完整切分**才算"裸的全到说法"；
//   · 句子里出现**数字 / 中文数量字 / 单位 / 货号**（`concreteContentPattern` ＋ `numberWords`
//     ＋ `quantityUnitWords`）→ 一律不兜底；
//   · 出现**否定**（`negationWords`）或**疑问**（`questionMarkers`）→ 一律不兜底；
//   · 清单外的任何字 → 一律不兜底。
//   ⇒ 「到了 2 双」「8230 到了 1 双」「还有一双没到」**必须**仍走原来的差异比对/追问 ——
//      被这层吞掉就会按申请数**整单入库**，那是写错账。
const ARRIVAL_ALL_PRESENT_PHRASES = Object.freeze({
  // 「全 / 都 / 齐」这一族 = "整批全到"的意思标记（至少出现一个才算"全到"）。
  completeWords: Object.freeze(['全部', '整批', '全都', '全齐', '收齐', '全', '都', '到齐', '齐']),
  // 「到」这一族 = 到货动词（至少出现一个）。
  // ⚠️ `到齐` / `全齐` / `收齐` / `齐` 同时属于两族：它们本身就同时表达了"到"和"齐"。
  arrivalWords: Object.freeze(['到齐', '到货', '收到', '到了', '来了', '全齐', '收齐', '齐', '到']),
  // 允许多出来的语气 / 收尾词（**不含任何数量信息**；「完毕」是她说过的旧收尾话术）。
  fillerWords: Object.freeze(['已经', '完毕', '了', '啦', '呢', '啊', '哦', '呀', '嘛', '哈']),
  // 出现这些 → 不兜底（她在说"没到 / 还差 / 缺"）。
  negationWords: Object.freeze(['没', '未', '不', '少', '差', '缺', '剩', '退', '漏', '空']),
  // 出现这些 → 不兜底（那是**问句**，不是"到货反馈"）。
  // ⚠️ 刻意**不含**「吧」：带了它就分不清"都到了吧？"是陈述还是发问，宁可交给模型。
  questionMarkers: Object.freeze(['?', '？', '吗']),
  // 中文数字 / 数量字（有它们就是"有具体数量"）。
  numberWords: Object.freeze(['零', '一', '二', '两', '三', '四', '五', '六', '七', '八', '九', '十', '半', '几']),
  // 数量单位（「双」是鞋的业务单位；货号里通常还有阿拉伯数字/字母 → 见下面那条正则）。
  quantityUnitWords: Object.freeze(['双', '个', '件', '只', '箱', '码', '号', '款', '色', '对']),
  // 阿拉伯数字 / 拉丁字母（货号形如 XHB8095 / 8230）—— 有它们就是"有具体内容"。
  concreteContentPattern: '[0-9０-９A-Za-z]',
});

const DEFAULTS = Object.freeze({
  enabled: true,
  // 交给模型的原话上限（字符）。超长只截断投喂，本地记录原样保留。
  maxTranscriptChars: 4000,
  // 一批最多核对多少条采购申请明细（防御性上限：异常数据不要打爆提示词）。
  maxRequestRows: 200,
  // 多句原话归集成一个「验收原话」时用的连接符（该字段是单值文本，飞书里没有多值容器）。
  acceptanceTextSeparator: '\n',
  // 卡片文案（用户可见文案一律可配，改文案不碰逻辑）。
  card: {
    title: '本次到货核对完毕，确认入库吗？',
    confirmLabel: '是',
    rejectLabel: '否',
    summaryHeading: '按你说的实际到货',
    hint: '点「是」我就按实际数量入库；点「否」我这次什么都不写。',
    // ⭐ 2026-10-07：算出来 `实际 = 0` 的行**不是错误**（供应商漏发了一整双），
    //    卡片上要让它看得出来是"这双没到"。这两个旋钮就是那两句可见文案。
    zeroActualNote: '这双没到，不入库',
    zeroRowsNote: '标「这双没到」的行我不会入库，也不会写库存流水。',
    // ⭐ 2026-10-07：失败时把那张卡片改成终态时的**标题**（红色 header）。
    //    她连着两次说「卡片点击后没有任何反应」——只弹 toast 不算反馈，
    //    失败必须在**她点的那张卡片上**看得出来。
    // ⚠️ 2026-10-07 晚：表名同步 —— 她当天在生产表把「采购到货」改名「到货验收」，
    //    所以这句话里的表名跟着改（用户可见文案里的旧表名一个都不留）。
    failedTitle: '到货验收核对没成功',
    // ⭐ 2026-10-08（业务负责人逐条批准）：点「否」**也 patch 卡面** ——
    //    她点完必须在那张卡上看见结果（"点击后没有任何反应"那两次投诉的同一个根因）。
    //    标题可配；那句正文复用既有的 `replies.rejected`，不另写一份中文。
    //    ⚠️ 终态卡收掉「是 / 否」两个按钮 ⇒ 改主意要在话题里再说一句（见 rejectLocked 的注释）。
    rejectedTitle: '这次没有入库',
    // ⭐⭐ 2026-10-07 晚（真机 23:37「日志说卡片已更新，她那边一张都没有」）：
    //    出口改成"每次都**在她说这句话的那个话题里重发一张新卡**"之后，
    //    上一张卡要**尽力作废**（收掉「是 / 否」按钮），否则话题里会同时留着两张都能点的卡。
    //    这两句就是那张作废卡上的文案（用户可见文案一律可配）。
    supersededTitle: '这张核对卡片已经作废',
    supersededMessage: '这张上的数量不要用了：我已经按你最新那句话重出一张新卡，**请用最新那张**（它就发在你刚说话的消息下面）。',
    // ⭐⭐ 2026-10-08：「表单填写 + 提交」那块（输入框 / 提交按钮 / 降级文案）。
    //    结构与文案全在 `ARRIVAL_FORM_DEFAULTS`（见文件上半部分的长注释）。
    form: ARRIVAL_FORM_DEFAULTS,
    // ⭐ 空提交时留在**她提交的那张卡上**的那句提醒（表单与它一起留着，她改一句再提交即可）。
    //    只弹 toast 不算反馈 —— 真机已经吃过"只弹 toast = 她什么都没看见"的教训。
    submitMissingNote: '没收到内容：请在上面的输入框里写一句实际到货情况，再点「提交」。',
    // ⭐⭐ 2026-10-08：「实际金额」那两个失败口子留在**她提交的那张卡上**的提醒
    //    （与 `submitMissingNote` 同一个理由：只弹 toast 她看不见）。
    //    ⚠️ 两张卡（`card.*` 这句）与服务端回执（`replies.amount*`）**分开两份文案**，
    //       与既有 `submitMissingNote` / `replies.submitMissing` 的写法一致。
    amountMissingNote: '没收到「实际金额」：请在上面的金额输入框里填一个数字（必填），再点「提交」。',
    amountInvalidNote: '「实际金额」只能填**不小于 0 的数字**（例：12800 / 12800.50）：请改一下再点「提交」。',
    // ⭐⭐ 提交**成功算出结果并出了新卡**之后，把她提交的那张卡收成的终态
    //    （表单收掉 ⇒ 点不了第二次，这正是"避免重复提交"）。
    //    ⚠️ 只在**真的算出结果**时才收：没有到货内容 / 解析失败时卡片保持可编辑
    //       （把没算成说成"已提交"就是谎报）。
    submittedTitle: '已提交',
    submittedMessage: '你填的实际到货情况我已经收到，并按它重算了一遍 —— 最新那张核对卡片就发在你这条消息下面，**请用最新那张**（点它上面的「是」才会入库）。',
  },
  // 点「是」之后回群里那句结果的**模板**（`{key}` 由 service 填；模板可配 = 改文案不碰逻辑）。
  summary: {
    // 全部行都到货（没有 0 行）时用这句 —— 与改动前的逐字相同。
    posted: '已按实际到货入库：{rowCount} 条明细 / 共 {total} 双（报货批次号 {batchNo}）。',
    // 有一部分行 `实际 = 0`：那些行不入库，必须在回话里说清楚。
    postedWithZero: '已按实际到货入库：{rowCount} 条明细 / 共 {total} 双；另有 {zeroCount} 条实际 0 双（没到），这 {zeroCount} 条我没有入库（报货批次号 {batchNo}）。',
    // 边界：这一批**每一行**都是 0 双（一件都没到）。不能写成"已入库 0 条"含糊过去。
    postedNothingArrived: '这批单子你说下来一件都没到（{zeroCount} 条明细全是 0 双），我没有入库、也没有写库存流水（报货批次号 {batchNo}）。',
  },
  replies: {
    // 业务负责人原话：「只回一句"好，那先不入库"」——一个字不多写。
    rejected: '好，那先不入库',
    // 重复点「是」/ 重复投递时的回执（幂等，不重复入库）。
    alreadyPosted: '这一批已经入库了，我没有重复写。',
    // 点「是」但任务里还没有算好的计划（读明细失败 / 卡片没发出去这种兜底）。
    // ⚠️ 2026-10-07 改文案：**不许**再让她"先说一句核对完了" —— 那条口令已经废掉
    //    （业务负责人：「用户一般一句话就能够说清楚这个事情」）。这里只说明"我还没算出来"。
    notConfirmedYet: '我这边还没算出这一批的核对结果，你再说一句实际到货，我重算一遍。',
    // ⭐ 2026-10-07 新增：她说了一句，但**这句话里没有可核对的到货信息**
    //    （半句话，或话题里的闲聊）。这时**绝不能**当成"全部到货"发卡片
    //    （那会让她一点「是」就按申请数整单入库），而是教她怎么说。
    //    只在模型认为"信息够了"（`complete === true`）却什么都没给出来时才回 ——
    //    否则静默，避免刷屏。（提示词里 `complete` 已改成"她给的信息够不够算"。）
    noArrivalContent: '这句里我没听出到货的变化。跟单子一样就说一句「都到了」；有多的少的，说一下货号、尺码和双数。',
    // ⭐ 2026-10-07 晚改名（原 `updatedCard`）：她已经有一张待确认卡片，又补充/修正了一句
    //    （或换了话题）—— 我们**在这个话题重发一张新卡**，旧卡尽力作废，回这一句说明"哪张才是准的"。
    //    🔴 **不许**再写"上面那张卡片已经更新"：真机 2026-10-07 23:37 那句回话就是这么说的，
    //    而她那边**一张卡都没有** —— 那句话把她（和排查的人）都带偏了。
    //    置空字符串 = 不回这句（卡片本身照样发）。
    recalculatedCard: '我按你刚说的重算了一遍，最新那张核对卡片就发在你这条消息下面 —— 你看一眼，点「是」我就按新的数量入库。',
    // 解析出来的差异对不上采购申请明细：明确说清，**不入库、不猜**。
    unmatched: '我没把你说的话对上这批采购申请的明细，先不入库。你说一下具体哪个尺码、多少双，我重算一遍。',
    // ⭐ 2026-10-07：算出来是**负数**（她说少的双数比这行申请数还多）。
    //    货号/尺码其实对上了，是**数字**对不上 —— 所以**不能**复用上面那句"对不上明细"
    //    （那句话会让她去改货号/尺码）。也**不静默当成 0 双**（那是替她编一行"没到"）。
    negative: '这个尺码你说少的双数比申请数还多，我算出来是负数，先不入库。你说一下这个尺码实际到了几双，我重算一遍。',
    // 核对期间没有任何可核对的明细（例如群里发的是别的单据）。
    noRows: '这批单子我没找到可以核对的采购申请明细，先不动。',
    // 已经入过库之后她又说话：不静默，明确告诉她这批已经处理过了。
    // ⭐ 2026-10-07 明确这是**有意选的"安全默认"**：**不自动重开、不自动改账** ——
    //    自动重开等于自动反向写库存，是这里最危险的做法（她最在意的就是"写错账"）。
    //    所以：一个字都不写 + 如实告诉她 + 让她给指令。
    // ⚠️ 已知缺口（未做）：这句里的"要改请告诉我该改哪一条"目前**没有配套的自动入口**，
    //    真要改得走人工库存调整（工作台盘点调整）。要做自动改账路径时，从这里起。
    afterPosted: '这一批已经入过库了，我没有再动任何表。要改请告诉我该改哪一条。',
    // ⭐ 2026-10-07 新增（她连着两次「卡片点击后没有任何反应」）：
    //    **失败必须在话题里留下一条看得见的东西**。下面三句就是那三个失败口子的文案，
    //    全部带 `{error}` 占位（`formatCopy` 填）—— **错误原文一个字都不许吞**。
    //    用法：卡片会被 patch 成红色终态（标题 = `card.failedTitle`），同时把同一句回到话题里。
    //
    // ① 点「是」之后入库那一步抛错（含**到货信息写不进「报货批次」那一行**）：
    //    可以从断点重试（入库本身有幂等兜底，「验收原话」写的是同一个值）。
    //    ⚠️ 2026-10-07 晚：原先还有一个 `arrivalCreateFailed`（"「到货验收」这一行没建成"）——
    //       那张表已被业务负责人删除，这里**不再建行**，失败原文由这一句承载 ⇒ 那个配置项删掉。
    inboundFailed: '入库没成功：{error}。请再点一次「是」，我会从断点接着写，不会重复入库。',
    // ② 任务丢了（本地记录被清 / 卡片是别处的）——以前也**只弹 toast**。
    taskMissing: '这条到货核对记录我已经找不到了，没法入库。你把「都到了」或差异再说一句，我重新核一遍。',
    // ③ 点「是」但任务里还没有算好的计划（她说的话我们没算出结果 / 卡片没发出去）——
    //    复用既有那句 `notConfirmedYet`（上面），这里不另写一份。
    //
    // ⭐⭐ 2026-10-08（业务负责人逐条批准）：**卡片没刷新成功**时往那条话题回的一句人话
    //    （`safeUpdateCard` 失败时发；它自己失败也只记日志、绝不抛）。
    //    🔴 顺序语义：**卡片是主、这句话是兜底** —— 所以话说"以这条话为准"。
    //    置空字符串 = 不回这句（卡片照样尽力 patch）。
    cardUpdateFailed: '这条核对卡片我没能刷新成功，请以我这条话为准；要是看不到按钮，就在这个话题里再说一句实际到货，我重出一张。',
    //
    // ⭐⭐ 2026-10-08：「表单填写 + 提交」那三个出口的回执。
    // 🔴 **注意可见性**：卡片动作那条路由的同步响应**固定**是「已收到，正在处理」
    //    （`routes/larkEvents.js` 的 `card.action.trigger`），下面这些 toast **她那边看不见**，
    //    只进 `lark.card.handled` 日志 ⇒ **可见反馈一律做在卡片上 / 话题里的回话上**
    //    （空提交 → `card.submitMissingNote`；没算出结果 → 既有那几句 `replies.*`）。
    // ① **空提交**（`form_value` 里没有那一项 / 只有空白）：明确提示，**一个字都不写**。
    //    ⚠️ 必填只是**前端**闸门（官方原文：未填写则前端提示、**不会发起回传**），
    //       所以服务端必须自己兜一层 —— 重放 / 模拟 / 降级都可能把空串送进来。
    submitMissing: '没看到「实际到货情况」的内容 —— 请在上面的输入框里写一句，再点「提交」。',
    // ⭐⭐ 2026-10-08：「实际金额」的**服务端**闸门（她的口径：必填，否则点不了按钮）。
    //   官方 `required` 只拦前端 ⇒ 服务端必须自己再拒一次，而且**一个字都不许写**。
    //   ① 没填 / 只有空白：明确要她补（不静默）。
    amountMissing: '没收到「实际金额」—— 这一次供应商的金额是必填的，请在上面的金额输入框里填一个数字，再点「提交」。',
    //   ② 填了但不是数字 / 是负数：同样拒绝 + 说清要什么形状。
    //      ⚠️ 只拒**负数**（0 是允许的：样品 / 赠送到货这种"这次金额为 0"是真实存在的输入形状）；
    //         她这次只说"为负 ⇒ 拒绝"。
    amountInvalid: '「实际金额」只能填**不小于 0 的数字**（例：12800 或 12800.50）—— 这次提交我没有处理，你改一下再点「提交」。',
    //   ③ ⭐ 点「是」那条路**没有金额输入**：这一批还没有金额时**不许写空的「实际金额」**，
    //      也不许静默跳过 —— 明确指回表单那条路（她的口径："必须让用户填"）。
    amountMissingOnConfirm: '这批还没收到这一次的供应商金额 —— 请先在卡片表单里填上「实际金额」再点「提交」，我才会按实际到货入库（我不会写一个空的「实际金额」）。',
    // ② 提交**收到并真的算出结果（出了新卡）**时的回执。
    submitReceived: '已收到你填的实际到货情况，我按它核对了一遍 —— 最新那张核对卡片就发在你的消息下面。',
    // ②-补 提交收到了，但**这次没能算出可入库的结果**（没有到货内容 / 解析失败 / 对不上明细 /
    //    读不到这批明细）：🔴 不许说成"卡片发你下面了"（根本没有那张卡）、
    //    也不许说成"已核对"（没核对出来）—— 如实说 + 指回那两条还活着的路。
    submitReceivedNoCard: '已收到你填的实际到货情况。这次我没能按它算出核对结果（没有入库、也没有写数据）—— 你改一句再点「提交」，或者直接在话题里说一句，我重算一遍。',
    // ③ 同一次提交被飞书**重投**（同一条卡片消息 id）：幂等，不重复核对、不重复发卡。
    submitDuplicate: '这次提交我已经处理过了，没有重复核对、也没有重复写。',
    // ④ 到货核对**整个链路关着**（`PURCHASE_ARRIVAL_CONVERSATION_ENABLED=false`）时她提交：
    //    不处理（与"在话题里说"**同一个开关、同一个语义**），但卡片动作必须回一个响应 ⇒ 如实说。
    disabled: '到货核对现在没有开着，这次提交我没有处理。',
  },
});

// 「显式布尔」解析：**不用 `|| fallback`**。
// 用 `||` 的坑是"清空变量"会回退到默认值，于是 `PURCHASE_ARRIVAL_CONVERSATION_ENABLED=`
// 反而打不开/关不掉（AGENTS.md 专门点了这个坑）。这里把空串当成"没配"，其余按字面认。
const parseExplicitBoolean = (raw, fallback) => {
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (value === '') return fallback;
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`PURCHASE_ARRIVAL_CONVERSATION_ENABLED 必须是 true/false，收到：${raw}`);
};

const positiveInteger = (value, fallback, label) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} 必须是正整数，收到：${value}`);
  return parsed;
};

/**
 * 组装本次运行的配置。`options` 可覆盖任意一项（测试用；生产走环境变量）。
 * 环境变量在每次调用时读，不在模块加载时求值——避免 dotenv 顺序问题
 *（2026-10-06 线上事故的教训：模块级求值会在空环境里定稿）。
 */
const resolveArrivalConversationConfig = (options = {}) => {
  const env = options.env || process.env;
  // ⚠️ `form` 必须**嵌套合并**（与 `replies` / `summary` 同一套写法）：
  //    只浅合并 `card` 的话，测试 / 调用方只想覆盖 `form.submitLabel` 一项时，
  //    会把 `form` 其余项（`fieldName` / `required` / 降级文案…）整块变成 undefined
  //    —— 那是"改一项、坏一片"的静默失效。
  const form = { ...DEFAULTS.card.form, ...((options.card || {}).form || {}) };
  const card = { ...DEFAULTS.card, ...(options.card || {}), form };
  const replies = { ...DEFAULTS.replies, ...(options.replies || {}) };
  const summary = { ...DEFAULTS.summary, ...(options.summary || {}) };
  return {
    enabled: options.enabled ?? parseExplicitBoolean(env.PURCHASE_ARRIVAL_CONVERSATION_ENABLED, DEFAULTS.enabled),
    maxTranscriptChars: positiveInteger(
      options.maxTranscriptChars, DEFAULTS.maxTranscriptChars, 'maxTranscriptChars',
    ),
    maxRequestRows: positiveInteger(options.maxRequestRows, DEFAULTS.maxRequestRows, 'maxRequestRows'),
    acceptanceTextSeparator: options.acceptanceTextSeparator ?? DEFAULTS.acceptanceTextSeparator,
    card,
    replies,
    summary,
  };
};

module.exports = {
  ARRIVAL_CONVERSATION_ACTIONS,
  ARRIVAL_BATCH_KINDS,
  ARRIVAL_DIFF_TYPES,
  ARRIVAL_ALL_PRESENT_PHRASES,
  ARRIVAL_FORM_DEFAULTS,
  ARRIVAL_CONVERSATION_DEFAULTS: DEFAULTS,
  resolveArrivalConversationConfig,
  parseExplicitBoolean,
};
