# 生命周期上下文与运行预算治理

## 结论

群 `1044877051` 的本次故障不是供应商上下文窗口溢出，而是本地
`maxRunTokens=120000` 被同一 Agent 运行内的多次请求累计穿透。

失败 Session `mtxwdixn-5e7073f9` 连续完成了三次模型调用：

| 轮次 | 输入 Token | 缓存命中 | 输出 Token | 本轮合计 | 运行累计 |
|---|---:|---:|---:|---:|---:|
| 1 | 40,879 | 40,320 | 304 | 41,183 | 41,183 |
| 2 | 41,598 | 41,088 | 104 | 41,702 | 82,885 |
| 3 | 41,757 | 41,600 | 69 | 41,826 | 124,711 |

三次请求都被 DeepSeek 正常接受。第三次返回后，下一轮开始前才执行：

```js
if (session.usage.totalTokens >= maxRunTokens) {
  throw new Error('Run token budget exceeded');
}
```

因此错误发生在本地运行预算，不是单请求的模型窗口。第三轮前没有预测
“本轮输入 + 预留输出”是否会越过累计预算，所以允许累计值从 82,885
直接跨到 124,711，随后才报错。

本轮在报错前已成功发送一条文字和一张表情。Outbox 中两个发送均有
`message_id`，但 `failLease()` 将“已有确定发送”与“发送结果不明”都视为
需要人工处理，导致 5 条输入进入 `held`，后续 183 条消息停在 `pending`。

## 上下文为什么增长

该生命周期在约 13.7 分钟内运行 33 次，发起 49 次模型调用：

- 19 次 `noreply`，13 次正常回复，1 次预算错误。
- 单请求输入从 14,931 Token 增长到 41,757 Token。
- 注入的 provider transcript 从空数组增长到 156 条消息、70,739 个 JSON 字符。
- 累计输入 1,398,552 Token，其中 98.26% 命中缓存。
- 每个 Session 平均增加约 838 个下一轮输入 Token。

增长是线性的 append-only，不是每轮重新注入全部群历史。首次运行注入历史，
后续运行只追加新增群消息、模型推理、工具调用/结果和终止状态。

主要常驻内容：

- System prompt：约 11K 字符。
- 33 次用户增量，其中每次都含生命周期状态和检查点。
- 80 条 assistant 消息，含约 16.5K 字符 `reasoning_content`。
- 48 次历史工具调用，其中 `finish` 33 次、`send_message` 14 次。
- 48 条 tool result。

保留这些内容能维持推理连续性和 DeepSeek 前缀缓存，但高活跃群中每条消息都会
确定性唤醒生命周期，导致同一长前缀被高频重放。缓存降低价格和延迟，不会减少
请求 Token 计数，也不会减少发送给 API 的请求体。

## 当前三个预算不是一回事

### 1. 模型上下文窗口

限制单个请求中的输入、工具定义和预留输出。当前最大实测输入为 41,757 Token，
供应商正常响应。DeepSeek 当前官方 Flash 模型上下文为 1M，旧
`deepseek-v4-flash-vision-exp` 名称仍接受，但实际路由到当前 Flash 模型。

### 2. 单次 Agent 运行预算

`maxRunTokens` 累加一次 Agent 运行内所有模型调用的输入与输出。工具每多一轮，
完整前缀就再计一次。本次正是三次 41K 请求累计超过 120K。

### 3. 生命周期 transcript 预算

`maxTranscriptChars=240000` 使用字符数，并且只在一次运行成功提交后检查。
它既不是 Token，也无法在即将发送的请求前阻止超限；失败运行不会进入提交路径。

## 生产输入 Token 分布

统计范围为当前留存的约 17.6 小时聊天记录，共 221 个 Session、453 次模型调用；
不包含每日动态等 `system:*` 后台任务。

| 口径 | 平均 | P50 | P75 | P90 | P95 | P99 | 最大 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 每次模型调用输入 | 19,949 | 18,343 | 24,087 | 29,822 | 33,821 | 39,256 | 41,757 |
| 每个 Session 累计输入 | 40,891 | 34,373 | 48,727 | 71,084 | 83,216 | 123,555 | 136,318 |
| 生命周期首次调用 | 13,875 | 13,841 | 15,359 | 18,690 | 18,950 | 19,012 | 19,053 |
| 生命周期续接调用 | 22,002 | 20,696 | 26,418 | 31,887 | 35,880 | 39,938 | 41,757 |
| 长线程调用（线程至少 10 个 Session） | 24,618 | 23,844 | 28,763 | 34,967 | 37,685 | 40,929 | 41,757 |

工具轮数分布：

- P50 为 2 轮，P90 为 3 轮，P95 为 4 轮，P99 为 5 轮，最大 6 轮。
- 同一 Session 内，相邻请求输入平均增加 465 Token，P95 增加 909 Token。
- 每个 Session 的总输出 P95 为 961 Token。

两个已经发生的累计预算错误分别从：

- `28,804` Token 开始，运行 4 轮后累计 `127,131`。
- `40,879` Token 开始，运行 3 轮后累计 `124,711`。

## 建议方案

### P0：恢复当前群

先核对 Outbox。本次两次写入均为 `sent` 且有消息 ID，没有 `sending/unknown`：

1. 将 5 条 `held` 输入确认完成，不能重新执行，以免重复发言。
2. 将 183 条过期 `pending` 仅归档为历史，不补跑模型，避免机器人突然回复几十分钟前的话。
3. 保持已关闭旧线程，新消息创建新生命周期。

这一步只恢复队列，不修改预算逻辑。

### P1：请求前预算与安全收尾

把当前“调用后发现超额”改为“调用前预测”：

1. 保存上一次真实 `prompt_tokens` 和对应 payload 字符数。
2. 用同一模型最近一次的 `tokens/chars` 比率预测下一请求输入，加 8% 至 12% 安全余量。
3. 预留可配置输出额度，例如 2K Token。
4. 判断：

```text
predicted_request = predicted_input + reserved_output
predicted_run = cumulative_run_tokens + predicted_request
```

5. `predicted_request` 超过模型窗口时，在请求前 rollover。
6. `predicted_run` 超过运行预算时，不再调用模型，进入受控收尾。

受控收尾必须区分外部效果：

| 状态 | 处理 |
|---|---|
| 尚无外部写入 | 以 `budget-stop` 正常结束，可选择不回复 |
| 只有已确认的 `sent` | 记录 `partial-success`，提交 transcript/checkpoint，确认 lease |
| 存在 `sending/unknown` | 保持 `held`，只允许只读核对 |

这样本次会在第二轮发完文字后停止，不会再进入第三轮，也不会把已确认发送的批次
变成错误。

### P1：分开命名和计量

配置与 UI 分成四项：

- `modelContextTokens`：模型单请求窗口，官方模型自动识别，未知模型必须配置。
- `maxRequestInputTokens`：应用允许的单请求输入软上限。
- `maxRunTokens`：同一 Agent 运行累计原始 Token 上限。
- `maxRunCost`：按缓存命中/未命中/输出单价计算的成本上限，可选。

Session 同时展示：

- 当前请求输入 Token。
- 当前运行累计 Token。
- 缓存命中 Token。
- 预测下一轮及剩余预算。
- 生命周期 transcript 大小和 rollover 原因。

错误名称使用“运行累计 Token 预算耗尽”，不要显示成“上下文窗口溢出”。

### P1：Token 驱动的生命周期 rollover

在每个新 Session 发请求前计算：

```text
predicted_input * min_useful_rounds + output_reserve
```

若超过 `maxRunTokens`，先结束旧 generation：

1. 保留旧 transcript 作为只读审计记录。
2. 用最新 checkpoint 固化话题、事实、未决问题和最后实际发言。
3. 新建 thread generation，仅注入 checkpoint、有限条最近群消息和新消息。
4. 不修改旧 generation，避免局部裁剪造成工具调用配对损坏。

敲定默认值：

```text
lifecycleRolloverInputTokens = 32000
maxRunTokens = 160000
```

该阈值按“下一 Session 首次请求的预测输入”判断，达到或超过即先换代。

选择 32K / 160K 的理由：

- 32K 高于全量 P90（29,822）和长线程 P75（28,763），避免正常长聊过早换代。
- 当前样本中 20/221（9.0%）个 Session 的首次请求达到 32K；换代后同一线程后续
  Session 会重新从约 14K 至 19K 起步，实际换代次数会远少于 20 次。
- 按 P95 的每轮增长 909 Token、Session 总输出 961 Token 估算，起始 32K 的四轮：

```text
32000 + 32909 + 33818 + 34727 + 961 = 134415
```

低于提升后的 160K，约留 25.6K 安全余量。
- 已知 `28,804 × 4` 的运行累计 127,131，在 160K 下可以正常完成，不必为它提前换代。
- 已知 40,879 起步的长上下文会在 32K 处换代，不再进入三轮 41K 请求。

32K 只是 generation 的软换代线，不替代逐轮 preflight。P99 的工具链可达五轮，
个别轮次输入增长可超过 2K；这些长尾必须由请求前预测安全收尾，不能继续降低
换代线来强行覆盖，否则会过度破坏上下文和缓存。

在 Token 字段实现前，现有 `maxTranscriptChars` 可临时设为 `48000` 作为近似保护。
对 166 个生命周期续接样本做线性拟合：

```text
prompt_tokens ≈ 11630 + 0.4204 × injected_transcript_chars
```

32K 输入约对应 48,450 个 transcript 字符，拟合误差 RMSE 约 891 Token。
因此 `48000` 只能作为当前模型和提示词下的过渡值，最终仍应由真实 Token
校准驱动，不能长期把字符数当成 Token。

### P2：降低 transcript 增长率

保持 generation 内字节级追加，以继续获得 DeepSeek 前缀缓存；仅在 generation
边界压缩：

- 归档 `finish` 工具调用和结果，将其结构化状态写入 checkpoint。
- Session 审计继续保留完整 `reasoning_content`，活跃上下文只保留当前 generation。
- `noreply` 连续出现时采用自适应聚批，减少高活跃群每条消息都启动一次模型。
- 给查表情后发送的流程增加批量动作能力，减少 `list -> send -> sticker -> finish`
  四轮链路，但不能牺牲图片确认和 Outbox 语义。

不建议在活跃 transcript 中间直接删消息。这样会破坏工具调用配对、推理连续性和
前缀缓存，而且难以证明删掉的内容不再被引用。

### P2：模型配置规范化

将已退役但兼容的 `deepseek-v4-flash-vision-exp` 迁移为官方当前名称
`deepseek-flash`，同时在模型目录保存：

- 上下文长度。
- 最大输出。
- 是否支持视觉。
- 预算来源和更新时间。

供应商 `/models` 没有返回上下文元数据，因此不能只依赖模型列表接口。
内置官方表与管理员覆盖应共同提供能力数据。

## 不推荐的单点修复

- 只把 `maxRunTokens` 调高：会推迟故障，但没有 32K 换代和逐轮 preflight 时，
  工具轮仍会线性放大累计输入。
- 只降低 `maxRounds`：会把预算错误变成轮次错误，复杂工具流程仍会半途结束。
- 只降低 `maxTranscriptChars`：字符不是 Token，且当前检查发生在请求之后。
- 每轮滑窗删除旧消息：破坏 append-only、推理状态、工具配对和缓存命中。
- 把缓存 Token 当作零 Token：价格低不等于没有上下文、网络和供应商计量成本。

## 验证矩阵

1. 用本次 `40,879 -> 41,598 -> 41,757` usage 序列做固定回归。
2. 下一轮预测越预算时，不再发起 HTTP 请求。
3. 已确认发送后预算停止：lease 被确认、Session 为 `partial-success`、不重复发送。
4. 未知发送结果：仍进入 `held`，不得自动重试。
5. rollover 后首请求只含 checkpoint、有限历史和新消息，不重复消费消息。
6. generation 内请求保持前缀一致，缓存命中率不明显回退。
7. 模型窗口小于运行预算时，单请求 gate 优先。
8. 长中文、长英文、工具 schema、大工具结果分别验证 Token 估算误差。
9. 高活跃群压测 30 分钟，不出现 held，P95 请求体和每分钟模型调用数受控。
10. UI 明确区分上下文、运行累计、缓存和成本四个指标。

## 建议实施顺序

1. P0 恢复该群队列。
2. P1 实现请求前预测和安全收尾，先在 `1044877051` 试点。
3. P1 增加 `lifecycleRolloverInputTokens=32000` 的 generation rollover，
   并将 `maxRunTokens` 提升到 160000。
4. 观察 24 小时：失败率、平均轮数、每次输入、缓存率、每分钟调用数和回复完整性。
5. P2 再做 transcript 归档压缩与自适应聚批。
6. 试点稳定后通过后台开关扩大到其他生命周期群。

## 参考资料

- [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)：
  当前 Flash 为 1M 上下文；旧 V4 Flash/vision 名称兼容路由到当前 Flash。
- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache)：
  缓存按相同前缀自动命中，但命中 Token 仍会出现在 usage 中。
- [DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api)：
  `previous_response_id`、`conversation`、`context_management` 均不支持，
  因此不能依赖服务端托管会话来省掉客户端 transcript。
