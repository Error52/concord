import type {Message} from '../types';
import {cmpId} from '../utils/ids';
import {messageForViewer,withReaction,type ReactionUpdate} from '../utils/reactions';

export interface ThreadData {parent:Message;replies:Message[]}
export type ThreadEvent=
  | {kind:'new'|'update';message:Message}
  | {kind:'delete';id:string}
  | {kind:'reaction';update:ReactionUpdate};

/** Replays events received after a thread snapshot, in arrival order. */
export function applyThreadEvent(data:ThreadData,event:ThreadEvent,viewerId:string):ThreadData|null {
  if(event.kind==='delete')return event.id===data.parent.id?null:data.replies.some(m=>m.id===event.id)?{...data,replies:data.replies.filter(m=>m.id!==event.id)}:data;
  if(event.kind==='new'){
    const m=event.message;if(m.channelId!==data.parent.channelId||m.replyTo?.id!==data.parent.id)return data;
    const replies=data.replies.filter(r=>r.id!==m.id);replies.push(messageForViewer(m,viewerId));replies.sort((a,b)=>cmpId(a.id,b.id));
    return {...data,replies};
  }
  const apply=(m:Message)=>event.kind==='reaction'
    ? m.id===event.update.messageId?withReaction(m,event.update,viewerId):m
    : m.id===event.message.id?messageForViewer(event.message,viewerId,m):m;
  const parent=apply(data.parent),replies=data.replies.map(apply);
  return parent===data.parent&&replies.every((m,i)=>m===data.replies[i])?data:{parent,replies};
}
