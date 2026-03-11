const { contextBridge, ipcRenderer } = require("electron");

const openFileListeners = new Set();
const exportProgressListeners = new Set();
const pendingOpenFiles = [];

ipcRenderer.on("video:open-request", (_event, filePath) => {
  if (typeof filePath !== "string" || !filePath) {
    return;
  }

  if (!openFileListeners.size) {
    pendingOpenFiles.push(filePath);
    return;
  }

  openFileListeners.forEach((listener) => listener(filePath));
});

ipcRenderer.on("video:export-progress", (_event, progress) => {
  exportProgressListeners.forEach((listener) => listener(progress));
});

contextBridge.exposeInMainWorld("videoApp", {
  openVideo: () => ipcRenderer.invoke("video:open"),
  analyzeVideo: (filePath) => ipcRenderer.invoke("video:analyze", filePath),
  exportClip: (payload) => ipcRenderer.invoke("video:export", payload),
  releaseMediaSession: (sessionId) => ipcRenderer.invoke("video:release-media-session", sessionId),
  onExportProgress: (callback) => {
    exportProgressListeners.add(callback);
    return () => exportProgressListeners.delete(callback);
  },
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  getWindowState: () => ipcRenderer.invoke("window:get-state"),
  onWindowStateChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("window:state-changed", listener);
    return () => ipcRenderer.removeListener("window:state-changed", listener);
  },
  onOpenFileRequested: (callback) => {
    openFileListeners.add(callback);

    while (pendingOpenFiles.length) {
      const filePath = pendingOpenFiles.shift();

      if (filePath) {
        callback(filePath);
      }
    }

    return () => openFileListeners.delete(callback);
  },
});
