import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { LuPhone, LuPhoneOff, LuVideo } from 'react-icons/lu';
import { useApp } from '../../state/app';
import { dismissCall, gateway } from '../../state/actions';
import { navigate } from '../../state/router';
import { voice } from '../../webrtc/voiceEngine';
import { startRingtone, stopRingtone } from '../../utils/notify';
import { Avatar } from '../ui/Avatar';

export function IncomingCall() {
  const call = useApp((s) => s.incomingCalls[0]);
  useEffect(() => {
    if (!call) return;
    startRingtone();
    return stopRingtone;
  }, [call?.channelId]);
  if (!call) return null;
  const name = call.caller.displayName || call.caller.username;
  const accept = async (video: boolean) => {
    dismissCall(call.channelId,call.id);
    navigate({ name: 'dm', channelId: call.channelId });
    if(!await voice.join(call.channelId)){
      gateway.send('call:decline',{channelId:call.channelId,ringId:call.id});return;
    }
    gateway.send('call:accept', { channelId: call.channelId,ringId:call.id });
    if (video) await voice.setCamera(true);
  };
  return createPortal(
    <div className="incoming-call" role="alertdialog" aria-label={`Входящий звонок от ${name}`}>
      <Avatar user={call.caller} size={72} />
      <div>
        <h3>{name}</h3>
        <p className="muted" style={{ margin: '4px 0 0' }}>{call.video ? 'Входящий видеозвонок…' : 'Входящий звонок…'}</p>
      </div>
      <div className="row" style={{ width: '100%' }}>
        <button
          className="btn btn-danger"
          onClick={() => {
            dismissCall(call.channelId,call.id);
            gateway.send('call:decline', { channelId: call.channelId,ringId:call.id });
          }}
        >
          <LuPhoneOff /> Отклонить
        </button>
        <button className="btn btn-success" onClick={() => void accept(false)}>
          <LuPhone /> Ответить
        </button>
        {call.video && (
          <button className="btn btn-success" onClick={() => void accept(true)} aria-label="Ответить с видео">
            <LuVideo />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
