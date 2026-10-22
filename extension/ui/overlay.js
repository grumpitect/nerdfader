// The in-page dialog. Injected into the tab's top frame (after ui/panel.js) each time Nerdfader's toolbar icon or
// shortcut is used: opens the panel centered over a blurred backdrop, or closes it if it is already open. Clicking the
// backdrop or pressing Esc closes it too. It lives in a closed shadow root, so the page's styles can't reach it.
//
// Option/Alt + scroll opens it "for a moment" instead (the background sets globalThis.__nerdfaderOpen first): it goes
// away 2 seconds after the last scroll, unless the user clicks or types in it, which keeps it until they click away
// or press Esc. While it is up, scrolling anywhere over it changes the volume.
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
  background: rgba(12, 6, 28, 0.35);
  -webkit-backdrop-filter: blur(8px) saturate(0.9);
  backdrop-filter: blur(8px) saturate(0.9);
  animation: fade 140ms ease-out;
}
.dialog {
  border: 1px solid #3a2366;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 79, 168, 0.08), 0 0 40px rgba(255, 79, 168, 0.12);
  animation: pop 160ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
.closing .backdrop { animation: fade 110ms ease-in reverse forwards; }
.closing .dialog { animation: pop 110ms ease-in reverse forwards; }
@keyframes fade { from { opacity: 0; } }
@keyframes pop { from { opacity: 0; transform: scale(0.96) translateY(6px); } }
@media (prefers-reduced-motion: reduce) {
  .backdrop, .dialog, .closing .backdrop, .closing .dialog { animation: none; }
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
    wrap.classList.add("closing");
    const done = () => { host.remove(); previousFocus?.focus?.({ preventScroll: true }); };
    matchMedia("(prefers-reduced-motion: reduce)").matches ? done() : setTimeout(done, 110);
  }
  host.addEventListener("nerdfader-close", close);
  addEventListener("pagehide", close);
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(); });

  // Shown for a moment: hide 2 s after the last scroll, unless the user starts using it.
  let staying = !request.moment, hideTimer = 0;
  const poke = () => {
    if (staying || closed) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(close, 2000);
  };
  const stay = () => { staying = true; clearTimeout(hideTimer); };
  host.addEventListener("nerdfader-poke", poke);
  dialog.addEventListener("pointerdown", stay);
  dialog.addEventListener("keydown", (e) => { if (e.key !== "Escape") stay(); });
  backdrop.addEventListener("wheel", (e) => {
    e.preventDefault();
    panel?.wheel(e);
    poke();
  }, { passive: false });

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
