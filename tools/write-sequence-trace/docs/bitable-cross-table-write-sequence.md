---
name: bitable-cross-table-write-sequence
description: 还原多维表格一次前端业务任务跨多张表的真实写入顺序时，如何用记录历史自动串联关联记录并全局排序
metadata:
    type: work_experience
    source: harness
    created_at: "2026-11-07"
    tags:
        - 飞书多维表格
        - record-history
        - 写入时序
        - 跨表追踪
        - 邯美数智化
---
## 适用场景
需要回答"一个完整前端任务（一笔销售/一次入库等）在后台先写哪张表哪个字段、后写哪个"，或排查跨表写入编排、状态机流转、重试漏写时。飞书事件订阅无 bitable 记录变更事件、无法实时推送，且无整库审计接口时使用。

## 关键做法
1. 以业务单据号为锚，先在主表按单号文本定位主记录，再沿 link 找齐该任务在各表的全部记录。邯美销售主表自带「销售明细」「收款明细」「库存流水」三个 link（收款明细 link 目标即 S 交易明细表）；同时库存流水「关联销售」指向的是销售明细 record_id 而非主表，需顺链路逐层找、用两条路径互为兜底，不能只查主表 id。
2. 对每条记录调 lark-cli base +record-history-list（单 record_id，page-size 50，has_more 时用本批最小 rev 作 --max-version 翻页），取 create_time（秒级）、rev（全局递增）、operator、field_changes(before/after)。
3. 把各表历史事件拉平成统一列表，按 (create_time, rev) 全局排序即得跨表写入先后（同秒靠 rev 分先后），并可算每步相对秒数。状态类字段（销售/库存/资金状态"未写入→已写入"）天然标记各子环节完成边界，operator 可区分真人与自动化机器人。
4. link/select/人员的 before/after 是 id，须用各表主字段及配置表建 id→名称映射后再展示。

## 踩过的坑
- record-history 只能逐 record_id 查；已删除或出库归零后从当前快照消失的记录拿不到 id、无法拉历史，该环节只能靠流水侧间接体现，不要承诺还原被删整条。
- python subprocess 调 lark-cli +record-list --output 时，不要用 tempfile.gettempdir() 的 macOS /var/folders/.../T 路径（会 status 2 失败），固定写到 /tmp；本环境 python3 -c 多行内联和 for 套 lark-cli 还会偶发吞输出，统一写 .py、结果落盘后再 Read 最稳。
- 公式/lookup/双向关联及机器人回写（如自动更新"标签二维码"）也进历史，属系统自动变更噪音，呈现时与人工主动写入区分；个别 link 的 before/after 可能是被序列化的 dict 字符串而非 list，翻译前先判类型。

## 可复用的产物或模板
- 全自动脚本：`tools/write-sequence-trace/scripts/fetch_trace.py`，按 `configs/sales.config.json` / `purchase.config.json` 取数并输出标准 `events.json`；再用 `build_html.py` 生成单文件 HTML。
- 旧版手动合并脚本：`tools/write-sequence-trace/scripts/merge_history_json.py`（仅兜底）。
- 核心命令：lark-cli base +record-history-list --base-token <token> --table-id <tid> --record-id <rid> --page-size 50 --as user。