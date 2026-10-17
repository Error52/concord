import {useEffect,useRef,useState} from 'react';
import {LuMic,LuSquare,LuX,LuLoaderCircle} from 'react-icons/lu';
import {settingsStore} from '../../state/settings';
import {toast} from '../../state/ui';
import {VoiceRecording,type RecordingStatus} from '../../utils/voiceRecording';

export function VoiceRecorder({onFile,disabled}:{onFile:(file:File)=>void;disabled:boolean}){
  const callback=useRef(onFile);callback.current=onFile;
  const capture=useRef<VoiceRecording|null>(null),[state,setState]=useState<{status:RecordingStatus;seconds:number}>({status:'idle',seconds:0});
  useEffect(()=>{
    const recording=new VoiceRecording({onState:(status,seconds)=>setState({status,seconds}),onFile:file=>callback.current(file),onError:message=>toast(message,'error'),onFallback:()=>toast('Сохранённый микрофон не найден — используется устройство по умолчанию')});
    capture.current=recording;
    return ()=>{recording.cancel();capture.current=null;};
  },[]);
  if(state.status==='idle')return <button className="icon-btn" aria-label="Записать голосовое сообщение" disabled={disabled} onClick={()=>{
    const settings=settingsStore.get();void capture.current?.start({...(settings.inputDeviceId==='default'?{}:{deviceId:{exact:settings.inputDeviceId}}),sampleRate:48000,channelCount:1,echoCancellation:settings.echoCancellation,noiseSuppression:settings.noiseSuppression,autoGainControl:settings.autoGainControl});
  }}><LuMic/></button>;
  return <>
    {state.status==='recording'&&<><button className="icon-btn danger" aria-label="Завершить запись" onClick={()=>capture.current?.stop()}><LuSquare/></button><span className="muted" role="timer" aria-label="Длительность записи">{Math.floor(state.seconds/60)}:{String(state.seconds%60).padStart(2,'0')}</span></>}
    {state.status==='stopping'&&<span className="icon-btn muted" role="status" aria-label="Обработка записи" title="Обработка…"><LuLoaderCircle aria-hidden="true"/></span>}
    <button className="icon-btn" aria-label="Отменить запись" aria-busy={state.status==='requesting'} onClick={()=>capture.current?.cancel()}><LuX/></button>
  </>;
}
