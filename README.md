<p align="center"><img src="docs/nerdfader-icon.png" width="256" alt="Nerdfader icon"></p>

# Nerdfader

**A volume slider for every browser tab, from 0 to 600%.**

Nerdfader is a small, free, open-source browser extension for Arc, Chrome and other Chromium browsers. Click its
icon (or press ⌘⇧End), and a small dialog opens in the middle of the page over a blurred backdrop. Drag the slider,
and that tab gets quieter (or louder). Click anywhere outside it, press Esc, or click the icon again to close it.
Most sites are boosted from inside the page, with no "this tab is being shared" highlight; capture mode is only
used, with your OK, for the few sites that block that.

Made for the [Nerdative](https://www.youtube.com/@nerdative) channel on YouTube, by the same person as
[Nerdwave](https://github.com/grumpitect/nerdwave).

<p align="center"><img src="docs/dialog.png" width="660" alt="Nerdfader's dialog over a page"></p>

## Features

- **One slider per tab.** 0 to 600%. Each tab remembers its volume across reloads and navigation, until you close it.
- **A boost you can hear, without crackle.** Above 100% a soft clipper rounds off the loudest peaks instead of
  chopping them, so loud music and speech really get louder (about +12 dB at 600%, where a limiter gave +6).
  600% is 6x (+15.6 dB) on quieter audio, the same scale as other boosters.
- **Capture mode, only when needed.** Netflix, Spotify and other DRM sites (and media served from another site
  without permission to process it) can't be boosted from inside the page. For those, Nerdfader offers capture
  mode: once for that tab, or always. It runs only while the tab plays sound: it stops a moment after the tab
  pauses or goes quiet, and starts again when it plays. The ⓘ next to capture_mode in the dialog explains it.
- **Reset.** One click (or **r** in the dialog) puts the tab back to 100%; with all_tabs on, it resets every tab.
- **all_tabs.** Turn it on and one slider sets every tab, including ones you open later. Turn it off and every
  tab goes back to the volume it had before.
- **Badge.** The toolbar icon shows the tab's volume when it isn't 100%.
- **Keys.** On any page (Ctrl instead of ⌘ on Windows and Linux):

  | Keys | Does |
  |---|---|
  | **⌘⇧End** | opens and closes the dialog (on a MacBook keyboard, End is fn+→) |
  | **⌘⇧↑** / **⌘⇧↓** | turns the tab up / down a step (5%, or 25% above 100%); hold to keep going |
  | **⌘⇧⌫** (Delete) | resets the tab to 100% |

  Louder, quieter and reset show the dialog for a moment, like scrolling. Change any of them under **keys** in the
  dialog (click one, press the new keys; Delete removes it). In a browser that already uses one of these keys
  itself, that one starts as ⌘⇧ + a number instead (0, then 1, 2...): Chrome uses ⌘⇧⌫ for "Delete browsing data",
  so there reset is ⌘⇧0; Arc uses none of them. The keys are Nerdfader's own, handled in the page, so they don't
  work while the address bar has focus or on pages extensions can't touch (`arc://` pages, the Web Store); the
  toolbar icon still does. In text fields, ⌘⇧↑/↓/End/⌫ keep editing text as usual.
- **Modifier + scroll.** Hold Command + Shift (Windows key + Shift elsewhere) and scroll anywhere, with a mouse wheel
  or two fingers on a trackpad, to change the tab's volume: scrolling down turns it up (with macOS natural scrolling,
  that's a two-finger swipe up). The dialog shows and follows along while you keep scrolling; it goes away a second
  after you stop. Click or type in it and it stays until you click away or press Esc. Choose the keys to hold under
  **scroll_volume**: any combination of ⌥ Option, ⌃ Control, ⇧ Shift and ⌘ Command (at least one), or turn it off.
  On a Mac, combinations with Option work with a trackpad only (macOS doesn't pass Option + mouse wheel to pages). A
  trackpad pinch never counts as Control + scroll, and a scroll that began without the keys (or is still coasting
  after a flick) never turns into a volume change when you press them. The page doesn't rubber-band while the dialog
  is up, so a hard swipe at the top or bottom of a page stays with the dialog.
- **Keyboard and mouse wheel in the dialog.** ←/→ change by 5% (25% above 100%; hold Shift for finer steps), **0**
  to **9** jump to 0 to 90%, **r** resets, **c** takes up the capture-mode offer, **Esc** closes, and scrolling over
  the dialog works too. The dialog keeps the keyboard itself, so no control inside it takes focus or shows a focus
  ring (Tab doesn't step through it).
- **Four-finger gestures?** macOS keeps three- and four-finger trackpad gestures to itself; web pages and extensions
  never see them. To open Nerdfader with one, map the gesture to ⌘⇧End (or ⌘⇧↑ / ⌘⇧↓) in a tool like
  [BetterTouchTool](https://folivora.ai).
- **The site doesn't notice.** YouTube's own volume slider keeps working and keeps showing its own value;
  Nerdfader scales whatever the site plays.
- **Even-feeling slider.** Below 100% it uses the same curve as VLC and Nerdwave, so 50% sounds about half as
  loud instead of barely quieter. The first half of the bar is 0 to 100%, the second half 100 to 600%.

## Install

**One command** (macOS; installs or updates to the latest release):

```bash
curl -fsSL https://raw.githubusercontent.com/grumpitect/nerdfader/main/install.sh | bash
```

[install.sh](install.sh) downloads the latest release, checks its SHA-256 against the one in the release notes, and
puts the extension in `~/Library/Application Support/Nerdfader/extension`. It only uses tools that come with macOS;
read it first if you like.

**By hand** (any OS): grab the latest **Nerdfader-x.y.z.zip** from
[Releases](https://github.com/grumpitect/nerdfader/releases/latest) and unzip it somewhere it can stay.

**Then, once, load it in your browser:**

1. Open `arc://extensions` in Arc (or `chrome://extensions` in Chrome, Brave, Edge...).
2. Turn on **Developer mode**, click **Load unpacked**, and choose the **Nerdfader** folder
   (the one the install command printed, or the one you unzipped).
3. Pin it to your toolbar so the slider is one click away.

Tabs that were already open start working right away. **Updating:** run the install command again (or replace the
folder). Nerdfader notices its files changed and reloads itself the next time you load a page or switch tabs; open
tabs switch to the new version on their own and your settings stay. (Updating from a version before 1.1.0, click
the reload arrow on Nerdfader's card once.)

## How it works

Browsers give extensions two ways to change a tab's volume. One is to capture the tab's audio (what Volume Master
does), which highlights the tab as being shared. Nerdfader uses the other whenever it can: a small script inside
each page (and each frame in it) that scales the page's own sound.

- **`<audio>` and `<video>`:** the element plays at the site's volume times yours. The site still reads back the
  volume it set, so its own controls don't jump. Above 100%, the element's sound goes through a gain stage and a
  soft clipper (Web Audio).
- **Web Audio** (games, some players): sound headed for the speakers passes through the same gain stage, which
  glides to the new level so dragging doesn't click.

The browser won't let a page's script process three kinds of sound, so those can't be boosted from inside:
protected (DRM) media, media from another site that doesn't allow it, and sound in a page you haven't clicked yet
(clicking anywhere in it fixes that one). Nerdfader detects these, keeps them at up to 100% instead of silencing
them, and the dialog offers **capture mode**:

- The tab's sound is captured and played back louder from a hidden extension page. The browser shows the tab as
  shared while this runs.
- It runs only while needed. It stops a moment (1.5 s) after the tab pauses, or after 3 s of silence, and starts
  again when the tab plays. It also stops right away when you go back to 100% or below.
- The browser only lets an extension capture a tab after you've clicked the extension on that tab. If it refuses
  to restart capture later (for example after the tab moved to a new page), the tab plays at 100% and opening the
  dialog on it resumes the boost.

Nerdfader can't reach pages the browser keeps extensions out of (`arc://` and `chrome://` pages, the Chrome Web
Store). Sound from plugins or from other extensions isn't affected either.

**Permissions.** Access to all sites, to run that script in whatever page you're on; storage, to remember volumes and
settings; tab capture and an offscreen page, for capture mode. Nerdfader sends nothing anywhere: there is no
network code in it.

Volumes live in the browser's extension storage. A tab's own volume lasts until the tab closes or the browser quits;
the switches, the keys and the scroll keys are remembered across restarts.

## Development

```bash
git clone https://github.com/grumpitect/nerdfader.git
cd nerdfader
npm install            # Playwright, for the tests only; the extension has no dependencies
npx playwright install chromium
npm test               # loads the extension into Chromium and measures what tabs actually play at
```

The tests switch the browser's audio output off (pages still play and can be captured) and measure each tab's
real output with tab capture, so they're silent.

```bash
npm run test:real      # the same in your installed Google Chrome, the way a person uses it (no window)
```

`test:real` starts Google Chrome with a throwaway profile and drives it over its debugging protocol, which can load
the extension and click its toolbar icon for real. It installs 1.0.0 and updates it over open tabs, reloads it while
tabs play, opens the dialog, uses the keys and modifier + scroll, runs capture mode under Chrome's real "only after
you clicked it on this tab" rule, plays a DRM (ClearKey) stream, and visits YouTube, Vimeo, Facebook and Twitch,
failing on anything that shows up under Errors in chrome://extensions. It runs twice: once letting pages play sound
freely (most tests need that), and once with the browser's normal autoplay rule, to check nothing warns before
you've clicked a page. Its audio output is off and it runs headless, so it's silent and never shows a window. Set
`CHROME` to use another Chromium-based browser.

To try a change, load the `extension` folder with **Load unpacked** and click the reload arrow after editing.

- `extension/content/main.js`: runs in the page's world; patches media volume and Web Audio, boosts, and reports
  what it can't boost.
- `extension/content/bridge.js`: runs in the extension's world; passes the level from the background to the page.
- `extension/content/input.js`: the keys and modifier + scroll (on pages and over the dialog).
- `extension/background.js`: remembers each tab's volume and the switches, pushes levels to tabs, and decides when
  capture mode runs.
- `extension/offscreen/`: capture mode's playback, soft clipper and silence detection.
- `extension/ui/panel.js`: the panel (slider, reset, switches, capture offer), shared by the dialog and the popup.
- `extension/ui/overlay.js`: the in-page dialog.
- `extension/popup/`: the toolbar popup, for pages the dialog can't open in.
- `Tools/make_icon.py`: regenerates the icons (`pip install pillow numpy`, then
  `python3 Tools/make_icon.py extension/icons`; `python3 Tools/make_icon.py --png docs/nerdfader-icon.png 1024`
  renders the README version).
- `SCREENSHOT=docs/dialog.png npm test` re-renders the README screenshot.

Maintainers publish a release with `./release.sh` (patch bump by default; `minor`, `major` or an exact `X.Y.Z`
also work). It runs the tests (all three suites), bumps the version in `manifest.json`, zips the extension, tags,
pushes and creates the GitHub release.

## Feedback

Found a site where it doesn't work, or have an idea? Click **feedback** in the dialog, or
[open an issue](https://github.com/grumpitect/nerdfader/issues/new/choose).

## License

[MIT](LICENSE).
