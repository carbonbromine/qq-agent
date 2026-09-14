# QQ Agent 架构与微信 Bot 可行性调研

调研日期：2026-09-13。对象：本地 `qq-agent` 及 `192.168.31.109` 上的实际部署。

本文区分已核实事实、工程判断与待验证能力。只进行了源码、配置、运行状态和公开资料检查，没有登录微信、发送消息、调用模型、重启服务或修改业务配置。没有保存连接密码、Token、API Key 或聊天正文。

## 1. 结论

**可以复用现有 Agent 做微信版本，但“微信私聊助手”和“普通微信群里的自主群友”不是同一个接入问题。**

- 微信私聊：优先评估官方 **ClawBot / iLink**。已检查腾讯发布的 `@tencent-weixin/openclaw-weixin@2.4.8`，支持扫码授权、HTTP 长轮询、文本与媒体，适合现有 Linux 主机。其 `src/channel.ts:179-183` 明确声明 `chatTypes: ["direct"]`，不能作为支持普通微信群的依据。
- 企业微信内部协作：官方 **智能机器人 API 长连接** 可接入，提供官方 Node.js SDK，无需公网回调地址。但群聊主要接收 @机器人的消息，不等于读取全群闲聊；官方帮助明确暂不支持外部群/客户群。
- 普通微信群自主互动：本次没有找到已核实、可直接推荐的官方通道。WeChatFerry、Wechaty 的非官方协议提供方、桌面自动化等可以列入实验候选，但登录兼容性、客户端版本、账号限制和持续维护都必须实测。
- 朋友圈：不能把现有 QQ 空间发布、点赞、评论直接平移。官方 ClawBot 的已核实能力不包含朋友圈；企业微信客户朋友圈也不是个人朋友圈自动化的等价接口。

**推荐先做隔离的 ClawBot 私聊试点，保留现有 QQ 服务；若硬目标就是普通微信群，则先验证接入端，接入验证通过后再投入 Agent 迁移。**

## 2. 实际部署

### 2.1 线上事实

| 项目 | 检查结果 |
| --- | --- |
| 操作系统 | Ubuntu 24.04.3 LTS，x86_64 |
| Agent 服务 | 用户级 `qq-agent-linux.service`，`active/running` |
| Node | 独立运行时 Node 22.23.2 |
| 代码目录 | `/mnt/data/qq-agent/app` |
| 运行数据 | `/mnt/data/qq-agent/data` |
| 控制台 | `http://192.168.31.109:3210`，进程直接监听 |
| 运行模式 | `active`，未暂停 |
| 模型配置 | DeepSeek 官方 API，配置模型名 `deepseek-flash` |
| 协议端 | 实际 API 返回 SnowLuma `1.14.15-node`，OneBot `v11` |
| 协议状态 | HTTP `online/good=true`，Agent WebSocket 已连接 |
| 接入范围 | 白名单 5 个群、4 个私聊，空白名单不放行 |
| 会话模式 | 全局统一 `lifecycle` |
| 聚合等待 | 线上 5-15 秒随机，连续消息最长聚合 20 秒 |
| 聊天运行并发 | 最多 2 个 |
| 单次运行预算 | 12 轮、180 秒、累计 160000 Token |
| 已启用 | 每日动态、动态互动、统一身份试点、黑话试点 |
| 未启用 | 时间控制总开关、冷场主动开话题 |
| 留存 | 消息不限条数，Session 审计文件保留 2000 份 |

检查时 `/healthz` 返回 200；服务本次启动以来 `NRestarts=0`。瞬时服务内存约 91 MiB，不包含 QQ 客户端、SnowLuma、DSH 和其他服务，也不是容量测试结果。

对 `app/onebot/orchestrator/store/tools/memory/llm/sender/config/identity-store/daily-moments/qzone-interactions` 共 12 个核心文件进行了 SHA-256 对照，本地与远端一致。工作区存在大量已有未提交改动，因此本文依据当前文件，不把 Git HEAD 当作线上全部代码。

### 2.2 进程与网络

```text
QQ 网络
   |
QQ Linux 客户端 + SnowLuma（独立容器）
   |  OneBot v11 事件 WebSocket: 127.0.0.1:13001
   |  OneBot HTTP 查询/发送:     127.0.0.1:13000
   |
qq-agent-linux.service（单 Node 进程）
   +-- 消息接入、SQLite、编排、工具、记忆
   +-- 每日动态、动态互动、身份/黑话试点
   +-- HTTPS -> DeepSeek / 搜索服务 / 媒体资源
   +-- HTTP + SSE -> 控制台 :3210

独立的旧组件和运维入口：
   DSH           127.0.0.1:3080  <- Nginx LAN :3080
   旧 Bridge     127.0.0.1:3100  <- Nginx LAN :3100（后端本次不可达）
   SnowLuma UI   127.0.0.1:15099 <- Nginx LAN :5099
   QQ noVNC      127.0.0.1:16081 <- Nginx LAN :6081
```

远端 Compose 声明镜像 `motricseven7/snowluma:v1.14.15`、容器名 `qq-bridge-snowluma`；QQ/Xvfb/VNC/Node 进程确实在同一容器 cgroup 中。Docker socket 需要额外 sudo 认证，本次未读取 Docker inspect；运行版本以上述实际 OneBot API 返回为准。

`qq-bridge-dsh.service` 仍运行，但新版 Agent 直接调用模型，不经过它。旧 Bridge 的回环地址没有监听，LAN `:3100` 只是仍保留的 Nginx 映射，不能仅凭这个端口判断旧机器人在线。

## 3. 软件架构

### 3.1 整体形态

这是一个**模块化单体聊天 Agent**，不是微服务集群，也不是通用 DSH/OpenClaw 的薄转发器。生产依赖主要是 `ws`、`undici`、`node-html-parser`、`jce`；SQLite 使用 Node 内置模块，控制台由原生 HTTP 服务和前端 JS/CSS 组成。

| 边界 | 核心文件 | 职责 |
| --- | --- | --- |
| 装配与管理 API | `server.js`、`app.js` | 启停、依赖装配、事件接入、管理接口、鉴权、SSE |
| QQ 通道 | `onebot.js` | WS 心跳/重连、HTTP 调用、消息段转换、引用/转发/媒体提取 |
| 持久消息队列 | `store.js` | SQLite 去重、租约、重试、outbox、线程和检查点 |
| 编排 | `orchestrator.js` | 聚合、触发、运行并发、模型/工具循环、续聊、记忆整理 |
| 模型上下文 | `prompt.js`、`personas.js` | 人设、场景规则、历史、成员印象、handoff、工具规则 |
| 模型客户端 | `llm.js`、`providers.js` | Chat Completions、凭据选择、超时重试、模型目录 |
| 工具与发送 | `tools.js`、`sender.js` | 当前会话绑定工具、发送串行化、限频和出站审计 |
| 记忆 | `memory.js` | 成员印象、原始记忆、整理结果、跨 Session handoff |
| 安全与时间 | `access.js`、`time-control.js`、`time-gate.js`、`safe-fetch.js` | 白名单、暂停、活跃时段、下载边界/SSRF 防护 |
| 表情资产 | `stickers.js`、`sticker-manager.js`、`asset-observer.js` | QQ 收藏同步、本地图片、备注/使用统计、管理端资产视图 |
| 社交任务 | `daily-moments.js`、`qzone-interactions.js`、`qzone-feed.js` | 定时总结、草稿/发布、好友动态阅览与互动 |
| 关系与黑话 | `identity-*.js`、`friend-request-protocol.js`、`slang-*.js` | 跨会话身份、好友审批、黑话发现/研究/收录 |
| 审计与成本 | `sessions.js`、`model-prices.js`、`price-feed.js` | 每轮模型输入/输出/工具轨迹、Token、缓存与计价 |
| 控制台 | `ui/`、`integrations.js` | 配置、存档、运行详情、资产、状态和旧组件入口 |

当前人设运行时来自新 Agent 的 `data/config.json` 中 `persona.roleText` 等字段，内置模板位于 `src/personas.js`。旧项目的 `qq-bridge-linux/roles/小鲸鱼.md` 不是新服务运行时自动读取的角色卡文件。

### 3.2 一条消息的完整路径

1. `OneBotClient` 收到事件，`app.js` 按会话串行处理。
2. 白名单/屏蔽检查后，解析文本、@、引用、合并转发和图片定位信息。
3. 写入 `ChatStore`，以 `(chat_key, mid)` 去重；自己的回显写为 self，非活跃时间可只归档。
4. `Orchestrator` 聚合消息，按 @、关键词、概率、档位或线程状态判断是否启动。
5. 获取持久租约，固定本轮消息快照；同一会话不同时运行两轮。
6. 构造人设、上下文和受限工具列表，请求 OpenAI 兼容 Chat Completions。
7. 执行工具并把结果交回模型，直到 `finish`、自然结束、预算停止或异常。
8. 普通聊天发送通过 `SendQueue`：先记录 outbox 意图，再执行 OneBot 写入，记录响应及 self 消息。
9. 处理成功后确认本批消息；生命周期模式同时提交线程 transcript 和结构化 checkpoint。
10. 运行期间新到的消息留在后续批次，不会被这次确认顺带清掉。

模型普通 assistant 文本**不会直接发给 QQ**，需要显式调用 `send_message` 等工具。工具上下文由程序绑定当前 `chatKey`，模型不能通过该工具任意指定另一个群。它目前没有通用 Shell/任意文件执行工具，迁移微信无需引入这些权限。

### 3.3 三种“会话”边界

| 标识/模式 | 含义 |
| --- | --- |
| `chatKey` | 群或私聊路由，当前是 `group:<QQ群号>` / `private:<QQ号>` |
| `sessionId` | 一次消息批次的 Agent 执行，拥有预算、工具轨迹、发送审计与结果 |
| `threadId` | 多个 Session 共享的对话生命周期 |
| `legacy` | 每批重新按 @/关键词/概率等触发 |
| `threaded` | 增加面向参与者或引用回复的确定性续聊窗口 |
| `lifecycle` | 活跃/倾听期内每批可交给模型，让模型决定回复还是沉默 |

所谓一次性 Session 是执行隔离，不是每轮失忆。`lifecycle` 会在本地 SQLite 保存供应商 transcript，包括工具轨迹及其返回的 `reasoning_content`；下一批重新发送稳定 system 前缀、旧 transcript 和新消息。

等待下一批时不占用持续的模型 HTTP 请求。默认上次输入达到 32000 Token、提示词/工具变化、图片上下文或线程期限等条件会推动换代；关闭后删除活跃 transcript，结构化 checkpoint 和正常审计记录按各自规则保留。

**缓存命中不等于省掉历史网络传输。** 当前 Chat Completions 仍逐次提交完整 `messages`；稳定前缀主要改善供应商计算/缓存计费。本地消息增量入库与有限上下文有利于控制数据量，但不是服务端会话增量协议。

### 3.4 数据与可靠性

`messages.sqlite` 使用 WAL、`synchronous=FULL`，包含：

- `messages` / `chats`：归档、自发消息、待处理状态。
- `runs`：批次租约，数据库约束每个会话最多一个 leased run。
- `outbox`：发送前记录意图，状态包括 `sending/sent/unknown`。
- `conversation_threads` / `thread_turns` / `thread_checkpoints`：生命周期和续接状态。

消息状态是 `pending -> leased -> acked`；失败按情况回到 pending 或进入 failed。已经产生发送效果、部分成功或结果无法确认时，批次会被 held，等待人工核对，不盲目整批重发。

这是合理的“持久处理 + 不确定发送隔离”，**不是外部 exactly-once 保证**。QQ 接口成功响应、实际对方收到、用户阅读不是一回事。微信接入必须继续区分这些层级。

其他持久化：

| 数据 | 载体 |
| --- | --- |
| 配置和凭据 | `config.json`，0600 |
| 成员印象 / handoff | `memory/` 下 JSON |
| 运行审计 | `sessions/` 下 JSON |
| 身份/好友请求 | `identity-pilot.sqlite` |
| 黑话研究/审批 | `slang-pilot.sqlite`，确认资产另有 JSON |
| 每日动态 / 动态互动 | 各自的 JSON 状态记录 |
| 表情和本地图片 | `stickers.json` 及受管文件 |

记忆目前是结构化印象和受限文本注入，不是向量数据库/RAG。SQLite 事务不能把上述所有 JSON 和外部写入合并为一个全局事务。

检查时消息状态为 4079 条 acked、2 条 failed，没有 pending/leased/held；这是瞬时快照，不是历史零故障证明，本次没有修改或重试失败记录。

### 3.5 自主社交并不都是聊天发送

- 每日动态：读取允许的群聊材料和记忆，专用模型任务研究/生成，草稿与发布分离，再调用 SnowLuma `send_qzone_msg`。
- 动态互动：轮询好友动态和评论，模型决定点赞/评论/回复，外部写入前记录自己的状态。
- 身份试点：按 QQ 号汇总可见互动；好友候选需管理员批准，主动申请使用 SnowLuma `send_packet` 的 QQ 协议，入站申请走 `set_friend_add_request`。
- 黑话试点：本地检测候选，经研究审批、收录审批和词条确认后才能进入对应范围的上下文。

这些后台任务有自己的执行与幂等逻辑，并非全部经过 `SendQueue`。聊天并发上限 2 也不应解读成整个进程所有模型任务的统一并发上限。

## 4. 迁移前应明确的边界

### 4.1 不能只替换 onebot.js

| 耦合位置 | 当前假设 | 微信影响 |
| --- | --- | --- |
| `access.js:4-10` | 会话 ID 必须是数字 | `wxid_*`、`*@im.wechat`、企微 userid 会直接被拒绝 |
| `onebot.js:208-274` | 收发和查询大量 `Number(id)`，QQ 消息段 | 必须换平台实现，长 ID 也不能随意转 JS Number |
| `app.js:417-708` | OneBot event、QQ @/引用/转发/好友事件 | 应提取标准事件入库入口 |
| `sender.js:78-82`、`orchestrator.js:648-650` | `chatKey.split(':')` | 加平台/账号命名空间后必须统一解析 |
| `tools.js:399-414` 等 | 记忆和人物工具校验数字 QQ 号 | 工具 schema、校验、说明都需平台化 |
| `memory.js:113-125,436-520` | 会话目录发现、编辑/删除限定数字 ID | 只放宽发送校验仍会造成资产管理失效 |
| `identity-store.js:23-25` 等 | QQ 号作为全局人物身份 | 需引入 provider/account/subject 作用域 |
| `prompt.js`、`personas.js` | QQ 群友规则、QQ 专属工具语义 | 保留性格，分离平台规则与能力描述 |
| `sticker-manager.js` | QQ 收藏接口、短期 rkey、按 QQ 消息刷新 | 本地资产可复用，平台同步/上传需重写 |
| `daily-moments.js`、`qzone-*.js` | QQ 空间接口和 Cookie/关联字段 | 微信首版禁用，不伪造朋友圈等价能力 |
| `ui/`、配置验证、管理员通知 | QQ 标签、数字输入、QQ 私聊审批 | 增加平台感知及独立管理路径 |

不要把微信 ID 哈希成假 QQ 号来骗过旧校验：会掩盖权限、碰撞、身份绑定和审计问题。

### 4.2 保留优点，避免复制历史负担

- 保留：白名单、observe/active、暂停、持久租约、held、工具目标绑定、检查点、预算和审计。
- 提升：原始事件尽早落盘。目前部分引用/转发查询在入库前执行；进程在此期间退出，以及协议断线且上游不回放，都不在 SQLite 租约保障范围内。
- 提升：按通道定义回执语义。API 接受不等于最终送达；本地生成的发送 ID 也不能冒充平台回执。
- 提升：`app.js` 约 2800 行、编排约 2000 行，平台接入和控制台装配有明显集中。优先提取接入/发送/身份边界，不同时重写全部控制台。
- 注意：源码仍有面向开发机调试端点的上报，部分包含消息预览。迁移/发布前应审核并通过显式开关关闭非必要上报，本次没有改动。
- 注意：控制台 LAN HTTP 不加密；新通道的登录态、媒体密钥和会话 token 不应出现在 URL、模型提示词或普通日志里。
- 注意：无限消息留存和多份 Session 输入快照会增长；双平台需要独立预算、留存、备份和数据访问范围。

## 5. 微信接入路线

### 5.1 官方 ClawBot / iLink：私聊首选

证据：[官方发布包][S1]、[发布元数据][S2]、[OpenClaw 微信文档][S3]。本次直接读取了 `2.4.8` 的 README、LICENSE、通道能力、收发和登录源码，没有安装或执行包。

- 插件是腾讯版权、MIT 许可；Node 要求 `>=22`。
- 插件本身依赖 OpenClaw 宿主 `>=2026.5.12`，不能直接当作当前 qq-agent 的插件加载。
- 底层是 iLink HTTP JSON API；源码提供扫码、消息轮询、媒体传输、发送和 token 管理的参考。
- 接收使用 `getupdates` 长轮询，默认等待约 35 秒，有消息可以提前返回，不是固定延迟 35 秒。
- 用 `get_updates_buf` 游标持续同步；发送使用 `sendmessage`，并传递收到消息中的 `context_token`。
- 媒体经过 CDN 上传/下载及相应加解密。不能沿用 QQ 图片 URL 直接发送的假设。
- `src/channel.ts` 仅声明 `direct`，与 OpenClaw 官方文档一致。网上称“原生支持普通微信群”的文章与此冲突，不采纳。

工程上可以在遵守使用条款的前提下，参考 MIT 源码提取独立 `WeixinIlinkAdapter`，继续使用现有 Agent 核心。另一种方式是保留官方插件宿主，新增受限的外部 Agent 桥接，但会多一个运行时和适配边界；并非零改造替换模型地址。

**这是一条与 ClawBot 对话的专用通道，不是接管用户原有微信号的全部好友/群聊。** 不能推导出读取用户全部聊天记录、代替用户回复任意好友、自动加好友或发朋友圈的权限。

仍需实测账号入口/授权、会话 token 生命周期、主动发送限制、断线恢复和媒体支持范围。未找到足以对当前版本作统一承诺的主动推送配额契约，不能把网络文章里的固定数字当作保证。源码 MIT 许可也不等于微信服务的无限制使用授权。

### 5.2 企业微信智能机器人：内部团队路线

证据：[长连接开发文档][S4]、[官方接入帮助][S5]。

- 官方 SDK：`@wecom/aibot-node-sdk`；连接地址 `wss://openws.work.weixin.qq.com`。
- BotID/Secret 订阅，主动从内网建立连接，不需要公网 IP 或回调域名。
- 同一机器人只允许一条有效长连接，新连接会踢掉旧连接；高可用应主备而非双活。
- 单聊以及群聊 @触发可接收；不等价于 QQ 当前对所有白名单群消息的归档和自主续聊。
- 官方文档提供主动推送和流式回复。回复和主动推送合计每会话限制 30 条/分钟、1000 条/小时。
- 文档规定消息回调后 24 小时内可回复；欢迎语是独立的 5 秒窗口，不能套用 QQ 的 5-15 秒聚合等待。
- 图片/文件/视频资源链接只有 5 分钟有效，资源另有 AES 密钥；需要及时安全获取和受管缓存。
- 官方帮助明确暂不支持外部群/客户群，不能经此接入已有普通微信群。

现有 80 条/分钟的 QQ 发送限频不能照搬。即使复用 lifecycle，也只能基于平台实际投递的消息续聊，不能假设机器人听到了群里的其他对话。

### 5.3 普通微信群：非官方实验路线

| 候选 | 已核实的项目形态 | 本次评价 |
| --- | --- | --- |
| WeChatFerry | Windows 客户端 Hook；有文本/@/图片/文件、消息接收、联系人、朋友圈读取等功能；README 的适配记录到微信 `3.9.12.51` | 功能接近需求，但不能据此保证当前账号还能登录指定版本。先做版本和收发验证 |
| Wechaty | Node/TS SDK，跨平台 API，真实微信接入依赖具体 Puppet/服务商 | 框架能跑 Linux，不代表对应微信协议当前可用；单独验证 provider、授权、费用和数据流 |
| wxauto | Windows UIAutomation；当前公开仓库仍标注微信 3.9.X，并有学习用途限制声明 | 桌面依赖、锁屏/界面/焦点、消息标识和版本升级风险明显；不作为首选生产通道 |
| itchat / Gewechat 老教程 | 有依赖方维护者明确公告原依赖已无法用于个人号接入 | 不作为新项目默认底座，下载成功或容器启动不等于登录收发可用 |

证据：[WeChatFerry][S6]、[Wechaty][S7]、[wxauto][S8]、[dify-on-wechat 维护公告][S9]。

若必须试验普通微信群，可考虑：

```text
专用 Windows 机器/虚拟机
  微信客户端 + 验证过版本的接入端
  -> 带鉴权的内部事件通道
192.168.31.109
  -> WechatDesktopAdapter -> 原有 Agent 核心 -> 回送命令
```

Linux 上看到 “Docker 微信机器人” 不代表原生无桌面方案，可能内部仍是 Wine、Windows VM 或远端协议服务。对本项目没有必要为了接入微信把整个 Agent 搬到 Windows。

使用非关键测试账号和知情的测试群，验证异常时暂停，不承诺不会被限制，也不把限频/随机延迟描述为避免封号的保证。本次没有登录任何第三方协议服务，没有验证其中任一方案的真实账号成功率。

### 5.4 其他官方入口

微信公众号、微信客服可用于面向用户的问答服务，但不是普通微信群 Bot。微信客服[发送文档][S10]规定用户主动消息后的 48 小时内最多下发 5 条，用户继续发送后可再次下发；API 成功还需关注发送失败事件。这些限制与 QQ 的短句多气泡、自主发言和持久群友关系不同。

传统企业微信群消息推送 Webhook 是[发通知接口][S11]，不能仅凭它实现接收消息和 AI 对话。不要与智能机器人 API 模式的 Webhook/长连接混为一谈。

## 6. 推荐改造形态

### 6.1 共享核心，显式通道能力

```text
QQ OneBotAdapter --------+
WeixinIlinkAdapter ------+--> 标准事件 -> 持久 Inbox -> 聚合/策略/租约
WeComBotAdapter ---------+                         |
                                                  v
                                  Agent / 人设 / 工具 / 记忆 / 审计
                                                  |
                                   Outbox + 通道策略 + 投递适配
                                                  |
                            QQ / ClawBot 私聊 / 企业微信内部会话
```

这里的“共享”优先指共享实现，不要求第一阶段共享生产进程、数据库或聊天记忆。新通道建议独立服务与数据目录，避免微信实验的重启、限流、凭据问题影响现有 QQ。

最小接口职责：

- `connect/stop/status`：连接、授权、心跳、健康状态。
- 标准入站事件：`platform/accountId/conversationType/conversationId/senderId/messageId/text/mentions/reply/media`。
- `sendText/sendMedia`：只处理当前绑定目标，返回明确的接受/未知/拒绝结果和平台回执信息。
- `capabilities`：是否支持群聊、全消息可见、@、引用、媒体、好友审批、朋友圈。
- 平台策略：消息长度按字符或 UTF-8 字节计量、限频、回复窗口、资源有效期。

默认不支持的能力不注册工具，也不注入提示词。微信私聊首版应关闭 QQ 空间、QQ 收藏同步、拍一拍和好友申请，先复用文本、记忆、搜索、审计，再逐项启用已验证媒体能力。

### 6.2 ID、游标、权限与带宽

- 标识使用平台原生字符串；区分本地消息序号与平台消息 ID。
- 会话/人物用 `platform + accountId + nativeId` 等结构化复合键，统一编码/解析，不靠散落的 `split(':')`。
- 不按同名昵称把 QQ 和微信人物自动合并，也不默认共享私聊记忆。需要明确绑定和可见范围。
- iLink 的 cursor 更新与收到消息的持久入库应具备原子性：先确保消息持久化，不能先推进游标再异步丢到内存队列；恢复后再用消息 ID 去重。
- `context_token`、企微 `req_id`/回复窗口属于通道元数据，不是给 LLM 的聊天正文。
- 继续维持发送前落盘、未知结果 held；不要仅因为存在 `client_id` 或 `req_id` 就假定服务端幂等。
- 内部通道只传增量事件和必要状态，图片按需获取并按内容哈希去重；有限时链接需及时受管缓存，不在每轮同步整个通讯录/历史。

## 7. 试点步骤与验收

以下是后续工作建议，不是本次已经执行的事项。

1. **先验证通道**：ClawBot 账号能否授权、接收一条文本并回一条、重启后恢复。普通微信群路线则先验证确切客户端版本、群 ID/成员 ID 和发送回执。
2. **隔离实例**：新增独立服务、数据目录、控制台 Token 与空白名单；按现有方式默认 observe，不改变现有 QQ 的模式。
3. **最小迁移**：标准事件、字符串 ID、文本发送、权限、租约和持久游标；调整平台提示词和发送限制。
4. **复用智能层**：人设、短期上下文、长期记忆、搜索、成本与审计；私聊缩短聚合等待，默认关闭主动发送。
5. **故障验收**：重复事件、断线重连、进程重启、发送超时/未知、token 失效、长 ID、权限拒绝、媒体过期、双实例冲突和紧急停机。
6. **小范围 active**：显式授权的账号/群逐步启用，观察漏收、重复发送、P95 延迟、Token 成本和限制事件，再决定扩大。

粗略工程量仅供排期：在通道已验证、凭据齐备且不迁移朋友圈的前提下，文本私聊试点约 3-7 个工程日，包含媒体/资产管理和异常恢复的完整试点约 1-3 周。普通微信群通道的登录与兼容性是独立风险，可能直接否决路线，不能包含在固定交付承诺里。

## 8. 证据与未验证项

本地关键代码入口：

- [应用装配与接入](../src/app.js)
- [权限与数字 ID 限制](../src/access.js)
- [QQ 协议客户端](../src/onebot.js)
- [SQLite 消息状态机](../src/store.js)
- [会话编排与生命周期](../src/orchestrator.js)
- [工具定义](../src/tools.js)
- [发送队列](../src/sender.js)
- [记忆存储](../src/memory.js)
- [对话模式说明](CONVERSATION_MODES.md)

公开来源均于 2026-09-13 查询。对接口能力优先采用官方文档和实际发布源码；GitHub README 只能证明项目宣称/适配记录，不能证明用户当前账号可登录。

[S1]: https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin
[S2]: https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/2.4.8
[S3]: https://docs.openclaw.ai/channels/wechat
[S4]: https://developer.work.weixin.qq.com/document/path/101463
[S5]: https://open.work.weixin.qq.com/help2/pc/21657
[S6]: https://github.com/lich0821/WeChatFerry
[S7]: https://github.com/wechaty/wechaty
[S8]: https://github.com/cluic/wxauto
[S9]: https://github.com/hanfangyuan4396/dify-on-wechat
[S10]: https://developer.work.weixin.qq.com/document/path/94677
[S11]: https://developer.work.weixin.qq.com/document/path/91770

没有执行：微信授权/登录、真实微信收发、模型调用验证、非官方协议兼容性测试、完整安全审计、压力测试或现有测试套件。本文结论是架构与接入可行性评估，不是已经上线微信 Bot 的验收报告。
