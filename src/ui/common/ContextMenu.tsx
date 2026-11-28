import { useEffect, useRef } from 'react';

export interface MenuItem {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** a choice in a group (shown with a check mark when true) */
  checked?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - items.length * 26 - 12);
  return (
    <div ref={ref} role="menu" style={{ left, top }} className="fixed z-[100] min-w-[180px] rounded-md border border-line-2 bg-panel-2 py-1 shadow-2xl shadow-black/60">
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={it.checked}
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onClick();
          }}
          className={`flex w-full items-center justify-between px-3 py-1 text-left text-[12px] hover:bg-accent/25 disabled:opacity-35 ${it.danger ? 'text-bad' : 'text-fg'}`}
        >
          <span>
            {it.checked !== undefined && <span className="mr-1.5 inline-block w-3 text-accent-hi">{it.checked ? '✓' : ''}</span>}
            {it.label}
          </span>
          {it.shortcut && <span className="ml-4 font-mono text-[10px] text-muted">{it.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}
