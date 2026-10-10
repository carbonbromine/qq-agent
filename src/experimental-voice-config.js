
export const VOICE_SPEAKERS = Object.freeze(['Vivian','Serena','Uncle_Fu','Dylan','Eric','Ryan','Aiden','Ono_Anna','Sohee']);
export const DEFAULT_VOICE_TTS_PILOT = Object.freeze({ enabled:false, graduated:false, speaker:'Vivian', maxChars:140, timeoutMs:90000 });
export function normalizeVoiceTtsPilot(raw={}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('语音配置必须是对象');
  const speaker=String(raw.speaker ?? 'Vivian');
  const maxChars=Number(raw.maxChars ?? 140), timeoutMs=Number(raw.timeoutMs ?? 90000);
  if (!VOICE_SPEAKERS.includes(speaker)) throw new Error('不支持的语音音色');
  if (!Number.isInteger(maxChars) || maxChars<1 || maxChars>300) throw new Error('语音最大长度必须在1–300之间');
  if (!Number.isInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>180000) throw new Error('语音超时必须在1000–180000毫秒之间');
  return {enabled:raw.enabled===true, graduated:raw.graduated===true, speaker, maxChars, timeoutMs};
}
