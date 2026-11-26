/**
 * Global keyboard shortcuts. Ignored while typing in text fields, and keys
 * claimed by an open instrument window (see liveKeys.ts) never reach this handler.
 */
import { useEffect } from 'react';
import { useProjectStore, updateProjectFields, getProject } from '../state/projectStore';
import { toggleMixer, useUiStore } from '../state/uiStore';
import { recorder } from '../audio/recorder';
import { saveNow } from '../persistence/session';
import {
  copySelectedClips,
  deleteSelection,
  duplicateSelectedClips,
  pasteClips,
  splitSelectedAtPlayhead,
  stopTransport,
  toggleLoopSelectedClips,
  togglePlay,
  selectAllClips,
  nudgeSelectedClips,
  gridTicks,
} from './actions';
import { PPQ } from '../core/time';

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) {
    const nonText = ['range', 'checkbox', 'radio', 'button', 'color', 'file'];
    return !nonText.includes(t.type);
  }
  return false;
}

/** Editors (piano roll) that handle their own Delete/copy/paste/arrow keys. */
function inOwnShortcutScope(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && t.closest('[data-own-shortcuts]') !== null;
}

/** Controls a mouse click leaves focused, where Space would otherwise re-activate them. */
function isClickableControl(t: EventTarget | null): boolean {
  if (t instanceof HTMLButtonElement || t instanceof HTMLSelectElement) return true;
  return t instanceof HTMLInputElement && ['range', 'checkbox', 'radio', 'button', 'color', 'file'].includes(t.type);
}

export function useGlobalShortcuts(): void {
  // Space is the transport key. A button or dropdown that merely kept focus after
  // a mouse click must not swallow it; only controls reached with Tab keep Space.
  useEffect(() => {
    let keyboardFocus = false;
    const onPointer = () => (keyboardFocus = false);
    const onTab = (e: KeyboardEvent) => {
      if (e.key === 'Tab') keyboardFocus = true;
    };
    const onSpace = (e: KeyboardEvent) => {
      if (e.key !== ' ' || !isClickableControl(e.target) || keyboardFocus) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).blur();
      if (!e.repeat) togglePlay();
    };
    // dropdowns give focus back once a value is chosen
    const onChange = (e: Event) => {
      if (e.target instanceof HTMLSelectElement && !keyboardFocus) e.target.blur();
    };
    // no browser context menu except where it's useful (text fields); the app's own menus still open
    const onContext = (e: MouseEvent) => {
      if (!isTypingTarget(e.target)) e.preventDefault();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onTab, true);
    window.addEventListener('keydown', onSpace, true);
    window.addEventListener('change', onChange, true);
    window.addEventListener('contextmenu', onContext);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onTab, true);
      window.removeEventListener('keydown', onSpace, true);
      window.removeEventListener('change', onChange, true);
      window.removeEventListener('contextmenu', onContext);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Inside an editor, only transport and undo/redo stay global.
      if (inOwnShortcutScope(e.target) && !(key === ' ' || key === 'enter' || (mod && (key === 'z' || key === 'y')))) return;
      if (e.repeat && (key === ' ' || key === 'r')) return;
      // sliders keep their own arrow keys
      if (key.startsWith('arrow') && e.target instanceof HTMLInputElement && e.target.type === 'range') return;
      if (key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (key === 'enter' && !mod) {
        stopTransport();
      } else if (mod && key === 's') {
        e.preventDefault();
        void saveNow();
      } else if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) useProjectStore.getState().redo();
        else useProjectStore.getState().undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        useProjectStore.getState().redo();
      } else if (mod && key === 'a') {
        e.preventDefault();
        selectAllClips();
      } else if (!mod && (key === 'arrowleft' || key === 'arrowright')) {
        e.preventDefault();
        const g = gridTicks() || PPQ / 4;
        nudgeSelectedClips((key === 'arrowright' ? 1 : -1) * (e.altKey ? 1 : g), 0);
      } else if (!mod && (key === 'arrowup' || key === 'arrowdown')) {
        e.preventDefault();
        nudgeSelectedClips(0, key === 'arrowdown' ? 1 : -1);
      } else if (e.key === '?') {
        useUiStore.getState().set({ helpOpen: !useUiStore.getState().helpOpen });
      } else if (mod && key === 'c') {
        copySelectedClips();
      } else if (mod && key === 'v') {
        e.preventDefault();
        pasteClips();
      } else if (mod && key === 'd') {
        e.preventDefault();
        duplicateSelectedClips();
      } else if (mod && key === 'l') {
        e.preventDefault();
        toggleLoopSelectedClips();
      } else if (key === 'delete' || key === 'backspace') {
        e.preventDefault();
        deleteSelection();
      } else if (key === 's' && !mod) {
        splitSelectedAtPlayhead();
      } else if (key === 'l' && !mod) {
        const p = getProject();
        updateProjectFields('Toggle loop', { loop: { ...p.loop, enabled: !p.loop.enabled } });
      } else if (key === 'm' && !mod) {
        const p = getProject();
        updateProjectFields('Toggle metronome', { metronome: !p.metronome });
      } else if (key === 'a' && !mod) {
        const ui = useUiStore.getState();
        ui.set({ automationMode: !ui.automationMode });
      } else if (e.key === 'F9') {
        e.preventDefault();
        toggleMixer();
      }
      if (key === 'r' && !mod && !e.repeat) void recorder.toggleRecord();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
