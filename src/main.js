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

const { app, BrowserWindow, Menu, Tray, shell, session, dialog, nativeImage, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

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
]);

function isInternal(url) {
  try {
    return INTERNAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

let mainWindow = null;
let tray = null;

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
    const bounds = mainWindow.getBounds();
    fs.writeFileSync(
      windowStatePath(),
      JSON.stringify({ ...bounds, isMaximized: mainWindow.isMaximized() }),
    );
  } catch {
    /* best effort */
  }
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
          click: () => shell.openExternal(params.linkURL),
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
      {
        label: 'Inspect Element',
        click: () => {
          win.webContents.inspectElement(params.x, params.y);
          if (win.webContents.isDevToolsOpened()) win.webContents.focus();
        },
      },
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
  const state = loadWindowState();
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

  mainWindow.webContents.on('found-in-page', (_e, result) => {
    mainWindow.webContents.send('find:result', {
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    });
  });

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
      shell.openExternal(url);
    }
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // No embedded webviews, ever.
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  // Downloads: ask where to save, then reveal the file (WKWebView
  // download delegate equivalent).
  mainWindow.webContents.session.on('will-download', (event, item) => {
    const savePath = dialog.showSaveDialogSync(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
    });
    if (!savePath) {
      item.cancel();
      return;
    }
    item.setSavePath(savePath);
    item.once('done', (_e, state) => {
      if (state === 'completed') shell.showItemInFolder(savePath);
    });
  });

  let saveTimer = null;
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 400);
  };
  mainWindow.on('resize', queueSave);
  mainWindow.on('move', queueSave);
  mainWindow.on('close', saveWindowState);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Test hook: MUSE_LINUX_SCREENSHOT=/path.png captures the loaded
  // page a few seconds after load and quits. Used to verify builds
  // headlessly; harmless in normal use.
  if (process.env.MUSE_LINUX_SCREENSHOT) {
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

function buildMenu() {
  const template = [
    {
      label: 'Muse',
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates...',
          click: () => shell.openExternal(RELEASES_URL),
        },
        { type: 'separator' },
        {
          label: 'Back to Muse home',
          accelerator: 'Alt+Home',
          click: () => mainWindow && mainWindow.loadURL(HOME_URL),
        },
        { type: 'separator' },
        { role: 'quit' },
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
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
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
  tray = new Tray(icon);
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
for (const scheme of ['hatch', 'endo-window', 'muse']) {
  try {
    app.setAsDefaultProtocolClient(scheme);
  } catch {
    /* best effort */
  }
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
    const link = argv.find((a) => /^(hatch|endo-window|muse):\/\//.test(a));
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
    // translated). Everything else is denied by default.
    const museSession = session.fromPartition('persist:muse');
    const allowedPermissions = ['media', 'geolocation', 'notifications', 'clipboard-sanitized-write'];
    const permissionOk = (webContents, permission) => {
      let originOk = false;
      try {
        originOk = isInternal(webContents.getURL());
      } catch {
        originOk = false;
      }
      return originOk && allowedPermissions.includes(permission);
    };
    museSession.setPermissionRequestHandler((wc, permission, callback) => callback(permissionOk(wc, permission)));
    museSession.setPermissionCheckHandler((wc, permission) => (wc ? permissionOk(wc, permission) : false));

    buildMenu();
    createWindow();
    buildTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.on('window-all-closed', () => {
    // Keep the tray alive like a desktop app; Quit is explicit.
    // If there is no tray (unsupported desktop), quit normally.
    if (!tray) app.quit();
  });
}
