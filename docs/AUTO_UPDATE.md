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
    "intervalHours": 6
  }
}
```

- 仓库只接受 GitHub HTTPS 地址。
- 分支名经过格式校验，默认 `main`。
- 管理员 QQ 必须位于私聊白名单。
- 控制台“控制 -> 更新部署”可保存设置、立即手动更新、暂停或恢复自动更新。

## 更新流程

1. 使用 `data/update-repository.git` 作为持久 bare 仓库，只浅拉取目标分支最新提交。
2. 与 `data/deployed-revision` 比较；相同则记录“已是最新”并结束。
3. 将目标提交检出到 `data/update-work/` 的临时目录。
4. 在独立临时数据目录中执行 `npm ci --ignore-scripts`、全部 `node:test` 单元测试
   及关键语法检查，不读取或修改生产数据。
5. 调用目标提交中的 `deploy.sh`。部署脚本创建代码快照、保留数据和凭据、重装依赖、
   校验 systemd 单元、启动服务并检查 `/healthz`。
6. 成功后记录目标提交；失败时由 `deploy.sh` 恢复旧代码和服务。

`deploy.sh` 会同时安装和校验更新 service/timer，并在部署失败时恢复旧单元及原启用状态。

## 失败策略

任何检查、测试或部署失败都会：

1. 将 `autoUpdate.enabled` 持久化为 `false`。
2. 在 `data/auto-update.json` 保存失败阶段、脱敏错误和目标提交。
3. 停止后续自动部署尝试；timer 后续唤醒只做关闭检查，不拉取代码。
4. 服务可用且 OneBot 已连接后，向配置的管理员发送一次失败通知。

通知发送失败时保留 pending 状态，Agent 启动或 OneBot 重连后继续发送。不会因为告警失败
再次触发部署，也不会递归创建异常。

管理员核对失败原因后，可在控制台点击“恢复自动更新”。“手动更新”即使自动更新已暂停
也可使用；手动更新失败同样会保持自动更新关闭。

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

命令：

```bash
manage.sh update-status
manage.sh update-now --confirm
manage.sh update-pause --confirm
manage.sh update-resume --confirm
```
