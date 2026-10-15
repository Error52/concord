import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Message,SelfUser,Channel,Notification} from '../src/types';

Object.defineProperty(globalThis,'window',{value:Object.assign(new EventTarget(),{matchMedia:()=>({matches:true}),setTimeout:(fn:()=>void,ms:number)=>setTimeout(fn,ms).unref(),clearTimeout,setInterval,clearInterval}),configurable:true});
Object.defineProperty(globalThis,'document',{value:Object.assign(new EventTarget(),{visibilityState:'hidden',hasFocus:()=>false}),configurable:true});
Object.defineProperty(globalThis,'location',{value:{protocol:'http:',host:'localhost',pathname:'/channels/@me',search:''},configurable:true});
Object.defineProperty(globalThis,'history',{value:{pushState(){},replaceState(){}},configurable:true});
const {api}=await import('../src/api/client');
const {appStore,initialState,getState}=await import('../src/state/app');
const {loadMessages,loadOlder,loadNewer,markRead,gateway,markNotificationsRead,clearNotifications}=await import('../src/state/actions');
const {routerStore}=await import('../src/state/router');
const {closeDm}=await import('../src/state/serverActions');
const channelId='00000000-0000-4000-8000-000000000001';
const message=(id:string,content=id):Message=>({id,content,channelId,serverId:null,author:null,kind:'default',replyTo:null,attachments:[],embeds:[],reactions:[],mentionIds:[],mentionsEveryone:false,pinned:false,editedAt:null,createdAt:'2026-10-16T00:00:00Z'});
function reset(items:Message[]=[],atLatest=true){routerStore.set({route:{name:'friends'}});appStore.set({...initialState,auth:'authed',me:{id:'me'} as SelfUser,channels:{[channelId]:{id:channelId,lastMessageId:items.at(-1)?.id} as Channel},messages:{[channelId]:{items,loading:false,atLatest,hasMoreBefore:true}}});}
function event(t:string,d:unknown){for(const fn of (gateway as any).handlers.get(t)??[])fn(d);}
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};

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
test('failed notification mutations preserve visible notifications and their counters',async(t)=>{
 reset();appStore.set({notifications:[notification('old')],unreadNotifications:1});t.mock.method(api,'post',async()=>{throw new Error('offline');});
 await assert.rejects(markNotificationsRead(),/offline/);assert.equal(getState().notifications[0]!.read,false);assert.equal(getState().unreadNotifications,1);
});
test('a fresh ready snapshot supersedes an older notification acknowledgement',async(t)=>{
 reset();const response=deferred<{ids:string[];unreadChanged:number}>();t.mock.method(api,'post',()=>response.promise);const reading=markNotificationsRead();
 event('ready',{user:{id:'me'},dms:[],relationships:[],readStates:[],notifications:{items:[notification('fresh')],unread:1},incomingCalls:[],features:{gif:{enabled:false}},servers:[],dmVoiceStates:[],voiceState:null});
 response.resolve({ids:['old'],unreadChanged:100});await reading;assert.equal(getState().unreadNotifications,1);assert.equal(getState().notifications[0]!.id,'fresh');
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
