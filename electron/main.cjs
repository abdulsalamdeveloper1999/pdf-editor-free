const { app, protocol, BrowserWindow } = require('electron');
const { registerScheme, serve, createWindow } = require('./app.cjs');

registerScheme(); // must happen before the app is ready

app.whenReady().then(() => {
  protocol.handle('app', serve);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
