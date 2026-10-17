import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Message,SelfUser,Channel,Notification} from '../src/types';

Object.defineProperty(globalThis,'window',{value:Object.assign(new EventTarget(),{matchMedia:()=>({matches:true}),setTimeout:(fn:()=>void,ms:number)=>setTimeout(fn,ms).unref(),clearTimeout,setInterval,clearInterval}),configurable:true});
Object.defineProperty(globalThis,'document',{value:Object.assign(new EventTarget(),{visibilityState:'hidden',hasFocus:()=>false}),configurable:true});
Object.defineProperty(globalThis,'location',{value:{protocol:'http:',host:'localhost',pathname:'/channels/@me',search:''},configurable:true});
Object.defineProperty(globalThis,'history',{value:{pushState(){},replaceState(){}},configurable:true});
const {api}=await import('../src/api/client');
const {appStore,initialState,getState}=await import('../src/state/app');
const {loadMessages,loadOlder,loadNewer,markRead,gateway,markNotificationsRead,clearNotifications,refreshServer}=await import('../src/state/actions');
const {routerStore}=await import('../src/state/router');
const {closeDm,sendFriendRequest,acceptFriend}=await import('../src/state/serverActions');
const channelId='00000000-0000-4000-8000-000000000001';
const message=(id:string,content=id):Message=>({id,content,channelId,serverId:null,author:null,kind:'default',replyTo:null,attachments:[],embeds:[],reactions:[],mentionIds:[],mentionsEveryone:false,pinned:false,editedAt:null,createdAt:'2026-10-16T00:00:00Z'});
function reset(items:Message[]=[],atLatest=true){routerStore.set({route:{name:'friends'}});appStore.set({...initialState,auth:'authed',me:{id:'me'} as SelfUser,channels:{[channelId]:{id:channelId,lastMessageId:items.at(-1)?.id} as Channel},messages:{[channelId]:{items,loading:false,atLatest,hasMoreBefore:true}}});}
function event(t:string,d:unknown){for(const fn of (gateway as any).handlers.get(t)??[])fn(d);}
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};

const fullServer=(name='Server'):any=>({server:{id:'server',name},channels:[{id:channelId,serverId:'server'}],roles:[],members:[],voiceStates:[],permissions:'1'});
test('a late server refresh cannot resurrect a removed server',async(t)=>{
 reset();event('server:create',fullServer());const response=deferred<any>();t.mock.method(api,'get',()=>response.promise);
 const loading=refreshServer('server');event('server:removed',{id:'server',reason:'leave'});response.resolve(fullServer());await loading;
 assert.equal(getState().servers.server,undefined);assert.equal(getState().permissions.server,undefined);assert.equal(getState().channels[channelId],undefined);
});
test('server refresh ignores older responses and a newer ready snapshot',async(t)=>{
 reset();event('server:create',fullServer());const a=deferred<any>(),b=deferred<any>();let n=0;t.mock.method(api,'get',()=>++n===1?a.promise:b.promise);
 const first=refreshServer('server'),second=refreshServer('server');b.resolve(fullServer('New'));await second;a.resolve(fullServer('Old'));await first;
 assert.equal(getState().servers.server!.name,'New');
 const stale=deferred<any>();t.mock.method(api,'get',()=>stale.promise);const loading=refreshServer('server');
 event('ready',{user:{id:'me'},dms:[],relationships:[],readStates:[],notifications:{items:[],unread:0},incomingCalls:[],features:{gif:{enabled:false}},servers:[],dmVoiceStates:[],voiceState:null});
 stale.resolve(fullServer());await loading;assert.equal(getState().servers.server,undefined);
});

test('server refresh replays channel and member changes received during its snapshot',async(t)=>{
 reset();const full=fullServer();full.members=[{serverId:'server',user:{id:'departing'},roleIds:[]}];event('server:create',full);
 const response=deferred<any>();t.mock.method(api,'get',()=>response.promise);const loading=refreshServer('server');
 event('channel:delete',{id:channelId,serverId:'server'});
 event('channel:create',{id:'new-channel',serverId:'server',name:'Created live'});
 event('member:leave',{serverId:'server',userId:'departing'});
 event('member:join',{serverId:'server',user:{id:'joining'},roleIds:[]});
 response.resolve(full);await loading;
 assert.equal(getState().channels[channelId],undefined);assert.equal(getState().channels['new-channel']?.name,'Created live');
 assert.equal(getState().members.server?.departing,undefined);assert.equal(getState().members.server?.joining?.user.id,'joining');
});

test('server refresh retains current voice state, profile, and message marker',async(t)=>{
 reset();const full=fullServer();full.channels[0].lastMessageId='100';full.members=[{serverId:'server',user:{id:'other',username:'Old'},roleIds:[]}];
 full.voiceStates=[{serverId:'server',channelId,userId:'other',selfMute:false}];event('server:create',full);
 const response=deferred<any>();t.mock.method(api,'get',()=>response.promise);const loading=refreshServer('server');
 event('voice:leave',{userId:'other',channelId});event('user:update',{id:'other',username:'New'});event('message:new',{...message('500'),serverId:'server'});
 response.resolve(full);await loading;
 assert.equal(getState().voiceStates.other,undefined);assert.equal(getState().users.other?.username,'New');assert.equal(getState().channels[channelId]?.lastMessageId,'500');
});

test('ready removes inaccessible server data and expired activity from the old connection',()=>{
 reset();event('server:create',fullServer());appStore.set({typing:{[channelId]:{other:{name:'Old',until:Date.now()+8000}}},speaking:{other:true}});
 event('ready',{user:{id:'me'},dms:[],relationships:[],readStates:[],notifications:{items:[],unread:0},incomingCalls:[],features:{gif:{enabled:false}},servers:[],dmVoiceStates:[],voiceState:null});
 assert.deepEqual(getState().roles,{});assert.deepEqual(getState().members,{});assert.deepEqual(getState().permissions,{});assert.deepEqual(getState().typing,{});assert.deepEqual(getState().speaking,{});
});

test('a superseded history request cannot replace a newer window',async(t)=>{
 reset();const old=deferred<Message[]>(),fresh=deferred<Message[]>();let calls=0;
 t.mock.method(api,'get',()=>++calls===1?old.promise:fresh.promise);
 const a=loadMessages(channelId,{reset:true}),b=loadMessages(channelId,{reset:true});
 fresh.resolve([message('200')]);await b;old.resolve([message('100')]);await a;
 assert.deepEqual(getState().messages[channelId]!.items.map(m=>m.id),['200']);
});

test('history loading preserves live arrivals, edits and deletions after its snapshot',async(t)=>{
 reset();const page=deferred<Message[]>();t.mock.method(api,'get',()=>page.promise);
 const loading=loadMessages(channelId,{reset:true});
 event('message:new',message('300'));event('message:update',message('100','edited live'));event('message:delete',{channelId,id:'200'});
 page.resolve([message('100','old'),message('200')]);await loading;
 assert.deepEqual(getState().messages[channelId]!.items.map(m=>[m.id,m.content]),[['100','edited live'],['300','300']]);
});

test('a failed newer-page request keeps history and permits another attempt',async(t)=>{
 reset([message('100')],false);let calls=0;t.mock.method(api,'get',async()=>{if(++calls===1)throw new Error('offline');return [message('200')];});
 await loadNewer(channelId);assert.equal(getState().messages[channelId]!.atLatest,false);assert.equal(getState().messages[channelId]!.loading,false);
 await loadNewer(channelId);assert.equal(calls,2);assert.deepEqual(getState().messages[channelId]!.items.map(m=>m.id),['100','200']);
});

test('pagination merges overlapping messages once and includes new authors',async(t)=>{
 reset([message('200')]);t.mock.method(api,'get',async()=>[message('100'),{...message('200'),author:{id:'author',username:'new'}}]);
 await loadOlder(channelId);assert.deepEqual(getState().messages[channelId]!.items.map(m=>m.id),['100','200']);
 assert.equal(getState().users.author?.username,'new');
});

test('a disconnected cache is not resurrected by an old pagination failure',async(t)=>{
 reset([message('100')],false);const pending=deferred<Message[]>();t.mock.method(api,'get',()=>pending.promise);
 const load=loadNewer(channelId);appStore.set({...initialState,auth:'guest'});pending.resolve([message('200')]);await load;
 assert.deepEqual(getState().messages,{});
});

test('failed initial loading retains already visible messages and can be retried',async(t)=>{
 reset([message('100')]);let calls=0;t.mock.method(api,'get',async()=>{if(++calls===1)throw new Error('offline');return [message('200')];});
 await loadMessages(channelId,{reset:true});assert.deepEqual(getState().messages[channelId]!.items.map(m=>m.id),['100']);
 await loadMessages(channelId);assert.equal(calls,2);assert.equal(getState().messages[channelId]!.items[0]?.id,'200');
});

test('a failed read acknowledgement is retried',async(t)=>{
 reset([message('100')]);appStore.set({readStates:{[channelId]:{channelId,lastReadId:'50',mentionCount:1}}});let calls=0;
 t.mock.method(api,'post',async()=>{if(++calls===1)throw new Error('offline');});
 await markRead(channelId,'100');await markRead(channelId,'100');assert.equal(calls,2);
});

test('a failed older read acknowledgement cannot overwrite a newer gateway marker',async(t)=>{
 reset([message('100')]);let reject!:(e:Error)=>void;
 t.mock.method(api,'post',()=>new Promise((_resolve,fail)=>reject=fail));
 const pending=markRead(channelId,'100');event('read:update',{channelId,lastReadId:'200',mentionCount:1});
 reject(new Error('offline'));await pending;
 assert.deepEqual(getState().readStates[channelId],{channelId,lastReadId:'200',mentionCount:1});
});

test('late duplicate sends do not move the channel and read marker backwards',()=>{
 reset([message('300')]);appStore.set({readStates:{[channelId]:{channelId,lastReadId:'300',mentionCount:1}}});
 event('message:new',{...message('200'),author:{id:'me'}});
 assert.equal(getState().channels[channelId]!.lastMessageId,'300');assert.equal(getState().readStates[channelId]!.lastReadId,'300');
});

test('duplicate message delivery does not count a mention twice',()=>{
 reset();const m={...message('400'),mentionIds:['me'],author:{id:'other'} as any};
 event('message:new',m);event('message:new',m);
 assert.equal(getState().readStates[channelId]!.mentionCount,1);
});

test('ready read revisions prevent replayed messages from counting existing mentions again',()=>{
 reset();event('ready',{user:{id:'me'},dms:[],relationships:[],readStates:[{channelId,lastReadId:'50',mentionCount:2,revision:'4'}],notifications:{items:[],unread:0},incomingCalls:[],features:{gif:{enabled:false}},servers:[],dmVoiceStates:[],voiceState:null});
 event('message:new',{...message('100'),mentionIds:['me'],author:{id:'other'}});
 event('message:new',{...message('200'),author:{id:'me'}});
 assert.deepEqual(getState().readStates[channelId],{channelId,lastReadId:'50',mentionCount:2,revision:'4'});
 event('read:update',{channelId,lastReadId:'200',mentionCount:0,revision:'5'});
 assert.deepEqual(getState().readStates[channelId],{channelId,lastReadId:'200',mentionCount:0,revision:'5'});
});

test('read state revisions reject old deliveries and allow an explicit newer mark unread',()=>{
 reset();event('read:update',{channelId,lastReadId:'200',mentionCount:0,revision:'8'});
 event('read:update',{channelId,lastReadId:'100',mentionCount:4,revision:'7'});
 event('read:update',{channelId,lastReadId:'50',mentionCount:8});
 assert.equal(getState().readStates[channelId]?.lastReadId,'200');
 event('read:update',{channelId,lastReadId:'100',mentionCount:4,revision:'9'});
 assert.deepEqual(getState().readStates[channelId],{channelId,lastReadId:'100',mentionCount:4,revision:'9'});
 event('message:new',{...message('300'),mentionIds:['me'],author:{id:'other'}});
 assert.equal(getState().readStates[channelId]?.mentionCount,4);
});

test('a late failed acknowledgement retains a newer read state revision',async(t)=>{
 reset([message('300')]);appStore.set({readStates:{[channelId]:{channelId,lastReadId:'100',mentionCount:2,revision:'3'}}});
 let reject!:(err:Error)=>void;t.mock.method(api,'post',()=>new Promise((_resolve,fail)=>reject=fail));
 const loading=markRead(channelId,'300');assert.equal(getState().readStates[channelId]?.revision,'3');
 event('read:update',{channelId,lastReadId:'200',mentionCount:1,revision:'4'});reject(new Error('offline'));await loading;
 assert.deepEqual(getState().readStates[channelId],{channelId,lastReadId:'200',mentionCount:1,revision:'4'});
});

test('a stale call dismissal does not hide a newer ring in the same DM',()=>{
 reset();const incoming={channelId,caller:{id:'other'},video:false,timeoutSec:45};
 event('call:incoming',{...incoming,id:'first'});event('call:incoming',{...incoming,id:'second'});
 event('call:declined',{channelId,ringId:'first'});
 assert.equal((getState().incomingCalls[0] as any)?.id,'second');
 event('call:declined',{channelId,ringId:'second'});assert.equal(getState().incomingCalls.length,0);
});

const notification=(id:string):Notification=>({id,type:'server',data:{},read:false,createdAt:'2026-10-16T00:00:00Z'});
test('notification read responses leave later arrivals unread',async(t)=>{
 reset();appStore.set({notifications:[notification('old')],unreadNotifications:1});const response=deferred<{ids:string[];unreadChanged:number}>();
 t.mock.method(api,'post',()=>response.promise);const reading=markNotificationsRead();event('notification:new',notification('new'));
 response.resolve({ids:['old'],unreadChanged:1});await reading;
 assert.equal(getState().unreadNotifications,1);assert.equal(getState().notifications.find(n=>n.id==='new')!.read,false);assert.equal(getState().notifications.find(n=>n.id==='old')!.read,true);
});
test('clearing notifications removes only rows actually deleted by the server',async(t)=>{
 reset();appStore.set({notifications:[notification('old')],unreadNotifications:1});const response=deferred<{ids:string[];unreadChanged:number}>();
 t.mock.method(api,'del',()=>response.promise);const clearing=clearNotifications();event('notification:new',notification('new'));
 response.resolve({ids:['old'],unreadChanged:1});await clearing;
 assert.deepEqual(getState().notifications.map(n=>n.id),['new']);assert.equal(getState().unreadNotifications,1);
});

test('notification read and clear synchronize across gateways and HTTP without double subtraction',async(t)=>{
 reset();appStore.set({notifications:[notification('old')],unreadNotifications:1});
 const result={mutationId:'cross-tab-read',ids:['old'],unreadChanged:1};t.mock.method(api,'post',async()=>{event('notification:read',result);event('notification:read',result);event('notification:new',notification('new'));return result;});
 await markNotificationsRead();assert.equal(getState().unreadNotifications,1);assert.equal(getState().notifications.find(n=>n.id==='old')!.read,true);
 event('notification:clear',{mutationId:'cross-tab-clear',ids:['old'],unreadChanged:0});assert.deepEqual(getState().notifications.map(n=>n.id),['new']);assert.equal(getState().unreadNotifications,1);
});
test('failed notification mutations preserve visible notifications and their counters',async(t)=>{
 reset();appStore.set({notifications:[notification('old')],unreadNotifications:1});t.mock.method(api,'post',async()=>{throw new Error('offline');});
 await assert.rejects(markNotificationsRead(),/offline/);assert.equal(getState().notifications[0]!.read,false);assert.equal(getState().unreadNotifications,1);
});
test('a fresh ready snapshot supersedes an older notification acknowledgement',async(t)=>{
 reset();const response=deferred<{ids:string[];unreadChanged:number}>();t.mock.method(api,'post',()=>response.promise);const reading=markNotificationsRead();
 event('ready',{user:{id:'me'},dms:[],relationships:[],readStates:[],notifications:{items:[notification('fresh')],unread:1},incomingCalls:[],features:{gif:{enabled:false}},servers:[],dmVoiceStates:[],voiceState:null});
 response.resolve({ids:['old'],unreadChanged:100});await reading;assert.equal(getState().unreadNotifications,1);assert.equal(getState().notifications[0]!.id,'fresh');
});

test('late notification events already included in ready do not change the fresh counter',()=>{
 reset();event('ready',{user:{id:'me'},dms:[],relationships:[],readStates:[],notifications:{items:[{...notification('old'),read:true},notification('fresh')],unread:1,revision:'4'},incomingCalls:[],features:{gif:{enabled:false}},servers:[],dmVoiceStates:[],voiceState:null});
 event('notification:read',{mutationId:'late-read',ids:['old'],unreadChanged:1,unread:0,revision:'3'});
 event('notification:new',{...notification('old'),revision:'2',unread:1});
 assert.equal(getState().unreadNotifications,1);assert.equal(getState().notifications.find(n=>n.id==='old')!.read,true);
});

test('out of order notification events retain the latest count and each row state',()=>{
 reset();event('ready',{user:{id:'me'},dms:[],relationships:[],readStates:[],notifications:{items:[],unread:0,revision:'0'},incomingCalls:[],features:{gif:{enabled:false}},servers:[],dmVoiceStates:[],voiceState:null});
 event('notification:new',{...notification('new'),revision:'3',unread:1});
 event('notification:read',{mutationId:'read-before-create',ids:['old'],unreadChanged:1,unread:0,revision:'2'});
 event('notification:new',{...notification('old'),revision:'1',unread:1});
 assert.equal(getState().unreadNotifications,1);assert.equal(getState().notifications.find(n=>n.id==='old')!.read,true);
 event('notification:clear',{mutationId:'clear-before-create',ids:['deleted'],unreadChanged:1,revision:'5',unread:1});
 event('notification:new',{...notification('deleted'),revision:'4',unread:2});
 assert.equal(getState().notifications.some(n=>n.id==='deleted'),false);assert.equal(getState().unreadNotifications,1);
});
test('failed DM close keeps the conversation and current route',async(t)=>{
 reset();const dm={id:channelId,recipients:[],lastMessageId:'100'} as any;appStore.set({dms:{[channelId]:dm}});routerStore.set({route:{name:'dm',channelId}});
 t.mock.method(api,'del',async()=>{throw new Error('offline');});await closeDm(channelId);
 assert.equal(getState().dms[channelId],dm);assert.equal(routerStore.get().route.name,'dm');
});
test('successful close leaves the active DM after the server confirms it',async(t)=>{
 reset();appStore.set({dms:{[channelId]:{id:channelId,recipients:[]} as any}});routerStore.set({route:{name:'dm',channelId}});
 t.mock.method(api,'del',async()=>undefined);await closeDm(channelId);assert.equal(getState().dms[channelId],undefined);assert.equal(routerStore.get().route.name,'friends');
});
test('a later incoming message supersedes an older DM close response',async(t)=>{
 reset();const dm={id:channelId,recipients:[],lastMessageId:'100'} as any;appStore.set({dms:{[channelId]:dm}});const response=deferred<void>();t.mock.method(api,'del',()=>response.promise);
 const close=closeDm(channelId);event('dm:create',{...dm,lastMessageId:'200'});response.resolve();await close;assert.equal(getState().dms[channelId]!.lastMessageId,'200');
});
test('a close confirmed by a refreshed snapshot still leaves the old DM route',async(t)=>{
 reset();appStore.set({dms:{[channelId]:{id:channelId,recipients:[]} as any}});routerStore.set({route:{name:'dm',channelId}});
 const response=deferred<void>();t.mock.method(api,'del',()=>response.promise);const close=closeDm(channelId);appStore.set({dms:{}});response.resolve();await close;
 assert.equal(routerStore.get().route.name,'friends');
});

const relation=(id:string):any=>({id,type:'friend',user:{id,username:id}});
test('a late friend response cannot replace a newer gateway relationship list',async(t)=>{
 reset();const response=deferred<any[]>();t.mock.method(api,'post',()=>response.promise);
 const request=sendFriendRequest({userId:'pending'});event('friend:update',[relation('newer')]);response.resolve([relation('old')]);await request;
 assert.deepEqual(Object.keys(getState().relationships),['newer']);
});

test('a late friend response is fenced by ready snapshots and account changes',async(t)=>{
 reset();const response=deferred<any[]>();t.mock.method(api,'post',()=>response.promise);const request=acceptFriend('pending');
 event('ready',{user:{id:'me'},dms:[],relationships:[relation('snapshot')],readStates:[],notifications:{items:[],unread:0},incomingCalls:[],features:{gif:{enabled:false}},servers:[],dmVoiceStates:[],voiceState:null});
 response.resolve([relation('old')]);await request;assert.deepEqual(Object.keys(getState().relationships),['snapshot']);
 const changed=deferred<any[]>();t.mock.method(api,'post',()=>changed.promise);const old=acceptFriend('pending');appStore.set({me:{id:'another'} as SelfUser});changed.resolve([relation('leaked')]);await old;
 assert.deepEqual(Object.keys(getState().relationships),['snapshot']);
});

test('concurrent friend HTTP responses retain the newest requested snapshot',async(t)=>{
 reset();const first=deferred<any[]>(),second=deferred<any[]>();let n=0;t.mock.method(api,'post',()=>++n===1?first.promise:second.promise);
 const old=acceptFriend('first'),fresh=acceptFriend('second');second.resolve([relation('second')]);await fresh;first.resolve([relation('first')]);await old;
 assert.deepEqual(Object.keys(getState().relationships),['second']);
});
