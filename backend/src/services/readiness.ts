import {pool} from '../db/pool.js';
import {redis} from '../redis.js';

/** Bound response time and keep one probe in flight while a dependency is unavailable. */
export function createReadinessProbe(checks:()=>Promise<unknown>,deadlineMs=1500,cacheMs=1000):()=>Promise<boolean>{
  let pending:Promise<boolean>|undefined,cached=false,expires=0;
  return async()=>{
    if(Date.now()<expires)return cached;
    if(!pending){
      const work=Promise.resolve().then(checks).then(()=>true,()=>false);
      pending=work;
      void work.then(ok=>{cached=ok;expires=Date.now()+cacheMs;pending=undefined;});
    }
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([pending,new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),deadlineMs);})]);}
    finally{if(timer)clearTimeout(timer);}
  };
}

export const isReady=createReadinessProbe(async()=>{
  const query={text:'SELECT 1',query_timeout:1000};
  const results=await Promise.allSettled([pool.query(query),redis.ping()]);
  if(results.some(r=>r.status==='rejected'))throw new Error('Dependency unavailable');
});
