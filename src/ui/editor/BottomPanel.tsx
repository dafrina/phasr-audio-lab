import { useEffect, useRef } from 'react';
import { AudioLines, Music, SlidersHorizontal, SlidersVertical, X } from 'lucide-react';
import { useProjectStore } from '../../state/projectStore';
import { useUiStore, type BottomPanel as PanelKind } from '../../state/uiStore';
import { TrackDevicePanel } from '../effects/TrackDevicePanel';
import { MasterDevicePanel } from '../effects/MasterDevicePanel';
import { EFFECT_LABELS } from '../../audio/effects/specs';
import { MASTER_ID, SEND_IDS, isBusId, sendLabel } from '../../project/types';
import { Mixer } from '../mixer/Mixer';
import { AudioClipEditor } from './AudioClipEditor';
import { PianoRoll } from './PianoRoll';

const MIN_H = 180;

/**
 * Resizable bottom panel with three views: the clip editor (piano roll /
 * audio editor), the mixer, and the selected track's devices (instrument + effects).
 */
export function BottomPanel() {
  const mode = useUiStore((s) => s.bottomPanel);
  const clipId = useUiStore((s) => s.editorClipId);
  const fxTrackId = useUiStore((s) => s.fxTrackId);
  const selectedTrackId = useUiStore((s) => s.selectedTrackId);
  const height = useUiStore((s) => s.bottomHeight);
  const set = useUiStore((s) => s.set);
  const clip = useProjectStore((s) => (clipId ? s.project.clips[clipId] : undefined));
  const trackId = fxTrackId ?? selectedTrackId;
  const track = useProjectStore((s) => s.project.tracks.find((t) => t.id === trackId));
  const drag = useRef<{ y: number; h: number } | null>(null);

  // close views whose subject disappeared (deleted, undone)
  useEffect(() => {
    if (clipId && !clip) set({ editorClipId: null, ...(mode === 'editor' ? { bottomPanel: 'none' as const } : {}) });
  }, [clipId, clip, mode, set]);
  const isMaster = isBusId(trackId);
  const sendBus = useProjectStore((s) => s.project.sends[(SEND_IDS as readonly string[]).indexOf(trackId ?? '')]);
  useEffect(() => {
    if (mode === 'track' && !track && !isMaster) set({ bottomPanel: 'none', fxTrackId: null });
  }, [mode, track, isMaster, set]);

  if (mode === 'none' || (mode === 'editor' && !clip)) return null;
  const maxH = Math.max(MIN_H, window.innerHeight - 220);
  const minH = mode === 'mixer' ? 400 : MIN_H;
  const h = Math.min(Math.max(height, minH), maxH);

  const Tab = ({ kind, label, icon, disabled }: { kind: PanelKind; label: string; icon: React.ReactNode; disabled?: boolean }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => set({ bottomPanel: kind, ...(kind === 'track' && track ? { fxTrackId: track.id } : {}) })}
      className={`flex h-6 max-w-[220px] items-center gap-1 truncate rounded-t px-2 text-[11px] disabled:opacity-30 ${
        mode === kind ? 'bg-panel text-fg' : 'text-muted hover:text-fg'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <div style={{ height: h }} className="relative flex shrink-0 flex-col border-t border-line-2 bg-panel">
      <div
        className="absolute -top-1 left-0 right-0 z-10 h-2 cursor-ns-resize"
        title="Drag to resize"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, h };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) set({ bottomHeight: Math.min(maxH, Math.max(MIN_H, d.h + d.y - e.clientY)) });
        }}
        onPointerUp={() => (drag.current = null)}
      />
      <div className="flex h-7 shrink-0 items-end gap-0.5 border-b border-line bg-panel-2 px-1">
        <Tab
          kind="editor"
          disabled={!clip}
          label={clip ? clip.name : 'Clip editor'}
          icon={clip?.kind === 'audio' ? <AudioLines size={12} /> : <Music size={12} />}
        />
        <Tab kind="mixer" label="Mixer" icon={<SlidersVertical size={12} />} />
        <Tab kind="track" disabled={!track && !isMaster} label={sendBus ? `Send ${sendLabel(sendBus, (t) => EFFECT_LABELS[t], true)}` : trackId === MASTER_ID ? 'Master devices' : track ? `${track.name} devices` : 'Track devices'} icon={<SlidersHorizontal size={12} />} />
        <button
          type="button"
          title="Close panel"
          onClick={() => set({ bottomPanel: 'none' })}
          className="mb-0.5 ml-auto flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-fg"
        >
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {mode === 'editor' && clip && clipId && (clip.kind === 'midi' ? <PianoRoll clipId={clipId} /> : <AudioClipEditor clipId={clipId} />)}
        {mode === 'mixer' && <Mixer />}
        {mode === 'track' && isMaster && trackId && <MasterDevicePanel busId={trackId} />}
        {mode === 'track' && !isMaster && track && <TrackDevicePanel trackId={track.id} />}
      </div>
    </div>
  );
}
