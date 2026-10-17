import { api, errorMessage, refreshSession, setAccessToken, setSessionLostHandler } from '../api/client';
import { Gateway } from '../websocket/gateway';
import { appStore, getState, initialState, setState, type AppState, type ChannelMessages } from './app';
import { navigate, routerStore } from './router';
import { toast, uiStore } from './ui';
import { settingsStore } from './settings';
import { cmpId, isNewer,newMessageNonce } from '../utils/ids';
import {messageForViewer,withReaction,type ReactionUpdate} from '../utils/reactions';
import { notifySound, showDesktopNotification } from '../utils/notify';
import type {
  Channel,
  Dm,
  FullServer,
  GifEmbed,
  IncomingCall,
  Member,
  Message,
  Notification,
  ReadyPayload,
  ReadState,
  Relation,
  Role,
  SelfUser,
  Server,
  User,
  VoiceState,
} from '../types';

// ───────────────────────────── gateway wiring ─────────────────────────────

export const gateway = new Gateway(() => {
  void logoutLocal('Сессия завершена. Войдите снова.');
});

gateway.onStatus((s) => setState({ gateway: s }));
setSessionLostHandler(() => void logoutLocal('Сессия истекла. Войдите снова.'));

const indexBy = <T, K extends string>(items: T[], key: (t: T) => K): Record<K, T> =>
  Object.fromEntries(items.map((i) => [key(i), i])) as Record<K, T>;

function mergeUsers(s: AppState, users: (User | null | undefined)[]): Record<string, User> {
  let changed = false;
  const next = { ...s.users };
  for (const u of users) {
    if (!u) continue;
    next[u.id] = u;
    changed = true;
  }
  return changed ? next : s.users;
}

function applyFullServer(s: AppState, full: FullServer): Partial<AppState> {
  const sid = full.server.id;
  const channels = { ...s.channels };
  for (const id of Object.keys(channels)) if (channels[id]!.serverId === sid) delete channels[id];
  for (const ch of full.channels) {
    const last=s.channels[ch.id]?.lastMessageId;
    channels[ch.id] = last&&(!ch.lastMessageId||isNewer(last,ch.lastMessageId))?{...ch,lastMessageId:last}:ch;
  }
  const voiceStates = { ...s.voiceStates };
  for (const [uid, vs] of Object.entries(voiceStates)) if (vs.serverId === sid) delete voiceStates[uid];
  for (const vs of full.voiceStates) voiceStates[vs.userId] = vs;
  return {
    servers: { ...s.servers, [sid]: full.server },
    serverOrder: s.serverOrder.includes(sid) ? s.serverOrder : [...s.serverOrder, sid],
    channels,
    roles: { ...s.roles, [sid]: full.roles },
    members: { ...s.members, [sid]: indexBy(full.members, (m) => m.user.id) },
    permissions: { ...s.permissions, [sid]: BigInt(full.permissions) },
    voiceStates,
    users: mergeUsers(s, full.members.map((m) => m.user)),
  };
}

function removeServer(s: AppState, sid: string): Partial<AppState> {
  const { [sid]: _s, ...servers } = s.servers;
  const { [sid]: _r, ...roles } = s.roles;
  const { [sid]: _m, ...members } = s.members;
  const { [sid]: _p, ...permissions } = s.permissions;
  const channelIds = new Set(Object.values(s.channels).filter(c => c.serverId === sid).map(c => c.id));
  const channels = Object.fromEntries(Object.entries(s.channels).filter(([, c]) => c.serverId !== sid));
  const messages = Object.fromEntries(Object.entries(s.messages).filter(([id]) => !channelIds.has(id)));
  const readStates = Object.fromEntries(Object.entries(s.readStates).filter(([id]) => !channelIds.has(id)));
  const typing = Object.fromEntries(Object.entries(s.typing).filter(([id]) => !channelIds.has(id)));
  const voiceStates = Object.fromEntries(Object.entries(s.voiceStates).filter(([,vs]) => vs.serverId !== sid));
  const speaking = Object.fromEntries(Object.entries(s.speaking).filter(([uid]) => s.voiceStates[uid]?.serverId !== sid));
  return { servers, roles, members, permissions, channels, messages, readStates, typing, voiceStates, speaking, serverOrder: s.serverOrder.filter((id) => id !== sid) };
}

let serverSnapshotGeneration = 0;
const serverRefreshes = new Map<string, number>();
type ServerChange=(s:AppState)=>Partial<AppState>;
const serverRefreshChanges=new Map<string,{request:number;changes:ServerChange[]}>();
function changeServerState(serverId:string|null,change:ServerChange):void {
  if(serverId)serverRefreshChanges.get(serverId)?.changes.push(change);
  setState(change);
}
function changeSharedServerState(change:ServerChange):void {
  for(const pending of serverRefreshChanges.values())pending.changes.push(change);
  setState(change);
}

function onReady(d: ReadyPayload): void {
  ++serverSnapshotGeneration;
  serverRefreshes.clear();
  serverRefreshChanges.clear();
  for(const timer of typingTimers.values())clearTimeout(timer);
  typingTimers.clear();
  readInFlight.clear();
  ++notificationGeneration;
  notificationSnapshotRevision=d.notifications.revision??'0';
  notificationRevision=notificationSnapshotRevision;
  notificationRows.clear();notificationMutations.clear();
  clearCallTimers();
  setState((s) => {
    let next: AppState = {
      ...s,
      me: d.user,
      ready: true,
      dms: indexBy(d.dms, (x) => x.id),
      relationships: indexBy(d.relationships, (r) => r.id),
      readStates: indexBy(d.readStates, (r) => r.channelId),
      notifications: d.notifications.items,
      unreadNotifications: d.notifications.unread,
      incomingCalls: d.incomingCalls,
      features: { gif: d.features.gif.enabled },
      servers: {},
      serverOrder: [],
      channels: {},
      roles: {},
      members: {},
      permissions: {},
      voiceStates: {},
      typing: {},
      speaking: {},
      // Message caches may have missed events while disconnected: drop them, they reload on view.
      messages: {},
      users: mergeUsers(s, [d.user, ...d.dms.flatMap((x) => x.recipients), ...d.relationships.map((r) => r.user)]),
    };
    for (const full of d.servers) next = { ...next, ...applyFullServer(next, full) };
    for (const dm of d.dms) {
      next.channels[dm.id] = { id: dm.id, serverId: null, type: 'dm', name: '', topic: '', category: '', position: 0, slowmodeSeconds: 0, lastMessageId: dm.lastMessageId };
    }
    for (const vs of d.dmVoiceStates) next.voiceStates[vs.userId] = vs;
    if (d.voiceState) next.voiceStates[d.voiceState.userId] = d.voiceState;
    return next;
  });
  for(const call of d.incomingCalls)scheduleCallTimeout(call);
  void reloadOpenChannel();
}

/** After (re)connect, refetch the channel currently on screen. */
async function reloadOpenChannel(): Promise<void> {
  const r = routerStore.get().route;
  const id = r.name === 'dm' ? r.channelId : r.name === 'channel' ? r.channelId : null;
  if (id) await loadMessages(id, { reset: true });
}

function upsertMessage(list: ChannelMessages | undefined, m: Message): ChannelMessages | undefined {
  if (!list) return list;
  const items = list.items.slice();
  // Replace an optimistic copy matched by nonce, or an existing message by id.
  const idx = items.findIndex((x) => x.id === m.id || (m.nonce && x.nonce === m.nonce && x.id.startsWith('pending-') && x.author?.id===m.author?.id));
  if (idx >= 0) items[idx] = { ...m, pending: false };
  else if (list.atLatest) {
    items.push(m);
    items.sort((a, b) => (a.pending ? 1 : b.pending ? -1 : cmpId(a.id, b.id)));
  } else return list;
  return { ...list, items };
}

const deliveredMessages=new Set<string>();
function onMessageNew(m: Message): void {
  recordMessageChange(m.channelId,m.id,()=>({...m,pending:false}),{...m,pending:false});
  const s = getState();
  const deliveryKey=`${s.me?.id}:${m.channelId}:${m.id}`;
  const duplicate=deliveredMessages.has(deliveryKey)||!!s.messages[m.channelId]?.items.some(item=>item.id===m.id);
  deliveredMessages.add(deliveryKey);
  if(deliveredMessages.size>2048)deliveredMessages.delete(deliveredMessages.values().next().value!);
  const mine = m.author?.id === s.me?.id;
  setState((st) => {
    const ch = st.channels[m.channelId];
    const previousRead=st.readStates[m.channelId];
    const authoritative=previousRead?.revision!==undefined;
    const readStates = !authoritative && mine && (!previousRead || isNewer(m.id,previousRead.lastReadId)) ? { ...st.readStates, [m.channelId]: { channelId: m.channelId, lastReadId: m.id, mentionCount: 0 } } : st.readStates;
    const mentioned = !authoritative && !duplicate && !mine && isNewer(m.id,previousRead?.lastReadId??'0') && (m.mentionIds.includes(st.me?.id ?? '') || m.mentionsEveryone);
    const rs = readStates[m.channelId];
    const nextRead = mentioned ? { ...readStates, [m.channelId]: { channelId: m.channelId, lastReadId: rs?.lastReadId ?? '0', mentionCount: (rs?.mentionCount ?? 0) + 1 } } : readStates;
    const lastMessageId=ch?.lastMessageId&&isNewer(ch.lastMessageId,m.id)?ch.lastMessageId:m.id;
    const dms = st.dms[m.channelId] ? { ...st.dms, [m.channelId]: { ...st.dms[m.channelId]!, lastMessageId } } : st.dms;
    const typing = st.typing[m.channelId] && m.author ? { ...st.typing, [m.channelId]: Object.fromEntries(Object.entries(st.typing[m.channelId]!).filter(([u]) => u !== m.author!.id)) } : st.typing;
    return {
      channels: ch ? { ...st.channels, [m.channelId]: { ...ch, lastMessageId } } : st.channels,
      messages: { ...st.messages, [m.channelId]: upsertMessage(st.messages[m.channelId], m)! },
      readStates: nextRead,
      dms,
      typing,
      users: mergeUsers(st, [m.author]),
    };
  });
  if (!getState().dms[m.channelId] && !m.serverId) void loadDm(m.channelId);
}

export function isViewing(channelId: string): boolean {
  const r = routerStore.get().route;
  return (r.name === 'dm' && r.channelId === channelId) || (r.name === 'channel' && r.channelId === channelId);
}

async function loadDm(id: string): Promise<void> {
  try {
    const dm = await api.get<Dm>(`/dm/${id}`);
    onDmCreate(dm);
  } catch {
    /* ignore */
  }
}

function onDmCreate(dm: Dm): void {
  setState((s) => ({
    dms: { ...s.dms, [dm.id]: dm },
    channels: { ...s.channels, [dm.id]: { id: dm.id, serverId: null, type: 'dm', name: '', topic: '', category: '', position: 0, slowmodeSeconds: 0, lastMessageId: dm.lastMessageId } },
    users: mergeUsers(s, dm.recipients),
  }));
}

function patchMessage(channelId: string, id: string, fn: (m: Message) => Message | null): void {
  recordMessageChange(channelId,id,fn);
  setState((s) => {
    const list = s.messages[channelId];
    if (!list) return {};
    const items: Message[] = [];
    for (const m of list.items) {
      if (m.id !== id) items.push(m);
      else {
        const r = fn(m);
        if (r) items.push(r);
      }
    }
    return { messages: { ...s.messages, [channelId]: { ...list, items } } };
  });
}

function onNotification(n: Notification): void {
  if(n.revision&&cmpId(n.revision,notificationSnapshotRevision)<=0)return;
  const row=notificationRows.get(n.id);
  if(row?.clear)return;
  if(row)n={...n,read:true};
  if(getState().notifications.some(item=>item.id===n.id))return;
  const unread=notificationCounter(n.revision,n.unread);
  setState((s) => ({ notifications: [n, ...s.notifications].slice(0, 100), unreadNotifications: unread??(n.revision?s.unreadNotifications:s.unreadNotifications+(n.read?0:1)) }));
  if(n.read)return;
  const me = getState().me;
  if (me?.chosenStatus === 'dnd') return;
  const viewing = n.data.channelId && isViewing(n.data.channelId as string) && document.hasFocus();
  if (viewing) return;
  const settings = settingsStore.get();
  if (settings.notificationSounds && n.type !== 'call') notifySound();
  const title = notificationTitle(n);
  if (settings.desktopNotifications && !document.hasFocus()) showDesktopNotification(title, String(n.data.content ?? ''));
  if (n.type === 'friend_request') toast(title);
}

let notificationGeneration=0;
let notificationSnapshotRevision='0',notificationRevision='0';
const notificationRows=new Map<string,{revision:string;clear:boolean}>();
function notificationCounter(revision?:string,unread?:number):number|undefined{
  if(revision&&unread!==undefined&&cmpId(revision,notificationRevision)>0){notificationRevision=revision;return unread;}
  return undefined;
}
interface NotificationMutation {mutationId?:string;ids:string[];unreadChanged:number;revision?:string;unread?:number}
const notificationMutations=new Set<string>();
function applyNotificationMutation(result:NotificationMutation,clear:boolean):void{
  if(result.revision&&cmpId(result.revision,notificationSnapshotRevision)<=0)return;
  if(result.mutationId){
    if(notificationMutations.has(result.mutationId))return;
    notificationMutations.add(result.mutationId);
    if(notificationMutations.size>512)notificationMutations.delete(notificationMutations.values().next().value!);
  }
  const ids=new Set(result.ids.filter(id=>{
    const previous=notificationRows.get(id);
    if(result.revision&&previous&&cmpId(previous.revision,result.revision)>=0)return false;
    if(result.revision)notificationRows.set(id,{revision:result.revision,clear});
    return true;
  }));
  while(notificationRows.size>2048)notificationRows.delete(notificationRows.keys().next().value!);
  const unread=notificationCounter(result.revision,result.unread);
  setState(s=>({notifications:clear?s.notifications.filter(n=>!ids.has(n.id)):s.notifications.map(n=>ids.has(n.id)?{...n,read:true}:n),
    unreadNotifications:unread??(result.revision?s.unreadNotifications:Math.max(0,s.unreadNotifications-result.unreadChanged))}));
}
gateway.on('notification:read',(result:NotificationMutation)=>applyNotificationMutation(result,false));
gateway.on('notification:clear',(result:NotificationMutation)=>applyNotificationMutation(result,true));
async function mutateNotifications(clear:boolean):Promise<void>{
  const generation=notificationGeneration;
  const result=await (clear?api.del<NotificationMutation>('/notifications'):api.post<NotificationMutation>('/notifications/read',{ids:'all'}));
  if(generation!==notificationGeneration)return;
  applyNotificationMutation(result,clear);
}
export const markNotificationsRead=():Promise<void>=>mutateNotifications(false);
export const clearNotifications=():Promise<void>=>mutateNotifications(true);

export function notificationTitle(n: Notification): string {
  const who = (u: User | undefined) => u?.displayName || u?.username || 'Кто-то';
  switch (n.type) {
    case 'mention':
      return `${who(n.data.author)} упомянул(а) вас в #${n.data.channelName}`;
    case 'everyone':
      return `${who(n.data.author)} упомянул(а) @everyone в #${n.data.channelName}`;
    case 'dm':
      return `Новое сообщение от ${who(n.data.author)}`;
    case 'friend_request':
      return `${who(n.data.from)} хочет добавить вас в друзья`;
    case 'friend_accept':
      return `${who(n.data.user)} принял(а) запрос в друзья`;
    case 'call':
      return `Входящий звонок от ${who(n.data.caller)}`;
    default:
      return 'Уведомление';
  }
}

function patchUser(u: User): void {
  changeSharedServerState((s) => {
    const next: Partial<AppState> = { users: { ...s.users, [u.id]: { ...s.users[u.id], ...u } } };
    if (s.me?.id === u.id) next.me = { ...s.me, ...u } as SelfUser;
    return next;
  });
}

const typingTimers = new Map<string, number>();

gateway.on('ready', onReady);
gateway.on('message:new', onMessageNew);
gateway.on('message:update', (m: Message) => {
  patchMessage(m.channelId, m.id, previous=>messageForViewer(m,getState().me?.id??'',previous));
});
gateway.on('message:delete', (d: { id: string; channelId: string }) => patchMessage(d.channelId, d.id, () => null));
gateway.on('reaction:update', (d: ReactionUpdate) => {
  const me = getState().me?.id ?? '';
  patchMessage(d.channelId, d.messageId, m=>withReaction(m,d,me));
});
gateway.on('typing:start', (d: { channelId: string; userId: string; username: string }) => {
  setState((s) => ({ typing: { ...s.typing, [d.channelId]: { ...s.typing[d.channelId], [d.userId]: { name: d.username, until: Date.now() + 8000 } } } }));
  const key = `${d.channelId}:${d.userId}`;
  clearTimeout(typingTimers.get(key));
  typingTimers.set(
    key,
    window.setTimeout(() => {
      setState((s) => {
        const ch = { ...s.typing[d.channelId] };
        delete ch[d.userId];
        return { typing: { ...s.typing, [d.channelId]: ch } };
      });
    }, 8000),
  );
});
gateway.on('read:update', (d: ReadState) =>
  setState((s) => {
    const previous=s.readStates[d.channelId];
    if(previous?.revision!==undefined&&(!d.revision||cmpId(d.revision,previous.revision)<=0))return {};
    return {readStates:{...s.readStates,[d.channelId]:d}};
  }),
);
gateway.on('presence:update', (d: { userId: string; status: User['status'] }) =>
  changeSharedServerState((s) => {
    const u = s.users[d.userId];
    const next: Partial<AppState> = u ? { users: { ...s.users, [d.userId]: { ...u, status: d.status } } } : {};
    if (s.me?.id === d.userId) next.me = { ...s.me, status: d.status };
    return next;
  }),
);
gateway.on('user:update', (u: User) => patchUser(u));
gateway.on('friend:update', (list: Relation[]) => setState((s) => ({ relationships: indexBy(list, (r) => r.id), users: mergeUsers(s, list.map((r) => r.user)) })));
gateway.on('dm:create', onDmCreate);
gateway.on('notification:new', onNotification);
gateway.on('server:create', (full: FullServer) => changeServerState(full.server.id,(s) => applyFullServer(s, full)));
gateway.on('server:update', (srv: Server) => changeServerState(srv.id,(s) => ({ servers: { ...s.servers, [srv.id]: srv } })));
gateway.on('server:delete', (d: { id: string }) => leaveServerLocal(d.id, 'Сервер удалён'));
gateway.on('server:removed', (d: { id: string; reason: string }) =>
  leaveServerLocal(d.id, d.reason === 'kick' ? 'Вас исключили с сервера' : d.reason === 'ban' ? 'Вас заблокировали на сервере' : null),
);
gateway.on('channel:create', (ch: Channel) => changeServerState(ch.serverId,(s) => ({ channels: { ...s.channels, [ch.id]: ch } })));
gateway.on('channel:update', (ch: Channel) => changeServerState(ch.serverId,(s) => ({ channels: { ...s.channels, [ch.id]: { ...ch, lastMessageId: s.channels[ch.id]?.lastMessageId ?? ch.lastMessageId } } })));
gateway.on('channel:delete', (d: { id: string; serverId: string }) => {
  changeServerState(d.serverId,(s) => {
    const { [d.id]: _, ...channels } = s.channels;
    return { channels };
  });
  const r = routerStore.get().route;
  if (r.name === 'channel' && r.channelId === d.id) navigate({ name: 'channel', serverId: d.serverId, channelId: null }, true);
});
const upsertMember = (m: Member) =>
  changeServerState(m.serverId,(s) => ({ members: { ...s.members, [m.serverId]: { ...s.members[m.serverId], [m.user.id]: m } }, users: mergeUsers(s, [m.user]) }));
gateway.on('member:join', upsertMember);
gateway.on('member:update', (m: Member) => {
  upsertMember(m);
  if (m.user.id === getState().me?.id) void refreshServer(m.serverId);
});
gateway.on('member:leave', (d: { serverId: string; userId: string }) =>
  changeServerState(d.serverId,(s) => {
    const members = { ...s.members[d.serverId] };
    delete members[d.userId];
    return { members: { ...s.members, [d.serverId]: members } };
  }),
);
gateway.on('role:update', (d: { serverId: string; roles: Role[] }) => {
  changeServerState(d.serverId,(s) => ({ roles: { ...s.roles, [d.serverId]: d.roles } }));
  void refreshServer(d.serverId); // my effective permissions may have changed
});
gateway.on('voice:join', (vs: VoiceState) => changeSharedServerState((s) => ({ voiceStates: { ...s.voiceStates, [vs.userId]: vs } })));
gateway.on('voice:state', (vs: VoiceState) => changeSharedServerState((s) => ({ voiceStates: { ...s.voiceStates, [vs.userId]: vs } })));
gateway.on('voice:leave', (d: { userId: string; channelId: string }) =>
  changeSharedServerState((s) => {
    if (s.voiceStates[d.userId]?.channelId !== d.channelId) return {};
    const { [d.userId]: _, ...voiceStates } = s.voiceStates;
    const { [d.userId]: _sp, ...speaking } = s.speaking;
    return { voiceStates, speaking };
  }),
);
gateway.on('voice:speaking', (d: { userId: string; speaking: boolean }) => setState((s) => ({ speaking: { ...s.speaking, [d.userId]: d.speaking } })));
const callTimers=new Map<string,ReturnType<typeof window.setTimeout>>();
function clearCallTimers():void{for(const timer of callTimers.values())window.clearTimeout(timer);callTimers.clear();}
function scheduleCallTimeout(call:IncomingCall):void{
  const old=callTimers.get(call.channelId);if(old)window.clearTimeout(old);
  const accountId=getState().me?.id;
  callTimers.set(call.channelId,window.setTimeout(()=>{
    if(getState().me?.id===accountId)dismissCall(call.channelId,call.id);
  },Math.max(0,call.timeoutSec??45)*1000));
}
gateway.on('call:incoming', (d: IncomingCall & { timeoutSec: number }) => {
  if (getState().me?.chosenStatus === 'dnd') return;
  setState((s) => ({ incomingCalls: [...s.incomingCalls.filter((c) => c.channelId !== d.channelId), d] }));
  scheduleCallTimeout(d);
});
for (const ev of ['call:accepted', 'call:declined']) gateway.on(ev, (d: { channelId: string;ringId?:string }) => dismissCall(d.channelId,d.ringId));
gateway.on('call:ended',(d:{channelId:string;ringId?:string})=>{if(d.ringId)dismissCall(d.channelId,d.ringId);});

export function dismissCall(channelId: string,ringId?:string): void {
  if(ringId&&getState().incomingCalls.some(c=>c.channelId===channelId&&c.id!==ringId))return;
  const timer=callTimers.get(channelId);if(timer)window.clearTimeout(timer);callTimers.delete(channelId);
  setState((s) => ({ incomingCalls: s.incomingCalls.filter((c) => c.channelId !== channelId || (!!ringId&&c.id!==ringId)) }));
}

function leaveServerLocal(serverId: string, message: string | null): void {
  serverRefreshes.set(serverId, (serverRefreshes.get(serverId) ?? 0) + 1);
  serverRefreshChanges.delete(serverId);
  setState((s) => removeServer(s, serverId));
  if (message) toast(message, 'info');
  const r = routerStore.get().route;
  if (r.name === 'channel' && r.serverId === serverId) navigate({ name: 'friends' }, true);
}

export async function refreshServer(serverId: string): Promise<void> {
  const request = (serverRefreshes.get(serverId) ?? 0) + 1;
  serverRefreshes.set(serverId, request);
  const pending={request,changes:[] as ServerChange[]};
  serverRefreshChanges.set(serverId,pending);
  const snapshot = serverSnapshotGeneration, userId = getState().me?.id;
  try {
    const full = await api.get<FullServer>(`/servers/${serverId}`);
    if (serverRefreshes.get(serverId) !== request || snapshot !== serverSnapshotGeneration || getState().me?.id !== userId) return;
    setState((s) => {
      let next={...s,...applyFullServer(s,full)};
      for(const change of pending.changes)next={...next,...change(next)};
      return next;
    });
  } catch {
    /* removed or offline */
  } finally {
    if(serverRefreshChanges.get(serverId)===pending)serverRefreshChanges.delete(serverId);
  }
}

// ───────────────────────────── auth ─────────────────────────────

export async function bootstrap(): Promise<void> {
  try {
  const ok = await refreshSession();
  if (!ok) {
    setState({ auth: 'guest' });
    return;
  }
  try {
    const me = await api.get<SelfUser>('/users/me');
    setState({ auth: 'authed', me });
    if (!needsEmailVerification(me)) gateway.start();
  } catch {
    setState({ auth: 'guest' });
  }
  } catch (err) { setState({auth:'guest'});toast(errorMessage(err,'Не удалось подключиться к серверу'),'error'); }
}

export function needsEmailVerification(user:SelfUser):boolean {
  return user.emailVerificationRequired && !user.emailVerified;
}

export function onAuthenticated(user: SelfUser, accessToken: string): void {
  setAccessToken(accessToken);
  setState({ auth: 'authed', me: user });
  if (needsEmailVerification(user)) {
    gateway.stop();
    if (routerStore.get().route.name !== 'verify') navigate({name:'verify',token:''},true);
    return;
  }
  gateway.start();
  const r = routerStore.get().route;
  const pendingInvite = sessionStorage.getItem('concord.pendingInvite');
  if (pendingInvite) {
    sessionStorage.removeItem('concord.pendingInvite');
    navigate({ name: 'invite', code: pendingInvite }, true);
  } else if (['login','register','forgot','reset','verify'].includes(r.name)) navigate({ name: 'friends' }, true);
}

export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout');
  } catch {
    /* already gone */
  }
  await logoutLocal(null);
}

async function logoutLocal(message: string | null): Promise<void> {
  clearCallTimers();
  notificationRows.clear();notificationMutations.clear();deliveredMessages.clear();
  readInFlight.clear();
  gateway.stop();
  const { voice } = await import('../webrtc/voiceEngine');
  await voice.disconnect();
  setAccessToken(null);
  appStore.set({ ...initialState, auth: 'guest' });
  uiStore.set({ settings: null, serverSettings: null, profile: null, modal: null });
  navigate({ name: 'login' }, true);
  if (message) toast(message, 'info');
}

// ───────────────────────────── messages ─────────────────────────────

const PAGE = 50;
let messageLoadId=0;
type MessageChange={id:string;apply:(m:Message)=>Message|null;append?:Message};
const messageLoads=new Map<string,{id:number;changes:MessageChange[]}>();

function recordMessageChange(channelId:string,id:string,apply:(m:Message)=>Message|null,append?:Message):void {
  const load=messageLoads.get(channelId);
  if(load)load.changes.push({id,apply,append});
}
function mergeMessages(...groups:Message[][]):Message[] {
  const byId=new Map<string,Message>();
  for(const items of groups)for(const m of items){
    if(!m.pending&&m.nonce)for(const [id,old] of byId)if(old.id.startsWith('pending-')&&old.nonce===m.nonce&&old.author?.id===m.author?.id)byId.delete(id);
    byId.set(m.id,m);
  }
  return [...byId.values()].sort((a,b)=>{
    const ap=a.id.startsWith('pending-'),bp=b.id.startsWith('pending-');
    return ap&&bp?0:ap?1:bp?-1:cmpId(a.id,b.id);
  });
}
function beginMessageLoad(channelId:string,list:ChannelMessages):number {
  const id=++messageLoadId;messageLoads.set(channelId,{id,changes:[]});
  setState((s)=>({messages:{...s.messages,[channelId]:{...list,loading:true,loadFailed:false,loadId:id}}}));
  return id;
}
function ownsMessageLoad(channelId:string,id:number):boolean{return getState().messages[channelId]?.loadId===id;}
function applyMessageChanges(channelId:string,items:Message[],append:boolean):Message[] {
  const byId=new Map(items.map(m=>[m.id,m]));
  for(const change of messageLoads.get(channelId)?.changes??[]){
    const previous=byId.get(change.id);
    if(!previous){if(append&&change.append)byId.set(change.id,change.append);continue;}
    const next=change.apply(previous);if(next)byId.set(change.id,next);else byId.delete(change.id);
  }
  return mergeMessages([...byId.values()]);
}
function finishMessageLoad(channelId:string,id:number):void {if(messageLoads.get(channelId)?.id===id)messageLoads.delete(channelId);}

export async function loadMessages(channelId: string, opts: { reset?: boolean; around?: string } = {}): Promise<void> {
  const existing = getState().messages[channelId];
  if (existing && !existing.loadFailed && !opts.reset && !opts.around) return;
  if (opts.around && existing?.items.some((m) => m.id === opts.around)) return;
  const id=beginMessageLoad(channelId,{items:existing?.items??[],hasMoreBefore:true,atLatest:!opts.around,loading:true});
  try {
    const q = opts.around ? `?around=${opts.around}&limit=${PAGE}` : `?limit=${PAGE}`;
    const items = await api.get<Message[]>(`/channels/${channelId}/messages${q}`);
    if(!ownsMessageLoad(channelId,id))return;
    const lastKnown = getState().channels[channelId]?.lastMessageId;
    const atLatest = !opts.around || !lastKnown || items.some((m) => m.id === lastKnown) || items.length === 0;
    const reconciled=applyMessageChanges(channelId,items,atLatest);
    const pending=atLatest?(getState().messages[channelId]?.items.filter(m=>m.id.startsWith('pending-'))??[]):[];
    setState((s) => ({
      messages: { ...s.messages, [channelId]: { items:mergeMessages(pending,reconciled), hasMoreBefore: opts.around ? true : items.length >= PAGE, atLatest, loading: false } },
      users: mergeUsers(s, items.map((m) => m.author)),
    }));
  } catch (err) {
    if(!ownsMessageLoad(channelId,id))return;
    setState((s) => ({ messages: { ...s.messages, [channelId]: { ...s.messages[channelId]!, loading: false,loadFailed:true } } }));
    toast(errorMessage(err, 'Не удалось загрузить сообщения'), 'error');
  }finally{finishMessageLoad(channelId,id);}
}

export async function loadOlder(channelId: string): Promise<void> {
  const list = getState().messages[channelId];
  if (!list || list.loading || !list.hasMoreBefore || list.items.length === 0) return;
  const before = list.items.find((m) => !m.pending)?.id;
  if (!before) return;
  const id=beginMessageLoad(channelId,list);
  try {
    const older = await api.get<Message[]>(`/channels/${channelId}/messages?before=${before}&limit=${PAGE}`);
    if(!ownsMessageLoad(channelId,id))return;
    const items=applyMessageChanges(channelId,older,false);
    setState((s) => {
      const cur = s.messages[channelId]!;
      return {
        messages: { ...s.messages, [channelId]: { ...cur, items: mergeMessages(items,cur.items), hasMoreBefore: older.length >= PAGE, loading: false } },
        users: mergeUsers(s, older.map((m) => m.author)),
      };
    });
  } catch {
    if(!ownsMessageLoad(channelId,id))return;
    setState((s) => ({ messages: { ...s.messages, [channelId]: { ...s.messages[channelId]!, loading: false } } }));
  }finally{finishMessageLoad(channelId,id);}
}

export async function loadNewer(channelId: string): Promise<void> {
  const list = getState().messages[channelId];
  if (!list || list.atLatest || list.loading) return;
  const after = list.items.findLast(m=>!m.id.startsWith('pending-'))?.id;
  if (!after) return;
  const id=beginMessageLoad(channelId,list);
  try{
  const newer = await api.get<Message[]>(`/channels/${channelId}/messages?after=${after}&limit=${PAGE}`);
  if(!ownsMessageLoad(channelId,id))return;
  const items=applyMessageChanges(channelId,newer,newer.length<PAGE);
  setState((s) => {
    const cur = s.messages[channelId]!;
    return { messages: { ...s.messages, [channelId]: { ...cur, items:mergeMessages(items,cur.items), atLatest: newer.length < PAGE, loading: false } },users:mergeUsers(s,items.map(m=>m.author)) };
  });
  }catch{
    if(ownsMessageLoad(channelId,id))setState((s)=>({messages:{...s.messages,[channelId]:{...s.messages[channelId]!,loading:false}}}));
  }finally{finishMessageLoad(channelId,id);}
}

export interface OutgoingMessage {
  nonce?: string;
  content: string;
  replyToId?: string | null;
  attachmentIds?: string[];
  gif?: Omit<GifEmbed, 'type' | 'provider'> | null;
}

export async function sendMessage(channelId: string, msg: OutgoingMessage): Promise<boolean> {
  const s = getState();
  const nonce = msg.nonce ?? newMessageNonce();
  const optimistic: Message = {
    id: `pending-${nonce}`,
    channelId,
    serverId: s.channels[channelId]?.serverId ?? null,
    author: s.me,
    content: msg.content,
    kind: 'default',
    replyTo: msg.replyToId ? {id:msg.replyToId,author:null,content:''} : null,
    attachments: [],
    embeds: [],
    reactions: [],
    mentionIds: [],
    mentionsEveryone: false,
    pinned: false,
    editedAt: null,
    createdAt: new Date().toISOString(),
    nonce,
    pending: true,
  };
  if (!msg.attachmentIds?.length && !msg.gif) {
    setState((st) => {
      const list = st.messages[channelId];
      if (!list?.atLatest) return {};
      return { messages: { ...st.messages, [channelId]: { ...list, items: [...list.items.filter(m=>m.id!==optimistic.id), optimistic] } } };
    });
  }
  try {
    const sent = await api.post<Message>(`/channels/${channelId}/messages`, { ...msg, nonce });
    if(getState().me?.id!==s.me?.id)return false;
    onMessageNew(sent);
    return true;
  } catch (err) {
    if(getState().me?.id!==s.me?.id)return false;
    patchMessage(channelId, optimistic.id, (m) => ({ ...m, failed: true, pending: false }));
    toast(errorMessage(err, 'Не удалось отправить сообщение'), 'error');
    return false;
  }
}

export function discardFailed(channelId: string, id: string): void {
  patchMessage(channelId, id, () => null);
}

export async function editMessage(m: Message, content: string): Promise<void> {
  try {
    await api.patch(`/messages/${m.id}`, { content });
  } catch (err) {
    toast(errorMessage(err, 'Не удалось изменить сообщение'), 'error');
  }
}

export async function deleteMessage(m: Message): Promise<void> {
  try {
    await api.del(`/messages/${m.id}`);
  } catch (err) {
    toast(errorMessage(err, 'Не удалось удалить сообщение'), 'error');
  }
}

export async function toggleReaction(m: Message, emoji: string): Promise<void> {
  const mine = m.reactions.find((r) => r.emoji === emoji)?.me;
  try {
    await (mine ? api.del(`/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`) : api.put(`/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`));
  } catch (err) {
    toast(errorMessage(err, 'Не удалось поставить реакцию'), 'error');
  }
}

const readInFlight = new Map<string, {id:string;marker:AppState['readStates'][string]}>();
export async function markRead(channelId: string, messageId?: string): Promise<void> {
  const s = getState();
  const id = messageId ?? s.channels[channelId]?.lastMessageId;
  if (!id || id.startsWith('pending')) return;
  const rs = s.readStates[channelId];
  if (rs && !isNewer(id, rs.lastReadId) && rs.mentionCount === 0) return;
  if (readInFlight.get(channelId)?.id === id) return;
  const marker={channelId,lastReadId:rs&&isNewer(rs.lastReadId,id)?rs.lastReadId:id,mentionCount:0,...(rs?.revision!==undefined?{revision:rs.revision}:{})};
  const pending={id,marker};readInFlight.set(channelId,pending);
  setState((st) => ({ readStates: { ...st.readStates, [channelId]: marker } }));
  try {
    await api.post(`/channels/${channelId}/read`, { messageId: id });
  } catch {
    // Restore only our optimistic marker; preserve newer gateway events and other accounts.
    setState(st=>{
      if(st.readStates[channelId]!==marker)return {};
      const next={...st.readStates};if(rs)next[channelId]=rs;else delete next[channelId];return {readStates:next};
    });
  } finally {
    if(readInFlight.get(channelId)===pending)readInFlight.delete(channelId);
  }
}

export async function markUnread(m: Message): Promise<void> {
  await api.post(`/channels/${m.channelId}/unread`, { messageId: m.id }).catch(() => undefined);
}

let lastTyping = 0;
export function sendTyping(channelId: string): void {
  if (Date.now() - lastTyping < 3000) return;
  lastTyping = Date.now();
  gateway.send('typing', { channelId });
}

// ───────────────────────────── selectors ─────────────────────────────

export function hasUnread(s: AppState, channelId: string): boolean {
  const ch = s.channels[channelId];
  if (!ch?.lastMessageId) return false;
  const rs = s.readStates[channelId];
  return isNewer(ch.lastMessageId, rs?.lastReadId ?? '0');
}

export function mentionCount(s: AppState, channelId: string): number {
  return s.readStates[channelId]?.mentionCount ?? 0;
}

export function serverUnread(s: AppState, serverId: string): { unread: boolean; mentions: number } {
  let unread = false;
  let mentions = 0;
  for (const ch of Object.values(s.channels)) {
    if (ch.serverId !== serverId || ch.type !== 'text') continue;
    if (hasUnread(s, ch.id)) unread = true;
    mentions += mentionCount(s, ch.id);
  }
  return { unread, mentions };
}

export function dmUnreadTotal(s: AppState): number {
  let n = 0;
  for (const id of Object.keys(s.dms)) if (hasUnread(s, id)) n += Math.max(1, mentionCount(s, id));
  return n;
}

export function displayName(s: AppState, user: User | null | undefined, serverId?: string | null): string {
  if (!user) return 'Удалённый пользователь';
  const nick = serverId ? s.members[serverId]?.[user.id]?.nickname : null;
  const u = s.users[user.id] ?? user;
  return nick || u.displayName || u.username;
}

/** The colour of a member's highest coloured role. */
export function roleColor(s: AppState, serverId: string | null | undefined, userId: string): string | null {
  if (!serverId) return null;
  const member = s.members[serverId]?.[userId];
  const roles = s.roles[serverId];
  if (!member || !roles) return null;
  let best: Role | null = null;
  for (const r of roles) if (r.color && member.roleIds.includes(r.id) && (!best || r.position > best.position)) best = r;
  return best?.color ?? null;
}

export function channelsOf(s: AppState, serverId: string): Channel[] {
  return Object.values(s.channels)
    .filter((c) => c.serverId === serverId)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

export function firstTextChannel(s: AppState, serverId: string): string | null {
  return channelsOf(s, serverId).find((c) => c.type === 'text')?.id ?? null;
}
