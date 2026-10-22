// Runs in the page's own JavaScript world (MAIN) at document_start, in every frame, before the page's scripts.
// Scales everything the page plays by the tab's level without the page noticing:
// - <audio>/<video>: the real volume is the page's volume times the level (up to 1), and the volume getter keeps
//   returning the page's own value, so the site's slider still shows what the site set.
// - Above 100%, elements are routed through Web Audio: a gain stage and a soft clipper, so loud parts are rounded off
//   instead of crackling. Elements the browser won't let Web Audio hear (DRM, media from another site without
//   CORS) are left alone, and the frame reports why so the extension can offer capture mode instead.
// - Web Audio: connections to an AudioContext's destination go through one hidden gain stage per context.
// bridge.js (the extension's isolated world) sends the level as a "nerdfader3:level" event on window, and passes
// this frame's "nerdfader3:status" (why it can't boost, or "") back to the extension.
//
// Updating the extension leaves the old copy of this script running in open tabs, cut off from the extension. The
// new copy takes over: the old one undoes its patches and hands over what it was tracking (elements already routed
// through Web Audio can't be routed a second time). Version 1.0 can't hand over, so it is set back to 100% (its
// own event, which nothing else sends any more) and left in place doing nothing. The events are versioned
// ("nerdfader3:") so cut-off copies of bridge.js from older builds, which threw when they heard one, never do.
(() => {
  const KEY = Symbol.for("nerdfader");
  const previous = window[KEY]?.retire?.();
  if (window.__nerdfaderPatched) window.dispatchEvent(new CustomEvent("nerdfader:level", { detail: 1 }));

  let level = 1;
  const NativeAudioContext = window.AudioContext;   // pages sometimes replace it later
  const connect = AudioNode.prototype.connect;
  const softClipCurve = (() => {
    const curve = new Float32Array(4097), knee = 0.6, ceiling = 0.97;
    for (let i = 0; i < curve.length; i++) {
      const x = ((i / (curve.length - 1)) * 2 - 1) * 8, a = Math.abs(x);
      curve[i] = Math.sign(x) * (a < knee ? a : knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee)));
    }
    return curve;
  })();
  const disconnect = AudioNode.prototype.disconnect;

  // A gain stage in front of a context's speakers. While boosting, a soft clipper sits after it: below 60% of full
  // scale the sound passes unchanged, above that peaks are rounded off smoothly towards a 97% ceiling instead of being
  // chopped off. That keeps nearly all of the boost on audio that is already loud (a limiter or compressor gives most
  // of it back) without the crackle of plain clipping. The shaper's input range is -1..1, so the signal is scaled down
  // by 8 on the way in (600% of a full-scale signal is 6).
  function outputStage(ctx) {
    const gain = ctx.createGain();
    const scale = ctx.createGain();
    scale.gain.value = 1 / 8;
    const clipper = ctx.createWaveShaper();
    clipper.curve = softClipCurve;
    clipper.oversample = "4x";
    connect.call(scale, clipper);
    connect.call(clipper, ctx.destination);
    let clipping = false;
    const set = (value, glide = true) => {
      const g = gain.gain;
      g.cancelScheduledValues(0);
      if (glide) g.setTargetAtTime(value, ctx.currentTime, 0.01);   // ~50 ms glide, no clicks while dragging
      else g.value = value;
      const boost = value > 1;
      if (boost === clipping) return;
      // Connect the new path before dropping the old one so there is no gap.
      connect.call(gain, boost ? scale : ctx.destination);
      disconnect.call(gain, boost ? ctx.destination : scale);
      clipping = boost;
    };
    connect.call(gain, ctx.destination);
    return { input: gain, set };
  }


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
    if (level > 1) boost(this);
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
  let boostCtx = previous?.boostCtx ?? null, boostStage = previous?.boostStage ?? null, needsClick = false;
  const wake = () => boostCtx && boostCtx.state !== "running" && boostCtx.resume();
  const check = () => {
    needsClick = boostCtx.state !== "running";
    if (!needsClick && level > 1) each(boost);
    report();
  };
  if (boostCtx) boostCtx.onstatechange = check;
  function boostContext() {
    if (boostCtx) return boostCtx;
    // A fixed rate: the default follows the current output device, which can be a 16 kHz headset for a moment.
    boostCtx = new NativeAudioContext({ sampleRate: 48000 });
    boostStage = outputStage(boostCtx);
    boostStage.set(Math.max(level, 1), false);
    // Browsers only start audio after the user has interacted with the page (or it may autoplay with sound).
    // Until then, routing would mute the element, so wait for a click or key press in the page.
    boostCtx.onstatechange = check;
    setTimeout(check, 300);
    return boostCtx;
  }
  function boost(el) {
    if (routed.has(el) || blocker(el) !== "") return;
    if (boostContext().state !== "running") return;
    try {
      connect.call(boostCtx.createMediaElementSource(el), boostStage.input);
    } catch {
      return;   // routed by an earlier copy that couldn't hand it over; it stays at up to 100%
    }
    routed.add(el);
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
    if (level > 1 && (e.type === "play" || e.type === "playing")) boost(e.target);
    report();
  };
  const mediaEvents = ["play", "playing", "pause", "ended", "emptied", "loadstart", "encrypted", "volumechange"];
  for (const type of mediaEvents) document.addEventListener(type, onMedia, true);
  addEventListener("pointerdown", wake, true);
  addEventListener("keydown", wake, true);

  // Web Audio made by the page
  const stages = previous?.stages ?? new WeakMap();   // AudioContext -> its output stage
  const contexts = previous?.contexts ?? new Set();   // WeakRefs to those contexts

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
    if (level > 1) each(boost);
    boostStage?.set(Math.max(level, 1));
    for (const ref of contexts) {
      const ctx = ref.deref();
      ctx ? stages.get(ctx).set(level) : contexts.delete(ref);
    }
    report();
  };

  const onLevel = (e) => {
    const n = Number(e.detail);
    if (n >= 0 && n <= 6) setLevel(n);
  };
  window.addEventListener("nerdfader3:level", onLevel);

  // Called by a newer copy of this script: undo everything here and hand over the state.
  const retire = () => {
    window.removeEventListener("nerdfader3:level", onLevel);
    for (const type of mediaEvents) document.removeEventListener(type, onMedia, true);
    removeEventListener("pointerdown", wake, true);
    removeEventListener("keydown", wake, true);
    if (Object.getOwnPropertyDescriptor(media, "volume").set === patchedVolume.set) Object.defineProperty(media, "volume", volume);
    if (media.play === patchedPlay) media.play = play;
    if (AudioNode.prototype.connect === patchedConnect) AudioNode.prototype.connect = connect;
    if (AudioNode.prototype.disconnect === patchedDisconnect) AudioNode.prototype.disconnect = disconnect;
    each((el) => volume.set.call(el, pageVolume.get(el)));
    if (boostCtx) boostCtx.onstatechange = null;
    return { pageVolume, elements, routed, encrypted, boostCtx, boostStage, stages, contexts };
  };
  Object.defineProperty(window, KEY, { value: { retire }, configurable: true });
  window.dispatchEvent(new Event("nerdfader3:ready"));
})();
