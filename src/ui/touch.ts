/**
 * Touch input helpers. Everything here is for touch (and pen) pointers only —
 * callers branch on `isTouch(e)`, so mouse behaviour never changes.
 */

/** a finger (or pen) rather than a mouse */
export function isTouch(e: { pointerType?: string }): boolean {
  return e.pointerType === 'touch' || e.pointerType === 'pen';
}

/** how long a finger rests without moving before it's a long-press (the touch right-click) */
export const LONG_PRESS_MS = 500;
/** how far a finger may wander before a press becomes a drag */
export const TOUCH_SLOP_PX = 8;
/** hit radius for small canvas targets (points, handles, EQ nodes) under a finger */
export const TOUCH_HIT_PX = 18;

/**
 * A long-press timer: `start` on a touch press, `move` on every move (it's
 * cancelled once the finger has moved more than the slop), `cancel` on release.
 * `fired` tells the release handler the press already did its long-press thing.
 */
export class LongPress {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private x = 0;
  private y = 0;
  fired = false;

  start(x: number, y: number, onLong: () => void, ms = LONG_PRESS_MS): void {
    this.cancel();
    this.fired = false;
    this.x = x;
    this.y = y;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fired = true;
      onLong();
    }, ms);
  }

  /** false once the finger has moved too far (and the long-press is off) */
  move(x: number, y: number): boolean {
    if (this.timer && Math.hypot(x - this.x, y - this.y) > TOUCH_SLOP_PX) this.cancel();
    return this.timer !== null;
  }

  get pending(): boolean {
    return this.timer !== null;
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Two (or more) fingers on a surface: their midpoint, for panning. Feed it every
 * touch pointer's down / move / up; `count` is how many are down.
 */
export class Fingers {
  private readonly at = new Map<number, { x: number; y: number }>();

  down(e: { pointerId: number; clientX: number; clientY: number }): void {
    this.at.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  move(e: { pointerId: number; clientX: number; clientY: number }): void {
    if (this.at.has(e.pointerId)) this.at.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  up(e: { pointerId: number }): void {
    this.at.delete(e.pointerId);
  }

  get count(): number {
    return this.at.size;
  }

  has(id: number): boolean {
    return this.at.has(id);
  }

  /** the midpoint of the fingers down */
  mid(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const p of this.at.values()) {
      x += p.x;
      y += p.y;
    }
    const n = Math.max(1, this.at.size);
    return { x: x / n, y: y / n };
  }
}
