// Runs in the extension's isolated world in every frame. Asks the background for this tab's level, passes it to
// main.js (the page's world), forwards every later change, and reports back when main.js can't boost this frame.
(() => {
  // After an extension update, the old copy of this script stays in open tabs, cut off from the extension (its
  // chrome.runtime.id is gone). Only step aside for a copy that is still connected.
  const alive = window.__nerdfaderBridge;
  if (typeof alive === "function" && alive()) return;
  window.__nerdfaderBridge = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  let level = null;
  const send = () => level !== null && window.dispatchEvent(new CustomEvent("nerdfader2:level", { detail: level }));

  // main.js may start after this script (e.g. when both are injected into an open tab), so resend when it is ready.
  window.addEventListener("nerdfader2:ready", send);
  window.addEventListener("nerdfader2:status", (e) => {
    chrome.runtime.sendMessage({ type: "status", status: String(e.detail ?? "") }).catch(() => {});
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "level") { level = msg.gain; send(); }
  });
  chrome.runtime.sendMessage({ type: "hello" }).then((reply) => {
    if (reply && level === null) { level = reply.gain; send(); }
  }, () => {});
})();
