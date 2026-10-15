# Changelog

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
