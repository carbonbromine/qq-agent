
import {normalizeVoiceTtsPilot} from './experimental-voice-config.js';
const MAX_BYTES=5*1024*1024;
export function localTtsEndpoint(value=process.env.QQ_AGENT_LOCAL_TTS_URL || 'http://127.0.0.1:8765/synthesize') {
  let url;
  try { url=new URL(String(value)); } catch { throw new Error('TTS 地址无效'); }
  if (url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.username || url.password
    || url.search || url.hash || url.pathname!=='/synthesize') throw new Error('TTS 仅允许本机 127.0.0.1 的 /synthesize');
  return url.href;
}
export async function synthesizeLocalVoice(text, rawConfig, {signal, fetchImpl=fetch, endpoint}={}) {
  const cfg=normalizeVoiceTtsPilot(rawConfig);
  if (!cfg.enabled) throw new Error('本地语音实验功能未启用');
  const spoken=String(text ?? '').trim();
  if (!spoken || [...spoken].length>cfg.maxChars) throw new Error('语音内容应为1–'+cfg.maxChars+'字符');
  signal?.throwIfAborted();
  const uri=localTtsEndpoint(endpoint);
  const timeout=AbortSignal.timeout(cfg.timeoutMs);
  const requestSignal=signal ? AbortSignal.any([signal,timeout]) : timeout;
  const response=await fetchImpl(uri, {method:'POST',
    headers:{'content-type':'application/json',accept:'audio/wav'},
    body:JSON.stringify({text:spoken,speaker:cfg.speaker}),signal:requestSignal});
  if (!response.ok) {
    try {await response.body?.cancel();} catch {}
    throw new Error('本地 TTS HTTP '+response.status);
  }
  if (!/^audio\/(x-wav|wav)(?:;|$)/.test(String(response.headers.get('content-type')||'').toLowerCase())) {
    try {await response.body?.cancel();} catch {}
    throw new Error('本地 TTS 未返回 WAV');
  }
  if (Number(response.headers.get('content-length')||0)>MAX_BYTES) throw new Error('音频大于5 MiB');
  if (!response.body) throw new Error('音频为空');
  const parts=[];let bytes=0;
  for await (const chunk of response.body) {
    requestSignal.throwIfAborted();
    bytes+=chunk.length;
    if (bytes>MAX_BYTES) throw new Error('音频大于5 MiB');
    parts.push(Buffer.from(chunk));
  }
  const wav=Buffer.concat(parts,bytes);
  if (wav.length<44 || wav.toString('ascii',0,4)!=='RIFF' || wav.toString('ascii',8,12)!=='WAVE') throw new Error('音频 WAV 格式错误');
  return wav;
}
