# 文档索引

本目录是 `feishu-retail-ops` 的知识库入口。根目录 `README.md` 面向人，`AGENTS.md` 面向智能代理；这里说明每一份文档现在是什么状态，避免把历史资料当成当前架构。

> **命名说明**：`box2bitable`（以及 `Box2Bitable`、`box2base`、`box to base` 等写法）是本项目**旧名称**；当前仓库名与项目名为 `feishu-retail-ops`，产品名「零售数智经营助手」，邯美部署名称「邯美数智经营工作台」。历史文档中的旧名按当时事实保留，不做替换；PM2 进程名 `box2bitable-server` 与服务器目录 `/opt/box2bitable` 属于运行兼容名称，一并保留，迁移方式见 `feishu-v1-operations.md`。

## 1. 现行事实（Current）

描述已经实现并正在运行的行为，以及**业务负责人已定、作为当前权威口径的业务规则**（后者会在文档顶部标注实现状态：口径已定 ≠ 代码已实现）。表内 `arrival-conversation-reconcile-2026-10-06.md` 是 2026-10-06 当天实现并已落测试的业务规格；它的前一版 `arrival-conversation-flow.md` 同日作废。

| 文档 | 内容 |
|---|---|
| [handoff.md](handoff.md) | 交接说明：当前状态、硬约束、幂等现状、待办、采购改造方案与下一步建议 |
| [handoff-douyin-content-co-creation.md](handoff-douyin-content-co-creation.md) | **抖音共创交接**（2026-10-04 新增协作线）：家族生意背景、既有飞书资产索引、能力边界与第一步请求 |
| [project-progress.md](project-progress.md) | 项目进展、已确认决策与后续路线 |
| [feishu-v1-operations.md](feishu-v1-operations.md) | 飞书 V1 的运行与运维手册（部署、日志、排查） |
| [module-boundaries.md](module-boundaries.md) | 模块边界与职责划分 |
| [idempotency-contract.md](idempotency-contract.md) | 采购与库存的远端幂等契约 |
| [inventory-size-reference-contract.md](inventory-size-reference-contract.md) | 库存与尺码关联字段契约 |
| [workbench-query-contract.md](workbench-query-contract.md) | 工作台查询接口契约 |
| [sales-line-plan.md](sales-line-plan.md) | 销售线的推进计划与判据 |
| [arrival-conversation-reconcile-2026-10-06.md](arrival-conversation-reconcile-2026-10-06.md) | 采购到货「群话题对话式核对」：业务负责人 2026-10-06 当天口述的**权威口径**与验收标准（**已实现**）。⚠️ 其中「实际到货不会为 0 / 不为实际为 0 写规则」一条已被 2026-10-07 的口径**收窄**（见下一行） |
| [arrival-zero-arrived-rule-2026-10-07.md](arrival-zero-arrived-rule-2026-10-07.md) | ⭐ **口径（权威 · 2026-10-07）**：「某个尺码实际到 0 双」是**正常情况** —— 该行不入库、**不阻断整单**；「真对不上明细」仍走原路径。**已实现**，验收标准与逐条对照见 [reports/arrival-zero-actual-2026-10-07.md](reports/arrival-zero-actual-2026-10-07.md) |
| [private-chat-removal-2026-10-07.md](private-chat-removal-2026-10-07.md) | 🔴 **私聊链路已移除**（业务负责人 2026-10-07：「以后私聊这条链路我们就没有了」）：入口统一到【群聊 + 话题】；方式是她拍板的 **ⓐ：代码里一行私聊都不留、测试全部迁到群聊入口**（**没有开关**）。含**验收标准**（A 入口 / B 群聊回归 / C 发送出口 / D 历史用例迁移 / E 门禁）、逐条实现对照、以及"怎么恢复私聊"。配套拍板见 [private-chat-removal-decision-2026-10-07.md](private-chat-removal-decision-2026-10-07.md)；承接 2026-10-06 的切除盘清 [private-chat-excision-todo.md](private-chat-excision-todo.md) |
| [product-info-gaps-card-move-2026-10-07.md](product-info-gaps-card-move-2026-10-07.md) | 🔴 **口径（权威 · 2026-10-07，⚠️ 当天她的口径改过两次，本文件是【最新版】）**：「补货品信息」段落**从确认卡片挪到【点确认之后的卡片】= ①「销售订单处理中」卡 ＋ ② 绿色「销售订单已入账」终态卡**（先"两边都放"(#220) → 她纠正「**不是，是只放在2上！**」(#221) → 她再改口「**中间态也应该有提示**」⇒ 处理中卡加回来）。**确认卡片（点之前）与取消 / 待修正始终不带**。起因（她的原话）：「我们的卡片能够实时更新，更新完之后，用户要补的链接其实就看不到了」。含**两次口径变更的时间线（每句原话）**、验收标准、终态卡分支覆盖表、配置键（`PRODUCT_INFO_GAPS_*`）与"不多读一次表"的边界 |
| [sales-confirm-processing-card-visible-2026-10-07.md](sales-confirm-processing-card-visible-2026-10-07.md) | ⭐ **口径（权威 · 2026-10-07）**：点「确认」后**那一次立即更新**的卡片必须一眼看出"已经点上了、正在写入"（业务负责人拍板的 **ⓐ**：醒目标题 ＋ 明细区变灰/加"处理中"提示；**不要**分阶段进度）。含验收标准、配置键（`SALES_PROCESSING_CARD_*`）与"只改显示"的边界 |
| [pending-deal-push-sections-2026-10-07.md](pending-deal-push-sections-2026-10-07.md) | ⚠️ **分区标题与判据已被 [sales-type-by-stock-2026-10-07.md](sales-type-by-stock-2026-10-07.md) 取代**（现为【预定】/【现货待收】、按**履约状态**分区，不再按交易类型编码）。其余（行格式 / 深链 / 按天去重 / 置顶）仍然有效。原文：⭐ **口径（权威 · 2026-10-07）**：每天 9 点的「待处理单推送」**按【预付 / 未付】分区**（业务负责人逐字：「只需要这些信息，按照预付和未付分区」），每条 = 单号 + 【预付/未付】 + **货号+尺码** + 待收金额 + 深链；**不加售出时间**。分区顺序/标题/行格式全在 `config/pendingDealPush`（`PENDING_DEAL_PUSH_BLOCK_ORDER` / `*_TEMPLATE` 等）。含验收标准、逐条对照、改后的推送样例与"额外读表"的代价 |

| [sales-type-by-stock-2026-10-07.md](sales-type-by-stock-2026-10-07.md) | 🔴🔴 **口径（权威 · 2026-10-07；取代同日更早的「按类型跳过库存解析」「候选只推在售」两刀）**：**交易类型 = 实时库存里有没有这一双**（有货 → `SALE_CASH` 现货；没货 → `SALE_PREPAID` **预定**）—— 她逐字：「库存里有这双 → 现货（当场交付 + 扣库存）；库存里没有 → 预定（不交付；等货到了再交付、那时才扣库存）」「⭐ 所以：**每次都必须查库存**（这就是判据本身）」；**资金与类型彻底解耦**（她逐字：「【资金 = 只听你怎么说】（与类型完全无关）」）—— 全款 / 部分 / 没付 / 定金四种资金形态 × 现货 / 预定两种类型都能配；**「未付」不再是一种交易类型**（她从「行为管理」删掉了那条记录）⇒ 候选源改成「**预定（未交付）** ＋ **现货但钱没结清**」、分区标题改成【预定】/【现货待收】；**候选给全部颜色**（撤掉“只推在售”）；卡片**三段分开说**（类型 · 履约状态 · 收款情况）。⚠️ 其中「候选上保留『有货 / 无货』标注」一条（AC-2.3）**已被同日后续的「甲 去掉」推翻** —— 见下一行。含验收标准 AC-1～AC-9、六处关键 diff、`SALE_UNPAID`/「未付」处置清单、**先红后绿证据**（含一次“把判据改成恒现货”的变异验证）、历史影响面的**只读核查**结果与未核到的部分 |
| [color-candidate-no-stock-preview-2026-10-07.md](color-candidate-no-stock-preview-2026-10-07.md) | 🔴 **口径（权威 · 2026-10-07，业务负责人逐字：「**甲 去掉**……候选只显示颜色（黑色 / 绿色），**选完 → 再查库存 → 告诉她"这双有货→现货"或"没货→预定"**」）**：**候选按钮只显示颜色名** —— 「有货 / 无货」预览标注、`SALES_COLOR_STOCK_LABEL_AVAILABLE/UNAVAILABLE` 两个环境变量、`SALES_COLOR_STOCK_STATUS` 常量与 `colorOptionsWithStockStatus()` **一并删除**（不留死配置）；⚠️ **"录单时读实时库存"保留**（单颜色货号仍用它定现货 / 预定），"选完颜色后重查库存定类型"**一字不改**。含验收标准 AC-1～AC-10、三处关键 diff、"录单读库存还用不用"的证据、改后按钮**逐字**内容、**mutation 自证**（把标注加回去 → 新断言变红） |
| [sales-missing-info-wording-2026-10-07.md](sales-missing-info-wording-2026-10-07.md) | 🔴 **文案（2026-10-07 真机）**：销售「销售信息还缺…」那句追问**不再漏代码标识符**（`items[0].actual_amount` / `payments[0].method`）、**一次只说一件事**（一件事一行，不再用「；」串成一段）、**每条都给具体动作**（如「带定金的单一次只能记一双，请把这两双分开发送～」）；起因是业务负责人收到那条后只问了一句「**这个提醒是什么意思？**」。⚠️ **判据一个字没动**（`missing_fields` 逐字不变、仍 `needs_info`、仍不发卡片、仍不入账）；文案全部进 `config/salesMissingInfoText`（`SALES_MISSING_INFO_*`）。含**逐句溯源**（哪一句出自哪个文件哪一行）、验收标准 AC-1～AC-8 与逐条对照。⚠️ **同日稍后已按【上游已变】同步过一次**（PR #234 合入 `2d852c3` 之后：那句「定金单暂只支持一条明细…」的生产者被**删除**、换成了 #234 **新增**的「哪一件是付了定金的那件…」，且缺项 index 从 `payments[0]` 变 `payments[1]`）—— ⭐ **当前有效事实见该文档第 14 节**（冲突逐行解法、新句子→新文案**逐字**对照表、映射表 ⇄ 形状守卫一致性证据、AC-S1～AC-S10 逐条对照） |
| [behavior-code-lookup-and-arrival-failure-feedback-2026-10-07.md](behavior-code-lookup-and-arrival-failure-feedback-2026-10-07.md) | ⭐ **修复（2026-10-07）**：①「行为管理」查找改为**按行为编码**（她把中文名「采购入库」改成了「入库」，按名找就永远抛错 ⇒ 点「是」永远入不了库）；②点到货卡片**失败必须有可见反馈**（把那张卡 patch 成红色终态 ＋ 回一句到话题；改前失败只弹 toast、卡片一动不动）。含验收标准 A1–A8 / B1–B11、同类排查逐条结论、与任务书口径的一处**不一致**（`PURCHASE_IN` ≠ 注册表里的 `STOCK_PURCHASE_INCREASE`） |
| [sales-product-registration-guard-2026-10-07.md](sales-product-registration-guard-2026-10-07.md) | 🔴 **判据（权威 · 2026-10-07）**：**A（读「货品信息」）之后**加一道「**这个货号到底有没有建档**」的判据 —— **三种交易类型都走**（她逐字：「三种交易类型，在看完货品信息之后，如果在货架上没有找到，都应该给到这个提示，而不是说等到 B」）。**没建档就拦**（`needs_info` / 不发卡片 / 回一句可配文案）与「**缺资料不拦**」（齐备公式说缺字段 → 只进终态卡那段「补货品信息」）**判据分开**。含验收标准 AC-1～AC-8、判据的**正证据**口径（读不到「货品信息」就不下结论）、配置键（`SALES_PRODUCT_REGISTRATION_*`）与正向证据日志 |
| [purchase-intake-batch-spec.md](purchase-intake-batch-spec.md) | ⭐ **采购提交的归批口径（业务口径 · 权威 · 已定）**：一次提交 = 一个行为（采购申请 或 采购退货）+ N 个编号（**= N 个不同货品**）→ **只出一张图**；⭐ **一个货品的多个尺码勾在同一条记录上，记录之间不合并数量**。⚠️ **口径已定，但代码尚未按此实现**（仍在用时间窗归批）；改造方案见第 3 节 |
| [sales-multi-line-trade-type-2026-10-07.md](sales-multi-line-trade-type-2026-10-07.md) | ⭐ **口径（权威 · 2026-10-07）**：放开「**定金单只支持一条明细**」—— 一张单**允许多明细、不拆单**（她逐字：「**这就是一个人买的呀**」）；「交易类型」**按明细行定**（每行单选；⚠️ 取值已被 [sales-type-by-stock-2026-10-07.md](sales-type-by-stock-2026-10-07.md) 收成**现货 / 预定**两种、且**由库存决定**），**销售主表多选**（去重后的多个，例：现货+预付）。「跑不跑 B（实时库存）/ 颜色候选范围 / 交不交付」的判据**取值从"整单"改成"逐明细"**，来源仍是 `config/salesTradeTypePolicy` / `config/salesMovements`。含**判据位置**（`doubaoService.normalizeSalesResult` 那条整单护栏）、验收标准 AC-1～AC-14、真机原话的逐字段解析结果、**先红后绿证据**、单类型单"逐字不变"哨兵，以及已知的下游缺口（待处理单推送的分区仍取整单第一个类型） |
| [arrival-conversation-flow.md](arrival-conversation-flow.md) | ⚠️ **已作废**（同日被上一份取代）：早一版规格；正文按当时事实保留，**不要再按它实施** |
| [sales-tail-payment-and-hint-2026-10-07.md](sales-tail-payment-and-hint-2026-10-07.md) | 🔴🔴 **真机修复（2026-10-07 22:59，业务负责人逐字）**：「定制一双 37 码的 26632，定金交了 100 元，微信，**下次收**120元」——① **「下次收」没被认成尾款**（`owed` 空、成交额也没推出来；同一天「下次**欠** 128」却全对，差别只在「欠」vs「收」这个用词）；② 后端那句「**已收的钱比这单成交金额还多**」在"成交额压根没解析出来"时是**误导**。⇒ ① 提示词 ＋ `config/salesDepositTerms`（**词表**：下次收/下次付/还要收/还要付/再收/再付/尾款/余款/剩下/剩下的/还差/补收，**方向词不改变性质：都是"还没到手的钱"**）把尾款说法统一成 `owed`，并立「**定金 + 尾款 ⇒ 成交额 = 两者之和**」；② 接线层那句加 `actualTotal > 0`（成交额**有值**才报），成交额没解析出来时改问「请说明这单成交金额（或定金+尾款分别是多少）」。含验收标准 AC-1～AC-9 + 逐条对照、**先红后绿证据**（改动前 11/15 红，另在未改动的 `main` 上复现出她收到的那两行原话）、全量 2 次与 CI 证据 |
| [arrival-all-arrived-phrases-2026-10-07.md](arrival-all-arrived-phrases-2026-10-07.md) | ⭐ **修复（2026-10-07 真机，业务负责人批准「这个也可以做～」）**：「**全到**」类说法**等价** —— 真机里「都到了」出卡片、而「**都到货了**」被判成 `no_arrival_content`（一句意思、两种结果）。两层一起改：① **提示词**把「都到货了 / 全部到货 / 都到齐了 / 都齐了 / 全到了 / 都收到了 / 全部到齐 / 齐了」列为等价（`same:true`）；② **代码侧兜底**（关键，真机那次就是模型没认出来）—— 只在**模型什么都没给出来**时，把"整句只由『全/都/齐』＋『到/到货/收到/来了』这类词构成、且无数字/数量/货号"的说法判为**全部到齐**。🔴 **绝不放宽"有具体内容"**（「到了 2 双」「8230 到了 1 双」「还有一双没到」仍走原判据）；**判据本身一个字没动**（兜底做在解析层，`purchaseArrivalConversationService` 一行未改）。词表进 `config/arrivalConversation.js`（配置先行）。含验收标准 AC-1～AC-10 + 逐条对照、正/反向用例清单、**先红后绿证据**（改动前 8/13 红，含真机那条 `no_arrival_content` 日志） |
| [purchase-batch-no-arrival-and-push-2026-10-07.md](purchase-batch-no-arrival-and-push-2026-10-07.md) | ⭐ **采购侧一批改动（业务负责人 2026-10-07 口径，逐字在文首）**：① **表改名同步**（「供应商对接」→**信息填写**、「单据信息」→**具体信息**）；② **报货批次号不再手填**，改由后端代码生成 `CGD-YYYYMMDD-NNNN`（入口**按包**生成一次并写回那一列 —— 归批键就是它，不写回就会退化成 N 个号 N 张图）；③ 「报货批次」**加**「到货状态」「单据」（新建 = 未到货、到货核对确认成功 = 已到货；「采购行为」她明确不用管 ⇒ 不映射）；④ 附件/图**从「具体信息.采购申请单」（该列已被她从生产表删除）挪到「报货批次.单据」**；⑤ 9 点推送**加【采购】区**（候选 = 「报货批次」里 到货状态 = 未到货；销售区**逐字不变**）。含**验收标准 A1–H4**、逐条对照、**先红后绿证据**（新用例在改动前 4/4 失败）、全量 2 次与 CI 证据，以及**两处需要她拍板的缺口**（退货批次没有「报货批次」行 ⇒ 退货单附件暂时没有落点；本地测试 Base 落后于生产 ⇒ 本机 `v1:schema-check` 会红，必须在服务器上跑）。⭐ **第 8 节是「表名/字段同步的最后两处」（2026-10-07 晚补）** |
| [arrival-table-rename-and-images-field-removal-2026-10-07.md](arrival-table-rename-and-images-field-removal-2026-10-07.md) | 🔴 **部署闸门对着生产报红后补的两处漏项（2026-10-07 晚）**：① 「采购到货」→**「到货验收」**（tableId `tblvLOXKESNTbZ7v` 不变）的 `tableName` 同步；② 该表 **「图片」整列已被业务负责人删除** ⇒ `images: '图片'` 映射**连全部读写点一起删**（读点 = `purchaseQueryService` 的 `image_count` ＋ 工作台「图片数」列；写点本来就不存在）。含**验收标准 A1–F3 + 逐条对照**、**「图片」读写点清单（删了哪些 / 哪些是别的物）**、**五张采购表逐表核对结论**、**注释怎么改的（旧的"要保留"口径已被推翻）**、先红后绿证据（改动前 5/5 红）、全量 2 次与 CI 证据，以及**唯一一处「需在服务器上复核」**（「采购入库」在生产闸门里排在 `purchaseArrival` 之后，那一轮**没走到它**） |
| [arrival-landing-on-batch-2026-10-07.md](arrival-landing-on-batch-2026-10-07.md) | 🔴🔴 **口径（权威 · 2026-10-07 晚；取代上面那一行 —— 表改名之后她当天又把表【整个删除】了）**：业务负责人逐字「我们到货验收数据表需要写入的点**变到了报货批次里面**……**「采购入库.采购到货批次」字段删除了，不需要了**」⇒ ① schema **删** `purchaseArrival` 整段、**删** `purchaseInbound.batch`，`purchaseOrderBatch` **加** `acceptanceText='验收原话'` / `confirmStatus='确认状态'`；② 到货确认的落点改成**按批次号（或批次 record id）更新「报货批次」那一行**（`createArrivalRecord` 删除，`confirmArrival` 收尾改 `orderBatches.markConfirmed`）；③ **幂等/关联键从「到货记录 id」换成「批次 record id」**（`purchase_arrival_record_id` → `purchase_batch_record_id`；「采购入库」的远端回查判据换成「采购申请关联」）；④ 工作台到货面板**改读「报货批次」**（不摘面板）；⑤ 「到货日」=更新时间 / 「验收人」=创建人是**飞书自动字段**，代码不写也不建映射。含**验收标准 AC1–AC11 + 逐条对照**、**先红后绿证据**（新用例在改动前 8/11 红）、全量 2 次与 CI 证据，以及**需她拍板/知情的判断**（孤儿调用不阻塞、工作台面板处置、`采购到货批次` 回查判据替换） |
<<<<<<< HEAD
| [purchase-return-unified-parsing-2026-10-07.md](purchase-return-unified-parsing-2026-10-07.md) | 🔴 **口径（权威 · 2026-10-07）**：业务负责人逐字「**不分报货还是退货，都是按照同样的逻辑：如果数量说明不写，数量就默认为一双**。你需要**把退货原有的那个解析路线删掉**，然后再把**采购的那个加上退货**就可以了」「它除了是删数量映射，它也**删除了"不需要再去实时库存表里找数量有哪些尺码"的逻辑**」⇒ ① schema **删** `purchaseReport.quantity='数量'`（那一列已被她从生产表删除，部署闸门红的就是它）；② **解析只有一条路**（`parseReportQuantities`：尺码多选逐个展开 + 数量说明缺省 1 双），`parseReportReturnQuantities` / `parseReportItems` / `parseReturnQuantity` **全删**；③ `planPurchaseReturn`（捞实时库存行 → 反推 `bySize`）**整段删除**，换成 `planReturnFromItems`（尺码/数量只来自表单，实时库存**只回答"这一项最多能退几双"**）；④ **库存不够的既有行为保留**：退能退的 + 把差额回报给她（一双都没有 ⇒ 不扣、不标终态、告诉她没处理）；⑤ 真正扣库存那一刀**一个字不改**（仍走 `STOCK_MOVEMENTS[STOCK_PURCHASE_DECREASE].consumes`）。含**验收标准 AC1–AC11 + 逐条对照**、**先红后绿证据**（新用例改动前 8/10 红、2 条哨兵绿）、全量 2 次与 CI 证据，以及**一处解释**（"删反推"与"报差额"的交界：只数数、不反推） |

| [terminal-card-confirm-deal-2026-10-07.md](terminal-card-confirm-deal-2026-10-07.md) | ⭐ **口径（2026-10-07，业务负责人拍板的**甲**）**：**入账之后**在**已经在她手里的那张「已入账」终态卡**上加**一个**【确认成交】按钮**（**不新发消息**），**只有点它才触发后续流程**；**只在需要它的单上出现** —— **预定（未交付）** 或 **现货有欠款**（现货已交付已结清的一律没有）；卡面**只有一个**按钮（不许"取消 / 否 / 稍后"）；点击**走既有那条「成交」逻辑**（`salesThreadProgressService` 的 complete 分支），并**先把"货那一半"做掉**（她 2026-10-06 在 `AGENTS.md` 第 16 条定的安全网）——**预定单货还没到时一个字节都不写**、明确回一句"先走到货入库，再到这张卡上点确认成交"。含**动手前对既有 complete 路径的核查结论（第 16 节记的两处缺口已在 2026-10-06 修好，本次直接复用、没改它的判断）**、**验收标准 AC-1～AC-10 + 逐条对照**、**先红后绿证据**（新用例改动前 10/13 红）、全量 2 次与 CI 证据、13 个 `SALES_CONFIRM_DEAL_*` 配置键，以及**需她拍板/知情的不确定处**（卡上带不了收款方式 ⇒ 多个方式时钱回问一句；两条路径"钱货顺序"不同；橙色"部分交付/交付待处理"卡是否也该有按钮） |
| [exchange-same-item-size-2026-10-07.md](exchange-same-item-size-2026-10-07.md) | ⭐ **修复（2026-10-07 真机 23:06）**：业务负责人逐字「换货是这两种：**1. 换尺码  2. 换另一双鞋**」⇒ ① **提示词**（`doubaoService` 规则 13）逐字写明两种换货 ＋ 两个逐字例子（她真机那句「6C98012-15L 换成41码」＋「把 6035 黑 38 换成 1366-33 黑 40」）＋ 重申"return/exchange 不许把货号填进 items"；② **接线层判据放宽**（`afterSalesFlowService.resolveOutgoing`）：从"必须有 `new_item_no`"改成 **`new_item_no` / `new_color` / `new_size` 三者任一有值即算齐全**，只有三者全空才追问 ——「换尺码」本来就不该有新货号（同款换码时货号/颜色/金额取**原明细**，同一双鞋换个码 ⇒ 差价 0、不动钱）；③ **追问话术分情况**并全部搬进 `config/afterSalesFlow.js` 的 `AFTER_SALES_ASK_TEXTS`（三者全空 → 「换成哪一双？发我货号，或者只说新尺码也行。」）；④ 排查日志补 `new_color` / `new_size` / `new_amount`。⚠️ **追问之后的多轮接续本件不做**（先核过：销售链路没有这套机制，按口径停下汇报，另立队列串行做）。含**验收标准 AC-1～AC-10 + 逐条对照**、**先红后绿证据**（改动前 4 条红）、全量 2 次（rebase 到 `e2ec040` 之后 1290/1290）与 CI 证据 |
>>>>>>> e87ddea (fix(after-sales): 换货分清「换尺码」与「换另一双」——同款换码不再被"换成哪一双"拦死)

## 2. 架构决策记录（Architecture Decision Records）

现行架构决策记录，回答「为什么系统被设计成这样」，与第 1 节的现状描述互补，**不是历史文档**。治理规则（何时写 ADR、Status、Evidence 标注原则）见 [adr/README.md](adr/README.md)。

| 文档 | 内容 |
|---|---|
| [adr/README.md](adr/README.md) | ADR 治理规则与索引 |
| [adr/ADR-001-separate-ai-interpretation-from-deterministic-business-execution.md](adr/ADR-001-separate-ai-interpretation-from-deterministic-business-execution.md) | AI 负责理解与结构化，确定性后端负责正式业务执行 |
| [adr/ADR-002-robot-entry-triage-and-decoupling.md](adr/ADR-002-robot-entry-triage-and-decoupling.md) | 机器人入口三分与解耦；状态以表为准；不做自主智能体 |
| [adr/ADR-003-ai-role-and-future-host-boundary.md](adr/ADR-003-ai-role-and-future-host-boundary.md) | AI 的定位是「不确定性收口器」；未来宿主只能接管无副作用的域（决策三为未来方向 · 当前不实施） |

## 3. 现行设计参考（Design Baseline + 状态说明）

方案推演与当前实现混在同一份文档里，正文不能整体当作现状。**引用前先读文档顶部的状态说明**。

| 文档 | 性质 |
|---|---|
| [lark-agent-technical-design.md](lark-agent-technical-design.md) | 飞书 V1 原始设计基线；顶部标注了 Current implementation / Original design baseline / Future plan 的分区 |
| [purchase-intake-batch-plan-2026-10-06.md](purchase-intake-batch-plan-2026-10-06.md) | ⚠️ **方案（未实施）**：把归批判据从「猜时间窗」改成「**这一包进了链路的条目，处理动作都跑完就发图**」（**到齐就发 · 两层划分**）＋**读不到就重试 3 次（1 秒 → 2 秒）**＋配置先行；❌ **不设超时兜底、不考虑拆包**（她 2026-10-06 明确）。**给业务负责人看的那一版**。配套口径见第 1 节 `purchase-intake-batch-spec.md` |

## 4. 历史文档（Historical）

以下文档记录的是当时的真实情况，正文保持原样，只加了状态说明。它们**不代表当前架构**。

| 文档 | 时期 |
|---|---|
| [prd.md](prd.md) | 原 `box2bitable` 微信小程序 PRD（已退役） |
| [tech-arch.md](tech-arch.md) | 微信小程序时期的技术架构（服务端视角） |
| [technical.md](technical.md) | 微信小程序时期的接口与页面规划 |
| [archive/legacy-agent-guide.md](archive/legacy-agent-guide.md) | 原根目录 `agent.md`，微信小程序时期的 Agent 指南 |
| [archive/legacy-trae/](archive/legacy-trae/) | 原 `.trae/documents/`，Trae 时期的 PRD / 技术架构草稿 |
| [archive/legacy-wechat-retirement.md](archive/legacy-wechat-retirement.md) | Legacy WeChat 退役记录（2026-10-01） |
| [archive/sales-daily-report-retirement.md](archive/sales-daily-report-retirement.md) | ⚠️ **销售战报退役记录（2026-10-07）**：业务负责人逐字「连代码一起删」⇒ 服务 / 卡片 / 配置 / `app.js` 接线 / 用例 / `SALES_DAILY_REPORT_*` 整体删除；含**共用件（`shanghaiDailyScheduler` 等）为什么没跟着删**与**验收标准 + 逐条对照** |
| [sales-daily-report-push-2026-10-06.md](sales-daily-report-push-2026-10-06.md) | ⚠️ **已退役（2026-10-07）**：当初的战报口径（两个数字怎么算、9/12/15/18/21 ＋ 22 点、过期不补推）；**正文按当时事实保留，不要再按它实施** |
| [sales-report-card-design-2026-10-06.md](sales-report-card-design-2026-10-06.md) | ⚠️ **已退役（2026-10-07）**：当初战报卡片的样式口径（两个大数字块、不写计算逻辑）；卡片本身已删 |
| [handoff-notes-2026-10-06/README.md](handoff-notes-2026-10-06/README.md) | 交接笔记归档（2026-10-06 清理）：原 7 个 worktree 根目录下的 18 份未跟踪 `.HANDOFF-*.md`，全是 **2026-10-05** 多代理并行期间父代理写给子代理的裁决/纠正/叫停便条；**历史记录，不是当前口径** |
| [branch-salvage-2026-10-06.md](branch-salvage-2026-10-06.md) | 分支清仓留档（2026-10-06 清理）：除 `main` 外 14 条远端分支**逐条的删除判据与取代证据**（含 tip SHA）；⭐ 以及唯一一条"真有价值但没进 main"的 `refactor/decouple-creation-and-stock` 的**原件留档**（`branch-salvage-2026-10-06/`：剥出来的 `productCreationService.js` 原文 + 全量 patch） |

当前仓库级 Agent 入口以根目录 [AGENTS.md](../AGENTS.md) 为准；`agent.md` 已不再是第二套入口。

## 5. 设计资产

| 资产 | 说明 |
|---|---|
| [prototypes/工作台页面架构原型.html](prototypes/工作台页面架构原型.html) | 工作台页面架构原型（静态 HTML，直接浏览器打开） |
| [reports/purchase-image-layout-and-group-thread-2026-10-07.md](reports/purchase-image-layout-and-group-thread-2026-10-07.md) | ⭐ **采购单 / 退货单出图排版 + 图与文字落在同一个话题**（业务负责人 2026-10-07 真机测试后当面提）：① 底部「合计 N 条 / M 双」整条删掉，改成**副标题** `供应商 · 报货日期 · 合计 M 双`（只留双数）、**不显示报货批次**、退货单同样改；② 采购群的 `im.message.reply` 补上 `reply_in_thread: true`，@经办人那条进**图所在的那个话题**。含**验收标准**、`表事件触发能否建话题` 的官方文档查证、逐条对照与定位回归证据 |
| [prototypes/purchase-order-2026-10-07.png](prototypes/purchase-order-2026-10-07.png) · [prototypes/purchase-return-2026-10-07.png](prototypes/purchase-return-2026-10-07.png) | 上面那次改动的**示例图**（采购单 / 退货单），由**项目自己的渲染器**生成（`server/scripts/render-purchase-image-prototype.js`）⇒ 示例图 = 她实际会收到的图 |
| [reports/arrival-zero-actual-2026-10-07.md](reports/arrival-zero-actual-2026-10-07.md) | ⭐ **到货核对「某尺码实际到 0 双」放行**（2026-10-07 真机误报的修复）：0 双的行**不入库、不阻断整单**；真「对不上明细」与「算出来是负数」各自有自己的提示与日志事件。含**动手前先写的验收标准**、实现落点、逐条对照、两个判断（负数 / 全 0）的理由与两次全量测试证据 |
| [reports/purchase-group-notice-wording-2026-10-07.md](reports/purchase-group-notice-wording-2026-10-07.md) | ⭐ **采购群那条话术改成"只说双数"**（业务负责人 2026-10-07 逐字：「不用说几条，只给出多少双就可以了」）：`@… 三星 这批 12 条（共 13 双），图可以直接转给供应商。` → `@… 三星 这批 13 双，图可以直接转给供应商。`（「N 条」与「共」都去掉）。含**唯一拼接点**、**双数口径（`quantity` 求和，未改）**、**配置先行**（`config/purchaseGroupNoticeText.js`）、**同类文案排查清单**（改了哪些 / 没动哪些）、验收标准逐条对照与两次全量 + CI 证据 |
| [purchase-batch-time-field-rename-2026-10-07.md](purchase-batch-time-field-rename-2026-10-07.md) | ⭐ **「报货批次」自动时间列改名同步**（部署闸门红的修复）：她把「创建时间」改名**「报货日」**、「更新时间」改名**「到货日」**（类型没变，仍是自动 `1001`/`1002`）⇒ schema 只改**字段名映射**（语义键 `createdAt` 不变），**到货日仍不建映射、两列都不写**；含**旧字段名全仓扫描**（改了哪些 / 为什么没改哪些）、**闸门"下一条"可疑清单**（按校验顺序推出"从未被核到的 5 张表"）、先红后绿 + 全量 2 次证据 |
