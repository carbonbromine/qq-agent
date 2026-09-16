# 正式能力固化与实验功能下线

## 目标

以下能力不再属于实验 feature flag，随 QQ Agent 服务恒定启动：

- 人物统一印象（IdentityPilotManager / IdentityStore）
- 自动好友添加（主动候选、入站好友请求、批准后主动发送）
- 异常处理基础设施（IncidentPilotManager）

“黑话研究”自动研究流水线下线。手工维护的黑话资产库（`data/slang.json` / AssetObserver）不是同一能力，继续保留。

## 兼容策略

`src/config.js` 是正式策略门面，原来的配置迁移、归一化和持久化实现保留在 `src/config-legacy.js`。这样旧模块继续使用同一组配置 API，不需要在一次发布里重写所有调用方。

门面强制以下不变量：

- `identityPilot.enabled = true`
- `identityPilot.incomingFriendRequest.enabled = true`
- `identityPilot.friendProposal.enabled = true`
- `identityPilot.friendProposal.activeDispatchEnabled = true`
- `incidentPilot.enabled = true`
- `slangPilot.enabled = false`

历史 `config.json` 中相反的值会在加载时被覆盖，并在下一次防抖保存时写回规范值。直接调用 `/api/config` 尝试修改这些旧开关也不会改变运行状态。

## 为什么没有直接删除旧配置对象

人物印象、好友审批和异常处理仍有大量稳定的运行参数，例如好友评估阈值、冷却时间、自动白名单、异常保留时间与通知策略。删除整个对象会同时删除这些参数并破坏依赖。

因此只固化生命周期开关，不删除业务调优字段。

## 管理员 QQ 未配置时

旧实验校验要求开启能力前必须先配置管理员 QQ。正式能力改为恒定启动后，如果继续沿用该校验，老安装或新安装会在保存任意无关设置时失败。

现在基础设施启动与审批通知解耦：

- IdentityStore、消息索引、好友快照和入站请求记录照常启动；
- Incident 数据库、异常采集和会话控制照常启动；
- 缺少管理员 QQ 时，只影响需要管理员参与的通知/审批边缘动作，并通过 `ownerConfigured=false` 与通知错误暴露状态；
- 不会因为未配置 owner 而把基础设施关闭。

## 黑话研究下线

运行时不再构造 SlangPilotManager，也不再扫描消息、创建研究任务或调用联网研究。`src/slang-pilot.js` 暂保留一个不可运行的兼容壳，避免旧的 `app.js` import 在同一版本升级中直接崩溃；研究实现、检测器和研究数据库代码已删除。

已有用户数据不会在升级时主动删除，避免破坏性迁移。控制台不再展示黑话研究入口；手工黑话资产仍在“观测”页工作。

## UI

“实验功能”页面继续保留，因为多模态上下文、工具调度、关系系统等其他实验项仍依赖该页面。这里只移除人物统一印象、自动好友添加、黑话研究、异常处理四个旧实验行；前三个正式能力使用独立业务页面。
