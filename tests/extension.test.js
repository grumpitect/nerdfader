// End-to-end tests: loads the unpacked extension into Playwright's Chromium and checks what pages actually play at.
// "page" values are what the site sees (element.volume in its own world); "real" values are what the browser plays
// at, read from an isolated world where the volume property is not patched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} expected ${b}, got ${a}`);
const gain = (p) => (p / 100) ** 3;

let server, origin, otherOrigin, context, ext;

const pages = {
  "/": `<!doctype html><title>t</title><audio id="a"></audio><video id="v"></video>
        <iframe id="f"></iframe>
        <script>document.getElementById("a").volume = 0.8;</script>`,
  "/frame": `<!doctype html><audio id="inner"></audio><script>document.getElementById("inner").volume = 0.5;</script>`,
};

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(pages[new URL(req.url, "http://x").pathname] ?? "");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  origin = `http://127.0.0.1:${port}`;
  otherOrigin = `http://localhost:${port}`;   // a different origin, for the cross-origin iframe
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const id = new URL(sw.url()).host;
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
const settle = () => new Promise((r) => setTimeout(r, 150));

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
  assert.deepEqual(state, { tab: 70, override: { on: false, percent: 20 } });
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
    window.returned = osc.connect(ctx.destination) === ctx.destination;
    osc.start();
  });
  assert.equal(await page.evaluate(() => window.returned), true, "connect() returns the destination for chaining");
  assert.equal(await page.evaluate(() => created.length), 1);
  near(await page.evaluate(() => created[0].gain.value), 1);

  await send({ type: "setTab", tabId, percent: 40 });
  await new Promise((r) => setTimeout(r, 400));   // the gain glides over ~50 ms
  const value = await page.evaluate(() => created[0].gain.value);
  assert.ok(Math.abs(value - gain(40)) < 1e-3, `gain ${value}`);

  // Offline rendering is not touched.
  assert.equal(await page.evaluate(() => {
    const off = new OfflineAudioContext(1, 128, 44100);
    off.createOscillator().connect(off.destination);
    return created.length;
  }), 1);
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

test("popup shows and changes the current tab", async () => {
  const { page, tabId } = await openTestPage();
  const url = page.url();
  const popup = await context.newPage();
  // A popup opened as a tab would see itself as the active tab, so point it at the test page.
  await popup.addInitScript(([tabId, url]) => {
    chrome.tabs.query = async () => [{ id: tabId, url }];
  }, [tabId, url]);
  await popup.setViewportSize({ width: 320, height: 300 });
  await popup.goto(ext.url());
  await popup.locator("#percent", { hasText: "100%" }).waitFor();
  assert.equal(await popup.locator("#target").textContent(), "127.0.0.1");

  await popup.keyboard.press("4");
  await popup.locator("#percent", { hasText: "40%" }).waitFor();
  await settle();
  near((await real(tabId)).a, 0.8 * gain(40));
  await popup.keyboard.press("ArrowRight");
  await popup.locator("#percent", { hasText: "45%" }).waitFor();
  await popup.click("#reset");
  await popup.locator("#percent", { hasText: "100%" }).waitFor();
  assert.equal(await popup.locator("#reset").isDisabled(), true);

  await popup.click("#toggleRow");
  await popup.locator("#target", { hasText: "all tabs" }).waitFor();
  await popup.keyboard.press("3");
  await settle();
  near((await real(tabId)).a, 0.8 * gain(30));
  await popup.click("#toggleRow");
  await popup.locator("#target", { hasText: "127.0.0.1" }).waitFor();
  await send({ type: "setOverride", on: false, percent: 100 });
  await send({ type: "setTab", tabId, percent: 100 });
  await popup.close();

  // SCREENSHOT=docs/popup.png npm test: renders the popup for the README, as if it were open on a video site.
  if (process.env.SCREENSHOT) {
    const shot = await context.newPage();
    await shot.addInitScript((tabId) => {
      chrome.tabs.query = async () => [{ id: tabId, url: "https://www.youtube.com/watch" }];
    }, tabId);
    await shot.goto(ext.url());
    await shot.locator("#percent", { hasText: "100%" }).waitFor();
    await shot.keyboard.press("4");
    await shot.locator("#percent", { hasText: "40%" }).waitFor();
    await shot.evaluate(() => document.activeElement.blur());
    await shot.waitForTimeout(300);
    await shot.locator("body").screenshot({ path: process.env.SCREENSHOT, scale: "device" });
    await send({ type: "setTab", tabId, percent: 100 });
    await shot.close();
  }
  await page.close();
});
