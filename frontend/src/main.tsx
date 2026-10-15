import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/auth.css';
import './styles/chat.css';
import './styles/voice.css';
import './styles/profile.css';
import './styles/settings.css';
import './styles/responsive.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
