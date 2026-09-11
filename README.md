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
  -> 10~20 秒有界聚合
  -> legacy / threaded / lifecycle 路由
  -> 可选持久化线程与检查点
  -> 一次性 Agent 会话
  -> 会话绑定工具
  -> OneBot HTTP
```

消息只在处理成功后确认。模型或进程失败时，未发送批次自动重试；
发送结果无法确认时进入 `held`，必须人工核对，避免重复发言。

## 一键部署

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

部署脚本会：

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

## 运维

```bash
bash manage.sh status
bash manage.sh logs
bash manage.sh health
bash manage.sh token
bash manage.sh restart
bash manage.sh observe
bash manage.sh activate --confirm-exclusive
bash manage.sh backup /path/to/new-backup-dir
```

控制台默认端口为 `3210`。Token 可在
`设置 -> 系统 -> 控制台安全` 中轮换。

启用前必须确保旧机器人未处理相同会话，否则会产生双回复。

## 数据

数据默认位于部署参数指定的 `data` 目录：

- `config.json`：配置和凭据，权限 `0600`
- `messages.sqlite`：消息、租约和出站状态
- `sessions/`：每次 Agent 运行记录
- `memory/`：群友长期印象和跨 Session 会话交接状态
- `daily-moments.json`：每日群聊总结、说说决策与发布结果
- `console-access.txt`：控制台地址和 Token，权限 `0600`

每次 Agent 运行仍有独立的审计记录。`lifecycle` 模式会按 `threadId`
持久化 provider transcript（包括工具轨迹和供应商返回的
`reasoning_content`），并在下一批消息中按原顺序续接；结构化 handoff
作为生命周期滚动后的压缩状态继续保留。控制台可检查注入历史、最新完整模型
输入以及逐轮 Token/缓存命中。

顶部状态与用量页均按每次模型调用返回的 `usage`、实际模型和调用时刻计价。
“今日”以及按天统计固定使用 `Asia/Shanghai` 自然日，不受服务器系统时区影响。

“设置 -> 每日动态”可启用每日群聊总结。任务按上海时间运行，读取当天活跃群的
消息、长期记忆和会话交接；模型可以联网研究、查看近期群图或收藏图，最终自行
决定发布或跳过。发布通过 SnowLuma `send_qzone_msg` 完成，并按日期记录幂等状态，
服务重启不会自动重复发布结果不明的说说。

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
