const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let win;
let origin;
const dataDir = process.env.WBLOOP_HOME || path.join(os.homedir(), '.wbloop');
const program = app.isPackaged ? path.join(process.resourcesPath, 'program') : path.resolve(__dirname, '../..');
const node = app.isPackaged ? path.join(process.resourcesPath, 'runtime/node.exe') : process.env.WBLOOP_NODE || 'node.exe';

async function startService() {
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  const log = fs.openSync(path.join(dataDir, 'logs/app-server.log'), 'a');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // A real bundled Node keeps runners and scheduled tasks independent of the GUI.
  env.PATH = `${path.dirname(node)};${env.PATH || env.Path || ''}`;
  delete env.Path;
  const child = spawn(node, [path.join(program, 'bin/wbloop.js'), 'serve', '--json-ready'], {
    cwd: dataDir, env, windowsHide: true, detached: true, stdio: ['ignore', 'pipe', log],
  });
  fs.closeSync(log);
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.stdout.destroy(); child.unref(); reject(new Error('The local service did not start within 30 seconds. See ~/.wbloop/logs/app-server.log.')); }, 30000);
    const fail = (error) => { clearTimeout(timer); reject(error); };
    child.once('error', fail);
    child.once('exit', (code) => { if (!origin) fail(new Error(`Local service exited (${code}). See ~/.wbloop/logs/app-server.log.`)); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      for (const line of output.split('\n')) {
        try {
          const msg = JSON.parse(line);
          if (msg.ready && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(msg.url)) {
            origin = new URL(msg.url).origin;
            clearTimeout(timer);
            child.stdout.destroy();
            child.unref();
            resolve(msg.url);
            return;
          }
        } catch { /* wait for readiness */ }
      }
    });
  });
}

function trusted(event) {
  return event.sender === win?.webContents && event.senderFrame === win.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    app.setAppUserModelId('local.oneiropolos.app');
    const url = await startService();
    win = new BrowserWindow({ width: 1240, height: 840, minWidth: 850, minHeight: 600, title: 'Oneiropolos', backgroundColor: '#171717', icon: path.join(program, 'public/logo.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'File', submenu: [{ label: 'New task', accelerator: 'Ctrl+N', click: () => command('new') }, { label: 'Settings', accelerator: 'Ctrl+,', click: () => command('settings') }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ label: 'Command palette', accelerator: 'Ctrl+K', click: () => command('palette') }, { role: 'reload' }, { role: 'togglefullscreen' }, { label: 'Open data folder', click: () => shell.openPath(dataDir) }, { role: 'toggleDevTools' }] },
      { label: 'Help', submenu: [{ label: 'Help', accelerator: 'Ctrl+/', click: () => command('help') }] },
    ]));
    win.webContents.setWindowOpenHandler(({ url: target }) => { if (/^https?:\/\//i.test(target)) shell.openExternal(target); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== origin) { event.preventDefault(); if (/^https?:\/\//i.test(target)) shell.openExternal(target); } });
    ipcMain.handle('oneiropolos:folder', async (event, start) => {
      if (!trusted(event)) throw new Error('Untrusted window');
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: typeof start === 'string' && fs.existsSync(start) ? start : os.homedir() });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.on('oneiropolos:theme', (event, value) => { if (trusted(event) && ['light', 'dark', 'system'].includes(value)) nativeTheme.themeSource = value; });
    ipcMain.on('oneiropolos:language', (event, value) => { if (trusted(event)) win.setTitle(value === 'zh' ? '守梦人' : value === 'ja' ? '夢守' : 'Oneiropolos'); });
    await win.loadURL(url);
    win.show();
    if (process.env.WBLOOP_SMOKE_TEST) {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const token = document.querySelector('meta[name="wbloop-token"]').content;
        const r = await fetch('/api/env', { headers: { 'x-wbloop-token': token } });
        const env = await r.json();
        return { title: document.title, native: !!window.oneiropolos, node: env.node, home: env.home, body: document.body.innerText.slice(0, 500) };
      })()`);
      fs.writeFileSync(process.env.WBLOOP_SMOKE_TEST, JSON.stringify(result, null, 2));
      app.quit();
    }
  }).catch((error) => { dialog.showErrorBox('Oneiropolos', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}

function command(name) { win?.webContents.executeJavaScript(`window.__wbloopApp?.command(${JSON.stringify(name)})`); }
