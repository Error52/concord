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
 assert.match(updated,/^BOOTSTRAP_FIRST_ADMIN=true$/m);
}));
const docker=spawnSync('docker',['compose','version'],{encoding:'utf8'});
test('Compose keeps explicit SMTP, custom registry/media ports and refuses an unknown database image',{skip:docker.status!==0?'Docker Compose is required':false},async()=>sandbox(async temp=>{
 const example=await readFile(path.join(root,'.env.example'),'utf8'),filename=path.join(temp,'test.env');
 const env={...process.env};for(const line of example.split('\n')){const key=/^([A-Z0-9_]+)=/.exec(line)?.[1];if(key)delete env[key];}
 let content=example.replace(/^SMTP_HOST=.*$/m,'SMTP_HOST=').replace(/^ACCOUNT_VERIFICATION_MODE=.*$/m,'ACCOUNT_VERIFICATION_MODE=secret-word').replace(/^NPM_REGISTRY=.*$/m,'NPM_REGISTRY=https://registry.example.com').replace(/^LIVEKIT_TCP_PORT=.*$/m,'LIVEKIT_TCP_PORT=7981').replace(/^LIVEKIT_UDP_PORT=.*$/m,'LIVEKIT_UDP_PORT=7982').replace(/^COMPOSE_PROFILES=.*$/m,'COMPOSE_PROFILES=server').replace(/^PUBLIC_HTTPS_PORT=.*$/m,'PUBLIC_HTTPS_PORT=8443');
 await writeFile(filename,content,{mode:0o600});
 const run=()=>spawnSync('docker',['compose','--env-file',filename,'config','--format','json'],{cwd:root,env,encoding:'utf8'});
 const result=run();assert.equal(result.status,0,result.stderr);const config=JSON.parse(result.stdout);
 assert.equal(config.services.backend.environment.SMTP_HOST,'');assert.equal(config.services.frontend.build.args.NPM_REGISTRY,'https://registry.example.com');
 assert.equal(config.services.backend.environment.ACCOUNT_VERIFICATION_MODE,'secret-word');
 assert.equal(String(config.services.backend.environment.BOOTSTRAP_FIRST_ADMIN),'true');
 assert.ok(config.services.livekit.ports.some(p=>p.target===7981&&String(p.published)==='7981'));assert.ok(config.services.livekit.ports.some(p=>p.target===7982&&p.protocol==='udp'));
 assert.ok(config.services['caddy-public'].ports.some(p=>p.target===8443&&String(p.published)==='8443'));assert.equal(String(config.services['caddy-public'].environment.PUBLIC_HTTPS_PORT),'8443');
 for(const service of Object.values(config.services))assert.equal(service.logging.options['max-size'],'10m');
 content=content.replace(/^POSTGRES_IMAGE=.*\n/m,'');await writeFile(filename,content);const missing=run();assert.notEqual(missing.status,0);assert.match(missing.stderr,/POSTGRES_IMAGE/);
}));

test('Compose does not bootstrap a public administrator when the setting is missing',{skip:docker.status!==0?'Docker Compose is required':false},async()=>sandbox(async temp=>{
 const example=await readFile(path.join(root,'.env.example'),'utf8');
 const filename=path.join(temp,'public.env');
 await writeFile(filename,example.replace(/^BOOTSTRAP_FIRST_ADMIN=.*\n/m,''),{mode:0o600});
 const env={...process.env};for(const line of example.split('\n')){const key=/^([A-Z0-9_]+)=/.exec(line)?.[1];if(key)delete env[key];}
 const result=spawnSync('docker',['compose','--env-file',filename,'config','--format','json'],{cwd:root,env,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.equal(String(JSON.parse(result.stdout).services.backend.environment.BOOTSTRAP_FIRST_ADMIN),'false');
}));
