// Keeps every tab's volume and the "all tabs" override, and pushes the right level to each tab.
//
// Volumes are percents (0 to 100). A tab without its own setting plays at 100%. Per-tab settings live in
// storage.session, so they last until the tab closes or the browser quits; the override lives in storage.local.
// While the override is on every tab plays at the override's percent, and each tab's own setting is kept for
// when it is turned off.

const DEFAULT = 100;
const tabKey = (id) => `tab:${id}`;

// Slider percent to amplitude. A cubic curve (like VLC's and Nerdwave's) so the slider feels even to the ear:
// 50% is clearly half as loud instead of barely quieter.
const gainOf = (percent) => (percent / 100) ** 3;

async function tabPercent(tabId) {
  const key = tabKey(tabId);
  return (await chrome.storage.session.get(key))[key] ?? DEFAULT;
}

async function override() {
  const { overrideOn = false, overridePercent = DEFAULT } = await chrome.storage.local.get(["overrideOn", "overridePercent"]);
  return { on: overrideOn, percent: overridePercent };
}

async function effectivePercent(tabId) {
  const o = await override();
  return o.on ? o.percent : tabPercent(tabId);
}

async function push(tabId, percent) {
  chrome.tabs.sendMessage(tabId, { type: "level", gain: gainOf(percent) }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: percent === DEFAULT ? "" : String(percent) }).catch(() => {});
}

async function pushAll() {
  const o = await override();
  const tabs = await chrome.tabs.query({});
  const stored = o.on ? {} : await chrome.storage.session.get(null);
  for (const tab of tabs) push(tab.id, o.on ? o.percent : stored[tabKey(tab.id)] ?? DEFAULT);
}

async function state(tabId) {
  return { tab: await tabPercent(tabId), override: await override() };
}

const handlers = {
  // From a page (bridge.js) as it loads: which level to play at.
  async hello(_msg, sender) {
    const percent = await effectivePercent(sender.tab.id);
    if (sender.frameId === 0) push(sender.tab.id, percent);   // also refreshes the badge after a navigation
    return { gain: gainOf(percent) };
  },
  // From the popup.
  state: (msg) => state(msg.tabId),
  async setTab(msg) {
    const percent = clamp(msg.percent);
    if (percent === DEFAULT) await chrome.storage.session.remove(tabKey(msg.tabId));
    else await chrome.storage.session.set({ [tabKey(msg.tabId)]: percent });
    if (!(await override()).on) push(msg.tabId, percent);
    return state(msg.tabId);
  },
  async setOverride(msg) {
    const change = {};
    if (typeof msg.on === "boolean") change.overrideOn = msg.on;
    if (msg.percent !== undefined) change.overridePercent = clamp(msg.percent);
    await chrome.storage.local.set(change);
    await pushAll();
    return state(msg.tabId);
  },
};

const clamp = (p) => Math.round(Math.min(100, Math.max(0, Number(p) || 0)));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender).then(reply, (err) => reply({ error: String(err) }));
  return true;   // reply arrives asynchronously
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(tabKey(tabId)));

// Chrome sometimes swaps a tab for a prerendered one with a new id; carry the setting over.
chrome.tabs.onReplaced.addListener(async (added, removed) => {
  const percent = await tabPercent(removed);
  await chrome.storage.session.remove(tabKey(removed));
  if (percent !== DEFAULT) await chrome.storage.session.set({ [tabKey(added)]: percent });
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.action.setBadgeBackgroundColor({ color: "#ff3fa4" });
  chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
  // Content scripts only start in pages loaded after install, so add them to the tabs already open.
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*", "file:///*"] })) {
    const target = { tabId: tab.id, allFrames: true };
    chrome.scripting
      .executeScript({ target, files: ["content/main.js"], world: "MAIN", injectImmediately: true })
      .then(() => chrome.scripting.executeScript({ target, files: ["content/bridge.js"] }))
      .catch(() => {});   // pages the browser protects (the Web Store, other extensions)
  }
  pushAll();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#ff3fa4" });
  chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
});
