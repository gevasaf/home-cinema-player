const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cinema', {
  storage: {
    get: (key) => ipcRenderer.invoke('storage:get', key),
    set: (key, value) => ipcRenderer.invoke('storage:set', key, value),
    subscribe: (key, callback) => {
      const channel = `storage:changed:${key}`
      ipcRenderer.on(channel, (_event, value) => callback(value))
      return () => ipcRenderer.removeAllListeners(channel)
    },
  },
  tmdb: {
    search: (title) => ipcRenderer.invoke('tmdb:search', title),
    fetchById: (imdbId) => ipcRenderer.invoke('tmdb:fetchById', imdbId),
  },
  ytdlp: {
    resolve: (ytIdOrUrl) => ipcRenderer.invoke('ytdlp:resolve', ytIdOrUrl),
    resolveSubtitles: (ytIdOrUrl) => ipcRenderer.invoke('ytdlp:resolve-subtitles', ytIdOrUrl),
  },
  debrid: {
    resolve: (imdbId, audioTrack) => ipcRenderer.invoke('debrid:resolve', imdbId, audioTrack),
    proxy: (url, audioTrack) => ipcRenderer.invoke('debrid:proxy', url, audioTrack),
  },
  subtitles: {
    fetch: (imdbId, language) => ipcRenderer.invoke('subtitles:fetch', imdbId, language),
    fetchUrl: (url) => ipcRenderer.invoke('subtitles:fetch-url', url),
  },
})
