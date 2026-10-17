import { useEffect, useRef, useState } from 'react';
import { LuCopy, LuHash, LuVolume2 } from 'react-icons/lu';
import { api, errorMessage } from '../../api/client';
import { useApp } from '../../state/app';
import { uiStore, useUi, toast } from '../../state/ui';
import { createChannel, createServer, joinByInvite } from '../../state/serverActions';
import { Modal } from '../ui/Modal';
import { Switch } from '../ui/Overlays';
import { SearchModal } from './SearchModal';
import { BookmarksModal, InboxModal } from './InboxModal';
import type { Invite } from '../../types';

const close = () => uiStore.set({ modal: null });

function CreateServerModal() {
  const me = useApp((s) => s.me);
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState(`Сервер ${me?.displayName || me?.username || ''}`.trim());
  const [isPublic, setPublic] = useState(false);
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting=useRef(false);
  const submit = async () => {
    if(submitting.current || (mode==='create'?name.trim().length<2:!invite.trim()))return;
    submitting.current=true;
    setBusy(true);
    try {
      const code = invite.trim().split('/').filter(Boolean).pop() ?? '';
      const created=mode==='create'?await createServer(name.trim(),isPublic):await joinByInvite(code);
      if(created)close();
    } finally {submitting.current=false;setBusy(false);}
  };
  return (
    <Modal
      title={mode === 'create' ? 'Создать сервер' : 'Присоединиться к серверу'}
      subtitle={mode === 'create' ? 'Сервер — место для вас и ваших друзей. Каналы и роли можно настроить позже.' : 'Вставьте приглашение — ссылку вида /invite/AbCd1234 или код.'}
      onClose={close}
      footer={
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setMode(mode === 'create' ? 'join' : 'create')}>
            {mode === 'create' ? 'У меня есть приглашение' : 'Создать свой'}
          </button>
          <button className="btn btn-primary" disabled={busy || (mode === 'create' ? name.trim().length < 2 : !invite.trim())} onClick={() => void submit()}>
            {mode === 'create' ? 'Создать' : 'Присоединиться'}
          </button>
        </>
      }
    >
      {mode === 'create' ? (
        <>
          <label className="field">
            <span className="field-label">Название сервера</span>
            <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
          </label>
          <div className="toggle-row">
            <div className="grow">
              <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Публичный сервер</div>
              <div className="field-hint">Будет виден в «Обзоре серверов», войти сможет любой.</div>
            </div>
            <Switch checked={isPublic} onChange={setPublic} label="Публичный" />
          </div>
        </>
      ) : (
        <label className="field">
          <span className="field-label">Приглашение</span>
          <input className="input" value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="http://localhost/invite/AbCd1234" onKeyDown={(e) => e.key === 'Enter' && void submit()} />
        </label>
      )}
    </Modal>
  );
}

function CreateChannelModal({ serverId, type: initialType }: { serverId: string; type: 'text' | 'voice' }) {
  const [type, setType] = useState(initialType);
  const [name, setName] = useState('');
  const categories = useApp((s) => [...new Set(Object.values(s.channels).filter((c) => c.serverId === serverId && c.type === type).map((c) => c.category))]);
  const [category, setCategory] = useState('');
  const [busy,setBusy]=useState(false);
  const submitting=useRef(false);
  useEffect(() => setCategory(categories[0] ?? ''), [type]);
  const submit = async () => {
    if (submitting.current||!name.trim()) return;
    submitting.current=true;setBusy(true);
    try {if(await createChannel(serverId, name.trim(), type, category || undefined))close();}
    finally{submitting.current=false;setBusy(false);}
  };
  return (
    <Modal
      title="Создать канал"
      onClose={close}
      footer={
        <>
          <button className="btn btn-ghost" onClick={close}>
            Отмена
          </button>
          <button className="btn btn-primary" disabled={busy||!name.trim()} onClick={() => void submit()}>
            Создать канал
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Тип канала</span>
        {(['text', 'voice'] as const).map((t) => (
          <button key={t} className={`chan${type === t ? ' active' : ''}`} style={{ height: 56 }} onClick={() => setType(t)}>
            {t === 'text' ? <LuHash /> : <LuVolume2 />}
            <span className="grow" style={{ textAlign: 'left' }}>
              <strong style={{ color: 'var(--text-0)', display: 'block' }}>{t === 'text' ? 'Текстовый' : 'Голосовой'}</strong>
              <span style={{ fontSize: '0.8125rem' }}>{t === 'text' ? 'Сообщения, изображения, GIF, файлы' : 'Голос, видео и демонстрация экрана'}</span>
            </span>
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field-label">Название</span>
        <input className="input" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder={type === 'text' ? 'новый-канал' : 'Игровая'} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </label>
      <label className="field">
        <span className="field-label">Категория</span>
        <input className="input" list="cats" value={category} onChange={(e) => setCategory(e.target.value)} placeholder={type === 'text' ? 'Текстовые каналы' : 'Голосовые каналы'} />
        <datalist id="cats">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
    </Modal>
  );
}

const EXPIRY: [string, number | null][] = [
  ['30 минут', 1800],
  ['1 час', 3600],
  ['1 день', 86400],
  ['7 дней', 604800],
  ['Никогда', null],
];
const USES: [string, number | null][] = [
  ['Без ограничений', null],
  ['1', 1],
  ['5', 5],
  ['10', 10],
  ['25', 25],
  ['100', 100],
];

function InviteModal({ serverId }: { serverId: string }) {
  const server = useApp((s) => s.servers[serverId]);
  const [expires, setExpires] = useState<number | null>(604800);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true);
    try {
      setInvite(await api.post<Invite>(`/servers/${serverId}/invites`, { expiresInSec: expires, maxUses }));
    } catch (err) {
      toast(errorMessage(err, 'Не удалось создать приглашение'), 'error');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void generate();
  }, []);
  const link = invite ? `${location.origin}/invite/${invite.code}` : '';
  return (
    <Modal title={`Пригласить друзей на «${server?.name ?? ''}»`} onClose={close}>
      <label className="field">
        <span className="field-label">Ссылка-приглашение</span>
        <div className="row">
          <input className="input" readOnly value={link || 'Создаём…'} onFocus={(e) => e.target.select()} />
          <button
            className="btn btn-primary"
            disabled={!invite}
            onClick={() => {
              void navigator.clipboard?.writeText(link);
              toast('Ссылка скопирована', 'success');
            }}
          >
            <LuCopy /> Копировать
          </button>
        </div>
        {invite && (
          <span className="field-hint">
            {invite.expiresAt ? `Истекает ${new Date(invite.expiresAt).toLocaleString('ru-RU')}` : 'Бессрочно'}
            {invite.maxUses ? ` · не более ${invite.maxUses} использований` : ''}
          </span>
        )}
      </label>
      <div className="form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label className="field">
          <span className="field-label">Срок действия</span>
          <select className="select" value={String(expires)} onChange={(e) => setExpires(e.target.value === 'null' ? null : Number(e.target.value))}>
            {EXPIRY.map(([l, v]) => (
              <option key={l} value={String(v)}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Макс. использований</span>
          <select className="select" value={String(maxUses)} onChange={(e) => setMaxUses(e.target.value === 'null' ? null : Number(e.target.value))}>
            {USES.map(([l, v]) => (
              <option key={l} value={String(v)}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button className="btn btn-secondary" disabled={busy} onClick={() => void generate()}>
        Создать новую ссылку
      </button>
    </Modal>
  );
}

export function ModalHost() {
  const modal = useUi((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'createServer':
      return <CreateServerModal />;
    case 'createChannel':
      return <CreateChannelModal serverId={modal.serverId} type={modal.type} />;
    case 'invite':
      return <InviteModal serverId={modal.serverId} />;
    case 'search':
      return <SearchModal serverId={modal.serverId} channelId={modal.channelId} onClose={close} />;
    case 'inbox':
      return <InboxModal onClose={close} />;
    case 'bookmarks':
      return <BookmarksModal onClose={close} />;
  }
}
