const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  safeStorage,
  session,
  shell,
} = require('electron');
const fs = require('fs');
const path = require('path');

const APP_URL = 'https://evo-leaf.com/';
const AUTH_FILE = 'gateway-auth.json';
const WINDOW_PARTITION = 'persist:evoleaf';

let mainWindow = null;
let activeAuthPrompt = null;
let lastAuthAttemptSource = null;
let persistentSession = null;

function getAuthFilePath() {
  return path.join(app.getPath('userData'), AUTH_FILE);
}

function encodeSecret(secret) {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      mode: 'safeStorage',
      value: safeStorage.encryptString(secret).toString('base64'),
    };
  }

  return {
    mode: 'plain',
    value: secret,
  };
}

function decodeSecret(encoded) {
  if (!encoded || !encoded.value) {
    return '';
  }

  if (encoded.mode === 'safeStorage' && safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(encoded.value, 'base64'));
  }

  return encoded.value;
}

function loadSavedGatewayCredentials() {
  try {
    const raw = fs.readFileSync(getAuthFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.username || !parsed.password) {
      return null;
    }

    return {
      username: parsed.username,
      password: decodeSecret(parsed.password),
    };
  } catch (_error) {
    return null;
  }
}

function saveGatewayCredentials(credentials) {
  const payload = {
    username: credentials.username,
    password: encodeSecret(credentials.password),
  };

  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(getAuthFilePath(), JSON.stringify(payload, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function clearGatewayCredentials() {
  try {
    fs.unlinkSync(getAuthFilePath());
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function clearGatewayAuthCache() {
  if (persistentSession && typeof persistentSession.clearAuthCache === 'function') {
    await persistentSession.clearAuthCache();
  }
}

function resetAuthAttemptState() {
  lastAuthAttemptSource = null;
}

function buildMenu() {
  const template = [
    {
      label: 'Account',
      submenu: [
        {
          label: 'Open EvoLeaf',
          click: () => {
            if (mainWindow) {
              mainWindow.loadURL(APP_URL);
            }
          },
        },
        {
          label: 'Log Out of EvoLeaf',
          click: () => {
            if (mainWindow) {
              mainWindow.loadURL(new URL('/logout', APP_URL).toString());
            }
          },
        },
        {
          label: 'Forget Saved Nginx Gateway Credentials',
          click: async () => {
            clearGatewayCredentials();
            resetAuthAttemptState();
            await clearGatewayAuthCache();
            if (mainWindow) {
              mainWindow.loadURL(APP_URL);
            }
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#f4efe5',
    autoHideMenuBar: false,
    title: 'EvoLeaf',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: WINDOW_PARTITION,
    },
  });

  mainWindow.loadURL(APP_URL);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && mainWindow.webContents.getURL().startsWith(APP_URL)) {
      resetAuthAttemptState();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function promptState() {
  const saved = loadSavedGatewayCredentials();
  return {
    username: saved ? saved.username : '',
    message:
      lastAuthAttemptSource === 'stored' || lastAuthAttemptSource === 'prompt'
        ? 'Saved gateway credentials were rejected. Enter the correct Nginx username and password.'
        : 'Enter the Nginx gateway username and password for evo-leaf.com. The app saves them for this local user.',
  };
}

function promptForGatewayCredentials(parentWindow) {
  if (activeAuthPrompt) {
    return activeAuthPrompt.promise;
  }

  const authWindow = new BrowserWindow({
    width: 420,
    height: 360,
    title: 'EvoLeaf Gateway Login',
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: Boolean(parentWindow),
    parent: parentWindow || null,
    autoHideMenuBar: true,
    backgroundColor: '#f4efe5',
    webPreferences: {
      preload: path.join(__dirname, 'auth-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  activeAuthPrompt = {};
  activeAuthPrompt.promise = new Promise((resolve, reject) => {
    const handleSubmit = (event, payload) => {
      if (event.sender !== authWindow.webContents) {
        return;
      }

      cleanup();
      resolve({
        username: String(payload.username || '').trim(),
        password: String(payload.password || ''),
      });
    };

    const handleCancel = event => {
      if (event.sender !== authWindow.webContents) {
        return;
      }

      cleanup();
      reject(new Error('Gateway login cancelled'));
    };

    const handleClosed = () => {
      cleanup(false);
      reject(new Error('Gateway login cancelled'));
    };

    function cleanup(closeWindow = true) {
      ipcMain.removeListener('auth:submit', handleSubmit);
      ipcMain.removeListener('auth:cancel', handleCancel);
      authWindow.removeListener('closed', handleClosed);
      if (closeWindow && !authWindow.isDestroyed()) {
        authWindow.close();
      }
      activeAuthPrompt = null;
    }

    ipcMain.on('auth:submit', handleSubmit);
    ipcMain.on('auth:cancel', handleCancel);
    authWindow.on('closed', handleClosed);
  });

  ipcMain.handleOnce('auth:get-prompt-state', () => promptState());
  authWindow.loadFile(path.join(__dirname, 'auth', 'index.html'));

  return activeAuthPrompt.promise;
}

async function resolveGatewayCredentials(parentWindow) {
  const saved = loadSavedGatewayCredentials();

  if (saved && lastAuthAttemptSource !== 'stored') {
    lastAuthAttemptSource = 'stored';
    return saved;
  }

  const entered = await promptForGatewayCredentials(parentWindow);
  saveGatewayCredentials(entered);
  lastAuthAttemptSource = 'prompt';
  return entered;
}

function wireGatewayAuthHandler() {
  app.on('login', async (event, webContents, _request, authInfo, callback) => {
    if (authInfo.scheme !== 'basic') {
      return;
    }

    event.preventDefault();

    try {
      const creds = await resolveGatewayCredentials(
        BrowserWindow.fromWebContents(webContents) || mainWindow
      );
      callback(creds.username, creds.password);
    } catch (_error) {
      callback();
    }
  });
}

app.whenReady().then(() => {
  persistentSession = session.fromPartition(WINDOW_PARTITION);
  persistentSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  buildMenu();
  wireGatewayAuthHandler();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
