// بيعرّف window.Android بنفس دوال جسر الأندرويد (MainActivity.Bridge)،
// فصفحة السبورة تشتغل على ويندوز بنفس الكود من غير تعديل.
const { contextBridge, ipcRenderer } = require('electron');

const call = (method, ...args) => ipcRenderer.sendSync('android:call', method, args);

contextBridge.exposeInMainWorld('Android', {
  listPdfs: () => call('listPdfs'),
  loadAnnotations: (name) => call('loadAnnotations', String(name)),
  saveAnnotations: (name, json) => call('saveAnnotations', String(name), String(json)),
  deletePdf: (name) => call('deletePdf', String(name)),
  listNotebooks: () => call('listNotebooks'),
  deleteNotebook: (id) => call('deleteNotebook', String(id)),
  pickPdf: () => {
    call('pickPdf');
  }
});
