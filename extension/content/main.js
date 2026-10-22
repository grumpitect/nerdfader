// Runs in the page's own JavaScript world (MAIN) at document_start, in every frame, before the page's scripts.
// Scales everything the page plays by the tab's level without the page noticing:
// - <audio>/<video>: the real volume is the page's volume times the level, and the volume getter keeps returning
//   the page's own value, so the site's slider still shows what the site set.
// - Web Audio: connections to an AudioContext's destination go through one hidden GainNode per context.
// bridge.js (the extension's isolated world) sends the level as a "nerdfader:level" event on window.
(() => {
  if (window.__nerdfaderPatched) return;
  Object.defineProperty(window, "__nerdfaderPatched", { value: true });

  let level = 1;

  // <audio> and <video>
  const media = HTMLMediaElement.prototype;
  const volume = Object.getOwnPropertyDescriptor(media, "volume");
  const pageVolume = new WeakMap();   // element -> the volume the page asked for
  const elements = new Set();         // WeakRefs to every element we have touched, attached or not (new Audio())

  const apply = (el) => {
    const want = Math.min(1, Math.max(0, pageVolume.get(el) * level));
    if (volume.get.call(el) !== want) volume.set.call(el, want);
  };
  const track = (el) => {
    if (pageVolume.has(el)) return;
    pageVolume.set(el, volume.get.call(el));
    elements.add(new WeakRef(el));
    apply(el);
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
    return play.apply(this, arguments);
  };
  // Elements that autoplay or start from the browser's own controls never call play() from script.
  document.addEventListener("play", (e) => e.target instanceof HTMLMediaElement && track(e.target), true);
  document.addEventListener("loadstart", (e) => e.target instanceof HTMLMediaElement && track(e.target), true);

  // Web Audio
  const gains = new WeakMap();        // AudioContext -> GainNode in front of its destination
  const contexts = new Set();         // WeakRefs to those contexts
  const connect = AudioNode.prototype.connect;
  const disconnect = AudioNode.prototype.disconnect;

  const gainFor = (ctx) => {
    let gain = gains.get(ctx);
    if (!gain) {
      gain = ctx.createGain();
      gain.gain.value = level;
      connect.call(gain, ctx.destination);
      gains.set(ctx, gain);
      contexts.add(new WeakRef(ctx));
    }
    return gain;
  };
  // Offline contexts render to a buffer, not the speakers, so they are left alone.
  const isSpeakers = (node) =>
    node instanceof AudioDestinationNode && typeof AudioContext !== "undefined" && node.context instanceof AudioContext;

  AudioNode.prototype.connect = function (target, ...rest) {
    if (isSpeakers(target)) {
      connect.call(this, gainFor(target.context), ...rest);
      return target;
    }
    return connect.call(this, target, ...rest);
  };
  AudioNode.prototype.disconnect = function (target, ...rest) {
    if (isSpeakers(target) && gains.has(target.context)) return disconnect.call(this, gains.get(target.context), ...rest);
    return disconnect.apply(this, arguments);
  };

  const setLevel = (next) => {
    level = next;
    for (const el of document.querySelectorAll("audio, video")) track(el);
    for (const ref of elements) {
      const el = ref.deref();
      el ? apply(el) : elements.delete(ref);
    }
    for (const ref of contexts) {
      const ctx = ref.deref();
      if (!ctx) { contexts.delete(ref); continue; }
      const g = gains.get(ctx).gain;
      g.cancelScheduledValues(0);
      g.setTargetAtTime(level, ctx.currentTime, 0.01);   // ~50 ms glide, no clicks while dragging
    }
  };

  window.addEventListener("nerdfader:level", (e) => {
    const n = Number(e.detail);
    if (n >= 0 && n <= 1) setLevel(n);
  });
  window.dispatchEvent(new Event("nerdfader:ready"));
})();
