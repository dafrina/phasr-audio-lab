import { describe, expect, it } from 'vitest';
import { createAudioClip, createMidiClip, createProject, createTrack } from '../src/project/defaults';
import { useProjectStore } from '../src/state/projectStore';
import { useUiStore } from '../src/state/uiStore';
import { nudgeSelectedClips, selectAllClips } from '../src/ui/actions';

function setup() {
  const p = createProject();
  const audio2 = createTrack('audio', 2);
  p.tracks.push(audio2);
  const a = createAudioClip(p.tracks[0]!.id, 'x', 'A', 960, 1920);
  const m = createMidiClip(p.tracks[1]!.id, 480, 1920);
  p.clips[a.id] = a;
  p.clips[m.id] = m;
  useProjectStore.getState().loadProject(p);
  return { p, a, m, audio2 };
}

describe('clip editing commands', () => {
  it('select all selects every clip', () => {
    const { a, m } = setup();
    selectAllClips();
    expect(new Set(useUiStore.getState().selectedClipIds)).toEqual(new Set([a.id, m.id]));
  });

  it('nudges by ticks, never before bar 1, as one undo step per selection', () => {
    const { a, m } = setup();
    useUiStore.getState().set({ selectedClipIds: [a.id, m.id] });
    nudgeSelectedClips(-2000, 0); // clamped so the earliest clip lands on 0
    const c = useProjectStore.getState().project.clips;
    expect(c[m.id]?.start).toBe(0);
    expect(c[a.id]?.start).toBe(480);
    nudgeSelectedClips(240, 0);
    expect(useProjectStore.getState().project.clips[m.id]?.start).toBe(240);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.clips[m.id]?.start).toBe(480); // both nudges coalesced
  });

  it('moves clips between tracks only when every clip fits the target track kind', () => {
    const { a, m, audio2 } = setup();
    useUiStore.getState().set({ selectedClipIds: [a.id] });
    nudgeSelectedClips(0, 1); // audio clip onto the instrument track below → refused
    expect(useProjectStore.getState().project.clips[a.id]?.trackId).toBe(a.trackId);
    nudgeSelectedClips(0, 2); // skip down two to the second audio track
    expect(useProjectStore.getState().project.clips[a.id]?.trackId).toBe(audio2.id);
    useUiStore.getState().set({ selectedClipIds: [a.id, m.id] });
    nudgeSelectedClips(0, -1); // mixed selection can't both fit → nothing moves
    expect(useProjectStore.getState().project.clips[m.id]?.trackId).toBe(m.trackId);
  });
});
