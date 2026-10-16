import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Attachment } from '../../types';

/** The same full-size image viewer is shared by the channel and its reply thread. */
export function ImageLightbox({ image, onClose }: { image: Attachment; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null), close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopImmediatePropagation();
        close.current();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        ref.current?.querySelector('a')?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); previous?.focus(); };
  }, []);
  return createPortal(
    <div ref={ref} tabIndex={-1} className="lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label={image.filename}>
      <div style={{ textAlign: 'center' }} onClick={event => event.stopPropagation()}>
        <img src={image.url} alt={image.filename} />
        <a href={image.url} target="_blank" rel="noopener noreferrer">Открыть оригинал</a>
      </div>
    </div>, document.body,
  );
}
