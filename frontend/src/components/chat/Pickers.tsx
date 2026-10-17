import { useEffect, useRef, useState, type RefObject } from 'react';
import { api, errorMessage } from '../../api/client';
import { EMOJI, searchEmoji } from '../../utils/emoji';
import type { Gif } from '../../types';
import { useApp } from '../../state/app';
import { settingsStore } from '../../state/settings';
import { useClampedPosition } from '../ui/Overlays';

const locale = (): string => (settingsStore.get().language === 'en' ? 'en_US' : 'ru_RU');
const TRENDING=Symbol('trending');

interface GifPage {
  items: Gif[];
  next: string | null;
}
interface GifCategory {
  name: string;
  query: string;
  previewUrl: string | null;
}

export type PickerTab = 'emoji' | 'gif';

/** Closes when clicking outside or pressing Escape. */
function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest('[data-picker-toggle]')) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [ref, onClose]);
}

export function EmojiGrid({ onPick }: { onPick: (e: string) => void }) {
  const [q, setQ] = useState('');
  const results = searchEmoji(q);
  return (
    <>
      <div className="picker-search">
        <input className="input" placeholder="Найти эмодзи" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="picker-body scroll">
        {q ? (
          <div className="emoji-grid">
            {results.map((e) => (
              <button key={e} onClick={() => onPick(e)} aria-label={e}>
                {e}
              </button>
            ))}
            {results.length === 0 && <p className="muted">Ничего не найдено</p>}
          </div>
        ) : (
          EMOJI.map((cat) => (
            <div key={cat.id}>
              <div className="emoji-cat">{cat.label}</div>
              <div className="emoji-grid">
                {cat.emoji.map(([e, k]) => (
                  <button key={e} onClick={() => onPick(e)} title={k.split(' ')[0]} aria-label={k}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function GifPanel({ onPick }: { onPick: (g: Gif) => void }) {
  const enabled = useApp((s) => s.features.gif);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const [cats, setCats] = useState<GifCategory[]>([]);
  const [items, setItems] = useState<Gif[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestGeneration=useRef(0);
  const loadingRef=useRef(false);

  useEffect(()=>()=>{++requestGeneration.current;loadingRef.current=false;},[]);

  useEffect(() => {
    if (!enabled) return;
    api.get<GifCategory[]>(`/gifs/categories?locale=${locale()}`).then(setCats, (e) => setError(errorMessage(e)));
  }, [enabled]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim() || null), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = async (search: string | null | typeof TRENDING, pos: string | null) => {
    if(pos&&loadingRef.current)return;
    const generation=pos?requestGeneration.current:++requestGeneration.current;
    loadingRef.current=true;
    setLoading(true);
    try {
      const page = await api.get<GifPage>(
        search === TRENDING ? `/gifs/trending?locale=${locale()}${pos ? `&pos=${encodeURIComponent(pos)}` : ''}` : `/gifs/search?locale=${locale()}&q=${encodeURIComponent(search ?? '')}${pos ? `&pos=${encodeURIComponent(pos)}` : ''}`,
      );
      if(generation!==requestGeneration.current)return;
      setItems((cur) => pos?[...new Map([...cur,...page.items].map(g=>[g.id,g])).values()]:page.items);
      setNext(page.next);
      setError(null);
    } catch (e) {
      if(generation===requestGeneration.current)setError(errorMessage(e));
    } finally {
      if(generation===requestGeneration.current){loadingRef.current=false;setLoading(false);}
    }
  };

  useEffect(() => {
    if (query) void load(query, null);
    else {
      ++requestGeneration.current;loadingRef.current=false;
      setItems([]);setNext(null);setError(null);setLoading(false);
    }
  }, [query]);

  if (!enabled) {
    return <div className="empty">GIF не настроены на сервере: администратору нужно задать GIF_API_KEY (Tenor или GIPHY).</div>;
  }

  const showingCategories = !query && items.length === 0;
  return (
    <>
      <div className="picker-search">
        <input className="input" placeholder="Поиск GIF" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div
        className="picker-body scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (next && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - 300) void load(query ?? TRENDING, next);
        }}
      >
        {error && <p className="field-error">{error}</p>}
        {showingCategories ? (
          <div className="gif-cats">
            <button className="gif-cat" style={{ background: 'linear-gradient(135deg, var(--accent), #ec4899)' }} onClick={() => void load(TRENDING, null)}>
              <span>🔥 Популярные</span>
            </button>
            {cats.map((c) => (
              <button key={c.name} className="gif-cat" style={c.previewUrl ? { backgroundImage: `url(${c.previewUrl})` } : undefined} onClick={() => setQ(c.query)}>
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="gif-grid">
            {items.map((g) => (
              <button key={g.id} onClick={() => onPick(g)} title={g.title}>
                <img src={g.previewUrl} alt={g.title} loading="lazy" />
              </button>
            ))}
          </div>
        )}
        {loading && <div className="skeleton" style={{ height: 80, marginTop: 6 }} />}
      </div>
    </>
  );
}

export function ComposerPicker({ tab, setTab, onEmoji, onGif, onClose }: { tab: PickerTab; setTab: (t: PickerTab) => void; onEmoji: (e: string) => void; onGif: (g: Gif) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  return (
    <div className="picker" ref={ref} role="dialog" aria-label={tab === 'gif' ? 'GIF' : 'Эмодзи'}>
      <div className="picker-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'gif'} onClick={() => setTab('gif')}>
          GIF
        </button>
        <button role="tab" aria-selected={tab === 'emoji'} onClick={() => setTab('emoji')}>
          Эмодзи
        </button>
      </div>
      {tab === 'gif' ? <GifPanel onPick={onGif} /> : <EmojiGrid onPick={onEmoji} />}
    </div>
  );
}

/** Small floating emoji picker for reactions. */
export function ReactionPicker({ x, y, onPick, onClose }: { x: number; y: number; onPick: (e: string) => void; onClose: () => void }) {
  const { ref, pos } = useClampedPosition(x, y);
  useDismiss(ref, onClose);
  return (
    <div className="picker" ref={ref} style={{ position: 'fixed', ...pos, right: 'auto', bottom: 'auto', width: 'min(360px, calc(100vw - 16px))' }}>
      <EmojiGrid
        onPick={(e) => {
          onPick(e);
          onClose();
        }}
      />
    </div>
  );
}
