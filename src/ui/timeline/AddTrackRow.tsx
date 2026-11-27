import { AudioLines, Plus, type LucideIcon } from 'lucide-react';
import { INSTRUMENT_TYPES, INSTRUMENTS, type InstrumentType } from '../../instruments/definitions';
import { MAX_TRACKS } from '../../project/types';
import { addNewTrack } from '../actions';
import { INSTRUMENT_UI } from '../instruments';

/** How each track type is offered: accent colour and a one-line "what is it". */
const OFFER: Record<InstrumentType | 'audio', { color: string; blurb: string; order: number }> = {
  keys: { color: '#e8c37a', blurb: 'Piano, keys & synths', order: 0 },
  triosc: { color: '#a78bfa', blurb: '3-osc synth', order: 1 },
  drumrack: { color: '#fb923c', blurb: 'Pads & patterns', order: 2 },
  sampler: { color: '#38bdf8', blurb: 'Your samples', order: 3 },
  audio: { color: '#4ade80', blurb: 'Record or import audio', order: 4 },
};

function Tile({ icon: Icon, label, blurb, color, title, wide, onClick }: { icon: LucideIcon; label: string; blurb: string; color: string; title: string; wide?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      onClick={onClick}
      className={`group relative flex h-[38px] min-w-0 items-center gap-2 rounded-md border border-line bg-panel-2 px-1.5 text-left transition-colors hover:bg-panel-3 ${wide ? 'col-span-2' : ''}`}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = color)}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = '')}
    >
      <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded" style={{ background: `${color}22`, color }}>
        <Icon size={15} />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[11px] font-semibold text-fg">{label}</span>
        <span className="truncate text-[9px] text-dim group-hover:text-muted">{blurb}</span>
      </span>
      <Plus size={12} className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100" style={{ color }} />
    </button>
  );
}

/** "Add a track" panel under the last track header: one tile per track type. */
export function AddTrackRow({ count }: { count: number }) {
  if (count >= MAX_TRACKS) {
    return (
      <div className="m-1.5 rounded-md border border-dashed border-line-2 px-2 py-2 text-[10px] leading-snug text-dim">
        All {MAX_TRACKS} tracks are in use. Delete one to add another — or use a Drum Rack's or the Keyforge's presets to swap sounds on an existing track.
      </div>
    );
  }
  const types = [...INSTRUMENT_TYPES].sort((a, b) => OFFER[a].order - OFFER[b].order);
  return (
    <div className="m-1.5 flex flex-col gap-1.5 rounded-lg border border-line bg-base/40 p-1.5">
      <div className="flex items-center gap-1 px-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        <Plus size={11} /> Add a track
        <span className="ml-auto font-mono font-normal normal-case tracking-normal text-dim">
          {count} / {MAX_TRACKS}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {types.map((type) => (
          <Tile
            key={type}
            icon={INSTRUMENT_UI[type].icon}
            label={INSTRUMENTS[type].label}
            blurb={OFFER[type].blurb}
            color={OFFER[type].color}
            title={`Add a ${INSTRUMENTS[type].label} track — ${INSTRUMENTS[type].description}`}
            onClick={() => addNewTrack(type)}
          />
        ))}
        <Tile icon={AudioLines} label="Audio" blurb={OFFER.audio.blurb} color={OFFER.audio.color} title="Add an audio track (for recording and audio clips)" wide onClick={() => addNewTrack('audio')} />
      </div>
    </div>
  );
}
