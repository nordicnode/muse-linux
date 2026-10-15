# Muse for Linux (unofficial)

Meta ships Muse for Mac, iOS, Android and the web, but not Linux.
This is an unofficial Linux desktop app: an Electron shell for
[muse.ai](https://muse.ai), modelled on the official macOS app
(Muse 7.0), built and verified against the real thing.

> **Disclaimer:** Unofficial project by
> [nordicnode](https://github.com/nordicnode). Not affiliated with,
> endorsed by, or sponsored by Meta. "Muse" and the app icon are
> Meta's; the Muse service is Meta's and subject to Meta's terms
> and regional availability. This repository contains only the
> shell code (MIT licensed, see [LICENSE](LICENSE)).

![Muse for Linux loading muse.ai](screenshot-verified.png)

## Install

From [Releases](https://github.com/nordicnode/muse-linux/releases),
pick whichever format you like (x64 and arm64 where applicable):

**AppImage** (recommended, no install):

```sh
chmod +x Muse-*.AppImage
./Muse-*.AppImage
```

**Debian/Ubuntu package:**

```sh
sudo apt install ./muse-linux_*_amd64.deb   # or *_arm64.deb
```

**Zip folder:**

```sh
unzip Muse-linux-x64.zip
./Muse-linux-x64/Muse
```

For the zip, `./install.sh` optionally adds a menu entry, icon and
deep-link registration (and `./uninstall.sh` removes them).

AppImage and .deb installs **auto-update** from GitHub Releases
(quiet background check on launch; *Muse -> Check for Updates...*
checks immediately). The zip build is manual: that menu item opens
the Releases page.

Verify downloads against `SHA256SUMS` attached to each release.

## Features

- Persistent login: sign in once, the session survives restarts
- Everything account/server-side works as on Mac and web: chats,
  the agent VM, files, connectors. The VM is bound to your
  account, not to any specific client
- System tray (closing the window keeps Muse in the tray, with
  your place in the conversation intact; can be switched off)
- Right-click context menu with spellcheck suggestions
- Find in page (Ctrl+F) with match counts
- Friendly offline page with retry when muse.ai cannot be reached
- Window size and position remembered between launches, and kept
  on a connected display if your monitor setup changes
- Downloads ask where to save, then reveal the file
- Muse/Meta hosts (login, accounts, auth) stay in-app; external
  links open in your default browser
- Mic/camera/geolocation/notifications only granted to Muse/Meta
  origins; everything else denied by default
- Deep links matching the Mac app: `hatch://`, `endo-window://`
  (plus `muse://`)

### Known differences from the macOS app

- No Apple-service integrations (Contacts, Calendar, Reminders,
  Photos, Speech Recognition, Keychain): macOS-only
- No native-bridge features for the device you are sitting at
  (host computer use, host local connectors, 1Password hookup)
- No Sparkle-style update feed from Meta; this port updates
  itself from its own GitHub Releases (AppImage/.deb), see Install

## Build from source

```sh
npm install
npm start           # run in dev mode
npm run package     # zip layout via electron-packager (dist-packager/)
npm run dist        # AppImage + .deb via electron-builder (dist/)
```

## Privacy

This shell adds no telemetry, analytics or third-party requests of
its own. It loads muse.ai and the Muse/Meta hosts needed for
login, and stores your session locally in Electron's per-app
profile (`persist:muse` partition) on your machine. Traffic goes
to Meta's services exactly as it does in a browser.

## How this came about: could the Mac app be "converted"?

No, and the analysis is half the fun. Extracting the official
`Muse-7.0.dmg` (49,905,200 bytes, SHA-256
`3bef29eafc4797c4e12ba99ca26c43a020511ec4d36985579fba9f5fff7f6fb5`,
built 2026-10-07) shows a **native macOS app**, not a
cross-platform bundle:

- One 51 MB universal Mach-O binary (x86_64 + arm64),
  bundle id `com.meta.endo` (internal names "Endo" / "Hatch"),
  Xcode 27, macOS 27 SDK, minimum macOS 14.0
- Written in **SwiftUI / AppKit**, hosting **WKWebView**; the only
  bundled framework is Sparkle (the macOS auto-updater)
- No Electron, no Tauri, no `app.asar` to repackage. Mach-O +
  SwiftUI cannot run or be recompiled on Linux, and Wine/Darling
  do not run SwiftUI GUI apps

What the Mac app does is wrap web technology in that native
shell: a bundled 44.7 MB single-file React app
(`Contents/Resources/hatch/index.html`), plus `https://muse.ai`
in a web view with injected native bridges
(`window.webkit.messageHandlers.*` / `window.endoHatch.*`), backed
by `api.muse.ai`, `api.meta.ai`, `hatch-api.meta.ai` and
`auth.meta.com`.

"Hatch" is the desktop client's internal codename (and its
mascot). The agent "VM" (in its hardened form, "CVM") is a
per-account remote virtual machine behind a gateway: the binary's
own strings describe a pinned VM that is suspended when idle and
woken on connect, with its own home directory you upload files to
via `files.upload`. The CVM form adds PIN lock, a recovery
secret, attestation gates and an encrypted Noise-protocol channel
("Vesta" auth). Because that VM is account-bound, this Linux shell
reaches it exactly like the Mac app does once you sign in.

(The reverse-engineering pass was done with REA, Ghidra and
Hopper; REA's graph evidence strips string literals, so endpoints
and constants were confirmed by mining the bundles directly.)
