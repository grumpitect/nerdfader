// The in-page dialog. Injected into the tab's top frame (after ui/panel.js) each time Nerdfader's toolbar icon is
// clicked: opens the panel centered over a blurred backdrop, or closes it if it is already open. Clicking the
// backdrop or pressing Esc closes it too. It lives in a closed shadow root, so the page's styles can't reach it.
(() => {
  const TAG = "nerdfader-dialog";
  const open = document.querySelector(TAG);
  if (open) { open.dispatchEvent(new Event("nerdfader-close")); return; }

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

  NerdfaderPanel.mount(dialog, { url: location.href, close }).then((p) => {
    panel = p;
    if (closed) p.destroy();
  });
})();
