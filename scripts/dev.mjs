#!/usr/bin/env node
import {readFile,writeFile,access,chmod} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import net from 'node:net';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const command=process.argv[2]??'help';
const secret=()=>randomBytes(32).toString('hex');
async function init(){
 const file=path.join(root,'.env');
 try{await access(file);console.log('Existing .env preserved.');return;}catch{}
 const password=secret();
 const values={APP_URL:'http://localhost:8080',HTTP_PORT:'8080',HTTP_BIND:'127.0.0.1',POSTGRES_PASSWORD:password,DATABASE_URL:`postgres://concord:${password}@localhost:5432/concord`,JWT_SECRET:secret(),LIVEKIT_API_SECRET:secret(),TURN_PASSWORD:secret(),LIVEKIT_TCP_PORT:'7981',LIVEKIT_UDP_PORT:'7982',GIF_PROVIDER:'none',COMPOSE_PROFILES:'dev'};
 const template=await readFile(path.join(root,'.env.example'),'utf8');
 const out=template.split(/\r?\n/).map(line=>{const key=line.match(/^([A-Z_]+)=/u)?.[1];return key&&key in values?`${key}=${values[key]}`:line;}).join('\n');
 await writeFile(file,out,{flag:'wx',mode:0o600});console.log('Created local .env with fresh secrets. Open http://localhost:8080 after startup.');
}
function docker(args){const r=spawnSync('docker',args,{cwd:root,stdio:'inherit'});if(r.error){console.error('Docker with Compose v2 is required:',r.error.message);process.exit(1);}process.exitCode=r.status??1;}
async function lanConfig(){
 const ip=process.argv[3];
 if(!ip||net.isIP(ip)!==4||!/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(ip))throw new Error('Use a private IPv4 address of this server: node scripts/dev.mjs lan <IP>');
 await init();
 const file=path.join(root,'.env'),old=await readFile(file,'utf8');
 const values={APP_URL:`https://${ip}:8443`,HTTPS_PORT:'8443',HTTP_BIND:'127.0.0.1',COOKIE_SECURE:'true',DEMO_MAILBOX:'true',BOOTSTRAP_FIRST_ADMIN:'true',COMPOSE_PROFILES:'https,dev',LIVEKIT_NODE_IP:ip,TURN_PUBLIC_HOST:ip,TURN_EXTERNAL_IP:ip};
 const seen=new Set();const lines=old.split(/\r?\n/).map(line=>{const key=line.match(/^([A-Z0-9_]+)=/)?.[1];if(key&&key in values){seen.add(key);return `${key}=${values[key]}`;}return line;});
 for(const [key,value] of Object.entries(values))if(!seen.has(key))lines.push(`${key}=${value}`);
 if(process.platform!=='win32')await chmod(file,0o600);
 await writeFile(file,lines.join('\n'),{mode:0o600});console.log(`LAN configuration ready: https://${ip}:8443 (demo mail). Existing secrets/data preserved.`);
}
if(command==='init')await init();
else if(command==='up'){await init();docker(['compose','up','--build','-d']);}
else if(command==='lan-config')await lanConfig();
else if(command==='lan'){await lanConfig();docker(['compose','up','--build','-d']);}
else if(command==='stop')docker(['compose','stop']);
else if(command==='logs')docker(['compose','logs','--tail','100']);
else if(command==='test-api')docker(['compose','-p','concord-tests','-f','test/compose.yml','up','--build','--abort-on-container-exit','--exit-code-from','api']);
else{console.log('node scripts/dev.mjs init | up | lan <IP> | lan-config <IP> | stop | logs | test-api');if(command!=='help')process.exitCode=2;}
