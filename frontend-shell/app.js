let deferredInstallPrompt = null;

async function updateSessionStatus() {
  const title = document.getElementById('session-title');
  const text = document.getElementById('session-text');

  try {
    const response = await fetch('/project', {
      credentials: 'include',
      redirect: 'follow',
      headers: {
        'X-Requested-With': 'frontend-shell',
      },
    });

    if (response.redirected && response.url.includes('/login')) {
      title.textContent = 'Not signed in';
      text.textContent = 'Open the standard Overleaf login page. After login, this app will keep using the same domain session.';
      return;
    }

    if (response.ok) {
      title.textContent = 'Signed in';
      text.textContent = 'Your Overleaf session is active on this domain. Open projects directly or install this shell on Android or desktop.';
      return;
    }

    title.textContent = 'Session unknown';
    text.textContent = 'The domain responded, but the login state could not be confirmed from the frontend shell.';
  } catch (error) {
    title.textContent = 'Connection issue';
    text.textContent = 'The frontend shell could not reach the Overleaf domain. Check the reverse proxy and network path.';
  }
}

function setupInstallPrompt() {
  const installButton = document.getElementById('install-button');
  if (!installButton) {
    return;
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.hidden = false;
  });

  installButton.addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      return;
    }

    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installButton.hidden = true;
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (error) {
    console.error('service worker registration failed', error);
  }
}

setupInstallPrompt();
updateSessionStatus();
registerServiceWorker();
