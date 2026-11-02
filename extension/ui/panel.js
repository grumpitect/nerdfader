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

  // The look: a page from a datasheet. Ink on paper with a faint blueprint grid, and a red pen for what's past
  // 100% and what's on. Light or dark with the system.
  const css = `
.nf {
  --paper: #f8f7f2;
  --ink: #15171b;
  --muted: #5f5e58;
  --red: #c21f35;
  --blue: #1f55c9;
  --faint: #c9c7bf;
  --grid: rgba(31, 85, 201, 0.06);
  --hover: rgba(21, 23, 27, 0.06);
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  width: 320px;
  padding: 14px 16px 12px;
  background-color: var(--paper);
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 12px 12px;
  color: var(--ink);
  font: 13px/1.4 var(--mono);
  text-align: left;
  user-select: none;
}
@media (prefers-color-scheme: dark) {
  .nf {
    --paper: #111317;
    --ink: #ebe9e3;
    --muted: #9b9990;
    --red: #ff6f7d;
    --blue: #82aaff;
    --faint: #3a3d44;
    --grid: rgba(130, 170, 255, 0.06);
    --hover: rgba(235, 233, 227, 0.08);
  }
}
.nf * { box-sizing: border-box; }
/* Nothing in the panel takes keyboard focus or shows a focus ring: the panel itself holds focus and handles keys. */
.nf, .nf * { outline: none !important; }
.nf ::-moz-focus-inner { border: 0; }
.nf p { margin: 0; }

.nf header { display: flex; justify-content: space-between; align-items: baseline; padding-bottom: 6px; border-bottom: 1px solid var(--ink); }
.nf .brand { color: var(--ink); font-weight: 700; font-size: 15px; text-decoration: none; }
.nf .version { color: var(--muted); font-size: 11px; text-decoration: none; }
.nf .brand:hover, .nf .version:hover { text-decoration: underline; }

.nf .target {
  margin: 10px 0 8px;
  color: var(--ink);
  font-weight: 700;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nf .target.all { color: var(--red); }

.nf .vol { display: flex; align-items: center; gap: 8px; }
.nf .label { color: var(--muted); }
.nf .percent { width: 4ch; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }

/* The volume as a scale: a baseline with 21 ticks (taller every fifth), an ink line up to the level and on in red
   past 100% (marked "1.0"), and a wedge riding on it. Drawn in whole pixels for the space the bar has (drawScale). */
.nf .bar { position: relative; flex: 1; min-width: 0; height: 32px; }
.nf .scale { position: absolute; top: 0; height: 32px; overflow: visible; }   /* out of the flow: the bar's width decides */
.nf .scale .base, .nf .scale .tick { stroke: var(--ink); stroke-width: 1; }
.nf .scale .level { stroke: var(--ink); stroke-width: 3; }
.nf .scale .over { stroke: var(--red); stroke-width: 3; }
.nf .scale .unity { stroke: var(--blue); stroke-width: 1.5; }
.nf .scale .unityLabel { fill: var(--blue); font: 7px var(--mono); }
.nf .scale .wedge { fill: var(--ink); }
.nf .scale .wedge.past { fill: var(--red); }

/* The real slider sits invisibly on top of the scale: mouse, keyboard and screen readers all use it. */
.nf .slider { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }

.nf .row { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; min-height: 26px; }
.nf .note { color: var(--muted); font-size: 12px; }
.nf .note.capture { color: var(--blue); }

.nf button {
  font: inherit;
  color: var(--ink);
  background: transparent;
  border: 1px solid var(--ink);
  border-radius: 0;
  padding: 2px 10px;
  cursor: pointer;
}
.nf button:hover { background: var(--hover); }
.nf button:disabled { color: var(--faint); border-color: var(--faint); background: transparent; cursor: default; }
.nf button.primary { color: var(--red); border-color: var(--red); }

.nf .rule { margin: 10px 0; border-top: 1px dashed var(--muted); position: relative; }
/* While voice_fix listens, a short sine trace runs along the rule under it, like an oscilloscope. */
.nf .rule.scan::after {
  content: ""; position: absolute; top: -5px; left: 0; width: 44px; height: 9px; background: var(--blue);
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='44' height='9'%3E%3Cpath d='M0 4.5q5.5-7 11 0t11 0 11 0 11 0' fill='none' stroke='black' stroke-width='1.5'/%3E%3C/svg%3E");
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='44' height='9'%3E%3Cpath d='M0 4.5q5.5-7 11 0t11 0 11 0 11 0' fill='none' stroke='black' stroke-width='1.5'/%3E%3C/svg%3E");
  animation: nf-trace 1.4s linear infinite;
}
@keyframes nf-trace { from { left: 0; } to { left: calc(100% - 44px); } }
@media (prefers-reduced-motion: reduce) { .nf .rule.scan::after { animation: none; left: calc(50% - 22px); } }

.nf .toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.nf .voiceRow { margin-top: 8px; }
.nf .toggle input { position: absolute; opacity: 0; pointer-events: none; }
.nf .caret { color: var(--red); visibility: hidden; }
.nf .toggle input:checked ~ .caret { visibility: visible; }
.nf .name { flex: 1; }
/* A switch as a schematic draws it: two terminals and a blade, open (off) or closed (on). */
.nf .switch {
  width: 30px; height: 16px; position: relative;
  background:
    radial-gradient(circle at 4px 11px, var(--ink) 2.4px, transparent 2.9px),
    radial-gradient(circle at 26px 11px, var(--ink) 2.4px, transparent 2.9px);
}
.nf .switch::after {
  content: ""; position: absolute; left: 4px; top: 10.25px; width: 22px; height: 1.5px; background: var(--muted);
  transform-origin: 0 50%; transform: rotate(-26deg); transition: transform 0.12s ease-out, background 0.12s;
}
.nf .toggle input:checked ~ .switch::after { transform: rotate(0); background: var(--blue); }
@media (prefers-reduced-motion: reduce) { .nf .switch::after { transition: none; } }

.nf .hint { color: var(--muted); font-size: 12px; margin: 4px 0 8px 18px; }
.nf .infoBtn {
  font: 700 10px/1 var(--mono); width: 15px; height: 15px; padding: 0; margin-left: 6px; border-radius: 50%;
  vertical-align: 1px; color: var(--muted); border-color: var(--muted);
}
.nf .infoBtn.open, .nf .infoBtn:hover { color: var(--blue); border-color: var(--blue); background: transparent; }
.nf .info { margin: 2px 0 8px 18px; padding: 8px 10px; border-left: 2px solid var(--blue); font-size: 12px; color: var(--ink); }
.nf .info p + p { margin-top: 6px; }
.nf .info p:has(b) + p:has(b) { margin-top: 2px; }   /* the Off and On lines sit together */
.nf .info b { color: var(--blue); font-weight: 700; }
.nf .picks { display: flex; gap: 6px; margin: -2px 0 8px 18px; }
.nf .pick { min-width: 30px; padding: 2px 6px; color: var(--muted); border-color: var(--faint); }
.nf .pick.on { color: var(--red); border-color: var(--red); }
.nf .picks.off { opacity: 0.4; }
.nf .setting { display: flex; align-items: center; gap: 8px; padding-left: 18px; }
.nf .setting .name { flex: 1; }
.nf .keysHead { padding-left: 18px; }
.nf .keyGrid { display: grid; grid-template-columns: auto 1fr auto 1fr; align-items: center; gap: 6px 8px; margin: 6px 0 0 18px; }
.nf .keyName { color: var(--muted); font-size: 12px; }
.nf .shortcutBtn { min-width: 0; padding: 2px 6px; justify-self: stretch; text-align: center; white-space: nowrap; }   /* all four the same width */
/* Modifier symbols (⌘⌥⇧⌃) in the system font: the monospace font has no proper ⇧ and borrows a mismatched one. */
.nf .kbd { font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif; font-weight: 600; letter-spacing: 0.06em; }
.nf .shortcutBtn.recording { color: var(--red); border-color: var(--red); }

.nf .offer { margin-top: 10px; padding: 10px; border: 1px dashed var(--red); font-size: 12px; }
.nf [hidden] { display: none !important; }
.nf .offer .buttons { display: flex; gap: 8px; margin: 8px 0; }
.nf .offer .hint { margin: 0; }

.nf footer { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; }
.nf footer a { color: var(--muted); text-decoration: none; }
.nf footer a:hover { color: var(--blue); }

.nf.unsupported .vol, .nf.unsupported .row, .nf.unsupported .voiceRow { opacity: 0.4; pointer-events: none; }
`;

  const html = `
<header>
  <a class="brand" href="https://github.com/grumpitect/nerdfader" target="_blank" rel="noopener" title="Nerdfader on GitHub">nerdfader</a>
  <a class="version" href="https://github.com/grumpitect/nerdfader/releases" target="_blank" rel="noopener" title="Release notes"></a>
</header>
<div class="target"></div>
<div class="vol">
  <span class="label">vol</span>
  <div class="bar">
    <svg class="scale" aria-hidden="true"></svg>
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
<label class="toggle voiceRow" title="voice fix (v)">
  <input type="checkbox" class="voiceToggle">
  <span class="caret">✓</span>
  <span class="name">voice_fix <button class="infoBtn" data-info="voiceInfo" title="What is voice fix?" aria-label="What is voice fix?">i</button></span>
  <span class="switch" aria-hidden="true"></span>
</label>
<div class="hint voiceHint"></div>
<div class="info voiceInfo" hidden>
  <p>Fixes badly recorded talks: a voice in one ear, an echo from a second mic further back, mains hum, a boomy low
  end. It listens first and fixes only what it finds, so a talk that's fine plays as it is.</p>
  <p><b>Off:</b> the tab plays as sent.</p>
  <p><b>On:</b> for this tab. Turn it off for music: it may lose its stereo.</p>
  <p>When it finds hum or an echo on YouTube, it also turns off Stable Volume in that tab while it's on: that
  setting lifts the quiet moments, and the hum or room noise with them.</p>
  <p>Once on, the page's sound goes through Nerdfader until you reload the page.</p>
</div>
<div class="rule voiceRule"></div>
<label class="toggle">
  <input type="checkbox" class="override">
  <span class="caret">✓</span>
  <span class="name">all_tabs</span>
  <span class="switch" aria-hidden="true"></span>
</label>
<div class="hint overrideHint"></div>
<label class="toggle">
  <input type="checkbox" class="alwaysToggle">
  <span class="caret">✓</span>
  <span class="name">capture_mode <button class="infoBtn" data-info="captureInfo" title="What is capture mode?" aria-label="What is capture mode?">i</button></span>
  <span class="switch" aria-hidden="true"></span>
</label>
<div class="hint captureHint"></div>
<div class="info captureInfo" hidden>
  <p>Some sites won't let Nerdfader turn them up past 100%: Netflix, Spotify and other sites with protected video,
  and players that load their media from another site. They still play, just not louder.</p>
  <p>Capture mode gets around that: Nerdfader records the tab's sound and plays it back louder. While it's on, the
  browser shows the tab as being shared, and it stops by itself when the tab goes quiet.</p>
  <p><b>Off:</b> Nerdfader asks you on such a site.</p>
  <p><b>On:</b> it just does it.</p>
</div>
<div class="rule"></div>
<div class="keysHead"><span class="name">keys</span></div>
<div class="keyGrid">
  <span class="keyName">open</span><button class="shortcutBtn" data-setting="shortcut"></button>
  <span class="keyName">reset</span><button class="shortcutBtn" data-setting="resetShortcut"></button>
  <span class="keyName">louder</span><button class="shortcutBtn" data-setting="upShortcut"></button>
  <span class="keyName">quieter</span><button class="shortcutBtn" data-setting="downShortcut"></button>
</div>
<div class="hint keysHint"></div>
<label class="toggle">
  <input type="checkbox" class="altScrollToggle">
  <span class="caret">✓</span>
  <span class="name">scroll_volume</span>
  <span class="switch" aria-hidden="true"></span>
</label>
<div class="hint altScrollHint"></div>
<div class="picks">
  <button class="pick kbd" data-key="alt"></button><button class="pick kbd" data-key="ctrl"></button><button class="pick kbd" data-key="shift"></button><button class="pick kbd" data-key="meta"></button>
</div>
<div class="rule"></div>
<footer>
  <span class="keys">←/→ · 0 to 9 · r reset</span>
  <a href="https://github.com/grumpitect/nerdfader/issues/new/choose" target="_blank" rel="noopener">feedback ↗</a>
</footer>`;

  // A shortcut as the platform writes it: ⌃⌥⇧⌘V on a Mac, Ctrl+Alt+Shift+V elsewhere. Shift + = shows as +.
  const mac = /Mac/.test(navigator.platform);
  function shortcutLabel(s) {
    if (!s) return "none";
    const names = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", End: "End", Home: "Home", PageUp: "PgUp", PageDown: "PgDn", Space: "Space", Backquote: "`",
      Minus: "−", Equal: s.shift ? "+" : "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
      Comma: ",", Period: ".", Slash: "/", Escape: "Esc", Enter: "Return", Backspace: mac ? "⌫" : "Backspace", Delete: mac ? "⌦" : "Del", Tab: "Tab" };
    const key = names[s.code] ?? s.code.replace(/^Key|^Digit|^Numpad/, "");
    if (mac) return (s.ctrl ? "⌃" : "") + (s.alt ? "⌥" : "") + (s.shift ? "⇧" : "") + (s.meta ? "⌘" : "") + key;
    return [s.ctrl && "Ctrl", s.alt && "Alt", s.shift && "Shift", s.meta && "Meta", key].filter(Boolean).join("+");
  }

  const modifierNames = mac
    ? { alt: "⌥", ctrl: "⌃", shift: "⇧", meta: "⌘" }
    : { alt: "Alt", ctrl: "Ctrl", shift: "Shift", meta: "Win" };
  const modifierWords = mac
    ? { alt: "Option", ctrl: "Control", shift: "Shift", meta: "Command" }
    : { alt: "Alt", ctrl: "Ctrl", shift: "Shift", meta: "Windows" };

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
    $("version").textContent = "NF-1 · rev " + chrome.runtime.getManifest().version;

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
    let recording = null;   // which shortcut is being recorded ("shortcut", "resetShortcut", "upShortcut", ...), if any
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
      drawScale();
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
      $("captureHint").textContent = "if on, allows a volume boost by recording the tab";

      $("voiceToggle").checked = supported && state.voice;
      // What it fixes, as it finds out: "on · listening", then for example "on · both ears, less boom, 60 Hz hum
      // removed" (or "both ears, echo removed, ..."), or "on · nothing to fix" for a talk that is fine as it is.
      const fixes = [];
      if (state.shape?.mono) fixes.push("both ears");
      if (state.shape?.echo) fixes.push("echo removed");
      if (state.shape?.boom) fixes.push("less boom");
      if (state.hum === "50" || state.hum === "60") fixes.push(`${state.hum} Hz hum removed`);
      const done = !!state.shape && !!state.hum;
      $("voiceRule").classList.toggle("scan", supported && state.voice && !done && !state.status);
      $("voiceHint").textContent = !supported || !state.voice ? "for talks: voice in both ears, less hum and boom"
        : state.status === "click" ? "on · click the page to start"
        : state.status && state.status !== "unknown" ? "on · this site can't be fixed"
        : fixes.length ? `on · ${fixes.join(", ")}`
        : done ? "on · nothing to fix"
        : "on · listening";

      const settings = state.settings ?? { shortcut: null, resetShortcut: null, upShortcut: null, downShortcut: null, altScroll: true, scrollKeys: ["shift", "meta"] };
      for (const b of root.querySelectorAll(".shortcutBtn")) {
        const which = b.dataset.setting, value = settings[which];
        b.textContent = recording === which ? "press keys…" : shortcutLabel(value);
        b.title = `${b.previousElementSibling.textContent}: click, then press the keys you want`;
        b.classList.toggle("kbd", recording !== which && !!value);
        b.classList.toggle("recording", recording === which);
      }
      $("keysHint").textContent = recording ? "press the new keys · Esc cancels · Delete removes it" : "work on any page · click one to change it";
      const held = settings.scrollKeys?.length ? settings.scrollKeys : ["shift", "meta"];
      const order = ["ctrl", "alt", "shift", "meta"];   // the order a Mac writes them in
      const words = order.filter((k) => held.includes(k)).map((k) => modifierWords[k]).join(" + ");
      $("altScrollToggle").checked = settings.altScroll;
      $("altScrollHint").textContent = settings.altScroll
        ? `hold ${words} and scroll on any page` + (mac && held.includes("alt") ? " · trackpad only" : "")
        : "off";
      $("picks").classList.toggle("off", !settings.altScroll);
      for (const b of root.querySelectorAll(".pick")) {
        const on = held.includes(b.dataset.key);
        b.textContent = modifierNames[b.dataset.key];
        b.title = on && held.length === 1
          ? "at least one key stays on"
          : `${on ? "don't hold" : "also hold"} ${modifierWords[b.dataset.key]} to change the volume by scrolling`;
        b.classList.toggle("on", on);
      }
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

    for (const b of root.querySelectorAll(".shortcutBtn")) {
      b.addEventListener("click", () => { recording = recording === b.dataset.setting ? null : b.dataset.setting; render(); });
    }
    for (const b of root.querySelectorAll(".infoBtn")) {
      b.addEventListener("click", (e) => {
        e.preventDefault();   // inside the switch's label: open the explanation, don't flip the switch
        e.stopPropagation();
        const info = $(b.dataset.info);
        info.hidden = !info.hidden;
        b.classList.toggle("open", !info.hidden);
      });
    }
    function setVoice(on) {
      if (!supported) return;
      state.voice = on;
      render();
      send("setVoice", { on });
    }
    $("voiceToggle").addEventListener("change", (e) => {
      setVoice(e.target.checked);
      root.focus();
    });
    for (const b of root.querySelectorAll(".pick")) {
      // Each one switches on and off; the last one on stays on.
      b.addEventListener("click", () => {
        const held = state.settings?.scrollKeys?.length ? state.settings.scrollKeys : ["shift", "meta"];
        const next = held.includes(b.dataset.key) ? held.filter((k) => k !== b.dataset.key) : [...held, b.dataset.key];
        if (next.length) saveSettings({ scrollKeys: next, altScroll: true });
      });
    }
    $("altScrollToggle").addEventListener("change", (e) => {
      saveSettings({ altScroll: e.target.checked });
      root.focus();
    });

    // While recording, the next key press with a non-modifier key becomes that shortcut.
    function record(e) {
      e.preventDefault();
      e.stopPropagation();
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      const which = recording;
      recording = null;
      if (e.key === "Escape" && plain) return render();
      if ((e.key === "Backspace" || e.key === "Delete") && plain) return saveSettings({ [which]: null });
      saveSettings({ [which]: { code: e.code, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey } });
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
      // (The two delete keys count as one, as in content/input.js.)
      const sameKey = (a, b) => a === b || (/^(Backspace|Delete)$/.test(a) && /^(Backspace|Delete)$/.test(b));
      const same = (s) => s && sameKey(e.code, s.code) && e.altKey === s.alt && e.ctrlKey === s.ctrl && e.metaKey === s.meta && e.shiftKey === s.shift;
      if (editable() && same(state.settings?.resetShortcut)) {
        e.preventDefault();
        e.nerdfaderMoment = true;   // see ui/overlay.js: like scrolling, not like using the dialog
        if (!e.repeat) setPercent(DEFAULT);
        return;
      }
      for (const [name, steps] of [["upShortcut", 5], ["downShortcut", -5]]) {
        if (editable() && same(state.settings?.[name])) {
          e.preventDefault();   // the same step as on the page; holding the keys keeps going
          e.nerdfaderMoment = true;
          setPercent(toPercent(Math.min(200, Math.max(0, toPos(current()) + steps))));
          return;
        }
      }
      const s = state.settings?.shortcut;
      if (close && same(s)) {
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
      else if (e.key === "v" && supported) { e.preventDefault(); setVoice(!state.voice); return; }
      if (p === null) return;
      e.preventDefault();
      setPercent(p);
    });
    // Scrolling in the toolbar popup (the in-page dialog's scrolling is counted by content/input.js, by the same rule):
    // the first scroll of a gesture moves one step, then one per 100 px; scrolling down turns it up.
    let carried = 0, lastWheel = -Infinity;
    function wheel(e) {
      if (!editable()) return;
      const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const delta = e.deltaMode === 1 ? raw * 40 : raw;
      if (!delta) return;
      e.preventDefault();
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
      if (steps) setPercent(toPercent(Math.min(200, Math.max(0, toPos(current()) + 5 * steps))));
    }
    // Only the popup listens itself; see above.
    if (!close) root.addEventListener("wheel", wheel, { passive: false });

    // The scale, in whole pixels for the space the bar has: 20 equal steps (ten up to 100%, ten from 100 to 600%), so
    // every tick lands on a pixel and the lines stay sharp. Centred, with any spare pixels on either side.
    function drawScale() {
      const bar = $("bar"), svg = $("scale");
      const room = Math.floor(bar.getBoundingClientRect().width);
      const step = Math.floor((room - 10) / 20);
      if (step <= 0) return;
      const x0 = 5.5, width = step * 20 + 11, at = (pos) => x0 + (pos / 10) * step, y = 18.5;
      svg.setAttribute("width", width);
      svg.style.left = `${Math.floor((room - width) / 2)}px`;
      const pos = toPos(current()), unity = at(100), x = at(pos);
      let ticks = "";
      for (let k = 0; k <= 20; k++) {
        const tx = x0 + k * step, major = k % 5 === 0;
        ticks += `<line class="tick" x1="${tx}" x2="${tx}" y1="${major ? 12 : 15}" y2="${major ? 25 : 22}"/>`;
      }
      svg.innerHTML = `<line class="base" x1="${x0}" x2="${at(200)}" y1="${y}" y2="${y}"/>${ticks}` +
        `<line class="level" x1="${x0}" x2="${Math.min(x, unity)}" y1="${y}" y2="${y}"/>` +
        (pos > 100 ? `<line class="over" x1="${unity}" x2="${x}" y1="${y}" y2="${y}"/>` : "") +
        `<line class="unity" x1="${unity}" x2="${unity}" y1="10" y2="27"/>` +
        `<text class="unityLabel" x="${unity}" y="32" text-anchor="middle">1.0</text>` +
        `<polygon class="wedge${pos > 100 ? " past" : ""}" points="${x - 5},4 ${x + 5},4 ${x},12"/>`;
    }
    new ResizeObserver(drawScale).observe(root);

    render();
    root.focus();
    // Called when something else changed the volume (scrolling on the page): show it at once.
    async function refresh() {
      const reply = await call("state");
      if (valid(reply) && !busy) { state = reply; render(); }
    }
    return { destroy: () => clearInterval(poll), wheel, refresh };
  }

  return { css, mount };
})();
