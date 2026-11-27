/**
 * Frame counters of the analyser views (tests and measurements read them via
 * window.__phasr): `frames` = animation frames a view ran (only while visible),
 * `draws` = frames it actually drew (unchanged / silent frames are skipped).
 */
export type AnalyzerView = 'spectrum' | 'spectrogram' | 'scope';

export const analyzerStats: { frames: Record<AnalyzerView, number>; draws: Record<AnalyzerView, number> } = {
  frames: { spectrum: 0, spectrogram: 0, scope: 0 },
  draws: { spectrum: 0, spectrogram: 0, scope: 0 },
};
