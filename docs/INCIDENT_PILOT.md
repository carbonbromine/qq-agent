# 异常处理基础设施试点

## 生命周期

配置位于 `incidentPilot`：

```json
{
  "enabled": false,
  "graduated": false,
  "ownerUin": "",
  "notifyWarnings": true,
  "duplicateWindowMinutes": 10,
  "unknownWritesBlockChat": false,
  "retentionDays": 90
}
```

- `enabled=false` 是默认值。一个从未启用的安装不会创建异常数据库、发送告警或改变会话行为。
- 首次启用后创建 `data/incident-pilot.sqlite`。
- 停用后不再采集、告警或应用群聊策略，但日志数据保留并可只读查看。
- `graduated=true` 只控制“异常”导航入口，不代替运行开关。
- 管理员 QQ 必须位于私聊白名单。

## 异常记录

异常按 code、category、source、chatKey 和脱敏消息生成 fingerprint。
同一 fingerprint 在配置窗口内聚合计数，不重复刷管理员。

记录包含：

- 等级：`info / warning / error / critical`
- 状态：`open / acknowledged / resolved`
- 来源、会话、Session、operation、首次与最近时间
- 脱敏详情、管理员告警状态和解决说明

异常页支持确认、解决和删除。只有已解决日志可以删除。
删除日志不会删除 Session、消息、审批、outbox 或会话运行状态。

模型生成的工具参数不是合法 JSON 时，属于当前模型轮次可自行纠正的输入错误，
不会写入异常日志或通知管理员。`finish` 中能够明确识别为字符串内部未转义引号的
情况会在执行前保守修复并写入 Session 审计；无法安全修复时只把错误回传给模型，
要求重新调用。外部写入失败、工具执行异常和系统错误仍按正常异常策略采集。

## 管理员告警

`error/critical` 首次立即告警，`warning` 由 `notifyWarnings` 控制。
OneBot 离线时保持 pending，恢复连接后发送。

告警使用独立状态机：

```text
pending -> sending -> sent
                   -> failed
                   -> unknown
```

发送结果未知时不自动重试，告警失败也不会递归创建新告警。
通知只携带脱敏摘要和异常编号。

## 会话控制

每个群可选择：

- `auto`：按系统策略运行。
- `blocked`：只归档消息，不调用模型。
- `continue`：忽略软阻塞并继续处理新消息。

全局观察模式、暂停、白名单、时间控制和硬安全限制仍优先。

从阻塞恢复时必须选择积压策略：

- 保留未读，暂不唤醒。
- 仅处理最近 100 条或 32,000 字符。
- 将旧积压标为已读，从下一条新消息开始。

群控制使用版本号防止并发覆盖。

## 未知外部写入

试点默认 `unknownWritesBlockChat=false`：

- 旧 operation 保持 unknown，不自动重试。
- 原批次保持 held，不能重放。
- 后续新消息可启动新 Session。
- Agent 收到“不得重试旧操作”的增量上下文。
- 管理员按 operation 逐条确认已发送或未发送。
- 同一批次的所有 unknown operation 核对后，原 held 批次才结束隔离。

兼容回退可将 `unknownWritesBlockChat=true`，恢复旧的整群阻塞策略。

## API

```text
GET    /api/incident-pilot/status
GET    /api/incidents?state=&severity=&chatKey=&limit=
GET    /api/incidents/:id
POST   /api/incidents/:id/acknowledge
POST   /api/incidents/:id/resolve
DELETE /api/incidents/:id

GET  /api/chats/:kind_:id/runtime-control
PUT  /api/chats/:kind_:id/runtime-control
GET  /api/chats/:kind_:id/unknown-operations
POST /api/chats/:kind_:id/unknown-operations/:operationId/reconcile
```

所有修改接口都需要控制台认证；删除、继续处理和未知写入核对需要显式确认。

## 关闭和回滚

关闭：

1. 在“设置 -> 实验功能”关闭“异常处理基础设施”。
2. 后端立即停止采集、告警和会话策略。
3. `incident-pilot.sqlite` 保留，不自动删除。
4. 旧 outbox 和消息状态不改变。

代码回滚前保持 `enabled=false`。不要删除 `messages.sqlite`、outbox 或未知写入证据。
如需彻底移除异常数据，应先停服务并单独备份后删除 `incident-pilot.sqlite*`。
