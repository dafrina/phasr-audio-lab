import { Component, type ErrorInfo, type ReactNode } from 'react';
import { exportArchive, saveNow } from '../../persistence/session';

interface State {
  error: Error | null;
}

/**
 * Last line of defence for UI bugs. Project state and the audio engine live
 * outside React, so even after a render crash the work can be saved/exported
 * and the UI can try to remount.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI crashed:', error, info.componentStack);
    void saveNow().catch(() => undefined);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center bg-base p-6">
        <div className="w-[520px] rounded-lg border border-bad/50 bg-panel-2 p-5 text-fg shadow-2xl">
          <div className="mb-1 text-[15px] font-semibold">Something went wrong in the interface</div>
          <div className="mb-3 text-[12px] text-muted">Your project was saved. You can export a backup, try to continue, or reload the app.</div>
          <pre className="mb-4 max-h-40 overflow-auto rounded bg-base p-2 font-mono text-[10px] text-bad">{error.message}</pre>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => void exportArchive()} className="h-7 rounded bg-panel-3 px-3 text-[12px] hover:bg-line-2">
              Export archive
            </button>
            <button type="button" onClick={() => this.setState({ error: null })} className="h-7 rounded bg-panel-3 px-3 text-[12px] hover:bg-line-2">
              Try to continue
            </button>
            <button type="button" onClick={() => location.reload()} className="h-7 rounded bg-accent px-3 text-[12px] text-white hover:bg-accent-hi">
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/** Surface otherwise-silent runtime errors as toasts (deduplicated). */
export function installGlobalErrorReporting(toast: (msg: string) => void): void {
  const recent = new Map<string, number>();
  const report = (msg: string) => {
    const now = Date.now();
    if ((recent.get(msg) ?? 0) > now - 5000) return;
    recent.set(msg, now);
    toast(msg);
  };
  window.addEventListener('error', (e) => {
    // resource loading errors and benign ResizeObserver notices aren't actionable
    if (!(e.error instanceof Error) || /ResizeObserver/.test(e.message)) return;
    report(`Unexpected error: ${e.error.message}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r: unknown = e.reason;
    report(`Unexpected error: ${r instanceof Error ? r.message : String(r)}`);
  });
}
