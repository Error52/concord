import { useEffect, useState } from 'react';
import { LuMessagesSquare, LuX } from 'react-icons/lu';
import { api, errorMessage } from '../../api/client';
import { gateway } from '../../state/actions';
import {getState} from '../../state/app';
import type {ReactionUpdate} from '../../utils/reactions';
import {applyThreadEvent,type ThreadData,type ThreadEvent} from '../../state/threadState';
import { toast } from '../../state/ui';
import { MessageItem, canManageIn } from './MessageItem';
import { Composer } from './Composer';
import { ImageLightbox } from './ImageLightbox';
import type { Attachment, Message } from '../../types';

/** Thread = a message plus its reply chain. New replies arrive live via the gateway. */
export function ThreadPanel({ channelId, serverId, messageId, onClose }: { channelId: string; serverId: string | null; messageId: string; onClose: () => void }) {
  const [data, setData] = useState<ThreadData | null>(null);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const { manage, pin } = canManageIn(serverId);

  useEffect(() => {
    let active=true,generation=0,loading=false,loaded=false;
    let changes:ThreadEvent[]=[];
    const load=async()=>{
      const id=++generation;loading=true;changes=[];
      try{
        let snapshot:ThreadData|null=await api.get<ThreadData>(`/messages/${messageId}/thread`);
        if(!active||id!==generation)return;
        for(const event of changes){if(snapshot)snapshot=applyThreadEvent(snapshot,event,getState().me?.id??'');}
        setData(snapshot);loaded=true;loading=false;
      }catch(err){if(active&&id===generation){loading=false;toast(errorMessage(err,'Не удалось открыть ветку'),'error');if(!loaded)onClose();}}
    };
    const update=(event:ThreadEvent)=>{
      if(loading)changes.push(event);
      setData(d=>d?applyThreadEvent(d,event,getState().me?.id??''):d);
    };
    const offNew = gateway.on('message:new', (m: Message) => {
      if (m.replyTo?.id === messageId&&m.channelId===channelId) update({kind:'new',message:m});
    });
    const offUpd = gateway.on('message:update', (m: Message) =>
      m.channelId===channelId&&update({kind:'update',message:m}),
    );
    const offReaction=gateway.on('reaction:update',(reaction:ReactionUpdate)=>{if(reaction.channelId===channelId)update({kind:'reaction',update:reaction});});
    const offDel = gateway.on('message:delete', (x: { id: string;channelId:string }) => {
      if(x.channelId!==channelId)return;
      if (x.id === messageId) onClose();
      update({kind:'delete',id:x.id});
    });
    const offReady=gateway.on('ready',()=>void load());
    void load();
    return () => {
      active=false;++generation;
      offNew();
      offUpd();
      offDel();
      offReaction();
      offReady();
    };
  }, [messageId,channelId,onClose]);

  return (
    <aside className="members thread-panel" style={{ width: 'min(380px, 100%)', display: 'flex', flexDirection: 'column', padding: 0 }}>
      <div className="main-head">
        <div className="main-head-title grow">
          <LuMessagesSquare />
          Ветка
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть ветку">
          <LuX />
        </button>
      </div>
      <div className="scroll" style={{ flex: 1, paddingBottom: 12 }}>
        {!data && <div className="skeleton" style={{ height: 60, margin: 16 }} />}
        {data && (
          <>
            <MessageItem m={{ ...data.parent, replyTo: null }} head canManage={manage} canPin={pin} onOpenImage={setLightbox} highlight={false} />
            <div className="divider-text">
              {data.replies.length} {data.replies.length === 1 ? 'ответ' : 'ответов'}
            </div>
            {data.replies.map((r) => (
              <MessageItem key={r.id} m={{ ...r, replyTo: null }} head canManage={manage} canPin={pin} onOpenImage={setLightbox} highlight={false} />
            ))}
          </>
        )}
      </div>
      <Composer channelId={channelId} serverId={serverId} placeholder="Ответить в ветке" fixedReplyTo={messageId} compact />
      {lightbox && <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />}
    </aside>
  );
}
