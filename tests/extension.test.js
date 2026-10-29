// End-to-end tests: loads the unpacked extension into Playwright's Chromium and checks what pages actually play at.
// "page" values are what the site sees (element.volume in its own world); "real" values are what the browser plays
// at, read from an isolated world where the volume property is not patched; "heard" values are peaks of a tab's
// actual sound output, captured the same way capture mode does it.
//
// The browser's audio output is switched off (--disable-audio-output): pages still play, still count as playing
// sound, and tab capture still hears them, but nothing reaches the speakers.
// The extension is allowlisted for tab capture, which skips the browser's "user opened the extension on this tab"
// rule; that rule itself can only be checked by hand.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const EXT = fs.realpathSync(fileURLToPath(new URL("../extension", import.meta.url)));
// The id Chromium gives an unpacked extension: the SHA-256 of its path, as letters a to p.
const EXT_ID = [...crypto.createHash("sha256").update(EXT).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
const TONE = 0.001;   // -60 dBFS
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} expected ${b}, got ${a}`);
const gain = (p) => (p <= 100 ? (p / 100) ** 3 : p / 100);

let server, origin, otherOrigin, context, ext, sw;

const pages = {
  "/": `<!doctype html><title>t</title><audio id="a"></audio><video id="v"></video>
        <iframe id="f"></iframe>
        <script>document.getElementById("a").volume = 0.8;</script>`,
  "/frame": `<!doctype html><audio id="inner"></audio><script>document.getElementById("inner").volume = 0.5;</script>`,
  "/player": `<!doctype html><title>player</title>`,
  // Something to see behind the dialog's blur in the README screenshot.
  "/demo": `<!doctype html><title>demo</title><body style="margin:0;font:600 28px system-ui;color:#fff;background:#0d0d14">
    <div style="height:62vh;background:linear-gradient(135deg,#ff4fa8,#6b3bff 55%,#1fc8ff);display:grid;place-items:center">▶ some video</div>
    <div style="padding:24px 32px;font-size:20px;color:#bbb">A very good video, with a title long enough to wrap behind the blur.</div></body>`,
};

// 16-bit mono WAV of a 19 kHz tone at TONE; parts alternate sound and silence, in seconds.
function wav(...parts) {
  const rate = 44100, total = parts.reduce((a, b) => a + b, 0) * rate;
  const b = Buffer.alloc(44 + total * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + total * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(total * 2, 40);
  let i = 0;
  parts.forEach((secs, n) => {
    for (let k = 0; k < secs * rate; k++, i++) {
      const v = n % 2 === 0 ? Math.round(TONE * 32767 * Math.sin((2 * Math.PI * 19000 * i) / rate)) : 0;
      b.writeInt16LE(v, 44 + i * 2);
    }
  });
  return b;
}
// Loud and dynamic like real speech or music: a body averaging about -20 dBFS with short peaks near full scale
// (5 ms at 90%, four times a second).
function loudWav(secs) {
  const rate = 44100, total = secs * rate, b = Buffer.alloc(44 + total * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + total * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(total * 2, 40);
  for (let i = 0; i < total; i++) {
    const t = i / rate, env = (t * 4) % 1 < 0.02 ? 0.9 : 0.15 + 0.03 * Math.sin(t * 7);
    b.writeInt16LE(Math.round(env * 32767 * Math.sin(2 * Math.PI * 1000 * t)), 44 + i * 2);
  }
  return b;
}
// A badly recorded talk, for voice fix, as 48 kHz stereo: the "voice" (a 2.5 kHz tone, 1 s on and 0.5 s off) only
// in the left ear, 60 Hz mains hum (its odd harmonics, 180 to 1980 Hz) in both, and quiet background noise.
const HUM = [180, 540, 900, 1500, 1980];   // hum harmonics the tests measure
function talkWav(secs) {
  const rate = 48000, total = secs * rate, b = Buffer.alloc(44 + total * 4);
  b.write("RIFF", 0); b.writeUInt32LE(36 + total * 4, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(total * 4, 40);
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < total; i++) {
    const t = i / rate;
    let hum = 0;
    for (let h = 3; h <= 33; h += 2) hum += 0.002 * Math.sin(2 * Math.PI * 60 * h * t + h);
    const voice = t % 1.5 < 1 ? 0.05 * Math.sin(2 * Math.PI * 2500 * t) : 0;
    b.writeInt16LE(Math.round(32767 * (voice + hum + 0.0005 * rand())), 44 + i * 4);
    b.writeInt16LE(Math.round(32767 * (hum + 0.0005 * rand())), 46 + i * 4);
  }
  return b;
}
// Talk the way YouTube's Stable Volume leaves it: the voice (2.5 kHz, 1 s) and pauses (0.5 s of 700 Hz) only 10 dB
// apart, the same in both ears, with 60 Hz hum (which is what makes voice fix switch Stable Volume off).
function liftedWav(secs) {
  const rate = 48000, total = secs * rate, b = Buffer.alloc(44 + total * 4);
  b.write("RIFF", 0); b.writeUInt32LE(36 + total * 4, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(total * 4, 40);
  for (let i = 0; i < total; i++) {
    const t = i / rate;
    let v = t % 1.5 < 1 ? 0.05 * Math.sin(2 * Math.PI * 2500 * t) : 0.0158 * Math.sin(2 * Math.PI * 700 * t);
    for (let h = 3; h <= 33; h += 2) v += 0.001 * Math.sin(2 * Math.PI * 60 * h * t + h);
    v += 0.0003 * Math.sin(i * 12.9898) * Math.sin(i * 78.233);   // a little noise
    b.writeInt16LE(Math.round(32767 * v), 44 + i * 4);
    b.writeInt16LE(Math.round(32767 * v), 46 + i * 4);
  }
  return b;
}
const sounds = { "/tone.wav": wav(30), "/gap.wav": wav(1, 5, 30), "/loud.wav": loudWav(30), "/talk.wav": talkWav(30), "/lifted.wav": liftedWav(40) };

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (sounds[path]) {
      res.setHeader("content-type", "audio/wav");
      return res.end(sounds[path]);
    }
    res.setHeader("content-type", "text/html");
    res.end(pages[path] ?? "");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  origin = `http://127.0.0.1:${port}`;
  otherOrigin = `http://localhost:${port}`;   // a different origin, for the cross-origin iframe
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    deviceScaleFactor: 2,
    ignoreDefaultArgs: ["--mute-audio"],
    args: [
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--allowlisted-extension-id=${EXT_ID}`,
      "--autoplay-policy=no-user-gesture-required",
      // Otherwise Bluetooth headphones' media buttons (or macOS on their behalf) can pause the test players.
      "--disable-features=MediaSessionService",
      // No sound reaches the speakers; pages still play, count as playing sound, and can be captured.
      "--disable-audio-output",
      // For the README screenshot: a reserved documentation domain instead of the test server's address.
      "--host-resolver-rules=MAP video.example 127.0.0.1",
    ],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  // Most tests check the wanted defaults, so they run as Arc would (a separate test covers other browsers).
  await sw.evaluate(() => chrome.storage.local.set({ browser: "arc" }));
  const id = new URL(sw.url()).host;
  assert.equal(id, EXT_ID, "extension id (needed for the capture allowlist)");
  ext = await context.newPage();
  await ext.goto(`chrome-extension://${id}/popup/popup.html`);
});

after(async () => {
  await context?.close();
  server?.close();
});

const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
// The newest tab at that origin (an earlier failed test may leave its tab open).
const tabIdOf = (url) => ext.evaluate(async (u) => Math.max(...(await chrome.tabs.query({ url: u + "/*" })).map((t) => t.id)), url);
// Real volumes of every <audio>/<video> in every frame of the tab, keyed by element id.
const real = (tabId) =>
  ext.evaluate(async (tabId) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => Object.fromEntries([...document.querySelectorAll("audio,video")].map((e) => [e.id, e.volume])),
    });
    return Object.assign({}, ...results.map((r) => r.result));
  }, tabId);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => wait(150);

// Peak of what the tab actually outputs over half a second.
const heard = (tabId) =>
  ext.evaluate(async (tabId) => {
    const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: id } },
    });
    const ctx = new AudioContext({ sampleRate: 48000 });   // not the output's rate, which may be 16 kHz on a headset
    const meter = ctx.createAnalyser();
    meter.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(meter);
    const samples = new Float32Array(2048);
    let peak = 0;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 50));
      meter.getFloatTimeDomainData(samples);
      for (const s of samples) peak = Math.max(peak, Math.abs(s));
    }
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    return peak;
  }, tabId);
// Loudness (RMS, in dBFS) of what the tab outputs over 1.5 s, and the share of samples at full scale (crackle).
const loudness = (tabId) =>
  ext.evaluate(async (tabId) => {
    const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: id } },
    });
    const ctx = new AudioContext({ sampleRate: 48000 });
    const meter = ctx.createAnalyser();
    meter.fftSize = 4096;
    ctx.createMediaStreamSource(stream).connect(meter);
    const samples = new Float32Array(4096);
    let sum = 0, n = 0, full = 0;
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 85));
      meter.getFloatTimeDomainData(samples);
      for (const s of samples) { sum += s * s; n++; if (Math.abs(s) >= 0.999) full++; }
    }
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    return { db: 20 * Math.log10(Math.sqrt(sum / n)), clipped: full / n };
  }, tabId);
const ratio = (a, b, want, msg) => assert.ok(Math.abs(a / b - want) / want < 0.08, `${msg ?? ""} expected x${want}, got x${(a / b).toFixed(3)} (${a} / ${b})`);

// A tab playing a looping tone in an <audio>, from this origin or another one.
async function openPlayer(src = "/tone.wav", { from = origin, loop = true } = {}) {
  const page = await context.newPage();
  await page.goto(origin + "/player");
  await page.evaluate(async ([src, loop]) => {
    const a = document.createElement("audio");
    a.id = "a"; a.src = src; a.loop = loop;
    document.body.append(a);
    await a.play();
  }, [from === origin ? src : from + src, loop]);
  await wait(300);
  return { page, tabId: await tabIdOf(origin) };
}
const captureState = async (tabId) => (await send({ type: "state", tabId })).capture;
// Per-tab capture stats from the offscreen page; {} once it has closed.
const offscreenStats = () => send({ target: "offscreen", type: "stats" }).then((r) => r ?? {}, () => ({}));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await wait(100);
  }
}

async function openTestPage() {
  const page = await context.newPage();
  await page.goto(origin + "/");
  await page.evaluate((src) => (document.getElementById("f").src = src), otherOrigin + "/frame");
  await page.frameLocator("#f").locator("#inner").waitFor({ state: "attached" });
  await settle();
  return { page, tabId: await tabIdOf(origin) };
}

test("a tab plays at 100% until it is changed", async () => {
  const { page, tabId } = await openTestPage();
  const r = await real(tabId);
  near(r.a, 0.8); near(r.v, 1); near(r.inner, 0.5);
  await page.close();
});

test("setting a tab scales its media, in every frame, while the page still sees its own volume", async () => {
  const { page, tabId } = await openTestPage();
  const state = await send({ type: "setTab", tabId, percent: 50 });
  assert.equal(state.tab, 50);
  await settle();
  const r = await real(tabId);
  near(r.a, 0.8 * gain(50), "audio"); near(r.v, gain(50), "video"); near(r.inner, 0.5 * gain(50), "cross-origin iframe");
  near(await page.evaluate(() => document.getElementById("a").volume), 0.8, "page-visible volume");

  // The page changing its own volume keeps being scaled.
  await page.evaluate(() => (document.getElementById("a").volume = 0.4));
  near((await real(tabId)).a, 0.4 * gain(50));
  near(await page.evaluate(() => document.getElementById("a").volume), 0.4);

  // Elements made later, including ones made with new Audio() and played before joining the page.
  await page.evaluate(() => {
    const el = new Audio(); el.id = "late"; el.volume = 0.5; el.play().catch(() => {}); document.body.append(el);
  });
  near((await real(tabId)).late, 0.5 * gain(50), "new Audio()");

  // Invalid values still throw like the browser's own setter.
  assert.equal(await page.evaluate(() => { try { document.getElementById("a").volume = 2; return "no"; } catch (e) { return e.name; } }), "IndexSizeError");
  await page.close();
});

test("a tab's volume survives reloads, and is forgotten when the tab closes", async () => {
  const { page, tabId } = await openTestPage();
  await send({ type: "setTab", tabId, percent: 30 });
  await page.reload();
  await settle();
  near((await real(tabId)).a, 0.8 * gain(30));
  await page.close();
  await settle();
  assert.equal((await send({ type: "state", tabId })).tab, 100);
});

test("override sets every tab, and turning it off restores each tab's own volume", async () => {
  const one = await openTestPage();
  await send({ type: "setTab", tabId: one.tabId, percent: 60 });
  const two = await context.newPage();
  await two.goto(otherOrigin + "/frame");
  const twoId = await tabIdOf(otherOrigin);
  await settle();
  near((await real(twoId)).inner, 0.5);

  await send({ type: "setOverride", on: true, percent: 20 });
  await settle();
  near((await real(one.tabId)).a, 0.8 * gain(20));
  near((await real(twoId)).inner, 0.5 * gain(20));

  // Changing a tab while the override is on is remembered for later but not played.
  await send({ type: "setTab", tabId: one.tabId, percent: 70 });
  await settle();
  near((await real(one.tabId)).a, 0.8 * gain(20));

  // New pages pick up the override as they load.
  await two.reload();
  await settle();
  near((await real(twoId)).inner, 0.5 * gain(20));

  const state = await send({ type: "setOverride", on: false, tabId: one.tabId });
  assert.equal(state.tab, 70);
  assert.deepEqual(state.override, { on: false, percent: 20 });
  await settle();
  near((await real(one.tabId)).a, 0.8 * gain(70));
  near((await real(twoId)).inner, 0.5);

  // Reset: 100% removes the tab's own setting.
  await send({ type: "setTab", tabId: one.tabId, percent: 100 });
  await settle();
  near((await real(one.tabId)).a, 0.8);
  await one.page.close();
  await two.close();
});

test("Web Audio goes through a gain node that follows the tab's volume", async () => {
  const { page, tabId } = await openTestPage();
  // Record the gain nodes the extension creates, then connect a source straight to the speakers.
  await page.evaluate(() => {
    const created = (window.created = []);
    const make = BaseAudioContext.prototype.createGain;
    BaseAudioContext.prototype.createGain = function () { const g = make.call(this); created.push(g); return g; };
    window.ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const silent = new GainNode(ctx, { gain: 0 });   // the graph is what's being tested, not the sound
    osc.connect(silent);
    window.returned = silent.connect(ctx.destination) === ctx.destination;
    osc.start();
  });
  assert.equal(await page.evaluate(() => window.returned), true, "connect() returns the destination for chaining");
  // The extension's stage: its input (the level) first, then the dry path, its output and the clipper's input
  // scaling. Voice fix's path is only built once it is turned on.
  assert.equal(await page.evaluate(() => created.length), 4);
  near(await page.evaluate(() => created[0].gain.value), 1);

  await send({ type: "setTab", tabId, percent: 40 });
  await new Promise((r) => setTimeout(r, 400));   // the gain glides over ~50 ms
  const value = await page.evaluate(() => created[0].gain.value);
  assert.ok(Math.abs(value - gain(40)) < 1e-3, `gain ${value}`);
  await send({ type: "setTab", tabId, percent: 150 });
  await new Promise((r) => setTimeout(r, 400));
  const boosted = await page.evaluate(() => created[0].gain.value);
  assert.ok(Math.abs(boosted - gain(150)) < 1e-2, `boosted gain ${boosted}`);
  await send({ type: "setTab", tabId, percent: 100 });

  // Offline rendering is not touched.
  assert.equal(await page.evaluate(() => {
    const off = new OfflineAudioContext(1, 128, 44100);
    off.createOscillator().connect(off.destination);
    return created.length;
  }), 4);
  await page.close();
});

test("tabs opened before the extension loaded get it when it is installed", async () => {
  // On install the background injects both scripts into open tabs. Here the page already has them, so this also
  // checks that injecting a second time does not patch twice (which would square the volume).
  const { page, tabId } = await openTestPage();
  await ext.evaluate(async (tabId) => {
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ["content/voice.js", "content/main.js"], world: "MAIN" });
    await chrome.scripting.executeScript({ target, files: ["content/bridge.js"] });
  }, tabId);
  await send({ type: "setTab", tabId, percent: 50 });
  await settle();
  near((await real(tabId)).a, 0.8 * gain(50), "applied once, not squared");
  await send({ type: "setTab", tabId, percent: 100 });
  await page.close();
});

test("the toolbar popup (for pages the dialog can't open in) shows and changes the current tab", async () => {
  const { page, tabId } = await openTestPage();
  const url = page.url();
  const popup = await context.newPage();
  // A popup opened as a tab would see itself as the active tab, so point it at the test page.
  await popup.addInitScript(([tabId, url]) => {
    chrome.tabs.query = async () => [{ id: tabId, url }];
  }, [tabId, url]);
  await popup.setViewportSize({ width: 320, height: 300 });
  await popup.goto(ext.url());
  await popup.locator(".percent", { hasText: "100%" }).waitFor();
  assert.equal(await popup.locator(".target").textContent(), "127.0.0.1");

  await popup.keyboard.press("4");
  await popup.locator(".percent", { hasText: "40%" }).waitFor();
  await settle();
  near((await real(tabId)).a, 0.8 * gain(40));
  await popup.keyboard.press("ArrowRight");
  await popup.locator(".percent", { hasText: "45%" }).waitFor();
  await popup.click(".reset");
  await popup.locator(".percent", { hasText: "100%" }).waitFor();
  assert.equal(await popup.locator(".reset").isDisabled(), true);

  await popup.click("label.toggle:has(.override)");
  await popup.locator(".target", { hasText: "all tabs" }).waitFor();
  await popup.keyboard.press("3");
  await settle();
  near((await real(tabId)).a, 0.8 * gain(30));
  await popup.click("label.toggle:has(.override)");
  await popup.locator(".target", { hasText: "127.0.0.1" }).waitFor();
  await send({ type: "setOverride", on: false, percent: 100 });
  await send({ type: "setTab", tabId, percent: 100 });
  await popup.close();

  await page.close();
});

test("above 100% a page boosts itself, through a limiter, and the site still sees its own volume", async () => {
  const { page, tabId } = await openPlayer();
  const base = await heard(tabId);
  assert.ok(base > TONE * 0.9, `the tone is audible (${base})`);
  await send({ type: "setTab", tabId, percent: 150 });
  await settle();
  ratio(await heard(tabId), base, gain(150), "150%");
  await send({ type: "setTab", tabId, percent: 600 });
  await settle();
  ratio(await heard(tabId), base, 6, "600%");
  near(await page.evaluate(() => document.getElementById("a").volume), 1, "page-visible volume");
  const state = await send({ type: "state", tabId });
  assert.equal(state.status, "", "no blocker reported");
  assert.equal(state.capture, "off");

  // Back under 100% the routed element still follows the slider.
  await send({ type: "setTab", tabId, percent: 50 });
  await settle();
  ratio(await heard(tabId), base, gain(50), "50% after boosting");
  await send({ type: "setTab", tabId, percent: 100 });
  await page.close();
});

test("media from another site without CORS is never silenced; the tab reports it instead", async () => {
  const { page, tabId } = await openPlayer("/tone.wav", { from: otherOrigin });
  const base = await heard(tabId);
  await send({ type: "setTab", tabId, percent: 200 });
  await settle();
  ratio(await heard(tabId), base, 1, "still plays at 100%");
  const state = await send({ type: "state", tabId });
  assert.equal(state.status, "cross-origin");
  assert.equal(state.capture, "off", "capture mode waits to be allowed");
  assert.equal(state.allowed, false);
  await send({ type: "setTab", tabId, percent: 100 });
  await page.close();
});

test("capture mode boosts a blocked tab, stops when it pauses, and restarts when it plays", async () => {
  const { page, tabId } = await openPlayer("/tone.wav", { from: otherOrigin });
  await send({ type: "setTab", tabId, percent: 150 });
  await settle();
  const state = await send({ type: "setCapture", tabId, once: true });
  assert.equal(state.capture, "on");
  await wait(500);
  const stats = (await offscreenStats())[tabId];
  near(Math.round(stats.gain * 1000) / 1000, Math.round(gain(150) * 1000) / 1000, "capture gain");
  assert.ok(stats.peak > TONE * 0.9, `capture hears the tab (${stats.peak})`);
  near((await real(tabId)).a, 1, "the page itself stays at 100%");

  // Changing the volume while capturing changes the capture's gain.
  await send({ type: "setTab", tabId, percent: 180 });
  await wait(300);
  assert.ok(Math.abs((await offscreenStats())[tabId].gain - gain(180)) < 0.01);

  // Pausing stops capture shortly after (not instantly, so a quick pause/resume doesn't flicker).
  await page.evaluate(() => document.getElementById("a").pause());
  await wait(500);
  assert.equal(await captureState(tabId), "on", "still on right after pausing");
  assert.equal(await until(async () => (await captureState(tabId)) === "off"), true, "stops after the grace period");
  assert.deepEqual(await offscreenStats(), {}, "offscreen page closed");

  // Playing again starts it again.
  await page.evaluate(() => document.getElementById("a").play());
  assert.equal(await until(async () => (await captureState(tabId)) === "on"), true, "restarts on play");

  // Dropping to 100% or below stops it right away.
  await send({ type: "setTab", tabId, percent: 100 });
  assert.equal(await captureState(tabId), "off");
  await page.close();
});

test("capture mode goes idle while a tab plays silence, and comes back with the sound", async () => {
  // 1 s of tone, then 5 s of silence while the element keeps playing, then tone again.
  const { page, tabId } = await openPlayer("/gap.wav", { from: otherOrigin, loop: false });
  await send({ type: "setCapture", tabId, always: true });
  await send({ type: "setTab", tabId, percent: 150 });
  assert.equal(await captureState(tabId), "on");
  assert.equal(await until(async () => (await captureState(tabId)) === "idle", 6000), true, "idle after 3 s of silence");
  assert.equal(await until(async () => (await captureState(tabId)) === "on", 6000), true, "on again when sound returns");
  await send({ type: "setCapture", tabId, always: false });
  assert.equal(await captureState(tabId), "off", "turning 'always' off stops it");
  await send({ type: "setTab", tabId, percent: 100 });
  await page.close();
});

test("closing a captured tab ends its capture", async () => {
  const { page, tabId } = await openPlayer("/tone.wav", { from: otherOrigin });
  await send({ type: "setTab", tabId, percent: 150 });
  assert.equal((await send({ type: "setCapture", tabId, once: true })).capture, "on");
  await page.close();
  assert.equal(await until(async () => Object.keys(await offscreenStats()).length === 0), true);
});

// The dialog lives in a closed shadow root, so these tests drive it the way a person does: keys and clicks.
const dialogOpen = (page) => page.evaluate(() => !!document.querySelector("nerdfader-dialog"));
// Open and showing its values, so it reacts to keys.
const dialogReady = (page) => page.evaluate(() => document.querySelector("nerdfader-dialog")?.dataset.ready !== undefined);
const openDialog = async (page, tabId) => {
  await sw.evaluate(async (tabId) => openPanel(await chrome.tabs.get(tabId)), tabId);
  await until(() => dialogReady(page), 2000);
};

test("the toolbar icon opens a dialog in the page that changes the tab, and closes on Esc, outside clicks or a second click", async () => {
  const { page, tabId } = await openTestPage();
  await page.evaluate(() => { window.pageKeys = 0; document.addEventListener("keydown", () => window.pageKeys++); });
  await openDialog(page, tabId);
  assert.equal(await dialogOpen(page), true);

  await page.keyboard.press("4");
  await settle();
  near((await real(tabId)).a, 0.8 * gain(40), "keys in the dialog change the tab");
  assert.equal(await page.evaluate(() => window.pageKeys), 0, "the page doesn't see keys typed in the dialog");

  await page.keyboard.press("Escape");
  assert.equal(await until(async () => !(await dialogOpen(page)), 1000), true, "Esc closes");

  await openDialog(page, tabId);
  await page.mouse.click(5, 5);
  assert.equal(await until(async () => !(await dialogOpen(page)), 1000), true, "a click outside closes");

  await openDialog(page, tabId);
  await wait(200);   // a person's second click
  await sw.evaluate(async (tabId) => openPanel(await chrome.tabs.get(tabId)), tabId);
  assert.equal(await until(async () => !(await dialogOpen(page)), 1000), true, "clicking the icon again closes");

  await send({ type: "setTab", tabId, percent: 100 });
  await page.close();

  // SCREENSHOT=docs/dialog.png npm test: renders the dialog for the README.
  if (process.env.SCREENSHOT) {
    const demo = await context.newPage();
    await demo.setViewportSize({ width: 880, height: 620 });
    const demoOrigin = origin.replace("127.0.0.1", "video.example");
    await demo.goto(demoOrigin + "/demo");
    const demoId = await tabIdOf(demoOrigin);
    await send({ type: "setTab", tabId: demoId, percent: 250 });
    // voice_fix on, as it looks once it has found hum.
    await send({ type: "setVoice", tabId: demoId, on: true });
    await sw.evaluate((tabId) => chrome.storage.session.set({ [`hum:${tabId}`]: { 0: JSON.stringify({ hum: "60", mono: true, boom: true }) } }), demoId);
    await openDialog(demo, demoId);
    await demo.evaluate(() => document.activeElement?.blur());
    await wait(300);
    await demo.screenshot({ path: process.env.SCREENSHOT });
    await send({ type: "setTab", tabId: demoId, percent: 100 });
    await send({ type: "setVoice", tabId: demoId, on: false });
    await demo.close();
  }
});

test("pages the dialog can't open in get the toolbar popup instead", async () => {
  const page = await context.newPage();
  await page.goto("chrome://version");
  const tabId = await ext.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((t) => t.id)));
  await sw.evaluate(async (tabId) => openPanel(await chrome.tabs.get(tabId)), tabId);
  assert.equal(await sw.evaluate((tabId) => chrome.action.getPopup({ tabId }), tabId), `chrome-extension://${EXT_ID}/popup/popup.html`);
  await page.close();
});

test("a newer copy of the page script takes over from an older one, boosts included", async () => {
  const { page, tabId } = await openPlayer();
  const base = await heard(tabId);
  await send({ type: "setTab", tabId, percent: 300 });
  await settle();
  ratio(await heard(tabId), base, 3, "boosted by the first copy");
  // What an extension update does to open tabs: inject the new scripts next to the old ones.
  await ext.evaluate(async (tabId) => {
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ["content/voice.js", "content/main.js"], world: "MAIN" });
    await chrome.scripting.executeScript({ target, files: ["content/bridge.js"] });
  }, tabId);
  await send({ type: "setTab", tabId, percent: 200 });
  await settle();
  ratio(await heard(tabId), base, 2, "the new copy controls the element the old one routed");
  await send({ type: "setTab", tabId, percent: 50 });
  await settle();
  ratio(await heard(tabId), base, gain(50), "and turns it down");
  await send({ type: "setTab", tabId, percent: 100 });
  await page.close();
});

test("version 1.0's page script left in an open tab doesn't stop the new one", async () => {
  // Load 1.0's main.js and then this one into a plain page, the way an update leaves them, and drive them by hand.
  const { execSync } = await import("node:child_process");
  const old = execSync("git show v1.0.0:extension/content/main.js").toString();
  const now = ["voice.js", "main.js"].map((f) => fs.readFileSync(`${EXT}/content/${f}`, "utf8")).join("\n");
  const plain = await chromium.launch();   // no extension, so only these two copies run
  const page = await plain.newPage();
  await page.goto(origin + "/player");
  const realVolume = await page.evaluate(([old, now]) => {
    const native = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
    const a = document.createElement("audio");
    // Run 1.0 the way it ran in its own world, then the new copy.
    new Function(old)();
    window.dispatchEvent(new CustomEvent("nerdfader:level", { detail: 0.125 }));   // 1.0 had this tab at 50%
    new Function(now)();
    a.volume = 0.8;
    window.dispatchEvent(new CustomEvent("nerdfader3:level", { detail: 0.125 }));
    return [native.get.call(a), a.volume];
  }, [old, now]);
  near(realVolume[0], 0.8 * 0.125, "scaled once, by the new copy");
  near(realVolume[1], 0.8, "page still sees its own volume");
  await plain.close();
});

test("the panel explains itself instead of breaking when the background doesn't answer", async () => {
  const popup = await context.newPage();
  await popup.addInitScript(() => {
    chrome.tabs.query = async () => [{ id: 1, url: "https://example.com/" }];
    chrome.runtime.sendMessage = async () => undefined;   // like an outdated background after an update
  });
  const errors = [];
  popup.on("pageerror", (e) => errors.push(e.message));
  await popup.goto(ext.url());
  await popup.locator(".target", { hasText: "Nerdfader was just updated" }).waitFor();
  assert.equal(await popup.locator(".slider").isVisible(), false);
  assert.deepEqual(errors, []);
  await popup.close();
});

test("boosting loud audio makes it clearly louder without crackling", async () => {
  const { page, tabId } = await openPlayer("/loud.wav");
  const levels = {};
  for (const p of [100, 200, 400, 600]) {
    await send({ type: "setTab", tabId, percent: p });
    await settle();
    levels[p] = await loudness(tabId);
  }
  const gainDb = (p) => levels[p].db - levels[100].db;
  console.log(`    loud audio: +${gainDb(200).toFixed(1)} dB at 200%, +${gainDb(400).toFixed(1)} at 400%, +${gainDb(600).toFixed(1)} at 600%`);
  assert.ok(gainDb(200) > 4.5, "200% is clearly louder");
  assert.ok(gainDb(400) > gainDb(200) + 3, "400% is clearly louder than 200%");
  assert.ok(gainDb(600) > gainDb(400) + 1.5, "600% is louder than 400%");
  for (const p of [200, 400, 600]) assert.ok(levels[p].clipped < 0.001, `no hard clipping at ${p}% (${levels[p].clipped})`);
  await send({ type: "setTab", tabId, percent: 100 });
  await page.close();
});

test("the shortcut (Command+Shift+End by default) opens and closes the dialog on the page; a new one can be recorded", async () => {
  const { page, tabId } = await openTestPage();
  await page.keyboard.press("Meta+Shift+End");
  assert.equal(await until(() => dialogReady(page), 2000), true, "default shortcut opens");
  await page.keyboard.press("Meta+Shift+End");
  assert.equal(await until(async () => !(await dialogOpen(page)), 1000), true, "and closes");

  // Record Ctrl+Shift+K in the panel (the toolbar popup shows the same panel without a shadow root).
  const popup = await context.newPage();
  await popup.addInitScript(([tabId, url]) => { chrome.tabs.query = async () => [{ id: tabId, url }]; }, [tabId, page.url()]);
  await popup.goto(ext.url());
  await popup.locator('.shortcutBtn[data-setting="shortcut"]', { hasText: "⇧⌘End" }).waitFor();
  await popup.click('.shortcutBtn[data-setting="shortcut"]');
  await popup.locator('.shortcutBtn[data-setting="shortcut"]', { hasText: "press keys" }).waitFor();
  await popup.keyboard.press("Control+Shift+KeyK");
  await popup.locator('.shortcutBtn[data-setting="shortcut"]', { hasText: "⌃⇧K" }).waitFor();
  await popup.close();
  await settle();

  await page.bringToFront();
  await page.keyboard.press("Meta+Shift+End");
  await wait(400);
  assert.equal(await dialogOpen(page), false, "the old shortcut no longer opens it");
  await page.keyboard.press("Control+Shift+KeyK");
  assert.equal(await until(() => dialogReady(page), 2000), true, "the recorded shortcut opens it");
  await page.keyboard.press("Escape");
  assert.equal(await until(async () => !(await dialogOpen(page)), 1000), true, "Esc closes it");

  // A shortcut without Ctrl/Alt/Cmd doesn't fire while typing in a text field.
  await send({ type: "setSettings", shortcut: { code: "KeyQ", alt: false, ctrl: false, meta: false, shift: false } });
  await settle();
  await page.evaluate(() => { const i = document.createElement("input"); i.id = "field"; document.body.append(i); i.focus(); });
  await page.keyboard.press("KeyQ");
  await wait(400);
  const where = await page.evaluate(() => document.activeElement?.tagName);
  assert.equal(await dialogOpen(page), false, `not while typing (focus was on ${where})`);
  assert.equal(await page.inputValue("#field"), "q");
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press("KeyQ");
  assert.equal(await until(() => dialogReady(page), 2000), true, "fires outside text fields");
  await page.keyboard.press("Escape");
  await until(async () => !(await dialogOpen(page)), 1000);

  await send({ type: "setSettings", shortcut: { code: "End", alt: false, ctrl: false, meta: true, shift: true } });
  await page.close();
});

test("Option/Alt + scroll changes the volume and shows the dialog for a moment; using it keeps it up", async () => {
  const { page, tabId } = await openTestPage();
  await page.mouse.move(200, 200);
  const state = async () => (await send({ type: "state", tabId })).tab;
  const altWheel = async (...deltas) => {
    await page.keyboard.down("Meta");   // Command + Shift + scroll, the default
    await page.keyboard.down("Shift");
    for (const d of deltas) await page.mouse.wheel(0, d);
    await page.keyboard.up("Shift");
    await page.keyboard.up("Meta");
  };
  const closesWithin = (ms) => until(async () => !(await dialogOpen(page)), ms);

  // A plain scroll still scrolls the page.
  await page.evaluate(() => { document.body.style.height = "5000px"; });
  await page.mouse.wheel(0, 300);
  assert.equal(await until(() => page.evaluate(() => scrollY > 0), 2000), true, "page scrolls");
  assert.equal(await dialogOpen(page), false);
  await wait(400);   // a pause: a scroll that began without the key never turns into a volume change

  // One notch down (louder): one step, and the dialog shows up; left alone, it goes away after about 2 s.
  await altWheel(100);
  assert.equal(await until(async () => (await state()) === 125, 2000), true, "a notch is one step");
  assert.equal(await until(() => dialogReady(page), 2000), true, "the dialog shows");
  const shownAt = Date.now();
  assert.equal(await closesWithin(3500), true, "it goes away by itself");
  assert.ok(Date.now() - shownAt > 700, "not too soon (about a second)");

  // A tiny notch counts too. Scrolling over the dialog (no Option needed) keeps changing the volume and keeps it up.
  await altWheel(4);
  assert.equal(await until(async () => (await state()) === 150, 2000), true, "a small notch is one step too");
  await until(() => dialogReady(page), 2000);
  for (let i = 0; i < 4; i++) {
    await wait(700);
    await page.mouse.wheel(0, -100);   // one notch up (quieter) each: 150 -> 125 -> 100 -> 95 -> 90
  }
  assert.equal(await dialogOpen(page), true, "kept up while scrolling");
  assert.equal(await until(async () => (await state()) === 90, 1000), true, "each notch over the dialog is a step");
  near((await real(tabId)).a, 0.8 * gain(90));
  assert.equal(await closesWithin(3500), true, "and goes away after the scrolling stops");

  // Using it (a key, a click) keeps it up until Esc or a click outside.
  await altWheel(100);
  await until(() => dialogReady(page), 2000);
  await page.keyboard.press("ArrowRight");
  await wait(3000);
  assert.equal(await dialogOpen(page), true, "stays once used");
  await page.keyboard.press("Escape");
  assert.equal(await closesWithin(1000), true, "Esc closes it");

  // A click on the backdrop hides it straight away.
  await altWheel(-100);
  await until(() => dialogReady(page), 2000);
  await page.mouse.click(5, 5);
  assert.equal(await closesWithin(500), true, "a click outside hides it at once");

  // Turned off: Option + scroll does nothing special.
  const before = await state();
  await send({ type: "setSettings", altScroll: false });
  await settle();
  await altWheel(-100);
  await wait(500);
  assert.equal(await state(), before, "no change");
  assert.equal(await dialogOpen(page), false, "no dialog");
  await send({ type: "setSettings", altScroll: true });
  await send({ type: "setTab", tabId, percent: 100 });
  await page.close();
});


test("nothing in the panel takes focus or shows a focus ring; the panel keeps the keys", async () => {
  const { page, tabId } = await openTestPage();
  const popup = await context.newPage();
  await popup.addInitScript(([tabId, url]) => { chrome.tabs.query = async () => [{ id: tabId, url }]; }, [tabId, page.url()]);
  await popup.goto(ext.url());
  await popup.locator(".percent", { hasText: "100%" }).waitFor();
  const focusables = await popup.evaluate(() => [...document.querySelectorAll(".nf button, .nf input, .nf a")].filter((e) => e.tabIndex >= 0).length);
  assert.equal(focusables, 0, "no control is in the Tab order");
  const active = () => popup.evaluate(() => document.activeElement.className);
  assert.match(await active(), /\bnf\b/, "the panel holds focus");
  await popup.click("label.toggle:has(.override)");   // all_tabs on
  assert.match(await active(), /\bnf\b/, "clicking a switch leaves focus on the panel");
  await popup.click("label.toggle:has(.override)");   // and off again
  await popup.keyboard.press("Tab");
  assert.match(await active(), /\bnf\b/, "Tab doesn't move focus");
  await popup.keyboard.press("5");
  await popup.locator(".percent", { hasText: "50%" }).waitFor();
  const outlines = await popup.evaluate(() => {
    const slider = document.querySelector(".slider");
    slider.focus();
    return [getComputedStyle(slider).outlineStyle, getComputedStyle(document.querySelector(".nf")).outlineStyle];
  });
  assert.deepEqual(outlines, ["none", "none"], "no focus ring, even on the slider while dragging");

  // "c" takes up the capture-mode offer.
  await send({ type: "setTab", tabId, percent: 300 });
  await popup.evaluate(() => document.querySelector(".nf").focus());
  await popup.reload();
  await page.evaluate(() => { const a = document.getElementById("a"); a.src = location.origin.replace("127.0.0.1", "localhost") + "/tone.wav"; return a.play(); });
  await popup.locator(".offer:not([hidden])").waitFor({ timeout: 5000 });
  await popup.keyboard.press("c");
  assert.equal(await until(async () => (await send({ type: "state", tabId })).allowed, 3000), true, "c allows capture mode");
  await send({ type: "setTab", tabId, percent: 100 });
  await popup.close();
  await page.close();
});

test("a continuous swipe that opens the dialog keeps changing the volume, by distance, with no hiccup", async () => {
  const { page, tabId } = await openTestPage();
  await page.mouse.move(300, 300);
  const cdp = await context.newCDPSession(page);
  // 30 events of 20 CSS px (40 device px at this page's 2x scale), about 50 ms apart, Command + Shift held: 600 px, so one
  // step to start and then one per 100 px.
  for (let i = 0; i < 30; i++) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 300, y: 300, deltaX: 0, deltaY: 40, modifiers: 4 | 8 });   // Command + Shift held
    await wait(16);
  }
  await wait(400);
  const after = (await send({ type: "state", tabId })).tab;
  assert.ok(after >= 225 && after <= 275, `about 6 steps up from 100% (got ${after}%)`);
  assert.equal(await dialogReady(page), true, "the dialog is up");
  // While it's up the page doesn't bounce (overscroll off), and closing puts the page back as it was.
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY), "none");
  await page.keyboard.press("Escape");
  await until(async () => !(await dialogOpen(page)), 1000);
  assert.equal(await page.evaluate(() => document.documentElement.style.overscrollBehavior), "");
  await send({ type: "setTab", tabId, percent: 100 });
  await page.close();
});

test("the scroll keys are any combination (Command + Shift by default); Control ignores trackpad pinches", async () => {
  const { page, tabId } = await openTestPage();
  await page.mouse.move(300, 300);
  const state = async () => (await send({ type: "state", tabId })).tab;
  const wheelWith = async (...keys) => {
    for (const k of keys) await page.keyboard.down(k);
    await page.mouse.wheel(0, 100);
    for (const k of keys.reverse()) await page.keyboard.up(k);
    await wait(500);
  };
  const closeDialog = async () => { await page.keyboard.press("Escape"); await until(async () => !(await dialogOpen(page)), 1000); };

  await wheelWith("Meta");
  assert.equal(await state(), 100, "Command alone doesn't, by default (Command + Shift)");
  await send({ type: "setSettings", scrollKeys: ["ctrl"] });
  await settle();
  await wheelWith("Meta", "Shift");
  assert.equal(await state(), 100, "Command + Shift no longer does it");
  // A pinch: a wheel event with ctrlKey set while the Control key isn't held.
  await page.evaluate(() => document.body.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true })));
  await wait(500);
  assert.equal(await state(), 100, "a pinch doesn't change the volume");
  await wheelWith("Control");
  assert.equal(await until(async () => (await state()) === 125, 2000), true, "Control + scroll does");
  await closeDialog();

  await send({ type: "setSettings", scrollKeys: ["alt", "ctrl"] });
  await settle();
  await wheelWith("Control");
  assert.equal(await state(), 125, "Control alone isn't the combination");
  await wheelWith("Alt", "Control");
  assert.equal(await until(async () => (await state()) === 150, 2000), true, "Option + Control + scroll does");
  await closeDialog();
  await send({ type: "setSettings", scrollKeys: [] });
  assert.deepEqual((await send({ type: "state", tabId })).settings.scrollKeys, ["alt", "ctrl"], "an empty combination is refused");

  await send({ type: "setSettings", scrollKeys: ["shift", "meta"] });
  await send({ type: "setTab", tabId, percent: 100 });
  await page.close();
});

test("capture mode's info button explains it without flipping the switch; the scroll key picker saves", async () => {
  const { page, tabId } = await openTestPage();
  const popup = await context.newPage();
  await popup.addInitScript(([tabId, url]) => { chrome.tabs.query = async () => [{ id: tabId, url }]; }, [tabId, page.url()]);
  await popup.goto(ext.url());
  await popup.locator(".percent", { hasText: "100%" }).waitFor();
  assert.equal(await popup.locator(".captureInfo").isVisible(), false);
  await popup.click('.infoBtn[data-info="captureInfo"]');
  assert.equal(await popup.locator(".captureInfo").isVisible(), true, "explanation shown");
  assert.match(await popup.locator(".captureInfo").textContent(), /records the tab's sound/);
  assert.equal(await popup.locator(".alwaysToggle").isChecked(), false, "switch untouched");
  await popup.click('.infoBtn[data-info="captureInfo"]');
  assert.equal(await popup.locator(".captureInfo").isVisible(), false, "and hidden again");
  assert.equal(await popup.locator(".captureHint").textContent(), "if on, allows a volume boost by recording the tab");
  const lines = await popup.locator(".captureInfo p").allTextContents();
  assert.ok(lines.some((l) => l.startsWith("Off:")) && lines.some((l) => l.startsWith("On:")), "Off and On on their own lines");

  const on = () => popup.evaluate(() => [...document.querySelectorAll(".pick.on")].map((b) => b.dataset.key));
  assert.deepEqual(await on(), ["shift", "meta"], "Command + Shift by default");
  assert.match(await popup.locator(".altScrollHint").textContent(), /hold Shift \+ Command and scroll/);
  await popup.click('.pick[data-key="alt"]');   // add Option
  await popup.locator('.pick.on[data-key="alt"]').waitFor();
  assert.deepEqual((await send({ type: "state", tabId })).settings.scrollKeys, ["alt", "shift", "meta"], "saved");
  assert.match(await popup.locator(".altScrollHint").textContent(), /Option \+ Shift \+ Command .*trackpad only/);
  await popup.click('.pick[data-key="shift"]');
  await popup.click('.pick[data-key="meta"]');
  await popup.locator('.pick.on[data-key="meta"]').waitFor({ state: "detached" });
  assert.deepEqual(await on(), ["alt"]);
  await popup.click('.pick[data-key="alt"]');   // the last one stays on
  await wait(300);
  assert.deepEqual(await on(), ["alt"], "at least one stays on");
  await send({ type: "setSettings", scrollKeys: ["shift", "meta"] });
  await popup.close();
  await page.close();
});

test("all 20 volume segments are the same width, with a gap marking 100%", async () => {
  const popup = await context.newPage();
  await popup.addInitScript(() => { chrome.tabs.query = async () => [{ id: 1, url: "https://example.com/" }]; });
  await popup.goto(ext.url());
  await popup.locator(".percent").waitFor();
  const widths = await popup.evaluate(() => [...document.querySelectorAll(".segments i")].map((i) => Math.round(i.getBoundingClientRect().width * 10) / 10));
  assert.equal(widths.length, 20);
  assert.ok(widths.every((w) => w === widths[0] && Number.isInteger(w)), `equal, whole-pixel widths: ${widths.join(", ")}`);
  const [ten, eleven, nine] = await popup.evaluate(() => [10, 11, 9].map((n) => document.querySelectorAll(".segments i")[n - 1].getBoundingClientRect()));
  assert.ok(eleven.left - ten.right > (ten.left - nine.right) + 0.5, "a wider gap between 100% and the boost half");
  // The brackets hug the segments: the same small space between "[" and the first segment as between the last and "]".
  const [open, close, first, last] = await popup.evaluate(() => {
    const [o, c] = document.querySelectorAll(".bracket");
    const segs = document.querySelectorAll(".segments i");
    return [o.getBoundingClientRect(), c.getBoundingClientRect(), segs[0].getBoundingClientRect(), segs[19].getBoundingClientRect()];
  });
  assert.ok(Math.abs((first.left - open.right) - (close.left - last.right)) < 1 && first.left - open.right < 7, "brackets hug the segments");
  await popup.close();
});

test("the name links to the project on GitHub, the version to its releases", async () => {
  const popup = await context.newPage();
  await popup.addInitScript(() => { chrome.tabs.query = async () => [{ id: 1, url: "https://example.com/" }]; });
  await popup.goto(ext.url());
  await popup.locator(".percent").waitFor();
  assert.equal(await popup.getAttribute(".brand", "href"), "https://github.com/grumpitect/nerdfader");
  assert.equal(await popup.getAttribute(".brand", "target"), "_blank");
  assert.equal(await popup.getAttribute(".version", "href"), "https://github.com/grumpitect/nerdfader/releases");
  assert.equal(await popup.evaluate(() => document.querySelector(".brand").tabIndex), -1, "not focusable, like the rest");
  await popup.close();
});

test("pressing the scroll key during a plain scroll (or its coasting) doesn't change the volume", async () => {
  const { page, tabId } = await openTestPage();
  await page.evaluate(() => { document.body.style.height = "8000px"; });
  await page.mouse.move(300, 300);
  const cdp = await context.newCDPSession(page);
  const scroll = (deltaY, modifiers) => cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 300, y: 300, deltaX: 0, deltaY, modifiers });
  // A flick and its coast: steady scroll events, and Command + Shift go down partway through (modifiers 4 | 8).
  for (let i = 0; i < 24; i++) {
    await scroll(40, i < 10 ? 0 : 4 | 8);
    await wait(30);
  }
  await wait(500);
  assert.equal((await send({ type: "state", tabId })).tab, 100, "volume unchanged");
  assert.equal(await dialogOpen(page), false, "no dialog");
  // After a pause, a scroll that starts with Command held does change it.
  await scroll(40, 4 | 8);
  assert.equal(await until(async () => (await send({ type: "state", tabId })).tab === 125, 2000), true, "a new Command + Shift + scroll works");
  await until(() => dialogReady(page), 2000);
  await page.keyboard.press("Escape");
  await send({ type: "setTab", tabId, percent: 100 });
  await page.close();
});

test("Command+Shift+Delete resets the tab to 100%, on the page or in the dialog; the reset key can be recorded", async () => {
  const { page, tabId } = await openTestPage();
  const state = async () => (await send({ type: "state", tabId })).tab;
  await send({ type: "setTab", tabId, percent: 250 });
  await settle();
  await page.keyboard.press("Meta+Shift+Backspace");
  assert.equal(await until(async () => (await state()) === 100, 2000), true, "reset from the page");
  // The other delete key (forward delete: fn + delete on a MacBook) does the same.
  await page.keyboard.press("Escape");
  await until(async () => !(await dialogOpen(page)), 1000);
  await send({ type: "setTab", tabId, percent: 250 });
  await page.keyboard.press("Meta+Shift+Delete");
  assert.equal(await until(async () => (await state()) === 100, 2000), true, "forward delete resets too");
  near((await real(tabId)).a, 0.8, "plays at 100%");
  assert.equal(await until(() => dialogReady(page), 2000), true, "the dialog shows the 100% for a moment");
  // In the open dialog: reset without closing it.
  await page.keyboard.press("3");
  assert.equal(await until(async () => (await state()) === 30, 2000), true);
  await page.keyboard.press("Meta+Shift+Backspace");
  assert.equal(await until(async () => (await state()) === 100, 2000), true, "reset from the dialog");
  assert.equal(await dialogOpen(page), true, "the dialog stays");
  await page.keyboard.press("Escape");
  await until(async () => !(await dialogOpen(page)), 1000);

  // Record a different reset key in the panel (the popup shows the same panel without a shadow root).
  const popup = await context.newPage();
  await popup.addInitScript(([tabId, url]) => { chrome.tabs.query = async () => [{ id: tabId, url }]; }, [tabId, page.url()]);
  await popup.goto(ext.url());
  const resetBtn = '.shortcutBtn[data-setting="resetShortcut"]';
  await popup.locator(resetBtn, { hasText: "⇧⌘⌫" }).waitFor();
  assert.equal(await popup.locator('.shortcutBtn[data-setting="shortcut"]').textContent(), "⇧⌘End");
  await popup.click(resetBtn);
  await popup.keyboard.press("Control+Shift+KeyR");
  await popup.locator(resetBtn, { hasText: "⌃⇧R" }).waitFor();
  assert.equal(await popup.locator('.shortcutBtn[data-setting="shortcut"]').textContent(), "⇧⌘End", "the open shortcut is untouched");
  await popup.close();
  await settle();
  await page.bringToFront();
  await send({ type: "setTab", tabId, percent: 200 });
  await page.keyboard.press("Meta+Shift+Backspace");
  await wait(400);
  assert.equal(await state(), 200, "the old reset key no longer resets");
  await page.keyboard.press("Control+Shift+KeyR");
  assert.equal(await until(async () => (await state()) === 100, 2000), true, "the recorded one does");
  await send({ type: "setSettings", resetShortcut: { code: "Backspace", alt: false, ctrl: false, meta: true, shift: true } });
  await page.close();
});

test("Command+Shift+Up/Down turn the volume up and down a step (holding repeats), shown for about a second", async () => {
  const { page, tabId } = await openTestPage();
  const state = async () => (await send({ type: "state", tabId })).tab;
  await page.keyboard.press("Meta+Shift+ArrowUp");
  assert.equal(await until(async () => (await state()) === 125, 2000), true, "one step up");
  assert.equal(await until(() => dialogReady(page), 2000), true, "the dialog shows");
  // In the dialog the same keys keep working, and each press keeps it up.
  await page.keyboard.press("Meta+Shift+ArrowUp");
  assert.equal(await until(async () => (await state()) === 150, 2000), true, "another step, in the dialog");
  await page.keyboard.press("Meta+Shift+ArrowDown");
  await page.keyboard.press("Meta+Shift+ArrowDown");
  assert.equal(await until(async () => (await state()) === 100, 2000), true, "two steps down");
  const lastChange = Date.now();
  assert.equal(await until(async () => !(await dialogOpen(page)), 2500), true, "goes away by itself");
  const after = Date.now() - lastChange;
  assert.ok(after > 700 && after < 2000, `about a second after the last change (${after} ms)`);

  // Holding the key down: the system repeats it, and every repeat is a step.
  const cdp = await context.newCDPSession(page);
  const key = (type, autoRepeat = false) => cdp.send("Input.dispatchKeyEvent",
    { type, modifiers: 4 | 8, key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, autoRepeat });
  await key("rawKeyDown");
  for (let i = 0; i < 3; i++) { await wait(60); await key("rawKeyDown", true); }
  await key("keyUp");
  assert.equal(await until(async () => (await state()) === 80, 2000), true, "four steps down while held (100 -> 80)");

  // In a text field Command+Shift+Up/Down select text, so they're left alone there.
  await until(async () => !(await dialogOpen(page)), 2500);
  await page.evaluate(() => { const t = document.createElement("textarea"); t.id = "t"; t.value = "one\ntwo"; document.body.append(t); t.focus(); });
  await page.keyboard.press("Meta+Shift+ArrowUp");
  await wait(400);
  assert.equal(await state(), 80, "volume unchanged while typing");
  assert.equal(await dialogOpen(page), false);
  await send({ type: "setTab", tabId, percent: 100 });
  await page.close();
});

test("the four key boxes are the same width", async () => {
  const popup = await context.newPage();
  await popup.addInitScript(() => { chrome.tabs.query = async () => [{ id: 1, url: "https://example.com/" }]; });
  await popup.goto(ext.url());
  await popup.locator(".percent").waitFor();
  const widths = await popup.evaluate(() => [...document.querySelectorAll(".shortcutBtn")].map((b) => Math.round(b.getBoundingClientRect().width)));
  assert.equal(widths.length, 4);
  assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `same width: ${widths.join(", ")}`);
  await popup.close();
});

test("in a browser that uses a default key itself, that key falls back to Command+Shift+0 (then 1, 2...)", async () => {
  const keysOf = async () => (await send({ type: "state", tabId: 0 })).settings;
  await sw.evaluate(() => chrome.storage.local.remove(["shortcut", "resetShortcut", "upShortcut", "downShortcut"]));   // defaults only
  assert.equal((await keysOf()).resetShortcut.code, "Backspace", "Arc: the wanted Command+Shift+Delete");
  await sw.evaluate(() => chrome.storage.local.set({ browser: "chromium" }));   // Chrome uses Command+Shift+Delete
  const s = await keysOf();
  assert.equal(s.resetShortcut.code, "Digit0", "reset falls back to Command+Shift+0");
  assert.deepEqual([s.shortcut.code, s.upShortcut.code, s.downShortcut.code], ["End", "ArrowUp", "ArrowDown"], "the rest stay");
  // A key the user picked is theirs, in any browser.
  await send({ type: "setSettings", resetShortcut: { code: "KeyR", alt: false, ctrl: true, meta: false, shift: true } });
  assert.equal((await keysOf()).resetShortcut.code, "KeyR");
  await sw.evaluate(() => chrome.storage.local.remove("resetShortcut"));
  await sw.evaluate(() => chrome.storage.local.set({ browser: "arc" }));
});

// What the tab outputs, per ear: RMS in dB, and the level (dB) at given frequencies, from tab capture.
const ears = (tabId, freqs = []) =>
  ext.evaluate(async ([tabId, freqs]) => {
    const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: id } },
    });
    const ctx = new AudioContext({ sampleRate: 48000 });
    const split = ctx.createChannelSplitter(2);
    ctx.createMediaStreamSource(stream).connect(split);
    const meters = [0, 1].map((ch) => {
      const m = ctx.createAnalyser();
      m.fftSize = 16384;
      m.smoothingTimeConstant = 0;
      split.connect(m, ch);
      return m;
    });
    const sums = [0, 0], peaks = [freqs.map(() => 0), freqs.map(() => 0)];
    const wave = new Float32Array(16384), spectrum = new Float32Array(8192);
    let n = 0;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 250));
      meters.forEach((m, ch) => {
        m.getFloatTimeDomainData(wave);
        for (const v of wave) sums[ch] += v * v;
        m.getFloatFrequencyData(spectrum);
        freqs.forEach((f, k) => {
          const bin = Math.round(f / (48000 / 16384));
          peaks[ch][k] += 10 ** (Math.max(spectrum[bin - 1], spectrum[bin], spectrum[bin + 1]) / 10);
        });
      });
      n += wave.length;
    }
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    const db = (x) => 10 * Math.log10(x);
    return [0, 1].map((ch) => ({ rms: db(sums[ch] / n), at: peaks[ch].map((p) => db(p / 6)) }));
  }, [tabId, freqs]);

test("voice fix mixes to mono, finds the hum and notches it out; turning it off brings the stereo back", async () => {
  const { page, tabId } = await openPlayer("/talk.wav");
  await page.evaluate(() => (window.__nerdfaderHumTiming = { lockAfter: 1, giveUpAfter: 5 }));   // quicker than 6 s
  const before = await ears(tabId, HUM);
  assert.ok(before[0].rms - before[1].rms > 10, `the voice is in the left ear only (${before[0].rms.toFixed(1)} / ${before[1].rms.toFixed(1)} dB)`);

  const reply = await send({ type: "setVoice", tabId, on: true });
  assert.equal(reply.voice, true);
  assert.equal(await sw.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId), "fix", "badge at 100%");
  assert.equal(await until(async () => (await send({ type: "state", tabId })).hum === "60", 8000), true, "60 Hz hum found");
  await wait(1500);   // the notches go in at a quiet moment
  const on = await ears(tabId, HUM);
  assert.ok(Math.abs(on[0].rms - on[1].rms) < 0.5, `both ears the same (${on[0].rms.toFixed(1)} / ${on[1].rms.toFixed(1)} dB)`);
  assert.ok(Math.abs(on[0].rms - (before[0].rms - 3)) < 1.5, `the voice mixed in at 0.71 (${before[0].rms.toFixed(1)} to ${on[0].rms.toFixed(1)} dB)`);
  HUM.forEach((f, k) => {
    const drop = before[1].at[k] - on[1].at[k];
    assert.ok(drop > 15, `hum at ${f} Hz down ${drop.toFixed(1)} dB`);
  });
  assert.equal((await send({ type: "state", tabId })).status, "", "nothing reported as blocked");

  await send({ type: "setVoice", tabId, on: false });
  assert.equal(await sw.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId), "");
  await wait(300);
  const off = await ears(tabId, HUM);
  assert.ok(off[0].rms - off[1].rms > 10, "stereo again");
  assert.ok(Math.abs(off[1].at[2] - before[1].at[2]) < 2, "and the hum back as it was");
  await page.close();
});

test("voice fix's filters: less boom, 200 Hz down 4 dB, deep notches up to 6 kHz, the rest untouched", async () => {
  // The stage itself, in an OfflineAudioContext: a tone through it with voice fix on, against the same tone with it off.
  const page = await context.newPage();
  await page.goto(origin + "/player");
  await page.addScriptTag({ path: EXT + "/content/voice.js" });
  const response = await page.evaluate(async () => {
    const tools = window[Symbol.for("nerdfader.voice")];
    const level = async (f, on) => {
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      const stage = tools.outputStage(ctx, { connect: AudioNode.prototype.connect, disconnect: AudioNode.prototype.disconnect });
      stage.setShape({ mono: true, mixDb: 10 * Math.log10(2), boom: true }, false);   // everything, as for the talk
      stage.setFamily(60);
      stage.setVoice(on, false);
      const osc = new OscillatorNode(ctx, { frequency: f });
      const amp = new GainNode(ctx, { gain: 0.1 });
      osc.connect(amp).connect(stage.input);
      osc.start();
      const out = (await ctx.startRendering()).getChannelData(0).subarray(24000);
      let sum = 0;
      for (const v of out) sum += v * v;
      return 10 * Math.log10(sum / out.length);
    };
    const result = {};
    for (const f of [40, 200, 600, 900, 1000, 1980, 2500, 4000, 4500, 6000, 8000]) result[f] = (await level(f, true)) - (await level(f, false));
    return result;
  });
  // A mono source comes out 3 dB louder (0.71 of left plus 0.71 of right), as in the samples. Expected values are the
  // filters' own response plus those 3 dB, worked out from the standard (RBJ) filter formulas the browser uses.
  const expect = { 40: -9.47, 200: -1.21, 600: 2.23, 1000: 0.27, 2500: 2.55, 4000: 2.01, 6000: 2.88, 8000: 3.01 };
  for (const [f, want] of Object.entries(expect)) {
    assert.ok(Math.abs(response[f] - want) < 0.1, `${f} Hz: expected ${want} dB, got ${response[f].toFixed(2)}`);
  }
  for (const f of [900, 1980, 4500]) assert.ok(response[f] < -30, `notch at ${f} Hz: ${response[f].toFixed(1)} dB`);
  await page.close();
});

test("voice fix: the switch, its v key, explanation and hints; it stays on for the site and turns off on another", async () => {
  const { page, tabId } = await openPlayer("/talk.wav");
  await page.evaluate(() => (window.__nerdfaderHumTiming = { lockAfter: 1, giveUpAfter: 5 }));
  const popup = await context.newPage();
  await popup.addInitScript(([tabId, url]) => { chrome.tabs.query = async () => [{ id: tabId, url }]; }, [tabId, page.url()]);
  await popup.goto(ext.url());
  await popup.locator(".percent", { hasText: "100%" }).waitFor();
  assert.equal(await popup.locator(".voiceToggle").isChecked(), false, "off by default");
  assert.equal(await popup.locator(".voiceHint").textContent(), "for talks: voice in both ears, less hum and boom");
  await popup.click('.infoBtn[data-info="voiceInfo"]');
  assert.equal(await popup.locator(".voiceInfo").isVisible(), true, "explanation shown");
  assert.equal(await popup.locator(".voiceToggle").isChecked(), false, "switch untouched");
  const lines = await popup.locator(".voiceInfo p").allTextContents();
  assert.ok(lines.some((l) => l.startsWith("Off:")) && lines.some((l) => l.startsWith("On:")), "Off and On on their own lines");

  await popup.keyboard.press("v");
  await popup.locator(".voiceHint", { hasText: /^on/ }).waitFor();
  assert.equal(await popup.locator(".voiceToggle").isChecked(), true);
  await popup.locator(".voiceRule.scan").waitFor();   // the scanning line while it listens
  await popup.locator(".voiceHint", { hasText: "on · both ears, less boom, 60 Hz hum removed" }).waitFor({ timeout: 8000 });
  await popup.locator(".voiceRule.scan").waitFor({ state: "detached" });   // and gone once it knows
  assert.equal((await send({ type: "state", tabId })).voice, true);

  // A reload keeps it, and the new page finds the hum again.
  await page.reload();
  await page.evaluate(async () => {
    window.__nerdfaderHumTiming = { lockAfter: 1, giveUpAfter: 5 };
    const a = document.createElement("audio");
    a.src = "/talk.wav"; a.loop = true; document.body.append(a);
    await a.play();
  });
  assert.equal((await send({ type: "state", tabId })).voice, true, "kept on a reload");
  assert.equal(await until(async () => (await send({ type: "state", tabId })).hum === "60", 8000), true, "found again");
  // Another site turns it off.
  await page.goto(otherOrigin + "/player");
  assert.equal(await until(async () => (await send({ type: "state", tabId })).voice === false, 3000), true, "off on another site");
  await page.goto(origin + "/player");
  assert.equal((await send({ type: "state", tabId })).voice, false, "and stays off");
  await popup.close();
  await page.close();
});

test("a page script from version 1.2 hands over to voice fix, boosted element included", async () => {
  const { execSync } = await import("node:child_process");
  const old = execSync("git show v1.2.0:extension/content/main.js").toString();
  const now = ["voice.js", "main.js"].map((f) => fs.readFileSync(`${EXT}/content/${f}`, "utf8")).join("\n");
  const { page, tabId } = await openPlayer("/talk.wav");
  await page.addScriptTag({ content: old });   // 1.2 takes the page over, as it ran before the update
  await send({ type: "setTab", tabId, percent: 200 });   // and routes the element through its own stage
  await settle();
  const boosted = await ears(tabId);
  await send({ type: "setTab", tabId, percent: 100 });
  await settle();
  const base = await ears(tabId);
  assert.ok(Math.abs(boosted[0].rms - base[0].rms - 6) < 1, "1.2 boosted it");
  await page.evaluate(() => (window.__nerdfaderHumTiming = { lockAfter: 1, giveUpAfter: 5 }));
  await page.addScriptTag({ content: now });   // the update
  await send({ type: "setVoice", tabId, on: true });
  assert.equal(await until(async () => (await send({ type: "state", tabId })).hum === "60", 8000), true, "hum found");
  await wait(1000);
  const on = await ears(tabId);
  assert.ok(Math.abs(on[0].rms - on[1].rms) < 0.5, `mono through the rebuilt stage (${on[0].rms.toFixed(1)} / ${on[1].rms.toFixed(1)} dB)`);
  await send({ type: "setTab", tabId, percent: 200 });
  await settle();
  const both = await ears(tabId);
  assert.ok(Math.abs(both[0].rms - on[0].rms - 6) < 1, "and still boosts");
  await send({ type: "setTab", tabId, percent: 100 });
  await send({ type: "setVoice", tabId, on: false });
  await page.close();
});

test("on YouTube, voice fix turns Stable Volume off in that tab only, or counters it when the player won't", async () => {
  // A stand-in for YouTube's player, with the methods voice fix uses; Stable Volume on, as YouTube starts it.
  const fakePlayer = (page, { canSwitch }) => page.evaluate((canSwitch) => {
    window.__nerdfaderHumTiming = { lockAfter: 1, giveUpAfter: 2 };
    const p = document.createElement("div");
    p.id = "movie_player";
    document.body.append(p);
    window.drc = 1;
    p.getDrcUserPreference = () => window.drc;
    // Like YouTube: every change is saved for all tabs, with the time.
    if (canSwitch) p.setDrcUserPreference = (on) => { window.drc = on; localStorage.setItem("yt-player-drc-pref", JSON.stringify({ data: String(on), creation: performance.now() })); };
    window.menu = (on) => p.setDrcUserPreference(on);   // the user, in YouTube's settings menu
    p.getStatsForNerds = () => ({ volume: window.drc ? "100%/100% DRC (cont.-17.2dB tgt.-14.0dB)" : "100%/100% (cont.-18.7dB tgt.-14.0dB)" });
    localStorage.setItem("yt-player-drc-pref", "saved by the user");
  }, canSwitch);
  const pauseLevel = async (tabId) => (await ears(tabId, [700]))[0].at[0];

  const { page, tabId } = await openPlayer("/lifted.wav");
  await fakePlayer(page, { canSwitch: true });
  await send({ type: "setVoice", tabId, on: true });
  const hasHum = (tabId) => until(async () => (await send({ type: "state", tabId })).hum === "60", 8000);
  assert.equal(await hasHum(tabId), true, "hum found");
  await wait(300);
  assert.equal(await page.evaluate(() => window.drc), false, "Stable Volume off in this player once hum is found");
  assert.equal(await page.evaluate(() => localStorage.getItem("yt-player-drc-pref")), "saved by the user", "the user's saved choice kept");
  await wait(5000);   // past the check, and long enough for the counter to have acted if it ran
  const switched = await pauseLevel(tabId);
  await send({ type: "setVoice", tabId, on: false });
  await wait(300);
  assert.equal(await page.evaluate(() => window.drc), true, "back on with voice fix off");
  assert.equal(await page.evaluate(() => localStorage.getItem("yt-player-drc-pref")), "saved by the user");

  // The user changes it themselves while voice fix is on: theirs from then on.
  await send({ type: "setVoice", tabId, on: true });
  await wait(300);
  assert.equal(await page.evaluate(() => window.drc), false);
  await page.evaluate(() => window.menu(true));   // they want it on
  await page.evaluate(async () => { const a = document.getElementById("a"); a.pause(); await a.play(); });   // the player's next "playing"
  await wait(300);
  assert.equal(await page.evaluate(() => window.drc), true, "not switched off again");
  // A reload of that tab keeps their choice: YouTube starts with Stable Volume on, as they saved it, and stays so.
  await page.reload();
  await fakePlayer(page, { canSwitch: true });
  await page.evaluate(async () => { const a = document.createElement("audio"); a.id = "a"; a.src = "/lifted.wav"; a.loop = true; document.body.append(a); await a.play(); });
  assert.equal(await hasHum(tabId), true, "hum found again after the reload");
  await wait(500);
  assert.equal((await send({ type: "state", tabId })).voice, true, "voice fix still on after the reload");
  assert.equal(await page.evaluate(() => window.drc), 1, "their Stable Volume left on after the reload");
  await page.evaluate(() => window.menu(false));   // and then off after all
  await send({ type: "setVoice", tabId, on: false });
  await wait(300);
  assert.equal(await page.evaluate(() => window.drc), false, "left off as they set it when voice fix goes off");
  // Voice fix on again later: a fresh start, so Stable Volume is switched off for it again.
  await page.evaluate(() => window.menu(true));
  await send({ type: "setVoice", tabId, on: true });
  await wait(300);
  assert.equal(await page.evaluate(() => window.drc), false, "switched off again for a new voice fix");
  await send({ type: "setVoice", tabId, on: false });
  await page.close();

  // YouTube changed its player: no way to switch. The counter turns the lifted pauses back down.
  const other = await openPlayer("/lifted.wav");
  await fakePlayer(other.page, { canSwitch: false });
  await send({ type: "setVoice", tabId: other.tabId, on: true });
  assert.equal(await hasHum(other.tabId), true);
  await wait(5000);   // the check, then a few seconds of levels
  const countered = await pauseLevel(other.tabId);
  console.log(`    pauses: ${switched.toFixed(1)} dB with Stable Volume switched off (no counter), ${countered.toFixed(1)} dB countered`);
  // About 6 dB once a pause has settled; it eases in over the first ~80 ms of each, so the average is lower.
  assert.ok(switched - countered > 3, `pauses turned down ${(switched - countered).toFixed(1)} dB`);
  await send({ type: "setVoice", tabId: other.tabId, on: false });
  await other.page.close();
});

test("voice fix leaves a recording that is already fine as it is: same level, same peaks, nothing to fix", async () => {
  // The same in both ears, no boom, no hum: loud.wav (1 kHz, peaks near full scale).
  const { page, tabId } = await openPlayer("/loud.wav");
  await page.evaluate(() => (window.__nerdfaderHumTiming = { lockAfter: 1, giveUpAfter: 2 }));
  // Readings of the same sound vary by a few tenths of a dB, so three each.
  const average = async () => {
    const r = [await loudness(tabId), await loudness(tabId), await loudness(tabId)];
    return { db: r.reduce((a, x) => a + x.db, 0) / 3, clipped: Math.max(...r.map((x) => x.clipped)) };
  };
  const before = await average();
  await send({ type: "setVoice", tabId, on: true });
  assert.equal(await until(async () => { const s = await send({ type: "state", tabId }); return s.hum === "none" && s.shape; }, 10000) && true, true, "listened");
  const state = await send({ type: "state", tabId });
  assert.deepEqual(state.shape, { mono: false, boom: false });
  const after = await average();
  assert.ok(Math.abs(after.db - before.db) < 0.5, `same level (${before.db.toFixed(1)} -> ${after.db.toFixed(1)} dB)`);
  assert.ok(after.clipped <= before.clipped + 1e-4, "no clipping added");
  const popup = await context.newPage();
  await popup.addInitScript(([tabId, url]) => { chrome.tabs.query = async () => [{ id: tabId, url }]; }, [tabId, page.url()]);
  await popup.goto(ext.url());
  await popup.locator(".voiceHint", { hasText: "on · nothing to fix" }).waitFor();
  await popup.close();
  await send({ type: "setVoice", tabId, on: false });
  await page.close();
});
