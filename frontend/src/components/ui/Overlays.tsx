import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { uiStore, useUi } from '../../state/ui';

/** Keeps a floating element inside the viewport. */
export function useClampedPosition(x: number, y: number, deps: unknown[] = []) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      const viewport = window.visualViewport;
      const offsetX = viewport?.offsetLeft ?? 0;
      const offsetY = viewport?.offsetTop ?? 0;
      const left = Math.max(offsetX + 8, Math.min(x, offsetX + (viewport?.width ?? window.innerWidth) - r.width - 8));
      const top = Math.max(offsetY + 8, Math.min(y, offsetY + (viewport?.height ?? window.innerHeight) - r.height - 8));
      setPos((prev) => prev.left === left && prev.top === top ? prev : {left, top});
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, ...deps]);
  return { ref, pos };
}

export function ContextMenuHost() {
  const menu = useUi((s) => s.contextMenu);
  const close = () => uiStore.set({ contextMenu: null });
  const { ref, pos } = useClampedPosition(menu?.x ?? 0, menu?.y ?? 0, [menu]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu, ref]);
  if (!menu) return null;
  return createPortal(
    <div className="menu" ref={ref} style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((item, i) =>
        item.divider ? (
          <div key={i} className="menu-divider" />
        ) : item.render ? (
          <div key={i} className="menu-custom">
            {item.render()}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item${item.danger ? ' danger' : ''}`}
            onClick={() => {
              close();
              item.onSelect?.();
            }}
          >
            {item.label}
            {item.icon}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="toast-dot" />
          {t.text}
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** Hover tooltip anchored above (or to the right of) its child. */
export function Tooltip({ text, children, side = 'top' }: { text: ReactNode; children: ReactNode; side?: 'top' | 'right' | 'bottom' }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!rect || !tipRef.current) return;
    const t = tipRef.current.getBoundingClientRect();
    let left = side === 'right' ? rect.right + 10 : rect.left + rect.width / 2 - t.width / 2;
    let top = side === 'right' ? rect.top + rect.height / 2 - t.height / 2 : side === 'bottom' ? rect.bottom + 8 : rect.top - t.height - 8;
    left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
    top = Math.max(8, top);
    setPos({ left, top });
  }, [rect, side]);
  return (
    <span
      style={{ display: 'contents' }}
      onMouseOver={(e) => {
        const el = (e.currentTarget.firstElementChild as HTMLElement | null) ?? (e.target as HTMLElement);
        setRect(el.getBoundingClientRect());
      }}
      onMouseLeave={() => {
        setRect(null);
        setPos(null);
      }}
      onFocus={(e) => setRect((e.target as HTMLElement).getBoundingClientRect())}
      onBlur={() => setRect(null)}
    >
      {children}
      {rect &&
        createPortal(
          <div ref={tipRef} className="tooltip" style={pos ?? { left: -9999, top: -9999 }} role="tooltip">
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
}
