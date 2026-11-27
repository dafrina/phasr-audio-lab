/** The arrangement's current time selection (drag on empty lane space), readable by the shortcuts. */
let current: { start: number; end: number } | null = null;

export function setTimeSelection(sel: { start: number; end: number } | null): void {
  current = sel;
}

export function getTimeSelection(): { start: number; end: number } | null {
  return current;
}
