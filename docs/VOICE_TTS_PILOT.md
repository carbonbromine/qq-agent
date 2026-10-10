
# 本地语音 TTS 实验（Qwen3-TTS / QQ record）

实验默认关闭。采用官方 Qwen3-TTS-12Hz-1.7B-CustomVoice 模型，Python 进程本地推理；
Node 端通过 127.0.0.1 的 HTTP 接口获取 PCM WAV，再用 OneBot v11 record 消息段发送
QQ 群或私聊**语音气泡**。不调用云端 TTS；安装依赖、下载权重时才需联网。

## 启动本地 TTS

前提：Linux、Python 3.10+（建议 3.12）、PyTorch 兼容的 CUDA GPU、足够磁盘空间；
SnowLuma/OneBot 已能收发 QQ 消息。首次安装会下载较多依赖和模型权重：

```bash
bash scripts/voice-tts/start.sh
# 新开终端；确保服务模型加载完成
curl -fsS http://127.0.0.1:8765/health
curl -fsS -X POST http://127.0.0.1:8765/synthesize   -H 'content-type: application/json'   -d '{"text":"我现在能说话了。","speaker":"Vivian"}'   --output /tmp/qq-voice.wav
file /tmp/qq-voice.wav
```

可用环境变量 QQ_TTS_DEVICE=cuda:0、QQ_TTS_MODEL=本地模型目录、
QQ_TTS_PORT=8765。服务只监听 localhost；如果 TTS 位于另一台 GPU 主机，
请通过 SSH 隧道转发，不要把 TTS 服务暴露公网。

## QQ Agent

「设置 → 实验功能」勾选「本地语音 TTS」并保存后，Agent 获得 send_voice 工具；
模型仅在需要时主动发送语音，不会自动把所有文字转语音。

配置 voiceTtsPilot：默认 enabled=false、graduated=false、speaker=Vivian、
maxChars=140、timeoutMs=90000。音色支持 Vivian、Serena、Uncle_Fu、Dylan、Eric
等 Qwen3-TTS CustomVoice 内置说话人。配置通过后端校验；本阶段没有固化按钮。

## 验收与回滚

1. 在专用 QQ 测试群验证 SnowLuma 支持 base64:// WAV record 并能转成语音气泡。
   某些 OneBot 实现需要额外的转码工具，不能保证所有版本通用。
2. 分别测试群聊、私聊、文本上限、GPU 无法连接、QQ 发送网络超时。
3. Outbox 记录的是语音文本及音色，不保存音频。QQ 发送结果未知时不得自动重发；
   TTS 合成失败发生在 QQ 发送之前，不产生 QQ 消息。
4. 关闭开关后新会话不再拥有 send_voice；停止 Python 服务即完全停用。
5. 执行 npm run test:unit 并在真实服务器实测后才能考虑固化上线。

目前只提交**实验代码和部署脚本**，不会自动安装 Python 模型或对 QQ 发消息。
