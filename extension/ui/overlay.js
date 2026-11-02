// The in-page dialog. Injected into the tab's top frame (after ui/panel.js) each time Nerdfader's toolbar icon or
// shortcut is used: opens the panel centered over a blurred backdrop, or closes it if it is already open. Clicking the
// backdrop or pressing Esc closes it too. It lives in a closed shadow root, so the page's styles can't reach it.
//
// Modifier + scroll, the louder/quieter keys and the reset key open it "for a moment" instead (the background sets
// globalThis.__nerdfaderOpen first): it goes away a second after the last change, unless the user clicks or types in it, which keeps it until they click away
// or press Esc. While it is up, scrolling anywhere over it changes the volume (counted by content/input.js).
(() => {
  const TAG = "nerdfader-dialog";
  const request = globalThis.__nerdfaderOpen ?? {};
  delete globalThis.__nerdfaderOpen;
  const open = document.querySelector(TAG);
  if (open) { open.dispatchEvent(new Event(request.moment ? "nerdfader-poke" : "nerdfader-close")); return; }

  const css = `
.backdrop {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(20, 22, 27, 0.28);
  -webkit-backdrop-filter: blur(6px) saturate(0.85);
  backdrop-filter: blur(6px) saturate(0.85);
  animation: fade 100ms ease-out;
}
/* A sheet of the datasheet laid on the page: a thin ink edge, square corners, a soft shadow; it settles into place. */
.dialog {
  border: 1px solid #15171b;
  border-radius: 2px;
  overflow: hidden;
  box-shadow: 0 18px 50px rgba(20, 22, 27, 0.22);
  animation: settle 100ms ease-out;
}
@media (prefers-color-scheme: dark) {
  .backdrop { background: rgba(0, 0, 0, 0.35); }
  .dialog { border-color: #ebe9e3; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5); }
}
/* channel_strip: a strip of warm metal; it slides 4 px into place, like a fader settling. */
.dialog.cs { border-color: #cfc4b1; border-radius: 6px; box-shadow: 0 24px 60px rgba(40, 30, 15, 0.25); animation: settle-cs 120ms ease-out; }
@media (prefers-color-scheme: dark) {
  .dialog.cs { border-color: #3a3026; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); }
}
.closing .backdrop { animation: fade 90ms ease-in reverse forwards; }
.closing .dialog { animation: settle 90ms ease-in reverse forwards; }
.closing .dialog.cs { animation: settle-cs 90ms ease-in reverse forwards; }
@keyframes fade { from { opacity: 0; } }
@keyframes settle { from { opacity: 0; transform: translateY(1px); } }
@keyframes settle-cs { from { opacity: 0; transform: translateY(4px); } }
@media (prefers-reduced-motion: reduce) {
  .backdrop, .dialog, .dialog.cs, .closing .backdrop, .closing .dialog, .closing .dialog.cs { animation: none; }
}
`;

  const host = document.createElement(TAG);
  for (const [k, v] of Object.entries({ all: "initial", position: "fixed", inset: "0", "z-index": "2147483647", display: "block" })) {
    host.style.setProperty(k, v, "important");
  }
  const shadow = host.attachShadow({ mode: "closed" });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(NerdfaderPanel.css + css);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement("style");
    style.textContent = NerdfaderPanel.css + css;
    shadow.append(style);
  }
  const wrap = document.createElement("div");
  wrap.innerHTML = `<div class="backdrop"><div class="dialog" role="dialog" aria-modal="true" aria-label="Nerdfader volume"></div></div>`;
  wrap.hidden = true;
  shadow.append(wrap);
  const backdrop = wrap.querySelector(".backdrop");
  const dialog = wrap.querySelector(".dialog");

  // Shown above a fullscreen video too.
  const parent = () => document.fullscreenElement ?? document.documentElement;
  parent().append(host);
  const refit = () => host.parentNode !== parent() && parent().append(host);
  document.addEventListener("fullscreenchange", refit);

  // No rubber-band bounce of the page while the dialog is up: a hard swipe at the top or bottom of a page would bounce
  // it, and the bounce takes the rest of the gesture away from the dialog. Put back as it was on close.
  const roots = [document.documentElement, document.body].filter(Boolean);
  const overscroll = roots.map((el) => [el.style.getPropertyValue("overscroll-behavior"), el.style.getPropertyPriority("overscroll-behavior")]);
  for (const el of roots) el.style.setProperty("overscroll-behavior", "none", "important");

  // Keys typed in the dialog stay in the dialog (so a video player doesn't also seek or change its own volume).
  const swallow = (e) => { if (e.composedPath().includes(host)) e.stopPropagation(); };
  for (const type of ["keydown", "keyup", "keypress", "wheel"]) host.addEventListener(type, swallow);

  const previousFocus = document.activeElement;
  let panel = null, closed = false;
  function close() {
    if (closed) return;
    closed = true;
    panel?.destroy();
    document.removeEventListener("fullscreenchange", refit);
    removeEventListener("pagehide", close);
    roots.forEach((el, i) => {
      if (overscroll[i][0]) el.style.setProperty("overscroll-behavior", ...overscroll[i]);
      else el.style.removeProperty("overscroll-behavior");
    });
    wrap.classList.add("closing");
    const done = () => { host.remove(); previousFocus?.focus?.({ preventScroll: true }); };
    matchMedia("(prefers-reduced-motion: reduce)").matches ? done() : setTimeout(done, 90);
  }
  host.addEventListener("nerdfader-close", close);
  addEventListener("pagehide", close);
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(); });

  // Shown for a moment: hide 1 s after the last change, unless the user starts using it.
  let staying = !request.moment, hideTimer = 0;
  const poke = () => {
    if (staying || closed) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(close, 1000);
  };
  const stay = () => { staying = true; clearTimeout(hideTimer); };
  // A poke comes with each volume step from scrolling: show the new value at once, and keep a "moment" dialog up.
  host.addEventListener("nerdfader-poke", () => { panel?.refresh(); poke(); });
  dialog.addEventListener("pointerdown", stay);
  // Keys the panel handled as louder / quieter / reset are like scrolling: they keep the moment going, they don't
  // keep the dialog up for good. (Listening on the backdrop, so the panel has seen the key first.)
  backdrop.addEventListener("keydown", (e) => {
    if (e.nerdfaderMoment) poke();
    else if (!["Escape", "Shift", "Meta", "Alt", "Control"].includes(e.key)) stay();   // a modifier alone isn't using it
  });
  // Scrolling over the dialog changes the volume; content/input.js counts it (one place for every scroll). This only
  // keeps the page behind from scrolling if that script isn't there.
  backdrop.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });

  // Shown once the panel has its values, so it never appears half-filled.
  NerdfaderPanel.mount(dialog, { url: location.href, close }).then((p) => {
    panel = p;
    if (closed) return p.destroy();
    wrap.hidden = false;
    host.dataset.ready = "";   // for tests and for anyone checking from the page: the dialog is showing its values
    dialog.focus();
    poke();
  });
})();
