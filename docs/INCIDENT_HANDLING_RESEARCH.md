# 异常处理、管理员告警与会话控制调研方案

日期：2026-09-14
状态：待评审，未实现、未修改生产配置。

## 1. 结论

建议不要把“异常”“阻塞”“日志”合并成一个布尔开关，而是拆成三套彼此独立的状态：

1. **异常事件**：记录发生了什么，负责去重、告警、确认、解决和删除。
2. **外部写入隔离**：只保护结果未知的那一次发送、好友申请或动态操作，永不自动重试。
3. **会话运行模式**：每个群独立选择自动、人工阻塞或强制继续，决定新消息是否运行 Agent。

推荐默认行为：

```text
普通异常 -> 记录 -> 必要时通知管理员 -> 当前操作失败或降级 -> 后续会话继续
明确外部失败 -> 记录并通知 -> 不标记未知 -> 后续会话继续
外部结果未知 -> 隔离该写入 -> 立即通知 -> 不重试旧操作 -> 后续新会话可继续
存储损坏/账号错位/权限边界破坏 -> 硬阻塞受影响范围 -> 立即通知管理员
管理员手动阻塞 -> 只归档消息，不运行模型、不发送
```

这意味着不再使用“存在任意 `held` 就拒绝整个群所有唤醒”的粗粒度规则。
未知写入仍然保持保守，但隔离粒度从“整个群”缩小到“具体外部操作”。

## 2. 与当前实现的差异

当前代码已经具备部分基础能力：

- `messages.sqlite` 保存消息租约、运行状态和 outbox。
- `outbox` 区分 `sending/sent/failed/unknown`。
- Session JSON 保存模型、工具、错误和 Token。
- 控制台群聊页已有“重试失败批次”和“确认发送结果”按钮。
- 好友和黑话模块已有向管理员私聊通知的局部实现。
- systemd journal 保存进程级日志。

当前不足：

- `src/orchestrator.js` 在唤醒前检查 `chatMeta.held > 0`，一个未知写入会停止整个群。
- 没有统一异常 ID、分类、严重度、状态、去重和通知记录。
- 同一错误可能同时出现在工具结果、Session、SQLite 和 journal，无法关联。
- 普通业务拒绝、模型参数错误和真正未知外部写入没有统一策略表。
- 好友/黑话管理员配置不能自然承担全局运维告警。
- 当前“确认发送结果”既在清 outbox，又在解除消息 hold，语义过重。
- 应用没有可删除的异常日志；Session 和 journald 也不是异常管理页面。
- 每个群没有持久化的独立运行模式。

最近发生的 UID 解析失败和拍一拍失败已经证明：明确失败若被误判成未知，
会让关键词和 @ 在触发判定之前被拦截。该具体缺陷已修复，但需要统一机制防止同类问题再次出现。

## 3. 实施顺序建议

虽然本需求表述为“其他功能完成后再完善”，建议调整顺序：

1. 先实现异常核心、日志和告警。
2. 再实现消息触发式主动好友评估。
3. 好友评估直接复用统一异常和告警机制。

原因是主动好友评估将新增后台模型请求、概率任务、管理员通知和审批状态。
如果先完成它再补异常机制，会产生第二套临时错误处理和迁移成本。

不要求一次改完全部模块。可以先让聊天、发送和进程边界接入，再扩展到动态、黑话和好友。

## 4. 异常分类模型

所有跨模块异常使用结构化 `AppIncidentError` 或等价描述，不再依赖错误文本正则决定行为。

建议字段：

```json
{
  "code": "ONEBOT_ACTION_REJECTED",
  "category": "external_write",
  "severity": "error",
  "scope": "chat",
  "outcome": "failed",
  "retryPolicy": "none",
  "blockPolicy": "none",
  "notifyPolicy": "immediate",
  "safeMessage": "群聊发送被 OneBot 明确拒绝"
}
```

### 4.1 分类与默认策略

| 类型 | 示例 | 当前操作 | 后续会话 | 管理员通知 |
| --- | --- | --- | --- | --- |
| 输入/工具校验 | ID 类型错误、参数缺失、JSON 不合法 | 返回模型纠正 | 继续 | 同类反复出现才汇总 |
| 可选能力失败 | 看图失败、表情失效、转发过期 | 降级或跳过 | 继续 | 记录；达到阈值通知 |
| 模型暂时失败 | 429、5xx、网络超时 | 有界重试；失败后释放批次 | 继续 | Session 最终失败时通知 |
| 外部明确失败 | OneBot 明确 `retcode != 0` | 不重试当前写入，可让模型修正 | 继续 | 首次立即通知 |
| 外部结果未知 | 请求发出后断线、超时、响应无法解析 | 隔离该 operation | 继续新消息，禁止重放旧写入 | 立即通知 |
| 数据完整性错误 | SQLite 损坏、事务无法提交、状态版本冲突 | 停止受影响模块 | 硬阻塞受影响范围 | 立即通知并升级 |
| 身份/权限错误 | 登录账号变化、白名单撤销、管理员失配 | 取消操作 | 硬阻塞受影响功能 | 立即通知 |
| 进程级错误 | uncaught exception、反复崩溃 | 退出交 systemd 拉起 | 全局健康异常 | 尽力告警并在重启后补报 |

### 4.2 什么是“常规异常”

以下默认不阻塞群聊：

- 参数校验失败。
- 工具不存在或模型给出畸形参数。
- 图片、表情、网页等可选素材读取失败。
- OneBot 返回明确业务失败。
- 单次模型请求失败或达到轮次预算。
- 单个实验模块研究失败。
- 调度任务失败。

这些错误可以令当前操作失败，但不得形成永久 `held`，也不得阻止下一条关键词或 @。

以下不是常规异常：

- 数据库损坏或事务一致性无法保证。
- 无法确认当前 QQ 账号。
- 安全权限校验失效。
- 外部写入结果未知。

即使是外部写入未知，也只隔离具体 operation。好友申请、审批、动态发布等不可幂等操作
继续沿用“不自动重试”；它们不应无条件冻结同群的普通聊天。

## 5. 会话状态与外部写入隔离

### 5.1 分离三种状态

```text
operatorMode: auto | blocked | continue
effectiveState: normal | degraded | blocked
operationState: pending | sending | sent | failed | unknown | reconciled
```

- `operatorMode` 是管理员选择，持久化并跨重启保留。
- `effectiveState` 是策略引擎计算结果。
- `operationState` 只描述一次外部写入。

禁止再从 `outbox unknown` 直接推导“整个 chat blocked”。

### 5.2 三个群聊模式

| 模式 | 行为 |
| --- | --- |
| 自动 | 推荐默认值。常规异常继续；硬安全错误阻塞；未知写入只隔离原操作 |
| 阻塞 | 新消息继续归档，但不租约、不调用模型、不发送；保留未读 |
| 继续 | 忽略软阻塞并处理新消息；仍不能重试未知旧写入，也不能绕过全局观察模式、白名单、时间控制、账号校验或数据库完整性保护 |

“继续”不是“忽略所有安全检查”。硬安全条件始终优先。

### 5.3 未知写入后的聊天行为

建议将当前 `held` 拆成：

- 原输入批次标记为 `completed_uncertain`，禁止重新运行。
- outbox 保留 `unknown`，等待人工核对。
- 后续新消息可以建立新 Session。
- 下一轮上下文加入短提示：存在一条未核对发送，禁止重复其正文或动作。
- 对相同 payload hash、目标和 operation type 保持去重。
- 管理员确认后把 operation 标记为 `reconciled_sent` 或 `reconciled_failed`。

不能因为允许新会话而重发旧内容。对主动好友申请、说说发布等高风险写入，
未知状态仍锁定该实体和动作类型，直到人工核对。

### 5.4 从阻塞恢复时如何处理积压

切换“阻塞 -> 自动/继续”时不能默认一次处理全部历史消息。弹出三个明确选项：

1. **从下一条新消息开始**：将旧未读归档为已读，推荐默认。
2. **处理最近一批**：只处理最近 100 条或 32,000 字符。
3. **保留未读，暂不唤醒**：仅切换模式，等待管理员手动唤醒。

每个选项显示将影响的消息数量，避免再次出现上千条积压突然补答。

## 6. 管理员告警

### 6.1 独立配置

不要复用 `identityPilot.friendProposal.ownerUin` 作为隐式全局管理员。
新增独立配置：

```json
{
  "incidentAlerts": {
    "enabled": true,
    "adminUins": ["2948771712"],
    "notifyWarnings": true,
    "duplicateWindowMinutes": 10,
    "digestIntervalMinutes": 15,
    "maxImmediatePerHour": 20
  }
}
```

管理员必须是有效 QQ 且位于私聊白名单。上线时显式写入现有管理员，
旧安装不能仅因为升级代码就静默开始向某个历史 owner 发告警。

### 6.2 通知策略

“所有异常都有记录”与“每次错误都发一条 QQ”应分开，否则模型参数纠错会刷屏。

- `critical`：立即发送，每个 incident 首次一次。
- `error`：首次立即发送；重复错误在窗口内只累计计数。
- `warning`：首次可发送；同类重复合并进 15 分钟摘要。
- `info`：只记录，不主动发送。
- 同一 fingerprint 在 10 分钟内合并，记录 `count/firstAt/lastAt`。
- 未解决错误持续 30 分钟或次数达到阈值时升级提醒。

模型在同一 Session 内纠正成功的参数错误记录为 `info`；
导致 Session 最终失败或连续三次相同错误才升级为 `warning/error`。

### 6.3 告警内容

管理员消息只包含：

```text
【QQ Agent 异常】
等级：错误
模块：群聊发送
会话：28届游戏策划想要工作（1044877051）
结果：OneBot 明确拒绝；会话未阻塞
次数：1
编号：inc_xxx
处理：控制台 → 异常
```

不得包含 API Key、Token、完整 prompt、完整聊天原文、Cookie、图片 URL 查询参数或内部堆栈。
详情页可以展示脱敏 stack、关联 Session 和 operation ID。

### 6.4 告警本身失败

告警发送必须使用独立 `AlertDispatcher`，不能走普通 Agent 会话，也不能递归生成告警：

- 发送前持久化 `pending`。
- 明确失败记为 `failed`，有限重试或等待人工修配置。
- 结果未知记为 `unknown`，不自动重试。
- OneBot 离线时保持 `pending`，连接恢复后发送。
- 告警发送异常只更新该 delivery，不再创建“告警发送失败”的新 incident。
- 控制台红点始终有效，即使 QQ 通知不可达。

## 7. 异常日志

### 7.1 独立存储

新增 `data/incidents.sqlite`，不把异常管理建立在 journal 文本解析上。

建议表：

```text
incidents
  id, fingerprint, code, category, severity, source
  chat_key, session_id, operation_id
  state, count, first_at, last_at
  safe_message, safe_details_json, stack_hash
  acknowledged_at, resolved_at, resolution

incident_occurrences
  id, incident_id, at, safe_details_json

alert_deliveries
  id, incident_id, admin_uin
  state, attempt_id, attempted_at, error

chat_runtime_controls
  chat_key, operator_mode, reason
  version, updated_at, updated_by
```

写入使用事务和原子状态迁移。数据库损坏时使用最小的紧急 JSONL 兜底，
重启后导入；兜底日志设置 `0600` 且大小封顶。

### 7.2 状态

```text
open -> acknowledged -> resolved -> deleted
```

- `acknowledged` 表示管理员已看到，不代表问题已解决。
- `resolved` 必须填写解决方式。
- 同类错误复发时可重新打开或创建新 incident，策略需固定。

### 7.3 删除语义

提供单条删除、批量删除已解决日志、按日期清理：

- 删除只删除异常中心记录和 occurrence。
- 不删除消息、记忆、审批、outbox 或业务状态。
- 不自动解除 unknown operation，不自动恢复群聊。
- 不自动删除关联 Session 文件。
- systemd journal 由操作系统维护，应用无法承诺逐条删除。
- 已发送到管理员 QQ 的消息也无法随本地日志删除。

未解决的 `critical` 默认不允许直接删除，须先解决；允许“确认并解决后删除”组合操作。
自动保留期建议： occurrence 30 天、已解决 incident 90 天、未解决 incident 不自动删除。

敏感字段写入前脱敏，不依赖展示时再遮盖。

## 8. 每个群的控制按钮

### 8.1 交互建议

在“存档”群列表每行增加一个盾牌图标按钮，颜色表达有效状态：

- 绿色盾牌：自动/正常。
- 黄色盾牌：降级运行，有异常或未知 operation。
- 红色锁：管理员阻塞。
- 蓝色播放：管理员强制继续。

按钮悬停显示原因和最后更新时间。点击后打开小菜单或模态框：

```text
自动处理（推荐）
阻塞会话
继续处理新消息
```

三态不能用一个无说明的二元 toggle。使用图标按钮加 tooltip，状态选择使用单选菜单。
手机端按钮保持固定 32px，不挤压群名和未读数。

群详情工具栏同步展示：

- 当前模式和有效状态。
- 阻塞/降级原因。
- 未解决 incident 数。
- 未知 operation 数。
- “查看异常”“更改模式”操作。

现有“确认发送结果”改名为“核对未知写入”，只处理选中的 operation，
不再一次清理整个群所有未知项。

### 8.2 权限和并发

- 仅控制台管理员可修改。
- API 使用 `expectedVersion`，防止两个页面覆盖彼此。
- 修改需记录操作者、原因和时间。
- 切换到“继续”且存在未知写入时必须二次确认。
- 已运行的 Session 切换阻塞时通过 AbortController 取消；若已经进入外部写入，
  仍按实际 operation 状态处理。

### 8.3 API 草案

```text
GET    /api/incidents?state=&severity=&chatKey=&source=&limit=
GET    /api/incidents/:id
POST   /api/incidents/:id/acknowledge
POST   /api/incidents/:id/resolve
DELETE /api/incidents/:id
POST   /api/incidents/delete-resolved

GET    /api/chats/:kind_:id/runtime-control
PUT    /api/chats/:kind_:id/runtime-control
       {mode, reason, expectedVersion, backlogAction, confirm}

GET    /api/chats/:kind_:id/unknown-operations
POST   /api/chats/:kind_:id/unknown-operations/:operationId/reconcile
       {result:"sent"|"failed", confirm:true}
```

删除、解决、切换继续及核对写入都是不同接口，避免一个按钮产生多个隐式副作用。

## 9. 代码结构

建议新增：

```text
src/incident-store.js
src/incident-manager.js
src/incident-errors.js
src/alert-dispatcher.js
src/chat-runtime-control.js
```

职责：

- `incident-errors`：错误 code、分类、严重度和默认策略。
- `incident-store`：事件、occurrence、通知和群模式持久化。
- `incident-manager`：去重、升级、解决、删除和 SSE。
- `alert-dispatcher`：管理员私聊通知及不可递归的发送状态机。
- `chat-runtime-control`：合并全局模式、访问控制、时间控制、人工模式和硬安全状态。

现有模块只通过窄接口接入：

```js
incidentManager.capture(error, context)
incidentManager.resolve(id, resolution)
chatRuntimeControl.effectiveState(chatKey)
```

低层只标注错误并抛出，最外层边界捕获一次，避免同一个异常被记录五遍。

首批接入点：

1. `server.js`：`uncaughtException/unhandledRejection/start/stop`。
2. `app.js`：HTTP、OneBot ingress、模块启动。
3. `orchestrator.js`：Session 最终失败及取消。
4. `sender.js/onebot.js`：外部写入明确失败与未知结果。
5. `daily-moments.js/qzone-interactions.js`：调度与外部写入。
6. `identity-pilot.js/slang-pilot.js`：研究、审批和好友协议。

## 10. 与当前状态机的迁移

迁移必须保守：

- 现有 `outbox unknown` 原样保留，不自动重试。
- 现有 `messages held` 转成 `completed_uncertain` 前先备份并建立 incident。
- 不在升级时自动解除未知写入。
- `chat_runtime_controls` 默认 `auto`。
- 新策略先以 `policyMode=legacy` 安装，后台可动态切到 `pilot`。
- 先选指定群试点，不要求重启切换。
- 旧“确认发送结果”在兼容期继续可用，但内部改为逐 operation 核对。

建议配置：

```json
{
  "incidentHandling": {
    "enabled": true,
    "policyMode": "legacy",
    "pilotChats": [],
    "ordinaryErrorsBlock": false,
    "unknownWritesBlockChat": false,
    "retentionDays": 90
  }
}
```

`ordinaryErrorsBlock` 最终应固定为 `false`，试点期间仅用于快速回退。
`unknownWritesBlockChat=false` 不代表重试未知写入，只表示新消息可继续处理。

## 11. 测试矩阵

### 11.1 异常策略

- 参数校验失败有日志、可纠正、下一条 @ 正常唤醒。
- OneBot 明确失败记 `failed`，通知管理员，不产生 chat hold。
- 网络断线或响应损坏记 `unknown`，旧 payload 不重试。
- 未知写入存在时，新关键词/@ 仍可启动独立 Session。
- 数据库损坏触发硬阻塞，不能被“继续”绕过。
- 同一异常跨多个 catch 边界只产生一个 incident。

### 11.2 告警

- 首次 error/critical 发送一次。
- 10 分钟内重复错误只更新 count，不刷屏。
- OneBot 离线保持 pending，恢复后只发一次。
- 告警发送明确失败不递归告警。
- 告警发送结果未知不自动重试。
- 多管理员分别维护 delivery 状态。
- 消息中不存在凭据、完整聊天原文和敏感 URL。

### 11.3 群聊控制

- `blocked` 只归档，不调用模型。
- `auto/continue` 恢复后按明确 backlogAction 行动。
- 模式跨重启保持。
- expectedVersion 冲突返回 409。
- 强制继续不能绕过 observe、白名单、时间控制和硬安全错误。
- 运行中切阻塞能取消模型，外部写入阶段不会伪报未发送。

### 11.4 日志

- 过滤、分页、详情、SSE 数量和状态准确。
- 删除 resolved 日志不改变消息/outbox/会话模式。
- open critical 不能直接删除。
- 批量清理只命中条件内日志。
- 损坏数据库 fail closed，并写入有界紧急日志。

测试全部使用 mock OneBot/模型，不发送真实消息。

## 12. 发布和验收

### 阶段 A：只记录

- 上线 incident store 和采集边界。
- 不改变现有阻塞策略，不发送管理员消息。
- 比较 Session、journal 与 incident 数量，消除重复和漏报。

### 阶段 B：告警

- 配置管理员并启用通知。
- 先只发送 critical/error，验证去重和离线补发。
- 观察 3 至 7 天，调整 warning 摘要阈值。

### 阶段 C：指定群非阻塞试点

- `unknownWritesBlockChat=false` 只对指定群生效。
- 验证未知旧操作没有重试，后续关键词/@ 正常运行。
- 验证管理员能逐 operation 核对。

### 阶段 D：全量与 UI

- 所有群展示模式按钮和状态。
- 上线异常中心、删除和批量清理。
- 保留 `legacy/pilot` 动态回切，数据不丢失。

验收指标：

- 普通异常导致整群永久阻塞：0。
- 未知外部写入自动重试：0。
- error/critical 事件持久化覆盖率：100%。
- OneBot 在线时首次 critical 告警在 60 秒内送达。
- 同 fingerprint 告警在窗口内不重复刷屏。
- 删除日志不改变任何业务状态。
- 切换群模式后无需重启即可生效。

## 13. 明确不做

- 不把所有 `console.error` 文本原样私聊给管理员。
- 不让 Agent 自己决定是否阻塞或删除异常。
- 不允许“继续”绕过安全、账号、权限和数据完整性门禁。
- 不因删除日志而删除聊天记录、审批记录或未知写入证据。
- 不自动重试任何结果未知的外部写入。
- 不依赖 journald 作为产品级异常数据库。
- 不在一个全局布尔值里混合会话暂停、异常确认和外部写入核对。

## 14. 推荐实施范围

第一版建议交付：

1. 统一异常模型与 `incidents.sqlite`。
2. 聊天、发送、进程边界接入。
3. 管理员 QQ 告警和去重。
4. 每群 `auto/blocked/continue` 控制。
5. 未知写入与会话解耦。
6. 异常中心的查看、解决和删除。
7. `legacy/pilot` 动态切换、完整回归和生产试点。

好友、黑话、每日动态和空间互动随后逐模块迁移到同一接口，避免一次改动扩大故障面。
