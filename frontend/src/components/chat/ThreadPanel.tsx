import { useCallback, useEffect, useState } from 'react';
import { LuMessagesSquare, LuX } from 'react-icons/lu';
import { api, errorMessage } from '../../api/client';
import { gateway } from '../../state/actions';
import {getState} from '../../state/app';
import {messageForViewer,withReaction,type ReactionUpdate} from '../../utils/reactions';
import { toast } from '../../state/ui';
import { MessageItem, canManageIn } from './MessageItem';
import { Composer } from './Composer';
import type { Message } from '../../types';

/** Thread = a message plus its reply chain. New replies arrive live via the gateway. */
export function ThreadPanel({ channelId, serverId, messageId, onClose }: { channelId: string; serverId: string | null; messageId: string; onClose: () => void }) {
  const [data, setData] = useState<{ parent: Message; replies: Message[] } | null>(null);
  const { manage, pin } = canManageIn(serverId);

  const load = useCallback(() => {
    api.get<{ parent: Message; replies: Message[] }>(`/messages/${messageId}/thread`).then(setData, (err) => {
      toast(errorMessage(err, 'Не удалось открыть ветку'), 'error');
      onClose();
    });
  }, [messageId, onClose]);

  useEffect(() => {
    load();
    const offNew = gateway.on('message:new', (m: Message) => {
      if (m.replyTo?.id === messageId) setData((d) => (d && !d.replies.some((r) => r.id === m.id) ? { ...d, replies: [...d.replies, m] } : d));
    });
    const offUpd = gateway.on('message:update', (m: Message) =>
      setData((d) => d && { parent: d.parent.id === m.id ? messageForViewer(m,getState().me?.id??'',d.parent) : d.parent, replies: d.replies.map((r) => (r.id === m.id ? messageForViewer(m,getState().me?.id??'',r) : r)) }),
    );
    const offReaction=gateway.on('reaction:update',(update:ReactionUpdate)=>setData(d=>{
      if(!d)return d;const apply=(m:Message)=>m.id===update.messageId?withReaction(m,update,getState().me?.id??''):m;
      return {parent:apply(d.parent),replies:d.replies.map(apply)};
    }));
    const offDel = gateway.on('message:delete', (x: { id: string }) => {
      if (x.id === messageId) onClose();
      setData((d) => d && { ...d, replies: d.replies.filter((r) => r.id !== x.id) });
    });
    return () => {
      offNew();
      offUpd();
      offDel();
      offReaction();
    };
  }, [messageId, load, onClose]);

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
            <MessageItem m={{ ...data.parent, replyTo: null }} head canManage={manage} canPin={pin} onOpenImage={() => undefined} highlight={false} />
            <div className="divider-text">
              {data.replies.length} {data.replies.length === 1 ? 'ответ' : 'ответов'}
            </div>
            {data.replies.map((r) => (
              <MessageItem key={r.id} m={{ ...r, replyTo: null }} head canManage={manage} canPin={pin} onOpenImage={() => undefined} highlight={false} />
            ))}
          </>
        )}
      </div>
      <Composer channelId={channelId} serverId={serverId} placeholder="Ответить в ветке" fixedReplyTo={messageId} compact />
    </aside>
  );
}
