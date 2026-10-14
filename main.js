const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
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

/* ----------------------- SRT time helpers ----------------------- */

function parseTimeToMs(t) {
  const m = t.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2], s = +m[3];
  let ms = +m[4];
  if (m[4].length === 1) ms *= 100;
  else if (m[4].length === 2) ms *= 10;
  return (h * 3600 + mi * 60 + s) * 1000 + ms;
}

function msToTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const mi = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const m = total % 1000;
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(mi)}:${pad(s)},${pad(m, 3)}`;
}

function parseSRT(content) {
  const blocks = content.replace(/\r/g, '').split(/\n\s*\n/).filter((b) => b.trim());
  const segs = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) { idx = i; break; }
    }
    if (idx === -1) continue;
    const tm = lines[idx].split('-->');
    const startMs = parseTimeToMs(tm[0]);
    const endMs = parseTimeToMs(tm[1]);
    if (startMs == null || endMs == null) continue;
    const text = lines.slice(idx + 1).join('\n');
    const index = /^\d+$/.test(lines[0].trim()) ? +lines[0].trim() : segs.length + 1;
    segs.push({ index, startMs, endMs, text });
  }
  return segs;
}

function serializeSRT(segs) {
  return segs
    .map((s, i) => {
      const index = s.index != null ? s.index : i + 1;
      return `${index}\n${msToTime(s.startMs)} --> ${msToTime(s.endMs)}\n${s.text}`;
    })
    .join('\n\n') + '\n';
}

/* ----------------------- IPC handlers ----------------------- */

ipcMain.handle('open-file', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const p = res.filePaths[0];
  const content = fs.readFileSync(p, 'utf-8');
  const segments = parseSRT(content);
  return { path: p, segments };
});

ipcMain.handle('save-file', async (_e, segs) => {
  const res = await dialog.showSaveDialog(win, {
    title: '导出字幕',
    defaultPath: 'optimized.srt',
    filters: [{ name: 'Subtitles', extensions: ['srt'] }],
  });
  if (res.canceled || !res.filePath) return null;
  // 添加 UTF-8 BOM (\ufeff) 以增强 Windows 兼容性
  fs.writeFileSync(res.filePath, '\ufeff' + serializeSRT(segs), 'utf-8');
  
  // 关键修复：使用 PowerShell 解除文件锁定，防止触发 Windows Internet 安全警告 (MotW)
  if (process.platform === 'win32') {
    exec(`powershell.exe -Command "Unblock-File -Path '${res.filePath}'"`, (err) => {
      if (err) console.error('Unblock file failed:', err);
    });
  }
  
  return res.filePath;
});

