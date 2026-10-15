import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StatsSampler} from '../src/webrtc/stats';
const report=(...rows:Record<string,unknown>[])=>new Map(rows.map(r=>[r.id,r])) as unknown as RTCStatsReport;
const audio=(id:string,bytes:number,received=100,lost=0)=>({id,type:'inbound-rtp',kind:'audio',ssrc:id,bytesReceived:bytes,packetsReceived:received,packetsLost:lost});

test('joining and leaving streams cannot inflate bandwidth or packet-loss counters',t=>{
 let time=0;t.mock.method(performance,'now',()=>time);const sampler=new StatsSampler();
 sampler.sample([],[report(audio('a',1000))]);time=1000;
 let s=sampler.sample([],[report(audio('a',2000,200),audio('b',1_000_000,900,100))]);
 assert.equal(s.downloadKbps,8);assert.equal(s.packetLossPct,0);time=2000;
 s=sampler.sample([],[report(audio('b',1_002_000,1000,100))]);assert.equal(s.downloadKbps,16);assert.equal(s.packetLossPct,0);
 time=3000;s=sampler.sample([],[report(audio('b',10,1,0))]);assert.equal(s.downloadKbps,0);assert.equal(s.packetLossPct,null);
 time=4000;s=sampler.sample([],[report(audio('b',1010,101,0))]);assert.equal(s.downloadKbps,8);assert.equal(s.packetLossPct,0);
});

test('publisher and subscriber transport IDs remain scoped to their peer connection',()=>{
 const peer=(rtt:number,protocol:string,codec:string)=>report(
  {id:'T01',type:'transport',selectedCandidatePairId:'pair'},
  {id:'pair',type:'candidate-pair',state:'succeeded',currentRoundTripTime:rtt,localCandidateId:'local'},
  {id:'local',type:'local-candidate',protocol,candidateType:'host'},
  {id:'codec',type:'codec',mimeType:codec},
  {id:'rtp',type:protocol==='udp'?'outbound-rtp':'inbound-rtp',kind:'audio',codecId:'codec',bytesSent:100,bytesReceived:100},
 );
 const s=new StatsSampler().sample([peer(.02,'udp','audio/opus')],[peer(.5,'tcp','video/VP8')]);
 assert.equal(s.rttMs,20);assert.equal(s.transport,'UDP · host');assert.equal(s.codec,'Opus');
});
