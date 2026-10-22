// Capture mode. The browser stops playing a captured tab's sound itself, so this page plays it back through a gain
// stage and a soft clipper. It tells the background when a tab has been quiet for a while (so capture can stop) and when
// a capture ends on its own (the tab closed, or the user stopped sharing).

const QUIET = 1e-4;          // peak level treated as silence (-80 dBFS)
const QUIET_FOR = 3000;      // ms of silence before capture stops
const softClipCurve = (() => {
  const curve = new Float32Array(4097), knee = 0.6, ceiling = 0.97;
  for (let i = 0; i < curve.length; i++) {
    const x = ((i / (curve.length - 1)) * 2 - 1) * 8, a = Math.abs(x);
    curve[i] = Math.sign(x) * (a < knee ? a : knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee)));
  }
  return curve;
})();
const sessions = new Map();  // tabId -> { stream, ctx, gain, peak, timer }
const tell = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

async function start({ tabId, streamId, gain }) {
  stop(tabId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
  });
  const ctx = new AudioContext({ sampleRate: 48000 });   // not the output device's rate, which can be 16 kHz
  const source = ctx.createMediaStreamSource(stream);
  const g = ctx.createGain();
  g.gain.value = 1;
  g.gain.setTargetAtTime(gain, ctx.currentTime, 0.02);
  // The same soft clipper as in pages (content/main.js): unchanged below 60% of full scale, then peaks rounded off
  // towards a 97% ceiling. The signal is scaled down by 8 to fit the shaper's -1..1 input.
  const scale = ctx.createGain();
  scale.gain.value = 1 / 8;
  const clipper = ctx.createWaveShaper();
  clipper.curve = softClipCurve;
  clipper.oversample = "4x";
  const meter = ctx.createAnalyser();
  meter.fftSize = 2048;
  source.connect(g).connect(scale).connect(clipper).connect(ctx.destination);
  source.connect(meter);

  const samples = new Float32Array(meter.fftSize);
  let quietSince = null;
  const session = { stream, ctx, gain: g, peak: 0 };
  session.timer = setInterval(() => {
    meter.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    session.peak = peak;
    if (peak > QUIET) { quietSince = null; return; }
    quietSince ??= Date.now();
    if (Date.now() - quietSince >= QUIET_FOR) { stop(tabId); tell({ type: "captureIdle", tabId }); }
  }, 250);

  stream.getAudioTracks()[0].addEventListener("ended", () => {
    if (sessions.get(tabId)?.stream !== stream) return;
    stop(tabId);
    tell({ type: "captureEnded", tabId });
  });
  sessions.set(tabId, session);
}

function stop(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  clearInterval(s.timer);
  s.stream.getTracks().forEach((t) => t.stop());
  s.ctx.close();
}

function setGain({ tabId, gain }) {
  const s = sessions.get(tabId);
  if (!s) return;
  s.gain.gain.cancelScheduledValues(0);
  s.gain.gain.setTargetAtTime(gain, s.ctx.currentTime, 0.01);
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== "offscreen") return false;
  const done = () => reply({ ok: true, active: sessions.size });
  // What each capture is doing (used by the tests): the gain applied and the last peak heard from the tab.
  if (msg.type === "stats") {
    reply(Object.fromEntries([...sessions].map(([id, s]) => [id, { gain: s.gain.gain.value, peak: s.peak }])));
    return false;
  }
  if (msg.type === "start") start(msg).then(done, (err) => reply({ ok: false, error: String(err), active: sessions.size }));
  else {
    if (msg.type === "stop") stop(msg.tabId);
    else if (msg.type === "gain") setGain(msg);
    done();
  }
  return true;
});
