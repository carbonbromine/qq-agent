# QQ Agent Linux

面向 Linux 服务器的 QQ 群聊 Agent。它直接连接外部 OneBot v11 服务，
每次触发使用独立的 OpenAI Chat Completions 会话，不依赖 DSH、MCP、
Electron 或 Windows 运行环境。

本项目基于 [K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent)
改造，保留上游 Git 历史和 MIT 许可。

## 架构

```text
OneBot WebSocket
  -> 按会话串行入库
  -> SQLite/WAL 消息状态机
  -> 默认随机 8~12 秒、最长 20 秒有界聚合
  -> legacy / threaded / lifecycle 路由
  -> 可选持久化线程与检查点
  -> 一次性 Agent 会话
  -> 会话绑定工具
  -> OneBot HTTP
```

消息只在处理成功后确认。模型或进程失败时，未发送批次自动重试；
发送结果无法确认时进入 `held`，必须人工核对，避免重复发言。

## 全栈一键部署

全新 Linux 机器推荐运行交互式安装器。它会询问部署目录和端口，自动安装
Docker（需要 sudo 确认）、下载 SnowLuma、配置 OneBot、安装 QQ Agent，并生成和
同步全部服务凭据。SnowLuma 已经包含 OneBot，不需要再安装 NapCat 或 Lagrange。

```bash
git clone https://github.com/carbonbromine/qq-agent.git
cd qq-agent
bash deploy-all.sh
```

默认目录为 `/mnt/data/qq-agent`，默认对外端口为：

- `3210`：QQ Agent 控制台；
- `5099`：SnowLuma WebUI；
- `6081`：QQ 登录使用的 noVNC。

OneBot HTTP `3000` 和 WebSocket `3001` 默认只绑定
`127.0.0.1`，不会暴露到局域网。安装器不会要求填写本机 IP，而是在完成后自动
检测并打印访问地址。所有生成的凭据保存在
`/mnt/data/qq-agent/deployment-access.txt`，权限为 `0600`。
脚本不会擅自修改 UFW、firewalld 或云安全组；需要跨主机访问时，应只向可信
局域网或 VPN 放行上述三个用户入口，不要把 noVNC 或 OneBot 暴露到公网。

首次安装会同时询问模型 Base URL、API Key、模型名和 QQ 白名单。基础设施启动后，
打开脚本给出的 noVNC 地址并扫码登录 QQ，再回到终端按 Enter；脚本会验证 OneBot
登录并询问是否激活。确认旧机器人已停止或排除相同群聊后，也可手动执行：

```bash
/mnt/data/qq-agent/app/manage.sh activate --confirm-exclusive
```

无人值守安装可使用：

```bash
bash deploy-all.sh --yes --root-dir /mnt/data/qq-agent \
  --agent-port 3210 --snowluma-port 5099 --novnc-port 6081 \
  --model-base-url https://api.deepseek.com \
  --model-api-key "$DEEPSEEK_API_KEY" --model deepseek-chat \
  --allow-groups 123456789
```

无人值守模式必须提供模型配置，或者显式增加 `--skip-model-config`，部署后再从控制台
填写。白名单可以留空，但机器人在配置允许的会话前不会响应。

仅本脚本管理且配置一致的安装允许重跑。开始写入前会核对 Agent 配置与部署记录、
systemd 服务目录、SnowLuma 容器的 Compose 归属/数据卷，以及端口占用。发现已有
非受管安装、残留不完整状态或后台修改过的凭据时，会报错退出，不覆盖配置或重启服务；
`--yes` 和 `--rotate-credentials` 都不能绕过这一保护。

可先进行只读检查（不创建目录、下载依赖或修改服务）：

```bash
bash deploy-all.sh --check-only --root-dir /mnt/data/qq-agent
```

旧 Bridge/SnowLuma 生产环境应使用 `deploy.sh` 更新 Agent，保留实际数据目录、
监听地址和 OneBot 配置；不要删除已有数据或伪造 `.env` 来绕过检查。全栈检查还需要
`realpath`、`ss`（iproute2）；已有 Docker 但无法读取容器时会安全退出。

受管安装重跑会保留 SnowLuma 数据、QQ 登录态和现有凭据。如需同步轮换 Agent、
OneBot、SnowLuma WebUI 与 noVNC 凭据，增加 `--rotate-credentials`；启用
SnowLuma 2FA 后还需提供 `--snowluma-totp`。完整参数见：

```bash
bash deploy-all.sh --help
```

## 仅部署 QQ Agent

要求：

- Linux + systemd user service
- `curl`、`tar`、`sha256sum`、`rsync`（缺少 Node.js 时自动安装已校验的 Node 22）
- 已运行的 OneBot v11 HTTP 和正向 WebSocket 服务
- OpenAI Chat Completions 兼容模型

```bash
git clone https://github.com/carbonbromine/qq-agent.git
cd qq-agent

bash deploy.sh \
  --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data \
  --host 192.168.31.109 \
  --port 3210
```

`deploy.sh` 不安装 SnowLuma，适合已有 OneBot 服务或只更新 Agent。该脚本会：

- 校验参数、源码和 Node.js `node:sqlite` 能力
- 安装生产依赖
- 自动检测或安装 Node.js 22 运行时
- 初始化独立数据目录和控制台 Token
- 注册并启用 `qq-agent-linux.service`
- 配置进程异常自动重启
- 检查端口冲突和 systemd unit
- 首次安装以 `observe` 模式启动，更新时保留已有运行模式
- 更新前自动创建代码快照，失败时恢复旧代码、配置和服务
- 排除 `.git`、`.dbg`、运行数据、凭据和本地调试记录

查看全部参数：

```bash
bash deploy.sh --help
```

如果已有外部备份流程，可以显式跳过代码快照：

```bash
bash deploy.sh --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data --host 192.168.31.109 --port 3210 \
  --no-backup
```

首次从旧 Bridge 迁移连接配置时可附加：

```bash
  --import-bridge /path/to/old/config.json \
  --credential-file /path/to/credentials.env
```

该操作只复制配置，不修改旧目录或数据。

更新已有安装：

```bash
git pull --ff-only
bash deploy.sh \
  --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data \
  --host 192.168.31.109 \
  --port 3210
```

更新不会重置现有配置或运行模式。默认在
`DATA_DIR/deploy-backups/` 创建部署前代码快照；任何安装、配置、systemd
校验或健康检查失败都会自动恢复旧代码、配置和服务。

部署脚本还会安装独立的 GitHub 更新 service/timer。自动更新默认关闭，可在
“控制 -> 更新部署”配置管理员后恢复。启用后默认每 6 小时浅拉取 `main`，
先执行单元测试，再复用 `deploy.sh` 部署；失败会回滚、停止自动更新并私聊管理员。
详见[自动更新部署](docs/AUTO_UPDATE.md)。

## 运维

```bash
bash manage.sh status
bash manage.sh logs
bash manage.sh health
bash manage.sh token
bash manage.sh restart
bash manage.sh observe
bash manage.sh activate --confirm-exclusive
bash manage.sh update-status
bash manage.sh update-now --confirm
bash manage.sh backup /path/to/new-backup-dir
```

控制台默认端口为 `3210`。Token 可在
`设置 -> 系统 -> 控制台安全` 中轮换。

顶层“控制”页是统一运维入口，集中提供 QQ Agent、DSH、Bridge、SnowLuma 和
QQ 远程桌面的入口与在线状态，并可跳转到模型、搜索、OneBot 和控制台 Token
设置。该页还可手动更新、暂停或恢复自动更新。SnowLuma 登录密钥可在该页直接修改，
密钥仅随单次请求发送，不写入 QQ
Agent 配置或前端存储。旧的 `3110` 门户不再映射。

启用前必须确保旧机器人未处理相同会话，否则会产生双回复。

## 数据

数据默认位于部署参数指定的 `data` 目录：

- `config.json`：配置和凭据，权限 `0600`
- `messages.sqlite`：消息、租约和出站状态
- `sessions/`：每次 Agent 运行记录
- `memory/`：群友长期印象和跨 Session 会话交接状态
- `identity-pilot.sqlite`：实验性统一 QQ 身份索引（仅启用实验开关后创建）
- `relationship-v2.sqlite`：关系 V2 的事件、分层状态与后台评估任务（仅启用后创建）
- `slang-pilot.sqlite`：黑话发现、研究任务和两级审批审计（仅启用后创建）
- `daily-moments.json`：每日群聊总结、说说决策与发布结果
- `qzone-interactions.json`：好友动态未读队列、评论回复和外部写入状态
- `console-access.txt`：控制台地址和 Token，权限 `0600`

“设置 -> 实验功能”只管理实验能力的运行开关与固化状态，不承载业务数据或高级
参数。固化后对应功能会取得独立顶层入口；关闭运行开关不会撤销入口或删除历史数据。
“旧印象”页按 QQ 号聚合白名单会话里的身份、别名、消息统计、好友状态及已有会话
印象，并开放受限的 `person_memory_lookup` 查询工具。“好友管理”页维护主动候选、
收到的好友请求、审批参数及状态。管理员批准主动候选后，系统通过 SnowLuma
`send_packet` 调用已验证的 QQ 好友协议；仅业务响应明确成功才标记已提交，超时、
断线或响应无法解析会进入“发送结果未知”且禁止自动重试。收到 `friend_add` 事件
后才闭环为“已成为好友”。收到的好友请求同样需要管理员审批，同意后调用标准
`set_friend_add_request` 并自动加入私聊白名单。
实现边界见[统一身份试点](docs/IDENTITY_PILOT.md)。

“观测”页展示并管理表情包、黑话与黑话研究数据。人物和旧印象由固化后的独立页面
管理，不再混放在通用观测入口。手动上传的表情保存在数据目录；QQ 收藏表情的删除
只会从 AI 资产库隐藏，不会改动 QQ 客户端收藏。表情图片通过控制台鉴权的同源代理
加载，临时 QQ 图片 URL 不会返回给浏览器。
详细口径见[资产观测](docs/ASSET_OBSERVABILITY.md)。

“设置 -> 实验功能”还可启用黑话语料库试点。白名单群消息先经过本地零 Token
检测，达到频次和人数门槛后进入“观测 -> 黑话研究”。管理员先批准是否消耗模型
和搜索额度进行研究，再批准是否写入候选库；只有之后人工确认的词条才会进入 Agent
上下文，并遵守群内私有或全局安全作用域。实现细节见
[黑话语料库试点](docs/SLANG_PILOT.md)。

每次 Agent 运行仍有独立的审计记录。`lifecycle` 模式会按 `threadId`
持久化 provider transcript（包括工具轨迹和供应商返回的
`reasoning_content`），并在下一批消息中按原顺序续接；结构化 handoff
作为生命周期滚动后的压缩状态继续保留。控制台可检查注入历史、最新完整模型
输入以及逐轮 Token/缓存命中。
生命周期默认在上次请求输入达到 32000 Token 时换代；单次 Agent 运行累计预算
为 160000 Token，追加工具轮会在请求前预估预算并安全收尾。

“设置 -> 聊天设置”可分别配置未思考等待的最短值与最长值。每次自动唤醒会在
范围内重新随机，默认 `8000–12000ms`；连续消息仍由 `maxBatchWaitMs=20000`
限制从首条待处理消息起的最长聚合时间。生命周期的等待批次会立即归入当前
`threadId`，控制台不会先显示独立窗口再合并；新 Session 也不会抢占正在查看的
详情。生命周期批次栏支持横向滚动，切换批次时保留详情和批次栏位置。

顶部状态与用量页均按每次模型调用返回的 `usage`、实际模型和调用时刻计价。
“今日”以及按天统计固定使用 `Asia/Shanghai` 自然日，不受服务器系统时区影响。

“设置 -> 每日动态”可启用每日群聊总结。任务按上海时间运行，读取当天活跃群的
消息、长期记忆和会话交接；模型可以联网研究、查看近期群图或收藏图，最终自行
决定发布或跳过。发布通过 SnowLuma `send_qzone_msg` 完成，并按日期记录幂等状态，
服务重启不会自动重复发布结果不明的说说。

每日动态使用专门的说说提示词，完整读取设置中的角色卡和管理员附加规则，
不再附加普通群聊的工具流程。提示词与设计说明见
[动态提示词](docs/DAILY_MOMENTS.md)。`生成新草稿` 不发布；检查正文后可点击
`发布这份草稿`，直接发送同一份内容，不再次消耗模型 Token。
中断的生成可重新执行；非法模型参数会触发纠错，纠错失败显示“生成失败”。
“发布结果待核对”只能核对空间记录，不能盲目重发。

“设置 -> 动态互动”可按可配置间隔阅览好友动态、决定点赞或评论，并检查自己
动态及已评论动态中的新回复。未阅览内容按最新优先统一提交给模型，超出模型
上下文窗口的旧条目继续保持未读。首次启用默认只建立基线，不突然互动历史内容。
设计、状态与幂等规则见[动态互动](docs/QZONE_INTERACTIONS.md)。

存档页的“主动唤醒”是管理员显式运行：有未读消息时绕过普通响应档位并立即
处理当前批次；没有未读消息时读取该模式配置的最近存档，让模型自行决定是否
发言。该操作仍受运行模式、暂停、白名单、时间控制、并发上限和 `held` 状态保护。

## 时间控制

“设置 -> 时间控制”默认关闭。关闭时忽略全部时间规则，不改变现有唤醒、提示词、
模型请求或消息处理策略。开启后统一使用上海时间，全局规则默认为 DS 低峰：
工作日 `00:00–09:00`、`12:00–14:00`、`18:00–24:00`，周末全天。
每个群聊及私聊均可覆盖为继承全局、DS 低峰、自定义星期/时段或全天活跃。
自定义允许跨午夜，例如周五 `22:00–02:00` 延续至周六凌晨；
`00:00–24:00` 为全天，自定义空时间表表示始终非活跃。

非活跃期消息与拍一拍仅归档，不触发 AI，不积压自动补回复；进入活跃期后新消息
按原模式处理，已归档消息仍可作为历史上下文。模型请求、工具轮、重试、记忆整理
及发送均受时间门控。每日动态与控制台模型测试遵循全局时间表，每日汇总还会排除
当前非活跃的会话；被时间限制挡住的定时动态推迟至活跃窗口。

规则修改即时生效。在途请求跨入非活跃期会被中止，后续请求与发信被拦截；
供应商对已经收到的请求仍可能计费，无法承诺撤销这部分 Token。
发送结果不明确的 `held` 记录不会因时间切换而被丢弃或自动重发。

聊天、密钥、Token 和运行数据均被 Git 忽略。

## 验证

```bash
npm ci --omit=dev --ignore-scripts
npm test
npm audit --omit=dev
bash -n deploy.sh manage.sh
```

详细说明见 [Linux 运维手册](docs/LINUX.md)。
试验性三模式对话引擎见
[Conversation Modes](docs/CONVERSATION_MODES.md)；早期参与者续接方案见
[Threaded Conversation Pilot](docs/THREADED_PILOT.md)。

## 许可

本项目使用 MIT 许可。OneBot 协议端是独立软件，遵循其自身许可。
