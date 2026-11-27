# PHASR Audio Lab

Browser DAW (12 tracks) with **TriOsc** (three-oscillator subtractive synth), **Keyforge** (modelled piano, electric
piano, tonewheel organ, analog and 808 engines), a **Drum Rack** and a **Sampler**; two playing tools — the **Gucci
Slipper-izer** (one key → a chord) and the **Arp-Ape-ator** (arpeggiator / step sequencer); insert effects on every
track, on two send channels and on the master.

**Live:** https://dafrina.github.io/phasr-audio-lab/ — deployed by `.github/workflows/pages.yml` on every push to `main`
(typecheck, unit + perf tests and the Playwright browser tests in parallel → build with `BASE_PATH=/<repo>/` → GitHub
Pages; pull requests run the same checks without deploying).
React + TypeScript (strict) + Vite + Zustand + Tailwind; audio via Web Audio API and AudioWorklet.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest, Node)
npm run test:e2e   # browser tests (Playwright + Chromium, e2e/): renders, effects, recording, cleanup
npm run test:perf  # audio-thread allocation budgets
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
| `src/keys` | Keyforge: per-engine param specs, presets and DSP engines (`dsp/`: piano, epiano, organ, analog, sub808, KeysSynth/KeysCore) |
| `src/drums`, `src/sampler` | Drum Rack kits + procedural drum synthesis; Sampler zone mapping (pure) |
| `src/chords`, `src/arp` | Slipper-izer chord theory and Arp-Ape-ator patterns (pure), applied to clips at playback / export / bake |
| `src/midi` | Standard MIDI File import and export |
| `src/persistence` | IndexedDB / OPFS storage, autosave, `.phasr` archives |
| `src/ui` | Toolbar, canvas arrangement (ruler/lanes), track headers, piano roll, mixer, instrument and tool windows |

**Signal path:** per track, clip sources or the instrument → input → insert effects → volume → pan → mute/solo gate →
meter → master; post-fader send taps feed send channels A and B (each: effects → fader → mute → meter → master).
Master: input → master effects → fader → limiter → output.

**Scheduling:** a Worker-driven clock wakes every 25 ms and schedules everything in the next 150 ms with
`AudioContext.currentTime` timestamps (both values configurable on `Transport`). Synth notes carry unique
note-instance IDs and are applied at their exact sample inside the worklet. Loop wraps split the window into
segments and record (time, tick) anchors for the playhead. Seeks, BPM changes and timeline edits cancel future
events, release sounding notes, and reschedule from the current position.

**TriOsc DSP:** PolyBLEP saw/square/pulse and integrated band-limited triangle in HQ mode (naive shapes in
Classic), xorshift noise, true L/R phase for stereo detune/phase offset, osc 3 → AM mode, TPT state-variable
filter (LP/HP/BP) with its own ADSR + key tracking, global LFO (pitch/cutoff/amp), 16-voice deterministic
allocation with click-free stealing (a stolen voice fades out first; measured in `tests/clicks.test.ts`),
mono/legato/glide, sustain pedal, pitch bend. `process()` creates no buffers or objects of its own, but V8 still
boxes some floating-point values at calls it doesn't inline: ≈ 3 kB of short-lived garbage per 128-frame block
(see *Allocation on the audio thread* under Performance).

## Status

- **Milestone 1 (core app): done.** Transport (play/pause/stop/seek/loop/metronome, count-in API), BPM and time
  signature, snap, undo/redo, audio import (button or drag & drop), clip move/move between tracks/trim/split/
  duplicate/delete/loop/copy/paste, zoom, scrolling, loop-region and time selection, track volume/pan/mute/solo with real meters.
- **Milestone 2 (TriOsc): done.** All synth sections, 12 factory presets plus user presets (localStorage),
  mouse and computer-keyboard playing, sustain and pitch-bend wheel.
- **Milestone 3 (MIDI integration): done.** Double-click an instrument lane to create a MIDI clip (or use the context menu);
  double-click any clip to open it in the resizable bottom editor. Piano roll: click (or press and hold ~150 ms) to add a
  note, a quick drag of more than 10 px on empty space selects, drag a note to move, drag the right
  edge to resize, right-click (or right-drag) to delete, Ctrl/Shift-drag marquee, Alt-drag duplicate, Ctrl+A/C/X/V/D,
  arrows transpose/nudge, Shift+Q quantize (with strength), velocity lane painting, clip length/loop handle, Ctrl+wheel /
  Alt+wheel zoom, key preview. Audio clips open a waveform editor (gain, fades, loop length, normalize, fit).
  Web MIDI input (toolbar keyboard button) plays the armed instrument track, else the open instrument window's track,
  else the selected instrument track.
- **Milestone 4 (multitrack mixing): done.** Up to 4 insert effects per track — EQ-3 (low shelf / peaking mid / high
  shelf), Spectra EQ (below), Compressor (threshold/ratio/attack/release/makeup + live gain-reduction meter), Delay (time
  or tempo-synced division, feedback with damping, equal-power mix), **Reverb Pro** (convolution with a generated stereo
  room impulse shaped by decay, size, damping and early reflections, plus pre-delay, low / high cut and width on the
  tail, and a room view drawn from that impulse: floor plan with the early-reflection paths, the impulse's spectrogram
  with the cut bands, decay curve and −60 dB point), **Reverb Lite** (algorithmic room — diffusers into
  an 8-line feedback delay network — with decay, size, tone, pre-delay and mix; ≈ 0.8 % of a core at any decay against
  Pro's 4–10 %, sleeps when silent, and its decay can be automated and sidechained, e.g. a kick choking the tail),
  Chorus / Flanger, Auto-Filter (low/high/band-pass with an LFO), Phaser (swept all-pass stages with feedback and
  stereo spread), **Saturator** (saturation → distortion → fuzz: a 4× oversampled waveshaper with Tape, Tube, Crunch,
  Clip, Fuzz, Rectify and Fold characters; drive and bias (even harmonics on any character); *Clean <* keeps the lows
  below a frequency undistorted (Linkwitz-Riley split, flat when summed); *Focus / Emph* boosts a band before the drive
  and cuts it back after, so the distortion concentrates there; an optional Lo-Fi stage (bit depth, sample rate);
  tone, output, and a parallel mix whose dry path is delayed to match the oversampler; adaptive auto gain that
  measures the dry and saturated levels and matches them — within 2 dB from 0 to 36 dB of drive on synths, piano and
  drums; the display shows the transfer curve and the odd / even harmonics it adds; stages that are off aren't wired
  in) and **Utility** (gain, balance, width from mono to 150 %, polarity per channel — for gain staging anywhere). Enable/bypass (click-free crossfade, measured for every effect in `e2e/clicks.e2e.ts`; a switched-off effect does no work), parameter smoothing, reorder,
  remove, factory + user effect presets, all saved in the project.
  Mixer (F9 or toolbar): a channel strip per track (up to 12) with fader, pan, mute/solo, send A/B knobs, real meters
  with peak hold/clip LED and effect slots; strips for the two send channels; the master with its own 4 effect slots and
  the limiter toggle. Track device panel (FX button) shows the instrument, the tools, the sends and the full chain.
- **Send channels A and B:** shared effect chains (e.g. one reverb, one delay) with up to 4 effects each, fed by every
  track's post-fader send knobs; Drum Rack pads have their own sends.
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
  → *Automate*, or use the track header's Auto… menu. Press **Shift+A** for Automation mode to draw points on the track
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
  Lo-Fi / House / Techno / Hip-Hop / Trap; voice, tone, snap, length per pad), a style per pad (Classic, House, Techno,
  Hip-Hop, Trap, Lo-Fi), per-pad gain, pan, tune, decay and choke groups, a Spectra EQ and send A/B per pad, and
  *Split to track* (moves a pad's notes onto a track of its own). Replace any pad with your own sample (drop a file on it,
  or *Sample…*), or drop/load several files to fill consecutive pads. **Pattern** tab: a 16-step grid per pad that edits
  the track's clip directly (click a hit, Shift-click accent/ghost, right-click rolls). The piano roll shows pad names
  for drum tracks.
- **Keyforge** (multi-engine keyboard instrument, 49 presets; every knob automatable):
  - *Piano* — modal string model: up to 96 partials per note following the stiff-string inharmonicity law
    (B rising into the treble) with Railsback stretch tuning; velocity-dependent hammer spectrum and contact time,
    strike-position notch; two/three coupled string resonators per low partial for beating and the prompt/aftersound
    double decay; frequency-dependent losses (high partials die first, bass rings ~20 s, treble ~1 s); dampers that
    are slower in the bass, undamped top keys, key-off noise; restrikes hit the vibrating string; soundboard body
    modes + hammer knock, 12 sympathetic "strings" that bloom with the sustain pedal, lid filter, pitch-based stereo.
    Tension modulation (hard strikes start a few cents sharp), per-strike variation and a recording-room ambience.
    A short, bright hammer *hit* on the upper partials (Hit knob), phantom partials (Metal), a dense soundboard
    resonator (Body), key-action knock (Thump), the felt hammer's low thud (Impact), treble trichord shimmer. Every key
    has its own fixed personality (ring, decay, detune, tuning) and chord notes land a few ms apart with softer hammers
    (Chord feel), so chords sound like separate strings. Held high notes fade into the room.
    Presets: Concert Grand, Felt Piano, Bright Upright.
  - *Electric Piano* — tine (fundamental + clamped-free beam bell modes 6.27×/17.55×) and detuned tonebar, through an
    asymmetric magnetic pickup (time derivative of flux) so hard hits bark; damper, stereo tremolo, preamp drive.
    Presets: Classic Tine EP, Suitcase EP, Soft Ballad EP.
  - *Tonewheel Organ* — 91 free-running tempered tonewheels shared by all keys (phase locked like the real thing),
    nine 3 dB-step drawbars with foldback, staggered-contact key click, single-triggered 2nd/3rd percussion, chorus
    scanner, overdrive, rotary speaker (800 Hz crossover, horn/drum inertia, Doppler, AM, cabinet reflection).
    Presets: Jazz Tonewheel, Rock Organ, Gospel Full.
  - *Analog* — up to 7 detuned stereo saws + sub + noise, drive, 4-pole resonant low-pass with envelope / key /
    velocity, filter motion LFO, pitch envelope, mono legato glide, ensemble, built-in tempo-synced ping-pong delay and
    large FDN reverb. 27 presets: pads (Warm Pad, Glass Pad, Solina Strings…), leads and stabs (Techno Stab, Supersaw
    Lead, Rave Hoover…) and basses (Acid Line, Reese Bass, Moog Bass, Rolling Techno Bass, Deep House Bass…).
  - *808* — the classic sub: a sine with a pitch-drop knock, click, long decay and saturation; monophonic with true 808
    glide. 11 presets (Trap 808, Long Boom, Distorted 808, Slide 808, Techno Sub, Kick-Bass…).
  - The organ also has 90s House Organ and Organ Sub Bass.
  - Realism is checked by measurement tests (`tests/keys.test.ts`): partial frequencies vs. the inharmonicity formula,
    A4 = 440 Hz, bass vs. treble T60, partial decay order, double decay, unison beating, velocity → brightness,
    dampers / undamped treble / pedal, EP bark and bell decay, tremolo rate, drawbar levels, phase-locked wheels,
    single-trigger percussion, key click, rotor speeds, filter sweeps, glide, sample-accurate starts, automation.
- **MIDI files:** drop a `.mid` file into the piano roll (its notes land where you drop it), onto an instrument track
  (a new clip there) or onto empty timeline space (one new track per MIDI track; drums become a Drum Rack). Export the
  song (project menu), a clip (its context menu) or the open clip (piano roll's .mid button) as a Standard MIDI File (Slipper-izer and Arp-Ape-ator tracks export what you hear).
- **Computer keyboard:** Z–M / Q–P play the instrument window in front (click a window to bring it forward) or, with none
  open, the selected instrument track. Song commands are always Shift+letter, editing is Ctrl/Cmd+letter.
- **MIDI recording:** arm an instrument track (R) and record: Web MIDI, the computer keys and the on-screen keyboard
  play the armed track and are written into a new clip ("Keys 3 take 1"). Notes land on the timeline position you were
  hearing (input timestamps are mapped through the context's output timestamp, so output latency is compensated),
  count-in notes snap to the start, the sustain pedal extends note lengths, loop passes merge, the take is drawn live,
  and one undo removes it. Web MIDI input always goes to the armed instrument track.
- **Gucci Slipper-izer** (chord tool for any synth track — footprints button in the track header or the device panel):
  play single keys, hear full chords. Pick a vibe (90s Deep House, Jazzy, Neo-Soul, Lo-fi Chill, Emotional Techno,
  Pop Anthem, Gospel), a progression and a key; white keys C D E F play the progression's four chords, G A B three
  extras, black keys spicier versions (m11, maj9♯11, 7alt…), and the octave moves the chord. Voicings gravitate to a
  fixed centre (smooth voice leading, no hidden state), optional bass, close/wide, strum. **Auto-play**: hold one key
  and the progression plays in rhythm (hold, stabs, house offbeat, groove, arp; ½/1/2 bars per chord), locked to the
  song tempo. Clips store the single keys you play (recording included) and are expanded at playback/export; the piano
  roll names the chord on every key and note; **Bake to notes** writes the chords into the clips (undoable).
- **Arp-Ape-ator** (arpeggiator / step sequencer for any instrument track — track devices panel): hold keys and they
  play up / down / up-down / random / as-played arpeggios over 1–4 octaves, or a 16-step line (velocity, accent, slide,
  tie, roll, chance, and a melody lane you draw pitches into, with scale snapping) transposed by the key you hold.
  Locked to the song grid, latch, swing and gate. **Step rec** fills the sequencer one key per step (Rest / Tie / Back /
  Clear); in arp mode **Rec** records the held keys into a clip. Clips keep the held keys and play back through the arp;
  **Bake to notes** writes the result. Every note lights its step / key in the note's colour, and a gorilla on the
  window drums along.
- **Sampler** (bring your own samples; nothing is shipped): drop or pick one or more audio files and each becomes a
  zone. Root notes are read from file names (`Piano_C4.wav`, `Bass A#1`, `pad-060`) or found by pitch detection (YIN).
  *Auto* mapping splits keys halfway between roots and stretches the outer zones to the ends of the keyboard, so every
  key plays (pitched from the nearest sample); samples sharing a root become velocity layers ordered by loudness.
  *Manual* mapping keeps your key/velocity ranges, and uncovered keys borrow the nearest zone. Attack, release,
  velocity, transpose, volume (automatable), one-shot mode, sustain pedal, pitch bend; key map with velocity axis.
- **Add tracks** from the *+ Add track* row under the last track (Audio / TriOsc / Drum Rack / Keyforge / Sampler) or the lane context menu.
- **Piano roll navigation:** Space + drag (or middle-drag) pans, Shift + wheel scrolls horizontally, horizontal scrollbar.
- **Milestone 6 (persistence & export): done.** Projects autosave (~1 s after each edit) to IndexedDB; audio assets go
  to the Origin Private File System where writable, else IndexedDB. The last project reopens on load. Project menu
  (folder icon): New, Open… (browser with duplicate / export / delete), Save a copy, Export/Import `.phasr` archive
  (a ZIP with `manifest.json` + every audio file), Export WAV…. Ctrl+S saves immediately. Missing audio and unavailable
  storage are reported. WAV export renders offline (OfflineAudioContext) through the same planner, instruments,
  effects, automation, sidechains and master chain as playback; whole song or loop region, 44.1–96 kHz, 16-bit PCM
  (TPDF dither) or 32-bit float, optional release/effect tails, real progress, and the encoded file is re-parsed and
  verified (header, length, finite samples) before download.
- **MP3 export** (same dialog, *Format → MP3*): 128/192/256/320 kbps CBR at 44.1 or 48 kHz with an ID3 title tag.
  Encoding runs in a Web Worker (a 3-minute song ≈ 5 s at 320 kbps) and the file is verified before download: every
  MPEG frame header is parsed, the length is checked, and the browser decodes it back.
- **Chorus / Flanger:** modulated short delay with feedback and stereo width; presets Chorus, Wide Chorus, Flanger,
  Jet Flanger, Vibrato.
- **Instrument automation:** TriOsc (amp & filter envelopes, cutoff, resonance, env amount, key tracking, LFO, glide,
  master, per-oscillator level/fine/pan/pulse width), every Keyforge parameter (incl. drawbars and rotor speed) and
  Drum Rack pads (gain, pan, tune, decay) — right-click a knob → Automate. Synth ramps are applied inside the worklet;
  drum pad values are sampled at each hit.
- **Keyboard/mouse:** Space always drives the transport unless you're typing or deliberately Tab-focused a control;
  the browser context menu is disabled outside text fields.

- **Milestone 7 (refinement): done.** Block-wise synth DSP (oscillators, envelope, filter rendered per 32-sample block
  with the waveform branch hoisted; bit-identical output, guarded by tests), cached static timeline layer (only the
  playhead/overlays repaint during playback), error boundary with "export archive / try to continue / reload",
  global error toasts and processor-error reporting, one-writer-per-project across tabs (Web Locks; a second tab is
  read-only with **Take over**), box-select clips (Ctrl/Shift-drag), Ctrl+A, arrow-key nudging and track moves,
  clip rename, `?` shortcut overlay, and a leak test (90 tracks with full chains created/deleted + project switches →
  channels/modulators/params back to baseline, +1.2 MB heap).

### Performance

**How these numbers are measured.** Machine: Intel Core Ultra 7 265H laptop (16 threads, 32 GB), Linux under
WSL2. Node 24 (V8 13.6) for the DSP benchmarks (`npm run bench`: the DSP cores alone, 48 kHz, 128-frame blocks, after a
JIT warm-up, median of 5 runs with the range printed); headless Chromium (Chrome for Testing 156) for offline renders,
effect costs and main-thread time. "× realtime" is audio seconds rendered per wall-clock second on one thread
(above 1× keeps up). **Compare numbers only within one session:** on this laptop the same code measures up to ~25 %
apart between sessions (power and thermal state). Before/after columns were measured back to back; e.g. re-running
the Keyforge bench on 27 Nov 2026 gave Concert Grand 22.7× (table: 28.2×) — and the commit the table was made from
(1ae92b6) measured 22.5× in the same session, so that gap is the machine, not a regression.


| Scenario | Before M7 | After M7 |
| --- | --- | --- |
| TriOsc *Soft Pad*, 16 voices (Node) | 9.8× realtime | 41× realtime |
| TriOsc *Detuned Saw*, 16 voices (Node) | 14× | 53× |
| 8 × TriOsc, 4-note chords every beat (offline, 10 s) | 4.0× | 9.2× |
| …plus 4 effects on every track (32 effects) | 1.7× | 2.5× |
| Timeline frame during playback (8 tracks × 24 clips) | 5–11 ms | 0.02–0.05 ms |

Track and effect limits (offline render of a busy song in headless Chromium, all tracks playing 4-note chords or
drums on every beat; half the tracks Keyforge, 4 effects each, × realtime on one thread):

| Tracks × 4 effects | reverb on every track | reverb on 1 in 4 |
| --- | --- | --- |
| 8 | 1.75× | 2.69× |
| 12 (the limit) | 1.09× | 1.74× |
| 16 | 0.79× | 1.23× |

Realtime playback does better than these numbers (Chrome runs long convolution partitions on a background thread).
Spectra EQ only connects the filter stages its enabled bands use (it used to run all 32: 4 Spectra EQs on 8 tracks went
from 1.25× to 8.2×), switched-off effects stop processing, and a Keyforge that has been silent for 0.2 s (below
−120 dB, no echo pending) sleeps until its next note.

Convolution reverb is now the dominant cost of the worst case; in a realtime context Chrome runs long convolution
partitions on a background thread, and the live 8-track/32-effect test keeps pace with wall-clock time.

**Effects** (offline render in headless Chromium, CPU per instance per audio second, 48 kHz): Spectra EQ 0.07 %,
Utility 0.16 %, EQ-3 / Delay 0.22 %, Compressor 0.25 %, Auto-Filter 0.29 %, Chorus 0.32 %, Phaser 0.35 %, Saturator
1.1–1.5 % (4× oversampling; 2.5 % with split, emphasis, bias and Lo-Fi all on), Reverb Lite 0.80 % (any
decay), Reverb Pro 3.9 % at 2.2 s and 9.4 % at 6 s of decay. Idle (8 silent instrument tracks, live context):
4.5 % of the audio thread with no effects, 25.6 % with a Reverb Pro on each, 5.6 % with a Reverb Lite on each.

**Keyforge engines** (`npm run bench`, Node, one track, × realtime; the output is bit-identical before and after):

| Preset (load) | Before | After |
| --- | --- | --- |
| Concert Grand (6-note chord every 0.5 s) | 20.7× | 28.2× |
| Felt Piano (same) | 26.7× | 34.8× |
| Warm Pad (6-note chord every 1 s) | 18.7× | 18.8× |
| Supersaw Lead / Classic Tine EP / Jazz Tonewheel / Trap 808 | | 26× / 118× / 55× / 412× |

The piano's strike glide and pitch bend only re-rotate the resonators instead of recomputing every partial's decay,
and the 8-line room reverb's Hadamard mix is unrolled.

**Allocation on the audio thread** (`npm run test:perf`, V8's sampling heap profiler over 4000 blocks with chords past
the polyphony limit, sustain and bends; budgets = measured + 50 %, so an added allocation fails the test). The phaser,
Lo-Fi, saturator auto gain and modulation-source cores allocate nothing. The others create no buffers or objects of
their own, but V8 boxes floating-point values passed to or returned from functions it doesn't inline (Reverb Lite:
exactly the two samples per frame handed to the feedback-delay network, 32 B per sample) and `for…of` over voices
allocates iterators. Per 128-frame block: TriOsc ≈ 3.1 kB, Reverb Lite 4.2 kB, Keyforge 808 2.1 kB, Tine EP 4.7 kB,
analog 12.7 kB, organ 38 kB, piano 93 kB (≈ 35 MB/s while the piano plays). The young-generation GC reclaims this
cheaply; whether it ever causes a dropout hasn't been measured, but it is garbage on the audio thread; passing samples through
fields or whole blocks instead of per-sample calls would remove most of it.

**App** (headless Chromium, 8 instrument tracks playing; main-thread busy time):

| Scenario | Before | After |
| --- | --- | --- |
| Idle | 6.9 % | 2.7 % |
| Playing, timeline | 16.2 % | 15.3 % |
| Playing + Arp-Ape-ator (sequencer) | 29.9 % | 17.8 % |
| Playing + Arp-Ape-ator (arp, gorilla drumming) | 30.2 % | 23.9 % |
| Playing + Drum Rack pattern grid | 17.2 % | 15.4 % |
| Startup JavaScript (gzip) | 296 kB | 200 kB |

Step playheads move a single overlay instead of re-rendering their window, meters skip frames that would look the
same, the ruler is cached like the lanes, the instrument / tool windows load on demand (prefetched when idle), and
the MP3 encoder is no longer part of the startup bundle.

## Browser support

- **Tested:** Chromium only (the Playwright suite runs Chrome for Testing on Linux; the app is developed in Chrome).
- **Required:** Web Audio with AudioWorklet, IndexedDB, ES2022. Recording needs `getUserMedia` in a secure context
  (https or localhost). MIDI input needs Web MIDI (Chrome, Edge, Firefox; not Safari) — without it the computer
  keyboard and on-screen keys still work.
- **Optional, with fallbacks:** Web Locks (one writer per project across tabs; without it every tab is a writer),
  `AudioContext.getOutputTimestamp` (MIDI recording timing; falls back to the reported output latency).
- **Not tested:** Firefox and Safari. Everything required exists there, but timing, latency reporting and
  `DynamicsCompressorNode` / convolution behaviour differ between engines and haven't been checked.

## Storage

Projects and audio live in the browser's IndexedDB for this site (and a few preferences in `localStorage`); nothing
is uploaded. Things that can lose work:

- **Eviction.** The app asks for persistent storage (`navigator.storage.persist()`) at startup, but browsers decide
  silently (Chrome by site engagement, Firefox may ask, Safari doesn't grant it), and without it the browser may
  clear the data under disk pressure; Safari can also delete a site's storage after 7 days of use without visiting it. Clearing
  site data, private windows and some privacy extensions remove it too.
- **Quota.** Recordings are stored as float WAV (≈ 23 MB per stereo minute at 48 kHz). When storage is full, saving
  fails with an error toast and the project stays open; the project browser shows usage against the quota.
- **Protection:** export a `.phasr` archive (project + every audio file) for anything you want to keep, and to move
  projects between browsers or machines.

## Testing

| Command | What | Where |
| --- | --- | --- |
| `npm test` | unit + integration tests (Vitest, Node): DSP, scheduling, persistence, golden project | CI |
| `npm run test:perf` | allocation budgets of the audio-thread DSP (pass/fail) | CI |
| `npm run test:e2e` | browser tests (Playwright, Chromium): golden-project renders vs baseline, every effect preset, click-free switching, recording with a fake microphone, cleanup / leaks, audio-node behaviour (clip fades from any start / stop, fader after removing a lane, pad sends vs. fader automation and ducking, drum chokes and Decay, sampler panic), solo vs. mute, and UI workflows driven by mouse and keyboard (add track, piano roll editing, effects, automation lanes, save/reload, WAV export, undo/redo, window stacking, keyboard rules, full storage, two tabs) | CI |
| `npm run bench` | speed benchmarks (× realtime, median of 5) | manual — CI runners are too noisy for timing |

`npm run test:e2e:update` rewrites the golden render baseline (`e2e/golden-baseline.json`) after an intended sound
change. Locally, `PLAYWRIGHT_CHROMIUM_PATH` can point at an installed Chromium instead of Playwright's download.

## Known limitations

- Drum Rack pads sit on consecutive notes from 36: kick / rim / snare / clap (36–39) match General MIDI, the rest
  don't (hats are 41 / 43, GM has 42 / 46). A drum MIDI file exported to (or imported from) other software plays
  those pads as other drums.
- Audio is not time-stretched: after a BPM change audio clips keep their position and length in beats, while
  their audio plays at its own speed — a faster tempo cuts a clip's audio shorter, a slower one leaves silence
  after the audio ends (trim or extend the clip, or loop it, to match).
- Notes that began before the play position are not "chased" (they don't sound mid-note on start/seek).
- Rescheduling after an edit during playback restarts in-progress audio clips at the correct offset, with a 4 ms de-click fade.
  Synth notes that are sounding at the moment of an edit are released (not re-triggered), so a held note may cut short once.
- MIDI recording bakes the sustain pedal into note lengths (there are no CC lanes) and doesn't record pitch bend.
  With the loop on, passes are merged into one clip.
- The master limiter is a hard-knee `DynamicsCompressorNode` (safety only, not a brickwall).
- The compressor is the browser's `DynamicsCompressorNode`; its built-in automatic makeup gain is cancelled so the
  Makeup knob is literal (residual error < ~1.5 dB around the fixed 6 dB knee).
- Master and send-channel effects can't be automated or sidechained yet.
- Reverb Pro's decay can't be automated or sidechained (changing it regenerates the impulse response); Reverb Lite's
  can. Automating
  compressor threshold/ratio doesn't update its makeup compensation.
- Recording latency compensation relies on what the browser reports; use the manual offset to fine-tune per interface.
- In the piano roll, Space starts/stops playback on key release (so it can double as the pan key). New notes default
  to 1/16; the piano roll has its own grid (default 1/16) separate from the arrangement snap.
- Audio sidechain sources tap the source track before its fader and mute (so a muted track can still drive a duck).
- Drum pads are one-shots (note length is ignored). Instrument parameters can be automated but not sidechain-modulated.
- TriOsc / Keyforge automation updates at the worklet's block rate (128 samples ≈ 2.7 ms).
- Keyforge is fully synthesized (no samples), so it trades the last bit of sampled-piano realism for tiny size,
  continuous velocity response and real interaction between notes (restrikes, pedal resonance).

## Keyboard

Press **?** in the app for the full list. One rule: **letters play notes, Shift + letter runs a song command,
Ctrl/Cmd + letter edits.**

- Song commands: Shift+S split at playhead · Shift+R record · Shift+L loop the time selection (or loop on/off) ·
  Shift+M metronome · Shift+A automation mode · Shift+Q quantize (piano roll).
- Editing: Ctrl+S save · Ctrl/Cmd+Z / Shift+Z undo/redo · Ctrl+A select all · Ctrl+C / V copy/paste · Ctrl+D duplicate ·
  Ctrl+L loop clip content.
- Everywhere: Space play/stop · Enter stop · Delete remove · ←→ nudge · ↑↓ move to track (piano roll: transpose, Shift =
  octave) · F9 mixer · ? help · Esc closes a window / deselects.
- Notes: Z–M / Q–P play the instrument window in front (or the selected instrument track), [ ] octave. Shortcuts are
  ignored while typing in text fields.

## Third-party code

MP3 encoding uses [@breezystack/lamejs](https://github.com/shijinyu/lamejs) (a JavaScript port of LAME), licensed under the
LGPL-3.0; it is loaded as a separate chunk only when exporting MP3.
