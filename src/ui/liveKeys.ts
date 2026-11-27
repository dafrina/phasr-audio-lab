/**
 * Computer-keyboard routing for instrument windows.
 *
 * While an instrument window (Keyforge, TriOsc, Sampler, Drum Rack,
 * Slipper-izer, Arp-Ape-ator) is open, its note keys play — wherever the
 * focus is (timeline, a knob, the piano roll …). The window in front (see
 * windowStack.ts: the one opened or clicked last) owns the keyboard; closing
 * it hands the keyboard to the next one.
 * Keys a window doesn't use (Space, Delete, Ctrl+Z, …) fall through to the
 * global shortcuts. Text fields and dropdowns keep their own keys.
 *
 * With no window open, the selected instrument track plays (the fallback
 * handler, see selectedTrackKeys.ts). Shift+key always goes to the shortcuts,
 * so Shift+S / Shift+R / … work while the letters play notes.
 */
import { useEffect, useRef } from 'react';
import { windowRank } from './common/windowStack';
import { isTypingTarget } from './shortcuts';

export interface LiveKeyHandler {
  /** return true if the key was used (it then doesn't reach the shortcuts) */
  keyDown(e: KeyboardEvent): boolean;
  keyUp(e: KeyboardEvent): boolean;
  /** release everything held (focus left the page, window closed) */
  release(): void;
}

/** registered handlers, oldest first; `owner` = the window (windowStack id) they belong to */
const stack: { h: LiveKeyHandler; owner?: string }[] = [];
let fallback: LiveKeyHandler | null = null;
let installed = false;

/** the frontmost window's handler (ties, and handlers without a window: the latest registered) */
const top = (): LiveKeyHandler | undefined => {
  let best: LiveKeyHandler | undefined;
  let bestRank = -2;
  for (const e of stack) {
    const r = e.owner ? windowRank(e.owner) : -1;
    if (r >= bestRank) {
      best = e.h;
      bestRank = r;
    }
  }
  return best ?? fallback ?? undefined;
};
const all = (): LiveKeyHandler[] => [...stack.map((e) => e.h), ...(fallback ? [fallback] : [])];

function onDown(e: KeyboardEvent): void {
  const h = top();
  if (!h || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (isTypingTarget(e.target)) return;
  if (h.keyDown(e)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function onUp(e: KeyboardEvent): void {
  // released keys are always delivered, so a note never hangs (even if focus moved meanwhile)
  for (const h of all()) if (h.keyUp(e)) e.stopPropagation();
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // capture phase: runs before editors' own key handlers
  window.addEventListener('keydown', onDown, true);
  window.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', () => {
    for (const h of all()) h.release();
  });
}

export function registerLiveKeys(h: LiveKeyHandler, owner?: string): () => void {
  install();
  const entry = { h, owner };
  stack.push(entry);
  return () => {
    h.release();
    const i = stack.lastIndexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** The handler used while no instrument window is open (the selected track). */
export function setFallbackLiveKeys(h: LiveKeyHandler | null): () => void {
  install();
  fallback?.release();
  fallback = h;
  return () => {
    if (fallback !== h) return;
    h?.release();
    fallback = null;
  };
}

/** Register a handler for the lifetime of the component; the latest callbacks are always used.
 * `owner`: the window (windowStack id) it belongs to, so the front window gets the keys. */
export function useLiveKeys(handler: LiveKeyHandler, owner?: string): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(
    () =>
      registerLiveKeys({
        keyDown: (e) => ref.current.keyDown(e),
        keyUp: (e) => ref.current.keyUp(e),
        release: () => ref.current.release(),
      }, owner),
    [owner],
  );
}
