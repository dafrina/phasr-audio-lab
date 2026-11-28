import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  activeClass?: string;
  children: ReactNode;
  size?: 'sm' | 'md';
}

export function IconButton({ active, activeClass = 'bg-accent text-white', className = '', children, size = 'md', ...rest }: IconButtonProps) {
  const sz = size === 'sm' ? 'h-5 min-w-5 px-1 text-[10px]' : 'h-7 min-w-7 px-1.5';
  return (
    <button
      type="button"
      {...rest}
      className={`touch-btn inline-flex items-center justify-center gap-1 rounded ${sz} transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        active ? activeClass : 'bg-panel-3 text-fg hover:bg-line-2'
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** Small letter toggle (M / S / R style). */
export function ToggleChip({
  on,
  onClick,
  label,
  onClass,
  title,
  disabled,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  onClass: string;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`touch-btn h-[18px] w-[18px] rounded-[3px] text-[10px] font-bold leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
        on ? onClass : 'bg-panel-3 text-muted hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  render,
  title,
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  render?: (v: T) => ReactNode;
  title?: (v: T) => string;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-line">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          title={title?.(o) ?? o}
          onClick={() => onChange(o)}
          className={`px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
            o === value ? 'bg-accent text-white' : 'bg-panel-3 text-muted hover:text-fg'
          }`}
        >
          {render ? render(o) : o}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, children, right, className = '' }: { title: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={`rounded-md border border-line bg-panel-2 p-2 ${className}`}>
      <div className="mb-1.5 flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}
