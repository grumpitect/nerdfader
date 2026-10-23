// Keeps every tab's volume and the "all tabs" override, pushes the right level to each tab, and runs capture mode.
//
// Volumes are percents (0 to 600). A tab without its own setting plays at 100%. Per-tab settings live in
// storage.session, so they last until the tab closes or the browser quits; the override and the "always use capture
// mode" choice live in storage.local. While the override is on every tab plays at the override's percent, and each
// tab's own setting is kept for when it is turned off.
//
// Above 100% pages boost themselves (content/main.js). When a page can't (DRM, media from another site, no click
// yet) it reports why, and if the user allowed capture mode for that tab, the tab's sound is captured and boosted in
// the offscreen page instead. Capture only runs while it is needed: it stops soon after the tab stops playing, and
// starts again when the tab plays. The browser only allows capturing a tab after the user opened Nerdfader on it,
// so if a restart is refused, it waits until the popup is opened on that tab again.

const DEFAULT = 100;
const MAX = 600;
const STOP_AFTER = 1500;   // ms to keep capturing after the page stops playing, so pause/resume doesn't flicker

// Slider percent to amplitude. Up to 100% a cubic curve (like VLC's and Nerdwave's) so turning down feels even to
// the ear: 50% is clearly half as loud. Above 100% the percent is the multiplier, like other boosters: 600% is 6x
// (+15.6 dB).
const gainOf = (percent) => (percent <= 100 ? (percent / 100) ** 3 : percent / 100);
const clamp = (p) => Math.round(Math.min(MAX, Math.max(0, Number(p) || 0)));
// The slider's first half is 0 to 100% in steps of 1, its second half 100 to 600% in steps of 5 (as in ui/panel.js).
const toPercent = (pos) => (pos <= 100 ? pos : 100 + (pos - 100) * 5);
const toPos = (p) => (p <= 100 ? p : 100 + (p - 100) / 5);

// The keyboard shortcuts, handled in every page by content/input.js (there are no browser-level ones: those can't be
// set by an extension, so they'd drift from what the dialog shows). Stored as the key's code and modifiers, all with
// Command + Shift (Ctrl + Shift off a Mac): End opens the dialog, Delete (the Backspace key) resets the tab to 100%,
// Up and Down turn it up and down a step. (Chrome's own "Delete browsing data" is also Command + Shift + Delete;
// Arc has nothing there.) Scrolling changes the volume with Command + Shift (Windows key + Shift elsewhere) held. Only
// defaults: choices the user made are kept.
const SHORTCUTS = { shortcut: "End", resetShortcut: "Backspace", upShortcut: "ArrowUp", downShortcut: "ArrowDown" };
// Defaults the browser itself already uses get Command + Shift + a number instead, in order: 0, 1, 2... (1, 2, 3...
// off a Mac, where Windows often keeps Ctrl + Shift + 0). Arc uses none of them (checked against its menus); Chrome
// (and, as far as we know, other Chromium browsers) uses Command/Ctrl + Shift + Delete for "Delete browsing data".
// Which browser this is comes from the pages (content/input.js): Arc adds its theme colors to every page.
const TAKEN_BY_BROWSER = { arc: [], chromium: ["resetShortcut"] };
// Version 1.2 changed the keys (End opens, Up/Down added, scroll keys became a combination), so key and scroll
// choices saved by an older version are cleared once and everything starts from the new defaults. Volumes and the
// other switches are kept.
const KEYS_VERSION = 2;
let keysUpgraded = null;
function upgradeKeys() {
  keysUpgraded ??= (async () => {
    const { keysVersion = 1 } = await chrome.storage.local.get("keysVersion");
    if (keysVersion >= KEYS_VERSION) return;
    await chrome.storage.local.remove([...Object.keys(SHORTCUTS), "altScroll", "scrollKey", "scrollKeys"]);
    await chrome.storage.local.set({ keysVersion: KEYS_VERSION });
  })().catch(() => {});
  return keysUpgraded;
}

async function settings() {
  await upgradeKeys();
  const mac = (await chrome.runtime.getPlatformInfo()).os === "mac";
  const keys = (code) => ({ code, shift: true, meta: mac, ctrl: !mac, alt: false });
  const stored = await chrome.storage.local.get([...Object.keys(SHORTCUTS), "altScroll", "scrollKeys", "scrollKey", "browser"]);
  // Until a page has told which browser this is, the defaults are the wanted ones.
  const taken = TAKEN_BY_BROWSER[stored.browser] ?? [];
  let number = mac ? 0 : 1;
  const defaults = Object.fromEntries(Object.entries(SHORTCUTS).map(([name, code]) =>
    [name, keys(taken.includes(name) ? `Digit${number++}` : code)]));
  // The keys to hold while scrolling: any combination of "alt", "ctrl", "shift" and "meta", at least one. (Versions
  // before 1.2 kept a single key as scrollKey.)
  const scrollKeys = stored.scrollKeys ?? (stored.scrollKey ? [stored.scrollKey] : ["shift", "meta"]);
  const result = { altScroll: stored.altScroll ?? true, scrollKeys };
  for (const name of Object.keys(SHORTCUTS)) result[name] = stored[name] === undefined ? defaults[name] : stored[name];
  return result;
}

const key = {
  tab: (id) => `tab:${id}`,           // the tab's own percent
  blocked: (id) => `blocked:${id}`,   // { frameId: why that frame can't boost }
  capture: (id) => `capture:${id}`,   // { state: off | on | idle | paused, once: allowed for this tab }
};
const get = async (area, k, fallback) => (await chrome.storage[area].get(k))[k] ?? fallback;

async function override() {
  const { overrideOn = false, overridePercent = DEFAULT } = await chrome.storage.local.get(["overrideOn", "overridePercent"]);
  return { on: overrideOn, percent: overridePercent };
}

async function tabInfo(tabId) {
  const [own, o, blocked, capture, captureAlways] = await Promise.all([
    get("session", key.tab(tabId), DEFAULT),
    override(),
    get("session", key.blocked(tabId), {}),
    get("session", key.capture(tabId), { state: "off", once: false }),
    get("local", "captureAlways", false),
  ]);
  const percent = o.on ? o.percent : own;
  const status = Object.values(blocked).find(Boolean) ?? "";
  const allowed = captureAlways || capture.once;
  return { own, override: o, percent, status, capture, captureAlways, allowed, need: percent > DEFAULT && status !== "" && allowed };
}

// What the page itself should play at: while capture boosts the tab, the page only turns down, never up.
const pageGain = (info) => (info.capture.state === "on" ? Math.min(gainOf(info.percent), 1) : gainOf(info.percent));

function push(tabId, info) {
  chrome.tabs.sendMessage(tabId, { type: "level", gain: pageGain(info) }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: info.percent === DEFAULT ? "" : String(info.percent) }).catch(() => {});
}

// Offscreen page that plays captured tabs back.
let creating = null;
async function offscreen(msg) {
  if (!(await chrome.offscreen.hasDocument())) {
    creating ??= chrome.offscreen.createDocument({
      url: "offscreen/offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Plays a captured tab's sound back louder when the page can't be boosted directly.",
    }).finally(() => (creating = null));
    await creating;
  }
  return chrome.runtime.sendMessage({ target: "offscreen", ...msg });
}
// Stops one tab's capture (a no-op if it already ended) and closes the offscreen page once nothing is captured.
async function stopCapture(tabId) {
  if (!(await chrome.offscreen.hasDocument())) return;
  const reply = await chrome.runtime.sendMessage({ target: "offscreen", type: "stop", tabId });
  if (reply?.active === 0) await chrome.offscreen.closeDocument().catch(() => {});
}

// Brings one tab in line with its settings. Calls for the same tab run one at a time.
const queues = new Map();
const stopTimers = new Map();
function reconcile(tabId, opts = {}) {
  const next = (queues.get(tabId) ?? Promise.resolve()).then(() => reconcileNow(tabId, opts)).catch(() => {});
  queues.set(tabId, next);
  next.then(() => queues.get(tabId) === next && queues.delete(tabId));
  return next;
}
async function reconcileNow(tabId, { opened = false, audible = false, stopNow = false } = {}) {
  const info = await tabInfo(tabId);
  const setState = async (state) => {
    info.capture = { ...info.capture, state };
    await chrome.storage.session.set({ [key.capture(tabId)]: info.capture });
  };
  const { state } = info.capture;

  if (!info.need) {
    if (state === "on") {
      // The page stopped playing: wait a moment in case it resumes. A lower volume or turning capture off: stop now.
      const quietOnly = info.percent > DEFAULT && info.allowed;
      if (quietOnly && !stopNow) {
        if (!stopTimers.has(tabId)) {
          stopTimers.set(tabId, setTimeout(() => { stopTimers.delete(tabId); reconcile(tabId, { stopNow: true }); }, STOP_AFTER));
        }
        return push(tabId, info);
      }
      await stopCapture(tabId);
    }
    if (state !== "off") await setState("off");
    return push(tabId, info);
  }

  clearTimeout(stopTimers.get(tabId));
  stopTimers.delete(tabId);
  if (state === "on") {
    await offscreen({ type: "gain", tabId, gain: gainOf(info.percent) });
    return push(tabId, info);
  }
  // Quiet tabs restart when they play again; refused restarts wait for the popup to be opened on the tab.
  const tryNow = opened || state === "off" || (state === "idle" && audible);
  if (!tryNow) return push(tabId, info);
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const reply = await offscreen({ type: "start", tabId, streamId, gain: gainOf(info.percent) });
    if (!reply?.ok) throw new Error(reply?.error ?? "capture failed");
    await setState("on");
  } catch {
    await setState("paused");
  }
  push(tabId, info);
}

async function reconcileAll() {
  for (const tab of await chrome.tabs.query({})) reconcile(tab.id);
}

async function state(tabId) {
  const info = await tabInfo(tabId);
  return {
    settings: await settings(),
    tab: info.own,
    override: info.override,
    status: info.status,
    capture: info.capture.state,
    allowed: info.allowed,
    captureAlways: info.captureAlways,
  };
}

const handlers = {
  // From a page (bridge.js) as it loads: which level to play at.
  async hello(_msg, sender) {
    reloadIfFilesChanged();
    const tabId = sender.tab.id;
    if (sender.frameId === 0) {
      // A new page: forget what the previous one reported.
      await chrome.storage.session.remove(key.blocked(tabId));
      reconcile(tabId);   // also refreshes the badge after a navigation
    }
    return { gain: pageGain(await tabInfo(tabId)) };
  },
  // From a page: why this frame can't boost what it is playing ("" when it can, or nothing is playing).
  async status(msg, sender) {
    const tabId = sender.tab.id;
    const blocked = await get("session", key.blocked(tabId), {});
    if (msg.status) blocked[sender.frameId] = msg.status;
    else delete blocked[sender.frameId];
    await chrome.storage.session.set({ [key.blocked(tabId)]: blocked });
    await reconcile(tabId);
  },
  // From the popup.
  async opened(msg) {
    await reconcile(msg.tabId, { opened: true });
    return state(msg.tabId);
  },
  state: (msg) => state(msg.tabId),
  async setTab(msg) {
    const percent = clamp(msg.percent);
    if (percent === DEFAULT) await chrome.storage.session.remove(key.tab(msg.tabId));
    else await chrome.storage.session.set({ [key.tab(msg.tabId)]: percent });
    await reconcile(msg.tabId, { opened: true });
    return state(msg.tabId);
  },
  async setOverride(msg) {
    const change = {};
    if (typeof msg.on === "boolean") change.overrideOn = msg.on;
    if (msg.percent !== undefined) change.overridePercent = clamp(msg.percent);
    await chrome.storage.local.set(change);
    await reconcile(msg.tabId, { opened: true });
    reconcileAll();
    return state(msg.tabId);
  },
  // Allow capture mode for this tab (once) or for every tab that needs it (always), or turn "always" off.
  async setCapture(msg) {
    if (typeof msg.always === "boolean") await chrome.storage.local.set({ captureAlways: msg.always });
    if (msg.once) {
      const capture = await get("session", key.capture(msg.tabId), { state: "off", once: false });
      await chrome.storage.session.set({ [key.capture(msg.tabId)]: { ...capture, once: true } });
    }
    await reconcile(msg.tabId, { opened: true });
    if (typeof msg.always === "boolean") reconcileAll();
    return state(msg.tabId);
  },
  // From a page (content/input.js): the shortcut was pressed, or Option/Alt + scroll moved the volume by some steps.
  async toggle(_msg, sender) {
    await openPanel(sender.tab);
  },
  // The reset shortcut: back to 100% (every tab's volume, while all_tabs is on), with the dialog shown for a moment.
  async resetTab(_msg, sender) {
    await resetVolume(sender.tab);
    return { percent: DEFAULT };
  },
  // Quick scrolling sends several at once; each starts from where the previous one left the volume.
  nudge(msg, sender) {
    const tabId = sender.tab.id;
    const next = (nudges.get(tabId) ?? Promise.resolve()).then(async () => {
      const info = await tabInfo(tabId);
      const percent = clamp(toPercent(Math.min(200, Math.max(0, toPos(info.percent) + 5 * Math.trunc(msg.steps)))));
      if (info.override.on) await handlers.setOverride({ tabId, percent });
      else await handlers.setTab({ tabId, percent });
      openPanel(sender.tab, { moment: true });
      return { percent };
    });
    nudges.set(tabId, next.catch(() => {}));
    return next;
  },
  getSettings: () => settings(),
  // From a page: whether this browser is Arc. Once a page has seen Arc, it stays Arc.
  async browserIs(msg) {
    const { browser } = await chrome.storage.local.get("browser");
    const next = msg.arc || browser === "arc" ? "arc" : "chromium";
    if (next === browser) return;
    await chrome.storage.local.set({ browser: next });
    await noteLoad({ browser: next });
    const now = await settings();
    for (const tab of await chrome.tabs.query({})) chrome.tabs.sendMessage(tab.id, { type: "settings", settings: now }).catch(() => {});
  },
  // From the panel: the shortcuts (each null for none), whether modifier + scroll changes the volume, and which
  // modifiers to hold for it (scrollKeys: any of "alt", "ctrl", "shift", "meta", at least one).
  async setSettings(msg) {
    const change = {};
    for (const name of Object.keys(SHORTCUTS)) if (msg[name] !== undefined) change[name] = msg[name];
    if (typeof msg.altScroll === "boolean") change.altScroll = msg.altScroll;
    if (Array.isArray(msg.scrollKeys)) {
      const keys = ["alt", "ctrl", "shift", "meta"].filter((k) => msg.scrollKeys.includes(k));
      if (keys.length) change.scrollKeys = keys;   // at least one stays on
    }
    await chrome.storage.local.set(change);
    const next = await settings();
    for (const tab of await chrome.tabs.query({})) chrome.tabs.sendMessage(tab.id, { type: "settings", settings: next }).catch(() => {});
    return state(msg.tabId);
  },
  // From the offscreen page.
  async captureIdle(msg) {
    const capture = await get("session", key.capture(msg.tabId), null);
    if (capture?.state === "on") await chrome.storage.session.set({ [key.capture(msg.tabId)]: { ...capture, state: "idle" } });
    await stopCapture(msg.tabId);
    reconcile(msg.tabId);
  },
  async captureEnded(msg) {
    const capture = await get("session", key.capture(msg.tabId), null);
    if (capture?.state === "on") await chrome.storage.session.set({ [key.capture(msg.tabId)]: { ...capture, state: "paused" } });
    await stopCapture(msg.tabId);
    reconcile(msg.tabId);
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target === "offscreen") return false;
  const handler = handlers[msg?.type];
  if (!handler) return false;
  if (["hello", "status", "toggle", "nudge", "resetTab", "browserIs"].includes(msg.type) && !sender.tab) return false;
  if (msg.tabId === undefined && sender.tab) msg.tabId = sender.tab.id;   // the in-page dialog doesn't know its tab id
  handler(msg, sender).then(reply, (err) => reply({ error: String(err) }));
  return true;   // reply arrives asynchronously
});

// Clicking the toolbar icon opens (or closes) the dialog in the page. Pages extensions can't reach get the toolbar
// popup instead: it is set for that tab and opened, or opens on the next click where opening it directly isn't
// supported.
const nudges = new Map();   // tabId -> the last volume nudge, so the next one waits for it
// { moment: true } shows it for a moment (modifier + scroll, the reset shortcut), or keeps it up if it is already
// showing; otherwise it opens the dialog, or closes it if it is open.
async function openPanel(tab, { moment = false } = {}) {
  reloadIfFilesChanged();
  // Opening it lets capture mode run on this tab, but only from the toolbar icon: the browser counts that (not the
  // in-page shortcut) as the user invoking the extension, and asks for it before capturing.
  if (!moment) reconcile(tab.id, { opened: true });
  const target = { tabId: tab.id };
  try {
    await chrome.scripting.executeScript({ target, func: (moment) => { globalThis.__nerdfaderOpen = { moment }; }, args: [moment] });
    await chrome.scripting.executeScript({ target, files: ["ui/panel.js", "ui/overlay.js"] });
  } catch {
    if (moment) return;
    await chrome.action.setPopup({ tabId: tab.id, popup: "popup/popup.html" });
    await chrome.action.openPopup?.({ windowId: tab.windowId }).catch(() => {});
  }
}
chrome.action.onClicked.addListener((tab) => openPanel(tab));

async function resetVolume(tab) {
  const info = await tabInfo(tab.id);
  if (info.override.on) await handlers.setOverride({ tabId: tab.id, percent: DEFAULT });
  else await handlers.setTab({ tabId: tab.id, percent: DEFAULT });
  openPanel(tab, { moment: true });
}

// A tab that went quiet in capture mode starts capturing again when it plays.
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  // A new page may be one the dialog can open in again.
  if (change.status === "loading") chrome.action.setPopup({ tabId, popup: "" }).catch(() => {});
  if (change.audible !== true) return;
  const capture = await get("session", key.capture(tabId), null);
  if (capture?.state === "idle") reconcile(tabId, { audible: true });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  clearTimeout(stopTimers.get(tabId));
  stopTimers.delete(tabId);
  await stopCapture(tabId).catch(() => {});
  chrome.storage.session.remove([key.tab(tabId), key.blocked(tabId), key.capture(tabId)]);
});

// Chrome sometimes swaps a tab for a prerendered one with a new id; carry the setting over.
chrome.tabs.onReplaced.addListener(async (added, removed) => {
  const percent = await get("session", key.tab(removed), DEFAULT);
  await chrome.storage.session.remove([key.tab(removed), key.blocked(removed), key.capture(removed)]);
  if (percent !== DEFAULT) await chrome.storage.session.set({ [key.tab(added)]: percent });
});

// Loaded from a folder (Load unpacked: installs from GitHub, and development), the extension notices when its files on
// disk change (an update copied in) and reloads itself, so the whole extension runs the new version together instead
// of new dialog files talking to an old background until someone clicks the reload arrow. Open tabs are taken over by
// the new version's scripts.
//
// The fingerprint of the running version lives in storage.session, which the browser empties whenever the extension
// is (re)loaded: an empty one means "just loaded", so the files on disk right now are the ones running. (It used to be
// saved in onInstalled; Arc then reloaded over and over, as if it doesn't send onInstalled for a self-reload.)
// The same "just loaded" moment attaches the new scripts to the tabs already open. As a last guard, three self-reloads
// within ten minutes stop it. The last few loads are kept in storage.local ("loads") to see what a browser did.
const WATCHED = [
  "manifest.json", "background.js", "content/main.js", "content/bridge.js", "content/input.js",
  "ui/panel.js", "ui/overlay.js", "popup/popup.html", "popup/popup.js", "offscreen/offscreen.js",
];
// null when any file couldn't be read: that means "can't tell", never "changed".
async function filesFingerprint() {
  const texts = await Promise.all(WATCHED.map((f) =>
    fetch(chrome.runtime.getURL(f), { cache: "no-store" }).then((r) => (r.ok ? r.text() : null), () => null)));
  if (texts.includes(null)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texts.join("\0")));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
let noting = Promise.resolve();
function noteLoad(entry) {
  noting = noting.then(async () => {
    const { loads = [] } = await chrome.storage.local.get("loads");
    await chrome.storage.local.set({ loads: [...loads, { at: new Date().toISOString(), ...entry }].slice(-12) });
  }).catch(() => {});
  return noting;
}
const running = (async () => {
  const { runningFingerprint } = await chrome.storage.session.get("runningFingerprint");
  if (runningFingerprint) return runningFingerprint;
  // Just loaded (installed, updated, reloaded, or the browser started): take over the tabs that are already open.
  let now = await filesFingerprint();
  for (let i = 0; !now && i < 5; i++) { await new Promise((r) => setTimeout(r, 500)); now = await filesFingerprint(); }
  if (now) await chrome.storage.session.set({ runningFingerprint: now });
  noteLoad({ fresh: true, version: chrome.runtime.getManifest().version, files: now?.slice(0, 12) ?? "unreadable" });
  attachToOpenTabs();
  return now;
})().catch(() => null);
let checking = null;   // checks that overlap share one
function reloadIfFilesChanged() {
  checking ??= (async () => {
    const was = await running;
    if (!was || (await chrome.management.getSelf()).installType !== "development") return;
    const disk = await filesFingerprint();
    if (!disk || was === disk) return;
    const { selfReloads = [] } = await chrome.storage.local.get("selfReloads");
    const recent = selfReloads.filter((t) => Date.now() - t < 10 * 60_000);
    if (recent.length >= 3) return;   // looping somehow: stop
    await chrome.storage.local.set({ selfReloads: [...recent, Date.now()] });
    await noteLoad({ selfReload: true, from: was.slice(0, 12), to: disk.slice(0, 12) });
    chrome.runtime.reload();
  })().catch(() => {}).finally(() => (checking = null));
}
chrome.tabs.onActivated.addListener(() => reloadIfFilesChanged());

function badgeColors() {
  chrome.action.setBadgeBackgroundColor({ color: "#ff3fa4" });
  chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
}

// Content scripts only start in pages loaded after the extension, so add them to the tabs already open. Safe to run
// on a page that has them already: each script takes over from, or steps aside for, an earlier copy.
async function attachToOpenTabs() {
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*", "file:///*"] })) {
    const target = { tabId: tab.id, allFrames: true };
    // A dialog left open by the previous version is cut off now; asking it to close also stops its refreshes.
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.querySelectorAll("nerdfader-dialog").forEach((d) => d.dispatchEvent(new Event("nerdfader-close"))),
    }).catch(() => {});
    chrome.scripting
      .executeScript({ target, files: ["content/main.js"], world: "MAIN", injectImmediately: true })
      .then(() => chrome.scripting.executeScript({ target, files: ["content/bridge.js", "content/input.js"] }))
      .catch(() => {});   // pages the browser protects (the Web Store, other extensions)
  }
  reconcileAll();
}

chrome.runtime.onInstalled.addListener(async (details) => {
  badgeColors();
  noteLoad({ installed: details.reason });
});

chrome.runtime.onStartup.addListener(badgeColors);
