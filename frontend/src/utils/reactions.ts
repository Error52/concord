import type {Message} from '../types';

export interface ReactionUpdate {
  messageId:string;
  channelId:string;
  emoji:string;
  userIds:string[];
  count:number;
  actorId?:string;
  actorHasReaction?:boolean;
}

/** Broadcast message DTOs were hydrated for the actor, so their `me` flag belongs to that actor. */
export function messageForViewer(message:Message,viewerId:string,previous?:Message):Message {
  return {...message,reactions:message.reactions.map(r=>({...r,
    me:r.userIds.includes(viewerId)||(r.count>r.userIds.length&&!!previous?.reactions.find(old=>old.emoji===r.emoji)?.me),
  }))};
}

export function withReaction(message:Message,update:ReactionUpdate,viewerId:string):Message {
  const previous=message.reactions.find(r=>r.emoji===update.emoji);
  const me=update.actorId===viewerId&&update.actorHasReaction!==undefined?update.actorHasReaction:
    update.userIds.includes(viewerId)||(update.count>update.userIds.length&&!!previous?.me);
  const next={emoji:update.emoji,count:update.count,userIds:update.userIds,me};
  const reactions=update.count===0?message.reactions.filter(r=>r.emoji!==update.emoji):
    previous?message.reactions.map(r=>r.emoji===update.emoji?next:r):[...message.reactions,next];
  return {...message,reactions};
}
