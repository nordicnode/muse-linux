// Muse for Linux - unofficial port of the macOS Muse desktop app.
//
// What the Mac app actually is (verified 2026-10-15 by extracting
// Muse-7.0.dmg and analysing it with REA + strings):
//   * A native SwiftUI/AppKit shell (bundle id com.meta.endo, internal
//     name "Endo" / "Hatch") hosting WKWebViews.
//   * The product surface is web technology: a bundled 44.7 MB local
//     React app at Contents/Resources/hatch/index.html, plus
//     https://muse.ai loaded in a web view with injected native
//     bridges (window.webkit.messageHandlers.* / window.endoHatch.*).
//   * Native-only extras: macOS Contacts/Calendar/Reminders/Photos
//     access, Apple Events, system Speech Recognition, Keychain
//     group, Sparkle auto-update, Crashpad crash reporting, and the
//     account's remote agent VM ("CVM") reached through the bridge.
//
// SwiftUI/AppKit/WKWebView code cannot run or be recompiled on Linux,
// so this port recreates the shell in Electron/Chromium and loads the
// same muse.ai web app the Mac app loads. Everything server-side
// (account, chats, the agent VM, connectors, files) works identically,
// as the VM is bound to the account, not the client. The native
// bridges above have no Linux equivalent in this build; web
// equivalents are used where they exist (getUserMedia for mic/camera,
// the Chromium file picker for files, web notifications).

const { app, BrowserWindow, Menu, Tray, shell, session, dialog, nativeImage, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

// Wayland: prefer a native Wayland window over XWayland when the
// session is Wayland (the hint is a no-op on X11). Must be set
// before the app is ready.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

const HOME_URL = 'https://muse.ai/';
const RELEASES_URL = 'https://github.com/nordicnode/muse-linux/releases';

// Hosts that belong inside the app (login and account flows included).
// Everything else opens in the user's default browser, the way the
// Mac app hands external links to the system.
const INTERNAL_HOSTS = new Set([
  'muse.ai',
  'www.muse.ai',
  'api.muse.ai',
  'auth.muse.ai',
  'auth.meta.com',
  'accountscenter.meta.com',
  'www.meta.com',
  'meta.com',
  'www.facebook.com',
  'facebook.com',
  'agent.meta.ai',
  // Google sign-in: without this, "Continue with Google" bounces
  // to the system browser and completes there, leaving the app
  // signed out.
  'accounts.google.com',
]);

function isInternal(url) {
  try {
    return INTERNAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Only these schemes may be handed to the OS from page-controlled
// URLs (link clicks, navigations, popups). Anything else (file:,
// app-specific protocol handlers a page could invoke with attacker
// arguments) is blocked rather than launched.
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
function openExternalSafe(url) {
  try {
    if (EXTERNAL_SCHEMES.has(new URL(url).protocol)) shell.openExternal(url);
  } catch {
    /* unparseable URL: do nothing */
  }
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let showingOffline = false;
let onOfflinePage = false;
let lastGoodURL = HOME_URL;
let downloadsWired = false;

// ---------------------------------------------------------------------
// Settings: currently just the close-to-tray preference, persisted as
// JSON in userData.
// ---------------------------------------------------------------------
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    return { closeToTray: true, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { closeToTray: true };
  }
}
const settings = loadSettings();
function saveSettings() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------
// Window state: remember size, position and maximised flag across runs.
// ---------------------------------------------------------------------
function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch {
    /* first run */
  }
  return { width: 1280, height: 860 };
}
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const isMaximized = mainWindow.isMaximized();
    // Save the NORMAL bounds, not the maximized ones: otherwise
    // unmaximizing after a restart keeps the full-screen size
    // instead of returning to the user's windowed size.
    const bounds = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    // Note: no zoom persistence here on purpose. Chromium already
    // remembers zoom per site in the profile (verified 2026-10-15:
    // set 1.5, restart, still 1.5 with no help from us). A previous
    // hand-rolled version force-applied the last page's factor to
    // every page and fought the built-in behaviour.
    fs.writeFileSync(windowStatePath(), JSON.stringify({ ...bounds, isMaximized }));
  } catch {
    /* best effort */
  }
}

// If the saved position no longer intersects any connected display
// (monitor unplugged, docking change), re-centre on the primary
// display instead of restoring the window somewhere unreachable.
function clampBoundsToDisplays(state) {
  if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) return state;
  const rect = { x: state.x, y: state.y, width: state.width, height: state.height };
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const overlapW = Math.min(rect.x + rect.width, a.x + a.width) - Math.max(rect.x, a.x);
    const overlapH = Math.min(rect.y + rect.height, a.y + a.height) - Math.max(rect.y, a.y);
    return overlapW >= 100 && overlapH >= 60; // enough title bar to grab
  });
  if (visible) return state;
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(state.width, wa.width);
  const height = Math.min(state.height, wa.height);
  return {
    ...state,
    width,
    height,
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2),
  };
}

// ---------------------------------------------------------------------
// Context menu: Electron shows nothing on right-click by default, so
// build the menu every desktop user expects.
// ---------------------------------------------------------------------
function installContextMenu(win) {
  win.webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.linkURL) {
      items.push(
        {
          label: 'Open Link in Browser',
          click: () => openExternalSafe(params.linkURL),
        },
        {
          label: 'Copy Link Address',
          click: () => require('electron').clipboard.writeText(params.linkURL),
        },
        { type: 'separator' },
      );
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        {
          label: 'Save Image As...',
          click: () => win.webContents.downloadURL(params.srcURL),
        },
        {
          label: 'Copy Image Address',
          click: () => require('electron').clipboard.writeText(params.srcURL),
        },
        { type: 'separator' },
      );
    }
    if (params.isEditable) {
      items.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' },
      );
      // Spellcheck suggestions, when Chromium has any.
      if (params.misspelledWord) {
        const suggestions = (params.dictionarySuggestions || []).slice(0, 5);
        if (suggestions.length) {
          items.push({ type: 'separator' });
          for (const s of suggestions) {
            items.push({
              label: s,
              click: () => win.webContents.replaceMisspelling(s),
            });
          }
        }
        items.push({
          label: 'Add to Dictionary',
          click: () =>
            win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        });
      }
    } else if (params.selectionText) {
      items.push({ role: 'copy', enabled: params.editFlags.canCopy });
    }
    items.push(
      { type: 'separator' },
      {
        label: 'Find in Page...',
        accelerator: 'Ctrl+F',
        click: () => showFindBar(win),
      },
      { role: 'reload' },
    );
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

// ---------------------------------------------------------------------
// Find in page: the bar itself is rendered by the preload script
// (shadow DOM inside the page); here we just drive findInPage and
// forward match counts back.
// ---------------------------------------------------------------------
function showFindBar(win) {
  win.webContents.send('find:show');
}
// Forward match counts to the window they belong to (main window
// and popups alike).
function wireFindResults(win) {
  win.webContents.on('found-in-page', (_e, result) => {
    if (win.isDestroyed()) return;
    win.webContents.send('find:result', {
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    });
  });
}
ipcMain.on('find:search', (event, { text, forward }) => {
  const wc = event.sender;
  if (!text) {
    wc.stopFindInPage('clearSelection');
    return;
  }
  wc.findInPage(text, { forward: forward !== false, findNext: true });
});
ipcMain.on('find:stop', (event) => {
  event.sender.stopFindInPage('keepSelection');
});

function createWindow() {
  const state = clampBoundsToDisplays(loadWindowState());
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 720,
    minHeight: 520,
    title: 'Muse',
    icon,
    backgroundColor: '#0f0f12',
    autoHideMenuBar: false,
    webPreferences: {
      partition: 'persist:muse', // login session survives restarts, like the Mac app
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (state.isMaximized) mainWindow.maximize();

  installContextMenu(mainWindow);
  wireFindResults(mainWindow);

  // Keep navigation inside the app for Muse/Meta hosts only.
  // Note: server redirects (will-redirect) are deliberately NOT
  // guarded. Meta's login flow bounces through redirect chains
  // (including an instagram.com redirect-cycle step); blocking those
  // wedges sign-in on a page that never finishes loading, which a
  // headless verification run caught on 2026-10-15. Link clicks and
  // script-driven navigations still go through will-navigate here.
  const guardNavigation = (event, url) => {
    if (!isInternal(url) && !url.startsWith('about:')) {
      event.preventDefault();
      openExternalSafe(url);
    }
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) return { action: 'allow' };
    openExternalSafe(url);
    return { action: 'deny' };
  });
  // Child windows (auth consent screens, payment popups, connector
  // OAuth) get the same treatment as the main window: navigation
  // guard, context menu, no unguarded popups of their own.
  mainWindow.webContents.on('did-create-window', (childWindow) => {
    installContextMenu(childWindow);
    wireFindResults(childWindow);
    childWindow.webContents.on('will-navigate', guardNavigation);
    childWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isInternal(url)) return { action: 'allow' };
      openExternalSafe(url);
      return { action: 'deny' };
    });
    childWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  });
  // No embedded webviews, ever.
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  // Downloads: ask where to save, then reveal the file (WKWebView
  // download delegate equivalent). The dialog is async: the item is
  // paused while it is open so the app does not freeze.
  //
  // Registered ONCE per session, not per window: the session is a
  // singleton, so wiring this inside createWindow stacked a new
  // handler (and a second save dialog) on every window recreation.
  if (!downloadsWired) {
    downloadsWired = true;
    mainWindow.webContents.session.on('will-download', (_event, item) => {
      item.pause();
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const options = {
        defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
      };
      const ask = parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
      ask
        .then(({ canceled, filePath }) => {
          if (canceled || !filePath) {
            item.cancel();
            return;
          }
          item.setSavePath(filePath);
          item.once('done', (_e, state) => {
            if (state === 'completed') shell.showItemInFolder(filePath);
          });
          item.resume();
        })
        .catch(() => item.cancel());
    });
  }

  // Offline handling: a network failure on the main frame swaps in
  // a small local page with a retry button (and auto-retry when the
  // connection comes back), instead of Chromium's raw error page.
  const wc = mainWindow.webContents;
  wc.on('did-finish-load', () => {
    const url = wc.getURL();
    if (url.startsWith('https://')) {
      showingOffline = false;
      onOfflinePage = false;
      lastGoodURL = url;
    } else if (url.includes('offline.html')) {
      // The offline page is fully up; a failed Retry from here must
      // be allowed to bring it back (see did-fail-load).
      showingOffline = false;
      onOfflinePage = true;
    }
  });
  wc.on('did-fail-load', (_e, errorCode, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 /* aborted */) return;
    if (!validatedURL.startsWith('http')) return;
    if (showingOffline && !onOfflinePage) return; // offline load already in flight
    showingOffline = true;
    onOfflinePage = false;
    wc.loadFile(path.join(__dirname, 'offline.html'), {
      query: { retry: lastGoodURL },
    }).catch(() => {
      showingOffline = false;
    });
  });

  // Crash recovery: a renderer/GPU crash must not leave a dead
  // white window in the tray forever. Reload automatically; if it
  // keeps dying, stop looping and ask the user.
  let crashTimes = [];
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || wc.isDestroyed()) return;
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < 60000);
    crashTimes.push(now);
    if (crashTimes.length >= 3) {
      showDialog({
        type: 'error',
        message: 'Muse keeps crashing.',
        detail: 'The page renderer died several times in a row. Reload once more, or quit and restart the app.',
        buttons: ['Reload', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) {
          crashTimes = [];
          if (!wc.isDestroyed()) wc.reload();
        } else {
          app.quit();
        }
      });
      return;
    }
    wc.reload();
  });
  let unresponsivePromptOpen = false;
  wc.on('unresponsive', () => {
    if (unresponsivePromptOpen || wc.isDestroyed()) return;
    unresponsivePromptOpen = true;
    showDialog({
      type: 'warning',
      message: 'Muse is not responding.',
      buttons: ['Keep waiting', 'Reload page'],
      defaultId: 0,
      cancelId: 0,
    }).then(({ response }) => {
      unresponsivePromptOpen = false;
      if (response === 1 && !wc.isDestroyed()) wc.reload();
    });
  });
  wc.on('responsive', () => {
    unresponsivePromptOpen = false;
  });

  let saveTimer = null;
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 400);
  };
  mainWindow.on('resize', queueSave);
  mainWindow.on('move', queueSave);
  mainWindow.on('close', (event) => {
    saveWindowState();
    // Close-to-tray: hiding instead of closing keeps the page (and
    // the conversation you had open) exactly where you left it.
    if (!isQuitting && settings.closeToTray && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Test hook: MUSE_LINUX_SCREENSHOT=/path.png captures the loaded
  // page a few seconds after load and quits. Used to verify builds
  // headlessly. Dev runs only: a packaged build ignores it, so a
  // stray environment variable can never affect real users.
  if (process.env.MUSE_LINUX_SCREENSHOT && !app.isPackaged) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(process.env.MUSE_LINUX_SCREENSHOT, image.toPNG());
          console.log('SCREENSHOT_SAVED', process.env.MUSE_LINUX_SCREENSHOT);
        } catch (err) {
          console.error('SCREENSHOT_FAILED', err);
        }
        app.quit();
      }, 6000);
    });
  }

  mainWindow.loadURL(HOME_URL);
  return mainWindow;
}

// ---------------------------------------------------------------------
// Auto-update: electron-updater against GitHub Releases. Only active
// in electron-builder builds (they carry an app-update.yml); the
// packager zip and dev runs fall back to opening the Releases page.
// ---------------------------------------------------------------------
let autoUpdaterRef = null;
let manualUpdateCheck = false;
let updateAvailableVersion = null;
// Dialogs must not be parented to a hidden/destroyed window (the
// window may be parked in the tray when an update check lands).
function showDialog(options) {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}
function checkForUpdates(manual) {
  const updateConfig = path.join(process.resourcesPath || '', 'app-update.yml');
  if (!app.isPackaged || !fs.existsSync(updateConfig)) {
    if (manual) shell.openExternal(RELEASES_URL);
    return;
  }
  try {
    if (!autoUpdaterRef) {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = false;
      autoUpdater.on('update-available', (info) => {
        // Keep the offer visible in the menu even if the user
        // dismisses this prompt (it used to vanish until restart).
        updateAvailableVersion = info.version;
        buildMenu();
        showDialog({
            type: 'info',
            message: `Muse for Linux ${info.version} is available.`,
            detail: 'Download it now? The app restarts to install.',
            buttons: ['Download', 'Later'],
            defaultId: 0,
            cancelId: 1,
          })
          .then(({ response }) => {
            if (response === 0) autoUpdater.downloadUpdate();
          });
      });
      autoUpdater.on('update-not-available', () => {
        if (updateAvailableVersion) {
          updateAvailableVersion = null;
          buildMenu();
        }
        if (manualUpdateCheck) {
          showDialog({
            type: 'info',
            message: 'You are up to date.',
          });
        }
        manualUpdateCheck = false;
      });
      autoUpdater.on('update-downloaded', () => {
        showDialog({
            type: 'info',
            message: 'Update downloaded.',
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            cancelId: 1,
          })
          .then(({ response }) => {
            if (response === 0) autoUpdater.quitAndInstall();
          });
      });
      autoUpdater.on('error', () => {
        if (manualUpdateCheck) shell.openExternal(RELEASES_URL);
        manualUpdateCheck = false;
      });
      autoUpdaterRef = autoUpdater;
    }
    manualUpdateCheck = manual;
    autoUpdaterRef.checkForUpdates().catch(() => {
      if (manual) shell.openExternal(RELEASES_URL);
      manualUpdateCheck = false;
    });
  } catch {
    if (manual) shell.openExternal(RELEASES_URL);
    manualUpdateCheck = false;
  }
}

function buildMenu() {
  const template = [
    {
      label: 'Muse',
      submenu: [
        { role: 'about' },
        {
          label: updateAvailableVersion
            ? `Download Update (${updateAvailableVersion})...`
            : 'Check for Updates...',
          click: () => {
            if (updateAvailableVersion && autoUpdaterRef) {
              Promise.resolve(autoUpdaterRef.downloadUpdate()).catch(() => checkForUpdates(true));
            } else {
              checkForUpdates(true);
            }
          },
        },
        {
          label: 'Keep in system tray when closed',
          type: 'checkbox',
          checked: settings.closeToTray,
          click: (menuItem) => {
            settings.closeToTray = menuItem.checked;
            saveSettings();
          },
        },
        { type: 'separator' },
        {
          label: 'Back to Muse home',
          accelerator: 'Alt+Home',
          click: () => mainWindow && mainWindow.loadURL(HOME_URL),
        },
        { type: 'separator' },
        { role: 'close', label: 'Close Window', accelerator: 'Ctrl+W' },
        { role: 'quit', accelerator: 'Ctrl+Q' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Find in Page...',
          accelerator: 'Ctrl+F',
          click: () => mainWindow && showFindBar(mainWindow),
        },
        {
          label: 'Print...',
          accelerator: 'Ctrl+P',
          click: () => mainWindow && mainWindow.webContents.print(),
        },
        {
          label: 'Save as PDF...',
          click: async () => {
            if (!mainWindow) return;
            try {
              const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
                defaultPath: 'muse.pdf',
                filters: [{ name: 'PDF', extensions: ['pdf'] }],
              });
              if (canceled || !filePath) return;
              const data = await mainWindow.webContents.printToPDF({});
              fs.writeFileSync(filePath, data);
              shell.showItemInFolder(filePath);
            } catch {
              /* user cancelled a dialog or the page went away */
            }
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Navigation',
      submenu: [
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: () => mainWindow && mainWindow.webContents.navigationHistory.goBack(),
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: () => mainWindow && mainWindow.webContents.navigationHistory.goForward(),
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTray() {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, 'icon.png'))
    .resize({ width: 22, height: 22 });
  try {
    tray = new Tray(icon);
  } catch (err) {
    // Desktops without a working tray/status area: carry on without
    // one. window-all-closed already quits the app when tray is null.
    console.error('Tray unavailable, continuing without it:', err.message);
    tray = null;
    return;
  }
  tray.setToolTip('Muse');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show Muse',
        click: () => {
          if (!mainWindow) createWindow();
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => {
    if (!mainWindow) return createWindow();
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

// Deep links: the Mac app registers hatch:// and endo-window://.
// Register the same schemes here so links keep working on Linux.
//
// Linux caveat (fixed in 1.0.1): Electron implements this by shelling
// out to xdg-mime once per scheme. With no .desktop entry installed
// for the app, xdg-mime fails noisily on every launch
// ("qtpaths: command not found" / "application argument missing",
// one block per scheme) and registers nothing anyway. So on Linux
// we only attempt it when a desktop entry exists; install.sh
// registers the schemes properly via xdg-mime when it installs one.
function hasDesktopEntry() {
  const dirs = [];
  if (process.env.XDG_DATA_HOME) dirs.push(process.env.XDG_DATA_HOME);
  if (process.env.HOME) dirs.push(path.join(process.env.HOME, '.local', 'share'));
  if (process.env.XDG_DATA_DIRS) dirs.push(...process.env.XDG_DATA_DIRS.split(':').filter(Boolean));
  dirs.push('/usr/local/share', '/usr/share');
  return dirs.some((d) =>
    ['muse.desktop', 'Muse.desktop', 'muse-linux.desktop'].some((f) =>
      fs.existsSync(path.join(d, 'applications', f)),
    ),
  );
}
if (process.platform !== 'linux' || hasDesktopEntry()) {
  for (const scheme of ['hatch', 'endo-window', 'muse']) {
    try {
      app.setAsDefaultProtocolClient(scheme);
    } catch {
      /* best effort */
    }
  }
}

function findDeepLink(argv) {
  return argv.find((a) => /^(hatch|endo-window|muse):\/\//.test(a));
}

function handleDeepLink(url) {
  // hatch:// and friends are just doors into the web app; anything
  // with a muse.ai path is honoured, the rest lands on home.
  try {
    const parsed = new URL(url);
    const target = parsed.searchParams.get('url');
    if (target && isInternal(target)) {
      if (!mainWindow) createWindow();
      mainWindow.loadURL(target);
      return;
    }
  } catch {
    /* fall through */
  }
  if (!mainWindow) createWindow();
  mainWindow.loadURL(HOME_URL);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = findDeepLink(argv);
    if (link) handleDeepLink(link);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAboutPanelOptions({
      applicationName: 'Muse for Linux',
      applicationVersion: app.getVersion(),
      version: '',
      credits:
        'Unofficial Linux port by nordicnode. Not affiliated with Meta. ' +
        'Muse is a product of Meta; this app is a shell for muse.ai.',
      iconPath: path.join(__dirname, 'icon.png'),
    });

    // Permissions: mic/camera/geolocation/notifications only for
    // Muse/Meta origins (the Mac app's usage-description prompts,
    // translated). Everything else is denied by default. The check
    // uses the REQUESTING origin, not the top page URL, so a
    // third-party iframe embedded in a Muse page cannot inherit
    // Muse's grant.
    const museSession = session.fromPartition('persist:muse');
    const allowedPermissions = ['media', 'geolocation', 'notifications', 'clipboard-sanitized-write'];
    const permissionOk = (webContents, permission, requestingUrl) => {
      let originOk = false;
      const target = requestingUrl || (webContents ? webContents.getURL() : '');
      try {
        originOk = isInternal(target);
      } catch {
        originOk = false;
      }
      return originOk && allowedPermissions.includes(permission);
    };
    museSession.setPermissionRequestHandler((wc, permission, callback, details) =>
      callback(permissionOk(wc, permission, details && details.requestingUrl)),
    );
    museSession.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
      permissionOk(wc, permission, requestingOrigin),
    );

    buildMenu();
    createWindow();
    buildTray();
    // Cold-start deep link: when the app was launched BY a link
    // (desktop file %U), the URL arrives in our own argv. Nothing
    // else delivers it on Linux (open-url is macOS-only, and
    // second-instance only fires when already running) - before
    // 1.3.0 it was silently dropped.
    const coldLink = findDeepLink(process.argv);
    if (coldLink) handleDeepLink(coldLink);
    // Quiet background update check (packaged builds only).
    setTimeout(() => checkForUpdates(false), 8000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.on('window-all-closed', () => {
    // With close-to-tray on, the window hides instead of closing, so
    // this rarely fires. With it off, closing the last window quits.
    // If there is no tray (unsupported desktop), quit normally.
    if (!tray || !settings.closeToTray) app.quit();
  });
}
