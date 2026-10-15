import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LuX } from 'react-icons/lu';

interface Props {
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}

/** Accessible modal: Escape closes, focus moves inside and returns on close, click outside closes. */
export function Modal({ title, subtitle, onClose, children, footer, width, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not(.modal-close)');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Nested dialogs own focus and Escape; the underlying dialog stays open.
      if ([...document.querySelectorAll('.overlay .modal')].at(-1) !== ref.current) return;
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        close.current();
      } else if (e.key === 'Tab') {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter((el) => el.getClientRects().length > 0);
        const first = items[0], last = items.at(-1);
        if (!first) { e.preventDefault(); ref.current?.focus(); }
        else if (e.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={`modal ${className ?? ''}`} style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog" aria-modal="true">
        {(title || subtitle) && (
          <div className="modal-head">
            <div className="grow">
              {title && <h2>{title}</h2>}
              {subtitle && <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.875rem' }}>{subtitle}</p>}
            </div>
            <button className="icon-btn modal-close" onClick={onClose} aria-label="Закрыть">
              <LuX />
            </button>
          </div>
        )}
        <div className="modal-body scroll">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
