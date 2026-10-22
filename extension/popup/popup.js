const $ = (id) => document.getElementById(id);
const DEFAULT = 100;

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
// Pages the browser keeps extensions out of (arc://, chrome://, the Web Store) report no http(s)/file URL.
const supported = /^(https?|file):/.test(tab?.url ?? "");
let state = await call("state");

$("version").textContent = "v" + chrome.runtime.getManifest().version;
$("segments").innerHTML = "<i></i>".repeat(20);

function call(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, tabId: tab?.id, ...extra });
}

// One request in flight at a time; while dragging, only the latest value is sent next.
let pending = null, busy = false;
async function send(type, extra) {
  pending = { type, extra };
  if (busy) return;
  busy = true;
  while (pending) {
    const next = pending; pending = null;
    const reply = await call(next.type, next.extra);
    if (!pending && reply && !reply.error) { state = reply; render(); }
  }
  busy = false;
}

const current = () => (state.override.on ? state.override.percent : state.tab);

function setPercent(p) {
  p = Math.round(Math.min(100, Math.max(0, p)));
  if (state.override.on) state.override.percent = p; else state.tab = p;
  render();
  send(state.override.on ? "setOverride" : "setTab", { percent: p });
}

function render() {
  const all = state.override.on;
  const p = current();
  document.body.classList.toggle("all", all);
  document.body.classList.toggle("unsupported", !all && !supported);

  const target = $("target");
  target.classList.toggle("all", all);
  target.textContent = all ? "all tabs" : supported ? new URL(tab.url).hostname || "this file" : "can't change this page";

  $("slider").value = p;
  $("slider").setAttribute("aria-valuetext", `${p}%`);
  $("percent").textContent = `${p}%`;
  [...$("segments").children].forEach((seg, i) => seg.classList.toggle("on", p > i * 5));
  $("reset").disabled = p === DEFAULT;

  $("note").textContent = all
    ? supported ? `this tab keeps ${state.tab}%` : ""
    : supported ? (p === DEFAULT ? "this tab, default" : "this tab only") : "";
  $("override").checked = all;
  $("overrideHint").textContent = all
    ? "every tab plays at this volume"
    : "set every tab at once";
}

$("slider").addEventListener("input", (e) => setPercent(Number(e.target.value)));
$("reset").addEventListener("click", () => setPercent(DEFAULT));
$("override").addEventListener("change", (e) => {
  state.override.on = e.target.checked;
  render();
  send("setOverride", { on: e.target.checked });
  $("slider").focus();
});

const editable = () => state.override.on || supported;
addEventListener("keydown", (e) => {
  if (!editable() || e.metaKey || e.ctrlKey || e.altKey) return;
  const step = e.shiftKey ? 1 : 5;
  let p = null;
  if (e.key === "ArrowRight" || e.key === "ArrowUp") p = current() + step;
  else if (e.key === "ArrowLeft" || e.key === "ArrowDown") p = current() - step;
  else if (e.key === "PageUp" || e.key === "End") p = 100;
  else if (e.key === "PageDown" || e.key === "Home") p = 0;
  else if (/^[0-9]$/.test(e.key)) p = Number(e.key) * 10;
  else if (e.key === "r") p = DEFAULT;
  if (p === null) return;
  e.preventDefault();
  setPercent(p);
});
addEventListener("wheel", (e) => {
  if (!editable() || !e.deltaY) return;
  e.preventDefault();
  setPercent(current() + (e.deltaY < 0 ? 5 : -5));
}, { passive: false });

render();
$("slider").focus();
