// The Nerdfader panel: the slider, reset, switches and capture-mode offer. Shown in a dialog centered on the page
// (ui/overlay.js), or in the toolbar popup on pages extensions can't reach (popup/popup.html). Defines
// NerdfaderPanel.mount(root, { tabId, url, close }); tabId can be left out inside a page, where the background
// knows which tab is asking.
globalThis.NerdfaderPanel = (() => {
  const DEFAULT = 100;
  const MAX = 600;
  // The slider's first half is 0 to 100% in steps of 1, its second half 100 to 600% in steps of 5.
  const toPercent = (pos) => (pos <= 100 ? pos : 100 + (pos - 100) * 5);
  const toPos = (p) => (p <= 100 ? p : 100 + (p - 100) / 5);

  const css = `
.nf {
  --bg: #170c2c;
  --edge: #3a2366;
  --text: #e9e3ff;
  --muted: #8f84b0;
  --pink: #ff4fa8;
  --cyan: #5ee6ff;
  --amber: #ffc857;
  --off: #3b2c5c;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  width: 320px;
  padding: 14px 16px 12px;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.4 var(--mono);
  text-align: left;
  user-select: none;
}
.nf * { box-sizing: border-box; }
/* Nothing in the panel takes keyboard focus or shows a focus ring: the panel itself holds focus and handles keys. */
.nf, .nf * { outline: none !important; }
.nf ::-moz-focus-inner { border: 0; }
.nf p { margin: 0; }

.nf header { display: flex; justify-content: space-between; align-items: baseline; }
.nf .brand { color: var(--pink); font-weight: 700; font-size: 15px; }
.nf .version { color: var(--muted); }

.nf .target {
  margin: 10px 0 8px;
  color: var(--cyan);
  font-weight: 700;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nf .target.all { color: var(--pink); }

.nf .vol { display: flex; align-items: center; gap: 8px; }
.nf .label { color: var(--muted); }
.nf .percent { width: 4ch; text-align: right; font-weight: 700; }

.nf .bar { position: relative; flex: 1; display: flex; align-items: center; gap: 4px; color: var(--muted); }
.nf .segments { flex: 1; display: grid; grid-template-columns: repeat(20, 1fr); gap: 2px; height: 16px; }
.nf .segments i { border-radius: 2px; background: var(--off); }
.nf .segments i.on { background: var(--amber); }
.nf .segments i.boost.on { background: var(--pink); }
.nf .segments i:nth-child(10) { margin-right: 3px; }   /* a small gap marks 100% */

/* The real slider sits invisibly on top of the segments: mouse, keyboard and screen readers all use it. */
.nf .slider { position: absolute; inset: -6px 0; width: 100%; height: calc(100% + 12px); margin: 0; opacity: 0; cursor: pointer; }

.nf .row { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; min-height: 26px; }
.nf .note { color: var(--muted); font-size: 12px; }
.nf .note.capture { color: var(--cyan); }

.nf button {
  font: inherit;
  color: var(--cyan);
  background: transparent;
  border: 1px solid var(--cyan);
  border-radius: 6px;
  padding: 2px 10px;
  cursor: pointer;
}
.nf button:hover { background: rgba(94, 230, 255, 0.12); }
.nf button:disabled { color: var(--off); border-color: var(--off); background: transparent; cursor: default; }
.nf button.primary { color: var(--pink); border-color: var(--pink); }
.nf button.primary:hover { background: rgba(255, 79, 168, 0.12); }

.nf .rule { margin: 10px 0; border-top: 1px dashed var(--edge); }

.nf .toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.nf .toggle input { position: absolute; opacity: 0; pointer-events: none; }
.nf .caret { color: var(--pink); visibility: hidden; }
.nf .toggle input:checked ~ .caret { visibility: visible; }
.nf .toggle input:checked ~ .name { color: var(--pink); }
.nf .name { flex: 1; }
.nf .switch { width: 30px; height: 16px; border-radius: 8px; background: var(--off); position: relative; transition: background 0.15s; }
.nf .switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--text); transition: transform 0.15s;
}
.nf .toggle input:checked ~ .switch { background: var(--pink); }
.nf .toggle input:checked ~ .switch::after { transform: translateX(14px); }

.nf .hint { color: var(--muted); font-size: 12px; margin: 4px 0 8px 18px; }
.nf .hint a { color: var(--cyan); cursor: pointer; text-decoration: none; }
.nf .hint a:hover { text-decoration: underline; }
.nf .setting { display: flex; align-items: center; gap: 8px; padding-left: 18px; }
.nf .setting .name { flex: 1; }
.nf .shortcutBtn { min-width: 64px; }
.nf .shortcutBtn.recording { color: var(--pink); border-color: var(--pink); }

.nf .offer { margin-top: 10px; padding: 10px; border: 1px dashed var(--pink); border-radius: 8px; font-size: 12px; }
.nf [hidden] { display: none !important; }
.nf .offer .buttons { display: flex; gap: 8px; margin: 8px 0; }
.nf .offer .hint { margin: 0; }

.nf footer { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; }
.nf footer a { color: var(--muted); text-decoration: none; }
.nf footer a:hover { color: var(--cyan); }

.nf.unsupported .vol, .nf.unsupported .row { opacity: 0.4; pointer-events: none; }
`;

  const html = `
<header>
  <span class="brand">nerdfader</span>
  <span class="version"></span>
</header>
<div class="target"></div>
<div class="vol">
  <span class="label">vol</span>
  <div class="bar">
    <span class="bracket">[</span>
    <div class="segments">${Array.from({ length: 20 }, (_, i) => `<i class="${i >= 10 ? "boost" : ""}"></i>`).join("")}</div>
    <span class="bracket">]</span>
    <input type="range" class="slider" min="0" max="200" step="1" aria-label="Volume">
  </div>
  <span class="percent"></span>
</div>
<div class="row">
  <span class="note"></span>
  <button class="reset" title="Back to 100% (r)">reset</button>
</div>
<div class="offer" hidden>
  <p class="offerText"></p>
  <div class="buttons">
    <button class="captureOnce primary" title="c">use capture mode</button>
    <button class="captureAlways">always</button>
  </div>
  <p class="hint">The tab shows as shared while it's boosted. Capture stops when the tab goes quiet.</p>
</div>
<div class="rule"></div>
<label class="toggle">
  <input type="checkbox" class="override">
  <span class="caret">&gt;</span>
  <span class="name">all_tabs</span>
  <span class="switch" aria-hidden="true"></span>
</label>
<div class="hint overrideHint"></div>
<label class="toggle">
  <input type="checkbox" class="alwaysToggle">
  <span class="caret">&gt;</span>
  <span class="name">capture_mode</span>
  <span class="switch" aria-hidden="true"></span>
</label>
<div class="hint captureHint"></div>
<div class="rule"></div>
<div class="setting">
  <span class="name">shortcut</span>
  <button class="shortcutBtn" title="Click, then press the keys you want (Esc cancels, Delete removes it)"></button>
</div>
<div class="hint shortcutHint"></div>
<label class="toggle">
  <input type="checkbox" class="altScrollToggle">
  <span class="caret">&gt;</span>
  <span class="name">option_scroll</span>
  <span class="switch" aria-hidden="true"></span>
</label>
<div class="hint altScrollHint"></div>
<div class="rule"></div>
<footer>
  <span class="keys">←/→ · 0 to 9 · r reset</span>
  <a href="https://github.com/grumpitect/nerdfader/issues/new/choose" target="_blank" rel="noopener">feedback ↗</a>
</footer>`;

  // A shortcut as the platform writes it: ⌃⌥⇧⌘V on a Mac, Ctrl+Alt+Shift+V elsewhere.
  const mac = /Mac/.test(navigator.platform);
  function shortcutLabel(s) {
    if (!s) return "none";
    const names = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Space: "Space", Backquote: "`",
      Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
      Comma: ",", Period: ".", Slash: "/", Escape: "Esc", Enter: "Return", Backspace: "Delete", Tab: "Tab" };
    const key = names[s.code] ?? s.code.replace(/^Key|^Digit|^Numpad/, "");
    if (mac) return (s.ctrl ? "⌃" : "") + (s.alt ? "⌥" : "") + (s.shift ? "⇧" : "") + (s.meta ? "⌘" : "") + key;
    return [s.ctrl && "Ctrl", s.alt && "Alt", s.shift && "Shift", s.meta && "Meta", key].filter(Boolean).join("+");
  }

  const reasons = {
    protected: "it plays protected (DRM) media",
    "cross-origin": "its media comes from another site",
    stream: "it plays a live stream",
    click: "you haven't clicked the page yet",
  };

  async function mount(root, { tabId, url, close } = {}) {
    // Pages the browser keeps extensions out of (arc://, chrome://, the Web Store) report no http(s)/file URL.
    const supported = /^(https?|file):/.test(url ?? "");
    const host = supported ? new URL(url).hostname.replace(/^www\./, "") || "this file" : "";
    const $ = (cls) => root.querySelector("." + cls);
    // After the extension reloads (an update), a panel that is still open is cut off from it, and calling into it
    // throws. Every call checks first; a cut-off dialog closes itself, a cut-off popup says to reopen it.
    let poll = 0, cutOff = false;
    const connected = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
    function disconnected() {
      if (cutOff) return;
      cutOff = true;
      clearInterval(poll);
      if (close) return close();
      $("target").textContent = "Nerdfader was just updated";
      $("note").textContent = "close this and open it again";
      for (const el of root.querySelectorAll(".vol, .row button, .offer, .rule, .toggle, .hint, .setting")) el.hidden = true;
    }
    const call = (type, extra = {}) => {
      if (!connected()) { disconnected(); return Promise.resolve(null); }
      try {
        return chrome.runtime.sendMessage({ type, tabId, ...extra }).catch(() => (connected() ? null : (disconnected(), null)));
      } catch {
        disconnected();
        return Promise.resolve(null);
      }
    };

    root.classList.add("nf");
    root.innerHTML = html;
    root.tabIndex = -1;
    for (const el of root.querySelectorAll("button, input, a")) el.tabIndex = -1;
    // Clicking a button or switch leaves focus on the panel (so no control ever looks focused); the slider still
    // gets the press, so dragging works.
    root.addEventListener("mousedown", (e) => {
      if (e.target !== root && !e.target.classList?.contains("slider")) e.preventDefault();
    });
    if (close) $("keys").textContent += " · esc close";
    $("version").textContent = "v" + chrome.runtime.getManifest().version;

    // A quick read first so the panel shows the right values straight away. In the toolbar popup, opening it is
    // also what lets the browser capture this tab, so a paused capture mode starts again (the dialog's icon click
    // already did that in the background).
    const valid = (reply) => reply && !reply.error && reply.override;
    let state = await call("state");
    if (!valid(state)) {   // the background may be restarting, for example right after an update
      await new Promise((r) => setTimeout(r, 300));
      state = await call("state");
    }
    if (!valid(state)) {
      $("target").textContent = "Nerdfader was just updated";
      $("note").textContent = "reload this page, then try again";
      for (const el of root.querySelectorAll(".vol, .row button, .rule, .toggle, .hint")) el.hidden = true;
      return { destroy() {} };
    }
    if (!close) call("opened").then((reply) => { if (valid(reply) && !busy) { state = reply; render(); } });

    // One request in flight at a time; while dragging, only the latest value is sent next.
    let pending = null, busy = false, changedAt = 0;
    async function send(type, extra) {
      pending = { type, extra };
      changedAt = Date.now();
      if (busy) return;
      busy = true;
      while (pending) {
        const next = pending; pending = null;
        const reply = await call(next.type, next.extra);
        if (!pending && valid(reply)) { state = reply; render(); }
      }
      busy = false;
    }

    // Pages report what they can boost, and capture mode starts and stops, while the panel is open.
    poll = setInterval(async () => {
      if (busy || Date.now() - changedAt < 800) return;
      const reply = await call("state");
      if (valid(reply) && !busy && Date.now() - changedAt >= 800) { state = reply; render(); }
    }, 500);

    const current = () => (state.override.on ? state.override.percent : state.tab);
    let recording = false;
    function saveSettings(change) {
      state.settings = { ...state.settings, ...change };
      render();
      send("setSettings", change);
    }

    function setPercent(p) {
      p = Math.round(Math.min(MAX, Math.max(0, p)));
      if (state.override.on) state.override.percent = p; else state.tab = p;
      render();
      send(state.override.on ? "setOverride" : "setTab", { percent: p });
    }

    function render() {
      const all = state.override.on;
      const p = current();
      const boosting = p > DEFAULT;
      root.classList.toggle("all", all);
      root.classList.toggle("unsupported", !all && !supported);

      const target = $("target");
      target.classList.toggle("all", all);
      target.textContent = all ? "all tabs" : supported ? host : "can't change this page";

      $("slider").value = toPos(p);
      $("slider").setAttribute("aria-valuetext", `${p}%`);
      $("percent").textContent = `${p}%`;
      [...$("segments").children].forEach((seg, i) => seg.classList.toggle("on", toPos(p) > i * 10));
      $("reset").disabled = p === DEFAULT;

      // What this tab is doing right now.
      const capture = state.capture;
      let note = "";
      if (supported && boosting && capture === "on") note = "capture mode: boosting";
      else if (supported && boosting && capture === "idle") note = "capture mode: waiting for sound";
      else if (supported && boosting && capture === "paused") note = "capture mode: click the Nerdfader icon to resume";
      else if (all) note = supported ? `this tab keeps ${state.tab}%` : "";
      else if (supported) note = p === DEFAULT ? "this tab, default" : boosting && !state.status ? "this tab, boosted" : "this tab only";
      $("note").textContent = note;
      $("note").classList.toggle("capture", note.startsWith("capture"));

      // A site that can't be boosted directly: offer capture mode.
      const offer = supported && boosting && state.status && !state.allowed;
      $("offer").hidden = !offer;
      if (offer) {
        $("offerText").textContent = `${host} can't go past 100% on its own: ${reasons[state.status] ?? "the browser blocks it"}.` +
          (state.status === "click" ? " Click anywhere in the page, or:" : "");
      }

      $("override").checked = all;
      $("overrideHint").textContent = all ? "every tab plays at this volume" : "set every tab at once";
      $("alwaysToggle").checked = state.captureAlways;
      $("captureHint").textContent = state.captureAlways
        ? "used on sites that block boosting"
        : "asks first on sites that block boosting";

      const settings = state.settings ?? { shortcut: null, altScroll: true };
      $("shortcutBtn").textContent = recording ? "press keys…" : shortcutLabel(settings.shortcut);
      $("shortcutBtn").classList.toggle("recording", recording);
      $("shortcutHint").innerHTML = "";
      $("shortcutHint").append(
        recording ? "Esc cancels, Delete removes it" : "opens this on any page",
        ...(state.browserShortcut !== undefined
          ? [` · browser: ${state.browserShortcut || "none"} `, Object.assign(document.createElement("a"), { textContent: "change", className: "changeBrowser", tabIndex: -1 })]
          : []),
      );
      $("altScrollToggle").checked = settings.altScroll;
      $("altScrollHint").textContent = settings.altScroll
        ? `${mac ? "⌥" : "Alt"} + scroll on any page changes the volume and shows this for a moment`
        : `${mac ? "⌥" : "Alt"} + scroll does nothing special`;
    }

    $("slider").addEventListener("input", (e) => setPercent(toPercent(Number(e.target.value))));
    $("reset").addEventListener("click", () => setPercent(DEFAULT));
    $("override").addEventListener("change", (e) => {
      state.override.on = e.target.checked;
      render();
      send("setOverride", { on: e.target.checked });
      root.focus();
    });
    $("captureOnce").addEventListener("click", () => {
      state.allowed = true;
      render();
      send("setCapture", { once: true });
    });
    $("captureAlways").addEventListener("click", () => {
      state.allowed = state.captureAlways = true;
      render();
      send("setCapture", { always: true });
    });
    $("alwaysToggle").addEventListener("change", (e) => {
      state.captureAlways = e.target.checked;
      render();
      send("setCapture", { always: e.target.checked });
      root.focus();
    });

    $("shortcutBtn").addEventListener("click", () => { recording = !recording; render(); });
    $("shortcutHint").addEventListener("click", (e) => {
      if (e.target.classList.contains("changeBrowser")) call("openShortcuts");
    });
    $("altScrollToggle").addEventListener("change", (e) => {
      saveSettings({ altScroll: e.target.checked });
      root.focus();
    });

    // While recording, the next key press with a non-modifier key becomes the shortcut.
    function record(e) {
      e.preventDefault();
      e.stopPropagation();
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      recording = false;
      if (e.key === "Escape" && plain) return render();
      if ((e.key === "Backspace" || e.key === "Delete") && plain) return saveSettings({ shortcut: null });
      saveSettings({ shortcut: { code: e.code, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey } });
      root.focus();
    }

    const editable = () => state.override.on || supported;
    root.addEventListener("keydown", (e) => {
      if (recording) return record(e);
      if (e.key === "Tab") { e.preventDefault(); return; }   // nothing to move to, and focus stays in the panel
      if (e.key === "c" && !$("offer").hidden && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        $("captureOnce").click();   // "use capture mode" from the keyboard
        return;
      }
      if (e.key === "Escape" && close) { e.preventDefault(); close(); return; }
      const s = state.settings?.shortcut;
      if (close && s && e.code === s.code && e.altKey === s.alt && e.ctrlKey === s.ctrl && e.metaKey === s.meta && e.shiftKey === s.shift) {
        // The shortcut that opened the dialog closes it too, but only a new press: while the keys are still held
        // from opening it, the system repeats them, and those repeats arrive here once the dialog has focus.
        e.preventDefault();
        if (!e.repeat) close();
        return;
      }
      if (!editable() || e.metaKey || e.ctrlKey || e.altKey) return;
      const step = e.shiftKey ? 1 : 5;   // in slider positions: 5% below 100%, 25% above
      let p = null;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") p = toPercent(Math.min(200, toPos(current()) + step));
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") p = toPercent(Math.max(0, toPos(current()) - step));
      else if (e.key === "PageUp" || e.key === "End") p = MAX;
      else if (e.key === "PageDown" || e.key === "Home") p = 0;
      else if (/^[0-9]$/.test(e.key)) p = Number(e.key) * 10;
      else if (e.key === "r") p = DEFAULT;
      if (p === null) return;
      e.preventDefault();
      setPercent(p);
    });
    // Scrolling: one step (as an arrow key) per 100 px, and at least one per scroll after a 200 ms pause, so a mouse
    // notch of any size counts and a trackpad swipe doesn't fly past (the same rule as Option + scroll on pages).
    let carried = 0, lastStep = -Infinity;
    function wheel(e) {
      if (!editable()) return;
      const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const delta = e.deltaMode === 1 ? raw * 40 : raw;
      if (!delta) return;
      e.preventDefault();
      if (Math.sign(delta) !== Math.sign(carried)) carried = 0;
      carried += delta;
      let steps = Math.trunc(carried / 100);
      if (steps) carried -= steps * 100;
      else if (e.timeStamp - lastStep > 200) { steps = Math.sign(delta); carried = 0; }
      if (!steps) return;
      lastStep = e.timeStamp;
      setPercent(toPercent(Math.min(200, Math.max(0, toPos(current()) - 5 * steps))));
    }
    // In the in-page dialog the backdrop passes every scroll on (see ui/overlay.js); the popup listens itself.
    if (!close) root.addEventListener("wheel", wheel, { passive: false });

    render();
    root.focus();
    return { destroy: () => clearInterval(poll), wheel };
  }

  return { css, mount };
})();
