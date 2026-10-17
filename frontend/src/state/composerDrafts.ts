import {createStore,useStoreSelector} from './store';

// A draft belongs to an account/channel/thread, rather than to one mounted editor.
// Late send failures must also reach an editor that was reopened in the meantime.
const drafts=createStore<{values:Record<string,string>}>({values:{}});
const failedSends=new Map<string,string>();
const sendKey=(draftKey:string,payload:string):string=>JSON.stringify([draftKey,payload]);
export const getComposerDraft=(key:string):string=>drafts.get().values[key]??'';
export function setComposerDraft(key:string,value:string|((current:string)=>string)):void {
  const current=getComposerDraft(key),next=typeof value==='function'?value(current):value;
  if(current===next)return;
  drafts.set(s=>{
    const values={...s.values};
    if(next)values[key]=next;else delete values[key];
    return {values};
  });
}
export function restoreComposerDraft(key:string,original:string):void {
  if(original)setComposerDraft(key,current=>current||original);
}
export function useComposerDraft(key:string):readonly[string,(value:string|((current:string)=>string))=>void] {
  return [useStoreSelector(drafts,s=>s.values[key]??''),value=>setComposerDraft(key,value)];
}
export function composerRetryNonce(key:string,payload:string):string|undefined {
  return failedSends.get(sendKey(key,payload));
}
export function rememberComposerSend(key:string,payload:string,nonce:string,ok:boolean):void {
  const id=sendKey(key,payload);
  if(ok){if(failedSends.get(id)===nonce)failedSends.delete(id);return;}
  failedSends.delete(id);failedSends.set(id,nonce);
  while(failedSends.size>128)failedSends.delete(failedSends.keys().next().value!);
}
