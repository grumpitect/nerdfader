const $ = (id) => document.getElementById(id);
const DEFAULT = 100;
const MAX = 600;
// The slider's first half is 0 to 100% in steps of 1, its second half 100 to 600% in steps of 5.
const toPercent = (pos) => (pos <= 100 ? pos : 100 + (pos - 100) * 5);
const toPos = (p) => (p <= 100 ? p : 100 + (p - 100) / 5);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
// Pages the browser keeps extensions out of (arc://, chrome://, the Web Store) report no http(s)/file URL.
const supported = /^(https?|file):/.test(tab?.url ?? "");
const host = supported ? new URL(tab.url).hostname.replace(/^www\./, "") || "this file" : "";

function call(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, tabId: tab?.id, ...extra });
}

// Opening the popup lets the browser capture this tab, so a paused capture mode starts again here.
let state = await call("opened");

$("version").textContent = "v" + chrome.runtime.getManifest().version;
$("segments").innerHTML = Array.from({ length: 20 }, (_, i) => `<i class="${i >= 10 ? "boost" : ""}"></i>`).join("");

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

// Pages report what they can boost, and capture mode starts and stops, while the popup is open.
chrome.storage.onChanged.addListener(async (changes) => {
  const mine = [`blocked:${tab?.id}`, `capture:${tab?.id}`, "captureAlways"];
  if (busy || !Object.keys(changes).some((k) => mine.includes(k))) return;
  const reply = await call("state");
  if (!busy && reply && !reply.error) { state = reply; render(); }
});

const current = () => (state.override.on ? state.override.percent : state.tab);

function setPercent(p) {
  p = Math.round(Math.min(MAX, Math.max(0, p)));
  if (state.override.on) state.override.percent = p; else state.tab = p;
  render();
  send(state.override.on ? "setOverride" : "setTab", { percent: p });
}

const reasons = {
  protected: "it plays protected (DRM) media",
  "cross-origin": "its media comes from another site",
  stream: "it plays a live stream",
  click: "you haven't clicked the page yet",
};

function render() {
  const all = state.override.on;
  const p = current();
  const boosting = p > DEFAULT;
  document.body.classList.toggle("all", all);
  document.body.classList.toggle("unsupported", !all && !supported);

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
  else if (supported && boosting && capture === "paused") note = "capture mode: open me on this tab to resume";
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
  $("captureAlwaysToggle").checked = state.captureAlways;
  $("captureHint").textContent = state.captureAlways
    ? "used on sites that block boosting"
    : "asks first on sites that block boosting";
}

$("slider").addEventListener("input", (e) => setPercent(toPercent(Number(e.target.value))));
$("reset").addEventListener("click", () => setPercent(DEFAULT));
$("override").addEventListener("change", (e) => {
  state.override.on = e.target.checked;
  render();
  send("setOverride", { on: e.target.checked });
  $("slider").focus();
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
$("captureAlwaysToggle").addEventListener("change", (e) => {
  state.captureAlways = e.target.checked;
  render();
  send("setCapture", { always: e.target.checked });
  $("slider").focus();
});

const editable = () => state.override.on || supported;
addEventListener("keydown", (e) => {
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
addEventListener("wheel", (e) => {
  if (!editable() || !e.deltaY) return;
  e.preventDefault();
  setPercent(toPercent(Math.min(200, Math.max(0, toPos(current()) + (e.deltaY < 0 ? 5 : -5)))));
}, { passive: false });

render();
$("slider").focus();
