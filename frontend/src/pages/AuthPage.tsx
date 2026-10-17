import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { api, ApiError, errorMessage, refreshSession, getAccessToken, setAccessToken } from '../api/client';
import { onAuthenticated, logout } from '../state/actions';
import { getState, useApp } from '../state/app';
import { navigate, type Route } from '../state/router';
import { toast } from '../state/ui';
import { ProfileCard } from '../components/profile/ProfileCard';
import { RecoveryWordForm } from '../components/auth/RecoveryWordForm';
import { PRESET_THEMES } from '../utils/color';
import { normalizeRecoveryWord, recoveryWordError } from '../utils/recoveryWord';
import type { AuthOptions, SelfUser, User } from '../types';

type AuthResponse = { user: SelfUser; accessToken: string } | { mfaRequired: true; ticket: string };
type AuthConfig={options:AuthOptions|null;error:string;retry:()=>void};

function OptionsNotice({config}:{config:AuthConfig}) {
  return config.error?<div><p className="field-error" role="alert">{config.error}</p><button type="button" className="link-btn" onClick={config.retry}>Повторить загрузку настроек</button></div>:!config.options?<p className="field-hint" role="status">Загружаем настройки регистрации…</p>:null;
}

const BANNER_COLORS = ['#7c6cff', '#5865f2', '#3b82f6', '#14b8a6', '#22c55e', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#64748b'];

function Brand() {
  return (
    <div className="auth-brand">
      <img src="/favicon.svg" alt="" />
      Concord
    </div>
  );
}

function fieldErrors(err: unknown): Record<string, string> {
  if (err instanceof ApiError && Array.isArray(err.details)) {
    return Object.fromEntries((err.details as { path: string; message: string }[]).map((d) => [d.path, d.message]));
  }
  return {};
}

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending=useRef(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if(pending.current)return;pending.current=true;
    setBusy(true);
    setError(null);
    try {
      const res = ticket
        ? await api.post<AuthResponse>('/auth/mfa', { ticket, code })
        : await api.post<AuthResponse>('/auth/login', { identifier:email, password });
      if ('mfaRequired' in res) setTicket(res.ticket);
      else onAuthenticated(res.user, res.accessToken);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.code === 'MFA_EXPIRED') setTicket(null);
    } finally {
      pending.current=false;
      setBusy(false);
    }
  };

  return (
    <form className="auth-card" onSubmit={submit}>
      <Brand />
      <h1>{ticket ? 'Двухфакторная проверка' : 'С возвращением!'}</h1>
      <p className="auth-sub">{ticket ? 'Введите 6-значный код из приложения-аутентификатора.' : 'Рады видеть вас снова.'}</p>
      <div className="auth-form">
        {ticket ? (
          <label className="field">
            <span className="field-label">Код</span>
            <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
          </label>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Email или имя пользователя</span>
              <input className="input" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </label>
            <label className="field">
              <span className="field-label">Пароль</span>
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <button type="button" className="link-btn" style={{ alignSelf: 'flex-start', fontSize: '0.8125rem' }} onClick={() => navigate({ name: 'forgot' })}>
              Забыли пароль?
            </button>
          </>
        )}
        {error && <div className="field-error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Входим…' : ticket ? 'Подтвердить' : 'Войти'}
        </button>
      </div>
      <p className="auth-alt">
        Нет аккаунта?{' '}
        <a href="/register" onClick={(e) => (e.preventDefault(), navigate({ name: 'register' }))}>
          Зарегистрироваться
        </a>
      </p>
    </form>
  );
}

function Register({config}:{config:AuthConfig}) {
  const [form, setForm] = useState({ username: '', displayName: '', email: '', password: '', confirm: '',recoveryWord:'',recoveryConfirm:'' });
  const [bannerColor, setBannerColor] = useState(BANNER_COLORS[0]!);
  const [preset, setPreset] = useState('default');
  const [avatar, setAvatar] = useState<File | null>(null);
  const [banner, setBanner] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pending=useRef(false);
  const wordMode=config.options?.verificationMode==='secret-word';
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const avatarUrl = useObjectUrl(avatar);
  const bannerUrl = useObjectUrl(banner);
  const preview: User = {
    id: 'preview',
    username: form.username || 'username',
    displayName: form.displayName || null,
    avatarUrl,
    bannerUrl,
    backgroundUrl: null,
    bannerColor,
    accentColor: bannerColor,
    bio: 'Так будет выглядеть ваш профиль.',
    theme: { preset, background: 'gradient' },
    status: 'online',
    customStatus: null,
    badges: [],
    createdAt: new Date().toISOString(),
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending.current || !config.options) return;
    const local: Record<string, string> = {};
    if (form.password !== form.confirm) local.confirm = 'Пароли не совпадают';
    if (form.password.length < 8) local.password = 'Пароль — минимум 8 символов';
    if(wordMode){const invalid=recoveryWordError(form.recoveryWord,form.recoveryConfirm,form.password,config.options.recoveryWordMinLength,config.options.recoveryWordMaxLength);if(invalid)local.recoveryWord=invalid;}
    for (const f of [avatar, banner]) if (f && f.size > 8 * 1024 * 1024) local.files = 'Изображение больше 8 МБ';
    setErrors(local);
    if (Object.keys(local).length) return;
    pending.current=true;
    setBusy(true);
    try {
      const res = await api.post<{ user: SelfUser; accessToken: string }>('/auth/register', {
        username: form.username,
        email: form.email,
        password: form.password,
        displayName: form.displayName || undefined,
        bannerColor,
        accentColor: bannerColor,
        theme: { preset },
        ...(wordMode?{recoveryWord:form.recoveryWord}:{}),
      });
      setAccessToken(res.accessToken);
      // Images are uploaded after the account exists; failures don't block sign-up.
      try {
        if (avatar) await api.putFile('/users/me/avatar', avatar);
        if (banner) await api.putFile('/users/me/banner', banner);
      } catch (err) {
        toast(errorMessage(err, 'Не удалось загрузить изображение — попробуйте в настройках профиля'), 'error');
      }
      const user = avatar || banner ? await api.get<SelfUser>('/users/me').catch(()=>res.user) : res.user;
      onAuthenticated(user, res.accessToken);
    } catch (err) {
      const fe = fieldErrors(err);
      if (err instanceof ApiError && err.code === 'EMAIL_TAKEN') fe.email = err.message;
      else if (err instanceof ApiError && err.code === 'USERNAME_TAKEN') fe.username = err.message;
      else if (!Object.keys(fe).length) fe.form = errorMessage(err);
      setErrors(fe);
    } finally {
      pending.current=false;
      setBusy(false);
    }
  };

  const err = (k: string) => errors[k] && <span id={`register-${k}-error`} className="field-error">{errors[k]}</span>;

  return (
    <form className="auth-card wide" onSubmit={submit}>
      <div>
        <Brand />
        <h1>Создать аккаунт</h1>
        <p className="auth-sub">Пара минут — и вы в сообществе.</p>
        <div className="auth-form">
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Имя пользователя</span>
              <input className={`input${errors.username ? ' invalid' : ''}`} value={form.username} onChange={set('username')} autoComplete="username" aria-label="Имя пользователя" aria-describedby={errors.username?'register-username-error':undefined} required minLength={2} maxLength={32} pattern="[a-zA-Z0-9_.]+" title="Латиница, цифры, «_» и «.»" />
              {err('username')}
            </label>
            <label className="field">
              <span className="field-label">Отображаемое имя</span>
              <input className="input" value={form.displayName} onChange={set('displayName')} maxLength={32} />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Email</span>
            <input className={`input${errors.email ? ' invalid' : ''}`} type="email" value={form.email} onChange={set('email')} autoComplete="email" aria-label="Email" aria-describedby={wordMode?'registration-email-note':undefined} required />
            {err('email')}
            {wordMode&&<span id="registration-email-note" className="field-hint">Контактный адрес. Для входа подойдёт и имя пользователя; регистрация не подтверждает владение почтой.</span>}
          </label>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Пароль</span>
              <input className={`input${errors.password ? ' invalid' : ''}`} type="password" value={form.password} onChange={set('password')} autoComplete="new-password" aria-label="Пароль" aria-describedby={errors.password?'register-password-error':undefined} minLength={8} maxLength={128} required />
              {err('password')}
            </label>
            <label className="field">
              <span className="field-label">Повторите пароль</span>
              <input className={`input${errors.confirm ? ' invalid' : ''}`} type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" aria-label="Повторите пароль" aria-describedby={errors.confirm?'register-confirm-error':undefined} required />
              {err('confirm')}
            </label>
          </div>
          {wordMode&&<>
            <div className="form-grid">
              <label className="field"><span className="field-label">Секретное слово</span><input className={`input${errors.recoveryWord?' invalid':''}`} type="password" autoComplete="off" value={form.recoveryWord} onChange={set('recoveryWord')} minLength={config.options?.recoveryWordMinLength??8} maxLength={config.options?.recoveryWordMaxLength??256} required/></label>
              <label className="field"><span className="field-label">Повторите секретное слово</span><input className="input" type="password" autoComplete="off" value={form.recoveryConfirm} onChange={set('recoveryConfirm')} minLength={config.options?.recoveryWordMinLength??8} maxLength={config.options?.recoveryWordMaxLength??256} required/></label>
            </div>
            {err('recoveryWord')}
            <p className="field-hint">Минимум {config.options?.recoveryWordMinLength??8} символов. Используйте слово или фразу, отличающиеся от пароля, и сохраните отдельно: они нужны для восстановления доступа. Регистр букв и лишние пробелы не учитываются.</p>
          </>}
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Аватар</span>
              <input className="input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => setAvatar(e.target.files?.[0] ?? null)} />
            </label>
            <label className="field">
              <span className="field-label">Баннер</span>
              <input className="input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => setBanner(e.target.files?.[0] ?? null)} />
            </label>
          </div>
          {err('files')}
          <div className="field">
            <span className="field-label">Цвет профиля</span>
            <div className="swatches">
              {BANNER_COLORS.map((c) => (
                <button key={c} type="button" className="swatch" style={{ background: c }} aria-pressed={c === bannerColor} aria-label={c} onClick={() => setBannerColor(c)} />
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">Тема профиля</span>
            <div className="theme-chips">
              {Object.entries(PRESET_THEMES).map(([key, t]) => (
                <button key={key} type="button" className="theme-chip" aria-pressed={preset === key} style={{ background: `linear-gradient(135deg, ${t.primary}, ${t.secondary})` }} onClick={() => setPreset(key)}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          {err('form')}
          <OptionsNotice config={config}/>
          <button className="btn btn-primary btn-block" disabled={busy||!config.options}>
            {busy ? 'Создаём…' : 'Продолжить'}
          </button>
        </div>
        <p className="auth-alt">
          Уже есть аккаунт?{' '}
          <a href="/login" onClick={(e) => (e.preventDefault(), navigate({ name: 'login' }))}>
            Войти
          </a>
        </p>
      </div>
      <div className="auth-preview">
        <span className="field-label">Предпросмотр</span>
        <ProfileCard user={preview} />
      </div>
    </form>
  );
}

function Forgot({config}:{config:AuthConfig}) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery,setRecovery]=useState({word:'',password:'',confirm:'',nextWord:'',repeat:'',totp:''});
  const pending=useRef(false),wordMode=config.options?.verificationMode==='secret-word';
  const setRecoveryField=(key:keyof typeof recovery)=>(e:ChangeEvent<HTMLInputElement>)=>setRecovery(value=>({...value,[key]:e.target.value}));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if(pending.current || !config.options)return;
    if(wordMode){
      if(recovery.password!==recovery.confirm){setError('Пароли не совпадают');return;}
      const invalid=recoveryWordError(recovery.nextWord,recovery.repeat,recovery.password,config.options.recoveryWordMinLength,config.options.recoveryWordMaxLength);
      if(invalid){setError(invalid);return;}
      if(normalizeRecoveryWord(recovery.word)===normalizeRecoveryWord(recovery.nextWord)){setError('Новое секретное слово должно отличаться от текущего');return;}
    }
    pending.current=true;setBusy(true);setError(null);
    try {
      if(wordMode){
        await api.post('/auth/recovery-word/reset',{identifier:email,recoveryWord:recovery.word,newPassword:recovery.password,newRecoveryWord:recovery.nextWord,...(recovery.totp?{totpCode:recovery.totp}:{})});
        setRecovery({word:'',password:'',confirm:'',nextWord:'',repeat:'',totp:''});
        await logout();toast('Пароль и секретное слово изменены. Войдите с новым паролем.','success');navigate({name:'login'},true);
      }else{
        await api.post('/auth/password/forgot', { email });setSent(true);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      pending.current=false;setBusy(false);
    }
  };
  return (
    <form className="auth-card" onSubmit={submit}>
      <Brand />
      <h1>Восстановление пароля</h1>
      <p className="auth-sub">{wordMode?'Введите сохранённое секретное слово и задайте новый пароль и новое секретное слово. Все прежние сеансы завершатся.':!config.options?'Загружаем способ восстановления…':sent ? 'Если такой аккаунт существует, мы отправили письмо со ссылкой. Ссылка действует 1 час.' : 'Укажите email — пришлём ссылку для сброса.'}</p>
      <OptionsNotice config={config}/>
      {!sent && config.options && (
        <div className="auth-form">
          <label className="field">
            <span className="field-label">{wordMode?'Email или имя пользователя':'Email'}</span>
            <input className="input" type={wordMode?'text':'email'} autoComplete={wordMode?'username':'email'} value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus disabled={busy}/>
          </label>
          {wordMode&&<>
            <label className="field"><span className="field-label">Секретное слово</span><input className="input" type="password" autoComplete="off" minLength={config.options.recoveryWordMinLength} maxLength={config.options.recoveryWordMaxLength} required value={recovery.word} onChange={setRecoveryField('word')} disabled={busy}/></label>
            <label className="field"><span className="field-label">Новый пароль</span><input className="input" type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={recovery.password} onChange={setRecoveryField('password')} disabled={busy}/></label>
            <label className="field"><span className="field-label">Повторите пароль</span><input className="input" type="password" autoComplete="new-password" maxLength={128} required value={recovery.confirm} onChange={setRecoveryField('confirm')} disabled={busy}/></label>
            <label className="field"><span className="field-label">Новое секретное слово</span><input className="input" type="password" autoComplete="off" minLength={config.options.recoveryWordMinLength} maxLength={config.options.recoveryWordMaxLength} required value={recovery.nextWord} onChange={setRecoveryField('nextWord')} disabled={busy}/></label>
            <label className="field"><span className="field-label">Повторите секретное слово</span><input className="input" type="password" autoComplete="off" minLength={config.options.recoveryWordMinLength} maxLength={config.options.recoveryWordMaxLength} required value={recovery.repeat} onChange={setRecoveryField('repeat')} disabled={busy}/></label>
            <p className="field-hint">Сохраните новое секретное слово отдельно от пароля. Прежнее слово больше не подойдёт. Минимум {config.options.recoveryWordMinLength} символов; регистр букв и лишние пробелы не учитываются.</p>
            <label className="field"><span className="field-label">Код 2FA, если включена</span><input className="input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={recovery.totp} onChange={e=>setRecovery(value=>({...value,totp:e.target.value.replace(/\D/g,'')}))} disabled={busy}/></label>
          </>}
          {error && <div className="field-error" role="alert">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy?'Проверяем…':wordMode?'Восстановить доступ':'Отправить ссылку'}
          </button>
        </div>
      )}
      <p className="auth-alt">
        <a href="/login" onClick={(e) => (e.preventDefault(), navigate({ name: 'login' }))}>
          ← Вернуться ко входу
        </a>
      </p>
    </form>
  );
}

function Reset({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('Пароли не совпадают');
    setBusy(true);
    try {
      await api.post('/auth/password/reset', { token, password });
      await logout();
      toast('Пароль изменён. Войдите с новым паролем.', 'success');
      navigate({ name: 'login' }, true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="auth-card" onSubmit={submit}>
      <Brand />
      <h1>Новый пароль</h1>
      <p className="auth-sub">После смены пароля все остальные сеансы будут завершены.</p>
      <div className="auth-form">
        <label className="field">
          <span className="field-label">Новый пароль</span>
          <input className="input" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field-label">Повторите пароль</span>
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {error && <div className="field-error">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy || !token}>
          Сохранить
        </button>
      </div>
    </form>
  );
}

function useObjectUrl(file:File|null):string|null {
  const [url,setUrl]=useState<string|null>(null);
  useEffect(()=>{
    const value=file?URL.createObjectURL(file):null;
    setUrl(value);
    return ()=>{if(value)URL.revokeObjectURL(value);};
  },[file]);
  return url;
}

export function VerificationPending() {
  const me=useApp(s=>s.me);
  if(!me)return null;
  if(me.verificationMode==='secret-word')return <div className="auth-card">
    <Brand/><h1>Завершите регистрацию</h1>
    <p className="auth-sub">Задайте секретное слово для восстановления доступа. Подтверждение по почте не требуется.</p>
    {me.recoveryWordAllowed?<RecoveryWordForm me={me} className="auth-form" onSaved={(user,token)=>{onAuthenticated(user,token);toast('Аккаунт готов','success');}}/>:<p className="field-hint">Для восстановления доступа администратора обратитесь к владельцу сервиса.</p>}
    <p className="auth-alt"><button type="button" className="link-btn" onClick={()=>void logout()}>Выйти и использовать другой аккаунт</button></p>
  </div>;
  return <EmailVerificationPending/>;
}

function EmailVerificationPending() {
  const me=useApp(s=>s.me);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[remaining,setRemaining]=useState(0);
  const checking=useRef(false),retryAt=useRef(0);
  const check=async(manual=false)=>{
    if(!me || checking.current)return;
    checking.current=true;
    if(manual){setBusy(true);setError('');}
    try {
      const user=await api.get<SelfUser>('/users/me');
      if(getState().me?.id!==me.id)return;
      if(user.emailVerified){
        if(await refreshSession()){
          const token=getAccessToken();
          if(token && getState().me?.id===me.id){onAuthenticated(user,token);toast('Почта подтверждена','success');}
        }
      }else if(manual)setError('Почта ещё не подтверждена. Откройте ссылку в письме.');
    }catch(err){if(manual)setError(errorMessage(err));}
    finally{checking.current=false;if(manual)setBusy(false);}
  };
  useEffect(()=>{
    let ticks=0;
    const tick=()=>{
      const seconds=Math.max(0,Math.ceil((retryAt.current-Date.now())/1000));setRemaining(seconds);
      if(!seconds && retryAt.current){retryAt.current=0;setError(e=>e.startsWith('Повторить отправку')?'':e);}
      if(++ticks%4===0 && !document.hidden)void check();
    };
    const timer=setInterval(tick,1000);
    const focus=()=>void check();window.addEventListener('focus',focus);
    return ()=>{clearInterval(timer);window.removeEventListener('focus',focus);};
  },[me?.id]);
  if(!me)return null;
  return <form className="auth-card" onSubmit={e=>{e.preventDefault();void check(true);}}>
    <Brand/><h1>Подтвердите почту</h1>
    <p className="auth-sub" style={{overflowWrap:'anywhere'}}>Для завершения регистрации откройте письмо на <strong>{me.email}</strong> и подтвердите адрес. Ссылка действует 24 часа.</p>
    <div className="auth-form">
      <button className="btn btn-primary btn-block" disabled={busy}>{busy?'Проверяем…':'Я подтвердил почту'}</button>
      {me.demoMailbox&&<>
        <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={async()=>{
          setBusy(true);setError('');
          try{
            const mail=await api.get<{verificationPath:string|null}>('/auth/email/demo');
            if(getState().me?.id!==me.id)return;
            if(!mail.verificationPath){setError('Письмо пока недоступно. Запросите новое.');return;}
            const token=new URL(mail.verificationPath,location.origin).searchParams.get('token');
            if(token)navigate({name:'verify',token});
          }catch(err){setError(errorMessage(err));}finally{setBusy(false);}
        }}>Открыть письмо в демопочте</button>
        <p className="field-hint">Локальная демоверсия: письмо доступно только в вашем аккаунте. Реальные письма наружу не отправляются.</p>
      </>}
      <button type="button" className="btn btn-secondary btn-block" disabled={busy||remaining>0} onClick={async()=>{
        setBusy(true);setError('');
        try{await api.post('/auth/email/resend');retryAt.current=Date.now()+60000;setRemaining(60);toast('Запрос принят. Проверьте почту.','success');}
        catch(err){setError(errorMessage(err));if(err instanceof ApiError && err.status===429){const wait=(err.details as {retryAfter?:number})?.retryAfter??60;retryAt.current=Date.now()+wait*1000;setRemaining(wait);}}
        finally{setBusy(false);}
      }}>{remaining>0?`Повторить через ${remaining} сек.`:'Отправить письмо повторно'}</button>
      {error&&<div className="field-error" role="alert">{error}</div>}
      <p className="field-hint">Если письма нет, проверьте папку «Спам» и правильность адреса.</p>
    </div>
    <p className="auth-alt"><button type="button" className="link-btn" onClick={()=>void logout()}>Выйти и использовать другой аккаунт</button></p>
  </form>;
}

function VerifyEmail({token}:{token:string}) {
  const [busy,setBusy]=useState(false),[done,setDone]=useState(false),[error,setError]=useState('');
  const submit=async(e:FormEvent)=>{
    e.preventDefault();if(busy||!token)return;setBusy(true);setError('');
    try{
      const res=await api.post<{userId:string}>('/auth/email/confirm',{token});
      if(getState().me?.id===res.userId && await refreshSession()){
        const user=await api.get<SelfUser>('/users/me'),access=getAccessToken();
        if(access){onAuthenticated(user,access);toast('Почта подтверждена','success');return;}
      }
      setDone(true);history.replaceState(null,'','/verify-email');
    }catch(err){setError(errorMessage(err));}finally{setBusy(false);}
  };
  return <form className="auth-card" onSubmit={submit}>
    <Brand/><h1>{done?'Почта подтверждена':'Подтверждение почты'}</h1>
    <p className="auth-sub">{done?'Теперь можно войти в аккаунт.':token?'Нажмите кнопку, чтобы завершить регистрацию.':'Откройте ссылку из письма или войдите, чтобы запросить новое письмо.'}</p>
    <div className="auth-form">
      {error&&<div className="field-error" role="alert">{error}</div>}
      {!done&&token&&<button className="btn btn-primary btn-block" disabled={busy}>{busy?'Подтверждаем…':'Подтвердить почту'}</button>}
      <button type="button" className="btn btn-secondary btn-block" onClick={()=>navigate({name:'login'},true)}>Перейти ко входу</button>
    </div>
  </form>;
}

export function AuthPage({ route }: { route: Route }) {
  const [options,setOptions]=useState<AuthOptions|null>(null),[optionsError,setOptionsError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    if(route.name!=='register' && route.name!=='forgot')return;
    let active=true;setOptions(null);setOptionsError('');
    void api.get<AuthOptions>('/auth/options').then(value=>{
      if(!['email','secret-word'].includes(value.verificationMode) || !Number.isInteger(value.recoveryWordMinLength) || !Number.isInteger(value.recoveryWordMaxLength) || value.recoveryWordMinLength<1 || value.recoveryWordMaxLength<value.recoveryWordMinLength)throw new Error('Invalid registration options');
      if(active)setOptions(value);
    }).catch(err=>{if(active)setOptionsError(errorMessage(err,'Не удалось загрузить настройки регистрации. Повторите попытку.'));});
    return ()=>{active=false;};
  },[route.name,attempt]);
  const config:AuthConfig={options,error:optionsError,retry:()=>setAttempt(value=>value+1)};
  return (
    <div className="auth-shell">
      {route.name === 'register' ? <Register config={config}/> : route.name === 'forgot' ? <Forgot config={config}/> : route.name === 'reset' ? <Reset token={route.token} /> : route.name === 'verify' ? <VerifyEmail token={route.token} /> : <Login />}
    </div>
  );
}
