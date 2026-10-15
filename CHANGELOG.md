# Changelog

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
