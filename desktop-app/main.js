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

  const state = promptState();
  const authWindow = new BrowserWindow({
    width: 420,
    height: 390,
    title: 'EvoLeaf Gateway Login',
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: false,
    parent: null,
    show: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: '#f4efe5',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
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

  const inlineHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EvoLeaf Gateway Login</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe5;
      --panel: #fffaf0;
      --ink: #122033;
      --muted: #4f5d73;
      --primary: #0f766e;
      --secondary: #334155;
      --border: rgba(18, 32, 51, 0.12);
      font-family: "Segoe UI", "Helvetica Neue", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top left, rgba(217, 119, 6, 0.18), transparent 18rem),
        linear-gradient(180deg, #fbf7ef 0%, var(--bg) 100%);
      color: var(--ink);
    }
    .panel {
      width: min(24rem, calc(100% - 2rem));
      padding: 1.4rem;
      border: 1px solid var(--border);
      border-radius: 1.2rem;
      background: var(--panel);
      box-shadow: 0 24px 50px rgba(18, 32, 51, 0.16);
    }
    .eyebrow {
      margin: 0 0 0.4rem;
      color: #d97706;
      text-transform: uppercase;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.12em;
    }
    h1 { margin: 0 0 0.6rem; font-size: 1.8rem; }
    .message { margin: 0 0 1rem; color: var(--muted); line-height: 1.45; }
    .field { display: block; margin-bottom: 0.9rem; }
    .field span { display: block; margin-bottom: 0.35rem; font-weight: 600; }
    .field input {
      width: 100%;
      min-height: 2.8rem;
      padding: 0.75rem 0.85rem;
      border: 1px solid var(--border);
      border-radius: 0.8rem;
      font: inherit;
      color: var(--ink);
      background: #fff;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.7rem;
      margin-top: 1.1rem;
    }
    .button {
      min-height: 2.8rem;
      padding: 0.75rem 1rem;
      border: 0;
      border-radius: 999px;
      color: #fff;
      cursor: pointer;
      font: inherit;
    }
    .button-primary { background: var(--primary); }
    .button-secondary { background: var(--secondary); }
  </style>
</head>
<body>
  <main class="panel">
    <p class="eyebrow">Nginx gateway</p>
    <h1>Sign in to EvoLeaf</h1>
    <p class="message">${state.message.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>
    <form id="login-form">
      <label class="field">
        <span>Username</span>
        <input id="username" name="username" type="text" autocomplete="username" required value="${state.username.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">
      </label>
      <label class="field">
        <span>Password</span>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
      </label>
      <div class="actions">
        <button class="button button-secondary" type="button" id="cancel-button">Cancel</button>
        <button class="button button-primary" type="submit">Continue</button>
      </div>
    </form>
  </main>
  <script>
    const { ipcRenderer } = require('electron');
    const form = document.getElementById('login-form');
    const username = document.getElementById('username');
    const password = document.getElementById('password');
    const cancelButton = document.getElementById('cancel-button');

    form.addEventListener('submit', event => {
      event.preventDefault();
      ipcRenderer.send('auth:submit', {
        username: username.value,
        password: password.value
      });
    });

    cancelButton.addEventListener('click', () => {
      ipcRenderer.send('auth:cancel');
    });

    if (username.value) {
      password.focus();
    } else {
      username.focus();
    }
  </script>
</body>
</html>`;

  authWindow.once('ready-to-show', () => {
    authWindow.show();
    authWindow.focus();
  });

  authWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(inlineHtml)}`);

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
