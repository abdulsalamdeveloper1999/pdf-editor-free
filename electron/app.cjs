// Shared between the real app and the smoke test, so the test exercises the
// same protocol handler and window setup the app ships with.
const { BrowserWindow, protocol, net, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const START = 'app://local/index.html';

// The renderer is the ordinary Vite build. It is served over a custom app://
// scheme rather than file://, because ES modules are blocked on file:// origins.
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

function serve(request) {
  const { pathname } = new URL(request.url);
  const file = path.join(DIST, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
  // never serve outside the bundled build
  if (file !== DIST && !file.startsWith(DIST + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }
  return net.fetch(pathToFileURL(file).toString());
}

function createWindow({ show = true } = {}) {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show,
    backgroundColor: '#f3f4f6',
    title: 'PDF Editor Free',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // the page has no outbound links; if one is ever added, send it to the browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(START);
  return win;
}

module.exports = { registerScheme, serve, createWindow, DIST, START };
