import {refreshSession} from '../api/client';

/** Old open tabs can have a media cookie from before session-bound downloads were deployed. */
export function installMediaRecovery():()=>void {
  const attempted=new WeakMap<Element,string>();let pending:Promise<boolean>|null=null,lastAttempt=0;
  const onError=(event:Event)=>{
    const element=event.target;
    if(!(element instanceof HTMLImageElement||element instanceof HTMLMediaElement))return;
    const source=element.currentSrc||element.src;
    if(!source)return;
    const url=new URL(source,location.href);
    if(url.origin!==location.origin||!url.pathname.startsWith('/api/attachments/')||attempted.get(element)===source)return;
    attempted.set(element,source);
    if(!pending&&Date.now()-lastAttempt<15_000)return;
    if(!pending){lastAttempt=Date.now();pending=refreshSession().catch(()=>false).finally(()=>{pending=null;});}
    void pending.then(ok=>{
      if(!ok||!element.isConnected)return;
      url.searchParams.set('mediaRetry',String(Date.now()));
      attempted.set(element,url.href);element.src=url.href;
      if(element instanceof HTMLMediaElement)element.load();
    });
  };
  document.addEventListener('error',onError,true);
  return ()=>document.removeEventListener('error',onError,true);
}
