import { X } from 'lucide-react';
import { useUiStore } from '../../state/uiStore';
import { useTransportStore } from '../../state/transportStore';

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);
  const engineError = useTransportStore((s) => s.engineError);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex max-w-sm flex-col gap-2">
      {engineError && (
        <div className="pointer-events-auto rounded-md border border-bad/60 bg-panel-2 px-3 py-2 text-[12px] text-fg shadow-xl">
          {engineError}
        </div>
      )}
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-md border bg-panel-2 px-3 py-2 text-[12px] text-fg shadow-xl ${
            t.kind === 'error' ? 'border-bad/60' : 'border-line-2'
          }`}
        >
          <span className="flex-1">{t.message}</span>
          <button type="button" onClick={() => dismiss(t.id)} className="text-muted hover:text-fg">
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
