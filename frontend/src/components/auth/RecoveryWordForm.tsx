import {useRef,useState,type FormEvent} from 'react';
import {api,ApiError,errorMessage,getAccessToken,refreshSession} from '../../api/client';
import {getState,setState} from '../../state/app';
import type {SelfUser} from '../../types';
import {normalizeRecoveryWord,recoveryWordError} from '../../utils/recoveryWord';

export function RecoveryWordForm({me,className='card col',onSaved}:{me:SelfUser;className?:string;onSaved:(user:SelfUser,token:string)=>void}) {
  const [password,setPassword]=useState(''),[oldWord,setOldWord]=useState(''),[word,setWord]=useState(''),[repeat,setRepeat]=useState(''),[totp,setTotp]=useState('');
  const [busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState('');
  const pending=useRef(false);
  const current=()=>getState().me?.id===me.id;
  const submit=async(e:FormEvent)=>{
    e.preventDefault();if(pending.current)return;
    if(!saved){
      const invalid=recoveryWordError(word,repeat,password);
      if(invalid){setError(invalid);return;}
      if(me.hasRecoveryWord && normalizeRecoveryWord(oldWord)===normalizeRecoveryWord(word)){setError('Новое секретное слово должно отличаться от текущего');return;}
    }
    pending.current=true;setBusy(true);setError('');
    try{
      if(!saved){
        const body={currentPassword:password,recoveryWord:word,...(me.hasRecoveryWord?{oldRecoveryWord:oldWord}:{}),...(me.totpEnabled?{totpCode:totp}:{})};
        try{await api.post('/auth/recovery-word',body);}
        catch(err){
          if(!(err instanceof ApiError) || err.status!==401 || err.code==='SESSION_CHANGED' || !current())throw err;
          if(!await refreshSession() || !current())throw err;
          await api.post('/auth/recovery-word',body);
        }
        if(!current())return;
        // The write succeeded even if refreshing the session fails next; a reopened form must ask for the old word.
        setState(state=>state.me?.id===me.id?{me:{...state.me,hasRecoveryWord:true}}:{});
        setSaved(true);
      }
      if(!await refreshSession())throw new ApiError(401,'SESSION_EXPIRED','Секретное слово сохранено. Войдите в аккаунт ещё раз.');
      if(!current())return;
      const user=await api.get<SelfUser>('/users/me'),token=getAccessToken();
      if(!current() || !token)return;
      onSaved(user,token);setPassword('');setOldWord('');setWord('');setRepeat('');setTotp('');setSaved(false);
    }catch(err){if(current())setError(errorMessage(err));}
    finally{pending.current=false;if(current())setBusy(false);}
  };
  return <form className={className} onSubmit={submit}>
    <p className="field-hint">Сохраните секретное слово отдельно от пароля. Оно понадобится для восстановления доступа и не подтверждает владение email. Минимум 12 символов.</p>
    {!saved&&<>
      <label className="field"><span className="field-label">Текущий пароль</span><input className="input" type="password" autoComplete="current-password" maxLength={128} required value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>
      {me.hasRecoveryWord&&<label className="field"><span className="field-label">Текущее секретное слово</span><input className="input" type="password" autoComplete="off" maxLength={256} required value={oldWord} onChange={e=>setOldWord(e.target.value)} disabled={busy}/></label>}
      <label className="field"><span className="field-label">Новое секретное слово</span><input className="input" type="password" autoComplete="off" minLength={12} maxLength={256} required value={word} onChange={e=>setWord(e.target.value)} disabled={busy}/></label>
      <label className="field"><span className="field-label">Повторите секретное слово</span><input className="input" type="password" autoComplete="off" maxLength={256} required value={repeat} onChange={e=>setRepeat(e.target.value)} disabled={busy}/></label>
      {me.totpEnabled&&<label className="field"><span className="field-label">Код 2FA</span><input className="input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={totp} onChange={e=>setTotp(e.target.value.replace(/\D/g,''))} disabled={busy}/></label>}
    </>}
    {saved&&<p className="field-hint" role="status">Секретное слово сохранено. Продолжите, чтобы обновить сеанс.</p>}
    {error&&<div className="field-error" role="alert">{error}</div>}
    <button className="btn btn-primary" disabled={busy}>{busy?'Сохраняем…':saved?'Продолжить':me.hasRecoveryWord?'Изменить секретное слово':'Сохранить секретное слово'}</button>
  </form>;
}
