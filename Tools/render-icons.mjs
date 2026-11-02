// Renders Nerdfader's toolbar and store icons (extension/icons/icon-<size>.png) from docs/nerdfader-icon.svg, with
// simpler drawings for the small sizes, where the full one would blur or thin out. Headless Chrome, nothing shown. Run by hand after
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
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [size, svg] of [[16, small], [32, medium], [48, medium], [128, full], [1024, full]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  const out = size === 1024 ? root + "docs/nerdfader-icon.png" : `${root}extension/icons/icon-${size}.png`;
  await page.screenshot({ path: out, omitBackground: true });
}
await browser.close();
