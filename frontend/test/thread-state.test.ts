import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyThreadEvent,type ThreadData,type ThreadEvent} from '../src/state/threadState';
import type {Message} from '../src/types';
const message=(id:string,replyTo:string|null=null,content=id)=>({id,channelId:'channel',content,reactions:[],replyTo:replyTo?{id:replyTo}:null} as Message);
test('thread snapshots retain later replies, edits and deletions in event order',()=>{
 let data:ThreadData|null={parent:message('100'),replies:[message('200','100')]};
 const events:ThreadEvent[]=[{kind:'new',message:message('300','100')},{kind:'update',message:message('100',null,'edited')},{kind:'delete',id:'200'}];
 for(const event of events)data=applyThreadEvent(data!,event,'me');
 assert.equal(data!.parent.content,'edited');assert.deepEqual(data!.replies.map(m=>m.id),['300']);
});
test('thread replay deduplicates replies and ignores unrelated channels and parents',()=>{
 let data:ThreadData={parent:message('100'),replies:[message('200','100')]};
 data=applyThreadEvent(data,{kind:'new',message:message('200','100')},'me')!;
 data=applyThreadEvent(data,{kind:'new',message:message('300','other')},'me')!;
 data=applyThreadEvent(data,{kind:'new',message:{...message('400','100'),channelId:'other'}},'me')!;
 assert.deepEqual(data.replies.map(m=>m.id),['200']);
});
test('a parent deleted during loading stays deleted and later reactions are personalized',()=>{
 const data={parent:message('100'),replies:[]};
 const updated=applyThreadEvent(data,{kind:'reaction',update:{messageId:'100',channelId:'channel',emoji:'👍',userIds:['me'],count:1}},'me')!;
 assert.equal(updated.parent.reactions[0]!.me,true);assert.equal(applyThreadEvent(updated,{kind:'delete',id:'100'},'me'),null);
});
test('unrelated events preserve thread state without triggering a render',()=>{
 const data={parent:message('100'),replies:[message('200','100')]};
 for(const event of [{kind:'delete',id:'other'},{kind:'update',message:message('other')},{kind:'reaction',update:{messageId:'other',channelId:'channel',emoji:'👍',userIds:[],count:0}}] satisfies ThreadEvent[])
  assert.equal(applyThreadEvent(data,event,'me'),data);
});
