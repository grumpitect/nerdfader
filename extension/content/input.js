// Runs in the extension's isolated world in every frame: the shortcuts (open the dialog, reset, louder, quieter),
// and modifier + scroll
// (Command by default), which changes the tab's volume and shows the dialog for a moment. While the dialog is up, any
// scroll over it changes the volume too, handled here as well: one place counts every scroll, so a swipe that opens
// the dialog keeps going without a hiccup.
// Settings come from the background ({ shortcut, resetShortcut, upShortcut, downShortcut, altScroll, scrollKeys }) when
// the page loads and whenever they change.
(() => {
  const connected = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const previous = window.__nerdfaderInput;
  if (typeof previous === "function" && previous()) return;
  window.__nerdfaderInput = connected;

  let settings = { shortcut: null, resetShortcut: null, upShortcut: null, downShortcut: null, altScroll: true, scrollKeys: ["shift", "meta"] };
  const ask = (msg) => (connected() ? chrome.runtime.sendMessage(msg) : Promise.reject(new Error("disconnected")));
  ask({ type: "getSettings" }).then((s) => s && !s.error && (settings = s), () => {});
  chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === "settings") settings = msg.settings; });

  const editable = (el) => el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? "");
  const matches = (e, s) =>
    s && e.code === s.code && e.altKey === s.alt && e.ctrlKey === s.ctrl && e.metaKey === s.meta && e.shiftKey === s.shift;

  // Which shortcut a key press is, and what it asks the background to do.
  const actions = [
    ["shortcut", { type: "toggle" }],
    ["resetShortcut", { type: "resetTab" }],
    ["upShortcut", { type: "nudge", steps: 1 }],
    ["downShortcut", { type: "nudge", steps: -1 }],
  ];
  const navigation = /^(Arrow|Home$|End$|Page|Backspace$|Delete$)/;
  function onKey(e) {
    if (!connected()) return shutDown();
    const found = actions.find(([name]) => matches(e, settings[name]));
    if (!found) return;
    const [name, msg] = found;
    const s = settings[name];
    if (e.repeat && msg.type !== "nudge") return;   // holding the louder/quieter keys keeps going; the others act once
    // In text fields, a shortcut without Ctrl, Alt or Cmd would get in the way of typing, and arrows, Home, End and
    // Delete (with Shift and Cmd: select or delete to the start or end) are how people edit, so those are left alone.
    const typing = editable(e.composedPath()[0]);
    if (typing && (navigation.test(s.code) || (!s.alt && !s.ctrl && !s.meta))) return;
    if (e.composedPath().some((n) => n.tagName === "NERDFADER-DIALOG")) return;   // the dialog handles its own keys
    e.preventDefault();
    e.stopImmediatePropagation();
    ask(msg).catch(() => {});
  }

  // A trackpad pinch reaches pages as Control + scroll, so Control only counts while the Control key is really held.
  let controlHeld = false;
  const onModifier = (e) => { if (e.key === "Control") controlHeld = e.type === "keydown"; };
  const keys = ["alt", "ctrl", "shift", "meta"];
  // Exactly the chosen modifiers are held (Command + Shift by default), no more, no fewer.
  function scrollKeyHeld(e) {
    const chosen = settings.scrollKeys?.length ? settings.scrollKeys : ["shift", "meta"];
    if (chosen.includes("ctrl") && !controlHeld) return false;
    return keys.every((k) => e[k + "Key"] === chosen.includes(k));
  }

  // The first scroll of a gesture (after a 250 ms pause) moves one step at once, whatever its size, since a mouse-wheel
  // notch can arrive as anything from a few pixels to over a hundred; after that, one step per 100 px of scrolling.
  // A step is the same as an arrow key in the dialog; scrolling down turns it up.
  //
  // A gesture (scroll events less than 250 ms apart) only changes the volume if the scroll key was already held when
  // it began. After a flick, macOS keeps sending scroll events while the page coasts to a stop, even once it looks
  // still; pressing the key then must not turn that coast into a volume change.
  let carried = 0, lastWheel = -Infinity, lastAnyWheel = -Infinity, gestureOurs = false;
  function onWheel(e) {
    if (!connected()) return shutDown();
    const overDialog = e.composedPath().some((n) => n.tagName === "NERDFADER-DIALOG");
    if (e.timeStamp - lastAnyWheel > 250) gestureOurs = overDialog || (settings.altScroll && scrollKeyHeld(e));
    lastAnyWheel = e.timeStamp;
    if (!overDialog && (!gestureOurs || !settings.altScroll || !scrollKeyHeld(e))) return;
    if (overDialog && e.ctrlKey && !controlHeld) return;   // a pinch over the dialog
    e.preventDefault();
    e.stopImmediatePropagation();
    const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    const delta = e.deltaMode === 1 ? raw * 40 : raw;   // lines to pixels
    if (!delta) return;
    let steps;
    if (e.timeStamp - lastWheel > 250 || Math.sign(delta) !== Math.sign(carried || delta)) {
      steps = Math.sign(delta);
      carried = 0;
    } else {
      carried += delta;
      steps = Math.trunc(carried / 100);
      carried -= steps * 100;
    }
    lastWheel = e.timeStamp;
    if (steps) ask({ type: "nudge", steps }).catch(() => {});
  }

  // Which browser: Arc adds its theme colors (--arc-palette-…) to every page, a moment after it loads. A normal web
  // page that still has none a few seconds in is taken as another Chromium browser.
  if (window === top && /^https?:/.test(location.protocol)) {
    const isArc = () => !!getComputedStyle(document.documentElement).getPropertyValue("--arc-palette-title").trim();
    let tries = 0;
    const look = () => {
      if (!connected()) return;
      if (isArc()) return ask({ type: "browserIs", arc: true }).catch(() => {});
      if (++tries < 6) return setTimeout(look, 500);
      ask({ type: "browserIs", arc: false }).catch(() => {});
    };
    if (document.readyState === "complete") setTimeout(look, 500);
    else addEventListener("load", () => setTimeout(look, 500), { once: true });
  }

  addEventListener("keydown", onKey, true);
  addEventListener("keydown", onModifier, true);
  addEventListener("keyup", onModifier, true);
  addEventListener("blur", () => (controlHeld = false));
  addEventListener("wheel", onWheel, { capture: true, passive: false });
  function shutDown() {
    removeEventListener("keydown", onKey, true);
    removeEventListener("keydown", onModifier, true);
    removeEventListener("keyup", onModifier, true);
    removeEventListener("wheel", onWheel, { capture: true });
  }
})();
