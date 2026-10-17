import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VoiceRecording} from '../src/utils/voiceRecording';

function fixture(options:{mime?:string;permission?:()=>Promise<MediaStream>;maxBytes?:number;nativeTimers?:boolean}={}){
 let time=0,tick:()=>void=()=>{},stopped=0;const files:File[]=[],errors:string[]=[],states:string[]=[],instances:Recorder[]=[];
 const stream={getTracks:()=>[{stop:()=>{stopped++;}}]} as unknown as MediaStream;
 class Recorder{
  static isTypeSupported(mime:string){return mime.startsWith(options.mime??'audio/webm');}
  mimeType:string;state='inactive';ondataavailable:((event:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;onerror:(()=>void)|null=null;
  constructor(_stream:MediaStream,config:{mimeType?:string}){this.mimeType=config.mimeType??'audio/aac';instances.push(this);}
  start(){this.state='recording';}
  stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['test recording'],{type:this.mimeType})});this.onstop?.();});}
 }
 const recording=new VoiceRecording({onState:state=>states.push(state),onFile:file=>files.push(file),onError:message=>errors.push(message)},
  {Recorder:Recorder as unknown as typeof MediaRecorder,getUserMedia:options.permission??(async()=>stream),now:()=>time,
   ...(!options.nativeTimers?{setInterval:((callback:()=>void)=>{tick=callback;return 1;}) as any,clearInterval:(()=>{tick=()=>{};}) as any}:{}),maxBytes:options.maxBytes});
 return {recording,stream,files,errors,states,instances,stopped:()=>stopped,advance(ms:number){time+=ms;},tick:()=>tick()};
}
const flush=async()=>{await Promise.resolve();await Promise.resolve();};

test('a finished voice message uses supported Opus fallback and releases the microphone before upload',async()=>{
 const h=fixture({mime:'audio/ogg'});await h.recording.start();h.advance(1000);h.recording.stop();assert.equal(h.stopped(),1);await flush();
 assert.equal(h.files.length,1);assert.equal(h.files[0]!.type,'audio/ogg');assert.match(h.files[0]!.name,/\.ogg$/);assert.equal(h.errors.length,0);assert.equal(h.states.at(-1),'idle');
});
test('cancelling while microphone permission is pending stops a late stream without creating a recording',async()=>{
 let resolve!:(stream:MediaStream)=>void;const h=fixture({permission:()=>new Promise(result=>{resolve=result;})});
 const pending=h.recording.start();h.recording.cancel();resolve(h.stream);await pending;
 assert.equal(h.instances.length,0);assert.equal(h.stopped(),1);assert.equal(h.files.length,0);
});
test('cancel/unmount prevents a late recorder stop callback from attaching a file',async()=>{
 const h=fixture();await h.recording.start();h.advance(1000);h.recording.stop();h.recording.cancel();await flush();
 assert.equal(h.files.length,0);assert.equal(h.stopped(),1);
});
test('denied permission returns to idle and permits another start',async()=>{
 let attempts=0;const h=fixture({permission:async()=>{attempts++;throw new DOMException('denied','NotAllowedError');}});
 await h.recording.start();await h.recording.start();assert.equal(attempts,2);assert.equal(h.errors.length,2);assert.equal(h.states.at(-1),'idle');
});
test('duration and byte limits release all capture resources',async()=>{
 const long=fixture();await long.recording.start();long.advance(300001);long.tick();assert.equal(long.stopped(),1);await flush();assert.equal(long.files.length,1);
 const large=fixture({maxBytes:3});await large.recording.start();large.advance(1000);large.instances[0]!.ondataavailable?.({data:new Blob(['too large'])});await flush();
 assert.equal(large.stopped(),1);assert.equal(large.files.length,0);assert.equal(large.errors.length,1);
});
test('an unsupported automatic recorder format cannot silently attach an unplayable file',async()=>{
 const h=fixture({mime:'audio/unknown'});await h.recording.start();h.advance(1000);h.recording.stop();await flush();assert.equal(h.files.length,0);assert.equal(h.errors.length,1);assert.equal(h.stopped(),1);
});
test('native browser timers retain their Window receiver when owned by the recorder',async(t)=>{
 t.mock.method(globalThis,'setInterval',function(this:unknown){if(this!==globalThis)throw new TypeError('Illegal invocation');return 1 as any;});
 t.mock.method(globalThis,'clearInterval',function(this:unknown){if(this!==globalThis)throw new TypeError('Illegal invocation');});
 const h=fixture({nativeTimers:true});await h.recording.start();assert.equal(h.states.at(-1),'recording');h.advance(1000);h.recording.stop();await flush();assert.equal(h.errors.length,0);assert.equal(h.files.length,1);
});
