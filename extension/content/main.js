// Runs in the page's own JavaScript world (MAIN) at document_start, in every frame, before the page's scripts.
// Scales everything the page plays by the tab's level without the page noticing:
// - <audio>/<video>: the real volume is the page's volume times the level (up to 1), and the volume getter keeps
//   returning the page's own value, so the site's slider still shows what the site set.
// - Above 100%, elements are routed through Web Audio: a gain stage and a limiter, so loud parts are held down
//   instead of distorting. Elements the browser won't let Web Audio hear (DRM, media from another site without
//   CORS) are left alone, and the frame reports why so the extension can offer capture mode instead.
// - Web Audio: connections to an AudioContext's destination go through one hidden gain stage per context.
// bridge.js (the extension's isolated world) sends the level as a "nerdfader:level" event on window, and passes
// this frame's "nerdfader:status" (why it can't boost, or "") back to the extension.
(() => {
  if (window.__nerdfaderPatched) return;
  Object.defineProperty(window, "__nerdfaderPatched", { value: true });

  let level = 1;
  const NativeAudioContext = window.AudioContext;   // pages sometimes replace it later
  const connect = AudioNode.prototype.connect;
  const disconnect = AudioNode.prototype.disconnect;

  // A gain stage in front of a context's speakers, with a limiter switched in only while boosting.
  function outputStage(ctx) {
    const gain = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.2;
    // Chromium's compressor adds make-up gain (0.6 x the gain reduction at 0 dBFS, ~1.1 dB here); take it back out
    // so a boost is exactly what the slider says.
    const trim = ctx.createGain();
    trim.gain.value = 10 ** (-(0.6 * 2 * (1 - 1 / 20)) / 20);
    connect.call(limiter, trim);
    connect.call(trim, ctx.destination);
    let limited = false;
    const set = (value, glide = true) => {
      const g = gain.gain;
      g.cancelScheduledValues(0);
      if (glide) g.setTargetAtTime(value, ctx.currentTime, 0.01);   // ~50 ms glide, no clicks while dragging
      else g.value = value;
      const boost = value > 1;
      if (boost === limited) return;
      // Connect the new path before dropping the old one so there is no gap.
      connect.call(gain, boost ? limiter : ctx.destination);
      disconnect.call(gain, boost ? ctx.destination : limiter);
      limited = boost;
    };
    connect.call(gain, ctx.destination);
    return { input: gain, set };
  }

  // <audio> and <video>
  const media = HTMLMediaElement.prototype;
  const volume = Object.getOwnPropertyDescriptor(media, "volume");
  const pageVolume = new WeakMap();   // element -> the volume the page asked for
  const elements = new Set();         // WeakRefs to every element we have touched, attached or not (new Audio())
  const routed = new WeakSet();       // elements playing through the boost stage
  const encrypted = new WeakSet();    // elements that announced DRM-protected media

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

  Object.defineProperty(media, "volume", {
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
  });

  const play = media.play;
  media.play = function () {
    track(this);
    if (level > 1) boost(this);
    return play.apply(this, arguments);
  };

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
  let boostCtx = null, boostStage = null, needsClick = false;
  function boostContext() {
    if (boostCtx) return boostCtx;
    // A fixed rate: the default follows the current output device, which can be a 16 kHz headset for a moment.
    boostCtx = new NativeAudioContext({ sampleRate: 48000 });
    boostStage = outputStage(boostCtx);
    boostStage.set(Math.max(level, 1), false);
    // Browsers only start audio after the user has interacted with the page (or it may autoplay with sound).
    // Until then, routing would mute the element, so wait for a click or key press in the page.
    const check = () => {
      needsClick = boostCtx.state !== "running";
      if (!needsClick && level > 1) each(boost);
      report();
    };
    boostCtx.onstatechange = check;
    setTimeout(check, 300);
    const wake = () => boostCtx.state !== "running" && boostCtx.resume();
    addEventListener("pointerdown", wake, true);
    addEventListener("keydown", wake, true);
    return boostCtx;
  }
  function boost(el) {
    if (routed.has(el) || blocker(el) !== "") return;
    if (boostContext().state !== "running") return;
    connect.call(boostCtx.createMediaElementSource(el), boostStage.input);
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
    window.dispatchEvent(new CustomEvent("nerdfader:status", { detail: status }));
  }

  // Elements that autoplay or start from the browser's own controls never call play() from script.
  const onMedia = (e) => {
    if (!(e.target instanceof HTMLMediaElement)) return;
    if (e.type === "encrypted") encrypted.add(e.target);
    track(e.target);
    if (level > 1 && (e.type === "play" || e.type === "playing")) boost(e.target);
    report();
  };
  for (const type of ["play", "playing", "pause", "ended", "emptied", "loadstart", "encrypted", "volumechange"]) {
    document.addEventListener(type, onMedia, true);
  }

  // Web Audio made by the page
  const stages = new WeakMap();       // AudioContext -> its output stage
  const contexts = new Set();         // WeakRefs to those contexts

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

  AudioNode.prototype.connect = function (target, ...rest) {
    if (isSpeakers(target) && target.context !== boostCtx) {
      connect.call(this, stageFor(target.context), ...rest);
      return target;
    }
    return connect.call(this, target, ...rest);
  };
  AudioNode.prototype.disconnect = function (target, ...rest) {
    if (isSpeakers(target) && stages.has(target.context)) return disconnect.call(this, stages.get(target.context).input, ...rest);
    return disconnect.apply(this, arguments);
  };

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

  window.addEventListener("nerdfader:level", (e) => {
    const n = Number(e.detail);
    if (n >= 0 && n <= 6) setLevel(n);
  });
  window.dispatchEvent(new Event("nerdfader:ready"));
})();
