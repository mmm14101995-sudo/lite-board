const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- المسارات ----------
// index.html وباقي ملفات الواجهة جوه مجلد www (نفس ملف الاندرويد)
const WWW = path.join(__dirname, 'www');

// بورت ثابت عشان localStorage وأي إعدادات على مستوى المتصفح تفضل محفوظة بين مرات التشغيل
const PREFERRED_PORT = 47321;

// الكتب والبيانات في مجلد المستندات: Documents\BoardPDF\{books,data,exports}
let ROOT, BOOKS_DIR, DATA_DIR, EXPORT_DIR, STATE_FILE;

let server = null;
let serverPort = 0;
let mainWindow = null;

const REVIEW_FOLDERS = new Set(['reviews', 'review', 'ملازم', 'مراجعات']);
const EXAM_FOLDERS = new Set(['exams', 'exam', 'اختبارات', 'اختبار']);
const GRADE_RE = /^[a-z0-9_-]{1,20}$/i;
const PICK_FOLDERS = { books: '', reviews: 'reviews', exams: 'exams' };
const MAX_BODY = 256 * 1024 * 1024; // حد أقصى لحجم الطلب (الحالة وملفات PDF المصدّرة)

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
  ROOT = base;
  BOOKS_DIR = path.join(ROOT, 'books');
  DATA_DIR = path.join(ROOT, 'data');
  EXPORT_DIR = path.join(ROOT, 'exports');
  STATE_FILE = path.join(DATA_DIR, 'state.json');
  for (const d of [BOOKS_DIR, DATA_DIR, EXPORT_DIR]) fs.mkdirSync(d, { recursive: true });
}

// ---------- الكتب ----------
// أي PDF جوه مجلد اسمه reviews أو ملازم يتعتبر ملزمة، وجوه exams اختبار، والباقي كتب
function walkBooks(dir, subParts, gradeName, items) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  const folders = subParts.map((p) => p.toLowerCase());
  const kind = folders.some((f) => EXAM_FOLDERS.has(f))
    ? 'exams'
    : folders.some((f) => REVIEW_FOLDERS.has(f))
      ? 'reviews'
      : 'books';

  for (const entry of entries) {
    if (entry.isDirectory()) {
      walkBooks(path.join(dir, entry.name), [...subParts, entry.name], gradeName, items);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
      const id = [gradeName, ...subParts, entry.name].join('/');
      items.push({
        id,
        title: path.parse(entry.name).name,
        url: '/books/' + id.split('/').map(encodeURIComponent).join('/'),
        grade: gradeName.toLowerCase(),
        kind
      });
    }
  }
}

function scanBooks() {
  const items = [];
  let grades;
  try {
    grades = fs.readdirSync(BOOKS_DIR, { withFileTypes: true });
  } catch (e) {
    return items;
  }
  for (const g of grades) {
    if (!g.isDirectory() || !GRADE_RE.test(g.name)) continue;
    walkBooks(path.join(BOOKS_DIR, g.name), [], g.name, items);
  }
  items.sort((a, b) => {
    const x = a.title.toLowerCase();
    const y = b.title.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return items;
}

// ---------- الحفظ على القرص ----------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveState(data) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- أدوات السيرفر ----------
function sendJson(res, data, status = 200) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

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

function isLocalOrigin(value) {
  return (
    value === `http://127.0.0.1:${serverPort}` ||
    value === `http://localhost:${serverPort}`
  );
}

// ---------- طلبات POST ----------
async function handlePost(req, res, p) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch (e) {
    return sendJson(res, { ok: false }, 400);
  }

  if (p === '/api/state') {
    saveState(payload);
    return sendJson(res, { ok: true });
  }

  if (p === '/api/books/pick') {
    const grade = String(payload.grade || 'sec3').toLowerCase();
    const kind = String(payload.kind || 'books');
    const folder = Object.hasOwn(PICK_FOLDERS, kind) ? PICK_FOLDERS[kind] : undefined;
    if (!GRADE_RE.test(grade) || folder === undefined) return sendJson(res, { ok: false }, 400);

    const opts = {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF files', extensions: ['pdf'] }]
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths.length) {
      return sendJson(res, { ok: false, cancelled: true });
    }

    const gradeDir = grade.toUpperCase();
    const target = folder ? path.join(BOOKS_DIR, gradeDir, folder) : path.join(BOOKS_DIR, gradeDir);
    fs.mkdirSync(target, { recursive: true });

    let count = 0;
    const ids = [];
    for (const src of result.filePaths) {
      const name = path.basename(src);
      if (!name.toLowerCase().endsWith('.pdf')) continue;
      fs.copyFileSync(src, path.join(target, name));
      count++;
      // نفس المعرّف اللي scanBooks بترجّعه
      ids.push([gradeDir, ...(folder ? [folder] : []), name].join('/'));
    }
    return sendJson(res, { ok: true, count, ids });
  }

  if (p === '/api/open-folder') {
    const grade = String(payload.grade || 'sec3').toLowerCase();
    if (!GRADE_RE.test(grade)) return sendJson(res, { ok: false }, 400);
    const folder = path.join(BOOKS_DIR, grade.toUpperCase(), 'exams');
    fs.mkdirSync(folder, { recursive: true });
    shell.openPath(folder);
    return sendJson(res, { ok: true, path: folder });
  }

  if (p === '/api/open-external') {
    const url = String(payload.url || '');
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return sendJson(res, { ok: true });
  }

  if (p === '/api/save-pdf') {
    let name = String(payload.name || 'board.pdf').replace(/[\\/:*?"<>|]/g, '_');
    if (!name || name === '.' || name === '..') name = 'board.pdf';
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const outPath = path.join(EXPORT_DIR, name);
    fs.writeFileSync(outPath, Buffer.from(String(payload.data || ''), 'base64'));
    return sendJson(res, { ok: true, path: outPath });
  }

  res.writeHead(404);
  res.end('Not found');
}

// ---------- السيرفر المحلي ----------
async function handle(req, res) {
  // حماية: نقبل بس الطلبات الموجهة للعنوان المحلي (ضد DNS rebinding)
  const host = req.headers.host;
  if (host !== `127.0.0.1:${serverPort}` && host !== `localhost:${serverPort}`) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const url = new URL(req.url, `http://127.0.0.1:${serverPort}`);
  const p = url.pathname;

  if (req.method === 'POST') {
    // حماية: نرفض طلبات POST اللي جاية من أي موقع تاني
    if (req.headers.origin && !isLocalOrigin(req.headers.origin)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    return handlePost(req, res, p);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Method not allowed');
  }

  if (p === '/api/books') return sendJson(res, scanBooks());
  if (p === '/api/state') return sendJson(res, loadState());
  if (p === '/api/media/list') return sendJson(res, []); // الفيديوهات غير مدعومة في السبورة

  if (p.startsWith('/books/')) {
    let rel;
    try {
      rel = decodeURIComponent(p.slice('/books/'.length));
    } catch (e) {
      res.writeHead(400);
      return res.end('Bad request');
    }
    const full = safeJoin(BOOKS_DIR, rel);
    if (!full || !full.toLowerCase().endsWith('.pdf')) {
      res.writeHead(404);
      return res.end('Not found');
    }
    return serveFile(req, res, full, 'application/pdf');
  }

  // ملفات الواجهة الثابتة من www
  let rel;
  try {
    rel = decodeURIComponent(p);
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = safeJoin(WWW, rel);
  if (!full) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  return serveFile(req, res, full, type);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      handle(req, res).catch(() => {
        try {
          res.writeHead(500);
          res.end('Server error');
        } catch (e) {
          /* تجاهل */
        }
      });
    });

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
  win.loadURL(`http://127.0.0.1:${serverPort}/`);
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
