// Runs in the page's own JavaScript world (MAIN) at document_start, in every frame, before the page's scripts.
// Scales everything the page plays by the tab's level without the page noticing:
// - <audio>/<video>: the real volume is the page's volume times the level (up to 1), and the volume getter keeps
//   returning the page's own value, so the site's slider still shows what the site set.
// - Above 100%, or with voice fix on, elements are routed through Web Audio: a gain stage, voice fix and a soft
//   clipper, so loud parts are rounded off instead of crackling (see content/voice.js, which runs just before this
//   and hands it the stage and the hum detector). Elements the browser won't let Web Audio hear (DRM, media from
//   another site without CORS) are left alone, and the frame reports why so the extension can offer capture mode
//   instead.
// - Web Audio: connections to an AudioContext's destination go through one hidden stage per context.
// bridge.js (the extension's isolated world) sends the level as a "nerdfader3:level" event on window and voice fix
// as "nerdfader3:voice" (1 or 0), and passes this frame's "nerdfader3:status" (why it can't boost, or "") and
// "nerdfader3:hum" (the hum voice fix found: "50", "60" or "none") back to the extension.
//
// Updating the extension leaves the old copy of this script running in open tabs, cut off from the extension. The
// new copy takes over: the old one undoes its patches and hands over what it was tracking (elements already routed
// through Web Audio can't be routed a second time). Version 1.0 can't hand over, so it is set back to 100% (its
// own event, which nothing else sends any more) and left in place doing nothing. The events are versioned
// ("nerdfader3:") so cut-off copies of bridge.js from older builds, which threw when they heard one, never do.
(() => {
  const KEY = Symbol.for("nerdfader");
  const VOICE = Symbol.for("nerdfader.voice");
  const tools = window[VOICE];
  delete window[VOICE];
  if (!tools) return;
  const previous = window[KEY]?.retire?.();
  if (window.__nerdfaderPatched) window.dispatchEvent(new CustomEvent("nerdfader:level", { detail: 1 }));

  let level = previous?.level ?? 1, voice = previous?.voice ?? false;
  // Elements go through Web Audio only when that's needed: to boost past 100%, or for voice fix.
  const needsGraph = () => level > 1 || voice;
  const NativeAudioContext = window.AudioContext;   // pages sometimes replace it later
  const connect = AudioNode.prototype.connect;
  const disconnect = AudioNode.prototype.disconnect;

  // Voice fix's hum notches. lock: the hum notched now (50, 60 or null). result: what was reported ("" until there
  // is an answer, then "50", "60" or "none"). due: a check is wanted (at first, and when a new video has played a
  // while).
  const hum = previous?.hum ?? { lock: null, pitch: null, result: "", due: true };
  // A stage in front of a context's speakers (content/voice.js). Stages handed over by an earlier copy, including
  // version 1.2's simpler ones, are rebuilt around their input, which the page's sound is already routed into.
  const outputStage = (ctx, input) => {
    const stage = tools.outputStage(ctx, { connect, disconnect }, input);
    stage.setFamily(hum.lock, hum.pitch);
    stage.setVoice(voice, false);
    return stage;
  };


  // <audio> and <video>
  const media = HTMLMediaElement.prototype;
  const volume = Object.getOwnPropertyDescriptor(media, "volume");
  const pageVolume = previous?.pageVolume ?? new WeakMap();   // element -> the volume the page asked for
  const elements = previous?.elements ?? new Set();     // WeakRefs to every element touched, attached or not (new Audio())
  const routed = previous?.routed ?? new WeakSet();     // elements playing through the boost stage
  const encrypted = previous?.encrypted ?? new WeakSet();   // elements that announced DRM-protected media

  const apply = (el) => {
    const want = Math.min(1, Math.max(0, pageVolume.get(el) * Math.min(level, 1)));
    if (volume.get.call(el) !== want) volume.set.call(el, want);
  };
  const track = (el) => {
    if (pageVolume.has(el)) return;
    pageVolume.set(el, volume.get.call(el));
    elements.add(new WeakRef(el));
    apply(el);
  };
  const each = (fn) => {
    for (const ref of elements) {
      const el = ref.deref();
      el ? fn(el) : elements.delete(ref);
    }
  };

  const patchedVolume = {
    configurable: true,
    enumerable: volume.enumerable,
    get() {
      return pageVolume.has(this) ? pageVolume.get(this) : volume.get.call(this);
    },
    set(v) {
      const n = Number(v);
      if (!(n >= 0 && n <= 1)) return volume.set.call(this, v);   // let the browser throw its own error
      track(this);
      pageVolume.set(this, n);
      apply(this);
    },
  };
  Object.defineProperty(media, "volume", patchedVolume);

  const play = media.play;
  const patchedPlay = function () {
    track(this);
    if (needsGraph()) boost(this);
    return play.apply(this, arguments);
  };
  media.play = patchedPlay;

  // Why Web Audio can't take this element's sound ("" when it can). Routing it anyway would silence it.
  function blocker(el) {
    if (el.mediaKeys || encrypted.has(el)) return "protected";
    if (el.srcObject) return "stream";
    const src = el.currentSrc;
    if (!src) return "unknown";
    const url = new URL(src, location.href);
    if (url.protocol === "blob:" || url.protocol === "data:" || url.origin === location.origin) return "";
    return el.crossOrigin === null ? "cross-origin" : "";
  }

  // The boost stage for elements, created the first time something needs boosting.
  let boostCtx = previous?.boostCtx ?? null, needsClick = false;
  let boostStage = previous?.boostStage ? outputStage(boostCtx, previous.boostStage.input) : null;
  // Browsers only let a page start Web Audio after a real interaction with it (a click, a normal key press; holding
  // Command or Shift, or Esc, doesn't count), unless the page may already play sound by itself. Starting it earlier
  // only gets a "not allowed to start" warning, so the boost stage waits for that.
  const playingSound = () => {
    let found = false;
    each((el) => { found ||= !el.paused && !el.muted && pageVolume.get(el) > 0; });
    return found;
  };
  const mayStart = () => (navigator.userActivation?.hasBeenActive ?? true) || playingSound();
  const wake = () => {
    if (!navigator.userActivation?.hasBeenActive) return;   // this key or click didn't count as interacting
    if (!boostCtx) { if (needsGraph()) each(boost); report(); }
    else if (boostCtx.state !== "running") boostCtx.resume();
  };
  const check = () => {
    needsClick = boostCtx.state !== "running";
    if (!needsClick && needsGraph()) each(boost);
    maybeDetect();
    report();
  };
  if (boostCtx) boostCtx.onstatechange = check;
  function boostContext() {
    if (boostCtx) return boostCtx;
    // A fixed rate: the default follows the current output device, which can be a 16 kHz headset for a moment.
    boostCtx = new NativeAudioContext({ sampleRate: 48000 });
    boostStage = outputStage(boostCtx);
    boostStage.set(Math.max(level, 1), false);
    // Routing an element into a context that isn't running would mute it, so elements join once it runs.
    boostCtx.onstatechange = check;
    setTimeout(check, 300);
    return boostCtx;
  }
  function boost(el) {
    if (routed.has(el) || blocker(el) !== "") return;
    if (!boostCtx && !mayStart()) { needsClick = true; return; }
    if (boostContext().state !== "running") return;
    try {
      connect.call(boostCtx.createMediaElementSource(el), boostStage.input);
    } catch {
      return;   // routed by an earlier copy that couldn't hand it over; it stays at up to 100%
    }
    routed.add(el);
    maybeDetect();
    if (counterWanted) setCounter(true);
  }

  // Report the first reason this frame can't boost something that is playing right now ("" if none).
  let lastStatus = "";
  function report() {
    let status = "";
    each((el) => {
      if (status || routed.has(el) || el.paused || el.ended || el.muted) return;
      status = blocker(el) || (needsClick ? "click" : "");
      if (status === "unknown") status = "";
    });
    if (status === lastStatus) return;
    lastStatus = status;
    window.dispatchEvent(new CustomEvent("nerdfader3:status", { detail: status }));
  }

  // Elements that autoplay or start from the browser's own controls never call play() from script.
  const onMedia = (e) => {
    if (!(e.target instanceof HTMLMediaElement)) return;
    if (e.type === "encrypted") encrypted.add(e.target);
    track(e.target);
    if (needsGraph() && (e.type === "play" || e.type === "playing")) boost(e.target);
    const el = e.target;
    if (routed.has(el) && (e.type === "loadstart" || e.type === "emptied" ||
      (e.type === "playing" && sources.has(el) && sources.get(el) !== el.currentSrc))) newSource();
    if (e.type === "playing") sources.set(el, el.currentSrc);
    if (voice && e.type === "playing") stableVolume(true);   // the player may not have existed when voice fix came on
    report();
  };
  const mediaEvents = ["play", "playing", "pause", "ended", "emptied", "loadstart", "encrypted", "volumechange"];
  for (const type of mediaEvents) document.addEventListener(type, onMedia, true);
  addEventListener("pointerdown", wake, true);
  addEventListener("keydown", wake, true);
  addEventListener("click", wake, true);

  // Hum detection, for voice fix, on the elements' sound only. It listens until it has an answer (content/voice.js),
  // then changes the notches at a quiet moment, so the change can't be heard. A new video in the same element (the
  // next one, an ad, a site that changes pages without loading one) keeps the notches, and is checked again once it
  // has played 30 s: ads are usually over by then.
  const sources = new WeakMap();   // element -> the media it played last
  const timing = () => ({ lockAfter: 6, giveUpAfter: 60, recheckAfter: 30, ...window.__nerdfaderHumTiming });   // tests shorten these
  let detection = null, fresh = null;
  function maybeDetect() {
    if (!hum.due || detection || fresh || !voice || !boostStage || boostCtx.state !== "running") return;
    const analyser = boostCtx.createAnalyser();
    analyser.fftSize = 16384;
    analyser.smoothingTimeConstant = 0;
    analyser.channelCount = 1;   // left and right mixed, as voice fix plays it
    analyser.channelCountMode = "explicit";
    connect.call(boostStage.input, analyser);
    const detector = tools.humDetector({ sampleRate: boostCtx.sampleRate, fftSize: analyser.fftSize, ...timing() });
    const spectrum = new Float32Array(analyser.frequencyBinCount), wave = new Float32Array(analyser.fftSize);
    // Its first readings, before it has heard a whole window, are partly empty: they would look like quiet moments.
    const full = boostCtx.currentTime + analyser.fftSize / boostCtx.sampleRate;
    let found, pitch, since = 0;
    const read = () => {
      if (boostCtx.currentTime < full) return;
      analyser.getFloatTimeDomainData(wave);
      let sum = 0;
      for (const v of wave) sum += v * v;
      const rms = 10 * Math.log10(sum / wave.length);
      if (found !== undefined) {
        if (rms <= detector.quietLevel || Date.now() - since > 10000) done();
        return;
      }
      analyser.getFloatFrequencyData(spectrum);
      const answer = detector.frame(spectrum, rms);
      if (answer === null) return;
      found = answer === "none" ? null : answer;
      pitch = detector.pitch;
      since = Date.now();
      if (found === hum.lock) done();
    };
    // (Turned off or taken over before this, the check is still due and starts again later.)
    const done = () => {
      hum.due = false;
      stopDetect();
      useHum(found, pitch);
    };
    detection = { analyser, timer: setInterval(read, 100) };
  }
  function stopDetect() {
    if (!detection) return;
    clearInterval(detection.timer);
    try { disconnect.call(boostStage.input, detection.analyser); } catch {}   // already gone if the stage was rebuilt
    detection = null;
  }
  function useHum(family, pitch) {
    hum.lock = family;
    hum.pitch = pitch;
    hum.result = family ? String(family) : "none";
    boostStage?.setFamily(family, pitch);
    forEachStage((stage) => stage.setFamily(family, pitch));
    tellHum();
  }
  const tellHum = () => hum.result && window.dispatchEvent(new CustomEvent("nerdfader3:hum", { detail: hum.result }));
  function newSource() {
    if (!voice) return;
    stopDetect();
    clearInterval(fresh?.timer);
    fresh = null;
    hum.due = true;
    if (!hum.result) return maybeDetect();   // still listening: start over on the new one
    let played = 0;
    const after = timing().recheckAfter;
    fresh = {
      timer: setInterval(() => {
        let playing = false;
        each((el) => { playing ||= routed.has(el) && !el.paused && !el.ended; });
        if (playing) played++;
        if (played < after) return;
        clearInterval(fresh.timer);
        fresh = null;
        maybeDetect();
      }, 1000),
    };
  }

  // YouTube's Stable Volume (on by default) plays a compressed copy of the sound: quiet moments come up 5 to 8 dB
  // closer to the voice, and with them the hum and noise voice fix is there to take away. While voice fix is on, it
  // is turned off in this tab's player, and back on when voice fix goes off. YouTube saves the choice for every tab,
  // so the saved one is put back straight away: other tabs, and this one after a reload, keep the user's own.
  // If the user changes Stable Volume themselves while voice fix is on, that's their choice: YouTube saves every change
  // made in its menu (with the time, so even switching it back counts), and once that saved choice differs from the
  // one put back here, the setting is left as they set it, now and when voice fix goes off. The extension keeps that
  // for the tab ("nerdfader3:stableTheirs" out, "nerdfader3:stable" back in), so a reload leaves it alone too.
  // These are the player's own methods. If they stop working (YouTube changed them), a moment later the player still
  // reports Stable Volume, or can't say, and voice fix counters it instead: it turns quiet moments back down by about
  // as much as Stable Volume lifted them (content/voice.js).
  const onYouTube = () => /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname) || !!document.getElementById("movie_player");
  const PREF = "yt-player-drc-pref";
  const savedChoice = () => { try { return localStorage.getItem(PREF); } catch { return null; } };
  // off: this tab's Stable Volume was turned off here. mark: the user's saved choice just after that. theirs: they
  // changed it since, so it's theirs until voice fix goes off.
  const stable = previous?.stable ?? { off: previous?.stableOff ?? false, mark: savedChoice(), theirs: false };
  let stableCheck = 0, counterWanted = false, counter = null;
  function stableVolume(off) {
    if (!onYouTube()) return;
    if (stable.off && savedChoice() !== stable.mark) {
      Object.assign(stable, { off: false, theirs: true });
      window.dispatchEvent(new Event("nerdfader3:stableTheirs"));
    }
    const player = document.getElementById("movie_player");
    const turn = (on) => {
      const saved = savedChoice();
      player.setDrcUserPreference(on);
      if (saved === null) localStorage.removeItem(PREF);
      else localStorage.setItem(PREF, saved);
    };
    try {
      if (off && !stable.off && !stable.theirs && typeof player?.setDrcUserPreference === "function" && player.getDrcUserPreference()) {
        turn(false);
        Object.assign(stable, { off: true, mark: savedChoice() });
      } else if (!off && stable.off) {
        turn(true);
        stable.off = false;
      }
    } catch {}
    if (!off) stable.theirs = false;
    clearTimeout(stableCheck);
    if (!off) return setCounter(false);
    // Whether it worked shows once the player has switched to the other copy of the sound.
    stableCheck = setTimeout(() => setCounter(voice && !stableVolumeIsOff()), 3000);
  }
  function stableVolumeIsOff() {
    try {
      const player = document.getElementById("movie_player");
      return player.getDrcUserPreference() === false && !/\bDRC\b/.test(player.getStatsForNerds?.()?.volume ?? "");
    } catch {
      return false;
    }
  }
  // The counter follows the level of the elements' sound every 25 ms.
  function setCounter(on) {
    counterWanted = on;
    if (!on && counter) {
      clearInterval(counter);
      counter = null;
      boostStage?.setCounter(false);
    }
    if (!on || counter || !boostStage) return;
    const meter = boostStage.setCounter(true);
    if (!meter) return;
    const next = tools.stableVolumeCounter(), wave = new Float32Array(meter.fftSize);
    counter = setInterval(() => {
      meter.getFloatTimeDomainData(wave);
      let sum = 0;
      for (const v of wave) sum += v * v;
      boostStage.counterTo(next(10 * Math.log10(sum / wave.length)));
    }, 25);
  }

  // Web Audio made by the page
  const stages = previous?.stages ?? new WeakMap();   // AudioContext -> its output stage
  const contexts = previous?.contexts ?? new Set();   // WeakRefs to those contexts
  const forEachStage = (fn) => {
    for (const ref of contexts) {
      const ctx = ref.deref();
      ctx ? fn(stages.get(ctx), ctx) : contexts.delete(ref);
    }
  };
  if (previous) forEachStage((stage, ctx) => stages.set(ctx, outputStage(ctx, stage.input)));

  const stageFor = (ctx) => {
    let stage = stages.get(ctx);
    if (!stage) {
      stage = outputStage(ctx);
      stage.set(level, false);
      stages.set(ctx, stage);
      contexts.add(new WeakRef(ctx));
    }
    return stage.input;
  };
  // Offline contexts render to a buffer, not the speakers, so they are left alone.
  const isSpeakers = (node) =>
    node instanceof AudioDestinationNode && node.context instanceof NativeAudioContext;

  const patchedConnect = function (target, ...rest) {
    if (isSpeakers(target) && target.context !== boostCtx) {
      connect.call(this, stageFor(target.context), ...rest);
      return target;
    }
    return connect.call(this, target, ...rest);
  };
  const patchedDisconnect = function (target, ...rest) {
    if (isSpeakers(target) && stages.has(target.context)) return disconnect.call(this, stages.get(target.context).input, ...rest);
    return disconnect.apply(this, arguments);
  };
  AudioNode.prototype.connect = patchedConnect;
  AudioNode.prototype.disconnect = patchedDisconnect;

  const setLevel = (next) => {
    level = next;
    for (const el of document.querySelectorAll("audio, video")) track(el);
    each(apply);
    if (needsGraph()) each(boost);
    boostStage?.set(Math.max(level, 1));
    forEachStage((stage) => stage.set(level));
    report();
  };

  const onLevel = (e) => {
    const n = Number(e.detail);
    if (n >= 0 && n <= 6) setLevel(n);
  };
  window.addEventListener("nerdfader3:level", onLevel);
  const onVoice = (e) => {
    const on = Number(e.detail) === 1;
    if (on !== voice) {
      voice = on;
      if (voice) each(boost);
      else stopDetect();
      boostStage?.setVoice(voice);
      forEachStage((stage) => stage.setVoice(voice));
      maybeDetect();
      report();
    }
    stableVolume(voice);   // (also after an update, which needs the counter started again)
    if (voice) tellHum();   // a new copy of bridge.js asks again after an update
  };
  window.addEventListener("nerdfader3:voice", onVoice);
  const onStable = (e) => { if (Number(e.detail) === 1 && !stable.off) stable.theirs = true; };
  window.addEventListener("nerdfader3:stable", onStable);

  // Called by a newer copy of this script: undo everything here and hand over the state.
  const retire = () => {
    window.removeEventListener("nerdfader3:level", onLevel);
    window.removeEventListener("nerdfader3:voice", onVoice);
    window.removeEventListener("nerdfader3:stable", onStable);
    stopDetect();
    clearTimeout(stableCheck);
    clearInterval(counter);
    clearInterval(fresh?.timer);
    for (const type of mediaEvents) document.removeEventListener(type, onMedia, true);
    removeEventListener("pointerdown", wake, true);
    removeEventListener("keydown", wake, true);
    removeEventListener("click", wake, true);
    if (Object.getOwnPropertyDescriptor(media, "volume").set === patchedVolume.set) Object.defineProperty(media, "volume", volume);
    if (media.play === patchedPlay) media.play = play;
    if (AudioNode.prototype.connect === patchedConnect) AudioNode.prototype.connect = connect;
    if (AudioNode.prototype.disconnect === patchedDisconnect) AudioNode.prototype.disconnect = disconnect;
    each((el) => volume.set.call(el, pageVolume.get(el)));
    if (boostCtx) boostCtx.onstatechange = null;
    return { pageVolume, elements, routed, encrypted, boostCtx, boostStage, stages, contexts, level, voice, hum, stable };
  };
  Object.defineProperty(window, KEY, { value: { retire }, configurable: true });
  window.dispatchEvent(new Event("nerdfader3:ready"));
})();
