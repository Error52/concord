import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,readFile,writeFile,stat,chmod,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function sandbox(fn){const temp=await mkdtemp(path.join(os.tmpdir(),'concord-deploy-'));try{await fn(temp);}finally{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.ok(path.basename(temp).startsWith('concord-deploy-'));await rm(temp,{recursive:true,force:true});}}
test('dev init and LAN updates protect env permissions, secrets and configured ports',async()=>sandbox(async temp=>{
 await mkdir(path.join(temp,'scripts'));await copyFile(path.join(root,'scripts/dev.mjs'),path.join(temp,'scripts/dev.mjs'));await copyFile(path.join(root,'.env.example'),path.join(temp,'.env.example'));
 const run=(...args)=>{const result=spawnSync(process.execPath,[path.join(temp,'scripts/dev.mjs'),...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);};
 run('init');const filename=path.join(temp,'.env'),initial=await readFile(filename,'utf8');
 if(process.platform!=='win32')assert.equal((await stat(filename)).mode&0o777,0o600);
 run('init');assert.equal(await readFile(filename,'utf8'),initial);
 await chmod(filename,0o644);run('lan-config','192.168.50.10');const updated=await readFile(filename,'utf8');
 for(const key of ['POSTGRES_PASSWORD','JWT_SECRET','LIVEKIT_API_SECRET','TURN_PASSWORD','LIVEKIT_TCP_PORT','LIVEKIT_UDP_PORT'])assert.equal(updated.match(new RegExp('^'+key+'=(.*)$','m'))[1],initial.match(new RegExp('^'+key+'=(.*)$','m'))[1]);
 assert.match(updated,/^DEMO_MAILBOX=true$/m);if(process.platform!=='win32')assert.equal((await stat(filename)).mode&0o777,0o600);
}));
const docker=spawnSync('docker',['compose','version'],{encoding:'utf8'});
test('Compose keeps explicit SMTP, custom registry/media ports and refuses an unknown database image',{skip:docker.status!==0?'Docker Compose is required':false},async()=>sandbox(async temp=>{
 const example=await readFile(path.join(root,'.env.example'),'utf8'),filename=path.join(temp,'test.env');
 const env={...process.env};for(const line of example.split('\n')){const key=/^([A-Z0-9_]+)=/.exec(line)?.[1];if(key)delete env[key];}
 let content=example.replace(/^SMTP_HOST=.*$/m,'SMTP_HOST=').replace(/^NPM_REGISTRY=.*$/m,'NPM_REGISTRY=https://registry.example.com').replace(/^LIVEKIT_TCP_PORT=.*$/m,'LIVEKIT_TCP_PORT=7981').replace(/^LIVEKIT_UDP_PORT=.*$/m,'LIVEKIT_UDP_PORT=7982');
 await writeFile(filename,content,{mode:0o600});
 const run=()=>spawnSync('docker',['compose','--env-file',filename,'config','--format','json'],{cwd:root,env,encoding:'utf8'});
 const result=run();assert.equal(result.status,0,result.stderr);const config=JSON.parse(result.stdout);
 assert.equal(config.services.backend.environment.SMTP_HOST,'');assert.equal(config.services.frontend.build.args.NPM_REGISTRY,'https://registry.example.com');
 assert.ok(config.services.livekit.ports.some(p=>p.target===7981&&String(p.published)==='7981'));assert.ok(config.services.livekit.ports.some(p=>p.target===7982&&p.protocol==='udp'));
 content=content.replace(/^POSTGRES_IMAGE=.*\n/m,'');await writeFile(filename,content);const missing=run();assert.notEqual(missing.status,0);assert.match(missing.stderr,/POSTGRES_IMAGE/);
}));
