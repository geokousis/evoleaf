const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('evoLeafDesktop', {
  platform: process.platform,
});
