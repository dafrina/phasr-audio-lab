/**
 * Wires the React-side stores to the audio engine. This is the only place
 * where store changes are pushed into the engine.
 */
import { useProjectStore } from '../state/projectStore';
import { useTransportStore } from '../state/transportStore';
import { uiToast } from '../state/uiStore';
import { engine } from './engine';
import { recorder } from './recorder';

let started = false;

export function startAudioBridge(): void {
  if (started) return;
  started = true;
  engine.syncProject(useProjectStore.getState().project);
  useProjectStore.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    engine.syncProject(s.project);
    recorder.syncFromProject(s.project);
  });
  const pushStatus = () =>
    useTransportStore.setState({
      engineStatus: engine.status,
      engineError: engine.error,
      contextRunning: engine.isRunning(),
    });
  engine.onStatus(pushStatus);
  engine.onInterrupted = (reason) => uiToast('error', `${reason} Playback paused.`);
  engine
    .init()
    .then(() => {
      engine.transport?.subscribe((snap) => useTransportStore.setState({ state: snap.state, countingIn: snap.countingIn }));
      pushStatus();
    })
    .catch(() => pushStatus());

  // Browsers only allow audio to start after a user gesture.
  const unlock = () => {
    void engine.resume().then(pushStatus, pushStatus);
  };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
}
