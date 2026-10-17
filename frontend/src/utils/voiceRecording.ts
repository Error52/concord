export type RecordingStatus='idle'|'requesting'|'recording'|'stopping';
interface Callbacks{onState:(status:RecordingStatus,seconds:number)=>void;onFile:(file:File)=>void;onError:(message:string)=>void;onFallback?:()=>void}
interface Dependencies{Recorder?:typeof MediaRecorder;getUserMedia?:(constraints:MediaStreamConstraints)=>Promise<MediaStream>;now?:()=>number;setInterval?:typeof setInterval;clearInterval?:typeof clearInterval;maxBytes?:number;maxMilliseconds?:number}
const MIME_TYPES=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'];

/** Owns every capture/recorder handle so stale permission and stop callbacks cannot send a file. */
export class VoiceRecording{
  private generation=0;private recorder:MediaRecorder|null=null;private stream:MediaStream|null=null;
  private timer:ReturnType<typeof setInterval>|null=null;private status:RecordingStatus='idle';private started=0;
  private readonly now:()=>number;private readonly setTimer:typeof setInterval;private readonly clearTimer:typeof clearInterval;
  constructor(private callbacks:Callbacks,private dependencies:Dependencies={}){
    this.now=dependencies.now??(()=>performance.now());this.setTimer=dependencies.setInterval??setInterval.bind(globalThis);this.clearTimer=dependencies.clearInterval??clearInterval.bind(globalThis);
  }
  private state(status:RecordingStatus){this.status=status;this.callbacks.onState(status,status==='idle'?0:Math.floor((this.now()-this.started)/1000));}
  private release(){if(this.timer!==null){this.clearTimer(this.timer);this.timer=null;}this.stream?.getTracks().forEach(track=>track.stop());this.stream=null;}
  async start(audio:MediaTrackConstraints={}):Promise<void>{
    if(this.status!=='idle')return;
    const Recorder=this.dependencies.Recorder??globalThis.MediaRecorder;
    const getUserMedia=this.dependencies.getUserMedia??navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
    if(!Recorder||!getUserMedia){this.callbacks.onError('Для записи нужен HTTPS и браузер с поддержкой записи звука');return;}
    const generation=++this.generation;this.started=this.now();this.state('requesting');
    try{
      let stream:MediaStream;
      try{stream=await getUserMedia({audio});}
      catch(error){
        if(generation!==this.generation)return;
        if(audio.deviceId&&['NotFoundError','OverconstrainedError'].includes((error as DOMException).name)){
          const {deviceId:_,...fallback}=audio;stream=await getUserMedia({audio:fallback});if(generation===this.generation)this.callbacks.onFallback?.();
        }else throw error;
      }
      if(generation!==this.generation){stream.getTracks().forEach(track=>track.stop());return;}
      this.stream=stream;
      const mime=MIME_TYPES.find(type=>Recorder.isTypeSupported?.(type));
      const recorder=new Recorder(stream,{...(mime?{mimeType:mime}:{}),audioBitsPerSecond:96000});this.recorder=recorder;
      const chunks:Blob[]=[];let bytes=0;
      recorder.ondataavailable=event=>{
        if(generation!==this.generation||!event.data.size)return;
        bytes+=event.data.size;
        if(bytes>(this.dependencies.maxBytes??25*1024*1024)){this.cancel();this.callbacks.onError('Запись больше 25 МБ — запишите более короткое сообщение');return;}
        chunks.push(event.data);
      };
      recorder.onerror=()=>{if(generation===this.generation){this.cancel();this.callbacks.onError('Не удалось записать звук. Попробуйте ещё раз');}};
      recorder.onstop=()=>{
        if(generation!==this.generation)return;
        this.recorder=null;this.release();this.state('idle');
        if(!bytes||this.now()-this.started<300){this.callbacks.onError('Запись слишком короткая. Запишите хотя бы секунду');return;}
        const type=(recorder.mimeType||chunks[0]?.type||mime||'').split(';')[0]!;
        const extensions:Record<string,string>={'audio/webm':'webm','audio/ogg':'ogg','audio/mp4':'mp4','audio/wav':'wav'};
        if(!extensions[type]){this.callbacks.onError('Браузер записал неподдерживаемый формат звука');return;}
        const blob=new Blob(chunks,{type});
        this.callbacks.onFile(new File([blob],`voice-${Date.now()}.${extensions[type]}`,{type}));
      };
      this.started=this.now();recorder.start(250);this.state('recording');
      this.timer=this.setTimer(()=>{
        if(generation!==this.generation)return;
        if(this.now()-this.started>=(this.dependencies.maxMilliseconds??5*60_000))this.stop();else this.state('recording');
      },1000);
    }catch(error){
      if(generation!==this.generation)return;
      this.cancel();const name=(error as DOMException).name;
      this.callbacks.onError(name==='NotAllowedError'?'Разрешите доступ к микрофону, чтобы записать сообщение':name==='NotFoundError'?'Микрофон не найден':'Не удалось начать запись. Проверьте микрофон');
    }
  }
  stop():void{
    if(this.status!=='recording')return;
    this.state('stopping');if(this.timer!==null){this.clearTimer(this.timer);this.timer=null;}
    try{this.recorder?.stop();this.release();}catch{this.cancel();this.callbacks.onError('Не удалось завершить запись');}
  }
  cancel():void{
    ++this.generation;const recorder=this.recorder;this.recorder=null;
    if(recorder&&recorder.state!=='inactive')try{recorder.stop();}catch{}
    this.release();this.state('idle');
  }
}
