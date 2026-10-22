// End-to-end tests: loads the unpacked extension into Playwright's Chromium and checks what pages actually play at.
// "page" values are what the site sees (element.volume in its own world); "real" values are what the browser plays
// at, read from an isolated world where the volume property is not patched; "heard" values are peaks of a tab's
// actual sound output, captured the same way capture mode does it.
//
// Sound is on (capture and the browser's "playing sound" state need it), but every tab is muted (tab capture still
// hears it) and every test tone is a 19 kHz tone at -60 dBFS, so the only thing that reaches the speakers, capture
// mode's own playback, is inaudible too.
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
const sounds = { "/tone.wav": wav(30), "/gap.wav": wav(1, 5, 30) };

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
    ],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  // Every test tab is muted: its sound still reaches tab capture (which the tests measure with), not the speakers.
  await sw.evaluate(() => {
    chrome.tabs.onCreated.addListener((tab) => chrome.tabs.update(tab.id, { muted: true }));
    chrome.tabs.query({}).then((tabs) => tabs.forEach((t) => chrome.tabs.update(t.id, { muted: true })));
  });
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
  // The extension's gain stage first, then a trim stage that undoes the limiter's make-up gain.
  assert.equal(await page.evaluate(() => created.length), 2);
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
  }), 2);
  await page.close();
});

test("tabs opened before the extension loaded get it when it is installed", async () => {
  // On install the background injects both scripts into open tabs. Here the page already has them, so this also
  // checks that injecting a second time does not patch twice (which would square the volume).
  const { page, tabId } = await openTestPage();
  await ext.evaluate(async (tabId) => {
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ["content/main.js"], world: "MAIN" });
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

  await popup.click("label.toggle >> nth=0");
  await popup.locator(".target", { hasText: "all tabs" }).waitFor();
  await popup.keyboard.press("3");
  await settle();
  near((await real(tabId)).a, 0.8 * gain(30));
  await popup.click("label.toggle >> nth=0");
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
const openDialog = async (page, tabId) => {
  await sw.evaluate(async (tabId) => openPanel(await chrome.tabs.get(tabId)), tabId);
  await until(() => dialogOpen(page), 2000);
  await wait(300);   // the panel loads its state
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
  await sw.evaluate(async (tabId) => openPanel(await chrome.tabs.get(tabId)), tabId);
  assert.equal(await until(async () => !(await dialogOpen(page)), 1000), true, "clicking the icon again closes");

  await send({ type: "setTab", tabId, percent: 100 });
  await page.close();

  // SCREENSHOT=docs/dialog.png npm test: renders the dialog for the README.
  if (process.env.SCREENSHOT) {
    const demo = await context.newPage();
    await demo.setViewportSize({ width: 880, height: 560 });
    await demo.goto(origin + "/demo");
    const demoId = await tabIdOf(origin);
    await send({ type: "setTab", tabId: demoId, percent: 250 });
    await openDialog(demo, demoId);
    await demo.evaluate(() => document.activeElement?.blur());
    await wait(300);
    await demo.screenshot({ path: process.env.SCREENSHOT });
    await send({ type: "setTab", tabId: demoId, percent: 100 });
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
    await chrome.scripting.executeScript({ target, files: ["content/main.js"], world: "MAIN" });
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
  const now = fs.readFileSync(EXT + "/content/main.js", "utf8");
  const plain = await chromium.launch();   // no extension, so only these two copies run
  const page = await plain.newPage();
  await page.goto(origin + "/player");
  const realVolume = await page.evaluate(([old, now]) => {
    const native = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
    const a = document.createElement("audio");
    // Run 1.0 the way it ran in its own world, then the new copy.
    new Function(old)();
    window.dispatchEvent(new CustomEvent("nerdfader:level", { detail: 1 }));   // 1.0's last level: 100%
    new Function(now)();
    a.volume = 0.8;
    window.dispatchEvent(new CustomEvent("nerdfader2:level", { detail: 0.125 }));
    return [native.get.call(a), a.volume];
  }, [old, now]);
  near(realVolume[0], 0.8 * 0.125, "scaled once, by the new copy");
  near(realVolume[1], 0.8, "page still sees its own volume");
  await plain.close();
});
