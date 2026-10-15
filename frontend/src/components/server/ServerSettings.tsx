import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuPlus, LuTrash2, LuX } from 'react-icons/lu';
import { api, errorMessage } from '../../api/client';
import { setState, useApp } from '../../state/app';
import { channelsOf, refreshServer } from '../../state/actions';
import { navigate } from '../../state/router';
import { deleteServer } from '../../state/serverActions';
import { toast, uiStore, useUi } from '../../state/ui';
import { can, Perm, PERM_LABELS, type PermName } from '../../utils/permissions';
import { Avatar } from '../ui/Avatar';
import { Switch } from '../ui/Overlays';
import { formatTimestamp } from '../../utils/format';
import type { Badge, Channel, Invite, Role, Server, User } from '../../types';

async function attempt<T>(fn: () => Promise<T>, ok?: string): Promise<T | null> {
  try {
    const r = await fn();
    if (ok) toast(ok, 'success');
    return r;
  } catch (err) {
    toast(errorMessage(err), 'error');
    return null;
  }
}

function Overview({ server }: { server: Server }) {
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description);
  const [isPublic, setPublic] = useState(server.isPublic);
  const dirty = name !== server.name || description !== server.description || isPublic !== server.isPublic;
  const upload = async (field: 'icon' | 'banner', file: File | null) => {
    const srv = await attempt(() => (file ? api.putFile<Server>(`/servers/${server.id}/${field}`, file) : api.del<Server>(`/servers/${server.id}/${field}`)), 'Сохранено');
    if (srv) setState((s) => ({ servers: { ...s.servers, [srv.id]: srv } }));
  };
  return (
    <>
      <h2>Обзор сервера</h2>
      <div className="settings-grid">
        <label className="field">
          <span className="field-label">Название</span>
          <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span className="field-label">Иконка и баннер</span>
          <div className="row">
            <label className="btn btn-secondary btn-sm">
              Иконка
              <input type="file" hidden accept="image/*" onChange={(e) => e.target.files?.[0] && void upload('icon', e.target.files[0])} />
            </label>
            <label className="btn btn-secondary btn-sm">
              Баннер
              <input type="file" hidden accept="image/*" onChange={(e) => e.target.files?.[0] && void upload('banner', e.target.files[0])} />
            </label>
            {server.iconUrl && (
              <button className="btn btn-ghost btn-sm" onClick={() => void upload('icon', null)}>
                Убрать иконку
              </button>
            )}
          </div>
        </div>
      </div>
      <label className="field" style={{ marginTop: 16 }}>
        <span className="field-label">Описание</span>
        <textarea className="textarea" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="toggle-row">
        <div className="grow">
          <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Публичный сервер</div>
          <div className="field-hint">Показывать в обзоре и разрешить вход без приглашения.</div>
        </div>
        <Switch checked={isPublic} onChange={setPublic} label="Публичный" />
      </div>
      {dirty && (
        <div className="save-bar">
          <span className="grow">Есть несохранённые изменения</span>
          <button className="btn btn-success btn-sm" onClick={() => void attempt(() => api.patch(`/servers/${server.id}`, { name, description, isPublic }), 'Сохранено')}>
            Сохранить
          </button>
        </div>
      )}
    </>
  );
}

function Roles({ serverId, perms }: { serverId: string; perms: bigint }) {
  const roles = useApp((s) => s.roles[serverId] ?? []);
  const [selected, setSelected] = useState<string | null>(roles[0]?.id ?? null);
  const role = roles.find((r) => r.id === selected) ?? null;
  const [draft, setDraft] = useState<Role | null>(role);
  useEffect(() => setDraft(role), [selected, role?.permissions, role?.name, role?.color, role?.hoist]);
  const flags = draft ? BigInt(draft.permissions) : 0n;
  const toggle = (k: PermName) => {
    if (!draft) return;
    const next = flags & Perm[k] ? flags & ~Perm[k] : flags | Perm[k];
    setDraft({ ...draft, permissions: next.toString() });
  };
  const dirty = draft && role && JSON.stringify(draft) !== JSON.stringify(role);
  return (
    <>
      <h2>Роли</h2>
      <p className="muted">Owner управляет всем. Роли упорядочены по старшинству: участник может управлять только ролями ниже своей высшей роли.</p>
      <div className="ss-roles">
        <div className="ss-role-list col" style={{ gap: 2 }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={async () => {
              const r = await attempt(() => api.post<Role>(`/servers/${serverId}/roles`, { name: 'Новая роль', color: '#99aab5' }));
              if (r) setSelected(r.id);
            }}
          >
            <LuPlus /> Создать роль
          </button>
          {[...roles].sort((a, b) => b.position - a.position).map((r) => (
            <button key={r.id} aria-current={r.id === selected} onClick={() => setSelected(r.id)}>
              <span className="pill-dot" style={{ background: r.color ?? 'var(--text-3)' }} />
              {r.isDefault ? '@everyone (Member)' : r.name}
            </button>
          ))}
        </div>
        {draft && (
          <div>
            <div className="settings-grid">
              <label className="field">
                <span className="field-label">Название роли</span>
                <input className="input" value={draft.name} disabled={draft.isDefault} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Цвет</span>
                <span className="color-input">
                  <input type="color" value={draft.color ?? '#99aab5'} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
                </span>
              </label>
            </div>
            <div className="toggle-row">
              <span className="grow">Показывать отдельно в списке участников</span>
              <Switch checked={draft.hoist} onChange={(v) => setDraft({ ...draft, hoist: v })} label="Отдельная группа" />
            </div>
            <h3>Права</h3>
            {(Object.keys(Perm) as PermName[]).map((k) => (
              <div key={k} className="perm-row">
                <div className="grow">
                  <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>{PERM_LABELS[k].label}</div>
                  {PERM_LABELS[k].hint && <div className="field-hint">{PERM_LABELS[k].hint}</div>}
                </div>
                <Switch checked={(flags & Perm[k]) !== 0n} onChange={() => toggle(k)} label={PERM_LABELS[k].label} />
              </div>
            ))}
            <div className="row" style={{ marginTop: 16 }}>
              {!draft.isDefault && (
                <button className="btn btn-danger btn-sm" onClick={() => confirm(`Удалить роль «${draft.name}»?`) && void attempt(() => api.del(`/servers/${serverId}/roles/${draft.id}`), 'Роль удалена')}>
                  Удалить роль
                </button>
              )}
            </div>
            {dirty && (
              <div className="save-bar">
                <span className="grow">Несохранённые изменения роли</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setDraft(role)}>
                  Сбросить
                </button>
                <button
                  className="btn btn-success btn-sm"
                  onClick={() =>
                    void attempt(
                      () => api.patch(`/servers/${serverId}/roles/${draft.id}`, { name: draft.isDefault ? undefined : draft.name, color: draft.color, permissions: draft.permissions, hoist: draft.hoist }),
                      'Роль сохранена',
                    )
                  }
                >
                  Сохранить
                </button>
              </div>
            )}
            {!can(perms, Perm.ADMINISTRATOR) && <p className="field-hint">Можно выдавать только те права, которые есть у вас.</p>}
          </div>
        )}
      </div>
    </>
  );
}

function MemberEditor({ serverId, userId, perms }: { serverId: string; userId: string; perms: bigint }) {
  const member = useApp((s) => s.members[serverId]?.[userId]);
  const user = useApp((s) => s.users[userId] ?? member?.user);
  const roles = useApp((s) => (s.roles[serverId] ?? []).filter((r) => !r.isDefault));
  const [badges, setBadges] = useState<(Badge & { holders: string[] })[]>([]);
  const loadBadges = () => void api.get<(Badge & { holders: string[] })[]>(`/servers/${serverId}/badges`).then(setBadges, () => undefined);
  useEffect(loadBadges, [serverId]);
  if (!member || !user) return <p className="muted">Участник не найден.</p>;
  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <Avatar user={user} size={48} />
        <div>
          <h2 style={{ margin: 0 }}>{user.displayName || user.username}</h2>
          <span className="muted">{user.username}</span>
        </div>
      </div>
      {can(perms, Perm.MANAGE_ROLES) && (
        <>
          <h3>Роли</h3>
          <div className="card">
            {roles.map((r) => (
              <div key={r.id} className="perm-row">
                <span className="pill-dot" style={{ background: r.color ?? 'var(--text-3)' }} />
                <span className="grow">{r.name}</span>
                <Switch
                  checked={member.roleIds.includes(r.id)}
                  onChange={(on) =>
                    void attempt(() =>
                      api.put(`/servers/${serverId}/members/${userId}/roles`, { roleIds: on ? [...member.roleIds, r.id] : member.roleIds.filter((x) => x !== r.id) }),
                    )
                  }
                  label={r.name}
                />
              </div>
            ))}
          </div>
        </>
      )}
      {can(perms, Perm.MANAGE_BADGES) && (
        <>
          <h3>Значки</h3>
          <div className="card">
            {badges.length === 0 && <span className="muted">На сервере ещё нет значков — создайте их во вкладке «Значки».</span>}
            {badges.map((b) => {
              const has = b.holders.includes(userId);
              return (
                <div key={b.id} className="perm-row">
                  <span className="badge-icon" style={{ background: `color-mix(in srgb, ${b.color} 30%, transparent)` }}>
                    {b.iconUrl ? <img src={b.iconUrl} alt="" /> : b.emoji}
                  </span>
                  <span className="grow">{b.name}</span>
                  <button
                    className={`btn btn-sm ${has ? 'btn-secondary' : 'btn-primary'}`}
                    onClick={async () => {
                      await attempt(() => (has ? api.del(`/servers/${serverId}/badges/${b.id}/users/${userId}`) : api.put(`/servers/${serverId}/badges/${b.id}/users/${userId}`)), has ? 'Значок снят' : 'Значок выдан');
                      loadBadges();
                    }}
                  >
                    {has ? 'Снять' : 'Выдать'}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

function Members({ serverId, perms }: { serverId: string; perms: bigint }) {
  const members = useApp((s) => Object.values(s.members[serverId] ?? {}));
  const roles = useApp((s) => s.roles[serverId] ?? []);
  const [q, setQ] = useState('');
  const list = members.filter((m) => (m.user.displayName ?? m.user.username).toLowerCase().includes(q.toLowerCase()) || m.user.username.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <h2>Участники — {members.length}</h2>
      <input className="input" placeholder="Поиск участников" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12 }} />
      <table className="table">
        <thead>
          <tr>
            <th>Участник</th>
            <th>Роли</th>
            <th>На сервере с</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((m) => (
            <tr key={m.user.id}>
              <td>
                <span className="row">
                  <Avatar user={m.user} size={28} /> {m.user.displayName || m.user.username}
                  {m.timeoutUntil && <span className="pill" style={{ color: 'var(--yellow)' }}>тайм-аут</span>}
                </span>
              </td>
              <td>
                <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                  {roles.filter((r) => m.roleIds.includes(r.id)).map((r) => (
                    <span key={r.id} className="pill">
                      <span className="pill-dot" style={{ background: r.color ?? 'var(--text-3)' }} />
                      {r.name}
                    </span>
                  ))}
                </span>
              </td>
              <td className="muted">{new Date(m.joinedAt).toLocaleDateString('ru-RU')}</td>
              <td>
                {(can(perms, Perm.MANAGE_ROLES) || can(perms, Perm.MANAGE_BADGES)) && (
                  <button className="btn btn-secondary btn-sm" onClick={() => uiStore.set({ serverSettings: { serverId, tab: `member:${m.user.id}` } })}>
                    Управлять
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ChannelEditor({ channel }: { channel: Channel }) {
  const [d, setD] = useState({ name: channel.name, topic: channel.topic, category: channel.category, slowmodeSeconds: channel.slowmodeSeconds });
  const dirty = JSON.stringify(d) !== JSON.stringify({ name: channel.name, topic: channel.topic, category: channel.category, slowmodeSeconds: channel.slowmodeSeconds });
  return (
    <>
      <h2>Канал {channel.type === 'text' ? `#${channel.name}` : channel.name}</h2>
      <div className="settings-grid">
        <label className="field">
          <span className="field-label">Название</span>
          <input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">Категория</span>
          <input className="input" value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })} />
        </label>
      </div>
      {channel.type === 'text' && (
        <>
          <label className="field" style={{ marginTop: 16 }}>
            <span className="field-label">Тема канала</span>
            <textarea className="textarea" maxLength={1024} value={d.topic} onChange={(e) => setD({ ...d, topic: e.target.value })} />
          </label>
          <label className="field" style={{ marginTop: 16 }}>
            <span className="field-label">Медленный режим — {d.slowmodeSeconds ? `${d.slowmodeSeconds} с` : 'выключен'}</span>
            <select className="select" value={d.slowmodeSeconds} onChange={(e) => setD({ ...d, slowmodeSeconds: Number(e.target.value) })}>
              {[0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? 'Выключен' : v < 60 ? `${v} с` : `${v / 60} мин`}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {dirty && (
        <div className="save-bar">
          <span className="grow">Несохранённые изменения</span>
          <button className="btn btn-success btn-sm" onClick={() => void attempt(() => api.patch(`/channels/${channel.id}`, d), 'Канал сохранён')}>
            Сохранить
          </button>
        </div>
      )}
    </>
  );
}

function Badges({ serverId }: { serverId: string }) {
  const [badges, setBadges] = useState<(Badge & { holders: string[] })[]>([]);
  const [form, setForm] = useState({ name: '', description: '', emoji: '🏆', color: '#f5a623' });
  const members = useApp((s) => s.members[serverId] ?? {});
  const load = () => void api.get<(Badge & { holders: string[] })[]>(`/servers/${serverId}/badges`).then(setBadges, (err) => toast(errorMessage(err), 'error'));
  useEffect(load, [serverId]);
  return (
    <>
      <h2>Значки</h2>
      <p className="muted">Значки выдают только участники с правом «Управлять значками» (Owner/Admin). Пользователи не могут выдать значок сами себе — это проверяет сервер.</p>
      <div className="card col" style={{ marginBottom: 16 }}>
        <div className="settings-grid">
          <label className="field">
            <span className="field-label">Название</span>
            <input className="input" maxLength={32} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Early User" />
          </label>
          <label className="field">
            <span className="field-label">Эмодзи и цвет</span>
            <span className="row">
              <input className="input" style={{ width: 70 }} maxLength={4} value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} />
              <span className="color-input">
                <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
              </span>
            </span>
          </label>
        </div>
        <label className="field">
          <span className="field-label">Описание</span>
          <input className="input" maxLength={200} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Joined during early access." />
        </label>
        <button
          className="btn btn-primary"
          style={{ alignSelf: 'flex-start' }}
          disabled={!form.name.trim()}
          onClick={async () => {
            if (await attempt(() => api.post(`/servers/${serverId}/badges`, form), 'Значок создан')) {
              setForm({ ...form, name: '', description: '' });
              load();
            }
          }}
        >
          <LuPlus /> Создать значок
        </button>
      </div>
      {badges.map((b) => (
        <BadgeRow key={b.id} b={b} serverId={serverId} members={Object.values(members).map((m) => m.user)} onChange={load} />
      ))}
    </>
  );
}

function BadgeRow({ b, serverId, members, onChange }: { b: Badge & { holders: string[] }; serverId: string; members: User[]; onChange: () => void }) {
  const [edit, setEdit] = useState(false);
  const [d, setD] = useState({ name: b.name, description: b.description, emoji: b.emoji ?? '', color: b.color, position: b.position });
  const [grantTo, setGrantTo] = useState('');
  const holders = members.filter((m) => b.holders.includes(m.id));
  return (
    <div className="badge-editor" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="row">
        <span className="badge-preview" style={{ background: `color-mix(in srgb, ${b.color} 28%, transparent)` }}>
          {b.iconUrl ? <img src={b.iconUrl} alt="" /> : b.emoji}
        </span>
        <div className="grow">
          <strong style={{ color: 'var(--text-0)' }}>{b.name}</strong>
          <div className="muted" style={{ fontSize: '0.8125rem' }}>{b.description}</div>
        </div>
        <label className="btn btn-ghost btn-sm">
          Иконка
          <input
            type="file"
            hidden
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void attempt(() => api.putFile(`/servers/${serverId}/badges/${b.id}/icon`, f), 'Иконка обновлена').then(onChange);
            }}
          />
        </label>
        <button className="btn btn-secondary btn-sm" onClick={() => setEdit(!edit)}>
          {edit ? 'Готово' : 'Изменить'}
        </button>
        <button className="icon-btn danger" aria-label="Удалить значок" onClick={() => confirm(`Удалить значок «${b.name}»?`) && void attempt(() => api.del(`/servers/${serverId}/badges/${b.id}`), 'Значок удалён').then(onChange)}>
          <LuTrash2 />
        </button>
      </div>
      {edit && (
        <div className="settings-grid">
          <input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} aria-label="Название" />
          <input className="input" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} aria-label="Описание" />
          <span className="row">
            <input className="input" style={{ width: 70 }} value={d.emoji} onChange={(e) => setD({ ...d, emoji: e.target.value })} aria-label="Эмодзи" />
            <input type="color" value={d.color} onChange={(e) => setD({ ...d, color: e.target.value })} aria-label="Цвет" />
            <input className="input" type="number" style={{ width: 90 }} value={d.position} onChange={(e) => setD({ ...d, position: Number(e.target.value) })} aria-label="Порядок" title="Порядок отображения" />
          </span>
          <button className="btn btn-success btn-sm" onClick={() => void attempt(() => api.patch(`/servers/${serverId}/badges/${b.id}`, { ...d, emoji: d.emoji || null }), 'Сохранено').then(onChange)}>
            Сохранить
          </button>
        </div>
      )}
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <span className="field-label">Владельцы:</span>
        {holders.length === 0 && <span className="muted" style={{ fontSize: '0.8125rem' }}>никто</span>}
        {holders.map((u) => (
          <span key={u.id} className="pill">
            <Avatar user={u} size={16} /> {u.displayName || u.username}
            <button aria-label="Снять значок" onClick={() => void attempt(() => api.del(`/servers/${serverId}/badges/${b.id}/users/${u.id}`), 'Значок снят').then(onChange)}>
              <LuX style={{ width: 12, height: 12 }} />
            </button>
          </span>
        ))}
        <select className="select" style={{ width: 'auto', padding: '4px 30px 4px 8px' }} value={grantTo} onChange={(e) => setGrantTo(e.target.value)} aria-label="Выдать участнику">
          <option value="">+ Выдать участнику…</option>
          {members.filter((m) => !b.holders.includes(m.id)).map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName || m.username}
            </option>
          ))}
        </select>
        {grantTo && (
          <button className="btn btn-primary btn-sm" onClick={() => void attempt(() => api.put(`/servers/${serverId}/badges/${b.id}/users/${grantTo}`), 'Значок выдан').then(() => (setGrantTo(''), onChange()))}>
            Выдать
          </button>
        )}
      </div>
    </div>
  );
}

function Invites({ serverId }: { serverId: string }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const load = () => void api.get<Invite[]>(`/servers/${serverId}/invites`).then(setInvites, (err) => toast(errorMessage(err), 'error'));
  useEffect(load, [serverId]);
  return (
    <>
      <h2>Приглашения</h2>
      <button className="btn btn-primary btn-sm" onClick={() => uiStore.set({ modal: { kind: 'invite', serverId } })} style={{ marginBottom: 12 }}>
        Создать приглашение
      </button>
      <table className="table">
        <thead>
          <tr>
            <th>Код</th>
            <th>Использований</th>
            <th>Истекает</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {invites.map((i) => (
            <tr key={i.code}>
              <td>
                <code className="md-inline-code">/invite/{i.code}</code>
              </td>
              <td>
                {i.uses}
                {i.maxUses ? ` / ${i.maxUses}` : ''}
              </td>
              <td className="muted">{i.expiresAt ? new Date(i.expiresAt).toLocaleString('ru-RU') : 'никогда'}</td>
              <td>
                <button className="icon-btn danger" aria-label="Удалить приглашение" onClick={() => void attempt(() => api.del(`/invites/${i.code}`), 'Приглашение удалено').then(load)}>
                  <LuTrash2 />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {invites.length === 0 && <p className="muted">Активных приглашений нет.</p>}
    </>
  );
}

function Bans({ serverId }: { serverId: string }) {
  const [bans, setBans] = useState<{ user: User; reason: string | null; createdAt: string }[]>([]);
  const load = () => void api.get<typeof bans>(`/servers/${serverId}/bans`).then(setBans, (err) => toast(errorMessage(err), 'error'));
  useEffect(load, [serverId]);
  return (
    <>
      <h2>Баны</h2>
      {bans.length === 0 && <p className="muted">Никто не забанен.</p>}
      {bans.map((b) => (
        <div key={b.user.id} className="session-row">
          <Avatar user={b.user} size={32} />
          <div className="grow">
            <strong>{b.user.displayName || b.user.username}</strong>
            <div className="muted" style={{ fontSize: '0.8125rem' }}>{b.reason || 'Без причины'}</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => void attempt(() => api.del(`/servers/${serverId}/bans/${b.user.id}`), 'Бан снят').then(load)}>
            Разбанить
          </button>
        </div>
      ))}
    </>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'server.update': 'изменил(а) настройки сервера',
  'channel.create': 'создал(а) канал',
  'channel.update': 'изменил(а) канал',
  'channel.delete': 'удалил(а) канал',
  'role.create': 'создал(а) роль',
  'role.update': 'изменил(а) роль',
  'role.delete': 'удалил(а) роль',
  'member.roles': 'изменил(а) роли участника',
  'member.kick': 'выгнал(а)',
  'member.ban': 'забанил(а)',
  'member.unban': 'разбанил(а)',
  'member.timeout': 'выдал(а) тайм-аут',
  'message.delete': 'удалил(а) сообщение',
  'message.pin': 'закрепил(а)/открепил(а) сообщение',
  'invite.create': 'создал(а) приглашение',
  'invite.delete': 'удалил(а) приглашение',
  'badge.create': 'создал(а) значок',
  'badge.update': 'изменил(а) значок',
  'badge.delete': 'удалил(а) значок',
  'badge.grant': 'выдал(а) значок',
  'badge.revoke': 'снял(а) значок',
  'voice.mute': 'изменил(а) серверный мут',
  'voice.move': 'переместил(а) в голосовой канал',
  'voice.disconnect': 'отключил(а) от голоса',
};

interface AuditEntry {
  id: string;
  actor: User | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetUser: User | null;
  data: Record<string, unknown>;
  createdAt: string;
}

function AuditLog({ serverId }: { serverId: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [more, setMore] = useState(true);
  const load = async (before?: string) => {
    const page = await attempt(() => api.get<AuditEntry[]>(`/servers/${serverId}/audit-log${before ? `?before=${before}` : ''}`));
    if (!page) return;
    setEntries((e) => (before ? [...e, ...page] : page));
    setMore(page.length === 50);
  };
  useEffect(() => void load(), [serverId]);
  return (
    <>
      <h2>Журнал аудита</h2>
      {entries.map((e) => (
        <div key={e.id} className="session-row">
          <Avatar user={e.actor} size={32} />
          <div className="grow">
            <div>
              <strong>{e.actor?.displayName || e.actor?.username || 'Система'}</strong> {ACTION_LABELS[e.action] ?? e.action}{' '}
              {e.targetUser && <strong>{e.targetUser.displayName || e.targetUser.username}</strong>}
              {typeof e.data.name === 'string' && <strong> «{e.data.name}»</strong>}
              {typeof e.data.badge === 'string' && <strong> «{e.data.badge}»</strong>}
            </div>
            <div className="muted" style={{ fontSize: '0.75rem' }}>
              {formatTimestamp(e.createdAt)}
              {typeof e.data.reason === 'string' && e.data.reason && ` · причина: ${e.data.reason}`}
              {typeof e.data.content === 'string' && ` · «${e.data.content.slice(0, 80)}»`}
            </div>
          </div>
        </div>
      ))}
      {entries.length === 0 && <p className="muted">Записей пока нет.</p>}
      {more && entries.length > 0 && (
        <button className="btn btn-secondary btn-sm" onClick={() => void load(entries[entries.length - 1]!.id)}>
          Загрузить ещё
        </button>
      )}
    </>
  );
}

export function ServerSettings() {
  const ss = useUi((s) => s.serverSettings);
  const server = useApp((s) => (ss ? s.servers[ss.serverId] : undefined));
  const perms = useApp((s) => (ss ? (s.permissions[ss.serverId] ?? 0n) : 0n));
  const me = useApp((s) => s.me?.id);
  const channels = useApp((s) => (ss ? channelsOf(s, ss.serverId) : []));
  useEffect(() => {
    if (ss) void refreshServer(ss.serverId);
  }, [ss?.serverId]);
  useEffect(() => {
    if (!ss) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.overlay') && uiStore.set({ serverSettings: null });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [!!ss]);
  const tabs = useMemo(() => {
    const t: [string, string][] = [];
    if (can(perms, Perm.MANAGE_SERVER)) t.push(['overview', 'Обзор']);
    if (can(perms, Perm.MANAGE_ROLES)) t.push(['roles', 'Роли']);
    t.push(['members', 'Участники']);
    if (can(perms, Perm.MANAGE_BADGES)) t.push(['badges', 'Значки']);
    if (can(perms, Perm.MANAGE_SERVER)) t.push(['invites', 'Приглашения']);
    if (can(perms, Perm.BAN_MEMBERS)) t.push(['bans', 'Баны']);
    if (can(perms, Perm.VIEW_AUDIT_LOG)) t.push(['audit', 'Журнал аудита']);
    return t;
  }, [perms]);
  if (!ss || !server) return null;
  const close = () => uiStore.set({ serverSettings: null });
  const tab = ss.tab;
  const go = (t: string) => uiStore.set({ serverSettings: { serverId: server.id, tab: t } });
  const channelTab = tab.startsWith('channel:') ? channels.find((c) => c.id === tab.slice(8)) : null;
  const memberTab = tab.startsWith('member:') ? tab.slice(7) : null;
  const effective = channelTab || memberTab ? tab : tabs.some(([k]) => k === tab) ? tab : (tabs[0]?.[0] ?? 'members');

  return createPortal(
    <div className="settings" role="dialog" aria-label="Настройки сервера">
      <aside className="settings-nav scroll">
        <nav>
          <h4 className="ellipsis">{server.name}</h4>
          {tabs.map(([k, l]) => (
            <button key={k} aria-current={effective === k ? 'page' : undefined} onClick={() => go(k)}>
              {l}
            </button>
          ))}
          {can(perms, Perm.MANAGE_CHANNELS) && (
            <>
              <h4>Каналы</h4>
              {channels.map((c) => (
                <button key={c.id} aria-current={effective === `channel:${c.id}` ? 'page' : undefined} onClick={() => go(`channel:${c.id}`)}>
                  {c.type === 'text' ? '#' : '🔊'} {c.name}
                </button>
              ))}
            </>
          )}
          {server.ownerId === me && (
            <>
              <div className="menu-divider" />
              <button
                style={{ color: 'var(--red)' }}
                onClick={async () => {
                  const typed = prompt(`Это действие необратимо. Введите название сервера «${server.name}» для подтверждения.`);
                  if (typed !== server.name) return;
                  if (await deleteServer(server.id)) {
                    close();
                    navigate({ name: 'friends' });
                  }
                }}
              >
                Удалить сервер
              </button>
            </>
          )}
        </nav>
      </aside>
      <main className="settings-content scroll">
        {effective === 'overview' && <Overview key={server.id} server={server} />}
        {effective === 'roles' && <Roles serverId={server.id} perms={perms} />}
        {effective === 'members' && <Members serverId={server.id} perms={perms} />}
        {effective === 'badges' && <Badges serverId={server.id} />}
        {effective === 'invites' && <Invites serverId={server.id} />}
        {effective === 'bans' && <Bans serverId={server.id} />}
        {effective === 'audit' && <AuditLog serverId={server.id} />}
        {channelTab && <ChannelEditor key={channelTab.id} channel={channelTab} />}
        {memberTab && <MemberEditor serverId={server.id} userId={memberTab} perms={perms} />}
      </main>
      <div className="settings-close">
        <button onClick={close} aria-label="Закрыть">
          <LuX />
        </button>
        <span>ESC</span>
      </div>
    </div>,
    document.body,
  );
}
