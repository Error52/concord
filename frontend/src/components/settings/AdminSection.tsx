import { useEffect, useMemo, useState } from 'react';
import { LuPlus, LuShield, LuTrash2 } from 'react-icons/lu';
import { api, errorMessage } from '../../api/client';
import { useApp } from '../../state/app';
import { toast } from '../../state/ui';
import { Avatar } from '../ui/Avatar';
import { formatTimestamp } from '../../utils/format';
import type { Badge, User } from '../../types';

/**
 * Platform admin panel: special badges that are shown on profiles everywhere (like Discord's
 * Staff / Early Supporter), plus the list of platform admins. All checks are repeated on the backend.
 */

type AdminBadge = Badge & { holderCount: number };

interface AdminUser {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
  isPlatformAdmin: boolean;
  adminFromEnv: boolean;
  createdAt: string;
  globalBadgeIds: string[];
}

interface AuditEntry {
  id: string;
  action: string;
  actor: User | null;
  target: User | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

const ACTIONS: Record<string, string> = {
  'badge.create': 'создал(а) значок',
  'badge.update': 'изменил(а) значок',
  'badge.icon': 'сменил(а) иконку значка',
  'badge.delete': 'удалил(а) значок',
  'badge.grant': 'выдал(а) значок',
  'badge.revoke': 'снял(а) значок',
  'admin.grant': 'выдал(а) права администратора',
  'admin.revoke': 'снял(а) права администратора',
};

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

function BadgeGlyph({ b, size = 40 }: { b: Pick<Badge, 'color' | 'iconUrl' | 'emoji'>; size?: number }) {
  return (
    <span className="badge-preview" style={{ width: size, height: size, background: `color-mix(in srgb, ${b.color} 28%, transparent)` }}>
      {b.iconUrl ? <img src={b.iconUrl} alt="" /> : (b.emoji ?? '★')}
    </span>
  );
}

const name = (u: { displayName: string | null; username: string }) => u.displayName || u.username;

export function AdminSection() {
  const me = useApp((s) => s.me);
  const [tab, setTab] = useState<'badges' | 'users' | 'audit'>('badges');
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [badges, setBadges] = useState<AdminBadge[]>([]);
  const loadBadges = () => void api.get<AdminBadge[]>('/admin/badges').then(setBadges, (e) => toast(errorMessage(e), 'error'));
  const loadStats = () => void api.get<Record<string, number>>('/admin/stats').then(setStats, () => undefined);
  useEffect(() => {
    loadBadges();
    loadStats();
  }, []);
  if (!me?.isPlatformAdmin) return null;
  return (
    <>
      <h2>
        <LuShield style={{ verticalAlign: '-3px' }} /> Админ-панель
      </h2>
      <p className="muted">
        Особые значки видны в профиле пользователя на всех серверах и в личных сообщениях — как значки Discord Staff. Создавать и выдавать их могут только
        администраторы платформы; сервер проверяет это при каждом запросе.
      </p>
      {stats && (
        <div className="admin-stats">
          {(
            [
              ['users', 'Пользователи'],
              ['servers', 'Серверы'],
              ['messages', 'Сообщения'],
              ['globalBadges', 'Особые значки'],
              ['admins', 'Администраторы'],
            ] as const
          ).map(([k, l]) => (
            <div key={k} className="card">
              <div className="admin-stat-value">{(stats[k] ?? 0).toLocaleString('ru-RU')}</div>
              <div className="muted">{l}</div>
            </div>
          ))}
        </div>
      )}
      <div className="admin-tabs" role="tablist">
        {(
          [
            ['badges', 'Особые значки'],
            ['users', 'Пользователи'],
            ['audit', 'Журнал'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'badges' && (
        <BadgesTab
          badges={badges}
          onChange={() => {
            loadBadges();
            loadStats();
          }}
        />
      )}
      {tab === 'users' && <UsersTab badges={badges} meId={me.id} onChange={() => { loadBadges(); loadStats(); }} />}
      {tab === 'audit' && <AuditTab />}
    </>
  );
}

// ───────────────────────────── badges ─────────────────────────────

function BadgesTab({ badges, onChange }: { badges: AdminBadge[]; onChange: () => void }) {
  const [form, setForm] = useState({ name: '', description: '', emoji: '🛡️', color: '#5865f2' });
  const [icon, setIcon] = useState<File | null>(null);
  const iconPreview = useMemo(() => (icon ? URL.createObjectURL(icon) : null), [icon]);
  useEffect(() => () => void (iconPreview && URL.revokeObjectURL(iconPreview)), [iconPreview]);
  const create = async () => {
    const b = await attempt(() => api.post<Badge>('/admin/badges', { ...form, emoji: form.emoji || null }));
    if (!b) return;
    if (icon) await attempt(() => api.putFile(`/admin/badges/${b.id}/icon`, icon));
    toast('Значок создан', 'success');
    setForm({ ...form, name: '', description: '' });
    setIcon(null);
    onChange();
  };
  return (
    <>
      <h3>Новый особый значок</h3>
      <div className="card col" style={{ marginBottom: 16 }}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <BadgeGlyph b={{ color: form.color, emoji: form.emoji || null, iconUrl: iconPreview }} size={56} />
          <div className="grow col">
            <div className="settings-grid">
              <label className="field">
                <span className="field-label">Название</span>
                <input className="input" maxLength={32} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Concord Staff" />
              </label>
              <label className="field">
                <span className="field-label">Эмодзи и цвет</span>
                <span className="row">
                  <input className="input" style={{ width: 70 }} maxLength={8} value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} />
                  <span className="color-input">
                    <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} aria-label="Цвет" />
                  </span>
                </span>
              </label>
            </div>
            <label className="field">
              <span className="field-label">Описание (видно при наведении)</span>
              <input className="input" maxLength={200} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Команда Concord" />
            </label>
            <div className="row">
              <label className="btn btn-secondary btn-sm">
                {icon ? `Иконка: ${icon.name}` : 'Своя картинка…'}
                <input type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => setIcon(e.target.files?.[0] ?? null)} />
              </label>
              {icon && (
                <button className="btn btn-ghost btn-sm" onClick={() => setIcon(null)}>
                  Убрать картинку
                </button>
              )}
              <span className="muted" style={{ fontSize: '0.8125rem' }}>
                PNG/JPG/WebP/GIF, будет уменьшена до 64×64. Без картинки показывается эмодзи.
              </span>
            </div>
            <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={!form.name.trim()} onClick={() => void create()}>
              <LuPlus /> Создать значок
            </button>
          </div>
        </div>
      </div>
      <h3>Особые значки ({badges.length})</h3>
      {badges.length === 0 && <p className="muted">Пока нет ни одного особого значка.</p>}
      {badges.map((b) => (
        <AdminBadgeRow key={b.id} b={b} onChange={onChange} />
      ))}
    </>
  );
}

function AdminBadgeRow({ b, onChange }: { b: AdminBadge; onChange: () => void }) {
  const [edit, setEdit] = useState(false);
  const [open, setOpen] = useState(false);
  const [d, setD] = useState({ name: b.name, description: b.description, emoji: b.emoji ?? '', color: b.color, position: b.position });
  const [holders, setHolders] = useState<User[] | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<AdminUser[]>([]);
  const loadHolders = () => void api.get<User[]>(`/admin/badges/${b.id}/users`).then(setHolders, (e) => toast(errorMessage(e), 'error'));
  useEffect(() => {
    if (open) loadHolders();
  }, [open, b.holderCount]);
  useEffect(() => {
    if (!open || !q.trim()) return setFound([]);
    const t = setTimeout(() => void api.get<AdminUser[]>(`/admin/users?q=${encodeURIComponent(q.trim())}`).then(setFound, () => setFound([])), 250);
    return () => clearTimeout(t);
  }, [q, open]);
  const grant = async (u: AdminUser) => {
    if ((await attempt(() => api.put(`/admin/badges/${b.id}/users/${u.id}`), `Значок «${b.name}» выдан ${name(u)}`)) !== null) {
      setQ('');
      onChange();
      loadHolders();
    }
  };
  return (
    <div className="badge-editor" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="row">
        <BadgeGlyph b={b} />
        <div className="grow">
          <strong style={{ color: 'var(--text-0)' }}>{b.name}</strong>
          <div className="muted" style={{ fontSize: '0.8125rem' }}>
            {b.description || 'Без описания'} · у {b.holderCount} {b.holderCount === 1 ? 'пользователя' : 'пользователей'}
          </div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(!open)}>
          {open ? 'Скрыть' : 'Выдать / владельцы'}
        </button>
        <label className="btn btn-ghost btn-sm">
          Иконка
          <input
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void attempt(() => api.putFile(`/admin/badges/${b.id}/icon`, f), 'Иконка обновлена').then(onChange);
            }}
          />
        </label>
        {b.iconUrl && (
          <button className="btn btn-ghost btn-sm" onClick={() => void attempt(() => api.del(`/admin/badges/${b.id}/icon`), 'Иконка убрана').then(onChange)}>
            Убрать иконку
          </button>
        )}
        <button className="btn btn-secondary btn-sm" onClick={() => setEdit(!edit)}>
          {edit ? 'Отмена' : 'Изменить'}
        </button>
        <button
          className="icon-btn danger"
          aria-label="Удалить значок"
          onClick={() => confirm(`Удалить особый значок «${b.name}»? Он исчезнет у всех ${b.holderCount} владельцев.`) && void attempt(() => api.del(`/admin/badges/${b.id}`), 'Значок удалён').then(onChange)}
        >
          <LuTrash2 />
        </button>
      </div>
      {edit && (
        <div className="col" style={{ marginTop: 8 }}>
          <div className="settings-grid">
            <input className="input" maxLength={32} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} aria-label="Название" />
            <span className="row">
              <input className="input" style={{ width: 70 }} maxLength={8} value={d.emoji} onChange={(e) => setD({ ...d, emoji: e.target.value })} aria-label="Эмодзи" />
              <span className="color-input">
                <input type="color" value={d.color} onChange={(e) => setD({ ...d, color: e.target.value })} aria-label="Цвет" />
              </span>
              <input className="input" style={{ width: 90 }} type="number" min={0} max={1000} value={d.position} onChange={(e) => setD({ ...d, position: Number(e.target.value) })} aria-label="Порядок" title="Порядок (меньше — левее)" />
            </span>
          </div>
          <input className="input" maxLength={200} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} aria-label="Описание" placeholder="Описание" />
          <button
            className="btn btn-primary btn-sm"
            style={{ alignSelf: 'flex-start' }}
            disabled={!d.name.trim()}
            onClick={async () => {
              if (await attempt(() => api.patch(`/admin/badges/${b.id}`, { ...d, emoji: d.emoji || null }), 'Сохранено')) {
                setEdit(false);
                onChange();
              }
            }}
          >
            Сохранить
          </button>
        </div>
      )}
      {open && (
        <div className="col" style={{ marginTop: 8 }}>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Кому выдать: имя пользователя, отображаемое имя или email…" autoFocus />
          {found.map((u) => {
            const has = u.globalBadgeIds.includes(b.id);
            return (
              <div key={u.id} className="perm-row">
                <Avatar user={u} size={28} />
                <span className="grow">
                  {name(u)} <span className="muted">@{u.username} · {u.email}</span>
                </span>
                <button className="btn btn-primary btn-sm" disabled={has} onClick={() => void grant(u)}>
                  {has ? 'Уже есть' : 'Выдать'}
                </button>
              </div>
            );
          })}
          <div className="field-label" style={{ marginTop: 8 }}>
            Владельцы
          </div>
          {holders === null ? (
            <span className="muted">Загрузка…</span>
          ) : holders.length === 0 ? (
            <span className="muted">Значок пока никому не выдан.</span>
          ) : (
            holders.map((u) => (
              <div key={u.id} className="perm-row">
                <Avatar user={u} size={28} />
                <span className="grow">
                  {name(u)} <span className="muted">@{u.username}</span>
                </span>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={async () => {
                    if ((await attempt(() => api.del(`/admin/badges/${b.id}/users/${u.id}`), 'Значок снят')) !== null) {
                      onChange();
                      loadHolders();
                    }
                  }}
                >
                  Снять
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── users ─────────────────────────────

function UsersTab({ badges, meId, onChange }: { badges: AdminBadge[]; meId: string; onChange: () => void }) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const load = () => void api.get<AdminUser[]>(`/admin/users?q=${encodeURIComponent(q.trim())}`).then(setUsers, (e) => toast(errorMessage(e), 'error'));
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [q]);
  const toggleBadge = async (u: AdminUser, b: AdminBadge) => {
    const has = u.globalBadgeIds.includes(b.id);
    const ok = await attempt(() => (has ? api.del(`/admin/badges/${b.id}/users/${u.id}`) : api.put(`/admin/badges/${b.id}/users/${u.id}`)), has ? 'Значок снят' : 'Значок выдан');
    if (ok !== null) {
      load();
      onChange();
    }
  };
  return (
    <>
      <h3>Пользователи</h3>
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по имени, email или ID…" style={{ marginBottom: 12 }} />
      {users.length === 0 && <p className="muted">Никого не найдено.</p>}
      {users.map((u) => (
        <div key={u.id} className="badge-editor" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className="row">
            <Avatar user={u} size={36} />
            <div className="grow">
              <strong style={{ color: 'var(--text-0)' }}>{name(u)}</strong>{' '}
              {u.isPlatformAdmin && (
                <span className="admin-pill">
                  <LuShield /> админ{u.adminFromEnv ? ' (.env)' : ''}
                </span>
              )}
              <div className="muted" style={{ fontSize: '0.8125rem' }}>
                @{u.username} · {u.email} · с {formatTimestamp(u.createdAt)}
              </div>
            </div>
            {u.isPlatformAdmin ? (
              <button
                className="btn btn-secondary btn-sm"
                disabled={u.adminFromEnv}
                title={u.adminFromEnv ? 'Указан в PLATFORM_ADMIN_EMAILS в .env' : undefined}
                onClick={() =>
                  confirm(u.id === meId ? 'Снять права администратора с себя? Админ-панель пропадёт.' : `Снять права администратора с ${name(u)}?`) &&
                  void attempt(() => api.put(`/admin/users/${u.id}/admin`, { value: false }), 'Права сняты').then((r) => {
                    if (r !== null) {
                      load();
                      onChange();
                      if (u.id === meId) location.reload();
                    }
                  })
                }
              >
                Снять админа
              </button>
            ) : (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() =>
                  confirm(`Сделать ${name(u)} администратором платформы? Он(а) сможет управлять особыми значками и другими админами.`) &&
                  void attempt(() => api.put(`/admin/users/${u.id}/admin`, { value: true }), 'Права выданы — пользователю нужно обновить страницу').then((r) => {
                    if (r !== null) {
                      load();
                      onChange();
                    }
                  })
                }
              >
                Сделать админом
              </button>
            )}
          </div>
          {badges.length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {badges.map((b) => {
                const has = u.globalBadgeIds.includes(b.id);
                return (
                  <button
                    key={b.id}
                    className={`admin-badge-chip${has ? ' on' : ''}`}
                    aria-pressed={has}
                    title={has ? `Снять «${b.name}»` : `Выдать «${b.name}»`}
                    onClick={() => void toggleBadge(u, b)}
                  >
                    <BadgeGlyph b={b} size={22} />
                    {b.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

// ───────────────────────────── audit ─────────────────────────────

function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  useEffect(() => void api.get<AuditEntry[]>('/admin/audit-log').then(setEntries, (e) => toast(errorMessage(e), 'error')), []);
  if (!entries) return <p className="muted">Загрузка…</p>;
  return (
    <>
      <h3>Журнал действий администраторов</h3>
      {entries.length === 0 && <p className="muted">Пока пусто.</p>}
      <table className="table">
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td style={{ width: 36 }}>{e.actor && <Avatar user={e.actor} size={24} />}</td>
              <td>
                <strong>{e.actor ? name(e.actor) : 'Удалённый пользователь'}</strong> {ACTIONS[e.action] ?? e.action}
                {typeof e.meta?.badge === 'string' && <> «{e.meta.badge}»</>}
                {typeof e.meta?.name === 'string' && <> «{e.meta.name}»</>}
                {e.target && <> → {name(e.target)}</>}
              </td>
              <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                {formatTimestamp(e.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
