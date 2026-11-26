import { ArrowRight, AudioLines, Footprints, Music, Plus, Repeat2, Send } from 'lucide-react';
import { arpActive } from '../../arp/expand';
import { openArp } from '../arp/ArpWindow';
import { SendKnobs } from '../mixer/Mixer';
import { chordToolActive, chordToolAvailable } from '../../chords/expand';
import { keyName, progressionOf, vibeById } from '../../chords/theory';
import { openSlipperizer } from '../chords/SlipperizerWindow';
import { INSTRUMENTS } from '../../instruments/definitions';
import { INSTRUMENT_UI } from '../instruments';
import { EFFECT_LABELS, EFFECT_TYPES } from '../../audio/effects/specs';
import { MAX_EFFECT_SLOTS, SEND_IDS } from '../../project/types';
import { addEffect } from '../../state/effectActions';
import { useProjectStore } from '../../state/projectStore';
import { openTrackDevices, useUiStore } from '../../state/uiStore';
import { Meter } from '../common/Meter';
import { EffectDevice } from './EffectDevice';
import { ModulationCard } from './ModulationCard';

/** Bottom-panel view of one track: its source (instrument or audio) and its insert chain. */
export function TrackDevicePanel({ trackId }: { trackId: string }) {
  const track = useProjectStore((s) => s.project.tracks.find((t) => t.id === trackId));
  const setUi = useUiStore((s) => s.set);
  if (!track) return <div className="p-4 text-muted">Track not found.</div>;
  const instDef = track.instrument ? INSTRUMENTS[track.instrument.type] : null;
  const InstIcon = track.instrument ? INSTRUMENT_UI[track.instrument.type].icon : null;
  const full = track.effects.length >= MAX_EFFECT_SLOTS;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel-2 px-2 text-[11px]">
        <span className="h-3 w-3 rounded-sm" style={{ background: track.color }} />
        {track.kind === 'audio' ? <AudioLines size={13} className="text-muted" /> : <Music size={13} className="text-muted" />}
        <span className="font-medium text-fg">{track.name}</span>
        <span className="text-dim">
          insert effects {track.effects.length}/{MAX_EFFECT_SLOTS} · signal flows left → right, then fader → pan → master
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-start gap-2 overflow-auto p-2">
        {chordToolAvailable(track) && (
          <>
            <div className="flex h-[150px] w-[150px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-md border border-[#5a4a22] bg-[#1d1a12] p-2 text-center">
              <Footprints size={20} className="text-[#d9b44a]" />
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#d9b44a]">Gucci Slipper-izer</div>
              {track.chords ? (
                <div className="text-[10px] leading-tight text-muted">
                  {chordToolActive(track) ? `${vibeById(track.chords.vibe).name} · ${progressionOf(track.chords).name}` : 'Off'}
                  <br />
                  {chordToolActive(track) && keyName(track.chords)}
                </div>
              ) : (
                <div className="text-[10px] leading-tight text-muted">Single keys → full chords</div>
              )}
              <button type="button" onClick={() => openSlipperizer(track.id)} className="h-6 rounded bg-[#d9b44a] px-2 text-[11px] font-semibold text-black">
                {track.chords ? 'Open' : 'Add chords'}
              </button>
            </div>
            <ArrowRight size={14} className="mt-[68px] shrink-0 text-dim" />
          </>
        )}
        {track.kind === 'instrument' && (
          <>
            <div className="flex h-[150px] w-[150px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-md border border-[#1f4a52] bg-[#0f1c20] p-2 text-center">
              <Repeat2 size={20} className="text-[#22d3ee]" />
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#22d3ee]">Arp / Seq</div>
              <div className="text-[10px] leading-tight text-muted">{track.arp ? (arpActive(track) ? track.arp.presetName : 'Off') : 'Hold keys → patterns'}</div>
              <button type="button" onClick={() => openArp(track.id)} className="h-6 rounded bg-[#22d3ee] px-2 text-[11px] font-semibold text-black">
                {track.arp ? 'Open' : 'Add arp'}
              </button>
            </div>
            <ArrowRight size={14} className="mt-[68px] shrink-0 text-dim" />
          </>
        )}
        <div className="flex h-[150px] w-[150px] shrink-0 flex-col items-center justify-center gap-2 rounded-md border border-line bg-panel-2 p-2 text-center">
          {track.kind === 'instrument' ? (
            <>
              {InstIcon && <InstIcon size={20} className="text-accent-hi" />}
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg">{instDef?.label}</div>
              <div className="text-[10px] text-muted">{track.instrument?.presetName}</div>
              <button type="button" onClick={() => setUi({ synthTrackId: track.id })} className="h-6 rounded bg-accent px-2 text-[11px] text-white hover:bg-accent-hi">
                Open {instDef?.label}
              </button>
            </>
          ) : (
            <>
              <AudioLines size={20} className="text-muted" />
              <div className="text-[11px] font-semibold text-fg">Audio clips</div>
              <div className="text-[10px] text-muted">{Object.values(useProjectStore.getState().project.clips).filter((c) => c.trackId === track.id).length} on this track</div>
            </>
          )}
        </div>
        {track.effects.map((slot, i) => (
          <div key={slot.id} className="flex items-center gap-2">
            <ArrowRight size={14} className="shrink-0 text-dim" />
            <EffectDevice trackId={track.id} slot={slot} index={i} count={track.effects.length} />
          </div>
        ))}
        {/* hidden once the chain is full ({MAX_EFFECT_SLOTS} effects) */}
        {!full && (
          <div className="flex items-center gap-2">
            <ArrowRight size={14} className="shrink-0 text-dim" />
            <div className="flex w-[130px] shrink-0 flex-col justify-center gap-1 rounded-md border border-dashed border-line-2 p-2">
              <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
                <Plus size={11} /> Add effect
              </div>
              {EFFECT_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  title={`Insert ${EFFECT_LABELS[t]} at the end of the chain`}
                  onClick={() => addEffect(track.id, t)}
                  className="h-6 rounded bg-panel-3 text-left text-[11px] text-fg hover:bg-line-2"
                >
                  <span className="px-2">{EFFECT_LABELS[t]}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <ArrowRight size={14} className="shrink-0 text-dim" />
          <div className="flex w-[120px] shrink-0 flex-col items-center gap-1 rounded-md border border-line bg-panel-2 p-2" title="Send part of this track (after its fader) to a shared send channel — e.g. one reverb for many tracks">
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
              <Send size={11} /> Sends
            </div>
            <SendKnobs track={track} size={32} />
            <button type="button" onClick={() => openTrackDevices(SEND_IDS[0])} className="text-[9px] text-dim hover:text-fg">
              edit send channels…
            </button>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <div className="mx-1 w-px self-stretch bg-line" />
          <ModulationCard track={track} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          <Meter source={track.id} width={10} height={120} />
        </div>
      </div>
    </div>
  );
}
