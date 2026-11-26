import { AudioLines, Plus } from 'lucide-react';
import { INSTRUMENT_TYPES, INSTRUMENTS } from '../../instruments/definitions';
import { MAX_TRACKS } from '../../project/types';
import { addNewTrack } from '../actions';
import { INSTRUMENT_UI } from '../instruments';

/** "+ Add track" row shown under the last track header (one button per track type). */
export function AddTrackRow({ count }: { count: number }) {
  if (count >= MAX_TRACKS) {
    return <div className="px-3 py-2 text-[10px] text-dim">Track limit reached ({MAX_TRACKS}).</div>;
  }
  return (
    <div className="m-1.5 flex flex-col gap-1 rounded-md border border-dashed border-line-2 p-1.5">
      <div className="flex items-center gap-1 px-0.5 text-[10px] uppercase tracking-wider text-muted">
        <Plus size={11} /> Add track
      </div>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          title="Add an audio track (for recording and audio clips)"
          onClick={() => addNewTrack('audio')}
          className="flex h-6 items-center gap-1 rounded bg-panel-3 px-2 text-[11px] text-fg hover:bg-line-2"
        >
          <AudioLines size={12} /> Audio
        </button>
        {INSTRUMENT_TYPES.map((type) => {
          const Icon = INSTRUMENT_UI[type].icon;
          return (
            <button
              key={type}
              type="button"
              title={`Add a ${INSTRUMENTS[type].label} track — ${INSTRUMENTS[type].description}`}
              onClick={() => addNewTrack(type)}
              className="flex h-6 items-center gap-1 rounded bg-panel-3 px-2 text-[11px] text-fg hover:bg-line-2"
            >
              <Icon size={12} /> {INSTRUMENTS[type].label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
