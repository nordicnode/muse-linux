# Changelog

## 1.3.0 - 2026-10-15

Second audit pass (all findings from the 1.2.0 review fixed):

- Bug fix: deep links (hatch://, endo-window://, muse://) now
  work when the app is NOT already running. The link arrives in
  the app's command line on a cold start and was silently dropped
  (verified: handled once with the link, ignored without)
- Bug fix: the release zip now actually contains install.sh and
  uninstall.sh at the top level, as the README describes.
  install.sh also finds the icon inside the packaged app when
  there is no source tree (verified end-to-end from the zip under
  a scratch home directory: binary, icon, desktop entry and all
  three scheme registrations land correctly)
- Google sign-in stays in the app: accounts.google.com is now an
  allowed in-app host, so "Continue with Google" no longer
  completes in your browser while the app stays signed out
- uninstall.sh now points at the real profile folder
  (~/.config/Muse)
- install.sh cleans up its temporary extraction folder
- Find in page: match counts work in popup windows too, and
  Escape closes the find bar even when focus is in the page
- Release builds no longer expose DevTools (Inspect Element and
  the View menu toggle removed), and the headless screenshot
  test hook is ignored by packaged builds
- The zip no longer bundles repo internals (.github, docs,
  scripts) inside the app folder
- Release workflow now refreshes assets instead of failing if
  re-run after a half-created release
- Dependabot enabled for npm and GitHub Actions updates

Still open (needs a real desktop, cannot be verified from CI):
auto-update from an installed copy. The feed and wiring are
verified; the 1.2.0 -> 1.3.0 update prompt on a real 1.2.0
AppImage/.deb install is the test.

## 1.2.0 - 2026-10-15

- Electron updated from 33 to 44 (current Chromium and security
  fixes; Electron 33 was end-of-life). Verified: dev run, offline
  flow, zip package and AppImage build all re-tested
- Bug fix: reopening the window no longer stacks duplicate
  download handlers (one download could pop the save dialog
  several times after a close/reopen cycle)
- Bug fix: pressing Retry on the offline page while still offline
  now returns to the friendly offline page instead of Chromium's
  error page
- Bug fix: desktops without a working system tray no longer risk
  a startup crash; the app runs without a tray there
- Bug fix: deep-link registration now also recognises the
  electron-builder desktop file (muse-linux.desktop)
- Popup windows (sign-in consent, payment, connector auth) now
  get the same navigation guard and right-click menu as the main
  window
- Zoom level is remembered between launches
- Ctrl+W closes the window (respects the tray setting)
- Update dialogs no longer fail if the window is parked in the
  tray when an update check lands
- README rewritten to be user-facing; build notes moved to
  BUILDING.md; stale committed SHA256SUMS removed (it is a
  per-release artifact)

## 1.1.0 - 2026-10-15

Everyday UX:
- Offline page: if muse.ai fails to load (network down, DNS,
  proxy), you now get a friendly "Can't reach Muse" page with a
  Retry button and automatic retry when the connection returns,
  instead of Chromium's raw error page
- Window position is clamped to a connected display on restore, so
  unplugging a monitor can no longer strand the window off-screen
- Close-to-tray is now genuine (the window hides, keeping your
  place in the conversation) and can be turned off in the Muse
  menu ("Keep in system tray when closed"); with it off, closing
  the window quits the app
- Download save dialog is async, so it no longer freezes the app
  while open

Packaging and updates:
- AppImage builds (x64 and arm64): one file, make it executable
  and run it. Plus .deb packages (x64 and arm64)
- Real auto-update for AppImage and .deb installs via
  electron-updater against GitHub Releases: a quiet background
  check on launch, and "Check for Updates..." actually checks now.
  The zip build keeps the manual flow and opens Releases
- Wayland: native window instead of XWayland where available
  (`--ozone-platform-hint=auto` in the app and desktop entries)

Repo:
- Release notes now contain only the tagged version's changelog
  section; CI smoke workflow (syntax check + package build) added

## 1.0.1 - 2026-10-15

- Fix noisy startup when running the unpacked binary without
  installing: Electron's protocol registration shells out to
  xdg-mime once per scheme and, with no .desktop entry present,
  printed `qtpaths: command not found` / `application argument
  missing` errors to the terminal on every launch. Registration is
  now only attempted when a desktop entry is installed (install.sh
  registers the schemes itself at install time).

Not app bugs, for the record: `Fontconfig warning: ... invalid
constant` lines come from the host system's fontconfig config
version; `ffmpeg_common.cc Unsupported pixel format: -1` lines are
Chromium's bundled ffmpeg probing the app's avatar videos. Both
appear with any Chromium/Electron app on such a system and are
harmless. Launching from the applications menu (or with
`2>/dev/null`) hides terminal noise entirely.

## 1.0.0 - 2026-10-15

First public release. Unofficial Linux desktop app for Muse
(modelled on the macOS Muse 7.0 app).

- Electron shell for https://muse.ai with persistent login session
- System tray, downloads with save dialog, external links open in
  the default browser, Muse/Meta auth hosts stay in-app
- Right-click context menu (copy/paste, links, images, spellcheck
  suggestions)
- Find in page (Ctrl+F) with match counts
- Window size/position restored between launches
- Mic/camera/geolocation/notification permissions granted only to
  Muse/Meta origins
- Deep links: `hatch://`, `endo-window://`, `muse://`
- install.sh / uninstall.sh with desktop entry and scheme-handler
  registration

### Known differences from the macOS app

- No Apple-service integrations (Contacts, Calendar, Reminders,
  Photos, Speech, Keychain): macOS-only, no Linux equivalent here
- No native-bridge features for the device you are sitting at
  (host computer use, host local connectors, 1Password hookup)
- No auto-update; download new releases from GitHub
- Everything server-side (chats, the agent VM, connectors, files)
  is account-bound and works as on Mac/web
