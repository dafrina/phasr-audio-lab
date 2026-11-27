import { PPQ } from '../../core/time';

export const HEADER_W = 300;
export const TRACK_H = 78;
export const RULER_H = 28;
export const EDGE_PX = 7;
export const MIN_PX_PER_BEAT = 4;
export const MAX_PX_PER_BEAT = 480;

export function tickToX(tick: number, pxPerBeat: number, scrollX: number): number {
  return (tick / PPQ) * pxPerBeat - scrollX;
}

export function xToTick(x: number, pxPerBeat: number, scrollX: number): number {
  return ((x + scrollX) / pxPerBeat) * PPQ;
}
