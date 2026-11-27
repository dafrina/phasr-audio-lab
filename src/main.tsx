import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { ErrorBoundary, installGlobalErrorReporting } from './ui/common/ErrorBoundary';
import { uiToast } from './state/uiStore';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
installGlobalErrorReporting((msg) => uiToast('error', msg));
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Dev-only handle for automated browser checks (stripped from production builds).
if (import.meta.env.DEV) {
  void Promise.all([
    import('./audio/engine'),
    import('./state/projectStore'),
    import('./state/uiStore'),
    import('./audio/effects/units'),
    import('./audio/effects/specs'),
    import('./audio/trackChannel'),
    import('./audio/trioscNode'),
    import('./audio/worklets/triosc.worklet.ts?worker&url'),
    import('./synth/presets'),
    import('./audio/recorder'),
    import('./state/recordingStore'),
    import('./audio/exportRender'),
    import('./persistence/session'),
    import('./ui/analyzer/stats'),
  ]).then(([e, p, u, fx, fxs, tc, tn, wl, pr, rec, recs, ex, ses, an]) => {
    (window as unknown as Record<string, unknown>).__phasr = {
      engine: e.engine,
      projectStore: p.useProjectStore,
      uiStore: u.useUiStore,
      createEffectUnit: fx.createEffectUnit,
      createEffectSlot: fxs.createEffectSlot,
      TrackChannel: tc.TrackChannel,
      TriOscInstrument: tn.TriOscInstrument,
      trioscWorkletUrl: wl.default,
      presets: pr.FACTORY_PRESETS,
      recorder: rec.recorder,
      recordingStore: recs.useRecordingStore,
      renderProjectToWav: ex.renderProjectToWav,
      session: ses,
      analyzerStats: an.analyzerStats,
    };
  });
}
