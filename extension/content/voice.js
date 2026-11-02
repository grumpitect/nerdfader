// Runs in the page's own JavaScript world (MAIN) just before content/main.js, which takes what this defines and
// removes it from the page again. Kept apart from main.js so the tests can run it on its own (tests/voice.test.js):
// - outputStage(): what routed sound goes through on its way to the speakers: the tab's level, voice fix, and a soft
//   clipper.
// - shapeJudge(): tells whether left and right differ (to mix them to mono, or to play only the one that arrives
//   first, when the other is its sound later) and whether the low end is heavy.
// - humDetector(): tells whether what is playing has mains hum at 50 or 60 Hz.
// - stableVolumeCounter(): undoes most of YouTube's Stable Volume, for when the player won't turn it off (main.js).
//
// Voice fix is for badly recorded talks: the voice in one ear, mains hum, a boomy low end. It listens first and fixes
// only what it finds (shapeJudge() and humDetector()), so a talk that is already fine passes as it is:
// - left and right differ (two mics, or the voice in one ear): mixed to mono, at a gain that keeps it as loud as it
//   was, with less boom: everything below 80 Hz cut and 200 Hz turned down 4 dB (also when the low end is heavy).
//   When one channel is the other's sound arriving later (a second mic far back in the room, which hears mostly the
//   room), only the earlier one plays, in both ears: mixed, every word would play twice (delayFinder());
// - mains hum: narrow notches remove it: the 3rd harmonic, and every odd
// harmonic from 500 to 6000 Hz (for 60 Hz: 180, 540, 660 ... 5940 Hz). The 5th and 7th (250 to 450 Hz) are left
// alone: they sit in the body of the voice. Up to 2000 Hz the notches have a Q of 30; above that they are 20 Hz wide,
// so the many notches up there take little of the voice (about 1 dB of 2 to 6 kHz). Mains hum is rarely exactly 50
// or 60 Hz (on the talk this was made for it is 60.04 Hz, so its 75th harmonic sits 3 Hz above 4500), so the notches
// follow the pitch the detector measured.
globalThis[Symbol.for("nerdfader.voice")] = (() => {
  const SLOTS = 56;   // notches: 47 for 60 Hz hum, 56 for 50 Hz
  // The notches for hum of a family (50 or 60) at its measured pitch: [{ frequency, Q }].
  const notches = (family, pitch = family) => {
    const hs = [3];
    for (let h = 5; h * family <= 6000; h += 2) if (h * family >= 500) hs.push(h);
    return hs.map((h) => {
      const frequency = h * pitch;
      return { frequency, Q: frequency <= 2000 ? 30 : frequency / 20 };
    });
  };

  const softClipCurve = (() => {
    const curve = new Float32Array(4097), knee = 0.6, ceiling = 0.97;
    for (let i = 0; i < curve.length; i++) {
      const x = ((i / (curve.length - 1)) * 2 - 1) * 8, a = Math.abs(x);
      curve[i] = Math.sign(x) * (a < knee ? a : knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee)));
    }
    return curve;
  })();

  // A gain stage in front of a context's speakers. Above 100% (counting voice fix's mono mix, which can turn the sound
  // up a little), a soft clipper sits after it: below 60% of full scale the sound passes unchanged, above that
  // peaks are rounded off smoothly towards a 97% ceiling instead of being chopped off. That keeps nearly all of a
  // boost on audio that is already loud (a limiter or compressor gives most of it back) without the crackle of plain
  // clipping. The shaper's input range is -1..1, so the signal is scaled down by 8 on the way in (600% of a
  // full-scale signal is 6).
  //
  //   input (level) ─┬─ dry ───────────────────────────────────────────────────────────────────────┬─ out ─ speakers,
  //                  └─ pick ─ (mono) ─ highpass ─ peaking ─ 56 notch slots ─ lookahead ─ counter ─ wet ┘   or the clipper
  //
  // Each part of the wet path is flat until voice fix finds what it is for; pick keeps only the channel that arrives
  // first when the other is its sound arriving later (shapeJudge()'s lag); wet's gain also makes up the loudness
  // YouTube's Stable Volume gave, once it is switched off (setMakeup()); lookahead and counter are for
  // stableVolumeCounter(): no delay and no change unless it runs.
  //
  // Voice fix crossfades dry to wet over 50 ms, once it has found something to fix. The notch slots start flat
  // (peaking at 0 dB, which changes nothing) and become notches once hum is found. connect and disconnect are the browser's own (main.js patches them).
  // A stage handed over by an earlier copy of the scripts keeps its input node, which the page's sound is already
  // routed into, and everything after it is built anew.
  function outputStage(ctx, { connect, disconnect }, input = null) {
    const adopted = !!input;
    if (adopted) disconnect.call(input);
    else input = ctx.createGain();
    input.channelCount = 2;
    input.channelCountMode = "max";
    const dry = ctx.createGain();
    const out = ctx.createGain();
    const scale = ctx.createGain();
    scale.gain.value = 1 / 8;
    const clipper = ctx.createWaveShaper();
    clipper.curve = softClipCurve;
    clipper.oversample = "4x";
    connect.call(input, dry);
    connect.call(dry, out);
    connect.call(scale, clipper);
    connect.call(clipper, ctx.destination);
    connect.call(out, ctx.destination);

    let wanted = adopted ? input.gain.value : 1, voiceOn = false, family = null, pitch = null;
    let shape = { mono: false, lag: 0, mixDb: 0, boom: false };
    let makeupDb = 0;
    let wet = null, pick = null, highpass = null, peaking = null, slots = null;
    let lookahead = null, counter = null, meter = null, counterDb = 0;
    // Built the first time voice fix has something to fix.
    const wetPath = () => {
      if (wet) return;
      // Two channels first: a splitter alone would put a mono source in the left only.
      const both = ctx.createGain(), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
      both.channelCount = 2;
      both.channelCountMode = "explicit";
      pick = [ctx.createGain(), ctx.createGain()];
      connect.call(input, both);
      connect.call(both, split);
      pick.forEach((g, i) => { connect.call(split, g, i); connect.call(g, merge, 0, i); });
      highpass = ctx.createBiquadFilter();
      peaking = ctx.createBiquadFilter();
      peaking.frequency.value = 200;
      peaking.Q.value = 1;
      slots = Array.from({ length: SLOTS }, () => {
        const f = ctx.createBiquadFilter();
        f.type = "peaking";
        f.gain.value = 0;
        return f;
      });
      lookahead = ctx.createDelay(0.1);
      counter = ctx.createGain();
      wet = ctx.createGain();
      wet.gain.value = 0;
      [merge, highpass, peaking, ...slots, lookahead, counter, wet, out].reduce((a, b) => (connect.call(a, b), b));
      setChannels();
      setBoom();
      setFamily(family, pitch);
    };
    // Mono: the browser mixes left and right in equally, 0.5 (L + R); with a lag, only the earlier one, at twice
    // that (lag above 0: the left is behind, so the right alone). Otherwise the filters keep the stereo. at: when the
    // channels change (s, context time).
    const setChannels = (at = 0) => {
      highpass.channelCount = shape.mono ? 1 : 2;
      highpass.channelCountMode = shape.mono ? "explicit" : "max";
      const lag = shape.mono ? shape.lag : 0;
      pick[0].gain.setValueAtTime(lag > 0 ? 0 : lag < 0 ? 2 : 1, at);
      pick[1].gain.setValueAtTime(lag < 0 ? 0 : lag > 0 ? 2 : 1, at);
    };
    // Less boom: 80 Hz high-pass (Butterworth: this type takes Q in dB) and 200 Hz down 4 dB. Otherwise both are flat
    // (a peaking filter at 0 dB changes nothing).
    const setBoom = () => {
      if (shape.boom) {
        highpass.type = "highpass";
        highpass.frequency.value = 80;
        highpass.Q.value = -3.01;
      } else {
        highpass.type = "peaking";
        highpass.gain.value = 0;
      }
      peaking.type = "peaking";
      peaking.gain.value = shape.boom ? -4 : 0;
    };
    // Voice fix plays the wet path only once it has found something to fix; until then, and when there is nothing,
    // the sound passes as it is.
    const active = () => voiceOn && (shape.mono || shape.boom || !!family);
    const mix = () => 10 ** (((shape.mono ? shape.mixDb : 0) + makeupDb) / 20);

    let clipping = false, unclip = 0;
    const route = (now) => {
      const need = wanted * (active() ? mix() : 1) > 1;
      clearTimeout(unclip);
      if (need === clipping) return;
      // Leaving the clipper waits for a glide down to finish, so nothing passes full scale on the direct path.
      if (!need && !now) { unclip = setTimeout(() => route(true), 80); return; }
      // Connect the new path before dropping the old one so there is no gap.
      connect.call(out, need ? scale : ctx.destination);
      disconnect.call(out, need ? ctx.destination : scale);
      clipping = need;
    };
    const to = (param, value, glide) => {
      param.cancelScheduledValues(0);
      if (!glide) { param.value = value; return; }
      param.setValueAtTime(param.value, ctx.currentTime);
      param.linearRampToValueAtTime(value, ctx.currentTime + 0.05);   // 50 ms, no clicks while dragging
    };
    // Crossfades between the sound as it is and voice fix's version.
    const apply = (glide) => {
      const on = active();
      if (on) wetPath();
      to(dry.gain, on ? 0 : 1, glide);
      if (wet) to(wet.gain, on ? mix() : 0, glide);
      route(!glide);
    };

    const set = (value, glide = true) => {
      wanted = value;
      to(input.gain, value, glide);
      route(!glide);
    };
    const setVoice = (on, glide = true) => {
      voiceOn = on;
      apply(glide);
    };
    // What shapeJudge() found: { mono, lag, mixDb (the mono mix's gain, so it is as loud as the stereo was), boom }.
    function setShape(next, glide = true) {
      const was = shape;
      shape = { mono: !!next.mono, lag: next.lag || 0, mixDb: next.mixDb ?? 0, boom: !!next.boom };
      const moved = shape.mono !== was.mono || (shape.mono && Math.sign(shape.lag) !== Math.sign(was.lag));
      if (!wet) return apply(glide);
      setBoom();
      if (!moved) return apply(glide);
      const now = ctx.currentTime;
      if (glide && active() && wet.gain.value > 0) {
        // Changing channels while voice fix plays would jump with a click: the wet path dips out for 20 ms,
        // changes, and comes back in 30.
        wet.gain.cancelScheduledValues(0);
        wet.gain.setValueAtTime(wet.gain.value, now);
        wet.gain.linearRampToValueAtTime(0, now + 0.02);
        setChannels(now + 0.02);
        wet.gain.setValueAtTime(0, now + 0.02);
        wet.gain.linearRampToValueAtTime(mix(), now + 0.05);
        route(false);
        return;
      }
      setChannels(glide && wet.gain.value > 0 ? now + 0.05 : 0);   // fading out: after the fade
      apply(glide);
    }
    // Hum at 50 or 60 Hz, at its measured pitch, or null for none: retypes the slots at once, so main.js calls it
    // while the sound is quiet.
    function setFamily(next, nextPitch = next) {
      family = next;
      pitch = nextPitch;
      if (slots) {
        const set = family ? notches(family, pitch ?? family) : [];
        slots.forEach((f, i) => {
          if (i < set.length) {
            f.type = "notch";
            f.frequency.value = set[i].frequency;
            f.Q.value = set[i].Q;
          } else {
            f.type = "peaking";
            f.gain.value = 0;
          }
        });
      }
      if (wet || active()) apply(true);
    }
    // Stable Volume's counter: on, it returns a meter of the sound just before the 30 ms lookahead, so changes in
    // level are seen before they are heard; counterTo() then sets the counter's gain (in dB): down quickly as the
    // sound gets quieter, back up quickly enough not to blunt the start of a word (10 ms up, 80 ms down).
    function setCounter(on) {
      if (!wet) return null;
      lookahead.delayTime.setTargetAtTime(on ? 0.03 : 0, ctx.currentTime, 0.05);
      if (!on) { counterTo(0); return null; }
      if (!meter) {
        meter = ctx.createAnalyser();
        meter.fftSize = 2048;
        connect.call(slots[slots.length - 1], meter);
      }
      return meter;
    }
    function counterTo(db) {
      if (!counter) return;
      counter.gain.setTargetAtTime(10 ** (db / 20), ctx.currentTime, db > counterDb ? 0.01 : 0.08);
      counterDb = db;
    }
    // The loudness YouTube's Stable Volume gave and switching it off took away (dB, 0 for none): on the talk the
    // echo fix was made for, 10 dB. Only voice fix's sound gets it: Stable Volume is off only for voice fix.
    function setMakeup(db) {
      if (db === makeupDb) return;
      makeupDb = db;
      if (wet) apply(true);
    }
    set(wanted, false);
    return { input, set, setVoice, setShape, setFamily, setMakeup, setCounter, counterTo };
  }

  // Finds mains hum in the frames it is given: the spectrum (dB per bin, as an AnalyserNode with smoothing 0 gives
  // it) and the frame's loudness (RMS in dBFS), one frame per frameSeconds of playback.
  //
  // Hum is clearest when nobody speaks, so it looks at the quietest 30% of frames (frames under -70 dBFS, digital
  // silence included, are not counted). For each odd harmonic 3 to 33 of 50 and of 60 Hz it measures how far the
  // loudest bin within 3 Hz stands above the median of the bins 8 to 25 Hz away, and averages that over those
  // frames. A family is found when at least 3 of its harmonics from the 9th up stand 6 dB or more above their
  // surroundings and the other family has at most 1 (harmonics within 12 Hz of one of the other family's, like
  // 540 and 550 Hz, are not counted for either). Music rarely does that: its notes aren't on either grid for long.
  //
  // frame() returns null until there is an answer: 50 or 60 once lockAfter seconds of counted frames show hum (from
  // 2 s when it is unmistakable), "none" once noneAfter seconds show nothing like it, or giveUpAfter seconds don't
  // settle it. With hum found, pitch is its exact fundamental, measured from where its
  // harmonics' peaks sit in those quiet frames (between bins, by fitting a parabola to the three around each peak;
  // the higher harmonics weigh most). quietLevel is the loudness of the quietest 30% (for main.js: a moment quiet
  // enough to change the filters in).
  function humDetector({ sampleRate, fftSize, frameSeconds = 0.1, lockAfter = 6, giveUpAfter = 60, noneAfter = 15 }) {
    const earlyAfter = Math.min(2, lockAfter);
    const binHz = sampleRate / fftSize;
    const candidates = [];
    for (const family of [50, 60]) for (let h = 3; h <= 33; h += 2) candidates.push({ family, h, freq: family * h });
    for (const c of candidates) {
      c.counts = c.h >= 9 && !candidates.some((o) => o.family !== c.family && Math.abs(o.freq - c.freq) <= 12);
      c.peak = [Math.ceil((c.freq - 3) / binHz), Math.floor((c.freq + 3) / binHz)];
      c.around = [];
      for (let i = Math.ceil((c.freq - 25) / binHz); i <= Math.floor((c.freq + 25) / binHz); i++) {
        if (Math.abs(i * binHz - c.freq) >= 8) c.around.push(i);
      }
    }
    const frames = [];
    const around = new Float64Array(Math.max(...candidates.map((c) => c.around.length)));
    const detector = { quietLevel: -Infinity, pitch: null, frame };

    function frame(spectrum, rms) {
      if (!(rms > -70)) return null;
      const prominence = new Float32Array(candidates.length), at = new Float32Array(candidates.length);
      candidates.forEach((c, k) => {
        let peak = -Infinity, top = 0, n = 0;
        for (let i = c.peak[0]; i <= c.peak[1]; i++) if (spectrum[i] > peak) { peak = spectrum[i]; top = i; }
        const [a, b, d] = [spectrum[top - 1], peak, spectrum[top + 1]];
        const bend = a - 2 * b + d;
        at[k] = (top + (Number.isFinite(bend) && bend < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - d)) / bend)) : 0)) * binHz;
        for (const i of c.around) if (Number.isFinite(spectrum[i])) around[n++] = spectrum[i];
        if (!Number.isFinite(peak) || n === 0) return;
        const sorted = around.subarray(0, n).sort();
        const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
        prominence[k] = Math.min(30, Math.max(0, peak - median));
      });
      frames.push({ rms, prominence, at });
      const seconds = frames.length * frameSeconds;
      if (seconds < earlyAfter) return null;

      const quiet = [...frames].sort((a, b) => a.rms - b.rms).slice(0, Math.max(1, Math.ceil(frames.length * 0.3)));
      detector.quietLevel = quiet[quiet.length - 1].rms;
      const found = { 50: [], 60: [] }, strong = { 50: 0, 60: 0 }, faint = { 50: 0, 60: 0 };
      candidates.forEach((c, k) => {
        if (!c.counts) return;
        let sum = 0;
        for (const f of quiet) sum += f.prominence[k];
        const mean = sum / quiet.length;
        if (mean >= 6) found[c.family].push(k);
        if (mean >= 9) strong[c.family]++;
        if (mean >= 4) faint[c.family]++;
      });
      for (const [family, other] of [[60, 50], [50, 60]]) {
        // Before lockAfter, only hum that is already unmistakable: 4 harmonics 9 dB out, none of the other family.
        const sure = seconds >= lockAfter ? found[family].length >= 3 && found[other].length <= 1
          : strong[family] >= 4 && found[other].length === 0;
        if (sure) {
          detector.pitch = measurePitch(found[family], quiet, family);
          return family;
        }
      }
      // No hum is clear sooner than hum: after noneAfter seconds, when neither family has even 3 harmonics 4 dB out
      // (talks with hum have 8 or 9 by then, clean ones 0 or 1).
      if (seconds >= noneAfter && faint[50] < 3 && faint[60] < 3) return "none";
      return seconds >= giveUpAfter ? "none" : null;
    }
    // The fundamental that best fits the harmonics' peaks (least squares through zero: h × pitch ≈ peak), from the
    // frames where each stands out. Mains hum is within a fraction of a hertz of 50 or 60; anything further off is a
    // bad reading, and the family's own pitch is used.
    function measurePitch(ks, quiet, family) {
      let num = 0, den = 0;
      for (const k of ks) {
        const { h } = candidates[k];
        const peaks = quiet.filter((f) => f.prominence[k] >= 6).map((f) => f.at[k]).sort((x, y) => x - y);
        if (!peaks.length) continue;
        const peak = peaks[Math.floor(peaks.length / 2)];
        num += h * peak * peaks.length;
        den += h * h * peaks.length;
      }
      const pitch = den ? num / den : family;
      return Math.abs(pitch - family) <= 0.5 ? pitch : family;
    }
    return detector;
  }

  // An in-place radix-2 FFT of re and im (their length a power of 2); sign 1 is the inverse, unscaled.
  function fft(re, im, sign = -1) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = (sign * 2 * Math.PI) / size;
      for (let k = 0; k < half; k++) {
        const c = Math.cos(step * k), s = Math.sin(step * k);
        for (let a = k; a < n; a += size) {
          const b = a + half, tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // Finds whether one channel is the other's sound arriving later, as with a second mic far back in the room (on the
  // talk this was made for, 21 m back: 63 ms). Mixed to mono as they are, every word plays twice. Each frame adds
  // the cross spectrum of a window of left and right (Hann, zero padded to twice its length so lags don't wrap).
  // answer() looks at 80 to 300 Hz, where a far mic still hears the voice clearly (above, it hears mostly the room),
  // weighs each frequency by its own loudness in both channels (so a voice's pitch, which makes speech look like
  // itself a few ms later, doesn't count), and turns that back into how well the channels match at each lag (1: the
  // same sound), corrected for how much of the window still overlaps there. It finds the peak from 5 to 150 ms
  // either way, and counts it when the match is MATCH or more and at least twice as good as within 5 ms of 0
  // (channels that are mostly the same sound at once stay as they are). On that talk the match is about 0.6 at
  // 64 ms within a second or two; on two mics side by side it stays under 0.3, and on identical channels under 0.4
  // away from 0 (where it is 1).
  // Returns { lag, match }: lag (s) is how far the left channel arrives after the right one (negative: the right
  // comes later), 0 for none; match is how well they match there.
  const MATCH = 0.4;
  function delayFinder(sampleRate, size) {
    const n = 2 * size, maxLag = Math.min(Math.round(0.15 * sampleRate), size / 2), minLag = Math.round(0.005 * sampleRate);
    const lo = Math.ceil((80 * n) / sampleRate), hi = Math.floor((300 * n) / sampleRate);
    const hann = new Float64Array(size);
    for (let i = 0; i < size; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    const re = new Float64Array(n), im = new Float64Array(n), sumRe = new Float64Array(n), sumIm = new Float64Array(n);
    const powerL = new Float64Array(n), powerR = new Float64Array(n);
    let overlap = null, heard = false;
    // Both channels in one transform: left as the real part, right as the imaginary part.
    const add = (left, right) => {
      re.fill(0); im.fill(0);
      for (let i = 0; i < size; i++) { re[i] = left[i] * hann[i]; im[i] = right[i] * hann[i]; }
      fft(re, im);
      for (let k = lo; k <= hi; k++) {
        const m = n - k;
        const lr = (re[k] + re[m]) / 2, li = (im[k] - im[m]) / 2, rr = (im[k] + im[m]) / 2, ri = (re[m] - re[k]) / 2;
        sumRe[k] += lr * rr + li * ri;   // left times the conjugate of right
        sumIm[k] += li * rr - lr * ri;
        powerL[k] += lr * lr + li * li;
        powerR[k] += rr * rr + ri * ri;
      }
      heard = true;
    };
    const answer = () => {
      if (!heard) return { lag: 0, match: 0 };
      if (!overlap) {
        // The window's overlap with itself at each lag: the inverse transform of its power spectrum.
        const wr = new Float64Array(n), wi = new Float64Array(n);
        wr.set(hann);
        fft(wr, wi);
        for (let k = 0; k < n; k++) { wr[k] = wr[k] * wr[k] + wi[k] * wi[k]; wi[k] = 0; }
        fft(wr, wi, 1);
        overlap = wr.map((v) => v / wr[0]);
      }
      // The band and its mirror (a real signal's), and nothing else.
      re.fill(0); im.fill(0);
      for (let k = lo; k <= hi; k++) {
        const weight = Math.sqrt(powerL[k] * powerR[k]);
        if (!(weight > 0)) continue;
        re[k] = sumRe[k] / weight; im[k] = sumIm[k] / weight;
        re[n - k] = re[k]; im[n - k] = -im[k];
      }
      fft(re, im, 1);
      const scale = 2 * (hi - lo + 1);
      const at = (j) => re[(j + n) % n] / scale / overlap[Math.abs(j)];
      let near = 0, best = 0, lag = 0;
      for (let j = -minLag + 1; j < minLag; j++) near = Math.max(near, at(j));   // within 5 ms of 0
      for (let j = minLag; j <= maxLag; j++) {
        for (const k of [j, -j]) if (at(k) > best) { best = at(k); lag = k; }
      }
      const found = best >= MATCH && best >= 2 * near;
      return { lag: found ? lag / sampleRate : 0, match: best };
    };
    return { add, answer };
  }

  // Judges the recording from frames of what plays (one per frameSeconds): its level (dBFS); the mean squares of left,
  // right, and the side (L - R) / 2 and mid (L + R) / 2; the power of the low end (160 to 320 Hz) and of the voice's
  // core (1 to 4 kHz); and the latest window of left and right (left, right: equal power-of-2 lengths, given with
  // sampleRate), for delayFinder(). From the louder half of lockAfter seconds of frames above -60 dBFS (the talking):
  // - mono when left and right differ: they don't move together (the side is more than a tenth of the mid, as with two
  //   mics in a room), or one is 1.5 dB or more louder (the voice in one ear). Identical channels stay as they are.
  // - lag: with mono, when one channel is the other's sound arriving later, how far the left one is behind (s;
  //   negative: the right one), else 0. The stage then plays only the earlier one, so there is no echo.
  // - mixDb: the mono mix's gain to be as loud as the two channels were: 3 dB for unrelated channels, 0 for identical
  //   (with a lag, the earlier channel alone: up or down to the average of the two, by up to 3 dB).
  // - boom: with mono (the room and mics that need it), or when the low end is within 2 dB of the voice's core (a
  //   clean recording of a voice is 3 to 5 dB below).
  // Returns null until it has heard enough (1.5 s when it is plain, otherwise lockAfter), then
  // { mono, lag, mixDb, boom, settled }. A lag can take longer to be sure of than the rest: told mono without one
  // before lockAfter, settled is false, and it keeps listening for one until lockAfter: then it answers once more,
  // settled, with the lag it found or none.
  function shapeJudge({ frameSeconds = 0.1, lockAfter = 6, sampleRate = 48000 } = {}) {
    const frames = [], earlyAfter = Math.min(1.5, lockAfter);
    let delays = null, told = null;
    // l, r, mid, side: the louder half's sums; delay: delayFinder()'s answer, or none.
    const shape = ({ mono, boom, l, r, mid, side }, delay, settled) => {
      const lag = mono && delay ? delay.lag : 0;
      // mid and side together are (l + r) / 2, the two channels' average.
      const mixDb = !mono ? 0 : lag ? Math.min(3, Math.max(-3, 10 * Math.log10((mid + side) / (lag > 0 ? r : l))))
        : Math.min(3, Math.max(0, 10 * Math.log10((mid + side) / mid)));
      return { mono, lag, mixDb, boom, settled };
    };
    return (f) => {
      if (!(f.level > -60) || told?.settled) return null;
      frames.push(f);
      if (f.left) {
        delays ??= delayFinder(sampleRate, f.left.length);
        delays.add(f.left, f.right);
      }
      const seconds = frames.length * frameSeconds;
      if (told) {
        const delay = delays.answer();
        if (!delay.lag && seconds < lockAfter) return null;
        told = { ...told, settled: true };
        return shape(told, delay, true);
      }
      if (seconds < earlyAfter) return null;
      const levels = frames.map((x) => x.level).sort((a, b) => a - b), median = levels[Math.floor(levels.length / 2)];
      let l = 0, r = 0, mid = 0, side = 0, low = 0, core = 0;
      for (const x of frames) {
        if (x.level < median) continue;
        l += x.l; r += x.r; mid += x.mid; side += x.side; low += x.low; core += x.core;
      }
      const apart = side / mid, imbalance = Math.abs(10 * Math.log10(l / r)), lowEnd = 10 * Math.log10(low / core);
      // Before lockAfter, only when it is plain: left and right far apart (two mics: 0.5 and up), or identical with a
      // low end clearly not heavy (an intro's music can be, for a moment).
      const plain = apart > 0.3 || imbalance > 6 || (apart < 0.02 && imbalance < 0.5 && lowEnd < -4);
      if (seconds < lockAfter && !plain) return null;
      const together = mid > 0 && apart < 0.1;
      const mono = !together || !(imbalance < 1.5);
      const delay = mono && delays ? delays.answer() : null;
      const settled = !delay || !!delay.lag || seconds >= lockAfter;
      told = { mono, boom: mono || lowEnd > -2, l, r, mid, side, settled };
      return shape(told, delay, settled);
    };
  }

  // YouTube's Stable Volume lifts quiet moments towards the voice: measured on a talk, by how far below the voice
  // they end up (dB), and how much they were lifted to get there. Louder than 3 dB below the voice is left alone.
  const LIFT = [[-15.5, 7], [-10.7, 6.8], [-7.8, 4.7], [-5.4, 2.1], [-3, 0]];
  const lift = (below) => {
    if (below <= LIFT[0][0]) return LIFT[0][1];
    for (let i = 1; i < LIFT.length; i++) {
      const [x0, y0] = LIFT[i - 1], [x1, y1] = LIFT[i];
      if (below <= x1) return y0 + ((below - x0) / (x1 - x0)) * (y1 - y0);
    }
    return 0;
  };
  // Takes the level of the last ~40 ms (dBFS) every stepSeconds and says how far to turn it down now (dB, 0 or
  // less): by the lift, read against the voice's level (the loudest 10% of the last 20 s). How far below the voice
  // the quiet 15% sit says how compressed the sound is: 12 dB or less below, fully; 17 dB or more (as uncompressed
  // talk usually is), not at all, so sound that isn't Stable Volume's is barely touched.
  function stableVolumeCounter({ stepSeconds = 0.025 } = {}) {
    const history = [], keep = Math.round(20 / stepSeconds);
    return (level) => {
      if (level > -100) {
        history.push(level);
        if (history.length > keep) history.shift();
      }
      if (history.length < 1 / stepSeconds) return 0;
      const sorted = [...history].sort((a, b) => a - b);
      const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
      const voice = at(0.9), depth = at(0.15) - voice;
      const scale = Math.min(1, Math.max(0, (depth + 17) / 5));
      return -scale * lift(level - voice);
    };
  }

  return { outputStage, shapeJudge, delayFinder, humDetector, notches, stableVolumeCounter, softClipCurve, SLOTS };
})();
