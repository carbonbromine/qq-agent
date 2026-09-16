# 正式能力固化与实验功能下线

## 当前状态

以下能力已经退出实验 feature flag 生命周期，随 QQ Agent 服务恒定启动：

- 人物统一印象（`IdentityPilotManager` / `IdentityStore`，类名暂保留以避免一次性重命名扩散）
- 好友管理（主动候选、入站好友请求、管理员审批、批准后发送）
- 异常处理基础设施（`IncidentPilotManager`，类名暂保留用于存储/API 兼容）

自动“黑话研究”流水线已退休。手工维护的黑话资产（`data/slang.json` / `AssetObserver`）与研究流水线不是同一能力，继续保留。

“实验功能”设置页本身仍保留，因为多模态上下文、工具调度、关系系统等真正的实验能力仍使用该入口。

## 配置架构

当前 `src/config.js` 是生产配置适配层，`src/config-legacy.js` 暂时承担历史配置格式的归一化、迁移和持久化。生产层把已经固化的旧 gate 规范成常量语义：

- `identityPilot.enabled = true`
- `identityPilot.incomingFriendRequest.enabled = true`
- `identityPilot.friendProposal.enabled = true`
- `identityPilot.friendProposal.activeDispatchEnabled = true`
- `incidentPilot.enabled = true`
- `slangPilot.enabled = false`

旧客户端即使继续提交这些字段，也不能改变上述状态。

人物/好友/Incident 仍保留业务调优参数，例如好友评估阈值、冷却时间、自动白名单、异常保留时间和通知策略。这些参数属于正式能力配置，不应因为删除实验开关而一起删除。

## 全局管理员 QQ

管理员 QQ 只有一个配置真源：

```json
{
  "admin": {
    "ownerUin": "12345678"
  }
}
```

好友审批、入站好友请求通知、异常告警、自动更新失败通知等都使用该管理员。

历史版本曾分别保存：

- `identityPilot.friendProposal.ownerUin`
- `incidentPilot.ownerUin`
- `autoUpdate.ownerUin`
- `slangPilot.ownerUin`

当前行为如下：

1. 旧安装第一次加载且尚无 `admin` 节时，会按 Identity/好友 → Incident → 自动更新 → 退休黑话研究的顺序迁移第一个有效 QQ。
2. `admin` 节一旦存在，就永远是唯一真源；旧模块字段不能反向覆盖它。
3. Identity、Incident、Auto Update 的旧 `ownerUin` 路径暂时作为运行时兼容镜像，由配置层统一覆盖。
4. 自动更新 HTTP API 仍接受历史 `ownerUin` 参数，但会立即写入 `admin.ownerUin`，不会创建新的模块级管理员配置。
5. 退休黑话研究不再保留管理员镜像，也不再保留研究阈值、联网研究等调优项。

配置管理员后，系统自动把该 QQ 加入私聊白名单，并从私聊黑名单移除，确保管理员审批命令不会在消息入口被访问控制提前丢弃。切换或清空管理员时，不自动删除旧管理员原有的普通私聊白名单资格。

## 未配置管理员时

人物/好友/异常基础设施与管理员通知已经解耦：

- IdentityStore、人物索引和好友快照照常启动；
- 入站好友请求仍可持久化；
- Incident 数据库、异常采集和会话控制照常启动；
- 只跳过需要管理员参与的 QQ 通知/私聊审批边缘动作。

自动更新是例外：自动部署失败需要可达的管理员通知目标，因此自动更新已经启用时不允许清空全局管理员 QQ。

## 黑话研究删除边界

自动研究能力不能恢复：

- 配置规范化后 `slangPilot` 只允许保留 `{ enabled: false, graduated: false }`；
- 历史 `ownerUin`、出现次数、研究轮数、联网研究等字段会从规范配置中清除；
- 旧调用方提交这些字段也会在保存后被清除；
- 研究 worker 不会随服务启动，不会扫描消息，也不会创建新的研究任务；
- 已有研究数据库不会在升级时被破坏性删除。

`src/slang-pilot.js` 目前只保留不可运行的兼容 tombstone，因为当前单体 `src/app.js` 仍有静态 import 和旧 API 兼容分支。真正的检测器、研究存储与研究实现已经删除。后续若拆分 `app.js` 路由，可以连同 tombstone 和旧 `/api/slang-pilot/*` 兼容路由一起物理删除。

手工黑话资产仍可以在“观测”相关能力中维护；这不会启动任何自动研究流程。

## UI 固化方式

正式能力拥有独立页面：人物印象、好友管理、异常处理。

`ui/stable-features.js` 现在在现有渲染函数边界执行规范化：

- 实验设置 HTML 在进入 DOM 前移除人物、好友、黑话研究、Incident 的旧实验行；
- 好友/异常页面渲染后移除模块级管理员输入，并保留必要的隐藏兼容值；
- 设置页只展示一个“全局管理员 QQ”入口；
- 好友批准后的发送开关不再展示，因为该能力已固化。

这里不再使用常驻 `MutationObserver` 监听整个页面。消息、状态或列表刷新不会因为“先渲染旧控件、再观察到并删除”而反复改 DOM。

## 兼容层的边界

当前版本仍保留 `config-legacy.js`、Identity/Incident 类名中的 `Pilot` 以及少量旧 API 名称，是为了避免在一次发布中同时改动配置文件格式、数据库文件名、HTTP 客户端和运行时组合根。

这些兼容名称不再代表可启停实验状态。新增代码不得重新读取模块级管理员作为配置真源，也不得新增这些已固化能力的 feature flag。
