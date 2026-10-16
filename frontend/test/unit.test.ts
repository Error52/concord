import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser globals so modules that touch window/location at import time can load in Node.
const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {} };
g.location ??= { pathname: '/channels/@me', search: '', protocol: 'http:', host: 'localhost' };
g.history ??= { pushState() {}, replaceState() {} };

const { StatsSampler, classify } = await import('../src/webrtc/stats.ts');
const { VoiceActivityDetector, toDb, dbToMeter } = await import('../src/webrtc/audioMeter.ts');
const { cmpId, isNewer,newMessageNonce } = await import('../src/utils/ids.ts');
const { contrastRatio, readableTextOn } = await import('../src/utils/color.ts');
const { parse, toPath } = await import('../src/state/router.ts');
const { formatBytes, formatDuration, plural } = await import('../src/utils/format.ts');
const { can, Perm } = await import('../src/utils/permissions.ts');
const { isEmojiOnly } = await import('../src/utils/markdown.tsx');

/** Builds an RTCStatsReport-like Map from plain records. */
const report = (...stats: Record<string, unknown>[]) => new Map(stats.map((s) => [s.id as string, s])) as unknown as RTCStatsReport;

test('message retry keys work without the secure-context randomUUID API',t=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 const getRandomValues=crypto.getRandomValues.bind(crypto);
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues}});
 t.after(()=>Object.defineProperty(globalThis,'crypto',original!));
 const first=newMessageNonce(),second=newMessageNonce();assert.match(first,/^[a-f0-9]{32}$/);assert.notEqual(first,second);
});

test('stats: RTT, transport and codec come from the selected candidate pair and codec stats', () => {
  const sampler = new StatsSampler();
  const pub = report(
    { id: 'T1', type: 'transport', selectedCandidatePairId: 'CP1', iceState: 'connected', dtlsState: 'connected' },
    { id: 'CP1', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.042, localCandidateId: 'L1' },
    { id: 'L1', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
    { id: 'O1', type: 'outbound-rtp', kind: 'audio', bytesSent: 10_000, codecId: 'C1' },
    { id: 'C1', type: 'codec', mimeType: 'audio/opus' },
    { id: 'R1', type: 'remote-inbound-rtp', fractionLost: 0.002, jitter: 0.004 },
  );
  const s = sampler.sample([pub], []);
  assert.equal(Math.round(s.rttMs!), 42);
  assert.equal(s.codec, 'Opus');
  assert.equal(s.transport, 'UDP · host');
  assert.equal(s.iceState, 'connected');
  assert.ok(Math.abs(s.packetLossPct! - 0.2) < 1e-9);
  assert.equal(s.uploadKbps, null); // needs two samples for a rate
  assert.equal(s.quality, 'excellent');
});

test('stats: bitrates and packet loss are computed from deltas between samples', async () => {
  const sampler = new StatsSampler();
  const sub = (bytes: number, recv: number, lost: number) =>
    report({ id: 'I1', type: 'inbound-rtp', kind: 'audio', bytesReceived: bytes, packetsReceived: recv, packetsLost: lost, jitter: 0.012, codecId: 'C' }, { id: 'C', type: 'codec', mimeType: 'audio/opus' });
  sampler.sample([], [sub(0, 0, 0)]);
  await new Promise((r) => setTimeout(r, 100));
  const s = sampler.sample([], [sub(8_000, 95, 5)]);
  assert.ok(s.downloadKbps! > 0);
  assert.equal(Math.round(s.packetLossPct!), 5);
  assert.equal(Math.round(s.jitterMs!), 12);
  assert.equal(s.quality, 'average');
});

test('stats: playout buffers use interval deltas, tolerate counter reset and missing fields',()=>{
 const sampler=new StatsSampler();
 const s=(delay:number,count:number)=>report({id:'audio',type:'inbound-rtp',kind:'audio',jitterBufferDelay:delay,jitterBufferEmittedCount:count});
 assert.equal(sampler.sample([],[s(10,100)]).audioBufferMs,100);
 assert.ok(Math.abs(sampler.sample([],[s(10.4,110)]).audioBufferMs!-40)<1e-6);
 assert.equal(sampler.sample([],[s(10.4,110)]).audioBufferMs,null);
 assert.equal(sampler.sample([],[s(1,20)]).audioBufferMs,50);
 sampler.reset();assert.equal(sampler.sample([],[s(2,20)]).audioBufferMs,100);
 assert.equal(sampler.sample([],[]).videoBufferMs,null);
});

test('stats: relay candidates are labelled as TURN; quality thresholds', () => {
  const s = new StatsSampler().sample(
    [
      report(
        { id: 'CP', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.25, localCandidateId: 'L' },
        { id: 'L', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'tcp' },
      ),
    ],
    [],
  );
  assert.equal(s.transport, 'TCP · relay (TURN)');
  assert.equal(classify(30, 0, 2), 'excellent');
  assert.equal(classify(150, 2, 10), 'good');
  assert.equal(classify(500, 12, 100), 'poor');
  assert.equal(classify(null, null, null), 'unknown');
});

test('VAD: opens on speech, holds through short gaps, closes after hangover', () => {
  const vad = new VoiceActivityDetector(-50, false, 300);
  assert.equal(vad.update(-70, 0), false);
  assert.equal(vad.update(-30, 10), true);
  assert.equal(vad.update(-70, 200), true); // within hangover
  assert.equal(vad.update(-70, 400), false);
});

test('VAD: auto threshold follows the noise floor', () => {
  const vad = new VoiceActivityDetector(-50, true);
  for (let t = 0; t < 200; t++) vad.update(-58, t * 10); // steady fan noise
  assert.equal(vad.isOpen, false);
  assert.ok(vad.effectiveThreshold > -58);
  assert.equal(vad.update(-30, 3000), true);
});

test('audio level helpers', () => {
  assert.equal(toDb(1), 0);
  assert.equal(toDb(0), -100);
  assert.equal(dbToMeter(-60), 0);
  assert.equal(dbToMeter(0), 1);
});

test('message ids compare as big integers', () => {
  assert.ok(cmpId('10', '9') > 0);
  assert.ok(cmpId('123456789012345678', '123456789012345677') > 0);
  assert.equal(isNewer('5', null), true);
  assert.equal(isNewer('5', '5'), false);
});

test('contrast validation mirrors the backend rule', () => {
  assert.ok(contrastRatio('#ffffff', '#000000') > 20);
  assert.equal(readableTextOn('#101020', '#402060'), '#ffffff');
  assert.equal(readableTextOn('#777777', '#888888'), null);
});

test('router parses and builds paths', () => {
  assert.deepEqual(parse('/channels/@me/abc/42', ''), { name: 'dm', channelId: 'abc', messageId: '42' });
  assert.deepEqual(parse('/channels/s1/c1', ''), { name: 'channel', serverId: 's1', channelId: 'c1', messageId: undefined });
  assert.deepEqual(parse('/invite/AbCd', ''), { name: 'invite', code: 'AbCd' });
  assert.equal(toPath({ name: 'channel', serverId: 's', channelId: 'c', messageId: '1' }), '/channels/s/c/1');
  assert.equal(toPath({ name: 'reset', token: 'a b' }), '/reset-password?token=a%20b');
});

test('formatting helpers', () => {
  assert.equal(formatBytes(1536), '1.5 КБ');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(plural(21, 'участник', 'участника', 'участников'), 'участник');
  assert.equal(plural(12, 'участник', 'участника', 'участников'), 'участников');
  assert.equal(isEmojiOnly('🔥🔥'), true);
  assert.equal(isEmojiOnly('ok 🔥'), false);
});

test('permission helper treats ADMINISTRATOR as all permissions', () => {
  assert.equal(can(Perm.ADMINISTRATOR, Perm.BAN_MEMBERS), true);
  assert.equal(can(Perm.SEND_MESSAGES, Perm.BAN_MEMBERS), false);
  assert.equal(can(undefined, Perm.SEND_MESSAGES), false);
});
