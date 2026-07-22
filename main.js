const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const url = require('url');

let mainWindow;
let torrserverProcess = null;
const PORT_TORRSERVER = 8090;
const PORT_LAMPA = 8300;

// ── Lampa directory ────────────────────────────────────────────────────────────
function getLampaDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'lampa')
    : path.join(__dirname, 'lampa');
}

// ── TorrServer binary path ─────────────────────────────────────────────────────
function getTorrServerBinPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'TorrServer-linux-amd64')
    : path.join(__dirname, 'bin', 'TorrServer-linux-amd64');
}

// ── Strip AppImage env vars that break child processes ─────────────────────────
function getCleanEnv() {
  const env = { ...process.env };
  if (env.LD_LIBRARY_PATH_ORIG !== undefined) {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH_ORIG;
    delete env.LD_LIBRARY_PATH_ORIG;
  } else {
    delete env.LD_LIBRARY_PATH;
  }
  if (env.LD_PRELOAD_ORIG !== undefined) {
    env.LD_PRELOAD = env.LD_PRELOAD_ORIG;
    delete env.LD_PRELOAD_ORIG;
  } else {
    delete env.LD_PRELOAD;
  }
  delete env.APPDIR;
  delete env.APPIMAGE;
  delete env.GST_PLUGIN_PATH;
  delete env.GST_PLUGIN_SYSTEM_PATH;
  return env;
}

// ── TorrServer lifecycle ───────────────────────────────────────────────────────
function startTorrServer() {
  const binPath = getTorrServerBinPath();

  if (!fs.existsSync(binPath)) {
    console.error('[TorrServer] Binary not found at:', binPath);
    return;
  }

  try {
    fs.chmodSync(binPath, 0o755);
  } catch (e) {
    console.warn('[TorrServer] chmod failed (read-only FS?):', e.message);
  }

  const dbPath = path.join(app.getPath('userData'), 'torrserver');
  fs.mkdirSync(dbPath, { recursive: true });

  console.log('[TorrServer] Starting at', binPath, 'on port', PORT_TORRSERVER);

  torrserverProcess = spawn(binPath, ['-p', String(PORT_TORRSERVER), '-d', dbPath], {
    detached: false,
    stdio: 'ignore',
    env: getCleanEnv()
  });

  torrserverProcess.on('error', (err) => {
    console.error('[TorrServer] spawn error:', err.message);
  });

  torrserverProcess.on('exit', (code) => {
    console.log('[TorrServer] exited with code', code);
    torrserverProcess = null;
  });

  setTimeout(optimizeTorrServerSettings, 5000);
}

function stopTorrServer() {
  if (torrserverProcess) {
    console.log('[TorrServer] Stopping...');
    torrserverProcess.kill();
    torrserverProcess = null;
  }
}

function optimizeTorrServerSettings() {
  const payload = JSON.stringify({
    action: 'set',
    sets: {
      CacheSize: 268435456,
      ReaderReadAHead: 95,
      PreloadCache: 25,
      UseDisk: false,
      ConnectionsLimit: 150,
      TorrentDisconnectTimeout: 90,
      ForceEncrypt: false,
      EnableIPv6: false
    }
  });

  const req = http.request({
    hostname: '127.0.0.1',
    port: PORT_TORRSERVER,
    path: '/settings',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  }, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => console.log('[TorrServer] Settings optimized:', data));
  });
  req.on('error', (err) => console.warn('[TorrServer] Settings optimization failed:', err.message));
  req.write(payload);
  req.end();
}

// ── Lampa HTTP server with built-in VP8/Opus transcoder ───────────────────────
function startLampaHttpServer() {
  const lampaDir = getLampaDir();
  if (!fs.existsSync(lampaDir)) {
    console.error('[HTTP] Lampa directory not found at:', lampaDir);
    return;
  }

  const settingsDir = path.join(app.getPath('userData'));
  const lastUrlPath = path.join(settingsDir, 'last_url.txt');

  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const query = parsed.query;

    // ── /stream.webm?url=...&start=... ─────────────────────────────────────
    if (pathname === '/stream.webm') {
      const videoUrl = query.url || '';
      const startTime = query.start || '0';

      if (!videoUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing url parameter');
        return;
      }

      // Normalize TorrServer URL
      let normalizedUrl = videoUrl;
      if (normalizedUrl.includes('127.0.0.1:8090') || normalizedUrl.includes('localhost:8090')) {
        normalizedUrl = normalizedUrl.replace(/&preload/g, '').replace(/&play/g, '') + '&play';
      }

      console.log(`[Transcoder] Starting VP8/Opus transcode: ${normalizedUrl.slice(0, 80)} from ${startTime}s`);

      // Find ffmpeg
      const ffmpegBin = findBinary('ffmpeg') || '/usr/bin/ffmpeg';

      const cmd = [ffmpegBin];
      if (startTime && startTime !== '0') {
        cmd.push('-ss', startTime);
      }
      cmd.push(
        '-i', normalizedUrl,
        '-c:v', 'libvpx',
        '-b:v', '4000k',
        '-deadline', 'realtime',
        '-cpu-used', '8',
        '-threads', '6',
        '-speed', '8',
        '-c:a', 'libopus',
        '-b:a', '128k',
        '-ac', '2',
        '-f', 'webm',
        '-y',
        'pipe:1'
      );

      res.writeHead(200, { 'Content-Type': 'video/webm' });

      let proc;
      try {
        proc = spawn(cmd[0], cmd.slice(1), {
          stdio: ['ignore', 'pipe', 'ignore'],
          env: getCleanEnv()
        });
      } catch (err) {
        console.error('[Transcoder] Failed to spawn ffmpeg:', err.message);
        res.end();
        return;
      }

      proc.stdout.pipe(res);

      req.on('close', () => {
        console.log('[Transcoder] Client disconnected, killing ffmpeg');
        try { proc.kill(); } catch (e) {}
      });

      proc.on('error', (err) => {
        console.error('[Transcoder] ffmpeg error:', err.message);
        try { res.end(); } catch (e) {}
      });

      proc.on('exit', () => {
        try { res.end(); } catch (e) {}
      });

      return;
    }

    // ── /save_url?url=... ──────────────────────────────────────────────────
    if (pathname === '/save_url') {
      const urlVal = query.url || '';
      if (urlVal && urlVal.includes('127.0.0.1:8300')) {
        try { fs.writeFileSync(lastUrlPath, urlVal, 'utf8'); } catch (e) {}
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    // ── /log_js?msg=... ────────────────────────────────────────────────────
    if (pathname === '/log_js') {
      const msg = query.msg || '';
      if (msg) console.log('[JS]', msg);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    // ── /check_vlc ─────────────────────────────────────────────────────────
    if (pathname === '/check_vlc') {
      const body = JSON.stringify({ found: true, method: 'transcoder', cmd: [], package: 'internal' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    // ── /torrserver_status ─────────────────────────────────────────────────
    if (pathname === '/torrserver_status') {
      const running = torrserverProcess !== null && !torrserverProcess.killed;
      const body = JSON.stringify({ running });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    // ── Static files from lampa directory ─────────────────────────────────
    const filePath = path.join(lampaDir, pathname === '/' ? 'index.html' : pathname);

    // Security: prevent path traversal
    if (!filePath.startsWith(lampaDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (statErr, stat) => {
      if (statErr || stat.isDirectory()) {
        // Try index.html in directory
        const indexPath = path.join(filePath, 'index.html');
        fs.readFile(indexPath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end('Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': getContentType(indexPath) });
            res.end(data);
          }
        });
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': getContentType(filePath) });
          res.end(data);
        }
      });
    });
  });

  server.listen(PORT_LAMPA, '127.0.0.1', () => {
    console.log(`[HTTP] Lampa server started on port ${PORT_LAMPA}, serving: ${lampaDir}`);
  });

  server.on('error', (err) => {
    console.error('[HTTP] Server error:', err.message);
  });

  return server;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function findBinary(name) {
  // Prefer bundled binary (works inside AppImage from resources/bin)
  const bundledPaths = app.isPackaged
    ? [path.join(process.resourcesPath, 'bin', name)]
    : [path.join(__dirname, 'bin', name)];

  const systemPaths = [
    `/usr/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/bin/${name}`
  ];

  for (const p of [...bundledPaths, ...systemPaths]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t'
  };
  return types[ext] || 'application/octet-stream';
}

// ── Electron window ────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    title: 'Lampa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.setMenu(null);

  // Load Lampa from local HTTP server for proper CORS and /stream.webm support
  mainWindow.loadURL(`http://127.0.0.1:${PORT_LAMPA}/index.html`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
let httpServer = null;

app.whenReady().then(() => {
  startTorrServer();
  httpServer = startLampaHttpServer();

  // Brief delay to ensure HTTP server is listening before opening window
  setTimeout(createWindow, 500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopTorrServer();
  if (httpServer) { try { httpServer.close(); } catch (e) {} }
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  stopTorrServer();
  if (httpServer) { try { httpServer.close(); } catch (e) {} }
});

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-torrserver-status', async () => {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT_TORRSERVER, path: '/', method: 'GET', timeout: 1000 },
      () => resolve(true)
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
});

ipcMain.handle('restart-torrserver', () => {
  stopTorrServer();
  setTimeout(startTorrServer, 1000);
  return { success: true };
});
