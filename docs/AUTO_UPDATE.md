# GitHub 自动更新部署

## 运行边界

自动更新由主进程之外的两个 systemd 用户单元执行：

```text
qq-agent-linux-update.timer
  -> qq-agent-linux-update.service
  -> scripts/auto-update.mjs
  -> deploy.sh
```

timer 每小时唤醒一次，应用配置中的 `intervalHours` 决定是否已经到达实际检查时间。
默认每 6 小时检查一次，功能默认关闭。更新器不复用聊天 Session，也不调用模型。

## 配置

```json
{
  "autoUpdate": {
    "enabled": false,
    "ownerUin": "",
    "repository": "https://github.com/carbonbromine/qq-agent.git",
    "branch": "main",
    "intervalHours": 6,
    "networkRetries": 4,
    "retryBaseMs": 1500,
    "retryMaxMs": 15000,
    "connectivityTimeoutSeconds": 20,
    "fetchTimeoutSeconds": 300,
    "forceHttp11": true,
    "disableOnFailure": true
  }
}
```

- 仓库只接受 GitHub HTTPS 地址。
- 分支名经过格式校验，默认 `main`；控制页可直接切换目标分支。
- `networkRetries` 是网络操作失败后的额外重试次数，范围 0–10。
- 重试采用指数退避：从 `retryBaseMs` 开始，最多增长到 `retryMaxMs`。
- `connectivityTimeoutSeconds` 控制轻量连通性预检超时；`fetchTimeoutSeconds` 控制实际 Git 拉取超时。
- `forceHttp11=true` 时 Git 使用 HTTP/1.1，并设置低速保护，可规避部分 HTTP/2 / GnuTLS 链路抖动。
- `disableOnFailure=true` 保持旧行为：更新失败后暂停后续自动更新；关闭后失败只记录并告警，后续周期继续尝试。
- 管理员 QQ 必须位于私聊白名单（单独的“测试 GitHub 连通性”不要求配置管理员）。
- 控制台“控制 -> 更新部署”可保存网络策略、测试连通性、立即手动更新、暂停或恢复自动更新。

## 更新流程

1. 使用 `data/update-repository.git` 作为持久 bare 仓库，保留 Git 对象缓存。
2. 先执行目标仓库 + 目标分支的 `git ls-remote` 轻量连通性测试；失败时按配置重试。
3. 连通性正常后浅拉取目标分支最新提交；`git fetch` 同样按配置重试。
4. 与 `data/deployed-revision` 比较；相同则记录“已是最新”并结束。
5. 将目标提交检出到 `data/update-work/` 的临时目录。
6. 在独立临时数据目录中执行 `npm ci`、全部 `node:test` 单元测试及关键语法检查，不读取或修改生产数据。
   `npm ci` 使用 `--prefer-offline` 优先复用 npm cache，并把同一组重试参数传给 npm 的 fetch 层。
7. 调用目标提交中的 `deploy.sh`。部署脚本创建代码快照、保留数据和凭据、重装依赖、
   校验 systemd 单元、启动服务并检查 `/healthz`。
8. 成功后记录目标提交；失败时由 `deploy.sh` 恢复旧代码和服务。

`deploy.sh` 会同时安装和校验更新 service/timer，并在部署失败时恢复旧单元及原启用状态。

## 连通性测试

控制页中的“测试 GitHub 连通性”会提交一个独立 `probe` 请求：

- 只检查目标 GitHub 仓库和目标分支能否通过 Git transport 获取 revision。
- 会应用 HTTP/1.1、超时、重试和指数退避设置。
- 不执行 `git fetch`、`npm ci`、测试或部署。
- 测试失败不会修改自动更新开关，也不会发送部署失败告警。
- 结果保存在 `data/auto-update.json` 的 `connectivity` 字段中，控制页可看到尝试次数、耗时、目标 revision 和错误。

## 失败策略

检查、测试或部署失败都会在 `data/auto-update.json` 保存失败阶段、脱敏错误和目标提交，并在服务可用且 OneBot 已连接后向管理员发送一次通知。

`disableOnFailure=true` 时：

1. 将 `autoUpdate.enabled` 持久化为 `false`。
2. `autoDisabled=true`，timer 后续唤醒不会继续部署。
3. 管理员核对后可从控制页恢复自动更新。

`disableOnFailure=false` 时：

1. 自动更新开关保持原状。
2. `autoDisabled=false`，下一个检查周期仍会继续尝试。
3. 告警会明确说明自动更新保持启用，而不是误报“已停止”。

通知发送失败时保留 pending 状态，Agent 启动或 OneBot 重连后继续发送。不会因为告警失败再次触发部署，也不会递归创建异常。

## 状态与运维

状态文件：

```text
data/auto-update.json
data/auto-update-request.json
data/deployed-revision
```

接口：

```text
GET  /api/auto-update/status
PUT  /api/auto-update/settings
POST /api/auto-update/run
POST /api/auto-update/pause
POST /api/auto-update/resume
POST /api/auto-update/notify-pending
```

高级网络配置由控制页通过通用 `/api/config` 持久化；连通性测试使用一次性的 `probe` 请求，不新增额外常驻服务。

命令：

```bash
manage.sh update-status
manage.sh update-now --confirm
manage.sh update-pause --confirm
manage.sh update-resume --confirm
```
