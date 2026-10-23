// Tests in real Google Chrome, the way a person uses Nerdfader: installed as an unpacked extension, updated and
// reloaded over open tabs, opened by clicking its toolbar icon, and tried on real sites. `npm run test:real` runs it
// all headless (no window, never takes focus). `npm run test:real:window` runs only the shortcut test with a window,
// the one thing headless can't cover (browser-level shortcuts come from the browser's own UI); that window sits in
// the bottom-left corner, mostly off-screen, and may briefly come to the front.
//
// Chrome is started with a throwaway profile and driven over its debugging protocol, which can load extensions and
// click their toolbar icon for real (Extensions.loadUnpacked, Extensions.triggerAction), so capture mode runs under
// the browser's actual "only after the user clicked the extension on this tab" rule. Errors are read from the same
// list chrome://extensions shows. Chrome's audio output is switched off, so nothing is audible (pages still play
// and can be captured). Chrome is quit properly at the end.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { chromium } from "playwright";

// A stuck site fails its own test instead of hanging the run.
const test = (name, opts, fn) => (fn ? nodeTest(name, { timeout: 90_000, ...opts }, fn) : nodeTest(name, { timeout: 90_000 }, opts));

const ROOT = path.resolve(import.meta.dirname, "..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TONE = 0.001;
const gain = (p) => (p <= 100 ? (p / 100) ** 3 : p / 100);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} expected ${b}, got ${a}`);
const ratio = (a, b, want, msg) =>
  assert.ok(Math.abs(a / b - want) / want < 0.1, `${msg ?? ""} expected x${want}, got x${(a / b).toFixed(3)} (${a} / ${b})`);
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => false);
    if (v || Date.now() > end) return v;
    await wait(100);
  }
}

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
      b.writeInt16LE(n % 2 === 0 ? Math.round(TONE * 32767 * Math.sin((2 * Math.PI * 19000 * i) / rate)) : 0, 44 + i * 2);
    }
  });
  return b;
}

// Pages: a player (same-origin tone, or one from the other origin), and Google's public ClearKey-encrypted (EME)
// demo stream played with Shaka Player, as DRM sites do it.
const files = {
  "/tone.wav": ["audio/wav", wav(60)],
  "/player": ["text/html", `<!doctype html><title>player</title><body><h1>player</h1><script>
    const q = new URLSearchParams(location.search);
    if (q.get("src")) {
      const a = document.createElement("audio");
      a.id = "a"; a.loop = true; a.muted = q.has("muted"); a.src = q.get("src"); document.body.append(a);
      if (!q.has("paused")) a.play().catch((e) => (window.playError = String(e)));
    }</script>`],
  "/drm": ["text/html", `<!doctype html><title>drm</title><body><video id="a" width="320" loop></video>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.12.6/shaka-player.compiled.js"></script>
    <script>(async () => {
      const v = document.getElementById("a");
      const player = new shaka.Player();
      await player.attach(v);
      player.configure({ drm: { clearKeys: { feedf00deedeadbeeff0baadf00dd00d: "00112233445566778899aabbccddeeff" } } });
      await player.load("https://storage.googleapis.com/shaka-demo-assets/angel-one-clearkey/dash.mpd");
      v.volume = 0.1;
      v.currentTime = 30;   // past the quiet opening
      await v.play();
      window.ready = !!v.mediaKeys;
    })().catch((e) => (window.failed = String(e)));</script>`],
};

let server, origin, other, chrome, profile, browser, cdp, ctx, devPage, extDir, id;
const headless = process.env.HEADLESS ? ["--headless=new"] : [];

before(async () => {
  server = http.createServer((req, res) => {
    const [type, body] = files[new URL(req.url, "http://x").pathname] ?? ["text/html", "<!doctype html><title>blank</title>"];
    res.setHeader("content-type", type);
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  other = `http://localhost:${server.address().port}`;

  profile = fs.mkdtempSync(path.join(os.tmpdir(), "nerdfader-chrome-"));
  extDir = path.join(profile, "Nerdfader");   // one folder, updated in place, like the install command does
  const port = 9300 + Math.floor(Math.random() * 600);
  // HEADLESS=1 runs Chrome without a window (same browser, no UI). Otherwise Chrome has a window, kept out of the way:
  // it starts with none (so it doesn't take focus), opens one in the background, and moves it to the bottom-left
  // corner, as far off-screen as macOS allows (a sliver stays visible), with throttling of hidden windows turned off.
  chrome = spawn(CHROME, [
    ...headless,
    `--user-data-dir=${profile}/profile`, `--remote-debugging-port=${port}`, "--enable-unsafe-extension-debugging",
    "--no-first-run", "--no-default-browser-check",
    // Pages may play sound without a click, which most tests need. STRICT_AUTOPLAY=1 keeps the browser's normal rule
    // (sound and Web Audio only after a real interaction with the page) for the test that checks that.
    ...(process.env.STRICT_AUTOPLAY ? [] : ["--autoplay-policy=no-user-gesture-required"]),
    // Otherwise Bluetooth headphones' media buttons (or macOS on their behalf) can pause the test players.
    "--disable-features=MediaSessionService",
    // No sound reaches the speakers; pages still play, count as playing sound, and can be captured.
    "--disable-audio-output",
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    // No macOS "reopen windows?" prompt for this throwaway Chrome (headless has no windows, and would read "YES" as
    // a second page to open).
    ...(headless.length ? ["about:blank"] : ["--no-startup-window", "-ApplePersistenceIgnoreState", "YES"]),
  ], { stdio: "ignore" });
  for (let i = 0; i < 100 && !browser; i++) {
    await wait(200);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  }
  cdp = await browser.newBrowserCDPSession();
  ctx = browser.contexts()[0];
  if (!headless.length) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true, background: true });
    const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId });
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: -6000, top: 6000, width: 1000, height: 700 } });
    await until(async () => ctx.pages().length > 0, 3000);
  }
  devPage = ctx.pages()[0];
  await devPage.goto("chrome://extensions");
  await devPage.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
});

after(async () => {
  // Quit Chrome properly; killing it makes macOS offer to reopen its windows next time.
  const exited = new Promise((r) => chrome.once("exit", r));
  await cdp?.send("Browser.close").catch(() => {});
  await Promise.race([exited, wait(10000)]);
  if (chrome.exitCode === null) chrome.kill();
  server?.close();
  fs.rmSync(profile, { recursive: true, force: true });
});

// Install or update: put a version's files in the folder and (re)load it, like clicking the reload arrow.
async function install(ref) {
  fs.rmSync(extDir, { recursive: true, force: true });
  if (ref === "working tree") fs.cpSync(path.join(ROOT, "extension"), extDir, { recursive: true });
  else {
    fs.mkdirSync(extDir, { recursive: true });
    execSync(`git -C "${ROOT}" archive ${ref} extension | tar -x -C "${extDir}" --strip-components 1`);
  }
  ({ id } = await cdp.send("Extensions.loadUnpacked", { path: extDir }));
  await until(async () => !!(await worker()), 5000);
  await wait(500);   // onInstalled injects into open tabs
  return id;
}
const worker = async () => ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${id}/`));
const bg = async (fn, arg) => (await worker()).evaluate(fn, arg);

// What chrome://extensions lists under Errors for Nerdfader.
const errors = () =>
  devPage.evaluate(async (id) => {
    const info = await chrome.developerPrivate.getExtensionInfo(id);
    return [...info.manifestErrors, ...info.runtimeErrors].map((e) => `${e.message} (${e.contextUrl || e.source})`);
  }, id);
const clearErrors = () => devPage.evaluate((id) => chrome.developerPrivate.deleteExtensionErrors({ extensionId: id }), id);

// A new tab, opened in the background so the test Chrome never comes in front of your apps.
async function newTab(url = "about:blank") {
  const known = new Set(ctx.pages());
  await cdp.send("Target.createTarget", { url: "about:blank", background: true });
  const page = await until(async () => ctx.pages().find((p) => !known.has(p)), 5000);
  if (url !== "about:blank") await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  return page;
}

async function open(url) {
  const page = await newTab();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  const tabId = await bg(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.filter((t) => t.url === url || t.pendingUrl === url).sort((a, b) => b.id - a.id)[0];
    return tab.id;
  }, page.url());
  return { page, tabId };
}
async function tabTarget(page) {
  const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
  return targetInfos.find((t) => t.url === page.url()).targetId;
}
// A real click on Nerdfader's toolbar icon, for the tab showing this page.
async function clickIcon(page) {
  if (headless.length) await page.bringToFront();   // with a window this would bring Chrome in front of your apps
  await cdp.send("Extensions.triggerAction", { id, targetId: await tabTarget(page) });
}
const dialog = (page) => page.evaluate(() => {
  const d = document.querySelector("nerdfader-dialog");
  return d ? (d.dataset.ready !== undefined ? "ready" : "loading") : "closed";
});
const call = (msg) => bg((msg) => handlers[msg.type](msg, {}), msg);
const state = (tabId) => call({ type: "state", tabId });
const realVolume = (tabId) =>
  bg(async (tabId) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => [...document.querySelectorAll("audio,video")].map((e) => e.volume),
    });
    return results.flatMap((r) => r.result);
  }, tabId);
// Peak of what the tab outputs, through tab capture (allowed because the icon was clicked on that tab).
const heard = (tabId) =>
  bg(async (tabId) => {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({ url: "offscreen/offscreen.html", reasons: ["USER_MEDIA"], justification: "test" });
    }
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    // Measure in the offscreen page: start a capture at gain 1, read its peak, stop it.
    await chrome.runtime.sendMessage({ target: "offscreen", type: "start", tabId: -tabId, streamId, gain: 1 });
    await new Promise((r) => setTimeout(r, 700));
    const stats = await chrome.runtime.sendMessage({ target: "offscreen", type: "stats" });
    await chrome.runtime.sendMessage({ target: "offscreen", type: "stop", tabId: -tabId });
    return stats[-tabId].peak;
  }, tabId);

test("updating from 1.0 over open tabs: no errors, and those tabs work with the new version", async () => {
  await install("v1.0.0");
  const player = await open(`${origin}/player?src=${other}/tone.wav`);
  const yt = await open("https://www.youtube.com/watch?v=jNQXAC9IVRw");
  await call({ type: "setTab", tabId: player.tabId, percent: 50 });
  await wait(300);
  near((await realVolume(player.tabId))[0], gain(50), "1.0 works");

  await install("working tree");
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/manifest.json"), "utf8")).version;
  assert.equal(await bg(() => chrome.runtime.getManifest().version), version, "running the new version");
  await call({ type: "setTab", tabId: player.tabId, percent: 30 });
  await wait(300);
  near((await realVolume(player.tabId))[0], gain(30), "the open tab follows the new version, scaled once");

  // The dialog opens on tabs that were open during the update, and works.
  for (const tab of [player, yt]) {
    await clickIcon(tab.page);
    assert.equal(await until(async () => (await dialog(tab.page)) === "ready", 3000), true, "dialog opens");
    await tab.page.keyboard.press("2");
    await wait(300);
    assert.equal((await state(tab.tabId)).tab, 20);
    await tab.page.keyboard.press("Escape");
    assert.equal(await until(async () => (await dialog(tab.page)) === "closed", 1000), true);
  }
  // Media events in old tabs (these made the cut-off 1.0 bridge throw).
  await player.page.evaluate(async () => { const a = document.getElementById("a"); a.pause(); await a.play(); });
  await wait(500);
  assert.deepEqual(await errors(), []);
  await player.page.close();
  await yt.page.close();
});

test("updating from the 15:36 build Jay had in Arc over a playing tab: no errors on play and pause", async () => {
  await install("12383df");   // its bridge.js threw when cut off and the page reported status
  const player = await open(`${origin}/player?src=${other}/tone.wav`);
  // Its dialog left open across the update kept refreshing and threw twice a second (Jay's 30nama tab).
  await clickIcon(player.page);
  assert.equal(await until(async () => (await dialog(player.page)) !== "closed", 3000), true, "old dialog open");
  await wait(500);   // (that build doesn't mark its dialog ready; give it time to load its values)
  await call({ type: "setTab", tabId: player.tabId, percent: 300 });   // makes the page report "cross-origin"
  await wait(500);
  await clearErrors();
  await install("working tree");
  await call({ type: "setTab", tabId: player.tabId, percent: 300 });
  for (let i = 0; i < 3; i++) {
    await player.page.evaluate(async () => { const a = document.getElementById("a"); a.pause(); await new Promise((r) => setTimeout(r, 200)); await a.play(); });
    await wait(300);
  }
  assert.equal((await state(player.tabId)).status, "cross-origin", "the new version hears the page");
  assert.equal(await dialog(player.page), "closed", "the new version closed the old dialog");
  await wait(1500);
  assert.deepEqual(await errors(), [], "the old cut-off copies stay quiet");
  await call({ type: "setTab", tabId: player.tabId, percent: 100 });
  await player.page.close();
});

test("reloading the extension while tabs play: no errors, tabs keep working", async () => {
  await install("working tree");
  const player = await open(`${origin}/player?src=${other}/tone.wav`);
  for (let i = 0; i < 3; i++) {
    await install("working tree");
    await player.page.evaluate(async () => { const a = document.getElementById("a"); a.pause(); await wait(); await a.play(); function wait() { return new Promise((r) => setTimeout(r, 200)); } });
    await call({ type: "setTab", tabId: player.tabId, percent: 40 + i * 10 });
    await wait(300);
    near((await realVolume(player.tabId))[0], gain(40 + i * 10), `after reload ${i + 1}`);
  }
  // With the dialog open when the extension reloads: it closes itself, and nothing throws.
  await clickIcon(player.page);
  assert.equal(await until(async () => (await dialog(player.page)) === "ready", 3000), true);
  await install("working tree");
  assert.equal(await until(async () => (await dialog(player.page)) === "closed", 3000), true, "the cut-off dialog closes");
  await wait(1500);   // a few of its refreshes would have run by now
  await clickIcon(player.page);
  assert.equal(await until(async () => (await dialog(player.page)) === "ready", 3000), true, "and opens again with the new version");
  await player.page.keyboard.press("Escape");
  assert.deepEqual(await errors(), []);
  await player.page.close();
});

test("copying new files into the folder makes the extension reload itself once, and open tabs keep working", async () => {
  await install("working tree");
  const p = await open(`${origin}/player?src=/tone.wav`);
  await wait(4000);   // past the startup grace period
  const marker = async () => bg(() => self.__marker ?? null).catch(() => "gone");
  await bg(() => { self.__marker = "old"; });

  // An update lands in the folder (install.sh and the dev copy swap the whole folder at once).
  const file = path.join(extDir, "content/input.js");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\n// updated\n");
  const other = await newTab(`${origin}/player?another=1`);   // any page load lets the extension notice
  assert.equal(await until(async () => (await marker()) === null, 8000), true, "reloaded by itself");
  await bg(() => { self.__marker = "new"; });
  for (let i = 0; i < 4; i++) {   // page loads and tab switches after the update must not reload it again
    const extra = await newTab(`${origin}/player?more=${i}`);
    if (headless.length) await p.page.bringToFront();
    await wait(1000);
    await extra.close();
  }
  assert.equal(await marker(), "new", "and only once (no reload loop)");
  const loads = await bg(async () => (await chrome.storage.local.get("loads")).loads);
  assert.equal(loads.filter((l) => l.selfReload).length, 1, `one self-reload in the load history (${JSON.stringify(loads)})`);

  // The tab that was open keeps working with the new version.
  await call({ type: "setTab", tabId: p.tabId, percent: 40 });
  await wait(300);
  near((await realVolume(p.tabId))[0], gain(40), "volume");
  if (headless.length) await p.page.bringToFront();
  await p.page.mouse.move(300, 300);
  await p.page.keyboard.down("Meta");
  await p.page.mouse.wheel(0, 100);   // down is louder
  await p.page.keyboard.up("Meta");
  assert.equal(await until(async () => (await state(p.tabId)).tab === 45, 2000), true, "Option + scroll on the old tab");
  await p.page.keyboard.press("Escape");
  await call({ type: "setTab", tabId: p.tabId, percent: 100 });
  assert.deepEqual(await errors(), []);
  await other.close();
  await p.page.close();
});

test("the toolbar icon opens the dialog quickly, keys stay in it, and it closes on Esc, outside clicks and a second click", async () => {
  const p = await open(`${origin}/player?src=/tone.wav`);
  await p.page.evaluate(() => { window.keys = 0; document.addEventListener("keydown", () => window.keys++); });
  const times = [];
  for (let i = 0; i < 3; i++) {
    if (i === 0) await bg(() => {}).catch(() => {});   // first one with the background already awake
    const t = Date.now();
    await clickIcon(p.page);
    assert.equal(await until(async () => (await dialog(p.page)) === "ready", 3000), true);
    times.push(Date.now() - t);
    await p.page.keyboard.press("Escape");
    await until(async () => (await dialog(p.page)) === "closed", 1000);
  }
  console.log(`    dialog ready after ${times.join(", ")} ms`);
  assert.ok(Math.max(...times) < 600, `opens in under 600 ms (${times})`);

  await clickIcon(p.page);
  await until(async () => (await dialog(p.page)) === "ready");
  await p.page.keyboard.press("5");
  await p.page.keyboard.press("ArrowRight");
  await wait(300);
  assert.equal((await state(p.tabId)).tab, 55);
  near((await realVolume(p.tabId))[0], gain(55));
  assert.equal(await p.page.evaluate(() => window.keys), 0, "the page saw no keys");
  await p.page.mouse.click(8, 8);
  assert.equal(await until(async () => (await dialog(p.page)) === "closed", 1000), true, "outside click closes");
  await clickIcon(p.page);
  await until(async () => (await dialog(p.page)) === "ready");
  await wait(200);   // a person's second click
  await clickIcon(p.page);
  assert.equal(await until(async () => (await dialog(p.page)) === "closed", 1000), true, "second click closes");

  // The volume holds after the dialog closes.
  await wait(1500);
  assert.equal((await state(p.tabId)).tab, 55);
  near((await realVolume(p.tabId))[0], gain(55));
  await call({ type: "setTab", tabId: p.tabId, percent: 100 });
  assert.deepEqual(await errors(), []);
  await p.page.close();
});

test("shortcuts: the browser shortcut is registered, the page shortcut toggles the dialog, Option + scroll shows it for a moment", async () => {
  // Chrome assigns an extension's default browser shortcut on a fresh install only (not when an update adds it).
  if (id) await cdp.send("Extensions.uninstall", { id });
  await install("working tree");
  // If a browser already uses the key itself it leaves Nerdfader's browser-level shortcut unassigned (then the
  // in-page shortcut below still does the job, and the dialog shows "browser: none · change").
  const browserShortcut = (await call({ type: "state", tabId: 0 })).browserShortcut;
  console.log(`    browser-level shortcut on a fresh install: "${browserShortcut}"`);
  assert.ok(["⇧⌘0", ""].includes(browserShortcut), `browser-level shortcut is ⇧⌘0 or unassigned (got "${browserShortcut}")`);
  const p = await open(`${origin}/player?src=/tone.wav`);
  await p.page.keyboard.press("Meta+Shift+Digit0");
  assert.equal(await until(async () => (await dialog(p.page)) === "ready", 3000), true, "page shortcut opens");
  await p.page.keyboard.press("Meta+Shift+Digit0");
  assert.equal(await until(async () => (await dialog(p.page)) === "closed", 1000), true, "and closes");

  // Held down: macOS repeats the keys about every 35 ms after half a second. The dialog stays; a new press closes it.
  const keys = await ctx.newCDPSession(p.page);
  const key = (type, autoRepeat = false) =>
    keys.send("Input.dispatchKeyEvent", { type, modifiers: 4 | 8, key: ")", code: "Digit0", windowsVirtualKeyCode: 48, autoRepeat });
  await key("rawKeyDown");
  await wait(450);
  for (let i = 0; i < 15; i++) { await key("rawKeyDown", true); await wait(35); }
  await key("keyUp");
  await wait(500);
  assert.equal(await dialog(p.page), "ready", "holding the shortcut keeps the dialog open");
  await key("rawKeyDown");
  await key("keyUp");
  assert.equal(await until(async () => (await dialog(p.page)) === "closed", 1000), true, "a new press closes it");

  await p.page.mouse.move(300, 300);
  await p.page.keyboard.down("Meta");
  await p.page.mouse.wheel(0, 100);   // down is louder
  await p.page.keyboard.up("Meta");
  assert.equal(await until(async () => (await state(p.tabId)).tab === 125, 2000), true, "Option + scroll: one step");
  assert.equal(await until(async () => (await dialog(p.page)) === "ready", 2000), true, "dialog shows");
  assert.equal(await until(async () => (await dialog(p.page)) === "closed", 3500), true, "and hides by itself");
  near((await realVolume(p.tabId))[0], 1, "the element plays at full volume; the rest of the boost is in Web Audio");
  await call({ type: "setTab", tabId: p.tabId, percent: 100 });
  assert.deepEqual(await errors(), []);
  await p.page.close();
});

test("on pages extensions can't touch, the icon opens the toolbar popup", async () => {
  const page = await newTab("chrome://version");
  if (headless.length) await page.bringToFront();
  const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
  await cdp.send("Extensions.triggerAction", { id, targetId: targetInfos.find((t) => t.url.startsWith("chrome://version")).targetId });
  const popup = await until(async () => (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.url.endsWith("/popup/popup.html")), 3000);
  assert.ok(popup, "popup opened");
  assert.deepEqual(await errors(), []);
  await page.close();
});

test("boosting a same-origin player in the page, measured", async () => {
  const p = await open(`${origin}/player?src=/tone.wav`);
  await clickIcon(p.page);   // allows measuring the tab with tab capture
  await until(async () => (await dialog(p.page)) === "ready");
  await p.page.keyboard.press("Escape");
  const base = await heard(p.tabId);
  assert.ok(base > TONE * 0.5, `audible to capture (${base})`);
  await call({ type: "setTab", tabId: p.tabId, percent: 400 });
  await wait(400);
  ratio(await heard(p.tabId), base, 4, "400%");
  assert.equal((await state(p.tabId)).capture, "off", "no capture needed");
  await call({ type: "setTab", tabId: p.tabId, percent: 100 });
  await p.page.close();
});

test("capture mode under Chrome's real rules: offered, started from the dialog, stops on pause, restarts on play", async () => {
  const p = await open(`${origin}/player?src=${other}/tone.wav`);
  await clickIcon(p.page);
  await until(async () => (await dialog(p.page)) === "ready");
  await p.page.keyboard.press("End");   // 600%
  assert.equal(await until(async () => (await state(p.tabId)).status === "cross-origin", 2000), true);
  await p.page.keyboard.press("c");   // "use capture mode" from the keyboard
  assert.equal(await until(async () => (await state(p.tabId)).capture === "on", 3000), true, "capture started");
  await wait(400);   // the boost glides in
  const stats = await bg(() => chrome.runtime.sendMessage({ target: "offscreen", type: "stats" }));
  near(Math.round(stats[p.tabId].gain * 100) / 100, 6, "boost applied");
  assert.ok(stats[p.tabId].peak > TONE * 0.5, `capture hears the tab (${stats[p.tabId].peak})`);
  await p.page.keyboard.press("Escape");

  await p.page.evaluate(() => document.getElementById("a").pause());
  assert.equal(await until(async () => (await state(p.tabId)).capture === "off", 4000), true, "stops after pausing");
  await p.page.evaluate(() => document.getElementById("a").play());
  assert.equal(await until(async () => (await state(p.tabId)).capture === "on", 4000), true,
    "restarts on play without another click (the click on this page still counts)");

  // A new page in the same tab: Chrome forgets the click, so capture waits for the icon.
  await p.page.goto(`${origin}/player?src=${other}/tone.wav&again=1`);
  const after = await until(async () => {
    const s = (await state(p.tabId)).capture;
    return s === "paused" || s === "on" ? s : false;
  }, 5000);
  console.log(`    after navigating, capture is "${after}"`);
  if (after === "paused") {
    await clickIcon(p.page);
    assert.equal(await until(async () => (await state(p.tabId)).capture === "on", 3000), true, "clicking the icon resumes it");
  }
  await call({ type: "setTab", tabId: p.tabId, percent: 100 });
  assert.equal((await state(p.tabId)).capture, "off");
  assert.deepEqual(await errors(), []);
  await p.page.close();
});

test("protected (EME) media is detected, kept playing, and boosted through capture mode", async () => {
  const p = await open(`${origin}/drm`);
  assert.equal(await until(() => p.page.evaluate(() => window.ready || window.failed), 15000), true,
    `ClearKey stream started (${await p.page.evaluate(() => window.failed)})`);
  await clickIcon(p.page);
  await until(async () => (await dialog(p.page)) === "ready");
  await p.page.keyboard.press("Escape");
  await wait(500);
  const base = await heard(p.tabId);
  assert.ok(base > 0.0005, `audible to capture (${base})`);
  await call({ type: "setTab", tabId: p.tabId, percent: 300 });
  assert.equal(await until(async () => (await state(p.tabId)).status === "protected", 2000), true);
  await wait(300);
  const after = await heard(p.tabId);
  assert.ok(after > base * 0.3, `not silenced (${base} -> ${after})`);
  await call({ type: "setCapture", tabId: p.tabId, once: true });
  assert.equal(await until(async () => (await state(p.tabId)).capture === "on", 3000), true);
  await wait(400);
  const stats = await bg(() => chrome.runtime.sendMessage({ target: "offscreen", type: "stats" }));
  near(Math.round(stats[p.tabId].gain * 100) / 100, 3, "boost applied by capture");
  assert.ok(stats[p.tabId].peak > 0.0005, `capture hears the protected stream (${stats[p.tabId].peak})`);
  await call({ type: "setTab", tabId: p.tabId, percent: 100 });
  assert.deepEqual(await errors(), []);
  await p.page.close();
});

// Runs a function in the page through the extension (not Playwright's page.evaluate, which counts as a click).
let inPage;
test("with the browser's normal autoplay rule, boosting and holding the scroll key before a click logs nothing", { skip: !process.env.STRICT_AUTOPLAY && "runs with STRICT_AUTOPLAY=1 (npm run test:real does)" }, async () => {
  await install("working tree");
  await clearErrors();
  // Audio loaded but not started (as on a page you haven't clicked yet); Web Audio may not start before a click.
  // Nothing here goes through Playwright's page.evaluate, which counts as a click.
  const p = await open(`${origin}/player?src=/tone.wav&paused`);
  inPage = (func) => bg(async ([tabId, src]) => {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: (src) => (0, eval)(`(${src})()`), args: [src] });
    return r.result;
  }, [p.tabId, String(func)]);
  await p.page.bringToFront();
  await until(() => inPage(() => document.getElementById("a").readyState >= 2), 3000);
  await call({ type: "setTab", tabId: p.tabId, percent: 300 });   // wants the boost stage
  await wait(800);
  assert.equal(await inPage(() => navigator.userActivation.hasBeenActive), false, "no click yet");
  // Holding the scroll key and scrolling, pressing Esc and Shift: none of these count as a click.
  await p.page.mouse.move(300, 300);
  await p.page.keyboard.down("Meta");
  await p.page.mouse.wheel(0, 100);
  await p.page.keyboard.up("Meta");
  await p.page.keyboard.press("Escape");
  await p.page.keyboard.press("Shift");
  await wait(800);
  assert.deepEqual(await errors(), [], "no warnings about the AudioContext");
  // A real click lets the boost start, still without warnings.
  await p.page.mouse.click(20, 20);
  assert.equal(await inPage(() => navigator.userActivation.hasBeenActive), true, "clicked");
  await inPage(() => document.getElementById("a").play());
  await clickIcon(p.page);   // lets the test measure the tab with tab capture
  await until(async () => (await dialog(p.page)) === "ready");
  await p.page.keyboard.press("Escape");
  await call({ type: "setTab", tabId: p.tabId, percent: 100 });
  await wait(400);
  const base = await heard(p.tabId);
  await call({ type: "setTab", tabId: p.tabId, percent: 300 });
  await wait(400);
  ratio(await heard(p.tabId), base, 3, "the boost works once the page was clicked");
  assert.deepEqual(await errors(), []);
  await call({ type: "setTab", tabId: p.tabId, percent: 100 });
  await p.page.close();
});

for (const [name, url, play] of [
  ["YouTube", "https://www.youtube.com/watch?v=jNQXAC9IVRw", true],
  ["Vimeo (embedded player)", "https://player.vimeo.com/video/76979871", true],
  ["Facebook", "https://www.facebook.com/", false],
  ["Twitch", "https://www.twitch.tv/", false],
]) {
  test(`real site: ${name}`, async () => {
    const p = await open(url);
    await wait(3000);
    await clickIcon(p.page);
    assert.equal(await until(async () => (await dialog(p.page)) === "ready", 3000), true, "dialog opens");
    await p.page.keyboard.press("Escape");
    if (play) {
      const playing = await p.page.evaluate(async () => {
        const v = document.querySelector("video");
        if (!v) return false;
        v.volume = 0.05;   // quiet enough that 3x stays under the limiter
        await Promise.race([v.play().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
        return !v.paused && v.readyState >= 3;
      });
      if (playing) {
        // The same stretch of the video each time.
        const measure = async () => {
          await p.page.evaluate(() => {
            const v = document.querySelector("video");
            v.currentTime = 2;
            return Promise.race([v.play().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
          });
          await wait(300);
          return heard(p.tabId);
        };
        const base = await measure();
        await call({ type: "setTab", tabId: p.tabId, percent: 300 });
        await wait(300);
        const boosted = await measure();
        const status = (await state(p.tabId)).status;
        console.log(`    ${name}: peak ${base.toFixed(4)} -> ${boosted.toFixed(4)} at 300%, status "${status}"`);
        // Real audio varies from moment to moment, so this checks "clearly boosted"; exact gains are checked with
        // steady test tones above.
        assert.ok(boosted / base > 2 && boosted / base < 5, `boosted about 3x (x${(boosted / base).toFixed(2)})`);
        assert.equal(status, "", "boosted in the page, no capture needed");
        await call({ type: "setTab", tabId: p.tabId, percent: 100 });
      } else console.log(`    ${name}: video didn't start here (sign-in or consent page?)`);
    }
    assert.deepEqual(await errors(), []);
    await p.page.close();
  });
}
