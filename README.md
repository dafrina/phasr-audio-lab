# PHASR Audio Lab

Browser DAW (8 tracks) with **TriOsc**, a custom three-oscillator subtractive synth.

**Live:** https://dafrina.github.io/phasr-audio-lab/ — deployed by `.github/workflows/pages.yml` on every push to `main`
(typecheck → tests → build with `BASE_PATH=/<repo>/` → GitHub Pages).
React + TypeScript (strict) + Vite + Zustand + Tailwind; audio via Web Audio API and AudioWorklet.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest, Node)
npm run typecheck
npm run build
```

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/core` | Time math (960 PPQ ticks ↔ beats/bars/seconds/samples, BBT, quantize, note→Hz), IDs |
| `src/project` | Versioned serializable project types, defaults, non-destructive clip ops, schema migrations |
| `src/state` | `projectStore` (every edit is a command → snapshot undo/redo with gesture coalescing), `uiStore`, `transportStore` |
| `src/audio` | `AudioEngine` (one AudioContext, master bus + safety limiter), `TrackChannel` graphs, `Transport` lookahead scheduler, worker clock, asset registry + peak caches, real meters |
| `src/synth` | TriOsc: centralized param specs, presets, and pure-TS DSP (`dsp/`) shared by the AudioWorklet, offline export and tests |
| `src/ui` | Toolbar, canvas arrangement (ruler/lanes), track headers, TriOsc plugin window |

**Signal path per track:** clip sources or TriOsc worklet → input → (insert FX slot chain) → volume → pan → mute/solo gate → meter → master → limiter → output.

**Scheduling:** a Worker-driven clock wakes every 25 ms and schedules everything in the next 150 ms with
`AudioContext.currentTime` timestamps (both values configurable on `Transport`). Synth notes carry unique
note-instance IDs and are applied at their exact sample inside the worklet. Loop wraps split the window into
segments and record (time, tick) anchors for the playhead. Seeks, BPM changes and timeline edits cancel future
events, release sounding notes, and reschedule from the current position.

**TriOsc DSP:** PolyBLEP saw/square/pulse and integrated band-limited triangle in HQ mode (naive shapes in
Classic), xorshift noise, true L/R phase for stereo detune/phase offset, osc 3 → AM mode, TPT state-variable
filter (LP/HP/BP) with its own ADSR + key tracking, global LFO (pitch/cutoff/amp), 16-voice deterministic
allocation with click-free stealing, mono/legato/glide, sustain pedal, pitch bend. `process()` allocates nothing.

## Status

- **Milestone 1 (core app): done.** Transport (play/pause/stop/seek/loop/metronome, count-in API), BPM and time
  signature, snap, undo/redo, audio import (button or drag & drop), clip move/move between tracks/trim/split/
  duplicate/delete/loop/copy/paste, zoom, scrolling, loop-region and time selection, track volume/pan/mute/solo with real meters.
- **Milestone 2 (TriOsc): done.** All synth sections, 12 factory presets plus user presets (localStorage),
  mouse and computer-keyboard playing, sustain and pitch-bend wheel.
- **Milestone 3 (MIDI integration): done.** Double-click an instrument lane to create a MIDI clip (or use the context menu);
  double-click any clip to open it in the resizable bottom editor. Piano roll: click to add, drag to move, drag the right
  edge to resize, right-click (or right-drag) to delete, Ctrl/Shift-drag marquee, Alt-drag duplicate, Ctrl+A/C/X/V/D,
  arrows transpose/nudge, Q quantize (with strength), velocity lane painting, clip length/loop handle, Ctrl+wheel /
  Alt+wheel zoom, key preview. Audio clips open a waveform editor (gain, fades, loop length, normalize, fit).
  Web MIDI input (toolbar keyboard button) plays the open TriOsc or the selected instrument track.
- **Milestone 4 (multitrack mixing): done.** Up to 4 insert effects per track — EQ-3 (low shelf / peaking mid / high
  shelf), Compressor (threshold/ratio/attack/release/makeup + live gain-reduction meter), Delay (time or tempo-synced
  division, feedback with damping, equal-power mix), Reverb (generated stereo IR, decay/pre-delay/mix). Enable/bypass
  (click-free crossfade), parameter smoothing, reorder, remove, factory + user effect presets, all saved in the project.
  Mixer (F9 or toolbar): 8 channel strips + master with fader, pan, mute/solo, real meters with peak hold/clip LED, effect
  slots, master limiter toggle. Track device panel (FX button) shows the instrument and the full chain.
- **Milestone 5 (recording): done.** Arm an audio track (R in the header; one at a time), pick the input in the record
  menu (▾ next to the record button), optional input monitoring (I) through the track's effects, count-in (Off/1/2/4
  bars), sample-aligned capture in an AudioWorklet, latency compensation (browser-reported output + input latency
  plus a manual offset) applied non-destructively via the clip's source offset, live waveform while recording, takes
  stored as lossless float WAV assets. Permission denial, device unplugged mid-take and browser audio suspension are
  handled — captured audio is kept.
- **Spectra EQ:** 8-band parametric EQ (bell, low/high shelf, low/high cut at 12/24/48 dB/oct Butterworth, notch,
  band-pass) with a live spectrum analyzer and the true response curve; drag nodes for frequency/gain, wheel for Q,
  double-click to add, right-click for type/slope/automate/remove.
- **Automation:** right-click any automatable knob (all effect parameters backed by AudioParams, track volume and pan)
  → *Automate*, or use the track header's Auto… menu. Press **A** for Automation mode to draw points on the track
  (click add, drag move, right-click/double-click delete, Shift = no snap). Moving an automated knob writes automation
  at the playhead (recording a sweep while playing). Playback is sample-accurate via AudioParam ramps (frequencies
  ramp exponentially), across loop wraps and seeks.
- **Sidechain / modulation routing:** right-click a knob → *Sidechain from <track> (MIDI notes | audio)*, or a track
  header's Auto… → *Duck from …*. Audio sources use an envelope follower on the source's post-effects signal (threshold,
  attack, release); MIDI sources fire an attack/hold/release envelope on note-ons (optionally only one note — Duck from a
  Drum Rack listens to its kick pad). Depth is in the target's units (dB, semitones via filter detune, pan…), stacks on
  top of automation, runs at audio rate in an AudioWorklet, and feedback loops are refused. Routes live in the track
  devices panel's Sidechain card.
- **Instruments are a registry** (`src/instruments/definitions.ts` + `src/audio/instruments.ts` + `src/ui/instruments.tsx`):
  adding one (e.g. a piano) is three typed entries; track creation, headers, migrations and the piano roll pick it up.
- **Drum Rack:** 16 pads (MIDI 36–51; Z–V / A–F / Q–R / 1–4 keys), procedurally synthesized kits (Electro / Punchy /
  Lo-Fi; voice, tone, snap, length per pad), per-pad gain, pan, tune, decay and choke groups. Replace any pad with your
  own sample (drop a file on it, or *Sample…*), or drop/load several files to fill consecutive pads. The piano roll shows
  pad names for drum tracks.
- **Add tracks** from the *+ Add track* row under the last track (Audio / TriOsc / Drum Rack) or the lane context menu.
- **Piano roll navigation:** Space + drag (or middle-drag) pans, Shift + wheel scrolls horizontally, horizontal scrollbar.
- **Milestone 6 (persistence & export): done.** Projects autosave (~1 s after each edit) to IndexedDB; audio assets go
  to the Origin Private File System where writable, else IndexedDB. The last project reopens on load. Project menu
  (folder icon): New, Open… (browser with duplicate / export / delete), Save a copy, Export/Import `.phasr` archive
  (a ZIP with `manifest.json` + every audio file), Export WAV…. Ctrl+S saves immediately. Missing audio and unavailable
  storage are reported. WAV export renders offline (OfflineAudioContext) through the same planner, instruments,
  effects, automation, sidechains and master chain as playback; whole song or loop region, 44.1–96 kHz, 16-bit PCM
  (TPDF dither) or 32-bit float, optional release/effect tails, real progress, and the encoded file is re-parsed and
  verified (header, length, finite samples) before download.
- **Chorus / Flanger:** modulated short delay with feedback and stereo width; presets Chorus, Wide Chorus, Flanger,
  Jet Flanger, Vibrato.
- **Instrument automation:** TriOsc (amp & filter envelopes, cutoff, resonance, env amount, key tracking, LFO, glide,
  master, per-oscillator level/fine/pan/pulse width) and Drum Rack pads (gain, pan, tune, decay) — right-click a knob →
  Automate. TriOsc ramps are applied inside the synth worklet; drum pad values are sampled at each hit.
- **Keyboard/mouse:** Space always drives the transport unless you're typing or deliberately Tab-focused a control;
  the browser context menu is disabled outside text fields.

- **Milestone 7 (refinement): done.** Block-wise synth DSP (oscillators, envelope, filter rendered per 32-sample block
  with the waveform branch hoisted; bit-identical output, guarded by tests), cached static timeline layer (only the
  playhead/overlays repaint during playback), error boundary with "export archive / try to continue / reload",
  global error toasts and processor-error reporting, one-writer-per-project across tabs (Web Locks; a second tab is
  read-only with **Take over**), box-select clips (Ctrl/Shift-drag), Ctrl+A, arrow-key nudging and track moves,
  clip rename, `?` shortcut overlay, and a leak test (90 tracks with full chains created/deleted + project switches →
  channels/modulators/params back to baseline, +1.2 MB heap).

### Performance (measured: headless Chromium / Node on the dev machine — run `npm run bench`)

| Scenario | Before M7 | After M7 |
| --- | --- | --- |
| TriOsc *Soft Pad*, 16 voices (Node) | 9.8× realtime | 41× realtime |
| TriOsc *Detuned Saw*, 16 voices (Node) | 14× | 53× |
| 8 × TriOsc, 4-note chords every beat (offline, 10 s) | 4.0× | 9.2× |
| …plus 4 effects on every track (32 effects) | 1.7× | 2.5× |
| Timeline frame during playback (8 tracks × 24 clips) | 5–11 ms | 0.02–0.05 ms |

Convolution reverb is now the dominant cost of the worst case; in a realtime context Chrome runs long convolution
partitions on a background thread, and the live 8-track/32-effect test keeps pace with wall-clock time.

## Known limitations

- Audio is not time-stretched: a BPM change moves audio clips but they keep their duration.
- Notes that began before the play position are not "chased" (they don't sound mid-note on start/seek).
- Rescheduling after an edit during playback restarts in-progress audio clips at the correct offset, with a 4 ms de-click fade.
  Synth notes that are sounding at the moment of an edit are released (not re-triggered), so a held note may cut short once.
- Web MIDI input plays live only; recording incoming MIDI into clips is not implemented.
- The master limiter is a hard-knee `DynamicsCompressorNode` (safety only, not a brickwall).
- The compressor is the browser's `DynamicsCompressorNode`; its built-in automatic makeup gain is cancelled so the
  Makeup knob is literal (residual error < ~1.5 dB around the fixed 6 dB knee).
- Effects are inserts only; there are no send/return buses.
- TriOsc synth parameters and reverb decay can't be automated yet (they aren't AudioParams); automation covers effect
  parameters and track volume/pan. Automating compressor threshold/ratio doesn't update its makeup compensation.
- Recording latency compensation relies on what the browser reports; use the manual offset to fine-tune per interface.
- In the piano roll, Space starts/stops playback on key release (so it can double as the pan key). New notes default
  to 1/16; the piano roll has its own grid (default 1/16) separate from the arrangement snap.
- Audio sidechain sources tap the source track before its fader and mute (so a muted track can still drive a duck).
- Drum pads are one-shots (note length is ignored). Instrument parameters can be automated but not sidechain-modulated.
- TriOsc automation updates at the worklet's block rate (128 samples ≈ 2.7 ms).

## Keyboard

Press **?** in the app for the full list. Space play/stop · Enter stop · Ctrl+S save · Ctrl+A select all · ←→ nudge · ↑↓ move to track · Ctrl/Cmd+Z / Shift+Z undo/redo · Ctrl+C / V copy/paste clips · Ctrl+D duplicate ·
Delete remove · S split at playhead · L loop on/off · Ctrl+L loop clip content · M metronome · F9 mixer · R record · A automation mode ·
TriOsc focused: Z–M / Q–P play notes, [ ] octave, Esc close.
Piano roll focused: Delete, Ctrl+A/C/X/V/D, ↑↓ transpose (Shift = octave), ←→ nudge, Q quantize, Esc deselect. Shortcuts are ignored while typing in text fields.
