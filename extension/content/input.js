// Runs in the extension's isolated world in every frame: the shortcut that opens the dialog, and Option/Alt + scroll,
// which changes the tab's volume and shows the dialog for a moment (the background opens it; once it is up, the
// dialog takes the scrolling itself).
// Settings come from the background ({ shortcut, altScroll }) when the page loads and whenever they change.
(() => {
  const connected = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const previous = window.__nerdfaderInput;
  if (typeof previous === "function" && previous()) return;
  window.__nerdfaderInput = connected;

  let settings = { shortcut: null, altScroll: true };
  const ask = (msg) => (connected() ? chrome.runtime.sendMessage(msg) : Promise.reject(new Error("disconnected")));
  ask({ type: "getSettings" }).then((s) => s && !s.error && (settings = s), () => {});
  chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === "settings") settings = msg.settings; });

  const editable = (el) => el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? "");
  const matches = (e, s) =>
    s && e.code === s.code && e.altKey === s.alt && e.ctrlKey === s.ctrl && e.metaKey === s.meta && e.shiftKey === s.shift;

  function onKey(e) {
    if (!connected()) return shutDown();
    const s = settings.shortcut;
    if (!matches(e, s) || e.repeat) return;
    // A shortcut without Ctrl, Alt or Cmd would get in the way of typing, so it doesn't fire in text fields.
    if (!s.alt && !s.ctrl && !s.meta && editable(e.composedPath()[0])) return;
    if (e.composedPath().some((n) => n.tagName === "NERDFADER-DIALOG")) return;   // the dialog handles its own keys
    e.preventDefault();
    e.stopImmediatePropagation();
    ask({ type: "toggle" }).catch(() => {});
  }

  // Option/Alt + scroll. Scrolling adds up, one step per 100 px (a two-finger swipe, a fast wheel spin); and when that
  // adds up to nothing yet, a scroll still moves one step if the last step was over 200 ms ago, because a mouse-wheel
  // notch can arrive as anything from a few pixels to over a hundred. A step is the same as an arrow key in the dialog.
  let carried = 0, lastStep = -Infinity;
  function onWheel(e) {
    if (!connected()) return shutDown();
    if (!e.altKey || !settings.altScroll || e.ctrlKey || e.metaKey) return;
    if (e.composedPath().some((n) => n.tagName === "NERDFADER-DIALOG")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    const delta = e.deltaMode === 1 ? raw * 40 : raw;   // lines to pixels
    if (!delta) return;
    if (Math.sign(delta) !== Math.sign(carried)) carried = 0;   // changed direction
    carried += delta;
    let steps = Math.trunc(carried / 100);
    if (steps) carried -= steps * 100;
    else if (e.timeStamp - lastStep > 200) { steps = Math.sign(delta); carried = 0; }
    if (!steps) return;
    lastStep = e.timeStamp;
    ask({ type: "nudge", steps: -steps }).catch(() => {});
  }

  addEventListener("keydown", onKey, true);
  addEventListener("wheel", onWheel, { capture: true, passive: false });
  function shutDown() {
    removeEventListener("keydown", onKey, true);
    removeEventListener("wheel", onWheel, { capture: true });
  }
})();
