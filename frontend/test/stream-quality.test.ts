import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StreamLoadController, streamProfile, screenCodec} from '../src/webrtc/streamQuality';

test('auto respects small CPUs and keeps the high quality ceiling on capable machines',()=>{
 assert.equal(streamProfile('auto',0,4).width,1920);
 assert.equal(streamProfile('auto',0,8).width,1920);
 assert.equal(streamProfile('auto',0,12).width,2560);
 assert.equal(streamProfile('auto',0,4).fps,30);
 assert.equal(streamProfile('auto',0,8).fps,60);
 assert.equal(streamProfile('720p30',0,2).width,1280);
});
test('CPU pressure lowers frame rate before resolution, text retains sharpness',()=>{
 assert.equal(streamProfile('auto',1,12).width,2560);
 assert.ok(streamProfile('auto',1).fps<60);
 assert.equal(streamProfile('auto',3).width,1280);
 assert.equal(streamProfile('text',3).width,2560);
 assert.equal(streamProfile('text',3).fps,8);
});
test('stream controller resists brief pressure, backs off and recovers gradually',()=>{
 const c=new StreamLoadController();
 const row=(reason:string)=>[{type:'outbound-rtp',kind:'video',qualityLimitationReason:reason}];
 assert.equal(c.sample(row('cpu'),30),false);
 assert.equal(c.sample(row('none'),30),false);
 for(let i=0;i<2;i++)assert.equal(c.sample(row('cpu'),30),false);
 assert.equal(c.sample(row('cpu'),30),true);assert.equal(c.tier,1);
 for(let i=0;i<19;i++)assert.equal(c.sample(row('none'),24),false);
 assert.equal(c.sample(row('none'),24),true);assert.equal(c.tier,0);
});
test('stream controller uses encoder time, ignores audio, tolerates missing stats and bounds its tier',()=>{
 const c=new StreamLoadController();
 assert.equal(c.sample([{type:'outbound-rtp',kind:'audio',qualityLimitationReason:'cpu'}],30),false);
 for(let i=0;i<5;i++)c.sample([{type:'outbound-rtp',kind:'video',framesEncoded:i*30,totalEncodeTime:i*1.2}],30);
 assert.equal(c.tier,1);
 for(let i=0;i<30;i++)c.sample([{type:'outbound-rtp',kind:'video',qualityLimitationReason:'cpu'}],30);
 assert.equal(c.tier,3);
 for(let i=0;i<30;i++)c.sample([{type:'outbound-rtp',kind:'video'}],30);
 assert.equal(c.tier,3);
 c.reset();assert.equal(c.tier,0);
});
test('bandwidth startup does not masquerade as CPU overload or erase screen detail',()=>{
 const c=new StreamLoadController();
 for(let i=0;i<30;i++)c.sample([{type:'outbound-rtp',kind:'video',qualityLimitationReason:'bandwidth'}],30);
 assert.equal(c.tier,0);
 assert.equal(streamProfile('auto').degradation,'maintain-framerate');
 for (const quality of ['720p30','1080p30','1080p60'] as const) assert.equal(streamProfile(quality).degradation,'maintain-framerate');
 assert.equal(streamProfile('text').degradation,'maintain-resolution');
});
test('screen codec falls back on browsers without H.264',()=>{
 assert.equal(screenCodec(null),'vp8');
 assert.equal(screenCodec({codecs:[{mimeType:'video/H264',clockRate:90000}]}),'h264');
});
