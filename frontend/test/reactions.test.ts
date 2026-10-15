import {test} from 'node:test';
import assert from 'node:assert/strict';
import {messageForViewer,withReaction} from '../src/utils/reactions';
import type {Message} from '../src/types';
const reaction=(me:boolean,count=1,userIds=['actor'])=>({emoji:'🔥',count,userIds,me});
const message=(me:boolean,count=1,userIds=['actor'])=>({id:'100',reactions:[reaction(me,count,userIds)]} as Message);

test('message updates personalize reactions for the viewer rather than the editing actor',()=>{
 assert.equal(messageForViewer(message(true),'viewer').reactions[0]!.me,false);
 assert.equal(messageForViewer(message(false,1,['viewer']),'viewer').reactions[0]!.me,true);
 assert.equal(messageForViewer(message(false,25),'viewer',message(true,25)).reactions[0]!.me,true);
});
test('a reaction beyond the first twenty users can be added and removed exactly',()=>{
 const common={messageId:'100',channelId:'channel',emoji:'🔥',userIds:Array.from({length:20},(_,i)=>`peer${i}`),count:24,actorId:'viewer'};
 const added=withReaction(message(false,23),{...common,actorHasReaction:true},'viewer');assert.equal(added.reactions[0]!.me,true);
 const removed=withReaction(added,{...common,count:23,actorHasReaction:false},'viewer');assert.equal(removed.reactions[0]!.me,false);
});
test('other participants changing a truncated reaction list preserves the viewer membership',()=>{
 const updated=withReaction(message(true,25),{messageId:'100',channelId:'channel',emoji:'🔥',userIds:['actor'],count:24,actorId:'actor',actorHasReaction:false},'viewer');
 assert.equal(updated.reactions[0]!.me,true);
 assert.deepEqual(withReaction(updated,{messageId:'100',channelId:'channel',emoji:'🔥',userIds:[],count:0},'viewer').reactions,[]);
});
