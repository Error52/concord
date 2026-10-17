import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual engine methods while isolating browser/SDK resource boundaries.
// TypeScript AST extraction keeps the test independent of source formatting.
const source=await readFile(new URL('../src/webrtc/voiceEngine.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('voiceEngine.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const owner=ast.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==='VoiceEngine');
assert.ok(owner&&ts.isClassDeclaration(owner));
const names=new Set(['startMicrophone','publishMicrophone','releaseMicrophone','toggleMute','computeGate','applyGate','onWindowBlur','onWindowFocus','onSettingsChanged','teardown']);
const methods=owner.members.filter(node=>ts.isMethodDeclaration(node)&&node.name&&names.has(node.name.getText(ast)));
assert.equal(methods.length,names.size);
const code=ts.transpileModule(`class Harness{${methods.map(node=>node.getText(ast)).join('\n')}};globalThis.Harness=Harness;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

function fixture(publish:(track:any)=>Promise<any>){
  const state={selfMute:false,selfDeaf:false,serverMute:false,serverDeaf:false,gateOpen:false,localSpeaking:false};
  const announcements:boolean[]=[],captures:Array<{raw:any;output:any;ctx:any}>=[];
  const settings:any={muteOnBlur:false,inputMode:'vad'};
  const focus={active:true};
  const sandbox:any={Track:{Source:{Microphone:'microphone'}},VOICE_AUDIO_PUBLISH:{},voiceStore:{get:()=>state,set:(next:object)=>Object.assign(state,next)},
    toast:()=>{},log:{warn:()=>{}},gateway:{send:()=>{}},mediaErrorMessage:()=>'',muteSound:()=>{},unmuteSound:()=>{},
    document:{hasFocus:()=>focus.active},settingsStore:{get:()=>settings},VoiceActivityDetector:class{isOpen=false;},clearTimeout,clearInterval};
  vm.createContext(sandbox);vm.runInContext(code,sandbox);
  const engine=new sandbox.Harness();
  const room={localParticipant:{publishTrack:publish}};
  Object.assign(engine,{room,micSeq:0,micPub:null,micStarting:null,lastSpeakingSent:false,mayPublish:()=>true,applyGate:()=>{},
    refreshParticipants:()=>{},announce:()=>announcements.push(state.selfMute)});
  const capture=()=>{
    const track=()=>({readyState:'live',stops:0,stop(){this.readyState='ended';this.stops++;}});
    const raw=track(),output=track(),ctx={closes:0,close:async()=>{ctx.closes++;}};
    engine.micStream={getTracks:()=>[raw]};engine.dest={stream:{getAudioTracks:()=>[output],getTracks:()=>[output]}};engine.ctx=ctx;
    const value={raw,output,ctx};captures.push(value);return value;
  };
  engine.acquireMic=async()=>{engine.micSeq++;capture();return true;};
  return {engine,room,state,announcements,captures,capture,settings,focus};
}

test('a failed microphone publication frees capture, shows muted state and retries once after unmute',async()=>{
  let calls=0;
  const f=fixture(async track=>{
    if(++calls===1)throw new Error('Transient SFU publication failure');
    return {track:{mediaStreamTrack:track},isMuted:false,mute:async()=>{}};
  });
  await f.engine.startMicrophone();
  assert.equal(calls,1);assert.equal(f.engine.micPub,null);assert.equal(f.engine.micStarting,null);
  assert.equal(f.state.selfMute,true);assert.equal(f.announcements.at(-1),true);
  assert.equal(f.captures[0]!.raw.readyState,'ended');assert.equal(f.captures[0]!.output.readyState,'ended');assert.equal(f.captures[0]!.ctx.closes,1);
  f.engine.toggleMute();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2);assert.equal(f.state.selfMute,false);assert.ok(f.engine.micPub);
  assert.equal(f.captures[1]!.raw.readyState,'live');assert.equal(f.captures[1]!.output.readyState,'live');
});

test('an older failed publication cannot stop or mute a newer device pipeline',async()=>{
  let reject!:(reason:Error)=>void,started!:()=>void;
  const began=new Promise<void>(resolve=>{started=resolve;});
  const f=fixture(async()=>{started();return new Promise((_resolve,deny)=>{reject=deny;});});
  const pending=f.engine.startMicrophone();await began;
  f.engine.micSeq++;const next=f.capture();
  const newPublication={track:{mediaStreamTrack:next.output},isMuted:false};f.engine.micPub=newPublication;
  reject(new Error('Late failure from old publication'));await pending;
  assert.equal(f.engine.micPub,newPublication);assert.equal(f.state.selfMute,false);assert.equal(f.announcements.length,0);
  assert.equal(next.raw.readyState,'live');assert.equal(next.output.readyState,'live');assert.equal(next.ctx.closes,0);
});

test('a failed publication from a disconnected room leaves the current room untouched',async()=>{
  let reject!:(reason:Error)=>void,started!:()=>void;
  const began=new Promise<void>(resolve=>{started=resolve;});
  const f=fixture(async()=>{started();return new Promise((_resolve,deny)=>{reject=deny;});});
  const pending=f.engine.startMicrophone();await began;
  const nextRoom={localParticipant:{}};f.engine.room=nextRoom;const next=f.capture();
  reject(new Error('Late old-room failure'));await pending;
  assert.equal(f.engine.room,nextRoom);assert.equal(f.state.selfMute,false);
  assert.equal(next.raw.readyState,'live');assert.equal(next.ctx.closes,0);
});

test('mute on blur remains enforced after teardown and a background rejoin until focus returns',async()=>{
  const f=fixture(async()=>({}));delete f.engine.applyGate;
  f.settings.muteOnBlur=true;f.engine.vad={isOpen:true};f.focus.active=false;
  Object.assign(f.engine,{micSeq:0,screenSeq:0,cameraSeq:0,rejoinTimer:null,pttReleaseTimer:null,statsTimer:null,
    screenTracks:[],cameraTracks:[],streamLoad:{reset(){}},unwatched:new Set(),sampler:{reset(){}}});
  Object.assign(f.room,{removeAllListeners(){},disconnect:async()=>{}});
  f.engine.onWindowBlur();assert.equal(f.engine.computeGate(),false);
  await f.engine.teardown();
  // A reconnect has no new blur event: the document stayed in the background.
  f.engine.room=f.room;f.engine.vad={isOpen:true};
  assert.equal(f.engine.mutedByBlur,false);assert.equal(f.engine.computeGate(),false);
  f.engine.applyGate();assert.equal(f.state.gateOpen,false);
  f.focus.active=true;f.engine.onWindowFocus();assert.equal(f.state.gateOpen,true);
});

test('changing mute-on-blur reconciles focus and clears a stale muted flag',()=>{
  const f=fixture(async()=>({}));delete f.engine.applyGate;
  f.engine.vad={isOpen:true};f.engine.prevSettings={...f.settings};f.focus.active=false;
  f.settings.muteOnBlur=true;f.engine.onSettingsChanged({...f.settings});
  assert.equal(f.engine.mutedByBlur,true);assert.equal(f.state.gateOpen,false);
  f.settings.muteOnBlur=false;f.engine.onSettingsChanged({...f.settings});
  assert.equal(f.engine.mutedByBlur,false);assert.equal(f.state.gateOpen,true);
});

test('focus reapplies the actual gate even when no stale blur flag was set',()=>{
  const f=fixture(async()=>({}));delete f.engine.applyGate;
  f.settings.muteOnBlur=true;f.engine.vad={isOpen:true};f.engine.mutedByBlur=false;f.focus.active=true;
  f.engine.onWindowFocus();assert.equal(f.state.gateOpen,true);
});
