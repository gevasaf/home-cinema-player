const Store = require('electron-store')
const fs = require('fs')
const path = require('path')

// All electron-store access is isolated here. No other module imports electron-store.
const electronStore = new Store({ name: 'cinema-data' })

// Subscribers: key → Set of callbacks (for cross-process notification)
const subscribers = new Map()

function notifySubscribers(mainWindow, key, value) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`storage:changed:${key}`, value)
  }
}

// The storage interface used by all other IPC handlers in the main process.
// This is the only object that touches electron-store.
const store = {
  get(key) {
    return electronStore.get(key)
  },
  set(key, value) {
    electronStore.set(key, value)
    if (subscribers.has(key)) {
      for (const cb of subscribers.get(key)) cb(value)
    }
  },
  subscribe(key, callback) {
    if (!subscribers.has(key)) subscribers.set(key, new Set())
    subscribers.get(key).add(callback)
    return () => subscribers.get(key).delete(callback)
  },
}

function seedFromLocalConfig() {
  const configPath = path.join(__dirname, '../../config/settings.local.json')
  if (!fs.existsSync(configPath)) return
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    for (const [key, value] of Object.entries(config)) {
      if (value !== '') store.set(key, value)
    }
  } catch (err) {
    console.warn('Could not load settings.local.json:', err.message)
  }
}

function createStorageHandlers(ipcMain, mainWindow) {
  ipcMain.handle('storage:get', (_event, key) => store.get(key))

  ipcMain.handle('storage:set', (_event, key, value) => {
    store.set(key, value)
    notifySubscribers(mainWindow, key, value)
  })

  // Load API keys from local config file (gitignored)
  seedFromLocalConfig()

  // Seed test playlist on first run
  if (!store.get('testPlaylistSeeded')) {
    store.set('currentPlaylist', buildTestPlaylist())
    store.set('testPlaylistSeeded', true)
  }

  return store
}

function buildTestPlaylist() {
  return {
    weekOf: '2026-06-07',
    lobbyVideo: 'local://assets/lobby-loop.mp4',
    openingIdent: 'local://assets/ident.mp4',
    trailers: [
      { type: 'youtube', ytId: '_IY7_iCuINo', title: 'Test Trailer 1' },
    ],
    short: {
      type: 'youtube',
      ytId: 'kjP2Hbd-_No',  // Pixar's Boundin' (2003)
      title: "Boundin'",
      imdbId: 'tt0293715',
      tmdbId: '13730',
      streamUrl: null,
      audioTrack: null,
      subtitleOverride: null,
      subtitleOffset: 0,
    },
    featureBumper: 'local://assets/feature-presentation.mp4',
    feature: {
      type: 'torrent',
      imdbId: 'tt0117705',  // Space Jam (1996)
      title: 'Space Jam',
      tmdbId: '2300',
      streamUrl: null,
      audioTrack: null,
      subtitleOverride: null,
      subtitleOffset: 0,
    },
    completedAt: null,
  }
}

module.exports = { createStorageHandlers }
