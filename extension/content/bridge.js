// Runs in the extension's isolated world in every frame. Asks the background for this tab's level and voice fix,
// passes them to main.js (the page's world), forwards every later change, and reports back when main.js can't boost
// this frame, and what hum voice fix found.
(() => {
  // After an extension update or reload, the old copy of this script stays in open tabs, cut off from the extension
  // (its chrome.runtime.id is gone, and calling into it throws). The new copy runs next to it; a cut-off copy shuts
  // itself down the first time it notices, and only a still-connected copy makes a new one step aside.
  const connected = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const previous = window.__nerdfaderBridge;
  if (typeof previous === "function" && previous()) return;
  window.__nerdfaderBridge = connected;

  let level = null, voice = false, stableTheirs = false;
  const send = () => {
    if (level === null) return;
    window.dispatchEvent(new CustomEvent("nerdfader3:level", { detail: level }));
    window.dispatchEvent(new CustomEvent("nerdfader3:stable", { detail: stableTheirs ? 1 : 0 }));   // before voice fix
    window.dispatchEvent(new CustomEvent("nerdfader3:voice", { detail: voice ? 1 : 0 }));
  };
  const take = (msg) => { level = msg.gain; voice = !!msg.voice; stableTheirs = !!msg.stableTheirs; send(); };
  const onStatus = (e) => {
    if (!connected()) return shutDown();
    chrome.runtime.sendMessage({ type: "status", status: String(e.detail ?? "") }).catch(() => {});
  };
  const onHum = (e) => {
    if (!connected()) return shutDown();
    chrome.runtime.sendMessage({ type: "hum", hum: String(e.detail ?? "") }).catch(() => {});
  };
  const onStableTheirs = () => {
    if (!connected()) return shutDown();
    chrome.runtime.sendMessage({ type: "stableTheirs" }).catch(() => {});
  };
  function shutDown() {
    window.removeEventListener("nerdfader3:ready", send);
    window.removeEventListener("nerdfader3:status", onStatus);
    window.removeEventListener("nerdfader3:hum", onHum);
    window.removeEventListener("nerdfader3:stableTheirs", onStableTheirs);
  }

  // main.js may start after this script (e.g. when both are injected into an open tab), so resend when it is ready.
  window.addEventListener("nerdfader3:ready", send);
  window.addEventListener("nerdfader3:status", onStatus);
  window.addEventListener("nerdfader3:hum", onHum);
  window.addEventListener("nerdfader3:stableTheirs", onStableTheirs);
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "level") take(msg);
  });
  chrome.runtime.sendMessage({ type: "hello" }).then((reply) => {
    if (reply && level === null) take(reply);
  }, () => {});
})();
