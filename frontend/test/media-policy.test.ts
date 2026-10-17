import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyPlaybackBuffer, playbackBufferTarget, playbackBufferFromReport, VOICE_AUDIO_PUBLISH, STREAM_AUDIO_PUBLISH} from '../src/webrtc/mediaPolicy';

test('voice gets a higher fidelity mono budget and loss protection; shared audio stays raw stereo',()=>{
 assert.equal(VOICE_AUDIO_PUBLISH.audioPreset.maxBitrate,96000);
 assert.equal(VOICE_AUDIO_PUBLISH.forceStereo,false);
 assert.ok(VOICE_AUDIO_PUBLISH.red && VOICE_AUDIO_PUBLISH.dtx);
 assert.equal(STREAM_AUDIO_PUBLISH.audioPreset.maxBitrate,192000);
 assert.ok(STREAM_AUDIO_PUBLISH.forceStereo);
 assert.ok(!STREAM_AUDIO_PUBLISH.red && !STREAM_AUDIO_PUBLISH.dtx);
 assert.equal(VOICE_AUDIO_PUBLISH.audioPreset.priority,'high');
});
test('receiver buffer leaves headroom for jitter without accumulating seconds of delay',()=>{
 assert.equal(playbackBufferTarget(false,null),20);
 assert.equal(playbackBufferTarget(true,0),40);
 assert.equal(playbackBufferTarget(true,45),110);
 assert.equal(playbackBufferTarget(false,300),160);
 assert.equal(playbackBufferTarget(false,NaN),20);
});
test('buffer preference is optional and rejected/unsupported setters never break a call',()=>{
 assert.equal(applyPlaybackBuffer(undefined,60),false);
 assert.equal(applyPlaybackBuffer({} as RTCRtpReceiver,60),false);
 const r={jitterBufferTarget:null as number|null};
 assert.equal(applyPlaybackBuffer(r as RTCRtpReceiver,60),true);
 assert.equal(r.jitterBufferTarget,60);
 const rejected=Object.defineProperty({},'jitterBufferTarget',{get:()=>null,set:()=>{throw new Error('Unsupported');}});
 assert.equal(applyPlaybackBuffer(rejected,60),false);
});

test('a jittery participant cannot inflate a healthy participant playback buffer',()=>{
 const report=(...rows:Record<string,unknown>[])=>new Map(rows.map((row,i)=>[String(i),row])) as unknown as RTCStatsReport;
 const healthy=report({type:'inbound-rtp',kind:'audio',jitter:0});
 const weak=report({type:'inbound-rtp',kind:'audio',jitter:.3});
 assert.equal(playbackBufferFromReport(false,'audio',healthy),20);
 assert.equal(playbackBufferFromReport(false,'audio',weak),160);
 assert.equal(playbackBufferFromReport(false,'audio',healthy),20);
 const screen=report({type:'inbound-rtp',kind:'video',jitter:.01},{type:'remote-inbound-rtp',kind:'video',jitter:.5});
 assert.equal(playbackBufferFromReport(true,'video',screen),40);
 assert.equal(playbackBufferFromReport(true,'video',undefined),40);
});

test('receiver buffering tolerates absent and invalid jitter without borrowing another media kind',()=>{
 const report=new Map([
  ['audio',{type:'inbound-rtp',mediaType:'audio',jitter:.04}],
  ['video',{type:'inbound-rtp',kind:'video',jitter:.4}],
  ['invalid',{type:'inbound-rtp',kind:'audio',jitter:NaN}],
  ['negative',{type:'inbound-rtp',kind:'audio',jitter:-1}],
 ]) as unknown as RTCStatsReport;
 assert.equal(playbackBufferFromReport(false,'audio',report),100);
 assert.equal(playbackBufferFromReport(true,'video',report),160);
 assert.equal(playbackBufferFromReport(false,'unknown',report),20);
});
