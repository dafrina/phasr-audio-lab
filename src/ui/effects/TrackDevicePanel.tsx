import { ArrowRight, AudioLines, Footprints, Music, Plus, Power, Repeat2, Send, type LucideIcon } from 'lucide-react';
import { arpActive } from '../../arp/expand';
import { openArp, openSlipperizer, setArpEnabled, setSlipperizerEnabled } from '../tools/open';
import { SendKnobs } from '../mixer/Mixer';
import { chordToolActive, chordToolAvailable } from '../../chords/expand';
import { keyName, progressionOf, vibeById } from '../../chords/theory';
import { INSTRUMENTS } from '../../instruments/definitions';
import { INSTRUMENT_UI } from '../instruments';
import { EFFECT_BLURBS, EFFECT_LABELS, EFFECT_TYPES } from '../../audio/effects/specs';
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
            <ToolCard
              icon={Footprints}
              name="Gucci Slipper-izer"
              color="#d9b44a"
              border="#5a4a22"
              bg="#1d1a12"
              added={!!track.chords}
              on={chordToolActive(track)}
              onToggle={(v) => setSlipperizerEnabled(track.id, v)}
              offHint="keys play single notes"
              status={
                track.chords ? (
                  chordToolActive(track) ? (
                    <>
                      {vibeById(track.chords.vibe).name} · {progressionOf(track.chords).name}
                      <br />
                      {keyName(track.chords)}
                    </>
                  ) : null
                ) : (
                  'Single keys → full chords'
                )
              }
              onOpen={() => openSlipperizer(track.id)}
              addLabel="Add chords"
            />
            <ArrowRight size={14} className="mt-[68px] shrink-0 text-dim" />
          </>
        )}
        {track.kind === 'instrument' && (
          <>
            <ToolCard
              icon={Repeat2}
              name="Arp-Ape-ator"
              color="#22d3ee"
              border="#1f4a52"
              bg="#0f1c20"
              added={!!track.arp}
              on={arpActive(track)}
              onToggle={(v) => setArpEnabled(track.id, v)}
              offHint="keys and clips play as they are"
              status={track.arp ? (arpActive(track) ? track.arp.presetName : null) : 'Hold keys → patterns'}
              onOpen={() => openArp(track.id)}
              addLabel="Add ape"
            />
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
                  title={`Insert ${EFFECT_LABELS[t]} at the end of the chain${EFFECT_BLURBS[t] ? ` — ${EFFECT_BLURBS[t]}` : ''}`}
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

/** A playing tool (Slipper-izer, Arp-Ape-ator) in the chain: power switch like an effect's, status, open / add. */
function ToolCard({
  icon: Icon,
  name,
  color,
  border,
  bg,
  added,
  on,
  onToggle,
  offHint,
  status,
  onOpen,
  addLabel,
}: {
  icon: LucideIcon;
  name: string;
  color: string;
  border: string;
  bg: string;
  added: boolean;
  on: boolean;
  onToggle: (on: boolean) => void;
  /** what happens while it's off */
  offHint: string;
  /** shown while on (or before it's added) */
  status: React.ReactNode;
  onOpen: () => void;
  addLabel: string;
}) {
  return (
    <div className={`relative flex h-[150px] w-[150px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-md border p-2 text-center ${added && !on ? 'opacity-60' : ''}`} style={{ borderColor: border, background: bg }}>
      {added && (
        <button
          type="button"
          title={on ? `Bypass ${name} (${offHint})` : `Switch ${name} on`}
          aria-pressed={on}
          onClick={() => onToggle(!on)}
          className={`absolute left-1.5 top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded ${on ? 'text-black' : 'bg-panel-3 text-dim'}`}
          style={on ? { background: color } : undefined}
        >
          <Power size={12} />
        </button>
      )}
      <Icon size={20} style={{ color }} />
      <div className="text-[10px] font-semibold uppercase leading-tight tracking-[0.1em]" style={{ color }}>
        {name}
      </div>
      <div className="text-[10px] leading-tight text-muted">{added && !on ? <>Off · {offHint}</> : status}</div>
      <button type="button" onClick={onOpen} className="h-6 rounded px-2 text-[11px] font-semibold text-black" style={{ background: color }}>
        {added ? 'Open' : addLabel}
      </button>
    </div>
  );
}
