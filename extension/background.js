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
  if (["hello", "status"].includes(msg.type) && !sender.tab) return false;
  handler(msg, sender).then(reply, (err) => reply({ error: String(err) }));
  return true;   // reply arrives asynchronously
});

// A tab that went quiet in capture mode starts capturing again when it plays.
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
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

function badgeColors() {
  chrome.action.setBadgeBackgroundColor({ color: "#ff3fa4" });
  chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
}

chrome.runtime.onInstalled.addListener(async () => {
  badgeColors();
  // Content scripts only start in pages loaded after install, so add them to the tabs already open.
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*", "file:///*"] })) {
    const target = { tabId: tab.id, allFrames: true };
    chrome.scripting
      .executeScript({ target, files: ["content/main.js"], world: "MAIN", injectImmediately: true })
      .then(() => chrome.scripting.executeScript({ target, files: ["content/bridge.js"] }))
      .catch(() => {});   // pages the browser protects (the Web Store, other extensions)
  }
  reconcileAll();
});

chrome.runtime.onStartup.addListener(badgeColors);
