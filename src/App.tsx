import { useEffect } from 'react';
import { startAudioBridge } from './audio/bridge';
import { useTransportStore } from './state/transportStore';
import { useUiStore } from './state/uiStore';
import { Toasts } from './ui/common/Toasts';
import { useGlobalShortcuts } from './ui/shortcuts';
import { Arrangement } from './ui/timeline/Arrangement';
import { Toolbar } from './ui/toolbar/Toolbar';
import { InstrumentEditor } from './ui/instruments';
import { initPersistence } from './persistence/session';
import { BusyOverlay } from './ui/project/ProjectUI';
import { ShortcutHelp } from './ui/common/ShortcutHelp';
import { BottomPanel } from './ui/editor/BottomPanel';
import { SlipperizerWindow } from './ui/chords/SlipperizerWindow';

function AudioUnlockBanner() {
  const status = useTransportStore((s) => s.engineStatus);
  const running = useTransportStore((s) => s.contextRunning);
  if (status !== 'ready' || running) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-14 z-50 -translate-x-1/2 rounded-full border border-accent/50 bg-panel-2/95 px-3 py-1 text-[11px] text-fg shadow-lg">
      Click anywhere to enable audio
    </div>
  );
}

export default function App() {
  useGlobalShortcuts();
  useEffect(() => {
    startAudioBridge();
    void initPersistence();
  }, []);
  const synthTrackId = useUiStore((s) => s.synthTrackId);
  const chordsTrackId = useUiStore((s) => s.chordsTrackId);
  return (
    <div className="relative flex h-full flex-col">
      <Toolbar />
      <AudioUnlockBanner />
      <Arrangement />
      <BottomPanel />
      {synthTrackId && <InstrumentEditor trackId={synthTrackId} />}
      {chordsTrackId && <SlipperizerWindow trackId={chordsTrackId} />}
      <Toasts />
      <BusyOverlay />
      <ShortcutHelp />
    </div>
  );
}
