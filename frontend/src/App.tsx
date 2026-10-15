import { useEffect, lazy, Suspense, Component, type ReactNode } from 'react';
import { useApp } from './state/app';
import { bootstrap, needsEmailVerification } from './state/actions';
import { navigate, useRoute } from './state/router';
import { useSettings } from './state/settings';
import { AuthPage, VerificationPending } from './pages/AuthPage';
import { InvitePage } from './pages/InvitePage';
import { ContextMenuHost, Toasts } from './components/ui/Overlays';

const Shell=lazy(()=>import('./AppShell'));
function Loading(){return <div className="auth-shell"><img src="/favicon.svg" alt="" width={56} height={56} style={{animation:'pop-in 600ms infinite alternate'}}/></div>;}
class ShellBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className="auth-shell"><div className="auth-card" role="alert"><h1>Не удалось загрузить приложение</h1><p className="auth-sub">Проверьте соединение и повторите загрузку.</p><button className="btn btn-primary btn-block" onClick={()=>location.reload()}>Повторить загрузку</button></div></div>:this.props.children;}
}

function useAppearance(): void {
  const s = useSettings((x) => ({ theme: x.theme, accent: x.accent, density: x.density, fontScale: x.fontScale, reducedMotion: x.reducedMotion }));
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = s.theme;
    root.dataset.density = s.density;
    root.dataset.reducedMotion = String(s.reducedMotion);
    root.style.setProperty('--accent', s.accent);
    root.style.setProperty('--font-scale', String(s.fontScale));
  }, [s.theme, s.accent, s.density, s.fontScale, s.reducedMotion]);
}

export function App() {
  const auth = useApp((s) => s.auth);
  const me = useApp((s) => s.me);
  const route = useRoute();
  useAppearance();
  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (auth === 'guest' && !['login', 'register', 'forgot', 'reset', 'verify', 'invite'].includes(route.name)) navigate({ name: 'login' }, true);
  }, [auth, route.name]);

  let content;
  if (auth === 'loading') {
    content = <Loading />;
  } else if ((route.name === 'verify' && route.token) || route.name === 'reset') {
    content = <AuthPage route={route} />;
  } else if (auth === 'authed' && me && needsEmailVerification(me)) {
    content = <div className="auth-shell"><VerificationPending /></div>;
  } else if (route.name === 'invite') {
    content = <InvitePage code={route.code} />;
  } else if (auth === 'guest') {
    content = <AuthPage route={route} />;
  } else {
    content = <ShellBoundary><Suspense fallback={<Loading />}><Shell /></Suspense></ShellBoundary>;
  }
  return (
    <>
      {content}
      <ContextMenuHost />
      <Toasts />
    </>
  );
}
