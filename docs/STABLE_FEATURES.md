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

## 全局管理员 QQ

管理员身份现在只有一个配置真源：

```json
{
  "admin": {
    "ownerUin": "12345678"
  }
}
```

好友审批、入站好友请求通知、异常告警、自动更新通知等所有管理员能力统一使用 `admin.ownerUin`。

旧版本曾分别保存：

- `identityPilot.friendProposal.ownerUin`
- `incidentPilot.ownerUin`
- `autoUpdate.ownerUin`
- `slangPilot.ownerUin`

这些字段现在只作为兼容镜像，不再是独立配置源。运行时策略会把它们同步成 `admin.ownerUin`，因此旧调用方继续读取也不会得到不同的管理员。

旧安装第一次加载时，如果还没有 `admin` 配置，会按以下顺序迁移第一个有效 QQ：

1. Identity / 好友审批管理员
2. Incident 告警管理员
3. 自动更新管理员
4. 旧黑话研究管理员

一旦 `admin` 节存在，哪怕 `ownerUin` 被明确清空，也不会再次从旧字段反向迁移。

配置全局管理员后，系统会自动把该 QQ 加入私聊白名单，并从私聊黑名单移除。这样管理员发来的好友审批等私聊命令不会在消息入口被访问控制提前丢弃。切换或清空管理员时，不自动删除历史管理员的普通私聊白名单资格，避免误删用户已有访问配置。

配置界面只展示一个“全局管理员 QQ”入口。各业务页面和自动更新页面原有的管理员输入框不再展示；其隐藏兼容字段只用于旧前端保存逻辑，不形成第二配置源。

## 为什么没有直接删除旧配置对象

人物印象、好友审批和异常处理仍有大量稳定的运行参数，例如好友评估阈值、冷却时间、自动白名单、异常保留时间与通知策略。删除整个对象会同时删除这些参数并破坏依赖。

因此只固化生命周期开关，不删除业务调优字段。旧 `ownerUin` 字段同样暂留用于兼容，但由全局管理员策略统一覆盖。

## 管理员 QQ 未配置时

旧实验校验要求开启能力前必须先配置管理员 QQ。正式能力改为恒定启动后，如果继续沿用该校验，老安装或新安装会在保存任意无关设置时失败。

现在基础设施启动与审批通知解耦：

- IdentityStore、消息索引、好友快照和入站请求记录照常启动；
- Incident 数据库、异常采集和会话控制照常启动；
- 缺少管理员 QQ 时，只影响需要管理员参与的通知/审批边缘动作，并通过 `ownerConfigured=false` 与通知错误暴露状态；
- 不会因为未配置 owner 而把基础设施关闭。

自动更新仍然需要管理员用于更新失败通知，因此自动更新已经启用时不允许清空全局管理员 QQ。

## 黑话研究下线

运行时不再构造 SlangPilotManager，也不再扫描消息、创建研究任务或调用联网研究。`src/slang-pilot.js` 暂保留一个不可运行的兼容壳，避免旧的 `app.js` import 在同一版本升级中直接崩溃；研究实现、检测器和研究数据库代码已删除。

已有用户数据不会在升级时主动删除，避免破坏性迁移。控制台不再展示黑话研究入口；手工黑话资产仍在“观测”页工作。

## UI

“实验功能”页面继续保留，因为多模态上下文、工具调度、关系系统等其他实验项仍依赖该页面。这里只移除人物统一印象、自动好友添加、黑话研究、异常处理四个旧实验行；正式能力使用独立业务页面。

设置页顶部统一展示“全局管理员 QQ”，不再让各模块分别维护 owner。
