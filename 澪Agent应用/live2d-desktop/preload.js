const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mioDesktop', {
  getState: () => ipcRenderer.invoke('mio-desktop:get-state'),
  setInteractive: (interactive) => ipcRenderer.send('mio-desktop:set-interactive', Boolean(interactive)),
  setModelBounds: (bounds) => ipcRenderer.send('mio-desktop:model-bounds', bounds || null),
  setUiOpen: (open) => ipcRenderer.send('mio-desktop:ui-open', Boolean(open)),
  setClickThroughLocked: (enabled) => ipcRenderer.send('mio-desktop:set-click-through-locked', Boolean(enabled)),
  setLockControlAnchor: (bounds) => ipcRenderer.send('mio-desktop:set-lock-control-anchor', bounds),
  setAlwaysOnTop: (enabled) => ipcRenderer.send('mio-desktop:set-always-on-top', Boolean(enabled)),
  setChatWindowOpen: (open) => ipcRenderer.send('mio-desktop:set-chat-window-open', Boolean(open)),
  toggleChatWindow: (anchor) => ipcRenderer.invoke('mio-desktop:toggle-chat-window', anchor || {}),
  showChatWindow: (anchor) => ipcRenderer.invoke('mio-desktop:show-chat-window', anchor || {}),
  openXiaozhi: () => ipcRenderer.send('mio-desktop:open-xiaozhi'),
  openScreenCrop: () => ipcRenderer.send('mio-desktop:open-screen-crop'),
  restoreVisibility: () => ipcRenderer.send('mio-desktop:restore-visibility'),
  importModel: () => ipcRenderer.invoke('mio-desktop:import-model'),
  selectModel: (modelId) => ipcRenderer.invoke('mio-desktop:select-model', String(modelId || '')),
  openAgent: () => ipcRenderer.invoke('mio-desktop:open-agent'),
  getVersion: () => ipcRenderer.invoke('mio-desktop:get-version'),
  close: () => ipcRenderer.send('mio-desktop:close'),
  sendXiaozhiBubble: (payload) => ipcRenderer.send('mio-pet-chat:xiaozhi-bubble', payload),
  sendPetEvent: (event) => ipcRenderer.send('mio-desktop:pet-event', event),
  onModelsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('mio-desktop:models-changed', listener)
    return () => ipcRenderer.removeListener('mio-desktop:models-changed', listener)
  },
  onClickThroughChanged: (callback) => {
    const listener = (_event, enabled) => callback(Boolean(enabled))
    ipcRenderer.on('mio-desktop:click-through-changed', listener)
    return () => ipcRenderer.removeListener('mio-desktop:click-through-changed', listener)
  },
  onXiaozhiBubble: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('mio-xiaozhi:bubble', listener)
    return () => ipcRenderer.removeListener('mio-xiaozhi:bubble', listener)
  },
  onPetEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('mio-pet-event', listener)
    return () => ipcRenderer.removeListener('mio-pet-event', listener)
  },
  onMouseMove: (callback) => {
    const listener = (_event, payload) => callback(payload || {})
    ipcRenderer.on('mio-desktop:mouse-move', listener)
    return () => ipcRenderer.removeListener('mio-desktop:mouse-move', listener)
  },
})
