# 观测告警（埋点第 3 刀）

> 第 1 刀事件目录见 [observability-events.md](observability-events.md)；第 2 刀日报见 [observability-daily.md](observability-daily.md)。

## 3 条规则

| 规则 | 触发条件 | 去重 key |
| --- | --- | --- |
| `error_rate` | 窗口内 error 占比 ≥ 阈值（默认 5%），且 error ≥ 3、总数 ≥ 20 | `error_rate` |
| `critical` | 命中「关键链路」事件且 level=error（默认 5 个事件，见 `config/alerts.js`） | `critical:<event>` |
| `slow` | 单条 `duration_ms` ≥ 阈值（默认 10000ms） | `slow:<event>` |

- 窗口默认 15 分钟；同 key **60 分钟**内只发一次；每窗口最多 **3** 条（防刷屏）。
- 收件人：`OBSERVABILITY_ALERTS_OPEN_ID`（**私发给业务负责人本人**，只发不收）优先；
  没有才用 `OBSERVABILITY_ALERTS_CHAT_ID` / `PURCHASE_CHAT_ID`（群）；都没配 ⇒ 只记 `observability.alert.skipped`。
- **默认关**（`OBSERVABILITY_ALERTS_ENABLED=false`）：不挂监听器、不发任何消息。

## 打开方式

```bash
# 服务器 .env（改完重启服务生效）
OBSERVABILITY_ALERTS_ENABLED=true
# 可选覆盖（不写就用默认值）
# OBSERVABILITY_ALERTS_WINDOW_MINUTES=15
# OBSERVABILITY_ALERTS_SILENT_MINUTES=60
# OBSERVABILITY_ALERTS_MAX_PER_WINDOW=3
# OBSERVABILITY_ALERTS_SLOW_MS=10000
# OBSERVABILITY_ALERTS_ERROR_RATE_PCT=5
# OBSERVABILITY_ALERTS_MIN_ERRORS=3
# OBSERVABILITY_ALERTS_MIN_TOTAL=20
# OBSERVABILITY_ALERT_CRITICAL_EVENTS=bitable.record.create_failed,bitable.record.update_failed,inventory.change.failed,scan.write.failed,label_print.job.failed
# OBSERVABILITY_ALERTS_OPEN_ID=ou_xxx   # 私发（优先）；只发不收，不恢复私聊录入
# OBSERVABILITY_ALERTS_CHAT_ID=oc_xxx
```

## 实现边界（如实）

- 判定器是**进程内内存窗口**：服务重启后窗口清零（不会误报旧日志，但会丢重启前未凑够的窗口）。
- 只读日志（`addLogListener`），**异常绝不影响业务日志**；发送失败只记 `observability.alert.failed`。
- 事件来自日志字段（`level/event/duration_ms`），不改任何业务链路。
