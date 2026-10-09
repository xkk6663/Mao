const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mioPetChat', {
  isElectron: true,
  hide: () => ipcRenderer.send('mio-pet-chat:hide'),
  sendXiaozhiBubble: (payload) => ipcRenderer.send('mio-pet-chat:xiaozhi-bubble', payload),
  sendPetEvent: (ev) => ipcRenderer.send('mio-desktop:pet-event', ev),
})
