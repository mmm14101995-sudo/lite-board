const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ملفات الواجهة (نفس مجلد assets بتاع الأندرويد): www/index.html
const WWW = path.join(__dirname, 'www');

// بورت ثابت عشان localStorage وإعدادات المتصفح تفضل محفوظة بين مرات التشغيل
const PREFERRED_PORT = 47321;

// الملفات بتتحفظ في: Documents\BoardPDF\pdfs  و  Documents\BoardPDF\annotations
// (نفس فكرة filesDir/pdfs و filesDir/annotations في الأندرويد)
let PDF_DIR, ANN_DIR;

let server = null;
let serverPort = 0;
let mainWindow = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8'
};

function initPaths() {
  let base;
  try {
    base = path.join(app.getPath('documents'), 'BoardPDF');
    fs.mkdirSync(base, { recursive: true });
  } catch (e) {
    // لو المستندات مش متاحة، نستخدم مجلد بيانات التطبيق
    base = path.join(app.getPath('userData'), 'BoardPDF');
    fs.mkdirSync(base, { recursive: true });
  }
  PDF_DIR = path.join(base, 'pdfs');
  ANN_DIR = path.join(base, 'annotations');
  fs.mkdirSync(PDF_DIR, { recursive: true });
  fs.mkdirSync(ANN_DIR, { recursive: true });
}

// ---------- نفس منطق جسر الأندرويد (MainActivity.Bridge) ----------
// أي حرف مش حرف/رقم/نقطة/شرطة/مسافة يتحول لـ _
function safeName(n) {
  return String(n).replace(/[^\p{L}\p{N}._ \-]/gu, '_');
}

function annFile(name) {
  return path.join(ANN_DIR, safeName(name) + '.json');
}

function safePdf(name) {
  const f = path.join(PDF_DIR, safeName(name));
  try {
    return fs.statSync(f).isFile() && path.dirname(f) === PDF_DIR ? f : null;
  } catch (e) {
    return null;
  }
}

function listPdfs() {
  let names = [];
  try {
    names = fs
      .readdirSync(PDF_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
      .map((e) => e.name)
      .sort();
  } catch (e) {
    /* مجلد فاضي */
  }
  return JSON.stringify(names);
}

function loadAnnotations(name) {
  try {
    return fs.readFileSync(annFile(name), 'utf8');
  } catch (e) {
    return '';
  }
}

function saveAnnotations(name, json) {
  try {
    const f = annFile(name);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, String(json), 'utf8');
    fs.renameSync(tmp, f);
    return true;
  } catch (e) {
    return false;
  }
}

function deletePdf(name) {
  const f = safePdf(name);
  if (!f) return false;
  try {
    fs.rmSync(annFile(name), { force: true });
    fs.unlinkSync(f);
    return true;
  } catch (e) {
    return false;
  }
}

function listNotebooks() {
  let ids = [];
  try {
    ids = fs
      .readdirSync(ANN_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith('nb_') && e.name.endsWith('.json'))
      .map((e) => e.name.slice(0, -'.json'.length))
      .sort();
  } catch (e) {
    /* مجلد فاضي */
  }
  return JSON.stringify(ids);
}

function deleteNotebook(id) {
  id = String(id);
  if (!id.startsWith('nb_')) return false;
  try {
    fs.unlinkSync(annFile(id));
    return true;
  } catch (e) {
    return false;
  }
}

// الصفحة بتنادي pickPdf() وترجع فوراً، والنتيجة بتيجي عن طريق onPdfAdded / onPdfError
function notifyPage(fn) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents
      .executeJavaScript(`if (window.${fn}) ${fn}();`)
      .catch(() => {});
  }
}

async function doPickPdf() {
  const opts = {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF files', extensions: ['pdf'] }]
  };
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts);
  if (result.canceled || !result.filePaths.length) return; // المستخدم ألغى

  try {
    for (const src of result.filePaths) {
      let name = path.basename(src);
      if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
      fs.copyFileSync(src, path.join(PDF_DIR, safeName(name)));
    }
    notifyPage('onPdfAdded');
  } catch (e) {
    notifyPage('onPdfError');
  }
}

function pickPdf() {
  doPickPdf().catch(() => notifyPage('onPdfError'));
  return null;
}

const bridge = {
  listPdfs,
  loadAnnotations,
  saveAnnotations,
  deletePdf,
  listNotebooks,
  deleteNotebook,
  pickPdf
};

// الـ preload بيكلّم الدوال دي بشكل متزامن زي ما بيحصل في الأندرويد
ipcMain.on('android:call', (event, method, args) => {
  let url = '';
  try {
    url = event.senderFrame.url;
  } catch (e) {
    /* تجاهل */
  }
  if (!url.startsWith(`http://127.0.0.1:${serverPort}/`)) {
    event.returnValue = null;
    return;
  }
  try {
    const fn = typeof method === 'string' && Object.hasOwn(bridge, method) ? bridge[method] : null;
    const out = fn ? fn(...(Array.isArray(args) ? args : [])) : null;
    event.returnValue = out === undefined ? null : out;
  } catch (e) {
    event.returnValue = null;
  }
});

// ---------- السيرفر المحلي (بديل WebViewAssetLoader) ----------
// /assets/*  →  مجلد www        (زي https://appassets.androidplatform.net/assets/)
// /pdfs/*    →  مجلد الكتب      (زي https://appassets.androidplatform.net/pdfs/)

// يمنع الخروج بره المجلد الأساسي (path traversal)
function safeJoin(base, rel) {
  const baseAbs = path.resolve(base);
  const full = path.resolve(baseAbs, String(rel).replace(/^[/\\]+/, ''));
  if (full === baseAbs || full.startsWith(baseAbs + path.sep)) return full;
  return null;
}

// يخدم الملف مع دعم Range عشان ملفات PDF الكبيرة تفتح بسرعة
function serveFile(req, res, full, contentType) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const size = st.size;
    let start = 0;
    let end = size - 1;
    let status = 200;

    const range = req.headers.range;
    if (range && range.startsWith('bytes=')) {
      const [s, e] = range.slice(6).split(',')[0].split('-');
      if (s) {
        start = parseInt(s, 10);
        if (e) end = parseInt(e, 10);
      } else if (e) {
        start = Math.max(0, size - parseInt(e, 10));
      }
      end = Math.min(end, size - 1);
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      status = 206;
    }

    const headers = {
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes'
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(full, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

function handle(req, res) {
  // حماية: نقبل بس الطلبات الموجهة للعنوان المحلي (ضد DNS rebinding)
  const host = req.headers.host;
  if (host !== `127.0.0.1:${serverPort}` && host !== `localhost:${serverPort}`) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Method not allowed');
  }

  let p;
  try {
    p = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${serverPort}`).pathname);
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad request');
  }

  let base;
  let rel;
  if (p === '/' || p === '') {
    base = WWW;
    rel = 'index.html';
  } else if (p.startsWith('/assets/')) {
    base = WWW;
    rel = p.slice('/assets/'.length);
  } else if (p.startsWith('/pdfs/')) {
    base = PDF_DIR;
    rel = p.slice('/pdfs/'.length);
  } else {
    res.writeHead(404);
    return res.end('Not found');
  }

  const full = safeJoin(base, rel);
  if (!full) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  return serveFile(req, res, full, type);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handle);
    const tryListen = (port) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && port !== 0) tryListen(0);
        else reject(err);
      };
      srv.once('error', onError);
      srv.listen(port, '127.0.0.1', () => {
        srv.removeListener('error', onError);
        serverPort = srv.address().port;
        server = srv;
        resolve();
      });
    };
    tryListen(PREFERRED_PORT);
  });
}

function isLocalOrigin(value) {
  return value === `http://127.0.0.1:${serverPort}` || value === `http://localhost:${serverPort}`;
}

// ---------- النافذة ----------
function createWindow() {
  Menu.setApplicationMenu(null);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), // بيعرّف window.Android زي الأندرويد
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // F12 أو Ctrl+Shift+I يفتحوا الـ Console لتشخيص الأخطاء
  win.webContents.on('before-input-event', (event, input) => {
    const isF12 = input.type === 'keyDown' && input.key === 'F12';
    const isCtrlShiftI =
      input.type === 'keyDown' &&
      input.control &&
      input.shift &&
      input.key.toLowerCase() === 'i';
    if (isF12 || isCtrlShiftI) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // الروابط الخارجية تتفتح في المتصفح، مش جوه التطبيق
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch (e) {
      /* تجاهل */
    }
    if (!isLocalOrigin(origin)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // عنوان النافذة بيعرض رقم الإصدار، ومش بيتغير من عنوان الصفحة
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadURL(`http://127.0.0.1:${serverPort}/assets/index.html`);
  win.setTitle(`بورد PDF - الإصدار ${app.getVersion()}`);
}

// نسخة واحدة بس من البرنامج (عشان البورت والملفات)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    initPaths();
    await startServer();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (server) server.close();
  });
}
