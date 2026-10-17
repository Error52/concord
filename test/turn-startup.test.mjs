import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const run=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const available=(()=>{try{run('compose','version');return true;}catch{return false;}})();
test('pinned coturn starts with the exact Compose command',{skip:available?false:'Docker Compose is required',timeout:120000},async()=>{
 const name='concord-turn-test-'+randomUUID().slice(0,8),network=name+'-net',sfu=name+'-sfu';
 try{
  const config=JSON.parse(run('compose','--env-file','.env.example','config','--format','json'));
  const turn=config.services.coturn;
  run('network','create',network);
  run('run','-d','--name',sfu,'--network',network,'--network-alias','livekit','node:24-bookworm-slim','node','-e','setInterval(()=>{},1000)');
  run('run','-d','--name',name,'--network',network,'--entrypoint','/bin/sh','-v',`${fileURLToPath(new URL('../deploy/start-turn.sh',import.meta.url))}:/etc/concord/start-turn.sh:ro`,turn.image,'/etc/concord/start-turn.sh',...turn.command);
  await new Promise(resolve=>setTimeout(resolve,2500));
  const state=JSON.parse(run('inspect',name))[0].State;
  assert.equal(state.Running,true,'coturn must stay up, exit='+state.ExitCode);
  const original=JSON.parse(run('inspect',sfu))[0].NetworkSettings.Networks[network].IPAddress;
  const ip=original.split('.');ip[3]=String(Number(ip[3])+10);
  run('rm','-f',sfu);run('run','-d','--name',sfu,'--network',network,'--network-alias','livekit','--ip',ip.join('.'),'node:24-bookworm-slim','node','-e','setInterval(()=>{},1000)');
  let changed=false;for(let i=0;i<20;i++){await new Promise(resolve=>setTimeout(resolve,500));if(run('logs',name).includes('LiveKit address changed')){changed=true;break;}}
  assert.equal(changed,true,'coturn refreshes the private peer exception when LiveKit changes address');
  await new Promise(resolve=>setTimeout(resolve,1000));assert.equal(JSON.parse(run('inspect',name))[0].State.Running,true);
 }finally{for(const container of [name,sfu])try{run('rm','-f',container);}catch{}try{run('network','rm',network);}catch{}}
});
