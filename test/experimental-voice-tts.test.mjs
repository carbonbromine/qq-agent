
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeVoiceTtsPilot,DEFAULT_VOICE_TTS_PILOT} from '../src/experimental-voice-config.js';
import {localTtsEndpoint,synthesizeLocalVoice} from '../src/experimental-voice-tts.js';
const wav=Buffer.alloc(64);wav.write('RIFF',0,'ascii');wav.write('WAVE',8,'ascii');
test('disabled by default and validates audio config',()=>{
  assert.equal(DEFAULT_VOICE_TTS_PILOT.enabled,false);
  assert.throws(()=>normalizeVoiceTtsPilot({speaker:'invalid'}),/音色/);
  assert.throws(()=>localTtsEndpoint('http://192.168.1.5:8765/synthesize'),/仅允许本机/);
});
test('disabled mode does not call TTS',async()=>{
  let called=false;
  await assert.rejects(synthesizeLocalVoice('你好',{}, {fetchImpl:()=>{called=true;}}),/未启用/);
  assert.equal(called,false);
});
test('valid WAV is accepted',async()=>{
  const result=await synthesizeLocalVoice('你好',{enabled:true}, {
    fetchImpl:async(uri,options)=>{
      assert.match(uri,/127\.0\.0\.1/);
      assert.deepEqual(JSON.parse(options.body),{text:'你好',speaker:'Vivian'});
      return new Response(wav,{headers:{'content-type':'audio/wav'}});
    }
  });
  assert.deepEqual(result,wav);
});
test('invalid WAV rejected, too-long text never calls backend',async()=>{
  await assert.rejects(synthesizeLocalVoice('你好',{enabled:true},{fetchImpl:async()=>new Response('bad',{headers:{'content-type':'audio/wav'}})}),/WAV/);
  await assert.rejects(synthesizeLocalVoice('长'.repeat(141),{enabled:true},{fetchImpl:()=>{throw Error('called');}}),/1–140/);
});
