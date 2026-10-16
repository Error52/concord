import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../../state/app';
import { loadMessages, loadNewer, loadOlder, markRead } from '../../state/actions';
import { uiStore, useUi } from '../../state/ui';
import { formatDate } from '../../utils/format';
import { canManageIn, MessageItem } from './MessageItem';
import { ImageLightbox } from './ImageLightbox';
import type { Attachment, Message } from '../../types';

const GROUP_WINDOW_MS = 7 * 60_000;

function sameGroup(a: Message | undefined, b: Message): boolean {
  if (!a || a.kind === 'system' || b.kind === 'system' || b.replyTo) return false;
  if (a.author?.id !== b.author?.id) return false;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() < GROUP_WINDOW_MS && new Date(a.createdAt).toDateString() === new Date(b.createdAt).toDateString();
}

interface Props {
  channelId: string;
  serverId: string | null;
  jumpTo?: string;
  intro: ReactNode;
}

/**
 * Message list with scroll anchoring: stays pinned to the bottom for new messages, keeps the
 * viewport stable while older pages are prepended, and can jump to a message (search results).
 */
export function MessageList({ channelId, serverId, jumpTo, intro }: Props) {
  const list = useApp((s) => s.messages[channelId]);
  const highlight = useUi((s) => s.highlight);
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevHeight = useRef<{ h: number; top: number; first?: string } | null>(null);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [showJump, setShowJump] = useState(false);
  const { manage, pin } = canManageIn(serverId);

  useEffect(() => {
    atBottom.current = !jumpTo;
    void loadMessages(channelId, jumpTo ? { around: jumpTo } : {});
  }, [channelId, jumpTo]);

  // After a jump, scroll the target into view and flash it.
  useEffect(() => {
    if (!jumpTo || !list?.items.some((m) => m.id === jumpTo)) return;
    const el = ref.current?.querySelector(`[data-message-id="${jumpTo}"]`);
    el?.scrollIntoView({ block: 'center' });
    uiStore.set({ highlight: jumpTo });
  }, [jumpTo, list?.items.length]);

  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => uiStore.set({ highlight: null }), 2400);
    return () => clearTimeout(t);
  }, [highlight]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !list) return;
    const prev = prevHeight.current;
    if (prev && prev.first !== list.items[0]?.id && el.scrollHeight !== prev.h) {
      // Older messages were prepended: keep the same content under the viewport.
      el.scrollTop = prev.top + (el.scrollHeight - prev.h);
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevHeight.current = { h: el.scrollHeight, top: el.scrollTop, first: list.items[0]?.id };
  }, [list?.items]);

  // Keep pinned to bottom when images load.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [list?.items.length]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el || !list) return;
    const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = bottomGap < 40 && list.atLatest;
    prevHeight.current = { h: el.scrollHeight, top: el.scrollTop, first: list.items[0]?.id };
    setShowJump(bottomGap > 800 || !list.atLatest);
    if (el.scrollTop < 400 && list.hasMoreBefore && !list.loading) void loadOlder(channelId);
    if (bottomGap < 400 && !list.atLatest && !list.loading) void loadNewer(channelId);
    if (atBottom.current && document.hasFocus()) void markRead(channelId);
  }, [channelId, list]);

  useEffect(() => {
    const onFocus = () => atBottom.current && void markRead(channelId);
    window.addEventListener('focus', onFocus);
    if (list && !list.loading && atBottom.current) void markRead(channelId);
    return () => window.removeEventListener('focus', onFocus);
  }, [channelId, list?.items.length, list?.loading]);

  const items = list?.items ?? [];
  let lastDay = '';
  return (
    <>
      <div className="messages scroll" ref={ref} onScroll={onScroll} role="log" aria-live="polite" aria-label="Сообщения">
        {list && !list.hasMoreBefore && intro}
        {list?.loading && items.length === 0 && <MessageSkeletons />}
        {list?.hasMoreBefore && items.length > 0 && <MessageSkeletons count={2} />}
        {items.map((m, i) => {
          const day = new Date(m.createdAt).toDateString();
          const divider = day !== lastDay ? <div className="divider-text">{formatDate(m.createdAt)}</div> : null;
          lastDay = day;
          return (
            <div key={m.nonce && m.pending ? m.nonce : m.id}>
              {divider}
              <MessageItem m={m} head={!!divider || !sameGroup(items[i - 1], m)} canManage={manage} canPin={pin} onOpenImage={setLightbox} highlight={highlight === m.id} />
            </div>
          );
        })}
      </div>
      {showJump && (
        <button
          className="btn btn-primary btn-sm jump-latest"
          onClick={() => {
            if (!list?.atLatest) void loadMessages(channelId, { reset: true });
            atBottom.current = true;
            ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
          }}
        >
          К новым сообщениям ↓
        </button>
      )}
      {lightbox && <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

function MessageSkeletons({ count = 6 }: { count?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="msg head" style={{ opacity: 1 - i * 0.12 }}>
          <div className="msg-gutter">
            <div className="skeleton" style={{ width: 40, height: 40, borderRadius: '50%' }} />
          </div>
          <div className="col" style={{ gap: 6 }}>
            <div className="skeleton" style={{ width: 120 + ((i * 37) % 80), height: 12 }} />
            <div className="skeleton" style={{ width: `${40 + ((i * 23) % 50)}%`, height: 12 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
