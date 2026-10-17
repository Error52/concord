import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { LuCirclePlus, LuFile, LuSend, LuSmile, LuX } from 'react-icons/lu';
import { uploadWithProgress, errorMessage, type UploadHandle } from '../../api/client';
import { getState, useApp } from '../../state/app';
import { displayName, sendMessage, sendTyping } from '../../state/actions';
import { toast, uiStore, useUi } from '../../state/ui';
import { can, Perm } from '../../utils/permissions';
import { formatBytes } from '../../utils/format';
import {newMessageNonce} from '../../utils/ids';
import {composerRetryNonce,rememberComposerSend,restoreComposerDraft,useComposerDraft} from '../../state/composerDrafts';
import { Avatar } from '../ui/Avatar';
import { ComposerPicker, type PickerTab } from './Pickers';
import {VoiceRecorder} from './VoiceRecorder';
import type { Attachment, Gif, User } from '../../types';

const MAX_FILE_MB = 25;
const MAX_FILES = 10;

interface Upload {
  key: string;
  file: File;
  preview: string | null;
  progress: number;
  result: Attachment | null;
  error: string | null;
  handle: UploadHandle<Attachment> | null;
}

export interface ComposerHandle {
  addFiles(files: File[]): void;
  focus(): void;
}

interface Props {
  channelId: string;
  serverId: string | null;
  placeholder: string;
  /** Overrides the reply target (thread panel). */
  fixedReplyTo?: string;
  compact?: boolean;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ channelId, serverId, placeholder, fixedReplyTo, compact }, ref) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [picker, setPicker] = useState<PickerTab | null>(null);
  const [suggest, setSuggest] = useState<{ query: string; start: number; index: number } | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [sending,setSending]=useState(false);
  const sendingRef=useRef(0);
  const sendChain=useRef<Promise<unknown>>(Promise.resolve());
  const reservedUploads=useRef(new Set<string>());
  const active=useRef(false);
  const resources=useRef(new Map<string,Upload>());
  const accountId=useApp(s=>s.me?.id??'guest');
  const mentionMap = useRef(new Map<string, string>());
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const replyId = useUi((s) => fixedReplyTo ?? s.replyTo[channelId] ?? null);
  const replyMsg = useApp((s) => (replyId && !fixedReplyTo ? s.messages[channelId]?.items.find((m) => m.id === replyId) : null));
  const perms = useApp((s) => (serverId ? s.permissions[serverId] : undefined));
  const slowmode = useApp((s) => s.channels[channelId]?.slowmodeSeconds ?? 0);
  const timedOut = useApp((s) => {
    const me = s.me?.id;
    const t = serverId && me ? s.members[serverId]?.[me]?.timeoutUntil : null;
    return t && new Date(t).getTime() > Date.now() ? t : null;
  });
  const canSend = !serverId || can(perms, Perm.SEND_MESSAGES);
  const canAttach = !serverId || can(perms, Perm.ATTACH_FILES);
  const bypassSlowmode = serverId ? can(perms, Perm.MANAGE_MESSAGES) || can(perms, Perm.MANAGE_CHANNELS) : true;

  // Draft per channel survives navigation.
  const draftKey = `${accountId}:${channelId}:${fixedReplyTo ?? ''}`;
  const [text,setText]=useComposerDraft(draftKey);
  const releaseUpload=(key:string)=>{
    const upload=resources.current.get(key);if(!upload)return;
    resources.current.delete(key);upload.handle?.abort();
    if(upload.preview)URL.revokeObjectURL(upload.preview);
  };
  useEffect(() => {
    active.current=true;
    setUploads([]);
    return ()=>{
      active.current=false;
      for(const key of resources.current.keys())releaseUpload(key);
    };
  }, [draftKey]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  const addFiles = (files: File[]) => {
    if (!canAttach) return toast('Нет права прикреплять файлы', 'error');
    const room = MAX_FILES - uploads.length;
    if (files.length > room) toast(`Можно прикрепить не более ${MAX_FILES} файлов`, 'error');
    const next: Upload[] = [];
    for (const file of files.slice(0, room)) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        toast(`«${file.name}» больше ${MAX_FILE_MB} МБ`, 'error');
        continue;
      }
      const u: Upload = { key, file, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null, progress: 0, result: null, error: null, handle: null };
      resources.current.set(key,u);
      const handle = uploadWithProgress<Attachment>(`/channels/${channelId}/attachments`, file, (p) => active.current&&setUploads((list) => list.map((x) => (x.key === key ? { ...x, progress: p } : x))));
      u.handle = handle;
      handle.promise.then(
        (result) => active.current&&resources.current.has(key)&&setUploads((list) => list.map((x) => (x.key === key ? { ...x, result, progress: 1 } : x))),
        (err) => {
          if (!active.current||!resources.current.has(key)||(err as { code?: string }).code === 'ABORTED') return;
          setUploads((list) => list.map((x) => (x.key === key ? { ...x, error: errorMessage(err, 'Ошибка загрузки') } : x)));
        },
      );
      next.push(u);
    }
    setUploads((list) => [...list, ...next]);
  };

  useImperativeHandle(ref, () => ({ addFiles, focus: () => taRef.current?.focus() }));

  const candidates = useMemo((): (User | 'everyone')[] => {
    if (!suggest) return [];
    const s = getState();
    const q = suggest.query.toLowerCase();
    const pool: User[] = serverId ? Object.values(s.members[serverId] ?? {}).map((m) => s.users[m.user.id] ?? m.user) : (s.dms[channelId]?.recipients ?? []).concat(s.me ? [s.me] : []);
    const users = pool.filter((u) => u.username.toLowerCase().includes(q) || (u.displayName ?? '').toLowerCase().includes(q)).slice(0, 8);
    const out: (User | 'everyone')[] = [...users];
    if (serverId && can(perms, Perm.MENTION_EVERYONE) && 'everyone'.startsWith(q)) out.push('everyone');
    return out;
  }, [suggest, serverId, channelId, perms]);

  const pickSuggestion = (c: User | 'everyone') => {
    if (!suggest) return;
    const label = c === 'everyone' ? 'everyone' : c.username;
    if (c !== 'everyone') mentionMap.current.set(label, c.id);
    const before = text.slice(0, suggest.start);
    const after = text.slice(suggest.start + 1 + suggest.query.length);
    setText(`${before}@${label} ${after}`);
    setSuggest(null);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const onChange = (value: string) => {
    setText(value);
    if (value.trim()) sendTyping(channelId);
    const caret = taRef.current?.selectionStart ?? value.length;
    const m = /(^|\s)@([\p{L}\p{N}_.]{0,32})$/u.exec(value.slice(0, caret));
    setSuggest(m ? { query: m[2]!, start: caret - m[2]!.length - 1, index: 0 } : null);
  };

  const encodeMentions = (raw: string): string =>
    raw.replace(/(^|\s)@([a-zA-Z0-9_.]{2,32})/g, (full, pre: string, name: string) => {
      const id = mentionMap.current.get(name) ?? findUserId(name, serverId, channelId);
      return id ? `${pre}<@${id}>` : full;
    });

  const submit = async (gif?: Gif) => {
    if(sendingRef.current && slowmode && !bypassSlowmode)return toast('Дождитесь отправки: в канале включён медленный режим');
    if (!canSend || timedOut) return;
    if (cooldown > 0) return;
    const pending = uploads.some((u) => !u.result && !u.error);
    if (pending) return toast('Дождитесь окончания загрузки файлов');
    const available=uploads.filter(u=>u.result&&!reservedUploads.current.has(u.key));
    const attachmentIds = available.map((u) => u.result!.id);
    const content = gif ? '' : encodeMentions(text.trim());
    if (!content && attachmentIds.length === 0 && !gif) return;
    const original=text,keys=new Set(available.map(u=>u.key));
    keys.forEach(key=>reservedUploads.current.add(key));
    ++sendingRef.current;setSending(true);if(!gif)setText('');
    const payload={
      content,
      replyToId: replyId,
      attachmentIds,
      gif: gif ? { url: gif.url, previewUrl: gif.previewUrl, width: gif.width, height: gif.height, title: gif.title } : null,
    };
    const requestKey=JSON.stringify([draftKey,payload]);
    const nonce=composerRetryNonce(draftKey,requestKey)??newMessageNonce();
    const pendingSend=sendChain.current.then(()=>getState().me?.id===accountId?sendMessage(channelId,{...payload,nonce}):false);
    sendChain.current=pendingSend.catch(()=>false);
    const ok=await pendingSend;
    rememberComposerSend(draftKey,requestKey,nonce,ok);
    --sendingRef.current;keys.forEach(key=>reservedUploads.current.delete(key));
    if(!ok&&!gif)restoreComposerDraft(draftKey,original);
    if(!active.current||getState().me?.id!==accountId)return;
    setSending(sendingRef.current>0);
    if(!ok){if(original)setText(current=>current||original);return;}
    for(const key of keys)releaseUpload(key);
    setUploads(list=>list.filter(u=>!keys.has(u.key)));
    if(!fixedReplyTo)uiStore.set(s=>s.replyTo[channelId]===replyId?{replyTo:{...s.replyTo,[channelId]:null}}:{});
    if (slowmode && !bypassSlowmode) setCooldown(slowmode);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest && candidates.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setSuggest({ ...suggest, index: (suggest.index + d + candidates.length) % candidates.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickSuggestion(candidates[suggest.index]!);
        return;
      }
      if (e.key === 'Escape') return setSuggest(null);
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
    if (e.key === 'Escape' && replyId && !fixedReplyTo) uiStore.set((s) => ({ replyTo: { ...s.replyTo, [channelId]: null } }));
    if (e.key === 'ArrowUp' && !text) {
      const s = getState();
      const mine = [...(s.messages[channelId]?.items ?? [])].reverse().find((m) => m.author?.id === s.me?.id && m.kind === 'default' && !m.pending);
      if (mine) {
        e.preventDefault();
        uiStore.set({ editing: mine.id });
      }
    }
  };

  if (!canSend || timedOut) {
    return (
      <div className="composer-wrap">
        <div className="composer" style={{ padding: '14px 16px', color: 'var(--text-3)' }}>
          {timedOut ? `Вы в тайм-ауте до ${new Date(timedOut).toLocaleTimeString('ru-RU')}` : 'У вас нет права отправлять сообщения в этом канале.'}
        </div>
      </div>
    );
  }

  return (
    <div className="composer-wrap" style={{ position: 'relative', ...(compact ? { padding: '0 12px 12px' } : {}) }}>
      {suggest && candidates.length > 0 && (
        <div className="mention-suggest" role="listbox">
          {candidates.map((c, i) => (
            <button key={c === 'everyone' ? 'everyone' : c.id} role="option" aria-selected={i === suggest.index} onMouseDown={(e) => (e.preventDefault(), pickSuggestion(c))}>
              {c === 'everyone' ? (
                <>
                  <strong>@everyone</strong>
                  <span className="muted" style={{ fontSize: '0.8125rem' }}>Уведомить всех участников</span>
                </>
              ) : (
                <>
                  <Avatar user={c} size={24} />
                  <strong>{displayName(getState(), c, serverId)}</strong>
                  <span className="muted" style={{ fontSize: '0.8125rem' }}>{c.username}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      {picker && (
        <ComposerPicker
          tab={picker}
          setTab={setPicker}
          onClose={() => setPicker(null)}
          onEmoji={(em) => {
            const ta = taRef.current;
            const pos = ta?.selectionStart ?? text.length;
            setText(text.slice(0, pos) + em + text.slice(pos));
            requestAnimationFrame(() => {
              ta?.focus();
              ta?.setSelectionRange(pos + em.length, pos + em.length);
            });
          }}
          onGif={(g) => {
            setPicker(null);
            void submit(g);
          }}
        />
      )}
      <div className="composer">
        {replyMsg && (
          <div className="composer-bar">
            <span className="grow ellipsis">
              Ответ для <strong style={{ color: 'var(--text-0)' }}>{displayName(getState(), replyMsg.author, serverId)}</strong>
            </span>
            <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => uiStore.set((s) => ({ replyTo: { ...s.replyTo, [channelId]: null } }))} aria-label="Отменить ответ">
              <LuX />
            </button>
          </div>
        )}
        {uploads.length > 0 && (
          <div className="uploads">
            {uploads.map((u) => (
              <div key={u.key} className={`upload${u.error ? ' error' : ''}`}>
                <div className="upload-thumb" style={u.preview ? { backgroundImage: `url(${u.preview})` } : undefined}>
                  {!u.preview && <LuFile style={{ width: 32, height: 32 }} />}
                </div>
                <div className="upload-name ellipsis" title={u.file.name}>
                  {u.file.name}
                </div>
                {u.error ? (
                  <div className="field-error" style={{ fontSize: '0.6875rem' }}>{u.error}</div>
                ) : u.result ? (
                  <div className="muted" style={{ fontSize: '0.6875rem' }}>{formatBytes(u.file.size)}</div>
                ) : (
                  <div className="progress" aria-label="Загрузка">
                    <div style={{ width: `${Math.round(u.progress * 100)}%` }} />
                  </div>
                )}
                <button
                  className="icon-btn"
                  aria-label="Убрать файл"
                  onClick={() => {
                    releaseUpload(u.key);
                    setUploads((list) => list.filter((x) => x.key !== u.key));
                  }}
                >
                  <LuX />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
          {canAttach && (
            <>
              <button className="icon-btn" onClick={() => fileRef.current?.click()} aria-label="Прикрепить файл">
                <LuCirclePlus />
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
            </>
          )}
          {canAttach&&<VoiceRecorder key={draftKey} disabled={uploads.length>=MAX_FILES} onFile={file=>addFiles([file])}/>}
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            placeholder={cooldown > 0 ? `Медленный режим: ${cooldown} с` : placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            maxLength={4000}
            aria-label={placeholder}
            disabled={cooldown > 0}
          />
          <button className="icon-btn gif" data-picker-toggle onClick={() => setPicker(picker === 'gif' ? null : 'gif')} aria-label="GIF">
            <span>GIF</span>
          </button>
          <button className="icon-btn" data-picker-toggle onClick={() => setPicker(picker === 'emoji' ? null : 'emoji')} aria-label="Эмодзи">
            <LuSmile />
          </button>
          {(text.trim() || uploads.length > 0) && (
            <button className="icon-btn" aria-busy={sending} onClick={() => void submit()} aria-label="Отправить" style={{ color: 'var(--accent)' }}>
              <LuSend />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

function findUserId(name: string, serverId: string | null, channelId: string): string | null {
  const s = getState();
  const pool: User[] = serverId ? Object.values(s.members[serverId] ?? {}).map((m) => m.user) : (s.dms[channelId]?.recipients ?? []);
  return pool.find((u) => u.username.toLowerCase() === name.toLowerCase())?.id ?? null;
}
