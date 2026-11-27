/**
 * With no instrument window open, the computer keyboard plays the selected
 * instrument track (timeline, mixer, piano roll …): Z–M / Q–P are notes
 * ([ ] octave), drum racks use their pad keys. Shift+letter still reaches the
 * shortcuts (Shift+S split, Shift+R record, Shift+L loop, …).
 */
import { useEffect } from 'react';
import { engine } from '../audio/engine';
import { getProject } from '../state/projectStore';
import { uiToast, useUiStore } from '../state/uiStore';
import { padNote } from '../drums/kit';
import { setFallbackLiveKeys } from './liveKeys';
import { KEY_MAP } from './synth/KeyboardStrip';
import { KEY_PADS } from './drums/padKeys';

function selectedInstrument(): { trackId: string; drums: boolean } | null {
  const id = useUiStore.getState().selectedTrackId;
  const track = id ? getProject().tracks.find((t) => t.id === id) : undefined;
  if (!track?.instrument) return null;
  return { trackId: track.id, drums: track.instrument.type === 'drumrack' };
}

export function useSelectedTrackKeys(): void {
  useEffect(() => {
    let octave = 4;
    const held = new Map<string, { trackId: string; id: number }>();
    return setFallbackLiveKeys({
      keyDown(e) {
        const sel = selectedInstrument();
        if (!sel) return false;
        if (!sel.drums && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
          octave = Math.min(8, Math.max(0, octave + (e.code === 'BracketRight' ? 1 : -1)));
          uiToast('info', `Computer keyboard: C${octave}`);
          return true;
        }
        let note: number | undefined;
        if (sel.drums) {
          const pad = KEY_PADS[e.code];
          if (pad !== undefined) note = padNote(pad);
        } else {
          const off = KEY_MAP[e.code];
          if (off !== undefined) note = (octave + 1) * 12 + off;
        }
        if (note === undefined) return false;
        if (e.repeat || held.has(e.code) || note > 127) return true;
        const id = engine.previewNoteOn(sel.trackId, note, sel.drums ? 0.85 : 0.8);
        if (id !== null) held.set(e.code, { trackId: sel.trackId, id });
        return true;
      },
      keyUp(e) {
        const h = held.get(e.code);
        if (!h) return false;
        engine.previewNoteOff(h.trackId, h.id);
        held.delete(e.code);
        return true;
      },
      release() {
        for (const h of held.values()) engine.previewNoteOff(h.trackId, h.id);
        held.clear();
      },
    });
  }, []);
}
