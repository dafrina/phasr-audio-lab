import { useEffect, useRef, useState } from 'react';
import { engine } from '../../audio/engine';
import { sameTarget, valueAt } from '../../project/automation';
import { isPlainChain, type AutomationTarget } from '../../project/types';
import { automate, deleteLane, endAutomationGesture, setLaneEnabled, showLane, writeAutomation } from '../../state/automationActions';
import { useProjectStore } from '../../state/projectStore';
import type { NumericParamSpec } from '../../synth/params';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { isModulatable, routesFor, sourceKinds } from '../../project/modulation';
import { addModRoute, removeModRoute } from '../../state/modulationActions';
import { Knob } from './Knob';

/**
 * Live value of an automatable parameter: the lane's curve value at the
 * playhead when automated (refreshed ~30×/s), otherwise the static value.
 */
export function useAutomatedValue(trackId: string, target: AutomationTarget, staticValue: number): { value: number; automated: boolean; laneId: string | null; enabled: boolean } {
  const lane = useProjectStore((s) => s.project.tracks.find((t) => t.id === trackId)?.automation.find((l) => sameTarget(l.target, target)));
  const [live, setLive] = useState<number | null>(null);
  const active = !!lane && lane.enabled && lane.points.length > 0;
  const points = lane?.points;
  useEffect(() => {
    if (!active || !points) {
      setLive(null);
      return;
    }
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 33) return;
      last = now;
      setLive(valueAt(points, engine.transport?.getTick() ?? 0));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, points]);
  return { value: active && live !== null ? live : staticValue, automated: active, laneId: lane?.id ?? null, enabled: lane?.enabled ?? false };
}

interface AutoKnobProps {
  trackId: string;
  target: AutomationTarget;
  spec: NumericParamSpec;
  value: number;
  onChange: (v: number) => void;
  label?: string;
  size?: number;
  color?: string;
  disabled?: boolean;
  title?: string;
}

/**
 * A knob that can be automated. Right-click → Automate / Show / Disable / Delete.
 * When automated it shows the curve value; moving it writes automation at the
 * playhead (recording a sweep while playing).
 */
export function AutoKnob({ trackId, target, spec, value, onChange, label, size, color = 'var(--color-accent)', disabled, title }: AutoKnobProps) {
  const auto = useAutomatedValue(trackId, target, value);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const gesture = useRef<string>('');
  const tracks = useProjectStore((s) => s.project.tracks);
  const owner = tracks.find((t) => t.id === trackId);
  const routes = owner ? routesFor(owner, target) : [];
  const modItems: MenuItem[] = [];
  if (owner && isModulatable(owner, target)) {
    for (const src of tracks) {
      for (const kind of sourceKinds(src)) {
        // a track's own audio may only drive its volume (anything else would be a feedback loop)
        if (src.id === trackId && kind === 'audio' && !(target.kind === 'track' && target.param === 'volumeDb')) continue;
        if (routes.some((r) => r.sourceTrackId === src.id && r.source === kind)) continue;
        modItems.push({
          label: `Sidechain from ${src.name} (${kind === 'midi' ? 'MIDI notes' : 'audio'})`,
          onClick: () => void addModRoute(trackId, src.id, kind, target),
        });
      }
    }
    for (const r of routes) {
      const src = tracks.find((t) => t.id === r.sourceTrackId);
      modItems.push({ label: `Remove sidechain from ${src?.name ?? '?'} (${r.source === 'midi' ? 'MIDI' : 'audio'})`, danger: true, onClick: () => removeModRoute(trackId, r.id) });
    }
  }
  const autoItems: MenuItem[] = auto.laneId
    ? [
        { label: 'Show automation lane', onClick: () => auto.laneId && (showLane(trackId, auto.laneId), automate(trackId, target)) },
        { label: auto.enabled ? 'Disable automation' : 'Enable automation', onClick: () => auto.laneId && setLaneEnabled(trackId, auto.laneId, !auto.enabled) },
        { label: 'Delete automation', danger: true, onClick: () => auto.laneId && deleteLane(trackId, auto.laneId) },
      ]
    : [{ label: 'Automate this parameter', onClick: () => automate(trackId, target) }];
  const items = [...autoItems, ...modItems];
  return (
    <div
      className="relative"
      onContextMenu={(e) => {
        // the master's and send channels' effects aren't automated or sidechained (yet): a plain knob there
        if (disabled || isPlainChain(trackId)) return;
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onPointerDown={() => (gesture.current = `auto-${trackId}-${JSON.stringify(target)}-${Date.now()}`)}
    >
      <Knob
        spec={spec}
        value={auto.value}
        size={size}
        label={label}
        disabled={disabled}
        color={auto.automated ? '#f472b6' : color}
        title={title ?? `${label ?? spec.label}: ${spec.format(auto.value)}${auto.automated ? ' — automated (moving it writes automation at the playhead)' : ''}${routes.length ? ' — sidechain-modulated' : ''}${isPlainChain(trackId) ? '' : ' · right-click to automate or sidechain'}`}
        onChange={(v) => {
          if (auto.automated) writeAutomation(trackId, target, v, gesture.current || `auto-${trackId}`);
          else onChange(v);
        }}
        onCommitEnd={() => endAutomationGesture(gesture.current)}
      />
      {routes.length > 0 && (
        <span
          className={`pointer-events-none absolute left-0 top-0 h-1.5 w-1.5 rounded-full ${routes.some((r) => r.enabled) ? 'bg-[#22d3ee]' : 'bg-dim'}`}
          title="Sidechain-modulated"
        />
      )}
      {auto.laneId && (
        <span
          className={`pointer-events-none absolute right-0 top-0 h-1.5 w-1.5 rounded-full ${auto.enabled ? 'bg-[#f472b6]' : 'bg-dim'}`}
          title="Automated"
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}
