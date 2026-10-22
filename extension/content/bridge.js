// Runs in the extension's isolated world in every frame. Asks the background for this tab's level, passes it to
// main.js (the page's world), forwards every later change, and reports back when main.js can't boost this frame.
(() => {
  // After an extension update or reload, the old copy of this script stays in open tabs, cut off from the extension
  // (its chrome.runtime.id is gone, and calling into it throws). The new copy runs next to it; a cut-off copy shuts
  // itself down the first time it notices, and only a still-connected copy makes a new one step aside.
  const connected = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const previous = window.__nerdfaderBridge;
  if (typeof previous === "function" && previous()) return;
  window.__nerdfaderBridge = connected;

  let level = null;
  const send = () => level !== null && window.dispatchEvent(new CustomEvent("nerdfader2:level", { detail: level }));
  const onStatus = (e) => {
    if (!connected()) return shutDown();
    chrome.runtime.sendMessage({ type: "status", status: String(e.detail ?? "") }).catch(() => {});
  };
  function shutDown() {
    window.removeEventListener("nerdfader2:ready", send);
    window.removeEventListener("nerdfader2:status", onStatus);
  }

  // main.js may start after this script (e.g. when both are injected into an open tab), so resend when it is ready.
  window.addEventListener("nerdfader2:ready", send);
  window.addEventListener("nerdfader2:status", onStatus);
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "level") { level = msg.gain; send(); }
  });
  chrome.runtime.sendMessage({ type: "hello" }).then((reply) => {
    if (reply && level === null) { level = reply.gain; send(); }
  }, () => {});
})();
