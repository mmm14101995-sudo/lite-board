const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

// نفس ملف الاندرويد: index.html جوه مجلد www
const APP_PAGE = path.join(__dirname, 'www', 'index.html');

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

  // عنوان النافذة بيعرض رقم الإصدار، ومش بيتغير من عنوان الصفحة
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadFile(APP_PAGE);
  win.setTitle(`بورد PDF - الإصدار ${app.getVersion()}`);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
