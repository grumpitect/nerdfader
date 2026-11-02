// Renders Nerdfader's toolbar and store icons (extension/icons/icon-<size>.png) from docs/nerdfader-icon.svg, with
// simpler drawings for the small sizes, where the full one would blur or thin out; and channel_strip's (cs-<size>.png). Headless Chrome, nothing shown. Run by hand after
// changing the icon: node Tools/render-icons.mjs
import fs from "node:fs";
import { chromium } from "playwright";
const root = new URL("..", import.meta.url).pathname;
const full = fs.readFileSync(root + "docs/nerdfader-icon.svg", "utf8");
// At 16 px: no edge or grid, a 1 px resistor and a 2 px arrow, on whole pixels.
const small = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <rect width="16" height="16" rx="3.5" fill="#f8f7f2"/>
  <rect x="3.5" y="6.5" width="9" height="3" fill="#f8f7f2" stroke="#15171b"/>
  <path d="M2.6 13.4L10.6 5.4" stroke="#c21f35" stroke-width="1.8"/>
  <path d="M13.6 2.4L8.6 3.4L12.6 7.4Z" fill="#c21f35"/>
</svg>`;
// At 32 and 48 px (32 is what a retina toolbar shows): the same drawing in heavier lines, without the grid.
const medium = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect x="3" y="3" width="122" height="122" rx="25" fill="#f8f7f2" stroke="#15171b" stroke-width="6"/>
  <path d="M10 64H26M102 64H118" stroke="#15171b" stroke-width="8"/>
  <rect x="26" y="46" width="76" height="36" fill="#f8f7f2" stroke="#15171b" stroke-width="9"/>
  <path d="M24 104L90 38" stroke="#c21f35" stroke-width="12"/>
  <path d="M110 18L76 25L103 52Z" fill="#c21f35"/>
</svg>`;
// channel_strip's icon (the default theme's, and the manifest's): docs/nerdfader-icon-channel-strip.svg, and simpler
// drawings for 16 px (slot and cap) and 32 px (no scale marks or gradient), with a light rim so it shows on dark bars.
const strip = fs.readFileSync(root + "docs/nerdfader-icon-channel-strip.svg", "utf8");
const stripSmall = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <rect x="0.5" y="0.5" width="15" height="15" rx="3.5" fill="#231d16" stroke="#5a4d3c"/>
  <rect x="7" y="2" width="2" height="12" fill="#0d0a07"/>
  <rect x="3.5" y="5" width="9" height="4" rx="0.8" fill="#ff8a3d"/>
</svg>`;
const stripMedium = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect x="2" y="2" width="124" height="124" rx="28" fill="#231d16" stroke="#f3e9d8" stroke-opacity="0.35" stroke-width="4"/>
  <rect x="56" y="20" width="16" height="88" rx="3" fill="#0d0a07"/>
  <rect x="80" y="62" width="14" height="5" rx="1" fill="#8be38f"/>
  <rect x="32" y="38" width="64" height="26" rx="4" fill="#ff8a3d"/>
  <rect x="32" y="49" width="64" height="4" fill="#5a2a0c"/>
</svg>`;
const browser = await chromium.launch();
const page = await browser.newPage();
const icons = [
  [16, small, "extension/icons/icon-16.png"], [32, medium, "extension/icons/icon-32.png"], [48, medium, "extension/icons/icon-48.png"],
  [128, full, "extension/icons/icon-128.png"],
  [16, stripSmall, "extension/icons/cs-16.png"], [32, stripMedium, "extension/icons/cs-32.png"], [48, stripMedium, "extension/icons/cs-48.png"], [128, strip, "extension/icons/cs-128.png"],
  [1024, strip, "docs/nerdfader-icon.png"],   // the README's: the default theme's
];
for (const [size, svg, out] of icons) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: root + out, omitBackground: true });
}
await browser.close();
